// AI assistant. Sends the conversation to the ground server, which answers
// with the AI model when online, or with built-in safety guidance offline.
import { api } from "./api.js";
import { loc } from "./location.js";
import { $, esc } from "./ui.js";
import { offlineAnswer } from "./offline-guide.js";

const KEY = "saadaxa.chat";
let history = [];
try { history = JSON.parse(sessionStorage.getItem(KEY)) || []; } catch {}

const SUGGESTIONS = [
  "Which open cases are critical and closest to me?",
  "Walk me through START triage",
  "Survivor pinned under a slab for 3 hours — what do we do before lifting?",
  "Safety checks before entering a collapsed building",
  "Swift-water rescue: what should the team do?",
  "Summarise the current operation",
];

function save() { try { sessionStorage.setItem(KEY, JSON.stringify(history.slice(-30))); } catch {} }

// Very small, safe formatter: paragraphs, numbered / bulleted lists, **bold**
function format(text) {
  const lines = esc(text).split(/\n/);
  let html = "", list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    let m;
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); html += "<ol>"; list = "ol"; } html += `<li>${m[1]}</li>`; }
    else if ((m = line.match(/^\s*[-•*]\s+(.*)/))) { if (list !== "ul") { close(); html += "<ul>"; list = "ul"; } html += `<li>${m[1]}</li>`; }
    else if (line.trim() === "") { close(); }
    else { close(); html += `<p>${line}</p>`; }
  }
  close();
  return html;
}

function bubble(role, text, mode) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = format(text) + (role === "assistant" && mode === "offline"
    ? '<div class="msg-meta">Offline guidance</div>' : "");
  return div;
}

export function renderChat() {
  const box = $("#chat-log");
  box.innerHTML = "";
  if (!history.length) {
    box.innerHTML = `<div class="chat-empty">
      <p class="chat-empty-title">Ask about triage, rescue procedures, first aid or the live cases.</p>
      <div class="chips">${SUGGESTIONS.map((s) => `<button class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join("")}</div>
    </div>`;
    box.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => ask(b.dataset.q)));
    return;
  }
  for (const m of history) box.appendChild(bubble(m.role, m.content, m.mode));
  box.scrollTop = box.scrollHeight;
}

let busy = false;
export async function ask(text) {
  text = (text || "").trim();
  if (!text || busy) return;
  busy = true;
  history.push({ role: "user", content: text });
  renderChat();
  const box = $("#chat-log");
  const typing = document.createElement("div");
  typing.className = "msg assistant typing";
  typing.innerHTML = "<span></span><span></span><span></span>";
  box.appendChild(typing);
  box.scrollTop = box.scrollHeight;
  $("#chat-send").disabled = true;

  let reply, mode;
  try {
    const res = await api("/api/chat", {
      method: "POST", timeout: 45000,
      body: {
        messages: history.map(({ role, content }) => ({ role, content })),
        lat: loc.fix?.lat ?? null, lon: loc.fix?.lon ?? null,
      },
    });
    reply = res.reply; mode = res.mode;
  } catch {
    // server unreachable: answer on the phone itself
    reply = offlineAnswer(text); mode = "offline";
  }
  history.push({ role: "assistant", content: reply, mode });
  save();
  busy = false;
  $("#chat-send").disabled = false;
  setMode(mode);
  renderChat();
}

export function setMode(mode) {
  const b = $("#chat-mode");
  if (!b) return;
  b.textContent = mode === "online" ? "AI online" : "Offline guidance";
  b.className = "badge " + (mode === "online" ? "ok" : "muted");
}

export function clearChat() { history = []; save(); renderChat(); }

// Voice input (where the browser supports speech recognition)
export function voiceSupported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
export function startVoice(onText, onEnd) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const r = new SR();
  r.lang = navigator.language || "en-IN";
  r.interimResults = true;
  r.onresult = (e) => onText([...e.results].map((x) => x[0].transcript).join(" "));
  r.onend = onEnd;
  r.onerror = onEnd;
  r.start();
  return r;
}
