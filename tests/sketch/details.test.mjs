// Finishing commands on the test box: exact elements, sizes and IFC classes; locked elements; clash checks; undo.
import test from "node:test";
import assert from "node:assert/strict";
import { History } from "../../web/assets/sketch/history.js";
import { runTool, TOOLS, toolSchemas } from "../../web/assets/sketch/aitools.js";
import { buildDetail, detailIfc, detailParts } from "../../web/assets/sketch/details.js";
import { partBoxes } from "../../web/assets/sketch/checks.js";
import * as S from "../../web/assets/sketch/solids.js";
import { testBox } from "./testbox.mjs";

const AI = { source: "ai", session: "s1" };
const setup = () => { const doc = testBox(); return { doc, h: new History(doc) }; };
const ok = r => { assert.ok(r.ok, r.error); return r; };
const bad = (r, re) => { assert.equal(r.ok, false, "should be refused"); assert.match(r.error, re); return r; };
const range = (doc, id) => { const d = doc.details.find(x => x.id === id); const b = detailParts(doc, d).flatMap(partBoxes); return { z0: Math.min(...b.map(x => x.z0)), z1: Math.max(...b.map(x => x.z1)) }; };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test("every command has a JSON schema the assistant can use", () => {
  for (const t of toolSchemas()) { assert.equal(t.input_schema.type, "object"); assert.ok(t.description.length > 10, t.name); }
  for (const n of ["add_cladding", "add_wall_sweep", "add_edge_sweep", "add_extrusion", "add_void", "add_railing", "add_fins", "add_canopy", "add_pergola", "add_soffit", "add_parapet", "add_planter", "add_steps", "add_screen", "set_material", "edit_element", "delete_element", "get_element", "list_materials", "list_profiles"]) assert.ok(TOOLS.some(t => t.name === n), n);
});

test("cladding: 30 mm on the Level 1 south face, cut round the door, windows and the balcony slab", () => {
  const { doc, h } = setup();
  const r = ok(runTool(h, "add_cladding", { wall_ids: ["S1"], thickness: 30, material: "mt-travertine" }, AI));
  const d = doc.details.find(x => x.id === r.ids[0]);
  assert.equal(d.kind, "cladding"); assert.equal(d.source, "ai"); assert.deepEqual(detailIfc(d), ["IFCCOVERING", ".CLADDING."]);
  const vol = S.prismVolume(detailParts(doc, d));
  // 10 m x 3 m face, less door 900 x 2100, two windows 1200 x 1200, less where the 4 m balcony slab (150 deep) meets it
  near(vol / 30, 10000 * 3000 - 900 * 2100 - 2 * 1200 * 1200 - 4000 * 150, 2000, "clad area");
});

test("glass railing on the balcony's free edges: 1100 mm high, IfcRailing", () => {
  const { doc, h } = setup();
  const r = ok(runTool(h, "add_railing", { edges: ["F2:exposed"], type: "glass", height: 1100, material: "mt-steel-brushed" }, AI));
  const d = doc.details.at(-1);
  assert.deepEqual(detailIfc(d), ["IFCRAILING", ".GUARDRAIL."]);
  const { z0, z1 } = range(doc, r.ids[0]); near(z0, 3000, 0.5, "base on the slab"); near(z1, 4100, 0.5, "top");
  assert.equal(detailParts(doc, d).length, 6); // three runs: base shoe + glass each
});

test("roof finishes: curved fascia, soffit with light line, parapet", () => {
  const { doc, h } = setup();
  const f = ok(runTool(h, "add_edge_sweep", { edges: ["R1:all"], profile: "pf-fascia-curved", material: "mt-paint-white" }, AI));
  let z = range(doc, f.ids[0]); near(z.z1, 6200, 0.5, "fascia top at roof top"); near(z.z0, 5750, 0.5, "hangs 450");
  const s = ok(runTool(h, "add_soffit", { host_id: "R1", material: "mt-timber-teak", lighting_line: true }, AI));
  const sd = doc.details.find(x => x.id === s.ids[0]); assert.deepEqual(detailIfc(sd), ["IFCCOVERING", ".CEILING."]);
  assert.equal(detailParts(doc, sd).length, 8); // 4 eave strips + 4 light lines
  z = range(doc, s.ids[0]); near(z.z1, 6000, 0.5, "soffit under the roof");
  const p = ok(runTool(h, "add_parapet", { edges: ["R1:all"], height: 900, material: "mt-paint-white" }, AI));
  z = range(doc, p.ids[0]); near(z.z0, 6200, 0.5, "parapet on the roof"); assert.ok(z.z1 > 7100 - 1 && z.z1 < 7200, "coping on top");
  assert.deepEqual(detailIfc(doc.details.find(x => x.id === p.ids[0])), ["IFCWALL", ".PARAPET."]);
});

test("soffit under the balcony: exactly the 4 x 1.5 m that projects past the floor below", () => {
  const { doc, h } = setup();
  const r = ok(runTool(h, "add_soffit", { host_id: "F2", material: "mt-timber-walnut" }, AI));
  const parts = detailParts(doc, doc.details.find(x => x.id === r.ids[0]));
  near(S.prismVolume(parts) / 20, 4000 * 1500, 1, "area");
  near(Math.max(...parts.map(p => p.z1)), 2850, 0.5, "under the slab");
});

test("fins, canopy, pergola, planter, steps, screen, wall sweep, extrusion: right size and class", () => {
  const { doc, h } = setup();
  const fins = ok(runTool(h, "add_fins", { wall_ids: ["S1"], from: 9000, to: 10000, count: 4, depth: 300, width: 50, material: "mt-alu-black" }, AI));
  const fd = doc.details.find(x => x.id === fins.ids[0]); assert.equal(detailParts(doc, fd).length, 4); assert.deepEqual(detailIfc(fd), ["IFCSHADINGDEVICE", ".USERDEFINED.", "LOUVRE"]);
  near(S.prismVolume(detailParts(doc, fd)), 4 * 50 * 300 * 3000, 1, "fin volume");
  const can = ok(runTool(h, "add_canopy", { opening_id: "D1", depth: 1200, material: "mt-concrete" }, AI));
  const cz = range(doc, can.ids[0]); near(cz.z0, 2300, 0.5, "200 above the door head"); near(cz.z1, 2450, 0.5, "150 thick");
  ok(runTool(h, "add_pergola", { level_id: "lv-2", area: [[-127.5, 4000], [-127.5, 8000], [-2500, 8000], [-2500, 4000]], height: 2700, material: "mt-timber-teak" }, AI));
  ok(runTool(h, "add_planter", { level_id: "lv-1", area: [[11000, 0], [12000, 0], [12000, 3000], [11000, 3000]], height: 600, material: "mt-concrete" }, AI));
  const st = ok(runTool(h, "add_steps", { level_id: "lv-1", at: [5000, -1027.5], direction: [0, 1], base_height: -450, count: 3, riser: 150, tread: 300, material: "mt-travertine" }, AI));
  assert.deepEqual(detailIfc(doc.details.find(x => x.id === st.ids[0])), ["IFCSTAIR", ".STRAIGHT_RUN_STAIR."]);
  ok(runTool(h, "add_screen", { level_id: "lv-1", line: [[10127.5, -500], [12000, -500]], height: 1800, pattern: "breeze_block", material: "mt-paint-white" }, AI));
  const ws = ok(runTool(h, "add_wall_sweep", { wall_ids: ["S2", "E2", "N2"], profile: "pf-band", height_from: "top", distance: 300, material: "mt-paint-charcoal" }, AI));
  const band = doc.components.find(c => c.id === ws.ids[0]); assert.deepEqual(band.ifc, ["IFCCOVERING", ".MOLDING."]); assert.equal(band.source, "ai");
  const ex = ok(runTool(h, "add_extrusion", { work_plane: { wall_id: "S1" }, profile_loops: [[[6500, 900], [7000, 900], [7000, 1800], [6500, 1800]]], start: 0, end: 80, material: "mt-alu-bronze", ifc_class: "IfcMember" }, AI));
  assert.deepEqual(doc.components.find(c => c.id === ex.ids[0]).ifc, ["IFCMEMBER", ".NOTDEFINED."]);
  assert.equal(doc.details.length, 6); assert.equal(doc.components.length, 2);
});

test("your elements are locked: Ollic AI may add, and set materials, but not move, resize or delete yours", () => {
  const { doc, h } = setup();
  const before = JSON.stringify(doc.walls);
  bad(runTool(h, "edit_element", { id: "S1", changes: { unconnectedHeight: 5000 } }, AI), /locked/);
  bad(runTool(h, "delete_element", { id: "S1" }, AI), /locked/);
  assert.equal(JSON.stringify(doc.walls), before);
  ok(runTool(h, "set_material", { element_ids: ["S1"], face: "exterior", material: "mt-brick-red" }, AI));
  assert.equal(doc.walls.find(w => w.id === "S1").finishes.exterior, "mt-brick-red");
  // its own elements it may change and delete; not those from another session
  const r = ok(runTool(h, "add_railing", { edges: ["F2:exposed"], type: "glass", height: 1100, material: "mt-steel-brushed" }, AI));
  ok(runTool(h, "edit_element", { id: r.ids[0], changes: { height: 1000 } }, AI)); near(range(doc, r.ids[0]).z1, 4000, 0.5, "edited");
  bad(runTool(h, "delete_element", { id: r.ids[0] }, { source: "ai", session: "other" }), /earlier session/);
  ok(runTool(h, "delete_element", { id: r.ids[0] }, AI)); assert.equal(doc.details.length, 0);
});

test("clash checks: a fin across a window and a canopy through a floor are refused; nothing floats", () => {
  const { doc, h } = setup();
  bad(runTool(h, "add_fins", { wall_ids: ["S1"], spacing: 600, depth: 300, material: "mt-alu-black" }, AI), /blocks (window|door)/);
  bad(runTool(h, "add_canopy", { opening_id: "D1", depth: 1200, height: 2850, material: "mt-concrete" }, AI), /floor slab/);
  bad(runTool(h, "add_planter", { level_id: "lv-2", area: [[20000, 0], [21000, 0], [21000, 1000], [20000, 1000]], material: "mt-concrete" }, AI), /float/);
  bad(runTool(h, "add_wall_sweep", { wall_ids: ["S1"], profile: "pf-plinth", material: "mt-stone-dark" }, AI), /blocks door/);
  assert.equal(doc.details.length + doc.components.length, 0, "refused commands leave nothing behind");
  assert.equal(h.undoStack.length, 0);
});

test("normal sizes: outside the range needs a reason; unknown names are refused with the closest", () => {
  const { h } = setup();
  bad(runTool(h, "add_railing", { edges: ["F2:exposed"], type: "glass", height: 1500, material: "mt-steel-brushed" }, AI), /normal range/);
  ok(runTool(h, "add_railing", { edges: ["F2:exposed"], type: "glass", height: 1500, material: "mt-steel-brushed", reason: "Client wants a privacy screen height" }, AI));
  bad(runTool(h, "add_cladding", { wall_ids: ["S1"], material: "travertine" }, AI), /mt-travertine/);
  bad(runTool(h, "add_edge_sweep", { edges: ["R1:all"], profile: "pf-gutter", material: "mt-paint-white" }, AI), /profile library/);
});

test("undo removes each added item cleanly", () => {
  const { doc, h } = setup();
  const snap = JSON.stringify(doc);
  ok(runTool(h, "add_cladding", { wall_ids: ["S1", "E1"], material: "mt-travertine" }, AI));
  ok(runTool(h, "add_railing", { edges: ["F2:exposed"], type: "baluster", height: 1100, material: "mt-alu-black" }, AI));
  ok(runTool(h, "set_material", { element_ids: ["F2"], material: "mt-concrete" }, AI));
  assert.equal(h.undoStack.length, 3);
  h.undo(); h.undo(); h.undo();
  assert.equal(JSON.stringify(doc), snap);
});

test("details follow their hosts: the railing's base moves with its level", () => {
  const { doc, h } = setup();
  const r = ok(runTool(h, "add_railing", { edges: ["F2:exposed"], type: "solid", height: 1000, material: "mt-paint-white" }, AI));
  doc.levels.find(l => l.id === "lv-2").elevation = 3300;
  near(range(doc, r.ids[0]).z0, 3300, 0.5, "follows");
  assert.throws(() => buildDetail(doc, "railing", { edges: ["F9:e1"] }), /not a floor or a roof/);
});

test("deleting a wall or floor trims or removes the details on it", async () => {
  const { dropWithHosts } = await import("../../web/assets/sketch/details.js");
  const { doc, h } = setup();
  ok(runTool(h, "add_cladding", { wall_ids: ["S1", "E1"], material: "mt-travertine" }, AI));
  ok(runTool(h, "add_railing", { edges: ["F2:exposed"], type: "glass", height: 1100, material: "mt-steel-brushed" }, AI));
  ok(runTool(h, "add_canopy", { opening_id: "D1", depth: 1200, material: "mt-concrete" }, AI));
  const kept = dropWithHosts(doc.details, new Set(["S1", "D1"]));
  assert.deepEqual(kept.map(d => d.kind), ["cladding", "railing"]);
  assert.deepEqual(kept[0].args.wall_ids, ["E1"]);
  assert.deepEqual(dropWithHosts(doc.details, new Set(["F2"])).map(d => d.kind), ["cladding", "canopy"]);
});
