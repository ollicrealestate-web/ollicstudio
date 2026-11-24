// Complete my design makes the model ready by itself: outer walls that stop short, run past a corner, sit on a face
// line or leave a gap are joined into closed loops; a missing upper floor is added; doors and windows stay where they
// were; and it is one step that Undo takes back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testBox } from "./testbox.mjs";
import { History } from "../../web/assets/sketch/history.js";
import { readiness } from "../../web/assets/sketch/summary.js";
import { prepareModel } from "../../web/assets/sketch/autofix.js";
import { openingFrame } from "../../web/assets/sketch/openings.js";
import * as G from "../../web/assets/sketch/geom.js";

const wall = (doc, id) => doc.walls.find(w => w.id === id);
const mids = doc => doc.openings.map(o => openingFrame(doc, o)?.mid).filter(Boolean);

test("an untouched model is left alone", () => {
  const h = new History(testBox());
  const r = prepareModel(h);
  assert.deepEqual(r, { done: [], issues: [] });
  assert.equal(h.undoStack.length, 0);
});

test("ends short of a corner, past a corner, and a missing wall are all closed; openings stay put; undo restores", () => {
  const doc = testBox(), h = new History(doc);
  // Level 1: the west wall stops 400 mm short of the north-west corner; the north wall runs 600 mm past the north-east
  wall(doc, "W1").b = G.P(0, 7600);
  wall(doc, "N1").b = G.P(10600, 8000);
  // the south wall (with the door and windows) stops 300 mm short at its start (x = 10000 end)
  wall(doc, "S1").a = G.P(9700, 0);
  // Level 2: the east wall is missing altogether, and level 2 has no floor
  doc.walls = doc.walls.filter(w => w.id !== "E2");
  doc.floors = doc.floors.filter(f => f.levelId !== "lv-2");
  assert.ok(readiness(doc).length >= 2, readiness(doc).join(" | "));
  const openings = mids(doc);   // where the doors and windows are in the broken model
  const r = prepareModel(h);
  assert.deepEqual(r.issues, [], r.issues.join(" | "));
  assert.ok(r.done.some(t => /joined/.test(t)) && r.done.some(t => /added a 8\.00 m outer wall/.test(t)) && r.done.some(t => /floor on Level 2/.test(t)), r.done.join(" | "));
  assert.deepEqual(wall(doc, "W1").b, { x: 0, y: 8000 });
  assert.deepEqual(wall(doc, "N1").b, { x: 10000, y: 8000 });
  assert.deepEqual(wall(doc, "S1").a, { x: 10000, y: 0 });
  // the openings on the south wall did not move (the wall's start moved, their positions were kept in space)
  mids(doc).forEach((p, i) => assert.ok(G.dist(p, openings[i]) < 0.5, `opening ${i} moved ${G.dist(p, openings[i]).toFixed(1)} mm`));
  assert.equal(h.undoStack.length, 1);
  h.undo();
  // undo brings back the broken model exactly as it was before the fix (not the original box)
  assert.equal(wall(doc, "W1").b.y, 7600);
  assert.ok(!doc.walls.some(w => w.id === "E2"));
});

test("an outer wall drawn on its exterior face is joined at the true corner", () => {
  const doc = testBox(), h = new History(doc);
  const w = wall(doc, "N1");
  // the same wall, located by its exterior face (127.5 mm north of the centre), and stopping 250 mm short
  w.locationLine = "finish-ext"; w.a = G.P(0, 8127.5); w.b = G.P(9750, 8127.5);
  const r = prepareModel(h);
  assert.deepEqual(r.issues, [], r.issues.join(" | "));
  assert.equal(w.locationLine, "wall-centre");
  assert.ok(G.dist(w.b, { x: 10000, y: 8000 }) < 0.5 && G.dist(w.a, { x: 0, y: 8000 }) < 0.5, JSON.stringify(w));
});

test("an empty sketch still asks for walls (nothing to start from)", () => {
  const doc = testBox(); doc.walls = []; doc.floors = []; doc.roofs = []; doc.openings = [];
  const r = prepareModel(new History(doc));
  assert.ok(r.issues.some(t => /no outer/.test(t)));
});
