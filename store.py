"""
SQLite-backed storage for the SAADAXA ground server.

Holds:
  * survivors     - found by aerial units (merged within 3 m)
  * sos           - SOS calls sent by survivors from the public SOS page
  * messages      - conversation per case (rescue team <-> survivor)
  * hazards       - field hazard reports
  * units         - rescue team positions
  * teams         - signed-in rescue team devices (tokens)
  * recordings    - uploaded audio / video
  * events        - operation log

A "case" is either a survivor detection or an SOS call. Rescue teams accept
a case and move it through: new -> accepted -> en_route -> on_scene -> rescued.
Drone telemetry is kept in memory only because it changes several times a second.
"""
import json
import secrets
import sqlite3
import threading
import time
import uuid
from pathlib import Path

from geo import haversine_m

DEDUP_RADIUS_M = 3.0
UNIT_STALE_S = 180
TELEMETRY_STALE_S = 15
CASE_STATUSES = ("new", "accepted", "en_route", "on_scene", "rescued", "closed")
CASE_TABLES = {"survivor": "survivors", "sos": "sos"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS survivors (
    id TEXT PRIMARY KEY, lat REAL, lon REAL, confidence REAL, thermal INTEGER,
    priority TEXT, status TEXT, team TEXT, detections INTEGER, drone_id TEXT, nav_mode TEXT,
    link TEXT, first_seen REAL, last_seen REAL, updated REAL, note TEXT
);
CREATE TABLE IF NOT EXISTS sos (
    id TEXT PRIMARY KEY, secret TEXT, lat REAL, lon REAL, accuracy REAL, people INTEGER,
    injured INTEGER, note TEXT, contact TEXT, priority TEXT, status TEXT, team TEXT,
    created REAL, updated REAL, last_seen REAL
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, case_type TEXT, case_id TEXT, sender TEXT,
    team TEXT, text TEXT, audio_url TEXT, ts REAL, delivery TEXT, drone_id TEXT
);
CREATE TABLE IF NOT EXISTS hazards (
    id TEXT PRIMARY KEY, lat REAL, lon REAL, kind TEXT, severity TEXT,
    note TEXT, team TEXT, created REAL, status TEXT
);
CREATE TABLE IF NOT EXISTS units (
    device_id TEXT PRIMARY KEY, team TEXT, member TEXT, lat REAL, lon REAL, accuracy REAL,
    source TEXT, updated REAL
);
CREATE TABLE IF NOT EXISTS teams (
    token TEXT PRIMARY KEY, device_id TEXT, team TEXT, member TEXT, created REAL, last_seen REAL
);
CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY, kind TEXT, filename TEXT, mime TEXT, size INTEGER,
    duration REAL, lat REAL, lon REAL, note TEXT, team TEXT, created REAL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, level TEXT, kind TEXT, message TEXT
);
"""


def _new_id(prefix):
    return "{}-{}".format(prefix, uuid.uuid4().hex[:6].upper())


class Store:
    def __init__(self, db_path):
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._move_old_database(Path(db_path))
        self.lock = threading.Lock()
        self.db = sqlite3.connect(str(db_path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.db.commit()
        self.telemetry = {}   # drone_id -> latest telemetry
        self.version = 0      # bumped on every change so the WebSocket knows to push

    @staticmethod
    def _move_old_database(path):
        """A database from SAADAXA 1.x has a different layout: keep it as a backup and start fresh."""
        if not path.exists():
            return
        con = sqlite3.connect(str(path))
        try:
            cols = [r[1] for r in con.execute("PRAGMA table_info(survivors)").fetchall()]
            old = bool(cols) and "team" not in cols
        finally:
            con.close()
        if old:
            backup = path.with_name("saadaxa-v1-backup.db")
            if backup.exists():
                backup.unlink()
            path.rename(backup)
            print("NOTE: old version-1 database moved to", backup.name)

    # ---------------- helpers ----------------
    def _rows(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def _one(self, sql, args=()):
        rows = self._rows(sql, args)
        return rows[0] if rows else None

    def _exec(self, sql, args=()):
        with self.lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
        self.version += 1
        return cur

    def log(self, level, kind, message):
        self._exec("INSERT INTO events (ts, level, kind, message) VALUES (?,?,?,?)",
                   (time.time(), level, kind, message))

    # ---------------- rescue teams ----------------
    def team_login(self, device_id, team, member):
        token = secrets.token_urlsafe(24)
        now = time.time()
        self._exec("DELETE FROM teams WHERE device_id=?", (device_id,))
        self._exec("INSERT INTO teams (token, device_id, team, member, created, last_seen) VALUES (?,?,?,?,?,?)",
                   (token, device_id, team, member, now, now))
        self.log("info", "team", "{} ({}) signed in".format(team, member))
        return token

    def team_for(self, token):
        if not token:
            return None
        t = self._one("SELECT * FROM teams WHERE token=?", (token,))
        if t:
            with self.lock:
                self.db.execute("UPDATE teams SET last_seen=? WHERE token=?", (time.time(), token))
                self.db.commit()
        return t

    def team_logout(self, token):
        self._exec("DELETE FROM teams WHERE token=?", (token,))

    # ---------------- drones ----------------
    def update_telemetry(self, t):
        prev = self.telemetry.get(t["drone_id"])
        t["ts"] = time.time()
        self.telemetry[t["drone_id"]] = t
        self.version += 1
        if prev:
            if prev.get("link") != t.get("link"):
                if t.get("link") == "LORA":
                    self.log("warn", "link", "{}: wideband weak (RSSI {} dBm). Switched to long-range radio. "
                             "Live video and voice paused.".format(t["drone_id"], t.get("rssi")))
                else:
                    self.log("info", "link", "{}: wideband link restored. Live video and voice resumed."
                             .format(t["drone_id"]))
            if prev.get("nav_mode") != t.get("nav_mode"):
                self.log("info" if t.get("nav_mode") == "GNSS" else "warn", "nav",
                         "{}: navigation mode {} -> {}".format(t["drone_id"], prev.get("nav_mode"), t.get("nav_mode")))

    def drones(self):
        now = time.time()
        return [t for t in self.telemetry.values() if now - t["ts"] < TELEMETRY_STALE_S]

    # ---------------- survivors (drone detections) ----------------
    def add_detection(self, d):
        now = time.time()
        existing = self._rows("SELECT * FROM survivors WHERE status NOT IN ('rescued','closed')")
        best, best_dist = None, None
        for s in existing:
            dist = haversine_m(s["lat"], s["lon"], d["lat"], d["lon"])
            if dist <= DEDUP_RADIUS_M and (best_dist is None or dist < best_dist):
                best, best_dist = s, dist
        if best:
            n = best["detections"] + 1
            lat = (best["lat"] * best["detections"] + d["lat"]) / n
            lon = (best["lon"] * best["detections"] + d["lon"]) / n
            conf = max(best["confidence"], d["confidence"])
            thermal = 1 if (best["thermal"] or d.get("thermal")) else 0
            self._exec("""UPDATE survivors SET lat=?, lon=?, confidence=?, thermal=?, detections=?,
                          last_seen=?, nav_mode=?, link=?, drone_id=? WHERE id=?""",
                       (lat, lon, conf, thermal, n, now, d.get("nav_mode"), d.get("link"),
                        d.get("drone_id"), best["id"]))
            return {"id": best["id"], "merged": True}
        sid = _new_id("SV")
        priority = d.get("priority") or ("critical" if d.get("thermal") and d["confidence"] >= 0.8
                                         else "high" if d["confidence"] >= 0.65 else "medium")
        self._exec("""INSERT INTO survivors (id, lat, lon, confidence, thermal, priority, status, team, detections,
                      drone_id, nav_mode, link, first_seen, last_seen, updated, note)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                   (sid, d["lat"], d["lon"], d["confidence"], 1 if d.get("thermal") else 0, priority,
                    "new", "", 1, d.get("drone_id"), d.get("nav_mode"), d.get("link"), now, now, now, ""))
        self.log("alert", "case", "New survivor {} located by {} ({} priority)".format(sid, d.get("drone_id"), priority))
        return {"id": sid, "merged": False}

    # ---------------- SOS calls from survivors ----------------
    def add_sos(self, s):
        sid = _new_id("SOS")
        secret = secrets.token_urlsafe(16)
        now = time.time()
        injured = int(s.get("injured", 0))
        priority = "critical" if injured or s.get("trapped") else "high"
        self._exec("""INSERT INTO sos (id, secret, lat, lon, accuracy, people, injured, note, contact, priority,
                      status, team, created, updated, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                   (sid, secret, s["lat"], s["lon"], s.get("accuracy"), s.get("people", 1), injured,
                    s.get("note", ""), s.get("contact", ""), priority, "new", "", now, now, now))
        if s.get("note"):
            self.add_message("sos", sid, "survivor", s["note"])
        self.log("alert", "case", "SOS {} received — {} person(s){}".format(
            sid, s.get("people", 1), ", injured" if injured else ""))
        return sid, secret

    def sos_by_secret(self, sid, secret):
        row = self._one("SELECT * FROM sos WHERE id=?", (sid,))
        if not row or not secrets.compare_digest(row["secret"], secret or ""):
            return None
        return row

    def touch_sos(self, sid, lat=None, lon=None, accuracy=None):
        if lat is not None and lon is not None:
            self._exec("UPDATE sos SET lat=?, lon=?, accuracy=?, last_seen=? WHERE id=?",
                       (lat, lon, accuracy, time.time(), sid))
        else:
            with self.lock:
                self.db.execute("UPDATE sos SET last_seen=? WHERE id=?", (time.time(), sid))
                self.db.commit()

    # ---------------- cases (shared by survivors + SOS) ----------------
    def get_case(self, case_type, cid):
        table = CASE_TABLES.get(case_type)
        if not table:
            return None
        return self._one("SELECT * FROM {} WHERE id=?".format(table), (cid,))

    def set_case_status(self, case_type, cid, status, team):
        table = CASE_TABLES[case_type]
        case = self.get_case(case_type, cid)
        if not case:
            return None
        assigned = case["team"]
        if status == "new":
            assigned = ""
        elif status == "accepted" or not assigned:
            assigned = team
        self._exec("UPDATE {} SET status=?, team=?, updated=? WHERE id=?".format(table),
                   (status, assigned, time.time(), cid))
        label = {"new": "released back to open cases", "accepted": "accepted", "en_route": "en route",
                 "on_scene": "on scene", "rescued": "rescued", "closed": "closed"}[status]
        self.log("ok" if status == "rescued" else "info", "case", "{} {} by {}".format(cid, label, team))
        if case_type == "sos":
            notes = {"accepted": "A rescue team has accepted your SOS and is preparing to reach you.",
                     "en_route": "The rescue team is on the way to you. Stay where you are if it is safe.",
                     "on_scene": "The rescue team has reached your area. Make noise or show a light.",
                     "rescued": "You have been marked as rescued. Stay with the team.",
                     "new": "Your SOS is waiting for the next available rescue team."}
            if status in notes:
                self.add_message("sos", cid, "system", notes[status])
        return True

    # ---------------- messages ----------------
    def add_message(self, case_type, case_id, sender, text="", team="", audio_url="", delivery="", drone_id=""):
        cur = self._exec("""INSERT INTO messages (case_type, case_id, sender, team, text, audio_url, ts, delivery, drone_id)
                            VALUES (?,?,?,?,?,?,?,?,?)""",
                         (case_type, case_id, sender, team, text, audio_url, time.time(), delivery, drone_id))
        return cur.lastrowid

    def messages(self, case_type, case_id):
        return self._rows("SELECT * FROM messages WHERE case_type=? AND case_id=? ORDER BY id", (case_type, case_id))

    def set_delivery(self, msg_id, delivery):
        self._exec("UPDATE messages SET delivery=? WHERE id=?", (delivery, msg_id))

    def drone_outbox(self, drone_id):
        """Team messages waiting to be played through a drone's loudspeaker."""
        rows = self._rows("""SELECT m.*, s.lat, s.lon FROM messages m JOIN survivors s ON s.id = m.case_id
                             WHERE m.case_type='survivor' AND m.sender='team' AND m.delivery='queued'
                             AND (m.drone_id=? OR m.drone_id='') ORDER BY m.id""", (drone_id,))
        for r in rows:
            self.set_delivery(r["id"], "sent")
        return rows

    def thread_summary(self):
        rows = self._rows("""SELECT case_type, case_id, COUNT(*) AS n, MAX(ts) AS last_ts,
                             SUM(CASE WHEN sender='survivor' THEN 1 ELSE 0 END) AS from_survivor
                             FROM messages GROUP BY case_type, case_id""")
        out = {}
        for r in rows:
            last = self._one("SELECT sender FROM messages WHERE case_type=? AND case_id=? ORDER BY id DESC LIMIT 1",
                             (r["case_type"], r["case_id"]))
            out["{}:{}".format(r["case_type"], r["case_id"])] = {
                "count": r["n"], "last_ts": r["last_ts"], "from_survivor": r["from_survivor"],
                "last_sender": last["sender"] if last else ""}
        return out

    # ---------------- hazards ----------------
    def add_hazard(self, h, team):
        hid = _new_id("HZ")
        self._exec("""INSERT INTO hazards (id, lat, lon, kind, severity, note, team, created, status)
                      VALUES (?,?,?,?,?,?,?,?,?)""",
                   (hid, h["lat"], h["lon"], h["kind"], h["severity"], h.get("note", ""), team,
                    h.get("created") or time.time(), "open"))
        self.log("warn", "hazard", "Hazard reported by {}: {} ({})".format(team, h["kind"], h["severity"]))
        return hid

    # ---------------- team positions ----------------
    def update_unit(self, u):
        self._exec("""INSERT INTO units (device_id, team, member, lat, lon, accuracy, source, updated)
                      VALUES (?,?,?,?,?,?,?,?)
                      ON CONFLICT(device_id) DO UPDATE SET team=excluded.team, member=excluded.member,
                      lat=excluded.lat, lon=excluded.lon, accuracy=excluded.accuracy,
                      source=excluded.source, updated=excluded.updated""",
                   (u["device_id"], u["team"], u["member"], u["lat"], u["lon"], u.get("accuracy"),
                    u.get("source", ""), time.time()))

    # ---------------- recordings ----------------
    def add_recording(self, r):
        self._exec("""INSERT OR REPLACE INTO recordings (id, kind, filename, mime, size, duration, lat, lon,
                      note, team, created) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                   (r["id"], r["kind"], r["filename"], r["mime"], r["size"], r.get("duration"),
                    r.get("lat"), r.get("lon"), r.get("note", ""), r.get("team", ""), time.time()))
        self.log("info", "recording", "{} recording received from {}".format(r["kind"].capitalize(), r.get("team", "")))
        return r["id"]

    def recordings(self):
        return self._rows("SELECT * FROM recordings ORDER BY created DESC LIMIT 100")

    # ---------------- snapshot pushed to the team app ----------------
    def snapshot(self):
        surv = self._rows("SELECT * FROM survivors ORDER BY last_seen DESC")
        sos = self._rows("""SELECT id, lat, lon, accuracy, people, injured, note, contact, priority, status, team,
                            created, updated, last_seen FROM sos ORDER BY created DESC LIMIT 300""")
        cases = ([dict(s, type="survivor") for s in surv] + [dict(s, type="sos") for s in sos])
        open_cases = [c for c in cases if c["status"] not in ("rescued", "closed")]
        return {
            "type": "state",
            "ts": time.time(),
            "drones": self.drones(),
            "cases": cases,
            "threads": self.thread_summary(),
            "hazards": self._rows("SELECT * FROM hazards ORDER BY created DESC LIMIT 200"),
            "units": self._rows("SELECT * FROM units WHERE updated > ?", (time.time() - UNIT_STALE_S,)),
            "events": self._rows("SELECT * FROM events ORDER BY id DESC LIMIT 30"),
            "stats": {
                "open": len(open_cases),
                "new": sum(1 for c in cases if c["status"] == "new"),
                "critical": sum(1 for c in open_cases if c["priority"] == "critical"),
                "rescued": sum(1 for c in cases if c["status"] == "rescued"),
                "sos_open": sum(1 for c in open_cases if c["type"] == "sos"),
            },
        }

    def to_json(self):
        return json.dumps(self.snapshot(), separators=(",", ":"))
