// Audio and live-camera video recording.
// Recordings are saved on the phone first (IndexedDB), stamped with time and
// location, then uploaded to the ground server when a link is available.
import { db } from "./db.js";
import { api } from "./api.js";

const VIDEO_TYPES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
const AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];

function pickType(list) {
  if (!window.MediaRecorder) return "";
  return list.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

export const rec = {
  mode: "video",           // "video" | "audio"
  facing: "environment",   // back camera by default
  stream: null,
  recorder: null,
  chunks: [],
  startedAt: 0,
  recording: false,
  audioCtx: null,
  analyser: null,
};

export function mediaSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

export async function startPreview(videoEl) {
  await stopPreview();
  const constraints = rec.mode === "video"
    ? { video: { facingMode: { ideal: rec.facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true } }
    : { audio: { echoCancellation: true, noiseSuppression: true }, video: false };
  rec.stream = await navigator.mediaDevices.getUserMedia(constraints);
  if (rec.mode === "video" && videoEl) {
    videoEl.srcObject = rec.stream;
    videoEl.muted = true;
    await videoEl.play().catch(() => {});
  }
  // level meter
  try {
    rec.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = rec.audioCtx.createMediaStreamSource(rec.stream);
    rec.analyser = rec.audioCtx.createAnalyser();
    rec.analyser.fftSize = 512;
    src.connect(rec.analyser);
  } catch { rec.analyser = null; }
  return rec.stream;
}

export async function stopPreview() {
  if (rec.recording) await stopRecording();
  if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
  rec.stream = null;
  if (rec.audioCtx) { try { await rec.audioCtx.close(); } catch {} }
  rec.audioCtx = null;
  rec.analyser = null;
}

export function level() {
  if (!rec.analyser) return 0;
  const buf = new Uint8Array(rec.analyser.fftSize);
  rec.analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
  return Math.min(1, Math.sqrt(sum / buf.length) * 3);
}

export function startRecording() {
  if (!rec.stream) throw new Error("No camera or microphone stream");
  const mimeType = pickType(rec.mode === "video" ? VIDEO_TYPES : AUDIO_TYPES);
  const stream = rec.mode === "audio" ? new MediaStream(rec.stream.getAudioTracks()) : rec.stream;
  rec.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  rec.chunks = [];
  rec.recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  rec.recorder.start(1000); // a chunk every second, so little is lost if the app is closed
  rec.startedAt = Date.now();
  rec.recording = true;
}

export function stopRecording() {
  return new Promise((resolve) => {
    if (!rec.recorder || rec.recorder.state === "inactive") { rec.recording = false; resolve(null); return; }
    rec.recorder.onstop = () => {
      rec.recording = false;
      const type = (rec.recorder.mimeType || (rec.mode === "video" ? "video/webm" : "audio/webm")).split(";")[0];
      const blob = new Blob(rec.chunks, { type });
      resolve({ blob, type, duration: (Date.now() - rec.startedAt) / 1000 });
    };
    rec.recorder.stop();
  });
}

export async function saveRecording({ blob, type, duration }, fix, note) {
  const id = "REC-" + Date.now().toString(36).toUpperCase();
  const item = {
    id, kind: rec.mode, blob, type, size: blob.size, duration,
    created: Date.now(), lat: fix?.lat ?? null, lon: fix?.lon ?? null, accuracy: fix?.accuracy ?? null,
    note: note || "", uploaded: false,
  };
  await db.put("recordings", item);
  return item;
}

export async function listRecordings() {
  const all = await db.all("recordings").catch(() => []);
  return all.sort((a, b) => b.created - a.created);
}

export async function deleteRecording(id) { await db.del("recordings", id); }

export async function uploadRecording(item) {
  const fd = new FormData();
  const ext = item.type.includes("mp4") ? (item.kind === "audio" ? "m4a" : "mp4") : item.type.includes("ogg") ? "ogg" : "webm";
  fd.append("file", new File([item.blob], `${item.id}.${ext}`, { type: item.type }));
  fd.append("kind", item.kind);
  fd.append("rec_id", item.id);
  fd.append("duration", String(item.duration || 0));
  if (item.lat != null) { fd.append("lat", String(item.lat)); fd.append("lon", String(item.lon)); }
  fd.append("note", item.note || "");
  await api("/api/recordings", { method: "POST", body: fd, timeout: 120000 });
  item.uploaded = true;
  await db.put("recordings", item);
  return item;
}

export async function uploadPending() {
  const items = await listRecordings();
  let n = 0;
  for (const it of items.filter((i) => !i.uploaded)) {
    try { await uploadRecording(it); n++; } catch { break; }
  }
  return n;
}

// ---------------- short voice clip for replying to a survivor ----------------
let clip = null;
export async function startClip() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mimeType = pickType(AUDIO_TYPES);
  const r = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  r.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  r.start(250);
  clip = { r, stream, chunks, started: Date.now() };
}

export function stopClip() {
  return new Promise((resolve) => {
    if (!clip) { resolve(null); return; }
    const c = clip;
    clip = null;
    c.r.onstop = () => {
      c.stream.getTracks().forEach((t) => t.stop());
      const type = (c.r.mimeType || "audio/webm").split(";")[0];
      resolve({ blob: new Blob(c.chunks, { type }), type, duration: (Date.now() - c.started) / 1000 });
    };
    c.r.stop();
  });
}
