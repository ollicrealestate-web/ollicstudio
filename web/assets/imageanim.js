// Construction animation from 3D images (no model needed): for each view, the building's lines
// are traced from its photoreal picture and drawn in glowing gold on a night background from the
// ground up; then a line of light sweeps up and reveals the photoreal picture, with a slow push-in.
// Everything is drawn on a 2D canvas as a pure function of time, so preview and export match.

const GOLD = [255, 196, 110];

function rand(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const clamp01 = x => Math.max(0, Math.min(1, x));
const ease = x => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };

/** Gold line drawing of an image: Sobel edges on a smoothed copy, thinned, strongest ~9% kept. */
export function traceLines(img, maxSide = 900) {
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const w = Math.max(8, Math.round((img.naturalWidth || img.width) * s)), h = Math.max(8, Math.round((img.naturalHeight || img.height) * s));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const src = g.getImageData(0, 0, w, h).data;
  let lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2];
  for (let pass = 0; pass < 2; pass++) {           // 3x3 box blur twice: drops fine texture, keeps edges of forms
    const o = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      let a = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) a += lum[(y + dy) * w + x + dx];
      o[y * w + x] = a / 9;
    }
    lum = o;
  }
  const mag = new Float32Array(w * h), dir = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1] + lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1];
    const gy = -lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1] + lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1];
    mag[i] = Math.hypot(gx, gy);
    const a = (Math.atan2(gy, gx) * 180 / Math.PI + 180) % 180;
    dir[i] = a < 22.5 || a >= 157.5 ? 0 : a < 67.5 ? 1 : a < 112.5 ? 2 : 3;
  }
  // keep only ridge pixels (thin lines), then the strongest of them
  const thin = new Float32Array(w * h), vals = [];
  const off = [[1, 0], [1, 1], [0, 1], [-1, 1]];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, [dx, dy] = off[dir[i]];
    if (mag[i] >= mag[i + dy * w + dx] && mag[i] >= mag[i - dy * w - dx]) { thin[i] = mag[i]; if (mag[i] > 4) vals.push(mag[i]); }
  }
  // threshold over the whole picture: clean 3D views keep all their edges, busy photos only the strongest ~9%
  const all = Array.from(mag).sort((a, b) => a - b);
  vals.sort((a, b) => a - b);
  const lo = Math.max(18, all[Math.floor(all.length * 0.91)] || 0), hi = Math.max(lo + 1, vals.length ? vals[Math.floor(vals.length * 0.97)] : lo + 1);
  const lines = document.createElement("canvas"); lines.width = w; lines.height = h;
  const lg = lines.getContext("2d"), out = lg.createImageData(w, h);
  const cols = new Float32Array(w), rowsHit = [];
  for (let i = 0; i < w * h; i++) {
    const k = (thin[i] - lo) / Math.max(1, hi - lo);
    if (k <= 0) continue;
    const a = Math.min(1, 0.55 + k);
    out.data[i * 4] = GOLD[0]; out.data[i * 4 + 1] = GOLD[1]; out.data[i * 4 + 2] = GOLD[2]; out.data[i * 4 + 3] = Math.round(a * 255);
    cols[i % w] += a; rowsHit.push(i);
  }
  lg.putImageData(out, 0, 0);
  // glow: the lines blurred by shrinking and enlarging
  const glow = document.createElement("canvas"); glow.width = w; glow.height = h;
  const small = document.createElement("canvas"); small.width = Math.max(4, w >> 3); small.height = Math.max(4, h >> 3);
  const sg = small.getContext("2d"); sg.imageSmoothingQuality = "high"; sg.drawImage(lines, 0, 0, small.width, small.height);
  const gg = glow.getContext("2d"); gg.imageSmoothingQuality = "high"; gg.globalAlpha = 1; gg.drawImage(small, 0, 0, w, h); gg.drawImage(small, 0, 0, w, h);
  // the building's width at each height: where most of the lines are
  const rowSpan = [];
  const band = Math.max(4, Math.round(h * 0.03));
  for (let y = 0; y < h; y += 1) {
    const xs = [];
    for (let yy = Math.max(0, y - band); yy < Math.min(h, y + band); yy++) for (let x = 0; x < w; x += 2) if (out.data[(yy * w + x) * 4 + 3] > 0) xs.push(x);
    if (xs.length < 6) { rowSpan.push(null); continue; }
    xs.sort((a, b) => a - b);
    rowSpan.push([xs[Math.floor(xs.length * 0.04)] / w, xs[Math.floor(xs.length * 0.96)] / w]);
  }
  return { lines, glow, width: w, height: h, rowSpan };
}

function nightBackdrop(w, h, seed = 3) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"), gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, "#040915"); gr.addColorStop(0.55, "#0f1f42"); gr.addColorStop(0.85, "#24365f"); gr.addColorStop(1, "#141a28");
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  const r = rand(seed);
  for (let i = 0; i < (w * h) / 2500; i++) { g.fillStyle = `rgba(214,222,255,${0.25 + r() * 0.6})`; const s = r() < 0.9 ? 1 : 2; g.fillRect(r() * w, r() * h * 0.7, s, s); }
  return c;
}

/**
 * views: [{ image (HTMLImageElement, photoreal), caption }]; seconds: per view.
 * Returns { duration, renderFrame(t, w, h), labelAt(t), tagAt(t), script }.
 */
export function createImageAnimation(views, { seconds = 10, script = {} } = {}) {
  const traced = views.map(v => ({ ...v, tr: traceLines(v.image) }));
  const per = Math.max(6, Math.min(20, seconds));
  const duration = per * Math.max(1, traced.length);
  const out = document.createElement("canvas"), g = out.getContext("2d");
  const tmp = document.createElement("canvas"), tg = tmp.getContext("2d");
  let backdrop = null;

  function at(t) {
    const i = Math.min(traced.length - 1, Math.floor(t / per));
    return { i, v: traced[i], u: clamp01((t - i * per) / per) };
  }
  function layout(img, w, h, zoom) {      // cover-fit with a centred push-in
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const s = Math.max(w / iw, h / ih) * zoom;
    return { x: (w - iw * s) / 2, y: (h - ih * s) / 2, w: iw * s, h: ih * s };
  }

  function renderFrame(t, w, h) {
    if (out.width !== w || out.height !== h) { out.width = w; out.height = h; tmp.width = w; tmp.height = h; backdrop = nightBackdrop(w, h); }
    const { v, u } = at(Math.min(t, duration - 1e-4));
    const zoom = 1 + 0.07 * u;
    const box = layout(v.image, w, h, zoom);
    // stages within a view: lines draw up (0-0.38), light sweeps up (0.42-0.82), photoreal holds
    const traceK = ease(u / 0.38), sweepK = ease((u - 0.42) / 0.4);
    const traceY = box.y + box.h * (1 - traceK);                // lines exist below this
    const revealY = box.y + box.h * (1 - sweepK) + (sweepK >= 1 ? -box.h * 0.05 : 0);

    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
    g.drawImage(backdrop, 0, 0, w, h);
    // a faint shadow of the finished building, so the lines sit on something
    g.globalAlpha = 0.09; g.drawImage(v.image, box.x, box.y, box.w, box.h); g.globalAlpha = 1;
    g.fillStyle = "rgba(6,12,30,0.35)"; g.fillRect(0, 0, w, h);

    // gold lines: everything below the drawing front, and above the reveal line
    const top = Math.max(traceY, 0), bottom = sweepK > 0 ? Math.min(revealY, h) : h;
    if (bottom > top) {
      g.save(); g.beginPath(); g.rect(0, top, w, bottom - top); g.clip();
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = 1; g.drawImage(v.tr.glow, box.x, box.y, box.w, box.h); g.drawImage(v.tr.glow, box.x, box.y, box.w, box.h);
      g.drawImage(v.tr.lines, box.x, box.y, box.w, box.h); g.drawImage(v.tr.lines, box.x, box.y, box.w, box.h);
      g.restore();
    }
    // the drawing front glows while the lines are being drawn
    if (traceK > 0 && traceK < 1) frontGlow(traceY, box, v, w, h, 0.9);

    // the photoreal picture below the reveal line, with a soft edge
    if (sweepK > 0) {
      tg.clearRect(0, 0, w, h); tg.globalCompositeOperation = "source-over";
      tg.drawImage(v.image, box.x, box.y, box.w, box.h);
      tg.globalCompositeOperation = "destination-in";
      const edge = h * 0.025, gr = tg.createLinearGradient(0, revealY - edge, 0, revealY + edge);
      gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(1, "rgba(0,0,0,1)");
      tg.fillStyle = gr; tg.fillRect(0, revealY - edge, w, h);
      tg.globalCompositeOperation = "source-over";
      g.globalCompositeOperation = "source-over"; g.drawImage(tmp, 0, 0);
      // once the sweep is past the roof, the sky becomes real too
      if (sweepK >= 1) { g.globalAlpha = clamp01((u - 0.82) / 0.08); g.drawImage(v.image, box.x, box.y, box.w, box.h); g.globalAlpha = 1; }
      if (sweepK < 1) frontGlow(revealY, box, v, w, h, 1.4);
    }
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
    return out;
  }

  function frontGlow(y, box, v, w, h, strength) {
    const rel = clamp01((y - box.y) / box.h), row = v.tr.rowSpan[Math.min(v.tr.rowSpan.length - 1, Math.floor(rel * v.tr.rowSpan.length))];
    if (!row) return;                       // above the roof or beside the building: no line of light
    const [a, b] = row;
    const x0 = box.x + a * box.w, x1 = box.x + b * box.w;
    g.save(); g.globalCompositeOperation = "lighter";
    // the lines right at the front, brightened
    const band = h * 0.03;
    g.beginPath(); g.rect(0, y - band, w, band * 2); g.clip();
    g.globalAlpha = Math.min(1, 0.9 * strength); g.drawImage(v.tr.glow, box.x, box.y, box.w, box.h); g.drawImage(v.tr.lines, box.x, box.y, box.w, box.h);
    g.restore();
    // a line of light across the building
    g.save(); g.globalCompositeOperation = "lighter";
    const lg = g.createLinearGradient(x0, 0, x1, 0);
    lg.addColorStop(0, "rgba(255,190,100,0)"); lg.addColorStop(0.08, `rgba(255,205,130,${0.9 * Math.min(1, strength)})`);
    lg.addColorStop(0.92, `rgba(255,205,130,${0.9 * Math.min(1, strength)})`); lg.addColorStop(1, "rgba(255,190,100,0)");
    g.fillStyle = lg; g.shadowColor = "rgba(255,190,100,0.9)"; g.shadowBlur = h * 0.02 * strength;
    g.fillRect(x0, y - Math.max(1.5, h * 0.0022), x1 - x0, Math.max(3, h * 0.0044));
    g.restore();
  }

  const labelAt = t => { const { v, u } = at(Math.min(t, duration - 1e-4)); return u < 0.42 ? (v.caption ? `${v.caption} · drawing` : "Drawing") : v.caption || "Completed building"; };
  const tagAt = t => { const { u } = at(Math.min(t, duration - 1e-4)); return u < 0.5 ? "Indicative sequence — not to scale" : "AI concept — not to scale"; };
  return { duration, renderFrame, labelAt, tagAt, script, views: traced.length };
}
