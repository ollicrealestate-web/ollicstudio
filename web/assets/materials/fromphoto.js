// A real, repeatable material from a photo: straighten the cropped area (four corners, perspective), find the
// pattern's period, remove uneven light, make it repeat with no joins, and make relief, roughness and shade maps.
// Works on plain pixel arrays ({ data: RGBA bytes, width, height }), so it runs the same in the browser and in tests.
// Faithful by design: the average colour is kept exactly, and nothing is invented (no new patterns).

const img = (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

/** The homography that takes the unit square (0,0)-(1,1) to four corners (top-left, top-right, bottom-right, bottom-left). */
function squareToQuad([[x0, y0], [x1, y1], [x2, y2], [x3, y3]]) {
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den; h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}
/** The cropped area, straightened: corners (pixels in src) to an outW x outH picture, sampled bilinearly. */
export function warp(src, corners, outW, outH) {
  const [a, b, c, d, e, f, g, h] = squareToQuad(corners), out = img(outW, outH), S = src.data, W = src.width, H = src.height;
  for (let y = 0; y < outH; y++) {
    const v = (y + 0.5) / outH;
    for (let x = 0; x < outW; x++) {
      const u = (x + 0.5) / outW, w = g * u + h * v + 1;
      let sx = (a * u + b * v + c) / w - 0.5, sy = (d * u + e * v + f) / w - 0.5;
      sx = Math.max(0, Math.min(W - 1.001, sx)); sy = Math.max(0, Math.min(H - 1.001, sy));
      const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy, o = (y * outW + x) * 4;
      const i00 = (iy * W + ix) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
      for (let k = 0; k < 3; k++) out.data[o + k] = (S[i00 + k] * (1 - fx) + S[i10 + k] * fx) * (1 - fy) + (S[i01 + k] * (1 - fx) + S[i11 + k] * fx) * fy;
      out.data[o + 3] = 255;
    }
  }
  return out;
}
/** Width and height in the photo's pixels of the cropped area (average of opposite sides), for its proportions. */
export function quadSize(c) {
  const L = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  return { w: (L(c[0], c[1]) + L(c[3], c[2])) / 2, h: (L(c[0], c[3]) + L(c[1], c[2])) / 2 };
}
/** A picture resized (box-averaged when shrinking, bilinear when growing). */
export function resize(src, w, h) {
  if (src.width === w && src.height === h) return src;
  return warp(src, [[0, 0], [src.width, 0], [src.width, src.height], [0, src.height]], w, h);
}
/** One channel blurred with a wide box blur, three times (close to a Gaussian), wrapping or clamping at the edges. */
function blur(ch, w, h, r, wrap = false) {
  let a = Float32Array.from(ch), b = new Float32Array(ch.length);
  // wrapping (a repeating picture) or mirrored at the edges (so an edge on a dark joint does not darken its surroundings)
  const at = (i, n) => { if (wrap) return ((i % n) + n) % n; while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - i - 1; return i; };
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {           // across
      let s = 0; for (let k = -r; k <= r; k++) s += a[y * w + at(k, w)];
      for (let x = 0; x < w; x++) { b[y * w + x] = s / (2 * r + 1); s += a[y * w + at(x + r + 1, w)] - a[y * w + at(x - r, w)]; }
    }
    for (let x = 0; x < w; x++) {           // down
      let s = 0; for (let k = -r; k <= r; k++) s += b[at(k, h) * w + x];
      for (let y = 0; y < h; y++) { a[y * w + x] = s / (2 * r + 1); s += b[at(y + r + 1, h) * w + x] - b[at(y - r, h) * w + x]; }
    }
  }
  return a;
}
/** The average colour, per channel (0-255). */
export function meanColour(p) {
  const s = [0, 0, 0], n = p.width * p.height;
  for (let i = 0; i < p.data.length; i += 4) { s[0] += p.data[i]; s[1] += p.data[i + 1]; s[2] += p.data[i + 2]; }
  return s.map(v => v / n);
}
/** CIE Lab of an sRGB colour (0-255), D65. */
export function lab([r, g, b]) {
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
/** Colour difference (CIE 1976) between two pictures' average colours. Under 5 reads as the same colour. */
export const deltaE = (p, q) => { const a = lab(meanColour(p)), b = lab(meanColour(q)); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); };

/** A smooth surface (a quadratic in x and y) fitted to log brightness: the light falling across the photo. */
function lightSurface(L, w, h) {
  const terms = (x, y) => [1, x, y, x * x, x * y, y * y];
  const A = Array.from({ length: 6 }, () => new Float64Array(6)), b = new Float64Array(6), step = Math.max(1, Math.round(Math.sqrt(w * h / 60000)));
  // sampled with a scattered offset, so a regular pattern (tile joints) cannot line up with the samples
  let seed = 12345; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y0 = 0; y0 < h; y0 += step) for (let x0 = 0; x0 < w; x0 += step) {
    const x = Math.min(w - 1, x0 + Math.floor(rnd() * step)), y = Math.min(h - 1, y0 + Math.floor(rnd() * step));
    const t = terms(x / w - 0.5, y / h - 0.5), v = Math.log(L[y * w + x]);
    for (let i = 0; i < 6; i++) { b[i] += t[i] * v; for (let j = 0; j < 6; j++) A[i][j] += t[i] * t[j]; }
  }
  for (let i = 0; i < 6; i++) {   // Gaussian elimination
    let p = i; for (let r = i + 1; r < 6; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < 6; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < 6; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  const c = new Float64Array(6);
  for (let i = 5; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < 6; j++) s -= A[i][j] * c[j]; c[i] = s / A[i][i]; }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const t = terms(x / w - 0.5, y / h - 0.5); let v = 0; for (let i = 0; i < 6; i++) v += c[i] * t[i]; out[y * w + x] = Math.exp(v); }
  return out;
}
/**
 * Removes uneven light: first the smooth fall-off across the photo (one side brighter, a dark corner), then softer
 * patches of shade (each pixel against the light around it, half strength). The average colour stays exactly the same.
 */
export function delight(p, { radius = 0.25, shade = 0.5 } = {}) {
  const { width: w, height: h, data } = p, L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = lum(data, i * 4) + 1;
  const S = lightSurface(L, w, h), flat = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) flat[i] = L[i] / S[i];
  const r = Math.max(2, Math.round(Math.min(w, h) * radius / 2)), B = blur(flat, w, h, r);
  let mean = 0; for (let i = 0; i < w * h; i++) mean += B[i]; mean /= w * h;
  let sMean = 0; for (let i = 0; i < w * h; i++) sMean += S[i]; sMean /= w * h;
  const out = img(w, h), before = meanColour(p);
  for (let i = 0; i < w * h; i++) {
    const k = (sMean / S[i]) * Math.pow(mean / B[i], shade);
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = data[i * 4 + c] * k;
    out.data[i * 4 + 3] = 255;
  }
  const after = meanColour(out);   // put back the exact average colour
  for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) out.data[i + c] = out.data[i + c] * (before[c] / Math.max(1, after[c]));
  return out;
}
/**
 * The repeat of a pattern (tiles, bricks, planks) along one axis, in pixels, from the self-similarity of the picture's
 * brightness; null when there is no clear repeat. min and max bound the search.
 */
export function period(p, axis = "x", { min = 8, max = null } = {}) {
  min = Math.max(2, Math.round(min)); if (max) max = Math.round(max);
  const { width: w, height: h, data } = p, n = axis === "x" ? w : h, m = axis === "x" ? h : w;
  // edges (where brightness changes) along the axis show joints best
  const prof = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 1; j < m - 1; j++) {
      const a = axis === "x" ? (j * w + i) * 4 : (i * w + j) * 4, b = axis === "x" ? (j * w + Math.min(n - 1, i + 1)) * 4 : (Math.min(n - 1, i + 1) * w + j) * 4;
      s += Math.abs(lum(data, a) - lum(data, b));
    }
    prof[i] = s / m;
  }
  let mu = 0; for (const v of prof) mu += v; mu /= n;
  const top = Math.min(max || Math.floor(n / 1.5), n - 2), score = new Float64Array(top + 1);
  for (let lag = min; lag <= top; lag++) {
    let s = 0, c = 0;
    for (let i = 0; i + lag < n; i++) { s += (prof[i] - mu) * (prof[i + lag] - mu); c++; }
    score[lag] = s / c;
  }
  let var0 = 0; for (const v of prof) var0 += (v - mu) ** 2; var0 /= n;
  // the strongest repeat, then its fundamental: a shorter repeat that is nearly as strong (a half or a third of it)
  const peaks = [];
  for (let lag = min + 1; lag < top; lag++) if (score[lag] > 0.2 * var0 && score[lag] >= score[lag - 1] && score[lag] >= score[lag + 1]) peaks.push(lag);
  if (!peaks.length) return null;
  let best = peaks.reduce((a, b) => (score[b] > score[a] ? b : a));
  for (const div of [4, 3, 2]) {
    const want = best / div, near = peaks.filter(l => Math.abs(l - want) <= Math.max(1.5, want * 0.04)).sort((a, b) => score[b] - score[a])[0];
    if (near && score[near] > 0.7 * score[best]) { best = near; break; }
  }
  const y0 = score[best - 1], y1 = score[best], y2 = score[best + 1], den = y0 - 2 * y1 + y2;
  return best + (den ? 0.5 * (y0 - y2) / den : 0);
}
/**
 * Makes a picture repeat with no visible join: blended with a copy shifted by half, which carries the picture's own
 * middle to its edges (where opposite edges then match), fading in only near the edges. band: fraction of the size.
 */
export function seamless(p, { band = 0.22 } = {}) {
  const { width: w, height: h, data } = p, out = img(w, h);
  const s = (t, n) => { const d = Math.min(t, n - 1 - t) / (n * band); return d >= 1 ? 1 : d * d * (3 - 2 * d); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = s(x, w) * s(y, h), o = (y * w + x) * 4, q = (((y + (h >> 1)) % h) * w + ((x + (w >> 1)) % w)) * 4;
    for (let c = 0; c < 3; c++) out.data[o + c] = data[o + c] * k + data[q + c] * (1 - k);
    out.data[o + 3] = 255;
  }
  return out;
}
/** How visible the join is when the picture repeats: the step across opposite edges, against the steps inside it (1 = like any other pixel step). */
export function seamScore(p) {
  const { width: w, height: h, data } = p;
  let edge = 0, inner = 0;
  for (let y = 0; y < h; y++) { edge += Math.abs(lum(data, (y * w + w - 1) * 4) - lum(data, y * w * 4)); inner += Math.abs(lum(data, (y * w + (w >> 1)) * 4) - lum(data, (y * w + (w >> 1) - 1) * 4)); }
  for (let x = 0; x < w; x++) { edge += Math.abs(lum(data, ((h - 1) * w + x) * 4) - lum(data, x * 4)); inner += Math.abs(lum(data, ((h >> 1) * w + x) * 4) - lum(data, (((h >> 1) - 1) * w + x) * 4)); }
  return edge / Math.max(1e-6, inner);
}
/** How much the light changes across the picture, in percent: the picture in 3 x 3 parts, each part's brightness
 * taken at its 75th percentile (the faces of the stone or tile, not its joints), largest against smallest. */
export function lightGradient(p) {
  const { width: w, height: h, data } = p, parts = Array.from({ length: 9 }, () => []);
  const step = Math.max(1, Math.round(Math.sqrt(w * h / 90000)));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) parts[Math.min(2, (3 * y / h) | 0) * 3 + Math.min(2, (3 * x / w) | 0)].push(lum(data, (y * w + x) * 4));
  const q = parts.map(a => { a.sort((u, v) => u - v); return a[Math.floor(a.length * 0.75)] || 0; });
  const m = q.reduce((a, b) => a + b, 0) / 9;
  return (Math.max(...q) - Math.min(...q)) / Math.max(1, m) * 100;
}
/**
 * Relief (normal, OpenGL style: green up), roughness and shade (ambient occlusion) from the picture's brightness.
 * strength: how deep the relief reads; rough: the material's base roughness (shinier where it is bright and smooth).
 */
export function maps(p, { strength = 2.5, rough = 0.6 } = {}) {
  const { width: w, height: h, data } = p, H = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) H[i] = lum(data, i * 4) / 255;
  const hs = blur(H, w, h, 1, true), wide = blur(H, w, h, Math.max(2, Math.round(w / 48)), true);
  const normal = img(w, h), roughness = img(w, h), ao = img(w, h), at = (x, y) => hs[((y + h) % h) * w + ((x + w) % w)];
  let mean = 0; for (const v of hs) mean += v; mean /= w * h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) * strength;
    const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) * strength;
    const nx = -dx, ny = dy, nz = 1, L = Math.hypot(nx, ny, nz), o = (y * w + x) * 4, i = y * w + x;
    normal.data[o] = (nx / L * 0.5 + 0.5) * 255; normal.data[o + 1] = (ny / L * 0.5 + 0.5) * 255; normal.data[o + 2] = (nz / L * 0.5 + 0.5) * 255; normal.data[o + 3] = 255;
    const r = Math.max(0.02, Math.min(1, rough + (mean - hs[i]) * 0.5));
    roughness.data[o] = roughness.data[o + 1] = roughness.data[o + 2] = r * 255; roughness.data[o + 3] = 255;
    const a = Math.max(0.35, Math.min(1, 1 - Math.max(0, wide[i] - hs[i]) * 2.2));
    ao.data[o] = ao.data[o + 1] = ao.data[o + 2] = a * 255; ao.data[o + 3] = 255;
  }
  return { normal, rough: roughness, ao };
}
/** A picture repeated n x n (the 3 x 3 check that it repeats with no joins). */
export function tiled(p, n = 3) {
  const out = img(p.width * n, p.height * n);
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const o = (y * out.width + x) * 4, q = ((y % p.height) * p.width + (x % p.width)) * 4;
    out.data[o] = p.data[q]; out.data[o + 1] = p.data[q + 1]; out.data[o + 2] = p.data[q + 2]; out.data[o + 3] = 255;
  }
  return out;
}

/**
 * The whole path. src: the photo's pixels. o: { corners (4 points in src pixels), mode: "across" | "tile",
 * acrossMm (what the crop measures across), upMm (and up, if known), tileW, tileH (one tile, mm), size (output pixels, default 1024),
 * rough (base roughness), strength (relief), lighting: true (remove uneven light) }.
 * Returns { color, normal, rough, ao, sizeM: [across, up] in metres for one repeat, tiles: [n across, n up] or null,
 * checks: { deltaE, seam, lightBefore, lightAfter, periodPx } }.
 */
export function photoToMaterial(src, o) {
  const N = o.size || 1024, q = quadSize(o.corners);
  // straighten the crop at about its own resolution
  const cw = Math.max(16, Math.min(2048, Math.round(q.w))), ch = Math.max(16, Math.min(2048, Math.round(q.h)));
  let crop = warp(src, o.corners, cw, ch);
  const original = crop;
  const lit = o.lighting === false ? crop : delight(crop);
  let sizeM, tiles = null, periodPx = null, work = lit;
  if (o.mode === "tile" && o.tileW > 0 && o.tileH > 0) {
    // the repeat in the photo: as many whole tiles as fit, so it repeats exactly at the tile joints
    const px = period(lit, "x", { min: Math.max(6, cw / 40) }), py = period(lit, "y", { min: Math.max(6, ch / 40) });
    const expX = cw / Math.max(1, Math.round(cw / (px || cw))), expY = ch / Math.max(1, Math.round(ch / (py || ch)));
    const nx = Math.max(1, Math.round(cw / (px || expX))), ny = Math.max(1, Math.round(ch / (py || expY)));
    periodPx = [px, py];
    const wx = Math.min(cw, Math.round((px || cw / nx) * nx)), wy = Math.min(ch, Math.round((py || ch / ny) * ny));
    work = warp(lit, [[0, 0], [wx, 0], [wx, wy], [0, wy]], wx, wy);
    tiles = [nx, ny];
    sizeM = [nx * o.tileW / 1000, ny * o.tileH / 1000];
  } else {
    const across = (o.acrossMm || 1000) / 1000;
    sizeM = [across, o.upMm > 0 ? o.upMm / 1000 : across * ch / cw];   // without the height, from the crop's proportions
  }
  // square output (the repeat's proportions are kept in sizeM), then made to repeat with no joins
  let color = resize(work, N, N);
  color = seamless(color, { band: o.mode === "tile" ? 0.06 : 0.22 });
  const m = maps(color, { strength: o.strength ?? 2.5, rough: o.rough ?? 0.6 });
  return { color, ...m, sizeM, tiles, original,
    checks: { deltaE: deltaE(original, color), seam: seamScore(color), lightBefore: lightGradient(original), lightAfter: lightGradient(color), periodPx } };
}
