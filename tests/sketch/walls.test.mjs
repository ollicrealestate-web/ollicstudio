// Phase 2 unit tests: wall joins (L, T, X with 225 and 150 walls), location lines, heights.
import test from "node:test";
import assert from "node:assert/strict";
import * as G from "../../web/assets/sketch/geom.js";
import { newProject } from "../../web/assets/sketch/model.js";
import { makeWall, wallFootprints, centrePolyline, wallType, outlineEdges, wallHeights, checkWall } from "../../web/assets/sketch/walls.js";

const near = (a, b, tol = 1e-6, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ? msg + ": " : ""}${a} != ${b}`);

function project() {
  const d = newProject();
  d.wallTypes.push({ id: "t225", name: "225", thickness: 225, core: 225, function: "exterior" }, { id: "t150", name: "150", thickness: 150, core: 150, function: "interior" });
  return d;
}
const W = (d, a, b, typeId, extra = {}) => { const w = makeWall(d, { a: G.P(...a), b: G.P(...b), typeId, baseLevelId: "lv-1", ...extra }); d.walls.push(w); return w; };

const R = (x0, y0, x1, y1) => p => p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1;
const anyOf = (...fs) => p => fs.some(f => f(p));

/** The pieces must tile the expected shape exactly: total area equal, and every sample point inside
 *  the expected shape covered once, every point outside it not covered (no gaps, no overlaps, no spill). */
function checkTiling(fp, expectedArea, box, region) {
  const polys = [...fp.values()].flatMap(f => f.pieces);
  const total = polys.reduce((s, p) => s + Math.abs(G.polygonArea(p)), 0);
  near(total, expectedArea, 1e-3, "total area");
  let bad = [];
  const step = 7.3; // mm, off-grid so samples never sit on an edge
  for (let x = box.x0 + 1.1; x < box.x1; x += step) for (let y = box.y0 + 1.3; y < box.y1; y += step) {
    const p = { x, y }, n = polys.filter(q => G.pointInPolygon(p, q)).length, want = region(p) ? 1 : 0;
    if (n !== want) bad.push(`(${x.toFixed(1)}, ${y.toFixed(1)}) covered ${n}x, expected ${want}`);
  }
  assert.equal(bad.length, 0, bad.slice(0, 5).join("; "));
}

test("L join, 225 + 150: mitred to the outer corner with no gap or overlap", () => {
  const d = project();
  W(d, [0, 0], [5000, 0], "t225");
  W(d, [0, 0], [0, 4000], "t150");
  const fp = wallFootprints(d, "lv-1");
  // union: 225 wall from the 150 wall's outer face (-75) to 5000; 150 wall from the 225 wall's outer face (-112.5) to 4000
  const expected = 5075 * 225 + 150 * (4000 - 112.5);
  checkTiling(fp, expected, { x0: -200, y0: -200, x1: 5100, y1: 4100 }, anyOf(R(-75, -112.5, 5000, 112.5), R(-75, -112.5, 75, 4000)));
  const pts = [...fp.values()].flatMap(f => f.pieces.flat());
  assert.ok(pts.some(p => Math.abs(p.x + 75) < 1e-6 && Math.abs(p.y + 112.5) < 1e-6), "outer corner at (-75, -112.5)");
  assert.ok(pts.some(p => Math.abs(p.x - 75) < 1e-6 && Math.abs(p.y - 112.5) < 1e-6), "inner corner at (75, 112.5)");
});

test("T join, 225 through, 150 stops: trimmed to the face, outline has no line across the junction", () => {
  const d = project();
  const a = W(d, [0, 0], [8000, 0], "t225");
  W(d, [4000, 0], [4000, 3000], "t150");
  const fp = wallFootprints(d, "lv-1");
  checkTiling(fp, 8000 * 225 + 150 * (3000 - 112.5), { x0: -50, y0: -200, x1: 8050, y1: 3100 }, anyOf(R(0, -112.5, 8000, 112.5), R(3925, 112.5, 4075, 3000)));
  assert.equal(fp.get(a.id).pieces.length, 1, "the through wall is not cut");
  const edges = outlineEdges([...fp.values()].flatMap(f => f.pieces));
  const across = edges.filter(([p, q]) => Math.abs(p.y - 112.5) < 1e-6 && Math.abs(q.y - 112.5) < 1e-6 && Math.min(p.x, q.x) >= 3925 - 1e-6 && Math.max(p.x, q.x) <= 4075 + 1e-6);
  assert.equal(across.length, 0, "no outline across the T");
  // the face of the 225 wall is drawn either side of the junction
  assert.ok(edges.some(([p, q]) => Math.abs(p.y - 112.5) < 1e-6 && Math.abs(q.y - 112.5) < 1e-6 && Math.max(p.x, q.x) <= 3925 + 1e-6));
});

test("X join, 225 and 150 crossing: the 150 wall is cut, the 225 wall continues", () => {
  const d = project();
  const a = W(d, [0, 0], [8000, 0], "t225");
  const b = W(d, [4000, -3000], [4000, 3000], "t150");
  const fp = wallFootprints(d, "lv-1");
  assert.equal(fp.get(a.id).pieces.length, 1);
  assert.equal(fp.get(b.id).pieces.length, 2);
  checkTiling(fp, 8000 * 225 + 150 * (6000 - 225), { x0: -50, y0: -3050, x1: 8050, y1: 3050 }, anyOf(R(0, -112.5, 8000, 112.5), R(3925, -3000, 4075, 3000)));
});

test("closed rectangle of exterior walls drawn clockwise by exterior finish face", () => {
  const d = project();
  const c = [[0, 0], [0, 8000], [10000, 8000], [10000, 0]]; // clockwise: exterior on the left = outside
  for (let i = 0; i < 4; i++) W(d, c[i], c[(i + 1) % 4], "wt-ext225", { locationLine: "finish-ext" });
  const fp = wallFootprints(d, "lv-1");
  const t = 255;
  // outer faces on the drawn lines, so the walls fill the band between the 10 x 8 m outline and the inner rectangle
  checkTiling(fp, 10000 * 8000 - (10000 - 2 * t) * (8000 - 2 * t), { x0: -50, y0: -50, x1: 10050, y1: 8050 }, p => R(0, 0, 10000, 8000)(p) && !R(t, t, 10000 - t, 8000 - t)(p));
  const xs = [...fp.values()].flatMap(f => f.pieces.flat()).map(p => p.x);
  near(Math.min(...xs), 0, 1e-6); near(Math.max(...xs), 10000, 1e-6);
});

test("location line: changing thickness keeps the chosen face on the line", () => {
  const d = project();
  const w = W(d, [0, 0], [5000, 0], "t150", { locationLine: "finish-int" });
  // exterior is on the left (+y); interior finish face on the line means the wall extends to +y
  near(centrePolyline(w, wallType(d, w))[0].y, 75);
  w.typeId = "t225";
  near(centrePolyline(w, wallType(d, w))[0].y, 112.5);
  w.flipped = true;
  near(centrePolyline(w, wallType(d, w))[0].y, -112.5);
});

test("three walls meeting at one point tile around a shared hub", () => {
  const d = project();
  W(d, [0, 0], [4000, 0], "t225");
  W(d, [0, 0], [-4000, 0], "t225");
  W(d, [0, 0], [0, 3000], "t150");
  const fp = wallFootprints(d, "lv-1");
  checkTiling(fp, 8000 * 225 + 150 * (3000 - 112.5), { x0: -4050, y0: -200, x1: 4050, y1: 3100 }, anyOf(R(-4000, -112.5, 4000, 112.5), R(-75, 112.5, 75, 3000)));
});

test("heights: unconnected, up to a level with offset, and the 40 m limit", () => {
  const d = project();
  d.levels.push({ id: "lv-2", name: "Level 2", elevation: 3000 });
  const w = W(d, [0, 0], [5000, 0], "t225", { unconnectedHeight: 2700 });
  assert.deepEqual(wallHeights(d, w), { z0: 0, z1: 2700 });
  w.topLevelId = "lv-2"; w.topOffset = -150;
  assert.deepEqual(wallHeights(d, w), { z0: 0, z1: 2850 });
  w.topLevelId = null; w.unconnectedHeight = 41000;
  assert.throws(() => checkWall(d, w), /40 m/);
  w.unconnectedHeight = 3000; w.baseOffset = 0;
  w.topLevelId = "lv-2"; w.topOffset = -3500;
  assert.throws(() => checkWall(d, w), /top must be above/);
});

test("arc wall joins a straight wall cleanly", () => {
  const d = project();
  W(d, [0, 0], [5000, 0], "t225");
  const arc = makeWall(d, { shape: "arc", c: G.P(5000, 2000), r: 2000, start: -Math.PI / 2, sweep: Math.PI, typeId: "t225", baseLevelId: "lv-1" });
  d.walls.push(arc);
  const fp = wallFootprints(d, "lv-1");
  const polys = [...fp.values()].flatMap(f => f.pieces);
  const expected = 5000 * 225 + Math.PI * ((2000 + 112.5) ** 2 - (2000 - 112.5) ** 2) / 2;
  const total = polys.reduce((s, p) => s + Math.abs(G.polygonArea(p)), 0);
  near(total, expected, expected * 0.002, "area within 0.2 %");
});
