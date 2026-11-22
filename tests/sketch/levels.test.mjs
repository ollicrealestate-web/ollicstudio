// Phase 2 unit tests: levels (10 at most, nothing above 40 m), heights moving the levels above.
import test from "node:test";
import assert from "node:assert/strict";
import { newProject } from "../../web/assets/sketch/model.js";
import { History } from "../../web/assets/sketch/history.js";
import * as LV from "../../web/assets/sketch/levels.js";
import { makeWall } from "../../web/assets/sketch/walls.js";

test("levels: add up to 10, refuse an 11th", () => {
  const d = newProject();
  for (let i = 0; i < 9; i++) LV.addLevelAbove(d, 3000);
  assert.equal(d.levels.length, 10);
  assert.equal(LV.sorted(d).at(-1).elevation, 27000);
  assert.equal(LV.sorted(d).at(-1).name, "Level 10");
  assert.throws(() => LV.addLevelAbove(d, 3000), /up to 10 levels/);
});

test("levels: nothing above 40 m, and a refused change leaves the model as it was", () => {
  const h = new History(newProject());
  h.transact("Levels", d => { for (let i = 0; i < 8; i++) LV.addLevelAbove(d, 4500); }); // top at +36.000
  const before = JSON.stringify(h.doc);
  assert.throws(() => h.transact("Too high", d => LV.addLevelAbove(d, 4500)), /40 m/);
  assert.equal(JSON.stringify(h.doc), before);
  const l1 = LV.sorted(h.doc)[0];
  assert.throws(() => h.transact("Taller", d => LV.setHeightAbove(d, l1.id, 9000)), /40 m/); // pushes the top to +40.500
  assert.equal(JSON.stringify(h.doc), before);
});

test("levels: a wall reaching past 40 m is refused too", () => {
  const d = newProject();
  for (let i = 0; i < 9; i++) LV.addLevelAbove(d, 4000); // top level +36.000
  const top = LV.sorted(d).at(-1);
  d.walls.push(makeWall(d, { a: { x: 0, y: 0 }, b: { x: 1000, y: 0 }, baseLevelId: top.id, unconnectedHeight: 3000 }));
  assert.doesNotThrow(() => LV.checkLevels(d));
  d.walls[0].unconnectedHeight = 4100;
  assert.throws(() => LV.checkLevels(d), /40 m/);
});

test("changing a floor-to-floor height moves every level above it", () => {
  const d = newProject();
  LV.addLevelAbove(d); LV.addLevelAbove(d); LV.addLevelAbove(d);
  const [l1, l2, l3, l4] = LV.sorted(d);
  LV.setHeightAbove(d, l2.id, 3600);
  assert.deepEqual(LV.sorted(d).map(l => l.elevation), [0, 3000, 6600, 9600]);
  assert.equal(LV.heightAbove(d, l2.id), 3600);
  LV.setElevation(d, l3.id, 7000);
  assert.deepEqual(LV.sorted(d).map(l => l.elevation), [0, 3000, 7000, 10000]);
  assert.throws(() => LV.setElevation(d, l2.id, -500), /at least 1000 mm above/);
  assert.equal(l4.name, "Level 4");
});

test("deleting a level removes what sits on it; walls that went up to it keep their height", () => {
  const d = newProject();
  const l2 = LV.addLevelAbove(d, 3000);
  const a = makeWall(d, { a: { x: 0, y: 0 }, b: { x: 4000, y: 0 }, baseLevelId: "lv-1", topLevelId: l2.id, topOffset: -150 });
  const b = makeWall(d, { a: { x: 0, y: 0 }, b: { x: 4000, y: 0 }, baseLevelId: l2.id });
  d.walls.push(a, b);
  assert.deepEqual(LV.elementsOn(d, l2.id), { walls: 1, lines: 0, floors: 0, topped: 1 });
  LV.deleteLevel(d, l2.id);
  assert.equal(d.walls.length, 1);
  assert.equal(d.walls[0].topLevelId, null);
  assert.equal(d.walls[0].unconnectedHeight, 2850);
  assert.throws(() => LV.deleteLevel(d, "lv-1"), /at least one level/);
});

test("level names must be unique and not empty", () => {
  const d = newProject();
  const l2 = LV.addLevelAbove(d);
  assert.throws(() => LV.rename(d, l2.id, "Level 1"), /two levels called/);
  assert.throws(() => LV.rename(d, l2.id, "   "), /needs a name/);
  LV.rename(d, l2.id, "First floor");
  assert.equal(l2.name, "First floor");
});
