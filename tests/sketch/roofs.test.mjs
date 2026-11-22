// Phase 7 unit tests: roofs from the weighted straight skeleton.
import test from "node:test";
import assert from "node:assert/strict";
import * as G from "../../web/assets/sketch/geom.js";
import * as R from "../../web/assets/sketch/roofs.js";

const near = (a, b, tol = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} != ${b}`);
const deg = d => (d * Math.PI) / 180;
const rect = (w, h) => [G.P(0, 0), G.P(w, 0), G.P(w, h), G.P(0, h)];
const ridges = (sk, top) => sk.arcs.filter(a => Math.abs(a.a.z - top) < 1e-3 && Math.abs(a.b.z - top) < 1e-3 && G.dist(a.a, a.b) > 1);
const area = f => Math.abs(G.polygonArea(f.pts));

test("slopes typed as degrees or rise:run", () => {
  near(R.parseSlope("30"), deg(30)); near(R.parseSlope("30°"), deg(30));
  near(R.parseSlope("1:2"), Math.atan(0.5)); near(R.parseSlope("300/1000"), Math.atan(0.3));
  assert.throws(() => R.parseSlope("steep"), /not a slope/);
  assert.equal(R.slopeLabel(deg(30)), "30°"); assert.equal(R.slopeLabel(Math.atan(0.5), "ratio"), "1:2");
});

test("hip roof on a 10 x 8 m rectangle at 30°: ridge 2 m long at 4 x tan 30° = 2.309 m", () => {
  const sk = R.skeleton(rect(10000, 8000), [deg(30), deg(30), deg(30), deg(30)]);
  near(sk.maxZ, 4000 * Math.tan(deg(30)), 1e-6, "ridge height");
  const r = ridges(sk, sk.maxZ);
  assert.equal(r.length, 1, "one ridge");
  near(G.dist(r[0].a, r[0].b), 2000, 1e-6, "ridge length");
  // the faces cover the footprint exactly (two trapezoids and two triangles)
  near(sk.faces.reduce((s, f) => s + area(f), 0), 80e6, 1e-3, "plan area");
  const hips = sk.arcs.filter(a => Math.abs(a.a.z) < 1e-6);
  assert.equal(hips.length, 4, "four hips from the corners");
});

test("gable roof when the two short edges define no slope: the ridge runs the full 10 m", () => {
  const sk = R.skeleton(rect(10000, 8000), [deg(30), null, deg(30), null]);
  near(sk.maxZ, 4000 * Math.tan(deg(30)), 1e-6);
  const r = ridges(sk, sk.maxZ);
  near(r.reduce((s, a) => s + G.dist(a.a, a.b), 0), 10000, 1e-6, "ridge length");
  assert.equal(sk.faces.filter(f => area(f) > 1).length >= 2, true);
  near(sk.faces.reduce((s, f) => s + area(f), 0), 80e6, 1e-3, "two slopes cover the plan");
});

test("mono-pitch: one sloped edge rises across the whole width", () => {
  const sk = R.skeleton(rect(10000, 6000), [deg(10), null, null, null]);
  near(sk.maxZ, 6000 * Math.tan(deg(10)), 1e-6);
  near(sk.faces.reduce((s, f) => s + area(f), 0), 60e6, 1e-3);
});

test("L-shaped hip roof has exactly one valley, from the inside corner", () => {
  // 10 x 8 L with a 4 x 4 notch out of the top-right corner
  const L = [G.P(0, 0), G.P(10000, 0), G.P(10000, 4000), G.P(6000, 4000), G.P(6000, 8000), G.P(0, 8000)];
  const sk = R.skeleton(L, L.map(() => deg(30)));
  const valleys = sk.arcs.filter(a => a.from === "valley");
  assert.equal(valleys.length, 1, "one valley");
  near(valleys[0].a.x, 6000, 1e-6); near(valleys[0].a.y, 4000, 1e-6); near(valleys[0].a.z, 0, 1e-6);
  near(sk.faces.reduce((s, f) => s + area(f), 0), Math.abs(G.polygonArea(L)), 1e-3, "faces cover the L exactly");
  near(sk.maxZ, 3000 * Math.tan(deg(30)), 1e-6, "the 6 m wide wing sets the top ridge height");
  assert.equal(sk.arcs.filter(a => a.from === "ridge").length, 2, "a ridge on each wing");
});

test("T- and U-shaped plans: two valleys each, faces cover the plan", () => {
  const T = [G.P(0, 4000), G.P(3000, 4000), G.P(3000, 0), G.P(7000, 0), G.P(7000, 4000), G.P(10000, 4000), G.P(10000, 8000), G.P(0, 8000)];
  const sT = R.skeleton(T, T.map(() => deg(30)));
  assert.equal(sT.arcs.filter(a => a.from === "valley").length, 2);
  near(sT.faces.reduce((s, f) => s + area(f), 0), Math.abs(G.polygonArea(T)), 1e-3);
  near(sT.maxZ, 2000 * Math.tan(deg(30)), 1e-6);
  const U = [G.P(0, 0), G.P(12000, 0), G.P(12000, 9000), G.P(8000, 9000), G.P(8000, 4000), G.P(4000, 4000), G.P(4000, 9000), G.P(0, 9000)];
  const sU = R.skeleton(U, U.map(() => deg(30)));
  assert.equal(sU.arcs.filter(a => a.from === "valley").length, 2);
  near(sU.faces.reduce((s, f) => s + area(f), 0), Math.abs(G.polygonArea(U)), 1e-3);
  near(sU.maxZ, 2000 * Math.tan(deg(30)), 1e-6);
  // every face is a plane at 30°: check its steepest slope
  for (const f of [...sT.faces, ...sU.faces]) { const [a, b, c] = f.pts; const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z }; const nx = ab.y * ac.z - ab.z * ac.y, ny = ab.z * ac.x - ab.x * ac.z, nz = ab.x * ac.y - ab.y * ac.x; if (Math.hypot(nx, ny, nz) < 1) continue; near(Math.atan2(Math.hypot(nx, ny), Math.abs(nz)), deg(30), 1e-6, "face slope"); }
});

test("the surface height at a point: halfway up a 30° slope", () => {
  const sk = R.skeleton(rect(10000, 8000), [deg(30), null, deg(30), null]);
  near(R.surfaceZ(sk, G.P(5000, 2000)), 2000 * Math.tan(deg(30)), 1e-6);
  near(R.surfaceZ(sk, G.P(1, 4000)), 4000 * Math.tan(deg(30)), 1e-3);
  assert.equal(R.surfaceZ(sk, G.P(-10, -10)), null);
});

// ---- roof records: overhangs, attached walls, extrusion roofs, meshes
import { newProject } from "../../web/assets/sketch/model.js";
import { makeWall, wallHeights } from "../../web/assets/sketch/walls.js";
const lines = pts => pts.map((p, i) => ({ shape: "line", a: p, b: pts[(i + 1) % pts.length] }));
const solidVol = ss => ss.reduce((v, s) => { const A = Math.abs(G.polygonArea(s.poly)); if (!s.top) return v + A * (s.z1 - s.z0); const a2 = G.polygonArea(s.poly), c = s.poly.reduce((m, q, i) => { const w = s.poly[(i + 1) % s.poly.length], k = q.x * w.y - w.x * q.y; return { x: m.x + (q.x + w.x) * k / (6 * a2), y: m.y + (q.y + w.y) * k / (6 * a2) }; }, { x: 0, y: 0 }); return v + A * (R.planeZ(s.top, c) - s.z0); }, 0);

test("an overhang hangs below the base: the slope starts at the wall face", () => {
  const doc = newProject();
  const fp = [G.P(-600, -600), G.P(10600, -600), G.P(10600, 8600), G.P(-600, 8600)];
  const r = R.makeRoof(doc, { baseLevelId: "lv-1", baseOffset: 3000, boundary: lines(fp).map(e => ({ ...e, slope: deg(30), overhang: 600 })) });
  doc.roofs.push(r);
  near(R.undersideAt(doc, r, G.P(5000, 4000)), 3000 + 4000 * Math.tan(deg(30)), 1e-6, "ridge underside");
  near(R.undersideAt(doc, r, G.P(5000, 0)), 3000, 1e-6, "at the wall face");
  near(R.undersideAt(doc, r, G.P(5000, -600)), 3000 - 600 * Math.tan(deg(30)), 1e-6, "at the eave");
  const g = R.roofGeometry(doc, r);
  near(g.top, 3000 + 4000 * Math.tan(deg(30)) + 200 / Math.cos(deg(30)), 1e-6, "top of the roof");
  const m = R.roofMesh(doc, r);
  assert.ok(m.tris.length > 10 && m.edges.length > 10);
  // top and underside each cover the whole plan (no face lost where a quad closes to a triangle)
  const planA = m.tris.reduce((s, t) => s + Math.abs(G.polygonArea(t)), 0);
  near(planA, 2 * 11200 * 9200, 1, "top + underside plan area");
});

test("a gable wall attached to the roof rises to the underside and fills the gable", () => {
  const doc = newProject();
  const fp = [G.P(0, 0), G.P(10000, 0), G.P(10000, 8000), G.P(0, 8000)];
  const r = R.makeRoof(doc, { baseLevelId: "lv-1", baseOffset: 3000, boundary: lines(fp).map((e, i) => ({ ...e, definesSlope: i % 2 === 0, slope: deg(30) })) });
  doc.roofs.push(r);
  const w = makeWall(doc, { a: G.P(1000, 0), b: G.P(1000, 8000), typeId: "wt-int150", unconnectedHeight: 3000, baseLevelId: "lv-1" });
  doc.walls.push(w);
  assert.deepEqual(R.wallsUnderRoof(doc, r), [w.id]);
  w.attachTopTo = r.id;
  const h = wallHeights(doc, w);
  near(h.z1, 3000 + 4000 * Math.tan(deg(30)), 1, "wall reaches the ridge underside");
  const T = 150, poly = [G.P(1000 - T / 2, 0), G.P(1000 + T / 2, 0), G.P(1000 + T / 2, 8000), G.P(1000 - T / 2, 8000)];
  const cut = R.clipUnderRoof(doc, r, [{ poly, z0: 0, z1: h.z1 }], h.ownTop);
  near(solidVol(cut), T * (8000 * 3000 + 0.5 * 8000 * 4000 * Math.tan(deg(30))), 1e3, "rectangle plus gable triangle");
  // detached, it goes back to its own height
  delete w.attachTopTo; near(wallHeights(doc, w).z1, 3000, 1e-9);
});

test("roof by extrusion: a gable profile, 200 mm thick, cuts square to the slope", () => {
  const doc = newProject();
  const r = R.makeExtrusionRoof(doc, { baseLevelId: "lv-1", baseOffset: 3000, a: G.P(0, 0), b: G.P(10000, 0), profile: [{ s: 0, h: 0 }, { s: 5000, h: 2000 }, { s: 10000, h: 0 }], start: 0, end: 8000 });
  doc.roofs.push(r);
  const th = Math.atan(2000 / 5000);
  near(R.undersideAt(doc, r, G.P(5000, 4000)), 3000 + 2000 - 200 / Math.cos(th), 1e-6);
  near(R.roofGeometry(doc, r).top, 5000, 1e-9);
  assert.equal(R.roofGeometry(doc, r).lines.length, 1, "one ridge line");
  assert.ok(R.roofMesh(doc, r).tris.length >= 12);
});

test("flat roof with a fall from a slope arrow: 100 mm over 10 m", () => {
  const doc = newProject();
  const fp = [G.P(0, 0), G.P(10000, 0), G.P(10000, 8000), G.P(0, 8000)];
  const r = R.makeRoof(doc, { baseLevelId: "lv-1", baseOffset: 3000, boundary: lines(fp).map(e => ({ ...e, definesSlope: false })), slopeArrows: [{ tail: G.P(0, 4000), head: G.P(10000, 4000), tailHeight: 100, headHeight: 0 }] });
  near(R.undersideAt(doc, r, G.P(0, 1000)), 3100, 1e-6); near(R.undersideAt(doc, r, G.P(10000, 1000)), 3000, 1e-6);
  const flat = R.makeRoof(doc, { baseLevelId: "lv-1", baseOffset: 3000, boundary: lines(fp).map(e => ({ ...e, definesSlope: false })) });
  near(R.roofGeometry(doc, flat).top, 3200, 1e-9);
});
