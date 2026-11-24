// Match a picture's camera: the picture (a Revit render, a site photo) is laid over the 3D view, and the camera is
// moved until the model's lines sit on the picture's edges. The score is how well they line up (0 to 100): for each
// line of the model, how near the nearest strong edge of the picture is, and the other way round.
// Works on plain pixel arrays ({ data, width, height }), so it is tested the same in the browser and in Node.

/** Brightness edges of a picture (Sobel), keeping the strongest share of them: true/false per pixel. */
export function edgesOf(img, keep = 0.12) {
  const { width: w, height: h, data } = img, L = new Float32Array(w * h), G = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const a = (dx, dy) => L[(y + dy) * w + x + dx];
    const gx = a(1, -1) + 2 * a(1, 0) + a(1, 1) - a(-1, -1) - 2 * a(-1, 0) - a(-1, 1), gy = a(-1, 1) + 2 * a(0, 1) + a(1, 1) - a(-1, -1) - 2 * a(0, -1) - a(1, -1);
    G[y * w + x] = Math.hypot(gx, gy);
  }
  const sorted = Float32Array.from(G).sort(), cut = Math.max(20, sorted[Math.floor(sorted.length * (1 - keep))]);
  const E = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) E[i] = G[i] >= cut ? 1 : 0;
  return { w, h, e: E };
}
/** The model's lines in a guide picture (light lines on black): true/false per pixel. */
export function linesOf(img, level = 90) {
  const { width: w, height: h, data } = img, E = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) E[i] = data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2] > level * 3 ? 1 : 0;
  return { w, h, e: E };
}
/** For every pixel, the distance (pixels) to the nearest edge pixel (two-pass chamfer, 3-4 weights). */
export function distanceTo({ w, h, e }) {
  const INF = 1e6, d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = e[i] ? 0 : INF;
  const at = (x, y) => d[y * w + x];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = d[y * w + x];
    if (x > 0) v = Math.min(v, at(x - 1, y) + 3);
    if (y > 0) { v = Math.min(v, at(x, y - 1) + 3); if (x > 0) v = Math.min(v, at(x - 1, y - 1) + 4); if (x < w - 1) v = Math.min(v, at(x + 1, y - 1) + 4); }
    d[y * w + x] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    let v = d[y * w + x];
    if (x < w - 1) v = Math.min(v, at(x + 1, y) + 3);
    if (y < h - 1) { v = Math.min(v, at(x, y + 1) + 3); if (x < w - 1) v = Math.min(v, at(x + 1, y + 1) + 4); if (x > 0) v = Math.min(v, at(x - 1, y + 1) + 4); }
    d[y * w + x] = v;
  }
  for (let i = 0; i < w * h; i++) d[i] /= 3;
  return d;
}
/**
 * How well the model's lines sit on the picture's edges, 0 to 100. pic: { edges, dist } of the picture; lines: the
 * model's lines (from linesOf). tol: how near counts (pixels).
 */
export function matchScore(pic, lines, tol = 4) {
  const { w, h, e } = lines, near = d => Math.max(0, 1 - d / tol);
  const ld = distanceTo(lines);
  let a = 0, na = 0, b = 0, nb = 0;
  for (let i = 0; i < w * h; i++) {
    if (e[i]) { a += near(pic.dist[i]); na++; }
    if (pic.edges.e[i]) { b += near(ld[i]); nb++; }
  }
  if (!na || !nb) return 0;
  return 100 * Math.sqrt((a / na) * (b / nb));   // both ways: the model's lines on the picture's edges, and back
}
/** A picture's edges and distances, ready for scoring at the size the guides are drawn. */
export function prepare(img, keep) {
  const edges = edgesOf(img, keep);
  return { edges, dist: distanceTo(edges) };
}

/**
 * Moves the camera to raise the score: small steps in each number (angle around, height, distance, lens, shift),
 * keeping a step when it helps and halving the steps when nothing does. evaluate(settings) -> score.
 */
export async function refine(start, evaluate, { rounds = 8, onStep = () => {}, signal } = {}) {
  let best = { ...start }, bestScore = await evaluate(best);
  const steps = { azimuth: 4, height: Math.max(0.3, (start.height || 1.6) * 0.15), distance: Math.max(0.5, (start.distance || 20) * 0.08), lens: 3, shiftX: 0.03, shiftY: 0.03 };
  const limits = { lens: [12, 200], height: [0.1, 2000], distance: [1, 20000], shiftX: [-1, 1], shiftY: [-1, 1], azimuth: [-360, 360] };
  for (let r = 0; r < rounds; r++) {
    let improved = false;
    for (const k of Object.keys(steps)) {
      for (const sign of [1, -1]) {
        if (signal?.aborted) return { settings: best, score: bestScore };
        const v = Math.min(limits[k][1], Math.max(limits[k][0], (best[k] || 0) + sign * steps[k]));
        const trial = { ...best, [k]: v }, s = await evaluate(trial);
        if (s > bestScore + 0.05) { best = trial; bestScore = s; improved = true; onStep(best, bestScore); break; }
      }
    }
    if (!improved) for (const k of Object.keys(steps)) steps[k] /= 2;
  }
  return { settings: best, score: bestScore };
}

/** A picture (an <img> or canvas) as pixels at a size. */
export function pixelsOf(img, w, h) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
  return { data: g.getImageData(0, 0, w, h).data, width: w, height: h };
}
/**
 * Matches the viewer's camera to a picture: a coarse pass on a small drawing, then a fine one on a larger drawing.
 * img: the picture (decoded <img>); start: camera settings (numbers, with a distance); returns { settings, score }.
 */
export async function matchView(viewer, img, start, { onStep = () => {}, signal } = {}) {
  const a = img.naturalWidth / img.naturalHeight || 1.5;
  const size = long => (a >= 1 ? [long, Math.round(long / a)] : [Math.round(long * a), long]);
  const pass = async (long, from, rounds) => {
    const [w, h] = size(long), pic = prepare(pixelsOf(img, w, h));
    let n = 0;
    const evaluate = async s => { viewer.setCamera(s); if (++n % 6 === 0) await new Promise(r => setTimeout(r, 0)); return matchScore(pic, linesOf(viewer.linePixels(w, h))); };
    return refine(from, evaluate, { rounds, onStep, signal });
  };
  const coarse = await pass(240, { ...start, aspect: a, custom: true }, 10);
  const fine = await pass(360, coarse.settings, 5);
  viewer.setCamera(fine.settings);
  return fine;
}
