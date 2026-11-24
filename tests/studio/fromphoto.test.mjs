// A material from a photo, checked with a test photo whose truth is known: a grid of 300 x 300 mm tiles (6 across,
// 5 up, dark grout) photographed at an angle, with light falling off strongly from one side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { photoToMaterial, period, tiled, seamScore, deltaE, lightGradient, warp } from "../../web/assets/materials/fromphoto.js";

const W = 1200, H = 900, CORNERS = [[150, 120], [1050, 200], [1000, 820], [180, 760]];   // the tiled area in the photo
const TILES = [6, 5], TILE_MM = 300, GROUT = 0.035;   // grout as a fraction of a tile
// the inverse of the square-to-corners mapping, to know which point of the tiled surface each photo pixel shows
function inverse(c) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = c;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3, den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, cc = x0, d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  // 3x3 [a b c; d e f; g h 1] inverted
  const A = e - f * h, B = cc * h - b, C = b * f - cc * e, D = f * g - d, E = a - cc * g, F = cc * d - a * f, G = d * h - e * g, Hh = b * g - a * h, I = a * e - b * d;
  return (x, y) => { const w = G * x + Hh * y + I; return [(A * x + B * y + C) / w, (D * x + E * y + F) / w]; };
}
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function testPhoto() {
  const data = new Uint8ClampedArray(W * H * 4), inv = inverse(CORNERS), noise = Float32Array.from({ length: 400 * 400 }, rnd);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [u, v] = inv(x + 0.5, y + 0.5), o = (y * W + x) * 4;
    let col;
    if (u < 0 || u > 1 || v < 0 || v > 1) col = [60, 58, 55];
    else {
      const tu = u * TILES[0], tv = v * TILES[1], fu = tu - Math.floor(tu), fv = tv - Math.floor(tv);
      const grout = fu < GROUT / 2 || fu > 1 - GROUT / 2 || fv < GROUT / 2 || fv > 1 - GROUT / 2;
      const n = noise[Math.min(399, Math.floor(u * 400)) * 400 + Math.min(399, Math.floor(v * 400))] * 14 - 7;   // the stone's speckle
      col = grout ? [95, 90, 84] : [214 + n, 200 + n, 178 + n];
    }
    const light = 0.55 + 0.6 * (x / W) * (0.85 + 0.15 * y / H);   // brighter to the right
    for (let k = 0; k < 3; k++) data[o + k] = col[k] * light;
    data[o + 3] = 255;
  }
  return { data, width: W, height: H };
}

const photo = testPhoto();
const out = photoToMaterial(photo, { corners: CORNERS, mode: "tile", tileW: TILE_MM, tileH: TILE_MM, size: 768 });

test("finds whole tiles: 6 across and 5 up, so it repeats at the joints", () => {
  assert.deepEqual(out.tiles, TILES);
  assert.deepEqual(out.sizeM.map(v => +v.toFixed(3)), [1.8, 1.5]);
});
test("the pattern's period matches the given tile size within 2%", () => {
  const px = period(out.color, "x"), py = period(out.color, "y");
  const mmX = px / out.color.width * out.sizeM[0] * 1000, mmY = py / out.color.height * out.sizeM[1] * 1000;
  assert.ok(Math.abs(mmX - TILE_MM) / TILE_MM < 0.02, `across: ${mmX.toFixed(1)} mm`);
  assert.ok(Math.abs(mmY - TILE_MM) / TILE_MM < 0.02, `up: ${mmY.toFixed(1)} mm`);
});
test("repeats with no visible join (3 x 3)", () => {
  const s = seamScore(out.color);
  assert.ok(s < 2, `join ${s.toFixed(2)} times an ordinary step`);
  const nine = tiled(out.color, 3);
  assert.equal(nine.width, out.color.width * 3);
});
test("the light falling across the photo is gone", () => {
  assert.ok(out.checks.lightBefore > 25, `the test photo has uneven light (${out.checks.lightBefore.toFixed(0)}%)`);
  assert.ok(out.checks.lightAfter < 3, `after: ${out.checks.lightAfter.toFixed(1)}%`);
});
test("the same colour as the cropped photo: average difference under 5 (ΔE)", () => {
  assert.ok(out.checks.deltaE < 5, `ΔE ${out.checks.deltaE.toFixed(2)}`);
  const straight = warp(photo, CORNERS, 600, 500);
  assert.ok(deltaE(straight, out.color) < 5);
});
test("the relief map is sensible: mostly facing out, with relief at the grout", () => {
  const d = out.normal.data; let z = 0, flat = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { z += d[i + 2]; if (Math.abs(d[i] - 128) < 6 && Math.abs(d[i + 1] - 128) < 6) flat++; n++; }
  assert.ok(z / n > 230, `mean blue ${(z / n).toFixed(0)}`);
  assert.ok(flat / n > 0.4 && flat / n < 0.995, `flat share ${(flat / n).toFixed(3)}`);
});
test("a photo measured across (no tiles) keeps its proportions", () => {
  const o = photoToMaterial(photo, { corners: CORNERS, mode: "across", acrossMm: 1800, upMm: 1500, size: 256 });
  assert.deepEqual(o.sizeM, [1.8, 1.5]);
  assert.ok(seamScore(o.color) < 2);
  assert.ok(o.checks.deltaE < 5);
  void lightGradient;
});
