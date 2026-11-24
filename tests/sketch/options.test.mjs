// The design option "AI proposal": kept apart from your model; accept and reject per item, accept all, discard, undo.
import test from "node:test";
import assert from "node:assert/strict";
import { History } from "../../web/assets/sketch/history.js";
import { runTool } from "../../web/assets/sketch/aitools.js";
import * as O from "../../web/assets/sketch/options.js";
import { testBox } from "./testbox.mjs";

const CTX = { source: "ai", session: "s1", option: O.OPTION };
function proposal() {
  const doc = testBox(), h = new History(doc);
  doc.settings.ai = { session: "s1", plan: [{ n: 1, text: "Travertine cladding on the south walls" }, { n: 2, text: "Glass railing on the balcony" }, { n: 3, text: "Brick on the east wall" }] };
  const ok = r => { assert.ok(r.ok, r.error); return r; };
  ok(runTool(h, "add_cladding", { wall_ids: ["S1", "S2"], material: "mt-travertine", plan_item: 1 }, CTX));
  ok(runTool(h, "add_railing", { edges: ["F2:exposed"], type: "glass", height: 1100, material: "mt-steel-brushed", plan_item: 2 }, CTX));
  ok(runTool(h, "set_material", { element_ids: ["E1", "E2"], material: "mt-brick-red", plan_item: 3 }, CTX));
  return { doc, h };
}

test("the proposal is kept apart: your walls keep their own material until you accept", () => {
  const { doc } = proposal();
  assert.ok(O.hasProposal(doc));
  assert.equal(doc.walls.find(w => w.id === "E1").material, undefined, "your wall is untouched");
  assert.equal(O.shownMaterial(doc.walls.find(w => w.id === "E1"), true), "mt-brick-red", "shown in the proposal");
  assert.equal(O.shownMaterial(doc.walls.find(w => w.id === "E1"), false), undefined, "not shown before");
  const items = O.proposalItems(doc);
  assert.deepEqual(items.map(i => [i.planItem, i.title, i.ids.length, i.materialIds.length]), [[1, "Travertine cladding on the south walls", 1, 0], [2, "Glass railing on the balcony", 1, 0], [3, "Brick on the east wall", 0, 2]]);
});

test("reject one item, accept the others: the model gets exactly the accepted ones", () => {
  const { doc, h } = proposal();
  const walls = JSON.stringify(doc.walls.map(w => [w.id, w.a, w.b, w.baseLevelId, w.topLevelId]));
  const [i1, i2, i3] = O.proposalItems(doc);
  h.transact("Reject", d => O.rejectIds(d, i2.ids));
  h.transact("Accept", d => O.acceptIds(d, [...i1.ids, ...i1.materialIds]));
  h.transact("Accept", d => O.acceptIds(d, i3.materialIds));
  assert.equal(O.hasProposal(doc), false);
  assert.deepEqual(doc.details.map(d => d.kind), ["cladding"]);
  assert.equal(doc.details[0].option, undefined, "now an ordinary element");
  assert.equal(doc.walls.find(w => w.id === "E2").material, "mt-brick-red");
  assert.equal(JSON.stringify(doc.walls.map(w => [w.id, w.a, w.b, w.baseLevelId, w.topLevelId])), walls, "walls did not move");
  // one undo step each
  h.undo(); h.undo(); h.undo();
  assert.equal(O.proposalItems(doc).length, 3);
});

test("accept all is one step; discard removes everything proposed and nothing else", () => {
  const { doc, h } = proposal();
  const before = JSON.stringify(testBox().walls);
  h.transact("Accept all", d => O.acceptAll(d));
  assert.equal(O.hasProposal(doc), false); assert.equal(doc.details.length, 2); assert.equal(doc.settings.ai.closed, "accepted");
  h.undo(); assert.equal(O.proposalItems(doc).length, 3);
  h.transact("Discard", d => O.discardAll(d));
  assert.equal(doc.details.length, 0); assert.equal(O.hasProposal(doc), false);
  assert.equal(JSON.stringify(doc.walls), before, "your walls are exactly as drawn");
});
