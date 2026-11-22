// Phase 6 unit tests: cutting prisms (voids, reveals) and sweeps, exactly.
import test from "node:test";
import assert from "node:assert/strict";
import * as G from "../../web/assets/sketch/geom.js";
import * as S from "../../web/assets/sketch/solids.js";

const near = (a, b, tol = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} != ${b}`);
const rect = (x0, y0, x1, y1) => [G.P(x0, y0), G.P(x1, y0), G.P(x1, y1), G.P(x0, y1)];

test("subtracting a convex shape leaves exactly the difference, in pieces that do not overlap", () => {
  const pieces = S.subtractConvex(rect(0, 0, 4000, 3000), rect(1000, 1000, 2000, 2000));
  near(pieces.reduce((s, p) => s + Math.abs(G.polygonArea(p)), 0), 12e6 - 1e6, 1e-3);
  for (let x = 13; x < 4000; x += 97) for (let y = 17; y < 3000; y += 89) assert.ok(pieces.filter(p => G.pointInPolygon({ x, y }, p)).length <= 1);
});

test("subtracting an L-shaped (non-convex) profile is exact too", () => {
  const L = [G.P(500, 500), G.P(2500, 500), G.P(2500, 1000), G.P(1000, 1000), G.P(1000, 2500), G.P(500, 2500)];
  const pieces = S.subtractPolygon([rect(0, 0, 4000, 3000)], L);
  near(pieces.reduce((s, p) => s + Math.abs(G.polygonArea(p)), 0), 12e6 - Math.abs(G.polygonArea(L)), 1e-3);
});

test("a void extrusion through a wall removes exactly its volume", () => {
  const wall = [{ poly: rect(0, -112.5, 6000, 112.5), z0: 0, z1: 3000 }];
  const v = { polys: [rect(2000, -500, 3000, 500)], z0: 1000, z1: 2000 }; // a 1000 x 1000 hole right through
  near(S.prismVolume(wall) - S.prismVolume(S.applyVoids(wall, [v])), 1000 * 225 * 1000, 1e-3);
  const niche = { polys: [rect(4000, 0, 5000, 500)], z0: 0, z1: 3000 };             // half way into the wall
  near(S.prismVolume(wall) - S.prismVolume(S.applyVoids(wall, [niche])), 1000 * 112.5 * 3000, 1e-3);
});

test("a wall reveal cuts a band of the chosen depth into one face only", () => {
  const wall = [{ poly: rect(0, -112.5, 6000, 112.5), z0: 0, z1: 3000 }];
  const r = { origin: G.P(0, 0), n: G.P(0, -1), max: 112.5 - 20, z0: 900, z1: 1000 }; // 20 deep, 100 high, on the -y face
  near(S.prismVolume(wall) - S.prismVolume(S.applyReveal(wall, r)), 6000 * 20 * 100, 1e-3);
});

test("a sweep along a straight path has volume = profile area x length; corners are mitred", () => {
  const prof = [G.P(0, 0), G.P(300, 0), G.P(300, 75), G.P(0, 75)];
  near(S.sweepVolume([G.P(0, 0), G.P(5000, 0)], prof), 300 * 75 * 5000, 1e-6);
  // a closed 10 x 8 m loop, profile hanging outwards (x < 0 is to the right = outside for a ccw path)
  const loop = rect(0, 0, 10000, 8000);
  const out = [G.P(-300, 0), G.P(0, 0), G.P(0, 75), G.P(-300, 75)];
  near(S.sweepVolume(loop, out, true), 300 * 75 * (2 * (10300 + 8300)), 1e-3, "outer band = 4 mitred pieces");
  const rings = S.sweepRings(loop, 1000, out, true);
  near(rings[0][0].x, -300, 1e-9); near(rings[0][0].y, -300, 1e-9); near(rings[0][0].z, 1000, 1e-9); // mitred corner point
});

import { newProject } from "../../web/assets/sketch/model.js";
import { makeWall, wallFootprints } from "../../web/assets/sketch/walls.js";
import * as C from "../../web/assets/sketch/components.js";
import { wallSolids } from "../../web/assets/sketch/openings.js";

test("extrusion: a 2 x 1 m profile from 0 to 900 is a 1.8 m³ block; a hole comes out of it", () => {
  const d = newProject();
  const L = (a, b) => ({ shape: "line", a: G.P(...a), b: G.P(...b) });
  const box = [L([0, 0], [2000, 0]), L([2000, 0], [2000, 1000]), L([2000, 1000], [0, 1000]), L([0, 1000], [0, 0])];
  const hole = [L([500, 250], [1000, 250]), L([1000, 250], [1000, 750]), L([1000, 750], [500, 750]), L([500, 750], [500, 250])];
  const e = C.makeExtrusion(d, { levelId: "lv-1", start: 0, end: 900, boundary: [...box, ...hole] });
  near(S.prismVolume(C.extrusionPrisms(d, e)), (2000 * 1000 - 500 * 500) * 900, 1e-3);
});

test("wall sweep: a plinth band runs round a closed rectangle of walls on their outside, mitred", () => {
  const d = newProject();
  const c = [[0, 0], [0, 8000], [10000, 8000], [10000, 0]]; // clockwise: exterior on the left = outside
  const ws = c.map((p, i) => { const w = makeWall(d, { a: G.P(...p), b: G.P(...c[(i + 1) % 4]), typeId: "wt-ext225", baseLevelId: "lv-1" }); d.walls.push(w); return w; });
  const sw = C.makeWallSweep(d, { wallIds: ws.map(w => w.id), profileId: "pf-plinth" });
  const paths = C.wallSweepPaths(d, sw);
  assert.equal(paths.length, 1); assert.equal(paths[0].closed, true);
  const xs = paths[0].pts.map(p => p.x), ys = paths[0].pts.map(p => p.y);
  near(Math.min(...xs), -127.5, 1e-6); near(Math.max(...xs), 10127.5, 1e-6); near(Math.min(...ys), -127.5, 1e-6);
  const g = C.wallSweepGeometry(d, sw)[0];
  near(S.sweepVolume(g.pts, g.prof, true), 30 * 450 * 2 * ((10255 + 30) + (8255 + 30)), 1, "band volume on the outside");
});

test("wall reveal: a 20 x 50 groove 1200 above the base comes out of the exterior face only", () => {
  const d = newProject();
  const w = makeWall(d, { a: G.P(0, 0), b: G.P(6000, 0), typeId: "wt-ext225", baseLevelId: "lv-1" });
  d.walls.push(w);
  const fp = wallFootprints(d, "lv-1").get(w.id);
  const plain = S.prismVolume(wallSolids(d, w, fp));
  d.components.push(C.makeWallSweep(d, { wallIds: [w.id], reveal: true, profileId: "pf-rect", rectW: 20, rectH: 50, from: "base", distance: 1200 }));
  let solids = wallSolids(d, w, fp);
  for (const r of C.revealsFor(d, w)) solids = S.applyReveal(solids, r);
  near(plain - S.prismVolume(solids), 6000 * 20 * 50, 1e-3);
  const band = solids.find(s => s.z0 === 1200 && s.z1 === 1250);
  assert.ok(band && Math.max(...band.poly.map(p => p.y)) === 127.5 - 20, "cut on the exterior (left, +y) face");
});
