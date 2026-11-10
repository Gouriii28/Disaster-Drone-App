// Small UI helpers shared by all screens.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer = null;
export function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 3200);
}

export function openSheet(id) {
  const s = $("#" + id);
  s.hidden = false;
  requestAnimationFrame(() => s.classList.add("open"));
  $("#scrim").hidden = false;
  $("#scrim").onclick = () => closeSheet(id);
}

export function closeSheet(id) {
  const s = $("#" + id);
  s.classList.remove("open");
  $("#scrim").hidden = true;
  setTimeout(() => (s.hidden = true), 200);
}

export function ago(tsSeconds) {
  const s = Math.max(0, Date.now() / 1000 - tsSeconds);
  if (s < 10) return "just now";
  if (s < 60) return `${Math.floor(s)} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function fmtDist(m) {
  if (m == null || isNaN(m)) return "—";
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

export function fmtCoord(lat, lon) {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

export function fmtTime(sec) {
  sec = Math.floor(sec);
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

export function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export function clock(ts) {
  return new Date(ts).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export const PRIORITY_LABEL = { critical: "Critical", high: "High", medium: "Medium" };
export const CASE_STATUS_LABEL = {
  new: "New — unassigned", accepted: "Accepted", en_route: "En route", on_scene: "On scene",
  rescued: "Rescued", closed: "Closed",
};
export const CASE_TYPE_LABEL = { survivor: "Found by aircraft", sos: "SOS call" };
export const NAV_LABEL = {
  GNSS: "Satellite (GNSS)", DEGRADED: "Satellite degraded", VIO: "Visual dead-reckoning",
  POS_HOLD: "Position hold", REACQ: "Re-acquiring satellites",
};
export const LINK_LABEL = { WIFI: "Wideband Wi-Fi", LORA: "Long-range radio" };
