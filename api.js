// Talks to the SAADAXA ground server: team sign-in, REST calls, the live
// WebSocket, and an outbox that keeps reports until a connection is available.
import { db } from "./db.js";

const listeners = new Set();
const statusListeners = new Set();
const outboxListeners = new Set();
let socket = null;
let retryMs = 1000;
let lastState = null;

export const net = { connected: false, lastMessage: 0 };

// ---------------- identity ----------------
export function deviceId() {
  let id = null;
  try { id = localStorage.getItem("saadaxa.device"); } catch {}
  if (!id) {
    id = "DEV-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    try { localStorage.setItem("saadaxa.device", id); } catch {}
  }
  return id;
}

export const session = {
  get() { try { return JSON.parse(localStorage.getItem("saadaxa.session")) || null; } catch { return null; } },
  set(s) { try { localStorage.setItem("saadaxa.session", JSON.stringify(s)); } catch {} },
  clear() { try { localStorage.removeItem("saadaxa.session"); } catch {} },
};

let onSignedOut = () => {};
export function setSignedOutHandler(fn) { onSignedOut = fn; }

export async function login(code, team, member) {
  const res = await fetch("/api/team/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, team, member, device_id: deviceId() }),
  });
  if (!res.ok) {
    const msg = res.status === 403 ? "Wrong access code." : res.status === 429 ? "Too many attempts. Wait a few minutes."
              : "Could not sign in (error " + res.status + ").";
    throw new Error(msg);
  }
  const s = await res.json();
  session.set(s);
  return s;
}

export async function logout() {
  try { await api("/api/team/logout", { method: "POST" }); } catch {}
  session.clear();
  try { socket && socket.close(); } catch {}
}

// ---------------- live state ----------------
export function onState(fn) { listeners.add(fn); if (lastState) fn(lastState); return () => listeners.delete(fn); }
function emit(state) { lastState = state; listeners.forEach((fn) => fn(state)); }
export function onNetStatus(fn) { statusListeners.add(fn); fn(net); }
function emitStatus() { statusListeners.forEach((fn) => fn(net)); }

export function connectLive() {
  const s = session.get();
  if (!s) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  try {
    socket = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(s.token)}`);
  } catch { scheduleReconnect(); return; }
  socket.onopen = () => { net.connected = true; retryMs = 1000; emitStatus(); flushOutbox(); };
  socket.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      net.lastMessage = Date.now();
      if (data.type === "state") emit(data);
      emitStatus();
    } catch {}
  };
  socket.onclose = (ev) => {
    net.connected = false;
    emitStatus();
    if (ev.code === 4401) { session.clear(); onSignedOut(); return; }
    scheduleReconnect();
  };
  socket.onerror = () => { try { socket.close(); } catch {} };
}

function scheduleReconnect() {
  setTimeout(() => { if (session.get()) connectLive(); }, retryMs);
  retryMs = Math.min(retryMs * 2, 15000);
}

// ---------------- REST ----------------
export async function api(path, { method = "GET", body, timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const s = session.get();
  const headers = {};
  if (s) headers.Authorization = "Bearer " + s.token;
  if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(path, {
      method, headers, signal: ctrl.signal,
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { session.clear(); onSignedOut(); }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      const err = new Error(`HTTP ${res.status} ${txt.slice(0, 120)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------------- outbox ----------------
// Each item: { id, path, method, body, created, label }
export async function sendOrQueue(path, body, label, method = "POST") {
  const item = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
    path, method, body: { ...body, created: Date.now() / 1000 }, label, created: Date.now(),
  };
  try {
    const res = await api(path, { method, body: item.body });
    return { sent: true, res };
  } catch (e) {
    if (e.status && e.status < 500) throw e;
    await db.put("outbox", item);
    notifyOutbox();
    return { sent: false };
  }
}

export function onOutbox(fn) { outboxListeners.add(fn); notifyOutbox(); }
async function notifyOutbox() {
  const items = await db.all("outbox").catch(() => []);
  outboxListeners.forEach((fn) => fn(items));
}

let flushing = false;
export async function flushOutbox() {
  if (flushing || !session.get()) return;
  flushing = true;
  try {
    const items = await db.all("outbox");
    for (const it of items.sort((a, b) => a.created - b.created)) {
      try {
        await api(it.path, { method: it.method, body: it.body });
        await db.del("outbox", it.id);
      } catch (e) {
        if (e.status && e.status < 500 && e.status !== 401) await db.del("outbox", it.id);
        else break;
      }
    }
  } finally {
    flushing = false;
    notifyOutbox();
  }
}

window.addEventListener("online", flushOutbox);
setInterval(flushOutbox, 30000);
