// Phase 4 unit tests: doors and windows cut their walls exactly and refuse to go where they do not fit.
import test from "node:test";
import assert from "node:assert/strict";
import * as G from "../../web/assets/sketch/geom.js";
import { newProject } from "../../web/assets/sketch/model.js";
import { makeWall, wallFootprints } from "../../web/assets/sketch/walls.js";
import * as O from "../../web/assets/sketch/openings.js";

const near = (a, b, tol = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} != ${b}`);
function setup(len = 5000) {
  const d = newProject();
  const w = makeWall(d, { a: G.P(0, 0), b: G.P(len, 0), typeId: "wt-ext225", baseLevelId: "lv-1", unconnectedHeight: 3000 });
  d.walls.push(w);
  return { d, w };
}

test("a 900 x 2100 door removes exactly 0.9 x 2.1 x thickness of wall", () => {
  const { d, w } = setup();
  const before = O.solidsVolume(O.wallSolids(d, w, wallFootprints(d, "lv-1").get(w.id)));
  near(before, 5000 * 255 * 3000, 1e-3, "wall volume");
  d.openings.push(O.makeOpening(d, "door", "dt-900", w.id, 2500));
  const after = O.solidsVolume(O.wallSolids(d, w, wallFootprints(d, "lv-1").get(w.id)));
  near(before - after, 900 * 2100 * 255, 1e-3, "door volume");
});

test("a 1200 x 1200 window on a 900 sill removes exactly its size, leaving wall below and above", () => {
  const { d, w } = setup();
  const fp = () => wallFootprints(d, "lv-1").get(w.id);
  const before = O.solidsVolume(O.wallSolids(d, w, fp()));
  d.openings.push(O.makeOpening(d, "window", "wn-1200", w.id, 1500));
  const solids = O.wallSolids(d, w, fp());
  near(before - O.solidsVolume(solids), 1200 * 1200 * 255, 1e-3, "window volume");
  assert.ok(solids.some(s => s.z1 === 900) && solids.some(s => s.z0 === 2100), "wall below the sill and above the head");
});

test("plan: a door at the cut plane leaves a gap; a high window above the cut plane does not", () => {
  const { d, w } = setup();
  d.openings.push(O.makeOpening(d, "door", "dt-900", w.id, 1000));
  d.openings.push(O.makeOpening(d, "window", "wn-600", w.id, 4000)); // toilet window on a 1500 sill
  const pieces = O.wallPlanPieces(d, w, wallFootprints(d, "lv-1").get(w.id), 1200);
  const area = pieces.reduce((s, p) => s + Math.abs(G.polygonArea(p)), 0);
  near(area, (5000 - 900) * 255, 1e-3, "plan area with one gap");
  assert.equal(pieces.length, 2);
});

test("openings that do not fit are refused with a reason", () => {
  const { d, w } = setup();
  const door = O.makeOpening(d, "door", "dt-900", w.id, 300); // 450 past the start
  assert.throws(() => O.checkOpening(d, door), /does not fit within the wall's length/);
  const garage = O.makeOpening(d, "door", "dt-garage", w.id, 2500);
  w.unconnectedHeight = 2300;
  assert.throws(() => O.checkOpening(d, garage), /taller than the wall/);
  w.unconnectedHeight = 3000;
  const a = O.makeOpening(d, "window", "wn-1200", w.id, 2000), b = O.makeOpening(d, "window", "wn-1200", w.id, 2600);
  d.openings.push(a);
  assert.throws(() => O.checkOpening(d, b), /overlaps another opening/);
  b.sillHeight = 2200; b.positionAlongWall = 2600;
  w.unconnectedHeight = 4000;
  assert.doesNotThrow(() => O.checkOpening(d, b), "stacked above, no overlap in height");
});

test("stretching a wall at its start keeps its door where it was", () => {
  const { d, w } = setup();
  const o = O.makeOpening(d, "door", "dt-900", w.id, 2000);
  d.openings.push(o);
  const before = new Map([[w.id, { a: { ...w.a }, b: { ...w.b } }]]);
  w.a = G.P(-1000, 0);
  O.keepOpeningsInPlace(d, before);
  near(o.positionAlongWall, 3000, 1e-9);
  const f = O.openingFrame(d, o);
  near(f.mid.x, 2000, 1e-9, "same place in space");
  // moving the whole wall moves the door with it
  const before2 = new Map([[w.id, { a: { ...w.a }, b: { ...w.b } }]]);
  w.a = G.add(w.a, G.P(0, 500)); w.b = G.add(w.b, G.P(0, 500));
  O.keepOpeningsInPlace(d, before2);
  near(o.positionAlongWall, 3000, 1e-9);
});

test("type marks: D1… for doors and W1… for windows", () => {
  const { d, w } = setup();
  assert.equal(O.typeMark(d, O.makeOpening(d, "door", "dt-900", w.id, 2000)), "D1");
  assert.equal(O.typeMark(d, O.makeOpening(d, "door", "dt-1200", w.id, 2000)), "D3");
  assert.equal(O.typeMark(d, O.makeOpening(d, "window", "wn-1500", w.id, 2000)), "W3");
});
