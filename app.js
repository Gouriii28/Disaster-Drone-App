// SAADAXA rescue-team console — main controller.
import { $, $$, esc, toast, openSheet, closeSheet, ago, fmtDist, fmtCoord, fmtTime, fmtBytes, clock,
         PRIORITY_LABEL, CASE_STATUS_LABEL, CASE_TYPE_LABEL, NAV_LABEL, LINK_LABEL } from "./ui.js";
import { api, connectLive, onState, onNetStatus, net, sendOrQueue, onOutbox, flushOutbox, deviceId,
         session, login, logout, setSignedOutHandler } from "./api.js";
import { loc, onLocation, startLocation, startSensors, setManualPosition, setServerReachable, setShare,
         distanceM, bearingDeg, compass, modeLabel, netLabel } from "./location.js";
import * as mapView from "./map.js";
import * as recorder from "./recorder.js";
import * as chat from "./chat.js";
import { db } from "./db.js";

const app = {
  config: { simulation: false, operation: "—", center: { lat: 22.5, lon: 79.0 }, assistant_online: false },
  state: null,
  alerts: [],
  view: "home",
  caseFilter: "new",
  openCase: null,          // { type, id }
  hazardPoint: null,
  seenThreads: {},         // "type:id" -> message count already seen
};
let outboxCount = 0;
const sosUrl = () => `${location.origin}/sos.html`;
try { app.seenThreads = JSON.parse(localStorage.getItem("saadaxa.seen")) || {}; } catch {}


// Replace an element's HTML only when it really changed, and at most every few
// seconds for time-only changes ("12 s ago"), so buttons are not swapped out
// under the user's finger while the live feed updates twice a second.
function setHTML(el, html, sig, after) {
  const now = Date.now();
  if (el._sig === sig && now - (el._at || 0) < 10000) return false;
  if (el._html === html) { el._sig = sig; el._at = now; return false; }
  el.innerHTML = html;
  el._html = html; el._sig = sig; el._at = now;
  if (after) after(el);
  return true;
}
const caseSig = (list) => list.map((c) => `${c.type}${c.id}${c.status}${c.team}${c.priority}${unread(c)}${Math.round((caseDistance(c) ?? 0) / 10)}`).join("|");

const me = () => (loc.fix ? loc.fix : null);
const myTeam = () => session.get()?.team || "";
const ACTIVE = ["accepted", "en_route", "on_scene"];

// =====================================================================
// Layout: map and chat fill the space between banners and tab bar
// =====================================================================
function fitViewport() {
  const top = $("#views").getBoundingClientRect().top + window.scrollY;
  document.documentElement.style.setProperty("--content-top", Math.max(0, Math.round(top)) + "px");
  if (app.view === "map") mapView.refreshSize();
}
window.addEventListener("resize", fitViewport);
new MutationObserver(fitViewport).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden"] });

// =====================================================================
// Navigation
// =====================================================================
function go(name) {
  if (app.view === "record" && name !== "record") leaveRecord();
  app.view = name;
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  $$(".tab").forEach((t) => t.classList.toggle("on", t.dataset.go === name));
  window.scrollTo(0, 0);
  fitViewport();
  if (name === "map") {
    const m = mapView.initMap($("#map"), null);
    if (m) {
      mapView.refreshSize();
      if (app.state) mapView.renderState(app.state, showCase);
      mapView.renderAlerts(app.alerts);
      mapView.renderMe(loc.fix, loc.mode);
    }
  }
  if (name === "assist") chat.renderChat();
  if (name === "record") renderRecordings();
  if (name === "cases") renderCases();
  try { history.replaceState(null, "", "#" + name); } catch {}
}
$$("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));

// =====================================================================
// Sign-in
// =====================================================================
function showSignIn() {
  $("#signin").hidden = false;
  document.body.classList.add("signed-out");
}
setSignedOutHandler(() => { toast("Signed out. Please sign in again.", "bad"); showSignIn(); });

$("#signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#si-error").hidden = true;
  $("#si-submit").disabled = true;
  try {
    await login($("#si-code").value.trim(), $("#si-team").value.trim(), $("#si-member").value.trim());
    $("#si-code").value = "";
    $("#signin").hidden = true;
    document.body.classList.remove("signed-out");
    startSession();
  } catch (err) {
    $("#si-error").textContent = err.message || "Could not reach the ground server.";
    $("#si-error").hidden = false;
  }
  $("#si-submit").disabled = false;
});

function startSession() {
  const s = session.get();
  $("#op-team").textContent = s ? `${s.team} · ${s.member}` : "";
  $("#brand-sub").textContent = s ? `Rescue Team Console · ${s.team}` : "Rescue Team Console";
  connectLive();
  flushOutbox();
  loadAlerts();
}

// =====================================================================
// Server connection + config
// =====================================================================
async function loadConfig() {
  try { app.config = await api("/api/config"); } catch {}
  $("#op-name").textContent = app.config.operation;
  $("#sim-banner").hidden = !app.config.simulation;
  chat.setMode(app.config.assistant_online ? "online" : "offline");
}

let offlineTimer = null;
onNetStatus((n) => {
  const dot = $("#net-dot");
  dot.className = "net-dot " + (n.connected ? "on" : "off");
  setServerReachable(n.connected);
  clearTimeout(offlineTimer);
  if (n.connected) $("#offline-banner").hidden = true;
  else offlineTimer = setTimeout(() => ($("#offline-banner").hidden = net.connected || !session.get()), 4000);
  renderConnection();
});

// =====================================================================
// Live state
// =====================================================================
onState((s) => {
  app.state = s;
  renderHome(s);
  if (app.view === "cases") renderCases();
  if (app.view === "map") mapView.renderState(s, showCase);
  const n = s.stats.new;
  $("#tab-count").hidden = !n;
  $("#tab-count").textContent = n > 99 ? "99+" : n;
  if (app.openCase) refreshCaseSheet();
});

function setChip(id, text, cls) {
  const c = $(id);
  c.className = "status-chip " + (cls || "");
  c.querySelector("span").textContent = text;
}

function caseDistance(c) {
  const f = me();
  return f ? distanceM(f, c) : null;
}

function unread(c) {
  const t = app.state?.threads?.[c.type + ":" + c.id];
  if (!t) return 0;
  const seen = app.seenThreads[c.type + ":" + c.id] || 0;
  return t.last_sender === "survivor" && t.count > seen ? t.count - seen : 0;
}

function caseRow(c) {
  const d = caseDistance(c);
  const u = unread(c);
  const who = c.type === "sos"
    ? `${c.people} person(s)${c.injured ? " · injured" : ""}`
    : `${c.thermal ? "Heat signature" : "Visual"} · ${Math.round(c.confidence * 100)}%`;
  const done = c.status === "rescued" || c.status === "closed";
  return `<button class="sv-card ${done ? "rescued" : esc(c.priority)}" data-type="${c.type}" data-id="${esc(c.id)}">
    <span class="bar"></span>
    <div class="row-main">
      <div class="row-title">${esc(c.id)}
        <span class="badge ${done ? "ok" : esc(c.priority)}">${done ? CASE_STATUS_LABEL[c.status] : PRIORITY_LABEL[c.priority]}</span>
        <span class="badge ${c.type === "sos" ? "sos" : ""}">${CASE_TYPE_LABEL[c.type]}</span>
        ${u ? `<span class="badge bad">${u} new message${u > 1 ? "s" : ""}</span>` : ""}</div>
      <div class="sv-meta">
        <span>${esc(CASE_STATUS_LABEL[c.status])}${c.team ? " · " + esc(c.team) : ""}</span>
        ${d != null ? `<span>${fmtDist(d)} ${compass(bearingDeg(me(), c))}</span>` : ""}
        <span>${who}</span>
        <span>${ago(c.type === "sos" ? c.created : c.last_seen)}</span>
      </div>
    </div></button>`;
}

function bindCaseRows(root) {
  $$(".sv-card", root).forEach((b) => b.addEventListener("click", () => showCase(b.dataset.type, b.dataset.id)));
}

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2 };
function sortCases(list) {
  return [...list].sort((a, b) => (PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
    || ((caseDistance(a) ?? 1e12) - (caseDistance(b) ?? 1e12)));
}

function renderHome(s) {
  $("#op-updated").textContent = "Updated " + ago(s.ts);
  $("#st-new").textContent = s.stats.new;
  $("#st-open").textContent = s.stats.open;
  $("#st-critical").textContent = s.stats.critical;
  $("#st-rescued").textContent = s.stats.rescued;

  if (!s.drones.length) setChip("#chip-air", "No aerial units", "");
  else {
    const lora = s.drones.filter((d) => d.link === "LORA").length;
    setChip("#chip-air", `${s.drones.length} aerial · ${lora ? "long-range radio (" + lora + ")" : "Wi-Fi link"}`, lora ? "warn" : "ok");
  }

  const mine = sortCases(s.cases.filter((c) => c.team === myTeam() && ACTIVE.includes(c.status)));
  setHTML($("#my-cases"), mine.length ? mine.map(caseRow).join("") : '<div class="empty">Your team has no active cases. Accept one from the list below or from Cases.</div>',
    caseSig(mine), bindCaseRows);

  const fresh = sortCases(s.cases.filter((c) => c.status === "new")).slice(0, 5);
  setHTML($("#new-cases"), fresh.length ? fresh.map(caseRow).join("") : '<div class="empty">No unassigned cases.</div>',
    caseSig(fresh), bindCaseRows);

  $("#drone-count").textContent = s.drones.length ? `${s.drones.length} active` : "";
  setHTML($("#drone-list"), s.drones.length ? s.drones.map((d) => `
    <div class="row">
      <svg style="color:var(--primary)"><use href="#i-uav"/></svg>
      <div class="row-main">
        <div class="row-title">${esc(d.drone_id)} <span class="badge">${esc(d.state)}</span>
          <span class="badge ${d.link === "LORA" ? "warn" : "ok"}">${esc(LINK_LABEL[d.link] || d.link)}</span></div>
        <div class="row-sub">${esc(NAV_LABEL[d.nav_mode] || d.nav_mode)} · HDOP ${d.hdop} · ${d.alt} m · ${d.rssi} dBm${d.nav_mode === "VIO" ? ` · drift ≤ ${d.drift_m} m` : ""}</div>
        ${d.link === "LORA" ? '<div class="video-off">Video and voice paused — coordinates only over long-range radio.</div>' : ""}
      </div>
      <div class="row-right"><span class="battery ${d.battery < 25 ? "low" : ""}"><i style="width:${Math.max(0, Math.min(100, d.battery))}%"></i></span><br>${Math.round(d.battery)}%</div>
    </div>`).join("") : '<div class="empty">No aerial units are reporting.</div>',
    s.drones.map((d) => d.drone_id + d.link + d.state + d.nav_mode + Math.round(d.battery / 5)).join("|"));

  setHTML($("#event-list"), s.events.length ? s.events.slice(0, 10).map((e) => `
    <div class="row"><span class="dot ${esc(e.level)}"></span>
      <div class="row-main">${esc(e.message)}</div><div class="row-right">${ago(e.ts)}</div></div>`).join("")
    : '<div class="empty">No events yet.</div>', s.events.length ? String(s.events[0].id) : "");
}

// =====================================================================
// Cases list
// =====================================================================
$$("#case-filter button").forEach((b) => b.addEventListener("click", () => {
  $$("#case-filter button").forEach((x) => x.classList.toggle("on", x === b));
  app.caseFilter = b.dataset.f;
  renderCases();
}));

function renderCases() {
  if (!app.state) { setHTML($("#case-list"), '<div class="card empty">Waiting for the ground server…</div>', "wait"); return; }
  const f = app.caseFilter;
  let list = app.state.cases;
  if (f === "new") list = list.filter((c) => c.status === "new");
  else if (f === "mine") list = list.filter((c) => c.team === myTeam() && c.status !== "closed");
  else if (f === "active") list = list.filter((c) => ACTIVE.includes(c.status));
  else if (f === "rescued") list = list.filter((c) => c.status === "rescued");
  list = sortCases(list);
  const empty = { new: "No new cases.", mine: "Your team has no cases.", active: "No active cases.", rescued: "No rescued cases yet.", all: "No cases yet." }[f];
  setHTML($("#case-list"), list.length ? list.map(caseRow).join("") : `<div class="card empty">${empty}</div>`,
    f + caseSig(list), bindCaseRows);
}

// =====================================================================
// Case sheet: details, status actions, conversation with the survivor
// =====================================================================
function getCase(type, id) { return app.state?.cases.find((c) => c.type === type && c.id === id); }

async function showCase(type, id) {
  app.openCase = { type, id };
  ["#cs-details", "#cs-actions"].forEach((q) => { $(q)._sig = null; $(q)._html = null; });
  $("#cs-thread").innerHTML = '<div class="empty">Loading…</div>';
  refreshCaseSheet(true);
  openSheet("sheet-case");
}

let lastThreadCount = -1;
let lastThreadLoad = 0;
async function refreshCaseSheet(force) {
  const oc = app.openCase;
  if (!oc) return;
  const c = getCase(oc.type, oc.id);
  if (!c) return;
  const d = caseDistance(c);
  $("#cs-title").textContent = `${c.type === "sos" ? "SOS" : "Survivor"} ${c.id}`;
  const details = c.type === "sos" ? `
      <span class="k">People</span><span class="v">${c.people}${c.injured ? " · injured reported" : ""}</span>
      <span class="k">Position accuracy</span><span class="v">${c.accuracy ? "± " + Math.round(c.accuracy) + " m" : "—"}</span>
      <span class="k">Phone</span><span class="v">${c.contact ? esc(c.contact) : "—"}</span>
      <span class="k">Received</span><span class="v">${clock(c.created * 1000)}</span>
      <span class="k">Last heard</span><span class="v">${ago(c.last_seen)}</span>` : `
      <span class="k">Heat signature</span><span class="v">${c.thermal ? "Confirmed by thermal camera" : "Not confirmed"}</span>
      <span class="k">Confidence</span><span class="v">${Math.round(c.confidence * 100)}%</span>
      <span class="k">Detections</span><span class="v">${c.detections} (merged within 3 m)</span>
      <span class="k">Found by</span><span class="v">${esc(c.drone_id || "—")} · ${esc(NAV_LABEL[c.nav_mode] || c.nav_mode || "")}</span>
      <span class="k">First seen</span><span class="v">${clock(c.first_seen * 1000)}</span>
      <span class="k">Last seen</span><span class="v">${ago(c.last_seen)}</span>`;
  setHTML($("#cs-details"), `<div class="kv-grid">
      <span class="k">Status</span><span class="v"><b>${esc(CASE_STATUS_LABEL[c.status])}</b>${c.team ? " · " + esc(c.team) : ""}</span>
      <span class="k">Priority</span><span class="v"><span class="badge ${esc(c.priority)}">${PRIORITY_LABEL[c.priority]}</span></span>
      <span class="k">Position</span><span class="v">${fmtCoord(c.lat, c.lon)}</span>
      <span class="k">From you</span><span class="v">${d != null ? `${fmtDist(d)} towards ${compass(bearingDeg(me(), c))}` : "Your position is unknown"}</span>
      ${details}
    </div>`, c.id + c.status + c.team + Math.round((d ?? 0) / 10));

  const mine = c.team === myTeam();
  const btns = [];
  btns.push('<button class="btn" data-act="map">Show on map</button>');
  btns.push(`<a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}">Directions</a>`);
  if (c.status === "new") btns.push('<button class="btn primary" data-st="accepted">Accept case</button>');
  else if (c.team && !mine && c.status !== "rescued" && c.status !== "closed") btns.push(`<span class="muted small">Assigned to ${esc(c.team)}</span><button class="btn" data-st="accepted">Take over</button>`);
  if (mine && c.status === "accepted") btns.push('<button class="btn primary" data-st="en_route">En route</button>');
  if (mine && c.status === "en_route") btns.push('<button class="btn primary" data-st="on_scene">On scene</button>');
  if (mine && ACTIVE.includes(c.status)) btns.push('<button class="btn ok" data-st="rescued">Rescued</button>', '<button class="btn" data-st="new">Release</button>');
  if (c.status === "rescued" || c.status === "closed") btns.push('<button class="btn" data-st="new">Reopen</button>');
  if (mine && c.status !== "closed") btns.push('<button class="btn danger-outline" data-st="closed">Close (false alarm)</button>');
  setHTML($("#cs-actions"), btns.join(""), c.id + c.status + c.team, (el) => {
    $$("[data-st]", el).forEach((b) => b.onclick = () => { const cur = getCase(c.type, c.id) || c; setCaseStatus(cur, b.dataset.st); });
    const mb = $("[data-act=map]", el);
    if (mb) mb.onclick = () => { const cur = getCase(c.type, c.id) || c; closeCase(); go("map"); setTimeout(() => mapView.focus(cur.lat, cur.lon), 150); };
  });

  // which channel reaches this survivor
  if (c.type === "sos") {
    $("#cs-channel").textContent = "Messages appear on the survivor's SOS page. Voice messages can be played there too.";
  } else {
    const drone = app.state.drones.find((x) => x.drone_id === c.drone_id);
    $("#cs-channel").textContent = drone
      ? `Messages are played on ${c.drone_id}'s loudspeaker (text is spoken by the aircraft).` +
        (drone.link === "LORA" ? " Voice is paused while the aircraft is on long-range radio — messages wait in a queue." : "")
      : `Messages wait in a queue until ${c.drone_id || "an aircraft"} is in range and collects them.`;
  }

  const t = app.state.threads?.[c.type + ":" + c.id];
  const count = t ? t.count : 0;
  // reload on new messages, and every 5 s so delivery status ("played by UAV-02") stays current
  if (force || count !== lastThreadCount || Date.now() - lastThreadLoad > 5000) {
    lastThreadCount = count;
    lastThreadLoad = Date.now();
    await loadThread(c);
  }
}

function deliveryLabel(m, c) {
  if (m.sender !== "team") return "";
  const d = m.delivery || "";
  if (c.type === "sos") return d === "delivered" ? "Seen on SOS page" : "Waiting for the survivor's page to open";
  if (d.startsWith("played:")) return "Played by " + d.slice(7);
  if (d === "sent") return "Sent to aircraft";
  if (d.startsWith("failed")) return "Aircraft could not play it";
  return "Queued for aircraft";
}

async function loadThread(c) {
  let msgs = [];
  try { msgs = await api(`/api/cases/${c.type}/${encodeURIComponent(c.id)}/messages`); }
  catch { $("#cs-thread").innerHTML = '<div class="empty">Could not load messages (offline).</div>'; return; }
  app.seenThreads[c.type + ":" + c.id] = msgs.length;
  try { localStorage.setItem("saadaxa.seen", JSON.stringify(app.seenThreads)); } catch {}
  $("#cs-thread").innerHTML = msgs.length ? msgs.map((m) => `
    <div class="msg ${m.sender === "team" ? "user" : m.sender === "system" ? "system" : "assistant"}">
      ${m.sender === "survivor" ? '<div class="msg-who">Survivor</div>' : m.sender === "team" ? `<div class="msg-who">${esc(m.team)}</div>` : ""}
      ${m.text ? `<p>${esc(m.text)}</p>` : ""}
      ${m.audio_url ? `<audio controls preload="none" src="${esc(m.audio_url)}"></audio>` : ""}
      <div class="msg-meta">${clock(m.ts * 1000)}${deliveryLabel(m, c) ? " · " + deliveryLabel(m, c) : ""}</div>
    </div>`).join("") : '<div class="empty">No messages yet.</div>';
  const box = $("#cs-thread");
  box.scrollTop = box.scrollHeight;
}

async function setCaseStatus(c, status) {
  try {
    await sendOrQueue(`/api/cases/${c.type}/${encodeURIComponent(c.id)}`, { status }, "Case update", "PATCH");
    toast(`${c.id}: ${CASE_STATUS_LABEL[status]}`, "ok");
  } catch { toast("Could not update the case.", "bad"); }
}

function closeCase() { closeSheet("sheet-case"); app.openCase = null; lastThreadCount = -1; }

$("#cs-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#cs-text").value.trim();
  const oc = app.openCase;
  if (!text || !oc) return;
  $("#cs-send").disabled = true;
  try {
    const r = await sendOrQueue(`/api/cases/${oc.type}/${encodeURIComponent(oc.id)}/messages`, { text }, "Message");
    $("#cs-text").value = "";
    if (!r.sent) toast("Offline — message saved and will be sent automatically.");
    const c = getCase(oc.type, oc.id);
    if (c) loadThread(c);
  } catch { toast("Message could not be sent.", "bad"); }
  $("#cs-send").disabled = false;
});
$("#cs-text").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#cs-form").requestSubmit(); } });

// hold-to-talk voice message
const vb = $("#cs-voice");
let recording = false;
vb.addEventListener("pointerdown", async (e) => {
  e.preventDefault();
  if (!recorder.mediaSupported() || !window.isSecureContext) { toast("Microphone needs HTTPS.", "bad"); return; }
  try { await recorder.startClip(); recording = true; vb.classList.add("listening"); $("#cs-voice-hint").textContent = "Recording… release to send."; }
  catch { toast("Microphone permission refused.", "bad"); }
});
async function endVoice() {
  if (!recording) return;
  recording = false;
  vb.classList.remove("listening");
  $("#cs-voice-hint").textContent = "Hold the microphone to record a voice message.";
  const clip = await recorder.stopClip();
  const oc = app.openCase;
  if (!clip || clip.duration < 0.6 || !oc) { toast("Too short — hold the button while speaking."); return; }
  const fd = new FormData();
  fd.append("file", new File([clip.blob], "voice.webm", { type: clip.type }));
  try {
    await api(`/api/cases/${oc.type}/${encodeURIComponent(oc.id)}/voice`, { method: "POST", body: fd, timeout: 60000 });
    toast("Voice message sent.", "ok");
    const c = getCase(oc.type, oc.id);
    if (c) loadThread(c);
  } catch { toast("Voice message could not be sent (no connection).", "bad"); }
}
["pointerup", "pointerleave", "pointercancel"].forEach((ev) => vb.addEventListener(ev, endVoice));
vb.addEventListener("contextmenu", (e) => e.preventDefault());

$$("[data-close]").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.close === "sheet-case") closeCase(); else closeSheet(b.dataset.close);
}));

// =====================================================================
// Position (automatic)
// =====================================================================
onLocation((l) => {
  const ml = modeLabel(l);
  setChip("#chip-loc", ml.text, ml.cls);
  const nl = netLabel(l);
  setChip("#chip-net", nl.text, nl.cls);

  // GPS-denied banner
  const denied = l.mode === "denied";
  $("#denied-banner").hidden = !denied;
  if (denied) {
    $("#denied-text").textContent = l.fix
      ? `GPS-denied mode · ${l.fix.source === "Dead-reckoning" ? `${l.steps} steps from anchor` : "using last known position"} · ±${l.fix.accuracy} m`
      : "GPS-denied mode · no position yet";
    $("#denied-sensors").hidden = l.sensors !== "needs-permission";
  }

  $("#set-loc-status").className = "loc-status " + (ml.cls === "ok" ? "ok" : ml.cls === "bad" ? "bad" : "");
  $("#set-loc-status").textContent = ml.text;
  const f = l.fix;
  $("#set-loc").innerHTML = `
    <span class="k">Mode</span><span class="v">${{ gps: "Satellite (GPS)", network: "Wi-Fi / mobile network positioning",
      denied: "GPS-denied (anchor + dead-reckoning)", permission: "Permission blocked", unsupported: "Unavailable", starting: "Starting" }[l.mode]}</span>
    <span class="k">Position</span><span class="v">${f ? fmtCoord(f.lat, f.lon) : "—"}</span>
    <span class="k">Accuracy</span><span class="v">${f ? "± " + f.accuracy + " m" : "—"}</span>
    <span class="k">Anchor</span><span class="v">${l.anchor ? `${esc(l.anchor.source)} · ${ago(l.anchor.ts / 1000)}` : "None yet"}</span>
    <span class="k">Step tracking</span><span class="v">${{ active: "Active", "needs-permission": "Needs permission", unavailable: "Not available on this device", unknown: "Checking…" }[l.sensors]}${l.heading != null ? ` · heading ${Math.round(l.heading)}°` : ""}</span>
    <span class="k">Network</span><span class="v">${esc(netLabel(l).text)}</span>`;
  $("#set-share").checked = l.share;
  if (l.error) $("#set-loc-status").textContent = l.error;

  mapView.renderMe(f, l.mode);
  updateHazardLoc();
});

$("#denied-sensors").addEventListener("click", async () => {
  const ok = await startSensors(true);
  toast(ok ? "Step tracking on." : "Motion sensors not allowed.", ok ? "ok" : "bad");
});
function startSetPosition() {
  closeSheet("sheet-settings");
  go("map");
  $("#pick-text").textContent = "Tap your current position on the map";
  $("#pick-hint").hidden = false;
  mapView.pickPoint($("#map"), (p) => {
    $("#pick-hint").hidden = true;
    setManualPosition(p.lat, p.lon);
    startSensors(true);
    toast("Position set. Step tracking continues from here.", "ok");
  });
}
$("#denied-set").addEventListener("click", startSetPosition);
$("#map-setpos").addEventListener("click", startSetPosition);
$("#set-share").addEventListener("change", (e) => setShare(e.target.checked));

// share position with other teams every 15 s
setInterval(async () => {
  if (!loc.share || !loc.fix || !net.connected || !session.get()) return;
  try { await api("/api/units/me", { method: "PUT", body: { lat: loc.fix.lat, lon: loc.fix.lon, accuracy: loc.fix.accuracy, source: loc.fix.source } }); }
  catch {}
}, 15000);

// =====================================================================
// Hazards
// =====================================================================
function updateHazardLoc() {
  if (app.hazardPoint) return;
  const f = me();
  $("#hz-loc").textContent = f ? `Your position: ${fmtCoord(f.lat, f.lon)} (±${f.accuracy} m)` : "Position unknown — choose the point on the map.";
}
function openHazard(point) {
  app.hazardPoint = point || null;
  if (point) $("#hz-loc").textContent = `Chosen on map: ${fmtCoord(point.lat, point.lon)}`;
  else updateHazardLoc();
  openSheet("sheet-hazard");
}
$("#btn-hazard-home").addEventListener("click", () => openHazard());
$$("#hz-sev button").forEach((b) => b.addEventListener("click", () => $$("#hz-sev button").forEach((x) => x.classList.toggle("on", x === b))));
function startHazardPick() {
  closeSheet("sheet-hazard");
  go("map");
  $("#pick-text").textContent = "Tap the map where the hazard is";
  $("#pick-hint").hidden = false;
  mapView.pickPoint($("#map"), (p) => { $("#pick-hint").hidden = true; openHazard(p); });
}
$("#hz-pick").addEventListener("click", startHazardPick);
$("#map-hazard").addEventListener("click", startHazardPick);
$("#pick-cancel").addEventListener("click", () => { mapView.cancelPick($("#map")); $("#pick-hint").hidden = true; });

$("#hazard-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p = app.hazardPoint || me();
  if (!p) { toast("Choose the hazard location on the map first.", "bad"); return; }
  $("#hz-submit").disabled = true;
  try {
    const r = await sendOrQueue("/api/hazards", {
      lat: p.lat, lon: p.lon, kind: $("#hz-kind").value,
      severity: $(".on", $("#hz-sev")).dataset.s, note: $("#hz-note").value.trim(),
    }, "Hazard");
    closeSheet("sheet-hazard");
    toast(r.sent ? "Hazard reported." : "Offline — saved and will be sent automatically.", r.sent ? "ok" : "");
    $("#hz-note").value = "";
    app.hazardPoint = null;
  } catch { toast("Report could not be sent.", "bad"); }
  $("#hz-submit").disabled = false;
});

// =====================================================================
// Map extras
// =====================================================================
$$("#map-filters input").forEach((i) => i.addEventListener("change", () => mapView.setLayerVisible(i.dataset.layer, i.checked)));
$("#map-india").addEventListener("click", () => mapView.showIndia());
$("#map-locate").addEventListener("click", () => {
  const f = me();
  if (f) mapView.focus(f.lat, f.lon, 17);
  else toast("Position unknown. Use the pin button to set it on the map.", "bad");
});
$("#btn-alerts-map").addEventListener("click", () => {
  go("map");
  const cb = $('#map-filters input[data-layer="alerts"]');
  cb.checked = true;
  mapView.setLayerVisible("alerts", true);
  setTimeout(() => mapView.showIndia(), 150);
});

// =====================================================================
// Disaster alerts — India only
// =====================================================================
async function loadAlerts() {
  try {
    const d = await api("/api/disasters/india", { timeout: 40000 });
    app.alerts = d.events || [];
    $("#alerts-note").textContent = app.alerts.length
      ? `${app.alerts.length} active alert(s) for India · NDMA SACHET, GDACS, USGS · updated ${ago(d.fetched)}${d.stale ? " (cached)" : ""}`
      : d.errors && d.errors.length >= 3 ? "Alert feeds unreachable — the ground server has no internet connection."
      : "No active disaster alerts for India right now.";
  } catch {
    $("#alerts-note").textContent = "Alert feeds unavailable while offline.";
  }
  const rank = { red: 0, orange: 1, yellow: 2, green: 3 };
  const top = [...app.alerts].sort((a, b) => (rank[a.level] ?? 4) - (rank[b.level] ?? 4) || b.time - a.time).slice(0, 10);
  $("#alert-list").innerHTML = top.map((e) => `
    <div class="row"><span class="dot ${esc(e.level)}"></span>
      <div class="row-main"><div>${esc(e.title_en || e.title)}${e.language && e.language !== "English" && !e.title_en ? ` <span class="badge">${esc(e.language)}</span>` : ""}</div>
        ${e.title_en ? `<div class="row-sub orig">${esc(e.language)} original: ${esc(e.title)}</div>` : ""}
        <div class="row-sub">${esc(e.type)} · ${esc(e.source)}${e.area ? " · " + esc(e.area.slice(0, 80)) : ""}${me() && e.lat != null ? " · " + fmtDist(distanceM(me(), e)) + " away" : ""}</div></div>
      <div class="row-right">${ago(e.time)}</div></div>`).join("");
  mapView.renderAlerts(app.alerts);
}

// =====================================================================
// Recorder (field evidence)
// =====================================================================
let meterRaf = null, stampTimer = null;

function setRecMode(mode) {
  recorder.rec.mode = mode;
  $$("#rec-mode button").forEach((b) => b.classList.toggle("on", b.dataset.m === mode));
  $("#rec-video").hidden = mode !== "video";
  $("#audio-stage").hidden = true;
  $("#rec-flip").style.visibility = mode === "video" ? "visible" : "hidden";
  $("#rec-enable").textContent = mode === "video" ? "Turn on camera" : "Turn on microphone";
  $("#rec-start-text").textContent = mode === "video" ? "Camera and microphone are off." : "Microphone is off.";
}
$$("#rec-mode button").forEach((b) => b.addEventListener("click", async () => {
  if (recorder.rec.recording) { toast("Stop the current recording first."); return; }
  const wasOn = !!recorder.rec.stream;
  await turnOffMedia();
  setRecMode(b.dataset.m);
  if (wasOn) turnOnMedia();
}));

async function turnOnMedia() {
  if (!recorder.mediaSupported()) { toast("This browser cannot record. Use Chrome or Safari.", "bad"); return; }
  if (!window.isSecureContext) { toast("Camera and microphone need HTTPS.", "bad"); return; }
  try {
    await recorder.startPreview($("#rec-video"));
    $("#rec-start").hidden = true;
    $("#audio-stage").hidden = recorder.rec.mode !== "audio";
    $("#rec-button").disabled = false;
    startMeters();
  } catch (e) {
    toast(e.name === "NotAllowedError" ? "Permission refused. Allow camera/microphone in browser settings." : "Could not start: " + e.message, "bad");
  }
}
async function turnOffMedia() {
  if (recorder.rec.recording) await finishRecording();
  await recorder.stopPreview();
  stopMeters();
  $("#rec-video").srcObject = null;
  $("#rec-start").hidden = false;
  $("#audio-stage").hidden = true;
  $("#rec-button").disabled = true;
  $("#rec-button").classList.remove("on");
  $("#rec-badge").hidden = true;
}
function startMeters() {
  stopMeters();
  const cv = $("#level"), ctx = cv.getContext("2d");
  const hist = new Array(60).fill(0);
  const draw = () => {
    if (recorder.rec.recording) $("#rec-timer").textContent = fmtTime((Date.now() - recorder.rec.startedAt) / 1000);
    if (recorder.rec.mode === "audio") {
      hist.push(recorder.level()); hist.shift();
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = recorder.rec.recording ? "#c0675f" : "#8796a8";
      const w = cv.width / hist.length;
      hist.forEach((v, i) => { const h = Math.max(2, v * cv.height); ctx.fillRect(i * w + 1, (cv.height - h) / 2, w - 2, h); });
    }
    meterRaf = requestAnimationFrame(draw);
  };
  draw();
  const stamp = () => {
    const f = me();
    $("#rec-stamp").innerHTML = `${new Date().toLocaleString()}<br>${f ? `${fmtCoord(f.lat, f.lon)} ±${f.accuracy} m` : "No position"}`;
  };
  stamp();
  stampTimer = setInterval(stamp, 1000);
}
function stopMeters() { cancelAnimationFrame(meterRaf); clearInterval(stampTimer); $("#rec-stamp").textContent = ""; }

async function finishRecording() {
  const result = await recorder.stopRecording();
  $("#rec-button").classList.remove("on");
  $("#rec-badge").hidden = true;
  if (!result || !result.blob.size) return;
  const item = await recorder.saveRecording(result, me(), $("#rec-note").value.trim());
  $("#rec-note").value = "";
  toast(`${item.kind === "video" ? "Video" : "Audio"} saved on this phone.`, "ok");
  await renderRecordings();
  if (net.connected) {
    try { await recorder.uploadRecording(item); toast("Recording sent to the ground server.", "ok"); }
    catch { toast("Saved. Upload will retry when connected."); }
    renderRecordings();
  }
}
$("#rec-enable").addEventListener("click", turnOnMedia);
$("#rec-off").addEventListener("click", turnOffMedia);
$("#rec-flip").addEventListener("click", async () => {
  if (recorder.rec.recording) { toast("Stop recording before switching camera."); return; }
  recorder.rec.facing = recorder.rec.facing === "environment" ? "user" : "environment";
  if (recorder.rec.stream) turnOnMedia();
});
$("#rec-button").addEventListener("click", async () => {
  if (recorder.rec.recording) return finishRecording();
  try { recorder.startRecording(); $("#rec-button").classList.add("on"); $("#rec-badge").hidden = false; }
  catch (e) { toast("Could not record: " + e.message, "bad"); }
});
async function leaveRecord() { if (recorder.rec.stream) await turnOffMedia(); }
document.addEventListener("visibilitychange", () => { if (document.hidden && app.view === "record" && !recorder.rec.recording) leaveRecord(); });

const objectUrls = [];
async function renderRecordings() {
  objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const items = await recorder.listRecordings();
  $("#rec-upload-all").hidden = !items.some((i) => !i.uploaded);
  $("#rec-list").innerHTML = items.length ? items.map((it) => `
    <div class="row" data-id="${esc(it.id)}">
      <svg style="color:var(--primary)"><use href="#${it.kind === "video" ? "i-rec" : "i-mic"}"/></svg>
      <div class="row-main">
        <div class="row-title">${it.kind === "video" ? "Video" : "Audio"} · ${fmtTime(it.duration || 0)}
          <span class="badge ${it.uploaded ? "ok" : "warn"}">${it.uploaded ? "Sent" : "On phone"}</span></div>
        <div class="row-sub">${clock(it.created)} · ${fmtBytes(it.size)}${it.lat != null ? " · " + fmtCoord(it.lat, it.lon) : ""}</div>
        ${it.note ? `<div class="row-sub">${esc(it.note)}</div>` : ""}
        <div class="rec-item-actions">
          <button data-act="play">Play</button><button data-act="save">Download</button>
          ${it.uploaded ? "" : '<button data-act="send">Send</button>'}<button data-act="del" class="del">Delete</button>
        </div>
      </div>
    </div>`).join("") : '<div class="empty">No recordings yet.</div>';
  $$("#rec-list .row").forEach((row) => {
    const it = items.find((i) => i.id === row.dataset.id);
    row.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
      const act = b.dataset.act;
      if (act === "play") {
        const old = row.querySelector(".rec-player");
        if (old) { old.remove(); return; }
        const url = URL.createObjectURL(it.blob); objectUrls.push(url);
        const el = document.createElement(it.kind === "video" ? "video" : "audio");
        el.className = "rec-player"; el.src = url; el.controls = true; el.playsInline = true;
        row.querySelector(".row-main").appendChild(el);
        el.play().catch(() => {});
      } else if (act === "save") {
        const url = URL.createObjectURL(it.blob); objectUrls.push(url);
        const a = document.createElement("a");
        const ext = it.type.includes("mp4") ? (it.kind === "audio" ? "m4a" : "mp4") : it.type.includes("ogg") ? "ogg" : "webm";
        a.href = url; a.download = `SAADAXA-${it.id}.${ext}`;
        document.body.appendChild(a); a.click(); a.remove();
      } else if (act === "send") {
        b.disabled = true; b.textContent = "Sending…";
        try { await recorder.uploadRecording(it); toast("Recording sent.", "ok"); }
        catch { toast("Upload failed — no connection to the ground server.", "bad"); }
        renderRecordings();
      } else if (act === "del") {
        if (b.dataset.confirm) { await recorder.deleteRecording(it.id); renderRecordings(); }
        else { b.dataset.confirm = "1"; b.textContent = "Tap again to delete"; setTimeout(() => { b.textContent = "Delete"; delete b.dataset.confirm; }, 3000); }
      }
    }));
  });
}
$("#rec-upload-all").addEventListener("click", async () => {
  const n = await recorder.uploadPending();
  toast(n ? `${n} recording(s) sent.` : "Nothing sent — check the connection.", n ? "ok" : "bad");
  renderRecordings();
});

// =====================================================================
// Assistant
// =====================================================================
const chatText = $("#chat-text");
chatText.addEventListener("input", () => { chatText.style.height = "auto"; chatText.style.height = Math.min(120, chatText.scrollHeight) + "px"; });
chatText.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chat-form").requestSubmit(); } });
$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = chatText.value;
  chatText.value = ""; chatText.style.height = "auto";
  chat.ask(q);
});
$("#chat-clear").addEventListener("click", chat.clearChat);
if (chat.voiceSupported()) {
  const b = $("#chat-voice");
  b.hidden = false;
  let r = null;
  b.addEventListener("click", () => {
    if (r) { r.stop(); return; }
    b.classList.add("listening");
    r = chat.startVoice((t) => (chatText.value = t), () => { b.classList.remove("listening"); r = null; });
  });
}

// =====================================================================
// Settings
// =====================================================================
function openSettings() { renderConnection(); openSheet("sheet-settings"); }
$("#btn-settings").addEventListener("click", openSettings);
$("#btn-sos-link").addEventListener("click", openSettings);
onOutbox((items) => { outboxCount = items.length; renderConnection(); });

function renderConnection() {
  const s = session.get();
  if (!$("#set-conn")) return;
  $("#set-team").innerHTML = s ? `<span class="k">Team</span><span class="v">${esc(s.team)}</span><span class="k">Member</span><span class="v">${esc(s.member)}</span>` : "";
  $("#set-conn").innerHTML = `
    <span class="k">Ground server</span><span class="v">${net.connected ? "Connected" : "Not connected"} (${esc(location.host)})</span>
    <span class="k">Last update</span><span class="v">${net.lastMessage ? ago(net.lastMessage / 1000) : "—"}</span>
    <span class="k">Saved updates</span><span class="v">${outboxCount ? `${outboxCount} waiting to send` : "None waiting"}</span>
    <span class="k">AI assistant</span><span class="v">${app.config.assistant_online ? "Online model" : "Offline field guidance"}</span>
    <span class="k">Data mode</span><span class="v">${app.config.simulation ? "Training simulation" : "Live operation"}</span>`;
  $("#set-sos-url").textContent = sosUrl();
  $("#set-device").textContent = `Device ID ${deviceId()} · App version 2.0`;
}
$("#set-sos-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(sosUrl()); toast("SOS page link copied.", "ok"); }
  catch { toast(sosUrl()); }
});
$("#set-flush").addEventListener("click", async () => {
  await flushOutbox();
  const n = await recorder.uploadPending();
  toast(outboxCount ? `${outboxCount} update(s) still waiting — no connection.` : `All updates sent${n ? `, ${n} recording(s) uploaded` : ""}.`);
});
$("#set-logout").addEventListener("click", async () => {
  await logout();
  closeSheet("sheet-settings");
  showSignIn();
});
$("#set-clear").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "Tap again to erase recordings and saved updates"; return; }
  await db.clear("recordings"); await db.clear("outbox");
  try { localStorage.clear(); sessionStorage.clear(); } catch {}
  toast("Phone data cleared.");
  setTimeout(() => location.reload(), 800);
});

// =====================================================================
// Start-up
// =====================================================================
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
setRecMode("video");
startLocation();
loadConfig().then(() => {
  if (session.get()) startSession(); else showSignIn();
  setInterval(() => { if (session.get()) loadAlerts(); }, 5 * 60 * 1000);
});
setInterval(() => { if (app.state) $("#op-updated").textContent = "Updated " + ago(app.state.ts); }, 5000);
const startView = (location.hash || "#home").slice(1);
go(["home", "map", "cases", "record", "assist"].includes(startView) ? startView : "home");
