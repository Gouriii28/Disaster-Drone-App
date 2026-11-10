// Automatic positioning for SAADAXA.
//
// The app decides by itself what is available — nothing to switch on or off:
//
//   GPS        a fresh fix with accuracy <= 50 m          -> "GPS"
//   NETWORK    a fresh fix, but rougher (Wi-Fi / cell)     -> "Wi-Fi / network position"
//   DENIED     no fix for 20 s (indoors, rubble, jammed)   -> GPS-denied mode
//
// In GPS-denied mode the app does what the aerial units do: it latches the last
// good fix as an ANCHOR and keeps estimating position from it — here by counting
// steps (accelerometer) and reading the compass heading (pedestrian dead-reckoning).
// The estimated error grows with distance walked. As soon as a good fix returns,
// the app re-anchors and the error resets. If there was never a fix, the team member
// can set their position by tapping the map.
//
// Network state is detected too: Wi-Fi / mobile data / offline, and whether the
// ground server is reachable. Without a network, reports are kept on the phone.

const listeners = new Set();
const KEY = "saadaxa.anchor";

const FIX_FRESH_MS = 40000;   // no fix for this long (and probes failing) means "no signal"
const PROBE_EVERY_MS = 15000; // actively ask for a fresh fix this often (phones stay quiet when you stand still)
const GPS_GOOD_M = 50;        // accuracy at or below this counts as GPS
const STEP_LENGTH_M = 0.7;    // average walking step
const DRIFT_PER_M = 0.05;     // dead-reckoning error grows ~5% of distance walked

export const loc = {
  mode: "starting",     // starting | gps | network | denied | permission | unsupported
  fix: null,            // best current position {lat, lon, accuracy, source, ts}
  lastReal: null,       // last real fix from the phone
  anchor: null,         // latched anchor for dead-reckoning
  steps: 0,
  distance: 0,
  heading: null,        // degrees from north
  sensors: "unknown",   // unknown | active | needs-permission | unavailable
  net: { online: navigator.onLine, type: "unknown", server: false },
  share: true,
  error: "",
};

try { loc.anchor = JSON.parse(localStorage.getItem(KEY)) || null; } catch {}
try { loc.share = localStorage.getItem("saadaxa.share") !== "0"; } catch {}

function emit() { listeners.forEach((fn) => fn(loc)); }
export function onLocation(fn) { listeners.add(fn); fn(loc); return () => listeners.delete(fn); }

function saveAnchor() { try { localStorage.setItem(KEY, JSON.stringify(loc.anchor)); } catch {} }

// ---------------- geodesy (same projection the aircraft use) ----------------
const A = 6378137.0, E2 = 6.69437999014e-3, R = Math.PI / 180;
function enuToGeo(lat0, lon0, east, north) {
  const s = Math.sin(lat0 * R);
  const rm = A * (1 - E2) / Math.pow(1 - E2 * s * s, 1.5);
  const rn = A / Math.sqrt(1 - E2 * s * s);
  return { lat: lat0 + (north / rm) / R, lon: lon0 + (east / (rn * Math.cos(lat0 * R))) / R };
}

// ---------------- satellite / network fixes ----------------
let watchId = null;
let evalTimer = null;
let probeTimer = null;

// Watching alone is not enough: browsers only report when the position changes,
// so a team member standing still would look like "no GPS". Probe regularly instead.
function probe() {
  navigator.geolocation.getCurrentPosition(onFix, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 });
}

function onFix(p) {
  const c = p.coords;
  const real = {
    lat: c.latitude, lon: c.longitude, accuracy: Math.round(c.accuracy),
    altitude: c.altitude, ts: Date.now(),
    source: c.accuracy <= GPS_GOOD_M ? "GPS" : "Wi-Fi / network",
  };
  loc.lastReal = real;
  loc.error = "";
  // Re-anchor on every good fix: resets dead-reckoning drift
  if (c.accuracy <= GPS_GOOD_M || !loc.anchor || (loc.anchor && c.accuracy < loc.anchor.accuracy)) {
    loc.anchor = { lat: real.lat, lon: real.lon, accuracy: real.accuracy, ts: real.ts, source: real.source };
    loc.steps = 0;
    loc.distance = 0;
    deadReckon.e = 0;
    deadReckon.n = 0;
    saveAnchor();
  }
  evaluate();
}

function onErr(e) {
  if (e.code === 1) {
    loc.mode = "permission";
    loc.error = "Location permission is blocked. Allow location for this site in the browser settings.";
  }
  evaluate();
}

export function startLocation() {
  if (!("geolocation" in navigator)) { loc.mode = "unsupported"; loc.error = "This browser has no location support."; emit(); return; }
  if (!window.isSecureContext) { loc.mode = "unsupported"; loc.error = "Location needs HTTPS (open the https:// address)."; emit(); return; }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  // Ask for the best the phone can do. The phone itself uses GPS when it has sky view,
  // and falls back to Wi-Fi / cell positioning when it does not.
  watchId = navigator.geolocation.watchPosition(onFix, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  startSensors(false);
  if (!evalTimer) evalTimer = setInterval(evaluate, 2000);
  if (!probeTimer) { probe(); probeTimer = setInterval(probe, PROBE_EVERY_MS); }
  evaluate();
}

// ---------------- dead-reckoning from steps + compass ----------------
const deadReckon = { e: 0, n: 0, lastStep: 0, above: false, smooth: 9.81 };

function onMotion(ev) {
  const a = ev.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  if (loc.sensors !== "active") { loc.sensors = "active"; }
  const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  deadReckon.smooth = deadReckon.smooth * 0.8 + mag * 0.2;   // low-pass filter
  const now = performance.now();
  // A step = acceleration rises above 11 m/s² then falls back below 9.5 m/s²
  if (!deadReckon.above && deadReckon.smooth > 11.0 && now - deadReckon.lastStep > 300) {
    deadReckon.above = true;
    deadReckon.lastStep = now;
    if (loc.mode === "denied" && loc.heading != null && loc.anchor) {
      deadReckon.e += STEP_LENGTH_M * Math.sin(loc.heading * R);
      deadReckon.n += STEP_LENGTH_M * Math.cos(loc.heading * R);
      loc.steps += 1;
      loc.distance += STEP_LENGTH_M;
    }
  } else if (deadReckon.above && deadReckon.smooth < 9.5) {
    deadReckon.above = false;
  }
}

function onOrientation(ev) {
  let h = null;
  if (typeof ev.webkitCompassHeading === "number") h = ev.webkitCompassHeading;          // iPhone
  else if (ev.absolute && typeof ev.alpha === "number") h = (360 - ev.alpha) % 360;      // Android
  if (h != null) loc.heading = h;
}

let sensorsOn = false;
export async function startSensors(fromUserTap) {
  if (sensorsOn) return true;
  const needsPermission = typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function";
  if (needsPermission) {
    if (!fromUserTap) { loc.sensors = "needs-permission"; emit(); return false; }
    try {
      const a = await DeviceMotionEvent.requestPermission();
      const b = typeof DeviceOrientationEvent.requestPermission === "function" ? await DeviceOrientationEvent.requestPermission() : "granted";
      if (a !== "granted" || b !== "granted") { loc.sensors = "unavailable"; emit(); return false; }
    } catch { loc.sensors = "unavailable"; emit(); return false; }
  }
  if (typeof DeviceMotionEvent === "undefined") { loc.sensors = "unavailable"; emit(); return false; }
  window.addEventListener("devicemotion", onMotion);
  window.addEventListener("deviceorientationabsolute", onOrientation);
  window.addEventListener("deviceorientation", onOrientation);
  sensorsOn = true;
  if (loc.sensors !== "active") loc.sensors = "unknown";
  setTimeout(() => { if (loc.sensors === "unknown") { loc.sensors = "unavailable"; emit(); } }, 4000);
  emit();
  return true;
}

// Team member sets their position by tapping the map (no fix at all)
export function setManualPosition(lat, lon) {
  loc.anchor = { lat, lon, accuracy: 25, ts: Date.now(), source: "Set on map" };
  loc.steps = 0; loc.distance = 0; deadReckon.e = 0; deadReckon.n = 0;
  saveAnchor();
  evaluate();
}

// ---------------- decide the mode ----------------
function evaluate() {
  // network
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  loc.net.online = navigator.onLine;
  loc.net.type = !navigator.onLine ? "none" : c && c.type ? c.type : "unknown";

  if (loc.mode === "permission" || loc.mode === "unsupported") { emit(); return; }

  const real = loc.lastReal;
  const fresh = real && Date.now() - real.ts < FIX_FRESH_MS;
  if (fresh && real.accuracy <= GPS_GOOD_M) {
    loc.mode = "gps";
    loc.fix = real;
  } else if (fresh) {
    loc.mode = "network";
    loc.fix = real;
  } else if (loc.anchor) {
    loc.mode = "denied";
    const p = enuToGeo(loc.anchor.lat, loc.anchor.lon, deadReckon.e, deadReckon.n);
    loc.fix = {
      lat: p.lat, lon: p.lon, ts: Date.now(),
      accuracy: Math.round(loc.anchor.accuracy + DRIFT_PER_M * loc.distance + (loc.distance ? 2 : 0)),
      source: loc.distance ? "Dead-reckoning" : "Last known position",
    };
  } else {
    loc.mode = real ? "denied" : "starting";
    loc.fix = null;
  }
  emit();
}

export function setServerReachable(ok) {
  if (loc.net.server !== ok) { loc.net.server = ok; emit(); }
}

export function setShare(on) {
  loc.share = on;
  try { localStorage.setItem("saadaxa.share", on ? "1" : "0"); } catch {}
  emit();
}

window.addEventListener("online", evaluate);
window.addEventListener("offline", evaluate);

// ---------------- helpers used by the screens ----------------
export function distanceM(a, b) {
  const Re = 6371008.8;
  const dLat = (b.lat - a.lat) * R, dLon = (b.lon - a.lon) * R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin(dLon / 2) ** 2;
  return 2 * Re * Math.asin(Math.sqrt(h));
}

export function bearingDeg(a, b) {
  const y = Math.sin((b.lon - a.lon) * R) * Math.cos(b.lat * R);
  const x = Math.cos(a.lat * R) * Math.sin(b.lat * R) - Math.sin(a.lat * R) * Math.cos(b.lat * R) * Math.cos((b.lon - a.lon) * R);
  return (Math.atan2(y, x) / R + 360) % 360;
}

export function compass(deg) {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}

export function modeLabel(l = loc) {
  const f = l.fix;
  switch (l.mode) {
    case "gps": return { text: `GPS ±${f.accuracy} m`, cls: "ok" };
    case "network": return { text: `Wi-Fi / network position ±${f.accuracy} m`, cls: "warn" };
    case "denied": return f ? { text: `GPS-denied · ${f.source.toLowerCase()} ±${f.accuracy} m`, cls: "warn" }
                            : { text: "GPS-denied · set position on map", cls: "bad" };
    case "permission": return { text: "Location permission blocked", cls: "bad" };
    case "unsupported": return { text: "Location unavailable", cls: "bad" };
    default: return { text: "Finding position…", cls: "" };
  }
}

export function netLabel(l = loc) {
  const t = l.net.type;
  const kind = !l.net.online || t === "none" ? "No network" : t === "wifi" ? "Wi-Fi" : t === "cellular" ? "Mobile data"
             : t === "ethernet" ? "Wired" : "Network";
  if (!l.net.online || t === "none") return { text: "Offline · reports saved on phone", cls: "bad" };
  return l.net.server ? { text: `${kind} · server connected`, cls: "ok" }
                      : { text: `${kind} · server unreachable`, cls: "warn" };
}
