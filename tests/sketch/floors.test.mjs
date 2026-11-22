// Phase 5 unit tests: the floor sketch checker, holes, Pick Walls with auto-trim, and walls attached under a floor.
import test from "node:test";
import assert from "node:assert/strict";
import * as G from "../../web/assets/sketch/geom.js";
import { newProject } from "../../web/assets/sketch/model.js";
import { makeWall, wallHeights } from "../../web/assets/sketch/walls.js";
import * as F from "../../web/assets/sketch/floors.js";

const near = (a, b, tol = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} != ${b}`);
const L = (a, b) => ({ shape: "line", a: G.P(...a), b: G.P(...b) });
const rect = (x0, y0, x1, y1) => [L([x0, y0], [x1, y0]), L([x1, y0], [x1, y1]), L([x1, y1], [x0, y1]), L([x0, y1], [x0, y0])];

test("a closed rectangle passes and gives one loop of 80 m²", () => {
  const r = F.checkSketch(rect(0, 0, 10000, 8000));
  assert.equal(r.ok, true);
  near(F.floorArea(F.floorParts(r.loops)), 80e6);
});

test("open loops are refused and the open lines are highlighted", () => {
  const c = rect(0, 0, 10000, 8000);
  c[2] = L([10000, 8000], [500, 8000]); // stops short of the corner
  const r = F.checkSketch(c);
  assert.equal(r.ok, false);
  assert.match(r.message, /closed loops/);
  assert.deepEqual(r.bad.sort(), [2, 3]);
});

test("overlapping and crossing lines are refused", () => {
  const c = rect(0, 0, 10000, 8000);
  c.push(L([2000, 0], [6000, 0])); // on top of the bottom edge
  const r = F.checkSketch(c);
  assert.equal(r.ok, false); assert.match(r.message, /cross or overlap/);
  assert.ok(r.bad.includes(0) && r.bad.includes(4));
  const x = rect(0, 0, 10000, 8000);
  x[1] = L([10000, 0], [10000, 9000]); x.push(L([10000, 9000], [12000, 9000])); // a crossing tail
  x.push(L([9000, 7000], [11000, 8500]));
  assert.equal(F.checkSketch(x).ok, false);
});

test("an inner loop makes a hole (stair void); the area excludes it", () => {
  const r = F.checkSketch([...rect(0, 0, 10000, 8000), ...rect(4000, 3000, 6500, 4200)]);
  assert.equal(r.ok, true);
  const parts = F.floorParts(r.loops);
  assert.equal(parts.length, 1); assert.equal(parts[0].holes.length, 1);
  near(F.floorArea(parts), 80e6 - 2500 * 1200);
});

test("arcs and circles close loops too", () => {
  const r = F.checkSketch([L([0, 0], [4000, 0]), { shape: "arc", c: G.P(4000, 2000), r: 2000, start: -Math.PI / 2, sweep: Math.PI }, L([4000, 4000], [0, 4000]), L([0, 4000], [0, 0])]);
  assert.equal(r.ok, true);
  near(F.floorArea(F.floorParts(r.loops)), 16e6 + Math.PI * 2000 ** 2 / 2, 16e6 * 0.002);
  assert.equal(F.checkSketch([{ shape: "arc", c: G.P(0, 0), r: 3000, start: 0, sweep: G.TAU }]).ok, true);
});

test("Pick Walls on a rectangle of walls gives a closed loop on their inner faces", () => {
  const d = newProject();
  const c = [[0, 0], [0, 8000], [10000, 8000], [10000, 0]];
  const ws = c.map((p, i) => { const w = makeWall(d, { a: G.P(...p), b: G.P(...c[(i + 1) % 4]), typeId: "wt-ext225", baseLevelId: "lv-1" }); d.walls.push(w); return w; });
  const curves = [];
  for (const w of ws) { curves.push(F.boundaryFromWall(d, w, G.P(5000, 4000))); F.autoTrim(curves, curves.length - 1, 600); }
  const r = F.checkSketch(curves);
  assert.equal(r.ok, true, r.message);
  near(F.floorArea(F.floorParts(r.loops)), (10000 - 255) * (8000 - 255), 1e-3); // inner faces, 127.5 in from each centreline
  // Extend into wall (to core): 112.5 in from each centreline
  const core = [];
  for (const w of ws) { core.push(F.boundaryFromWall(d, w, G.P(5000, 4000), { extendToCore: true })); F.autoTrim(core, core.length - 1, 600); }
  near(F.floorArea(F.floorParts(F.checkSketch(core).loops)), (10000 - 225) * (8000 - 225), 1e-3);
});

test("walls attached to a floor stop at its underside", () => {
  const d = newProject();
  d.levels.push({ id: "lv-2", name: "Level 2", elevation: 3000 });
  const floor = F.makeFloor(d, { levelId: "lv-2", typeId: "ft-rc150", heightOffset: 0, boundary: rect(0, 0, 10000, 8000) });
  d.floors.push(floor);
  const w = makeWall(d, { a: G.P(0, 0), b: G.P(5000, 0), baseLevelId: "lv-1", topLevelId: "lv-2" });
  d.walls.push(w);
  assert.equal(wallHeights(d, w).z1, 3000);
  w.attachTopTo = floor.id;
  assert.equal(wallHeights(d, w).z1, 2850);
  floor.heightOffset = 50;
  assert.equal(wallHeights(d, w).z1, 2900);
  assert.deepEqual(F.floorLevels(d, floor), { top: 3050, bottom: 2900 });
});
