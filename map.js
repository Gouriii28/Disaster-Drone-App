// Operation map (Leaflet) — real satellite imagery with place names by default.
// Shows cases (aircraft detections + SOS calls), aerial units, rescue teams,
// hazard reports, India disaster alerts (with their warning areas) and your position.
import { esc, fmtCoord, ago, PRIORITY_LABEL, CASE_STATUS_LABEL, NAV_LABEL, LINK_LABEL } from "./ui.js";

let map = null;
const layers = {};
let meMarker = null, meCircle = null;
let pickHandler = null;
let placedOnUser = false;
const visible = { cases: true, drones: true, units: true, hazards: true, alerts: true };

const PRIORITY_COLOR = { critical: "#a63a32", high: "#b0701a", medium: "#4f6d8f" };
const LEVEL_COLOR = { red: "#a63a32", orange: "#b0701a", yellow: "#a89220", green: "#4c7a5c" };
const INDIA_VIEW = { lat: 22.5, lon: 79.0, zoom: 5 };

export function initMap(el, center) {
  if (map) return map;
  if (!window.L) {
    el.innerHTML = '<div class="map-offline">Map library could not load.</div>';
    return null;
  }
  const start = center && center.zoom ? center : INDIA_VIEW;
  map = L.map(el, { zoomControl: false, attributionControl: true, worldCopyJump: true })
    .setView([start.lat, start.lon], start.zoom);
  map.attributionControl.setPrefix(false);   // keep only the required map-data credits
  L.control.zoom({ position: "bottomright" }).addTo(map);

  const imagery = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" });
  const labels = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Labels © Esri", pane: "overlayPane" });
  const satellite = L.layerGroup([imagery, labels]);
  const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { maxZoom: 19, attribution: "© OpenStreetMap contributors" });
  satellite.addTo(map);
  const layersControl = L.control.layers({ "Satellite": satellite, "Street": street }, null, { position: "topright" }).addTo(map);
  watchTiles(el, imagery, street, satellite, layersControl);

  for (const k of Object.keys(visible)) {
    layers[k] = L.layerGroup();
    if (visible[k]) layers[k].addTo(map);
  }

  map.on("click", (e) => {
    if (pickHandler) {
      const fn = pickHandler;
      pickHandler = null;
      el.classList.remove("picking");
      fn({ lat: e.latlng.lat, lon: e.latlng.lng });
    }
  });
  return map;
}

// If map pictures cannot be downloaded (blocked network, no internet), say so clearly,
// and fall back from satellite to the street map automatically.
function watchTiles(el, imagery, street, satellite, control) {
  const note = document.createElement("div");
  note.className = "map-note";
  note.hidden = true;
  el.appendChild(note);
  const stats = new Map([[imagery, { ok: 0, bad: 0 }], [street, { ok: 0, bad: 0 }]]);
  let switched = false, blocked = false, hideTimer = null;
  const check = () => {
    const sat = stats.get(imagery), st = stats.get(street);
    if (!switched && sat.ok === 0 && sat.bad >= 6) {
      switched = true;
      map.removeLayer(satellite);
      street.addTo(map);
      note.textContent = "Satellite pictures could not load on this network — showing the street map instead.";
      note.hidden = false;
      hideTimer = setTimeout(() => { if (!blocked) note.hidden = true; }, 8000);
    }
    if (!blocked && sat.ok === 0 && st.ok === 0 && sat.bad + st.bad >= 10) {
      blocked = true;
      clearTimeout(hideTimer);
      note.innerHTML = "Map pictures cannot be downloaded. This phone or laptop has no internet, or this network " +
        "blocks map servers (common on college/office Wi-Fi). Cases, teams and aircraft still show correctly. " +
        "Try mobile data or a phone hotspot.";
      note.hidden = false;
    }
  };
  for (const [layer, st] of stats) {
    layer.on("tileload", () => { st.ok++; if (st.ok === 1) { blocked = false; note.hidden = true; } });
    layer.on("tileerror", () => { st.bad++; check(); });
  }
}

export function refreshSize() { if (map) setTimeout(() => map.invalidateSize(), 60); }

export function setLayerVisible(name, on) {
  visible[name] = on;
  if (!map) return;
  if (on) layers[name].addTo(map); else map.removeLayer(layers[name]);
}

export function pickPoint(el, fn) { pickHandler = fn; el.classList.add("picking"); }
export function cancelPick(el) { pickHandler = null; el.classList.remove("picking"); }
export function focus(lat, lon, zoom = 18) { if (map) map.setView([lat, lon], zoom); }
export function showIndia() { if (map) map.setView([INDIA_VIEW.lat, INDIA_VIEW.lon], INDIA_VIEW.zoom); }

// ---------------- keyed markers, updated in place (popups stay open) ----------------
const keyed = { cases: new Map(), drones: new Map(), units: new Map(), hazards: new Map() };

function sync(name, items, keyOf, create, update) {
  const store = keyed[name];
  const seen = new Set();
  for (const it of items) {
    const k = keyOf(it);
    seen.add(k);
    let m = store.get(k);
    if (!m) { m = create(it); m.addTo(layers[name]); store.set(k, m); }
    else update(m, it);
  }
  for (const [k, m] of store) if (!seen.has(k)) { layers[name].removeLayer(m); store.delete(k); }
}

function caseIcon(c) {
  const done = c.status === "rescued" || c.status === "closed";
  const color = done ? "#7c8794" : PRIORITY_COLOR[c.priority] || "#4f6d8f";
  const label = c.type === "sos" ? "SOS" : "";
  const ring = c.status === "new" ? "new" : "";
  return L.divIcon({
    className: "",
    html: `<div class="case-pin ${c.type} ${ring}" style="background:${color}">${label}</div>`,
    iconSize: c.type === "sos" ? [34, 20] : [18, 18], iconAnchor: c.type === "sos" ? [17, 10] : [9, 9],
  });
}
const caseKey = (c) => c.type + ":" + c.id;
const caseTip = (c) => `${esc(c.id)} · ${PRIORITY_LABEL[c.priority] || ""} · ${CASE_STATUS_LABEL[c.status]}${c.team ? " · " + esc(c.team) : ""}`;

function droneIcon(d) {
  return L.divIcon({
    className: "drone-icon",
    html: `<div class="drone-pin ${d.link === "LORA" ? "lora" : ""}"><svg viewBox="0 0 24 24" width="16" height="16"><use href="#i-uav"/></svg></div><span class="drone-label">${esc(d.drone_id)}</span>`,
    iconSize: [30, 30], iconAnchor: [15, 15],
  });
}
const dronePopup = (d) => `<b>${esc(d.drone_id)}</b><br>${esc(d.state)} · ${d.alt} m · ${Math.round(d.battery)}%<br>
  ${esc(NAV_LABEL[d.nav_mode] || d.nav_mode)}<br>${esc(LINK_LABEL[d.link] || d.link)} (${d.rssi} dBm)`;

export function renderState(state, onCaseClick) {
  if (!map) return;
  sync("cases", state.cases, caseKey,
    (c) => {
      const m = L.marker([c.lat, c.lon], { icon: caseIcon(c), zIndexOffset: c.type === "sos" ? 800 : 600 }).bindTooltip(caseTip(c));
      m._sig = c.status + c.priority;
      m.on("click", () => onCaseClick && onCaseClick(c.type, c.id));
      return m;
    },
    (m, c) => {
      m.setLatLng([c.lat, c.lon]);
      if (m._sig !== c.status + c.priority) { m.setIcon(caseIcon(c)); m._sig = c.status + c.priority; }
      m.setTooltipContent(caseTip(c));
    });

  sync("drones", state.drones, (d) => d.drone_id,
    (d) => { const m = L.marker([d.lat, d.lon], { icon: droneIcon(d), zIndexOffset: 500 }).bindPopup(dronePopup(d)); m._link = d.link; return m; },
    (m, d) => { m.setLatLng([d.lat, d.lon]); if (m._link !== d.link) { m.setIcon(droneIcon(d)); m._link = d.link; } m.setPopupContent(dronePopup(d)); });

  sync("units", state.units, (u) => u.device_id,
    (u) => L.marker([u.lat, u.lon], {
      icon: L.divIcon({ className: "", html: `<div class="team-pin"></div><span class="team-label">${esc(u.team)}</span>`, iconSize: [14, 14], iconAnchor: [7, 7] }),
    }).bindTooltip(`${esc(u.team)} · ${esc(u.member)} · ${ago(u.updated)}`),
    (m, u) => m.setLatLng([u.lat, u.lon]));

  sync("hazards", state.hazards, (h) => h.id,
    (h) => L.marker([h.lat, h.lon], {
      icon: L.divIcon({ className: "", html: `<div class="hz-pin ${esc(h.severity)}">!</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).bindPopup(`<b>${esc(h.kind)}</b> (${esc(h.severity)})<br>${esc(h.note)}<br><small>${esc(h.team)} · ${ago(h.created)}</small>`),
    () => {});
}

export function renderAlerts(events) {
  if (!map) return;
  layers.alerts.clearLayers();
  for (const e of events) {
    const color = LEVEL_COLOR[e.level] || "#4f6d8f";
    const popup = `<b>${esc(e.type)}</b> · ${esc(e.source)}<br>${esc(e.title_en || e.title)}${e.area ? `<br><small>${esc(e.area)}</small>` : ""}<br><small>${ago(e.time)}</small>`;
    for (const poly of e.polygons || []) {
      L.polygon(poly, { color, weight: 1.5, fillOpacity: 0.12 }).bindPopup(popup).addTo(layers.alerts);
    }
    if (e.lat != null) {
      L.circleMarker([e.lat, e.lon], { radius: 7, color: "#fff", weight: 1.5, fillColor: color, fillOpacity: 0.95 })
        .bindPopup(popup).addTo(layers.alerts);
    }
  }
}

export function renderMe(fix, mode) {
  if (!map) return;
  if (!fix) {
    if (meMarker) { map.removeLayer(meMarker); map.removeLayer(meCircle); meMarker = meCircle = null; }
    return;
  }
  const ll = [fix.lat, fix.lon];
  const denied = mode === "denied";
  if (!meMarker) {
    meCircle = L.circle(ll, { radius: fix.accuracy, color: "#2f5d8a", weight: 1, fillOpacity: 0.1 }).addTo(map);
    meMarker = L.circleMarker(ll, { radius: 7, color: "#fff", weight: 3, fillColor: "#2f5d8a", fillOpacity: 1 }).bindTooltip("You").addTo(map);
  } else {
    meMarker.setLatLng(ll);
    meCircle.setLatLng(ll).setRadius(fix.accuracy);
  }
  meCircle.setStyle({ dashArray: denied ? "4 4" : null, color: denied ? "#9a6216" : "#2f5d8a" });
  meMarker.setStyle({ fillColor: denied ? "#9a6216" : "#2f5d8a" });
  if (!placedOnUser) { placedOnUser = true; map.setView(ll, 16); }
}
