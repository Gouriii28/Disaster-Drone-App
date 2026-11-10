"""
SAADAXA ground server (rescue-team edition).

Start it from the project folder with:
    python server/run.py

What it does:
  * serves the rescue-team app (web/index.html) and the public survivor SOS page (web/sos.html)
  * signs rescue teams in with a shared access code
  * receives telemetry, survivor detections and survivor audio from aerial units
  * turns detections and SOS calls into "cases" that teams accept and close
  * carries messages between teams and survivors (SOS page text, or drone loudspeaker)
  * pulls live disaster alerts for India only (NDMA SACHET, GDACS, USGS)
  * answers the AI assistant
  * pushes the whole picture to every signed-in team device twice a second
"""
import asyncio
import os
import time
import uuid
import xml.etree.ElementTree as ET
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import List, Literal, Optional

import httpx
from dotenv import load_dotenv
from fastapi import (Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile, WebSocket,
                     WebSocketDisconnect)
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from geo import haversine_m
from knowledge import offline_answer
from store import CASE_STATUSES, Store

SERVER_DIR = Path(__file__).resolve().parent
ROOT_DIR = SERVER_DIR.parent
WEB_DIR = ROOT_DIR / "web"
DATA_DIR = SERVER_DIR / "data"
REC_DIR = DATA_DIR / "recordings"
VOICE_DIR = DATA_DIR / "voice"
REC_DIR.mkdir(parents=True, exist_ok=True)
VOICE_DIR.mkdir(parents=True, exist_ok=True)

load_dotenv(SERVER_DIR / ".env")

SIMULATION = os.getenv("SIMULATION", "0") == "1"
CENTER_LAT = float(os.getenv("CENTER_LAT", "22.5"))
CENTER_LON = float(os.getenv("CENTER_LON", "79.0"))
OPERATION_NAME = os.getenv("OPERATION_NAME", "Disaster Response Operation")
TEAM_ACCESS_CODE = os.getenv("TEAM_ACCESS_CODE", "change-this-code")
DRONE_TOKEN = os.getenv("DRONE_TOKEN", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
AI_MODEL = os.getenv("AI_MODEL", "claude-sonnet-5-5")
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "200"))
# 1 = hide alerts that have no English version and could not be translated
ALERTS_ENGLISH_ONLY = os.getenv("ALERTS_ENGLISH_ONLY", "0") == "1"

store = Store(DATA_DIR / "saadaxa.db")


async def simulated_speaker():
    """In simulation, pretend each aircraft plays queued team voice/text messages."""
    while True:
        for d in store.drones():
            for m in store.drone_outbox(d["drone_id"]):
                await asyncio.sleep(1.5)
                store.set_delivery(m["id"], "played:{}".format(d["drone_id"]))
        await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(app):
    tasks = []
    if SIMULATION:
        from simulator import Simulator
        tasks.append(asyncio.create_task(Simulator(store, CENTER_LAT, CENTER_LON).run()))
        tasks.append(asyncio.create_task(simulated_speaker()))
    else:
        store.log("info", "system", "Ground server started — waiting for aerial units and SOS calls")
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="SAADAXA Ground Server", lifespan=lifespan)


# ======================================================================
# Models
# ======================================================================
class Login(BaseModel):
    code: str = Field(max_length=100)
    team: str = Field(min_length=1, max_length=40)
    member: str = Field(min_length=1, max_length=40)
    device_id: str = Field(min_length=1, max_length=40)


class Telemetry(BaseModel):
    drone_id: str
    lat: float
    lon: float
    alt: float = 0
    battery: float = 0
    hdop: float = 0
    nav_mode: Literal["GNSS", "DEGRADED", "VIO", "POS_HOLD", "REACQ"] = "GNSS"
    rssi: float = -50
    link: Literal["WIFI", "LORA"] = "WIFI"
    video: bool = True
    audio: bool = True
    state: str = "SURVEY"
    drift_m: float = 0


class Detection(BaseModel):
    drone_id: str
    lat: float
    lon: float
    confidence: float = Field(ge=0, le=1)
    thermal: bool = False
    nav_mode: str = "GNSS"
    link: str = "WIFI"
    priority: Optional[Literal["critical", "high", "medium"]] = None


class DroneAck(BaseModel):
    message_id: int
    status: Literal["played", "failed"] = "played"
    drone_id: str


class CaseUpdate(BaseModel):
    status: Literal["new", "accepted", "en_route", "on_scene", "rescued", "closed"]


class TeamMessage(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


class Hazard(BaseModel):
    lat: float
    lon: float
    kind: str = Field(max_length=60)
    severity: Literal["low", "moderate", "severe"]
    note: str = Field(default="", max_length=500)
    created: Optional[float] = None


class Unit(BaseModel):
    lat: float
    lon: float
    accuracy: Optional[float] = None
    source: str = Field(default="", max_length=40)


class PublicSOS(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    accuracy: Optional[float] = None
    people: int = Field(default=1, ge=1, le=500)
    injured: bool = False
    trapped: bool = False
    note: str = Field(default="", max_length=500)
    contact: str = Field(default="", max_length=40)


class PublicUpdate(BaseModel):
    secret: str = Field(max_length=60)
    text: str = Field(default="", max_length=1000)
    lat: Optional[float] = None
    lon: Optional[float] = None
    accuracy: Optional[float] = None


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    lat: Optional[float] = None
    lon: Optional[float] = None


# ======================================================================
# Access control
# ======================================================================
def require_team(authorization: Optional[str] = Header(default=None)):
    token = (authorization or "").replace("Bearer ", "").strip()
    team = store.team_for(token)
    if not team:
        raise HTTPException(401, "Sign in required")
    return team


def check_drone_token(token):
    if DRONE_TOKEN and token != DRONE_TOKEN:
        raise HTTPException(401, "Bad drone token")


_rate = defaultdict(deque)


def rate_limit(request: Request, key: str, limit: int, window_s: int):
    ip = request.client.host if request.client else "?"
    q = _rate[(key, ip)]
    now = time.time()
    while q and now - q[0] > window_s:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(429, "Too many requests. Please wait a minute and try again.")
    q.append(now)


# ======================================================================
# Public info + sign-in
# ======================================================================
@app.get("/api/health")
def health():
    return {"ok": True, "time": time.time()}


@app.get("/api/config")
def config():
    return {
        "simulation": SIMULATION,
        "operation": OPERATION_NAME,
        "center": {"lat": CENTER_LAT, "lon": CENTER_LON},
        "assistant_online": bool(ANTHROPIC_API_KEY),
        "default_code": TEAM_ACCESS_CODE == "change-this-code",
    }


@app.post("/api/team/login")
def team_login(body: Login, request: Request):
    rate_limit(request, "login", 10, 300)
    if body.code.strip() != TEAM_ACCESS_CODE:
        raise HTTPException(403, "Wrong access code")
    token = store.team_login(body.device_id.strip(), body.team.strip(), body.member.strip())
    return {"token": token, "team": body.team.strip(), "member": body.member.strip()}


@app.get("/api/team/me")
def team_me(team=Depends(require_team)):
    return {"team": team["team"], "member": team["member"]}


@app.post("/api/team/logout")
def team_logout(authorization: Optional[str] = Header(default=None)):
    store.team_logout((authorization or "").replace("Bearer ", "").strip())
    return {"ok": True}


@app.get("/sos")
def sos_redirect():
    return RedirectResponse("/sos.html")


# ======================================================================
# Aerial units
# ======================================================================
@app.post("/api/drone/telemetry")
def drone_telemetry(t: Telemetry, x_drone_token: Optional[str] = Header(default=None)):
    check_drone_token(x_drone_token)
    store.update_telemetry(t.model_dump())
    return {"ok": True}


@app.post("/api/drone/detection")
def drone_detection(d: Detection, x_drone_token: Optional[str] = Header(default=None)):
    check_drone_token(x_drone_token)
    return store.add_detection(d.model_dump())


@app.get("/api/drone/{drone_id}/outbox")
def drone_outbox(drone_id: str, x_drone_token: Optional[str] = Header(default=None)):
    """Team messages the aircraft should play on its loudspeaker (text: speak with TTS)."""
    check_drone_token(x_drone_token)
    rows = store.drone_outbox(drone_id)
    return [{"message_id": r["id"], "survivor_id": r["case_id"], "text": r["text"],
             "audio_url": r["audio_url"], "lat": r["lat"], "lon": r["lon"]} for r in rows]


@app.post("/api/drone/ack")
def drone_ack(a: DroneAck, x_drone_token: Optional[str] = Header(default=None)):
    check_drone_token(x_drone_token)
    store.set_delivery(a.message_id, "{}:{}".format(a.status, a.drone_id))
    return {"ok": True}


@app.post("/api/drone/audio")
async def drone_audio(survivor_id: str = Form(...), drone_id: str = Form(...), file: UploadFile = File(...),
                      x_drone_token: Optional[str] = Header(default=None)):
    """Survivor speech captured by the aircraft microphone."""
    check_drone_token(x_drone_token)
    if not store.get_case("survivor", survivor_id):
        raise HTTPException(404, "Unknown survivor")
    url = await save_upload(file, VOICE_DIR, "voice")
    store.add_message("survivor", survivor_id, "survivor", "", audio_url=url, drone_id=drone_id)
    store.log("alert", "case", "Voice received from survivor {} via {}".format(survivor_id, drone_id))
    return {"ok": True, "url": url}


# ======================================================================
# Cases (team only)
# ======================================================================
@app.patch("/api/cases/{case_type}/{case_id}")
def case_update(case_type: Literal["survivor", "sos"], case_id: str, u: CaseUpdate, team=Depends(require_team)):
    if u.status not in CASE_STATUSES:
        raise HTTPException(400, "Bad status")
    if not store.set_case_status(case_type, case_id, u.status, team["team"]):
        raise HTTPException(404, "Case not found")
    return {"ok": True}


@app.get("/api/cases/{case_type}/{case_id}/messages")
def case_messages(case_type: Literal["survivor", "sos"], case_id: str, team=Depends(require_team)):
    return store.messages(case_type, case_id)


def _delivery_for(case_type, case):
    if case_type == "sos":
        return "waiting"   # becomes "delivered" when the survivor's SOS page fetches it
    return "queued"        # aircraft collects it from /api/drone/{id}/outbox


@app.post("/api/cases/{case_type}/{case_id}/messages")
def case_message_text(case_type: Literal["survivor", "sos"], case_id: str, m: TeamMessage, team=Depends(require_team)):
    case = store.get_case(case_type, case_id)
    if not case:
        raise HTTPException(404, "Case not found")
    mid = store.add_message(case_type, case_id, "team", m.text.strip(), team=team["team"],
                            delivery=_delivery_for(case_type, case),
                            drone_id=case.get("drone_id") or "" if case_type == "survivor" else "")
    return {"id": mid}


@app.post("/api/cases/{case_type}/{case_id}/voice")
async def case_message_voice(case_type: Literal["survivor", "sos"], case_id: str, file: UploadFile = File(...),
                             team=Depends(require_team)):
    case = store.get_case(case_type, case_id)
    if not case:
        raise HTTPException(404, "Case not found")
    url = await save_upload(file, VOICE_DIR, "voice")
    mid = store.add_message(case_type, case_id, "team", "", team=team["team"], audio_url=url,
                            delivery=_delivery_for(case_type, case),
                            drone_id=case.get("drone_id") or "" if case_type == "survivor" else "")
    return {"id": mid, "url": url}


# ======================================================================
# Public survivor SOS page (no sign-in)
# ======================================================================
def _public_view(row):
    msgs = store.messages("sos", row["id"])
    for m in msgs:
        if m["sender"] == "team" and m["delivery"] == "waiting":
            store.set_delivery(m["id"], "delivered")
    return {
        "id": row["id"], "status": row["status"], "team": row["team"],
        "messages": [{"sender": m["sender"], "text": m["text"], "audio_url": m["audio_url"],
                      "team": m["team"], "ts": m["ts"]} for m in msgs],
    }


@app.post("/api/public/sos")
def public_sos(s: PublicSOS, request: Request):
    rate_limit(request, "sos", 5, 600)
    sid, secret = store.add_sos(s.model_dump())
    return {"id": sid, "secret": secret}


@app.get("/api/public/sos/{sid}")
def public_sos_view(sid: str, secret: str):
    row = store.sos_by_secret(sid, secret)
    if not row:
        raise HTTPException(404, "Not found")
    store.touch_sos(sid)
    return _public_view(row)


@app.post("/api/public/sos/{sid}/update")
def public_sos_update(sid: str, u: PublicUpdate, request: Request):
    rate_limit(request, "sos-msg", 30, 300)
    row = store.sos_by_secret(sid, u.secret)
    if not row:
        raise HTTPException(404, "Not found")
    store.touch_sos(sid, u.lat, u.lon, u.accuracy)
    if u.text.strip():
        store.add_message("sos", sid, "survivor", u.text.strip())
    return _public_view(store.sos_by_secret(sid, u.secret))


# ======================================================================
# Hazards, team positions, recordings (team only)
# ======================================================================
@app.post("/api/hazards")
def hazard_create(h: Hazard, team=Depends(require_team)):
    return {"id": store.add_hazard(h.model_dump(), team["team"])}


@app.put("/api/units/me")
def unit_update(u: Unit, team=Depends(require_team)):
    store.update_unit({"device_id": team["device_id"], "team": team["team"], "member": team["member"],
                       **u.model_dump()})
    return {"ok": True}


EXT = {"audio/webm": "webm", "video/webm": "webm", "audio/mp4": "m4a", "video/mp4": "mp4",
       "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
       "video/quicktime": "mov"}


async def save_upload(file, folder, url_prefix, name=None):
    mime = (file.content_type or "").split(";")[0]
    if not mime.startswith(("audio/", "video/")):
        raise HTTPException(400, "Only audio or video files are accepted")
    name = name or uuid.uuid4().hex[:16]
    name = "".join(c for c in name if c.isalnum() or c in "-_")[:40]
    fname = "{}.{}".format(name, EXT.get(mime, "bin"))
    dest = folder / fname
    size, limit = 0, MAX_UPLOAD_MB * 1024 * 1024
    with dest.open("wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                out.close()
                dest.unlink()
                raise HTTPException(413, "File larger than {} MB".format(MAX_UPLOAD_MB))
            out.write(chunk)
    return "/media/{}/{}".format(url_prefix, fname)


@app.post("/api/recordings")
async def recording_upload(
    file: UploadFile = File(...),
    kind: Literal["audio", "video"] = Form(...),
    rec_id: str = Form(default=""),
    duration: float = Form(default=0),
    lat: Optional[float] = Form(default=None),
    lon: Optional[float] = Form(default=None),
    note: str = Form(default=""),
    team=Depends(require_team),
):
    rid = "".join(c for c in (rec_id or uuid.uuid4().hex) if c.isalnum() or c in "-_")[:40]
    url = await save_upload(file, REC_DIR, "recordings", rid)
    fname = url.rsplit("/", 1)[-1]
    size = (REC_DIR / fname).stat().st_size
    store.add_recording({"id": rid, "kind": kind, "filename": fname, "mime": file.content_type, "size": size,
                         "duration": duration, "lat": lat, "lon": lon, "note": note[:500],
                         "team": team["team"]})
    return {"id": rid, "url": url}


# ======================================================================
# Live disaster alerts — INDIA ONLY
#   NDMA SACHET (official CAP alerts): https://sachet.ndma.gov.in/
#   GDACS (UN/EU global alerts, filtered to India): https://www.gdacs.org/
#   USGS earthquakes (filtered to India):           https://earthquake.usgs.gov/
# ======================================================================
SACHET_RSS = "https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml"
GDACS_RSS = "https://www.gdacs.org/xml/rss.xml"
USGS_FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson"
GDACS_TYPES = {"EQ": "Earthquake", "TC": "Cyclone", "FL": "Flood", "VO": "Volcano",
               "DR": "Drought", "WF": "Wildfire", "TS": "Tsunami"}
SEVERITY_LEVEL = {"extreme": "red", "severe": "orange", "moderate": "yellow", "minor": "green", "unknown": "yellow"}

_feed_cache = {"ts": 0.0, "data": None}
_cap_cache = {}   # CAP url -> parsed alert


def _tag(el):
    return el.tag.split("}")[-1].lower()


def _child_text(el, name):
    for c in el:
        if _tag(c) == name:
            return (c.text or "").strip()
    return ""


def _parse_time(v):
    if not v:
        return None
    try:
        return parsedate_to_datetime(v).timestamp()
    except (TypeError, ValueError):
        pass
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# Indian scripts by Unicode block, used when an alert does not state its language
SCRIPTS = [((0x0980, 0x09FF), "Bengali"), ((0x0900, 0x097F), "Hindi"), ((0x0B80, 0x0BFF), "Tamil"),
           ((0x0C00, 0x0C7F), "Telugu"), ((0x0C80, 0x0CFF), "Kannada"), ((0x0D00, 0x0D7F), "Malayalam"),
           ((0x0A80, 0x0AFF), "Gujarati"), ((0x0A00, 0x0A7F), "Punjabi"), ((0x0B00, 0x0B7F), "Odia")]
LANG_CODES = {"en": "English", "hi": "Hindi", "bn": "Bengali", "ta": "Tamil", "te": "Telugu", "kn": "Kannada",
              "ml": "Malayalam", "gu": "Gujarati", "pa": "Punjabi", "or": "Odia", "mr": "Marathi", "as": "Assamese"}


def detect_language(text, declared=""):
    for ch in text:
        code = ord(ch)
        for (lo, hi), name in SCRIPTS:
            if lo <= code <= hi:
                if name == "Hindi" and declared.lower().startswith("mr"):
                    return "Marathi"
                if name == "Bengali" and declared.lower().startswith("as"):
                    return "Assamese"
                return name
    if declared:
        return LANG_CODES.get(declared.lower()[:2], declared)
    return "English"


def _parse_cap(xml_bytes, url):
    root = ET.fromstring(xml_bytes)
    sent = None
    infos = []
    for c in root:
        t = _tag(c)
        if t == "sent":
            sent = _parse_time((c.text or "").strip())
        elif t == "info":
            infos.append(c)
    if not infos:
        return None
    # An alert can carry the same message in several languages: prefer English
    info = next((i for i in infos if _child_text(i, "language").lower().startswith("en")
                 and detect_language(_child_text(i, "headline")) == "English"), None)
    if info is None:
        info = next((i for i in infos if detect_language(_child_text(i, "headline") or _child_text(i, "description"))
                     == "English"), infos[0])
    rec = {
        "source": "NDMA SACHET",
        "type": _child_text(info, "event") or "Alert",
        "title": _child_text(info, "headline") or _child_text(info, "event"),
        "description": _child_text(info, "description")[:600],
        "instruction": _child_text(info, "instruction")[:400],
        "issuer": _child_text(info, "sendername"),
        "level": SEVERITY_LEVEL.get(_child_text(info, "severity").lower(), "yellow"),
        "severity": _child_text(info, "severity"),
        "time": sent or time.time(),
        "expires": _parse_time(_child_text(info, "expires")),
        "url": url,
        "polygons": [],
    }
    rec["language"] = detect_language(rec["title"] + rec["description"], _child_text(info, "language"))
    area_names = []
    pts_all = []
    for area in info:
        if _tag(area) != "area":
            continue
        area_names.append(_child_text(area, "areadesc"))
        for g in area:
            if _tag(g) == "polygon" and g.text:
                pts = []
                for pair in g.text.split():
                    try:
                        a, b = pair.split(",")[:2]
                        pts.append((float(a), float(b)))
                    except ValueError:
                        continue
                if len(pts) >= 3:
                    step = max(1, len(pts) // 150)        # keep polygons light for the phone
                    rec["polygons"].append(pts[::step])
                    pts_all += pts
            elif _tag(g) == "circle" and g.text:
                try:
                    centre, _radius = g.text.split()
                    a, b = centre.split(",")
                    pts_all.append((float(a), float(b)))
                except ValueError:
                    pass
    rec["area"] = ", ".join(n for n in area_names if n)[:300]
    if pts_all:
        rec["lat"] = sum(p[0] for p in pts_all) / len(pts_all)
        rec["lon"] = sum(p[1] for p in pts_all) / len(pts_all)
    return rec


async def _fetch_sachet(client):
    r = await client.get(SACHET_RSS)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    links = []
    for item in root.iter():
        if _tag(item) == "item":
            link = _child_text(item, "link")
            if link:
                links.append((link, _child_text(item, "title"), _parse_time(_child_text(item, "pubdate"))))
    links = links[:40]

    async def get_cap(link, title, pub):
        if link in _cap_cache:
            return _cap_cache[link]
        try:
            rr = await client.get(link)
            rr.raise_for_status()
            rec = _parse_cap(rr.content, link)
        except Exception:
            rec = None
        if rec is None:
            rec = {"source": "NDMA SACHET", "type": "Alert", "title": title, "level": "yellow",
                   "time": pub or time.time(), "url": link, "polygons": []}
        _cap_cache[link] = rec
        return rec

    recs = await asyncio.gather(*[get_cap(*l) for l in links])
    now = time.time()
    return [r for r in recs if not r.get("expires") or r["expires"] > now]


async def _fetch_gdacs(client):
    r = await client.get(GDACS_RSS)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    out = []
    for item in root.iter():
        if _tag(item) != "item":
            continue
        rec = {"source": "GDACS"}
        country, iso3 = "", ""
        for c in item:
            t, v = _tag(c), (c.text or "").strip()
            if t == "title":
                rec["title"] = v
            elif t == "link":
                rec["url"] = v
            elif t == "eventtype":
                rec["type"] = GDACS_TYPES.get(v, v)
            elif t == "alertlevel":
                rec["level"] = v.lower()
            elif t == "country":
                country = v
            elif t == "iso3":
                iso3 = v
            elif t == "pubdate":
                rec["time"] = _parse_time(v) or time.time()
            elif t == "point":
                for p in c:
                    if _tag(p) == "lat":
                        rec["lat"] = float(p.text)
                    elif _tag(p) == "long":
                        rec["lon"] = float(p.text)
                if "lat" not in rec and v:
                    parts = v.split()
                    if len(parts) == 2:
                        rec["lat"], rec["lon"] = float(parts[0]), float(parts[1])
        in_india = "IND" in iso3.upper().split(",") or "india" in country.lower() \
            or "india" in rec.get("title", "").lower()
        if in_india and "title" in rec:
            rec.setdefault("type", "Alert")
            rec.setdefault("level", "green")
            rec.setdefault("time", time.time())
            rec["polygons"] = []
            out.append(rec)
    return out


async def _fetch_usgs(client):
    r = await client.get(USGS_FEED)
    r.raise_for_status()
    out = []
    for f in r.json().get("features", []):
        p, g = f["properties"], f["geometry"]["coordinates"]
        place = p.get("place") or ""
        if not place.rstrip().lower().endswith("india"):
            continue
        mag = p.get("mag") or 0
        out.append({
            "source": "USGS", "type": "Earthquake",
            "title": "Magnitude {} earthquake — {}".format(mag, place),
            "level": "red" if mag >= 6.5 else "orange" if mag >= 5.0 else "yellow" if mag >= 4.0 else "green",
            "time": (p.get("time") or 0) / 1000, "lat": g[1], "lon": g[0], "url": p.get("url"),
            "polygons": [],
        })
    return out


_translations = {}   # original title -> English


async def translate_alerts(events):
    """Translate non-English alert titles to English with the AI model (if a key is set).
    The original text is kept; the English version is added as title_en."""
    todo = [e for e in events if e["language"] != "English"]
    for e in todo:
        if e["title"] in _translations:
            e["title_en"] = _translations[e["title"]]
    missing = list(dict.fromkeys(e["title"] for e in todo if e["title"] not in _translations))[:40]
    if not missing or not ANTHROPIC_API_KEY:
        return
    try:
        import json as _json
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY, timeout=40)
        numbered = "\n".join("{}. {}".format(i + 1, t) for i, t in enumerate(missing))
        resp = await client.messages.create(
            model=AI_MODEL, max_tokens=4000,
            system="You translate official Indian disaster alerts into clear, plain English. Keep place names, "
                   "times and numbers exactly. Reply with ONLY a JSON array of strings, one translation per input "
                   "line, in the same order.",
            messages=[{"role": "user", "content": numbered}],
        )
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
        start, end = text.find("["), text.rfind("]")
        out = _json.loads(text[start:end + 1])
        for original, english in zip(missing, out):
            if isinstance(english, str) and english.strip():
                _translations[original] = english.strip()
        for e in todo:
            if e["title"] in _translations:
                e["title_en"] = _translations[e["title"]]
    except Exception as ex:
        store.log("warn", "alerts", "Could not translate alerts ({})".format(type(ex).__name__))


@app.get("/api/disasters/india")
async def disasters_india():
    if _feed_cache["data"] and time.time() - _feed_cache["ts"] < 300:
        return _feed_cache["data"]
    events, errors = [], []
    async with httpx.AsyncClient(timeout=15, follow_redirects=True,
                                 headers={"User-Agent": "SAADAXA/2.0 (disaster response)"}) as client:
        results = await asyncio.gather(_fetch_sachet(client), _fetch_gdacs(client), _fetch_usgs(client),
                                       return_exceptions=True)
    for name, res in zip(("NDMA SACHET", "GDACS", "USGS"), results):
        if isinstance(res, Exception):
            errors.append("{}: {}".format(name, type(res).__name__))
        else:
            events += res
    for e in events:
        e.setdefault("language", detect_language(e.get("title", "")))
    await translate_alerts(events)
    if ALERTS_ENGLISH_ONLY:
        events = [e for e in events if e["language"] == "English" or e.get("title_en")]
    events.sort(key=lambda e: e.get("time", 0), reverse=True)
    data = {"fetched": time.time(), "events": events, "errors": errors, "online": bool(events) or len(errors) < 3}
    if not errors or events:
        _feed_cache.update(ts=time.time(), data=data)
    elif _feed_cache["data"]:
        return dict(_feed_cache["data"], stale=True, errors=errors)
    return data


# ======================================================================
# AI assistant (team only)
# ======================================================================
SYSTEM_PROMPT = """You are the SAADAXA operations assistant for disaster rescue teams in India.
The person asking is a rescue team member working in the field.

Rules:
- Be brief and practical: short numbered steps, field-ready. No jargon unless it is standard rescue terminology.
- Cover triage (START), first aid, crush injuries, confined-space and collapsed-structure safety,
  water rescue, casualty handling, and team coordination.
- When asked about cases, use ONLY the live data below. Never invent survivors, locations, numbers or ETAs.
- Remind about team safety when relevant (secure the scene before entry).
- Keep answers under 180 words unless asked for more. Answer in the language the user writes in.

Live data from the ground server:
{context}"""


def situation_context(lat, lon):
    snap = store.snapshot()
    st = snap["stats"]
    lines = [
        "Operation: {}{}".format(OPERATION_NAME, " (TRAINING SIMULATION — synthetic aircraft data)" if SIMULATION else ""),
        "Open cases: {} (new {}, critical {}), rescued: {}".format(st["open"], st["new"], st["critical"], st["rescued"]),
        "Aerial units active: {}".format(len(snap["drones"])),
    ]
    open_cases = [c for c in snap["cases"] if c["status"] not in ("rescued", "closed")]
    if lat is not None and lon is not None:
        lines.append("Asking team member position: {:.5f}, {:.5f}".format(lat, lon))
        for c in open_cases:
            c["_d"] = haversine_m(lat, lon, c["lat"], c["lon"])
        open_cases.sort(key=lambda c: c["_d"])
    for c in open_cases[:15]:
        d = " · {:.0f} m away".format(c["_d"]) if "_d" in c else ""
        who = "SOS call, {} person(s){}".format(c.get("people", 1), ", injured" if c.get("injured") else "") \
            if c["type"] == "sos" else "survivor detected by aircraft ({}heat signature)".format("" if c.get("thermal") else "no ")
        lines.append("- {} [{} priority, status {}, team {}] {}{}".format(
            c["id"], c["priority"], c["status"], c["team"] or "none", who, d))
    for h in snap["hazards"][:5]:
        lines.append("- Hazard: {} ({})".format(h["kind"], h["severity"]))
    return "\n".join(lines)


@app.post("/api/chat")
async def chat(req: ChatRequest, team=Depends(require_team)):
    msgs = [m.model_dump() for m in req.messages if m.content.strip()][-12:]
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    if not msgs:
        raise HTTPException(400, "No question")
    question = msgs[-1]["content"]
    if not ANTHROPIC_API_KEY:
        return {"reply": offline_answer(question), "mode": "offline"}
    try:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY, timeout=30)
        resp = await client.messages.create(
            model=AI_MODEL, max_tokens=700,
            system=SYSTEM_PROMPT.format(context=situation_context(req.lat, req.lon)),
            messages=msgs,
        )
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
        return {"reply": text or offline_answer(question), "mode": "online"}
    except Exception as e:
        store.log("warn", "assistant", "AI unavailable ({}); used offline guidance".format(type(e).__name__))
        return {"reply": offline_answer(question), "mode": "offline", "error": type(e).__name__}


# ======================================================================
# Live WebSocket for signed-in teams (2 Hz)
# ======================================================================
@app.websocket("/ws")
async def ws(socket: WebSocket, token: str = ""):
    if not store.team_for(token):
        await socket.close(code=4401)
        return
    await socket.accept()
    try:
        last_sent = -1
        while True:
            if store.version != last_sent:
                last_sent = store.version
                await socket.send_text(store.to_json())
            await asyncio.sleep(0.5)
    except (WebSocketDisconnect, RuntimeError):
        pass


# ======================================================================
# Static files — must be mounted last
# ======================================================================
app.mount("/media/recordings", StaticFiles(directory=REC_DIR), name="recordings")
app.mount("/media/voice", StaticFiles(directory=VOICE_DIR), name="voice")
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
