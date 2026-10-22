// Construction animation from 3D images (no model needed): for each view, the building's lines
// are traced from its photoreal picture and drawn in glowing gold on a night background from the
// ground up; then a line of light sweeps up and reveals the photoreal picture, with a slow push-in.
// Everything is drawn on a 2D canvas as a pure function of time, so preview and export match.

const GOLD = [255, 178, 80];

function rand(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const clamp01 = x => Math.max(0, Math.min(1, x));
const ease = x => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };

/**
 * Gold line drawing of an image, Canny-style: smoothed, Sobel edges thinned to one pixel, then
 * hysteresis (strong edges, plus weaker ones joined to them), small specks removed, and only the
 * building's width kept (trees, sky and stars at the sides are dropped).
 */
export function traceLines(img, maxSide = 1400) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.min(1, maxSide / Math.max(iw, ih));
  const w = Math.max(8, Math.round(iw * s)), h = Math.max(8, Math.round(ih * s)), n = w * h;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const src = g.getImageData(0, 0, w, h).data;
  let lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2];
  for (let pass = 0; pass < 3; pass++) {           // separable box blur, three times: close to a Gaussian
    const t = new Float32Array(n), o = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 1; x < w - 1; x++) t[y * w + x] = (lum[y * w + x - 1] + lum[y * w + x] + lum[y * w + x + 1]) / 3;
    for (let y = 1; y < h - 1; y++) for (let x = 0; x < w; x++) o[y * w + x] = (t[(y - 1) * w + x] + t[y * w + x] + t[(y + 1) * w + x]) / 3;
    lum = o;
  }
  const mag = new Float32Array(n), dir = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1] + lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1];
    const gy = -lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1] + lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1];
    mag[i] = Math.hypot(gx, gy);
    const a = (Math.atan2(gy, gx) * 180 / Math.PI + 180) % 180;
    dir[i] = a < 22.5 || a >= 157.5 ? 0 : a < 67.5 ? 1 : a < 112.5 ? 2 : 3;
  }
  const thin = new Float32Array(n), off = [[1, 0], [1, 1], [0, 1], [-1, 1]];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, [dx, dy] = off[dir[i]];
    if (mag[i] >= mag[i + dy * w + dx] && mag[i] > mag[i - dy * w - dx]) thin[i] = mag[i];
  }
  // hysteresis: strong = the top ~7% of the picture's gradients (at least a clear edge), weak joined to strong
  const sorted = Float32Array.from(mag).sort();
  const high = Math.max(28, sorted[Math.floor(n * 0.93)]), low = high * 0.45;
  const keep = new Uint8Array(n), stack = [];
  for (let i = 0; i < n; i++) if (thin[i] >= high) { keep[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx; if (!keep[j] && thin[j] >= low) { keep[j] = 1; stack.push(j); }
    }
  }
  // drop specks: connected pieces shorter than ~2% of the picture
  const minLen = Math.max(18, Math.round(Math.max(w, h) * 0.02)), seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!keep[i] || seen[i]) continue;
    const part = [i]; seen[i] = 1;
    for (let k = 0; k < part.length; k++) {
      const q = part[k], x = q % w, y = (q / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx; if (keep[j] && !seen[j]) { seen[j] = 1; part.push(j); }
      }
    }
    if (part.length < minLen) for (const q of part) keep[q] = 0;
  }
  // the building: the widest run of columns with many lines, around the busiest column
  const col = new Float32Array(w);
  for (let i = 0; i < n; i++) if (keep[i]) col[i % w]++;
  const win = Math.max(2, Math.round(w * 0.02)), sm = new Float32Array(w);
  for (let x = 0; x < w; x++) { let a = 0, c2 = 0; for (let k = -win; k <= win; k++) if (x + k >= 0 && x + k < w) { a += col[x + k]; c2++; } sm[x] = a / c2; }
  let peak = 0; for (let x = 1; x < w; x++) if (sm[x] > sm[peak]) peak = x;
  const cut = sm[peak] * 0.22;
  let x0 = peak, x1 = peak;
  while (x0 > 0 && (sm[x0 - 1] >= cut || sm[Math.max(0, x0 - win * 2)] >= cut)) x0--;
  while (x1 < w - 1 && (sm[x1 + 1] >= cut || sm[Math.min(w - 1, x1 + win * 2)] >= cut)) x1++;
  const pad = Math.round(w * 0.03); x0 = Math.max(0, x0 - pad); x1 = Math.min(w - 1, x1 + pad);
  for (let i = 0; i < n; i++) { const x = i % w; if (x < x0 || x > x1) keep[i] = 0; }

  const lines = document.createElement("canvas"); lines.width = w; lines.height = h;
  const lg = lines.getContext("2d"), out = lg.createImageData(w, h);
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const a = Math.min(1, 0.7 + 0.3 * (thin[i] - low) / Math.max(1, high - low));
    out.data[i * 4] = GOLD[0]; out.data[i * 4 + 1] = GOLD[1]; out.data[i * 4 + 2] = GOLD[2]; out.data[i * 4 + 3] = Math.round(a * 255);
  }
  lg.putImageData(out, 0, 0);
  const glow = document.createElement("canvas"); glow.width = w; glow.height = h;
  const small = document.createElement("canvas"); small.width = Math.max(4, w >> 2); small.height = Math.max(4, h >> 2);
  const sg = small.getContext("2d"); sg.imageSmoothingQuality = "high"; sg.drawImage(lines, 0, 0, small.width, small.height);
  const gg = glow.getContext("2d"); gg.imageSmoothingQuality = "high"; gg.drawImage(small, 0, 0, w, h); gg.globalCompositeOperation = "lighter"; gg.drawImage(small, 0, 0, w, h);
  // the building's width at each height, for the line of light
  const rowSpan = [], band = Math.max(4, Math.round(h * 0.025));
  for (let y = 0; y < h; y++) {
    let a = -1, b = -1, cnt = 0;
    for (let yy = Math.max(0, y - band); yy < Math.min(h, y + band); yy++) for (let x = x0; x <= x1; x += 2) if (keep[yy * w + x]) { cnt++; if (a < 0 || x < a) a = x; if (x > b) b = x; }
    rowSpan.push(cnt < 6 ? null : [a / w, b / w]);
  }
  return { lines, glow, width: w, height: h, rowSpan };
}

/**
 * Gold lines from an AI line drawing (light lines on black, same view as the photo): far cleaner
 * than tracing the photo. Brightness becomes the gold's opacity.
 */
export function linesFromDrawing(img, maxSide = 1600) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.min(1, maxSide / Math.max(iw, ih));
  const w = Math.max(8, Math.round(iw * s)), h = Math.max(8, Math.round(ih * s)), n = w * h;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const src = g.getImageData(0, 0, w, h).data;
  const lines = document.createElement("canvas"); lines.width = w; lines.height = h;
  const lg = lines.getContext("2d"), out = lg.createImageData(w, h), keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const l = 0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2];
    const a = Math.max(0, Math.min(1, (l - 60) / 170)) * 0.85;
    if (a <= 0) continue;
    keep[i] = a > 0.3 ? 1 : 0;
    out.data[i * 4] = GOLD[0]; out.data[i * 4 + 1] = GOLD[1]; out.data[i * 4 + 2] = GOLD[2]; out.data[i * 4 + 3] = Math.round(a * 255);
  }
  lg.putImageData(out, 0, 0);
  const glow = document.createElement("canvas"); glow.width = w; glow.height = h;
  const small = document.createElement("canvas"); small.width = Math.max(4, w >> 2); small.height = Math.max(4, h >> 2);
  const sg = small.getContext("2d"); sg.imageSmoothingQuality = "high"; sg.drawImage(lines, 0, 0, small.width, small.height);
  const gg = glow.getContext("2d"); gg.imageSmoothingQuality = "high"; gg.drawImage(small, 0, 0, w, h); gg.globalCompositeOperation = "lighter"; gg.drawImage(small, 0, 0, w, h);
  const rowSpan = [], band = Math.max(4, Math.round(h * 0.025));
  for (let y = 0; y < h; y++) {
    let a = -1, b = -1, cnt = 0;
    for (let yy = Math.max(0, y - band); yy < Math.min(h, y + band); yy++) for (let x = 0; x < w; x += 2) if (keep[yy * w + x]) { cnt++; if (a < 0 || x < a) a = x; if (x > b) b = x; }
    rowSpan.push(cnt < 6 ? null : [a / w, b / w]);
  }
  return { lines, glow, width: w, height: h, rowSpan, clean: true };
}

/** The picture with soft edges, for when it does not fill the frame. */
function feathered(img) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const c = document.createElement("canvas"); c.width = iw; c.height = ih;
  const g = c.getContext("2d"); g.drawImage(img, 0, 0);
  g.globalCompositeOperation = "destination-in";
  const fx = iw * 0.07, fy = ih * 0.05;
  const m = document.createElement("canvas"); m.width = iw; m.height = ih; const mg = m.getContext("2d");
  let gr = mg.createLinearGradient(0, 0, iw, 0);
  gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(fx / iw, "#000"); gr.addColorStop(1 - fx / iw, "#000"); gr.addColorStop(1, "rgba(0,0,0,0)");
  mg.fillStyle = gr; mg.fillRect(0, 0, iw, ih);
  mg.globalCompositeOperation = "destination-in";
  gr = mg.createLinearGradient(0, 0, 0, ih);
  gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(fy / ih, "#000"); gr.addColorStop(1, "#000");
  mg.fillStyle = gr; mg.fillRect(0, 0, iw, ih);
  g.drawImage(m, 0, 0);
  return c;
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
  const traced = views.map(v => ({ ...v, tr: v.drawing ? linesFromDrawing(v.drawing) : traceLines(v.image), soft: feathered(v.image) }));
  const per = Math.max(6, Math.min(20, seconds));
  const duration = per * Math.max(1, traced.length);
  const out = document.createElement("canvas"), g = out.getContext("2d");
  const tmp = document.createElement("canvas"), tg = tmp.getContext("2d");
  let backdrop = null;

  function at(t) {
    const i = Math.min(traced.length - 1, Math.floor(t / per));
    return { i, v: traced[i], u: clamp01((t - i * per) / per) };
  }
  function layout(img, w, h, zoom) {      // the whole building in frame (the sides fade into the night), with a push-in
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const cover = Math.max(w / iw, h / ih), fit = Math.min(w / iw, h / ih);
    const s = (cover / fit < 1.08 ? cover : fit * 1.02) * zoom;
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
    g.globalAlpha = 0.09; g.drawImage(v.soft, box.x, box.y, box.w, box.h); g.globalAlpha = 1;
    g.fillStyle = "rgba(6,12,30,0.35)"; g.fillRect(0, 0, w, h);

    // gold lines: everything below the drawing front, and above the reveal line
    const top = Math.max(traceY, 0), bottom = sweepK > 0 ? Math.min(revealY, h) : h;
    if (bottom > top) {
      g.save(); g.beginPath(); g.rect(0, top, w, bottom - top); g.clip();
      g.globalCompositeOperation = "lighter";
      if (v.tr.clean) {     // an AI line drawing: lines are already solid, so less doubling
        g.globalAlpha = 0.75; g.drawImage(v.tr.glow, box.x, box.y, box.w, box.h);
        g.globalAlpha = 0.95; g.drawImage(v.tr.lines, box.x, box.y, box.w, box.h);
      } else {
        g.globalAlpha = 1; g.drawImage(v.tr.glow, box.x, box.y, box.w, box.h); g.globalAlpha = 0.6; g.drawImage(v.tr.glow, box.x, box.y, box.w, box.h);
        g.globalAlpha = 1; g.drawImage(v.tr.lines, box.x, box.y, box.w, box.h); g.globalAlpha = 0.5; g.drawImage(v.tr.lines, box.x, box.y, box.w, box.h);
      }
      g.restore();
    }
    // the drawing front glows while the lines are being drawn
    if (traceK > 0 && traceK < 1) frontGlow(traceY, box, v, w, h, 0.9);

    // the photoreal picture below the reveal line, with a soft edge
    if (sweepK > 0) {
      tg.clearRect(0, 0, w, h); tg.globalCompositeOperation = "source-over";
      tg.drawImage(v.soft, box.x, box.y, box.w, box.h);
      tg.globalCompositeOperation = "destination-in";
      const edge = h * 0.025, gr = tg.createLinearGradient(0, revealY - edge, 0, revealY + edge);
      gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(1, "rgba(0,0,0,1)");
      tg.fillStyle = gr; tg.fillRect(0, revealY - edge, w, h);
      tg.globalCompositeOperation = "source-over";
      g.globalCompositeOperation = "source-over"; g.drawImage(tmp, 0, 0);
      // once the sweep is past the roof, the sky becomes real too
      if (sweepK >= 1) { g.globalAlpha = clamp01((u - 0.82) / 0.08); g.drawImage(v.soft, box.x, box.y, box.w, box.h); g.globalAlpha = 1; }
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
