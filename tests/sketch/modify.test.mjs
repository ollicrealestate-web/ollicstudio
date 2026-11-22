// Phase 3 unit tests: Modify tools give exact results on walls and lines.
import test from "node:test";
import assert from "node:assert/strict";
import * as G from "../../web/assets/sketch/geom.js";
import { newProject } from "../../web/assets/sketch/model.js";
import { makeWall, wallFootprints } from "../../web/assets/sketch/walls.js";
import { makeLine } from "../../web/assets/sketch/elements.js";
import * as M from "../../web/assets/sketch/modify.js";

const near = (a, b, tol = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} != ${b}`);
const nearP = (p, q, tol = 1e-6, msg = "") => { near(p.x, q.x, tol, msg + " x"); near(p.y, q.y, tol, msg + " y"); };
const W = (d, a, b, extra = {}) => { const w = makeWall(d, { a: G.P(...a), b: G.P(...b), baseLevelId: "lv-1", typeId: "wt-int150", ...extra }); d.walls.push(w); return w; };
const L = (d, a, b) => { const l = makeLine("model", "lv-1", "thin", G.P(...a), G.P(...b)); d.lines.push(l); return l; };

test("offset of a wall chain by 1200 mm gives exact positions and keeps the corners joined", () => {
  const d = newProject();
  const a = W(d, [0, 0], [6000, 0]), b = W(d, [6000, 0], [6000, 4000]), c = W(d, [6000, 4000], [0, 4000]);
  const made = M.offsetChain(d, [a, b, c], 1200, G.P(3000, 2000), true); // towards the inside
  assert.equal(d.walls.length, 6);
  const [na, nb, nc] = made;
  nearP(na.a, G.P(0, 1200)); nearP(na.b, G.P(4800, 1200));
  nearP(nb.a, G.P(4800, 1200)); nearP(nb.b, G.P(4800, 2800));
  nearP(nc.a, G.P(4800, 2800)); nearP(nc.b, G.P(0, 2800));
  assert.ok(made.every(w => w.typeId === "wt-int150"), "copies keep the type");
});

test("offset of a closed rectangle chain mitres every corner, including the closing one", () => {
  const d = newProject();
  const c = [[0, 0], [10000, 0], [10000, 8000], [0, 8000]];
  const ws = c.map((p, i) => W(d, p, c[(i + 1) % 4]));
  const made = M.offsetChain(d, ws, 1200, G.P(-500, -500), false); // move outwards, no copy
  assert.equal(d.walls.length, 4);
  nearP(made[0].a, G.P(-1200, -1200)); nearP(made[0].b, G.P(11200, -1200));
  nearP(made[2].a, G.P(11200, 9200)); nearP(made[3].b, G.P(-1200, -1200));
});

test("single offset of a line goes to the side of the cursor", () => {
  const d = newProject();
  const l = L(d, [0, 0], [5000, 0]);
  const o = M.offsetElement(d, l, 1200, G.P(2500, -50), true);
  nearP(o.a, G.P(0, -1200)); nearP(o.b, G.P(5000, -1200));
  assert.equal(d.lines.length, 2);
});

test("Trim/Extend to Corner: the picked parts are kept and meet exactly", () => {
  const d = newProject();
  const a = W(d, [0, 0], [6000, 0]);        // runs past the corner
  const b = W(d, [4000, 500], [4000, 5000]); // stops short of the corner
  M.trimCorner(a, G.P(1000, 0), b, G.P(4000, 3000));
  nearP(a.a, G.P(0, 0)); nearP(a.b, G.P(4000, 0));
  nearP(b.a, G.P(4000, 0)); nearP(b.b, G.P(4000, 5000));
});

test("Trim to a boundary keeps the picked side; extend reaches the boundary", () => {
  const d = newProject();
  const l = L(d, [0, 0], [8000, 0]);
  M.trimTo(l, G.P(5000, -1000), G.P(5000, 1000), G.P(6000, 0)); // keep the right part
  nearP(l.a, G.P(5000, 0)); nearP(l.b, G.P(8000, 0));
  const m = L(d, [0, 2000], [3000, 2000]);
  M.trimTo(m, G.P(5000, -1000), G.P(5000, 1000), G.P(1000, 2000)); // extend to the boundary
  nearP(m.b, G.P(5000, 2000));
});

test("Chamfer 300/300 gives exact end points and a 424.26 mm cut", () => {
  const d = newProject();
  const a = L(d, [0, 0], [5000, 0]), b = L(d, [0, 0], [0, 4000]);
  const piece = M.chamfer(d, a, G.P(2000, 0), b, G.P(0, 2000), 300, 300);
  nearP(a.a, G.P(300, 0)); nearP(a.b, G.P(5000, 0));
  nearP(b.a, G.P(0, 300)); nearP(b.b, G.P(0, 4000));
  near(G.dist(piece.a, piece.b), Math.hypot(300, 300), 1e-9);
  // on walls: the new wall has the first wall's type and heights
  const w1 = W(d, [0, 0], [5000, 0], { typeId: "wt-ext225", unconnectedHeight: 2700 }), w2 = W(d, [0, 0], [0, 4000], { typeId: "wt-int150" });
  const pw = M.chamfer(d, w1, G.P(2000, 0), w2, G.P(0, 2000), 300, 300);
  assert.equal(pw.typeId, "wt-ext225"); assert.equal(pw.unconnectedHeight, 2700);
  assert.ok(d.walls.includes(pw));
});

test("Fillet r = 500 gives exact tangent points and a quarter arc of radius 500", () => {
  const d = newProject();
  const a = W(d, [0, 0], [5000, 0]), b = W(d, [0, 0], [0, 4000]);
  const arc = M.fillet(d, a, G.P(2000, 0), b, G.P(0, 2000), 500);
  nearP(a.a, G.P(500, 0)); nearP(b.a, G.P(0, 500));
  near(arc.r, 500, 1e-9); nearP(arc.c, G.P(500, 500), 1e-9);
  near(Math.abs(arc.sweep), Math.PI / 2, 1e-9);
  nearP(G.arcStart(arc), G.P(500, 0), 1e-9); nearP(G.arcEnd(arc), G.P(0, 500), 1e-9);
  // the arc wall joins both walls cleanly (no gaps or overlaps at the tangent points)
  const fp = wallFootprints(d, "lv-1");
  const total = [...fp.values()].flatMap(f => f.pieces).reduce((s, p) => s + Math.abs(G.polygonArea(p)), 0);
  const expected = 4500 * 150 + 3500 * 150 + (Math.PI / 4) * ((500 + 75) ** 2 - (500 - 75) ** 2);
  near(total, expected, expected * 0.002, "area");
  // radius 0 is a plain trim to the corner
  const c = L(d, [0, 0], [3000, 0]), e = L(d, [-100, 200], [-100, 3000]);
  assert.equal(M.fillet(d, c, G.P(2000, 0), e, G.P(-100, 2000), 0), null);
  nearP(c.a, G.P(-100, 0)); nearP(e.a, G.P(-100, 0));
});

test("Split at a point, Split with gap, and Delete inner segment", () => {
  const d = newProject();
  const w = W(d, [0, 0], [6000, 0]);
  const second = M.split(d, w, G.P(2000, 30));
  nearP(w.b, G.P(2000, 0)); nearP(second.a, G.P(2000, 0)); nearP(second.b, G.P(6000, 0));
  assert.notEqual(second.id, w.id); assert.equal(second.typeId, w.typeId);
  const l = L(d, [0, 1000], [6000, 1000]);
  const g = M.split(d, l, G.P(3000, 1000), 20);
  nearP(l.b, G.P(2990, 1000)); nearP(g.a, G.P(3010, 1000));
  const m = L(d, [0, 2000], [6000, 2000]);
  const rest = M.deleteBetween(d, m, G.P(2000, 2000), G.P(4000, 2000));
  nearP(m.b, G.P(2000, 2000)); nearP(rest.a, G.P(4000, 2000)); nearP(rest.b, G.P(6000, 2000));
});

test("Move, Copy, Rotate, Mirror and Scale are exact; mirroring a wall keeps its exterior on the mirrored side", () => {
  const d = newProject();
  const w = W(d, [1000, 0], [4000, 0], { typeId: "wt-ext225" });
  M.transformIds(d, [w.id], M.translation(G.P(500, 200)));
  nearP(w.a, G.P(1500, 200));
  const [cid] = M.transformIds(d, [w.id], M.rotation(G.P(1500, 200), Math.PI / 2), { copy: true });
  const c = d.walls.find(x => x.id === cid);
  nearP(c.b, G.P(1500, 3200), 1e-9);
  const [mid] = M.transformIds(d, [w.id], M.mirrorAcross(G.P(0, 1000), G.P(10, 1000)), { copy: true });
  const m = d.walls.find(x => x.id === mid);
  nearP(m.a, G.P(1500, 1800), 1e-9); nearP(m.b, G.P(4500, 1800), 1e-9);
  assert.equal(m.flipped, true, "exterior side mirrored");
  const l = L(d, [0, 0], [1000, 0]);
  M.transformIds(d, [l.id], M.scaling(G.P(0, 0), 2.5));
  nearP(l.b, G.P(2500, 0));
  const pinned = L(d, [0, 0], [1, 1]); pinned.pinned = true;
  assert.throws(() => M.transformIds(d, [pinned.id], M.translation(G.P(1, 0))), /pinned/);
  assert.doesNotThrow(() => M.transformIds(d, [pinned.id], M.translation(G.P(1, 0)), { copy: true }));
});

test("Array: linear to the 2nd item or spread to the last; radial round a centre", () => {
  const d = newProject();
  const l = L(d, [0, 0], [0, 1000]);
  M.arrayLinear(d, [l.id], G.P(1000, 0), 4);
  assert.deepEqual(d.lines.map(x => x.a.x), [0, 1000, 2000, 3000]);
  const k = L(d, [0, 5000], [0, 6000]);
  M.arrayLinear(d, [k.id], G.P(3000, 0), 4, true);
  assert.deepEqual(d.lines.filter(x => x.a.y === 5000).map(x => x.a.x), [0, 1000, 2000, 3000]);
  const r = L(d, [1000, 0], [2000, 0]);
  const before = d.lines.length;
  M.arrayRadial(d, [r.id], G.P(0, 0), Math.PI / 2, 4);
  assert.equal(d.lines.length, before + 3);
  nearP(d.lines.at(-1).a, G.P(0, -1000), 1e-9);
  assert.throws(() => M.arrayLinear(d, [l.id], G.P(1, 0), 1), /between 2 and 200/);
});

test("Align moves a parallel element onto the reference; a locked alignment holds when the reference moves", () => {
  const d = newProject();
  const ref = L(d, [0, 0], [0, 5000]);
  const w = W(d, [800, 1000], [800, 4000], { typeId: "wt-int150" });
  const fp = wallFootprints(d, "lv-1").get(w.id);
  const lines = M.alignLines(w, fp);
  const faceIdx = lines.findIndex(x => x.kind === "face" && x.a.x < 800); // the face at x = 725
  const face = lines[faceIdx];
  const mv = M.alignMove({ a: ref.a, b: ref.b }, face);
  w.a = G.add(w.a, mv); w.b = G.add(w.b, mv);
  near(w.a.x, 75, 1e-9, "wall face now on x = 0");
  d.constraints = [{ ref: ref.id, refIdx: 0, el: w.id, elIdx: faceIdx }];
  ref.a = G.add(ref.a, G.P(500, 0)); ref.b = G.add(ref.b, G.P(500, 0));
  M.enforceLocks(d, x => wallFootprints(d, "lv-1").get(x.id));
  near(w.a.x, 575, 1e-9, "locked face follows the reference");
});
