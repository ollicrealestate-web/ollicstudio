// Makes the construction animation video in the browser: title card, the animation with stage
// captions, the AI renders of the rooms, end card. Each frame is drawn at full size and encoded
// with the browser's own video encoder (WebCodecs): H.264 where the browser has it (Chrome, Edge,
// Safari), otherwise VP9, which the server converts. Nothing is sent until the file is finished.
import { Muxer, ArrayBufferTarget } from "../vendor/mp4-muxer/mp4-muxer.mjs";

export const SIZES = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080] };
const FPS = 30, CARD = 3, FADE = 0.4;
const RED = "#d42127", INK = "#f4f4f5", MUTED = "#a3a3ad", BLACK = "#070707";
const FONT = '"Outfit", "Segoe UI", system-ui, sans-serif';
const CODECS = [["avc1.640028", "avc"], ["avc1.4d0028", "avc"], ["avc1.42E028", "avc"], ["vp09.00.40.08", "vp9"]];

export function canExport() { return typeof window.VideoEncoder === "function" && typeof window.VideoFrame === "function"; }

async function chooseCodec(w, h, bitrate) {
  for (const [codec, kind] of CODECS) {
    // VP9 is only the fallback and the server converts it again, so it is encoded in the fast mode at a higher bitrate
    const config = kind === "avc" ? { codec, width: w, height: h, bitrate, framerate: FPS, avc: { format: "avc" } }
      : { codec, width: w, height: h, bitrate: Math.round(bitrate * 1.4), framerate: FPS, latencyMode: "realtime" };
    try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, kind }; } catch { /* try the next */ }
  }
  return null;
}

function loadImage(url) {
  return new Promise(resolve => {
    if (!url) return resolve(null);
    const img = new Image(); img.crossOrigin = "anonymous";
    img.onload = () => resolve(img); img.onerror = () => resolve(null);
    img.src = url;
  });
}

function wrap(g, text, maxW) {
  const words = String(text || "").split(/\s+/).filter(Boolean), lines = [];
  let line = "";
  for (const w of words) { const t = line ? `${line} ${w}` : w; if (g.measureText(t).width <= maxW || !line) line = t; else { lines.push(line); line = w; } }
  if (line) lines.push(line);
  return lines;
}

function drawCard(g, w, h, title, subtitle, end) {
  const u = Math.min(w, h) / 1080;
  g.fillStyle = BLACK; g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(212,33,39,0.12)"; g.lineWidth = 1;
  for (let x = 0; x < w; x += 90 * u) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = 0; y < h; y += 90 * u) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  const m = 110 * u;
  g.font = `700 ${84 * u}px ${FONT}`; g.textBaseline = "top";
  const lines = wrap(g, title, w - 2 * m).slice(0, 3);
  let y = (h - (lines.length * 96 * u + 80 * u)) / 2;
  g.fillStyle = RED; g.fillRect(m, y - 40 * u, 90 * u, 8 * u);
  g.fillStyle = INK; lines.forEach((l, i) => g.fillText(l, m, y + i * 96 * u));
  y += lines.length * 96 * u + 18 * u;
  g.font = `400 ${36 * u}px ${FONT}`; g.fillStyle = MUTED;
  wrap(g, subtitle, w - 2 * m).slice(0, 3).forEach(l => { g.fillText(l, m, y); y += 48 * u; });
  if (end) { g.font = `500 ${26 * u}px ${FONT}`; g.fillText("3D sequence is indicative; renders are AI concepts, not to scale.", m, h - m); }
}

function drawCaption(g, w, h, { title, tag, brand }) {
  const u = Math.min(w, h) / 1080, m = 56 * u;
  const band = 300 * u, grad = g.createLinearGradient(0, h - band, 0, h);
  grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0,0.6)");
  g.fillStyle = grad; g.fillRect(0, h - band, w, band);
  g.textBaseline = "top";
  if (title) {
    g.font = `600 ${54 * u}px ${FONT}`;
    const lines = wrap(g, title, w * 0.7).slice(0, 2);
    const y = h - m - lines.length * 64 * u;
    g.fillStyle = RED; g.fillRect(m, y + 6 * u, 7 * u, lines.length * 64 * u - 8 * u);
    g.fillStyle = INK; lines.forEach((l, i) => g.fillText(l, m + 26 * u, y + i * 64 * u));
  }
  if (tag) {
    g.font = `500 ${24 * u}px ${FONT}`;
    const tw = g.measureText(tag).width, pad = 14 * u;
    g.fillStyle = "rgba(7,7,7,0.78)"; g.fillRect(m, m, tw + 2 * pad + 8 * u, 46 * u);
    g.fillStyle = RED; g.fillRect(m, m, 5 * u, 46 * u);
    g.fillStyle = INK; g.fillText(tag, m + pad + 8 * u, m + 10 * u);
  }
  if (brand) {
    g.font = `500 ${26 * u}px ${FONT}`; g.fillStyle = "rgba(244,244,245,0.88)";
    g.fillText(brand, w - m - g.measureText(brand).width, h - m - 30 * u);
  }
}

function drawStill(g, w, h, img, k, i) {
  const s = Math.max(w / img.width, h / img.height) * (i % 2 ? 1.08 - 0.08 * k : 1 + 0.08 * k);
  const dw = img.width * s, dh = img.height * s;
  const pan = i % 3 === 1 ? (k - 0.5) * (dw - w) * 0.6 : 0;
  g.drawImage(img, (w - dw) / 2 + pan, (h - dh) / 2, dw, dh);
}

/**
 * seq: createConstruction(...); stills: [{url, caption}]; returns { blob, codec, duration, items }.
 * onProgress(fraction, text). Stops with an AbortError when signal is aborted.
 */
export async function exportVideo({ seq, script, stills = [], brand = "Ollic Design Studio", title = "Construction sequence", onProgress = () => {}, signal }) {
  if (!canExport()) throw new Error("This browser cannot make videos. Use Chrome or Edge on a computer, or Safari 17 or newer.");
  const [w, h] = SIZES[script.format] || SIZES["16:9"];
  const chosen = await chooseCodec(w, h, w * h > 1.5e6 ? 8_000_000 : 6_000_000);
  if (!chosen) throw new Error("This browser cannot make videos. Use Chrome or Edge on a computer, or Safari 17 or newer.");
  try { await document.fonts?.load(`600 40px "Outfit"`); } catch { /* the fallback font is fine */ }
  const imgs = script.renders ? (await Promise.all(stills.map(s => loadImage(s.url)))).map((img, i) => img && { img, caption: stills[i].caption, render_id: stills[i].render_id }).filter(Boolean) : [];

  const parts = [{ kind: "card", seconds: CARD, title: script.title || title, subtitle: script.subtitle }];
  parts.push({ kind: "build", seconds: seq.duration });
  imgs.forEach((s, i) => parts.push({ kind: "still", seconds: script.render_seconds, still: s, index: i }));
  parts.push({ kind: "card", seconds: CARD, title: "Thank you", subtitle: script.subtitle || script.title || title, end: true });
  const total = parts.reduce((a, p) => a + p.seconds, 0);
  const frames = Math.round(total * FPS);

  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const g = out.getContext("2d", { alpha: false });
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: chosen.kind, width: w, height: h, frameRate: FPS }, fastStart: "in-memory" });
  let failure = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { failure = e; } });
  enc.configure(chosen.config);

  let partIndex = 0, partStart = 0;
  for (let f = 0; f < frames; f++) {
    if (signal?.aborted) { enc.close(); throw new DOMException("Export cancelled.", "AbortError"); }
    if (failure) throw new Error("The video encoder stopped. Try again, or use another browser.");
    const t = f / FPS;
    while (partIndex < parts.length - 1 && t >= partStart + parts[partIndex].seconds) { partStart += parts[partIndex].seconds; partIndex++; }
    const p = parts[partIndex], lt = t - partStart, k = Math.min(1, lt / p.seconds);
    if (p.kind === "card") {
      drawCard(g, w, h, p.title, p.subtitle, p.end);
    } else if (p.kind === "build") {
      const canvas = seq.renderFrame(lt, w, h);
      g.drawImage(canvas, 0, 0, w, h);
      drawCaption(g, w, h, { title: script.captions ? seq.labelAt(lt) : "", tag: "Indicative sequence — not to scale", brand });
    } else {
      g.fillStyle = BLACK; g.fillRect(0, 0, w, h);
      drawStill(g, w, h, p.still.img, k, p.index);
      drawCaption(g, w, h, { title: p.still.caption, tag: "AI concept — not to scale", brand });
    }
    const fade = Math.min(1, lt / FADE, (p.seconds - lt) / FADE);
    if (fade < 1) { g.fillStyle = `rgba(0,0,0,${1 - Math.max(0, fade)})`; g.fillRect(0, 0, w, h); }
    const vf = new VideoFrame(out, { timestamp: Math.round(f * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(vf, { keyFrame: f % (FPS * 2) === 0 });
    vf.close();
    if (enc.encodeQueueSize > 4) await new Promise(r => enc.addEventListener("dequeue", r, { once: true }));
    if (f % 10 === 0) { onProgress(f / frames, `Drawing frame ${f + 1} of ${frames}`); await new Promise(r => setTimeout(r, 0)); }
  }
  onProgress(1, "Finishing the file");
  await enc.flush();
  if (failure) throw new Error("The video encoder stopped. Try again, or use another browser.");
  enc.close();
  muxer.finalize();
  const items = imgs.map(s => ({ caption: s.caption, render_id: s.render_id }));
  return { blob: new Blob([target.buffer], { type: "video/mp4" }), codec: chosen.kind, duration: total, items, width: w, height: h };
}
