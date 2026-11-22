// Phase 1 unit tests: model, undo/redo, geometry, snaps, selection. Run: node --test tests/sketch
import test from "node:test";
import assert from "node:assert/strict";
import * as G from "../../web/assets/sketch/geom.js";
import { History } from "../../web/assets/sketch/history.js";
import { newProject, normalize, levelLabel } from "../../web/assets/sketch/model.js";
import { findSnap } from "../../web/assets/sketch/snaps.js";
import { makeLine, makeArc, planCurves, inRect, moveGrip, setLineLength } from "../../web/assets/sketch/elements.js";

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const nearP = (p, q, tol = 1e-6) => { near(p.x, q.x, tol); near(p.y, q.y, tol); };

test("new project has Level 1 at ±0.000 and the Nigerian types", () => {
  const d = newProject();
  assert.equal(d.levels.length, 1);
  assert.equal(levelLabel(d.levels[0].elevation), "±0.000");
  assert.equal(levelLabel(3000), "+3.000");
  assert.equal(levelLabel(-150), "−0.150");
  const ext = d.wallTypes.find(t => t.id === "wt-ext225");
  assert.equal(ext.thickness, 255); // 225 block + 15 render each side
  assert.equal(d.doorTypes.find(t => t.id === "dt-900").height, 2100);
  assert.equal(d.windowTypes.find(t => t.id === "wn-1200").sill, 900);
});

test("normalize rejects what is not a sketch and fills missing collections", () => {
  assert.throws(() => normalize({ hello: 1 }), /not an Ollic sketch/);
  assert.throws(() => normalize({ levels: [], schemaVersion: 99 }), /newer version/);
  const d = normalize({ levels: [{ id: "a", name: "L", elevation: 0 }] });
  assert.ok(Array.isArray(d.walls) && Array.isArray(d.lines));
});

test("undo and redo replay adds, edits and deletes exactly", () => {
  const h = new History(newProject());
  const d = h.doc;
  h.transact("Add lines", doc => {
    doc.lines.push(makeLine("model", "lv-1", "thin", G.P(0, 0), G.P(1000, 0)));
    doc.lines.push(makeLine("model", "lv-1", "thin", G.P(0, 0), G.P(0, 1000)));
  });
  const snap1 = JSON.stringify(d);
  h.transact("Edit", doc => { doc.lines[0].b = G.P(2000, 0); doc.lines.splice(1, 1); doc.name = "House"; });
  const snap2 = JSON.stringify(d);
  assert.equal(d.lines.length, 1);
  h.undo();
  assert.equal(JSON.stringify(d), snap1);
  h.redo();
  assert.equal(JSON.stringify(d), snap2);
  h.undo(); h.undo();
  assert.equal(d.lines.length, 0);
  assert.equal(h.canUndo(), false);
  h.redo(); h.redo();
  assert.equal(JSON.stringify(d), snap2);
});

test("a refused edit leaves the model untouched and adds no undo step", () => {
  const h = new History(newProject());
  const before = JSON.stringify(h.doc);
  assert.throws(() => h.transact("Bad", doc => { doc.lines.push(makeLine("model", "lv-1", "thin", G.P(0, 0), G.P(1, 1))); throw new Error("no"); }), /no/);
  assert.equal(JSON.stringify(h.doc), before);
  assert.equal(h.canUndo(), false);
});

test("a no-op transaction adds no undo step", () => {
  const h = new History(newProject());
  h.transact("Nothing", () => {});
  assert.equal(h.canUndo(), false);
});

test("angle constraint: Shift holds 0/90, otherwise 15-degree steps within 3 degrees", () => {
  const o = G.P(0, 0);
  const q = G.constrainAngle(o, G.P(1000, 120), { ortho: true });
  nearP(q, G.P(Math.hypot(1000, 120), 0), 1e-6);
  const r = G.constrainAngle(o, G.fromAngle((44 * Math.PI) / 180, 1000));
  assert.equal(r.deg, 45);
  const s = G.constrainAngle(o, G.fromAngle((38 * Math.PI) / 180, 1000));
  assert.equal(s.angleSnapped, undefined); // 38 is 7 degrees from 45: free
});

test("arcs: three points, ends + radius, and points on the arc", () => {
  const arc = G.arcFrom3(G.P(1000, 0), G.P(0, 1000), G.P(-1000, 0));
  nearP(arc.c, G.P(0, 0), 1e-6); near(arc.r, 1000, 1e-6); near(arc.sweep, Math.PI, 1e-9);
  const cw = G.arcFrom3(G.P(1000, 0), G.P(0, -1000), G.P(-1000, 0));
  near(cw.sweep, -Math.PI, 1e-9);
  const a2 = G.arcFromEndsRadius(G.P(0, 0), G.P(2000, 0), 1000, 1);
  nearP(a2.c, G.P(1000, 0), 1e-6);
  nearP(G.arcMid(a2), G.P(1000, -1000), 1e-6);
  assert.equal(G.arcFromEndsRadius(G.P(0, 0), G.P(2000, 0), 900, 1), null); // radius too small
});

test("regular polygons: inscribed corners on the circle, circumscribed edges touch it", () => {
  const ins = G.regularPolygon(G.P(0, 0), G.P(1000, 0), 6, "inscribed");
  for (const p of ins) near(G.len(p), 1000, 1e-6);
  const cir = G.regularPolygon(G.P(0, 0), G.P(1000, 0), 4, "circumscribed");
  const m = G.mid(cir[0], cir[1]);
  near(G.len(m), 1000, 1e-6);
});

test("snaps: endpoint beats nearest, midpoint, intersection, perpendicular, tangent, grid, overrides", () => {
  const doc = newProject();
  doc.lines.push(makeLine("model", "lv-1", "thin", G.P(0, 0), G.P(4000, 0)));
  doc.lines.push(makeLine("model", "lv-1", "thin", G.P(2000, -2000), G.P(2000, 2000)));
  doc.lines.push(makeArc("model", "lv-1", "thin", { c: G.P(8000, 0), r: 1000, start: 0, sweep: G.TAU }));
  doc.lines.push(makeLine("model", "lv-1", "thin", G.P(0, 3000), G.P(2000, 3000)));
  const curves = planCurves(doc, "lv-1");
  const opts = { radius: 150, grid: 1000 };
  assert.equal(findSnap(G.P(3950, 40), curves, opts).kind, "endpoint");
  const m = findSnap(G.P(1010, 3020), curves, opts);
  assert.equal(m.kind, "midpoint"); nearP(m.point, G.P(1000, 3000));
  const x = findSnap(G.P(2030, 30), curves, opts);
  assert.equal(x.kind, "intersection"); nearP(x.point, G.P(2000, 0));
  const c = findSnap(G.P(8050, 20), curves, opts);
  assert.equal(c.kind, "centre");
  const pp = findSnap(G.P(3000, 60), curves, { ...opts, from: G.P(3000, 1500) });
  assert.equal(pp.kind, "perpendicular"); nearP(pp.point, G.P(3000, 0), 1e-6);
  const t = findSnap(G.P(8000, 1030), curves, { ...opts, from: G.P(5000, 1000), enabled: new Set(["tangent"]) });
  assert.equal(t.kind, "tangent");
  near(G.dot(G.sub(t.point, G.P(8000, 0)), G.sub(t.point, G.P(5000, 1000))), 0, 1e-3);
  assert.equal(findSnap(G.P(5960, -3050), curves, opts).kind, "grid");
  assert.equal(findSnap(G.P(3950, 40), curves, { ...opts, override: "off" }), null);
  assert.equal(findSnap(G.P(1100, 30), curves, { ...opts, override: "nearest" }).kind, "nearest");
});

test("window selects only what is fully inside; crossing selects anything touched", () => {
  const l = makeLine("model", "lv-1", "thin", G.P(0, 0), G.P(4000, 0));
  const r = { x0: -100, y0: -100, x1: 2000, y1: 100 };
  assert.equal(inRect(l, r, false), false);
  assert.equal(inRect(l, r, true), true);
  assert.equal(inRect(l, { x0: -100, y0: -100, x1: 4100, y1: 100 }, false), true);
  const arc = makeArc("model", "lv-1", "thin", { c: G.P(0, 0), r: 1000, start: 0, sweep: Math.PI / 2 });
  assert.equal(inRect(arc, { x0: 900, y0: -10, x1: 1100, y1: 50 }, true), true);
});

test("grips and typed length edit lines exactly", () => {
  const l = makeLine("model", "lv-1", "thin", G.P(0, 0), G.P(3000, 4000));
  setLineLength(l, 10000);
  nearP(l.b, G.P(6000, 8000));
  moveGrip(l, "a", G.P(100, 100));
  nearP(l.a, G.P(100, 100));
  const arc = makeArc("model", "lv-1", "thin", G.arcFrom3(G.P(1000, 0), G.P(0, 1000), G.P(-1000, 0)));
  moveGrip(arc, "mid", G.P(0, 2000));
  nearP(G.arcStart(arc), G.P(1000, 0), 1e-6);
  nearP(G.arcEnd(arc), G.P(-1000, 0), 1e-6);
  nearP(G.arcMid(arc), G.P(0, 2000), 1e-6);
});
