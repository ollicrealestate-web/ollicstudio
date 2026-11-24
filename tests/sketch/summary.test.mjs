// The model summary Ollic AI reads, and the readiness check before it starts.
import test from "node:test";
import assert from "node:assert/strict";
import { modelSummary, readiness, compass } from "../../web/assets/sketch/summary.js";
import { newProject } from "../../web/assets/sketch/model.js";
import { testBox } from "./testbox.mjs";

test("compass directions (plan +y is north)", () => {
  assert.equal(compass({ x: 0, y: 1 }), "N"); assert.equal(compass({ x: 0, y: -1 }), "S"); assert.equal(compass({ x: 1, y: 0 }), "E"); assert.equal(compass({ x: -1, y: -1 }), "SW");
});

test("summary of the test box: levels, walls facing out, openings, floors with balcony edges, flat roof", () => {
  const s = modelSummary(testBox());
  assert.deepEqual(s.levels.map(l => [l.id, l.elevation, l.height_to_next]), [["lv-1", 0, 3000], ["lv-2", 3000, null]]);
  assert.equal(s.walls.length, 8);
  assert.deepEqual(Object.fromEntries(s.walls.filter(w => w.level === "lv-1").map(w => [w.id, w.outer_face_faces])), { W1: "W", N1: "N", E1: "E", S1: "S" });
  const s1 = s.walls.find(w => w.id === "S1"); assert.equal(s1.thickness, 255); assert.equal(s1.length, 10000); assert.equal(s1.top, 3000); assert.deepEqual(s1.openings, ["D1", "WS1a", "WS1b"]);
  const d1 = s.openings.find(o => o.id === "D1"); assert.deepEqual([d1.kind, d1.width, d1.height, d1.sill, d1.head, d1.faces, d1.from_along_wall, d1.to_along_wall], ["door", 900, 2100, 0, 2100, "S", 4550, 5450]);
  const f2 = s.floors.find(f => f.id === "F2");
  assert.deepEqual(f2.edges.filter(e => !e.wall_on_or_under).map(e => [e.ref, e.faces, e.length]), [["F2:e2", "W", 1500], ["F2:e3", "S", 4000], ["F2:e4", "E", 1500]]);
  const r = s.roofs[0]; assert.equal(r.shape, "flat"); assert.deepEqual(r.overhangs, [600, 600, 600, 600]); assert.equal(r.top, 6200); assert.equal(r.edges.length, 4);
});

test("scope cuts the summary down to chosen levels or elements", () => {
  const s = modelSummary(testBox(), { levels: ["lv-2"] });
  assert.ok(s.walls.every(w => w.level === "lv-2")); assert.deepEqual(s.floors.map(f => f.id), ["F2"]);
  const t = modelSummary(testBox(), { ids: ["S2"] });
  assert.deepEqual(t.walls.map(w => w.id), ["S2"]); assert.deepEqual(t.openings.map(o => o.id).sort(), ["D2", "WS2a", "WS2b"]);
});

test("readiness says exactly what is missing, in plain words", () => {
  assert.deepEqual(readiness(testBox()), []);
  const empty = newProject(); assert.match(readiness(empty).join(" "), /no outer \(exterior\) walls/);
  const d = testBox(); d.floors = d.floors.filter(f => f.id !== "F2");
  assert.ok(readiness(d).includes("Level 2 has no floor yet."));
  const o = testBox(); o.walls = o.walls.filter(w => w.id !== "N1");
  assert.ok(readiness(o).includes("The outer walls on Level 1 do not close into a loop yet."));
});
