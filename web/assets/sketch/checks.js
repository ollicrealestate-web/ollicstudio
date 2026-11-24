// Automatic checks for added details (enforced in code, for the assistant and for hand use alike):
// no blocking a door or window, no cutting through floors, roofs, walls or other parts, nothing floating,
// nothing above the 40 m limit. Each check throws a plain-words reason.
import * as G from "./geom.js";
import * as S from "./solids.js";
import { MAX_HEIGHT_MM } from "./model.js";
import { wallFootprints, extSign } from "./walls.js";
import { wallSolids, openingFrame, isDoor } from "./openings.js";
import { floorParts, floorLoops, floorLevels } from "./floors.js";
import { roofGeometry, planeZ } from "./roofs.js";
import { extrusionPrisms } from "./components.js";
import { detailParts } from "./details.js";

const PEN = 15;  // mm a part may press into another solid (touching faces, rounding)
const GAP = 5;   // mm: closer than this counts as attached

/** Upright boxes { poly, z0, z1 } that cover a part (sweeps: one box per straight run). */
export function partBoxes(part) {
  if (part.poly) return [{ poly: part.poly, z0: part.z0, z1: part.z1 }];
  const { rings } = part.sweep, out = [];
  for (let i = 0; i + 1 < rings.length; i++) {
    const pts = [...rings[i], ...rings[i + 1]], a = rings[i][0], b = rings[i + 1][0];
    let u = G.norm(G.sub(b, a)); if (!Number.isFinite(u.x) || G.len(G.sub(b, a)) < 1e-6) continue;
    const n = G.perp(u), ss = pts.map(p => G.dot(G.sub(p, a), u)), ts = pts.map(p => G.dot(G.sub(p, a), n)), zs = pts.map(p => p.z);
    const s0 = Math.min(...ss), s1 = Math.max(...ss), t0 = Math.min(...ts), t1 = Math.max(...ts);
    const P = (s, t) => G.add(G.add(a, G.mul(u, s)), G.mul(n, t));
    out.push({ poly: [P(s0, t0), P(s1, t0), P(s1, t1), P(s0, t1)], z0: Math.min(...zs), z1: Math.max(...zs) });
  }
  return out;
}

/** Everything solid in the model except the given ids: [{ id, what, poly, z0, z1 }] plus roof faces. */
export function modelSolids(doc, skip = new Set()) {
  const out = [], roofs = [];
  const fps = new Map(); for (const l of doc.levels) for (const [id, f] of wallFootprints(doc, l.id)) fps.set(id, f);
  for (const w of doc.walls) { if (skip.has(w.id) || !fps.has(w.id)) continue; try { for (const s of wallSolids(doc, w, fps.get(w.id))) out.push({ id: w.id, what: "wall", ...s }); } catch { /* skip */ } }
  for (const f of doc.floors) { if (skip.has(f.id)) continue; const { top, bottom } = floorLevels(doc, f); for (const p of floorParts(floorLoops(f))) out.push({ id: f.id, what: "floor", poly: p.outer, z0: bottom, z1: top }); }
  for (const r of doc.roofs) { if (skip.has(r.id)) continue; try { const g = roofGeometry(doc, r); for (const fc of g.faces) roofs.push({ id: r.id, what: "roof", face: fc, poly: fc.pts.map(p => G.P(p.x, p.y)), z0: Math.min(...fc.pts.map(p => p.z)), z1: Math.max(...fc.pts.map(p => p.z)) + fc.thick }); } catch { /* skip */ } }
  for (const c of doc.components) { if (skip.has(c.id) || c.kind !== "extrusion" || c.isVoid || c.plane) continue; try { for (const p of extrusionPrisms(doc, c)) out.push({ id: c.id, what: "component", ...p }); } catch { /* skip */ } }
  for (const d of doc.details || []) { if (skip.has(d.id)) continue; for (const p of detailParts(doc, d)) for (const b of partBoxes(p)) out.push({ id: d.id, what: d.kind === "cladding" ? "cladding" : "detail", ...b }); }
  return { solids: out, roofs };
}

/** The space in front of and behind each door and window that must stay clear. */
export function openingZones(doc) {
  const out = [];
  for (const o of doc.openings) {
    const f = openingFrame(doc, o); if (!f) continue;
    const ext = G.mul(f.ax.n, extSign(f.w)), a = G.add(f.ax.c0, G.mul(f.ax.u, f.s0)), b = G.add(f.ax.c0, G.mul(f.ax.u, f.s1));
    out.push({ id: o.id, what: isDoor(o) ? "door" : "window", poly: [G.add(a, G.mul(ext, -f.ax.h - 300)), G.add(b, G.mul(ext, -f.ax.h - 300)), G.add(b, G.mul(ext, f.ax.h + 600)), G.add(a, G.mul(ext, f.ax.h + 600))], z0: f.zSill, z1: f.zHead });
  }
  return out;
}

// ---- geometry of overlaps
function clipConvex(poly, tri) {
  const c = G.polygonArea(tri) < 0 ? [...tri].reverse() : tri;
  let p = poly;
  for (let i = 0; i < c.length && p; i++) { const a = c[i], b = c[(i + 1) % c.length], inward = G.perp(G.norm(G.sub(b, a))); p = S.clipHalf(p, a, G.mul(inward, -1), 0); }
  return p;
}
/** How far box A presses into box B: the smaller of the height overlap and the plan overlap's width (mm). */
export function penetration(A, B) {
  const zo = Math.min(A.z1, B.z1) - Math.max(A.z0, B.z0);
  if (zo <= 0) return 0;
  let width = 0;
  for (const t of S.triangulate(B.poly)) {
    const piece = clipConvex(A.poly, t); if (!piece) continue;
    const area = Math.abs(G.polygonArea(piece)); let diam = 0;
    for (const p of piece) for (const q of piece) diam = Math.max(diam, G.dist(p, q));
    if (diam > 0) width = Math.max(width, area / diam);
  }
  return Math.min(zo, width);
}
function planGap(A, B) {
  if (A.some(p => G.pointInPolygon(p, B)) || B.some(p => G.pointInPolygon(p, A))) return 0;
  let d = Infinity;
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
    const a = A[i], a2 = A[(i + 1) % A.length], b = B[j], b2 = B[(j + 1) % B.length];
    if (G.segIntersect(a, a2, b, b2)) return 0;
    d = Math.min(d, G.projectOnSegment(a, b, b2).dist, G.projectOnSegment(b, a, a2).dist);
  }
  return d;
}
const boxGap = (A, B) => Math.hypot(Math.max(0, A.z0 - B.z1, B.z0 - A.z1), planGap(A.poly, B.poly));
/** Sample points well inside a box (so touching faces do not count). */
function samples(A) {
  const c = A.poly.reduce((s, p) => G.add(s, G.mul(p, 1 / A.poly.length)), G.P(0, 0));
  const pts = [c, ...A.poly.map(p => G.lerp(p, c, Math.min(0.9, 20 / Math.max(1, G.dist(p, c)))))];
  const zs = A.z1 - A.z0 > 2 * PEN ? [A.z0 + PEN, (A.z0 + A.z1) / 2, A.z1 - PEN] : [(A.z0 + A.z1) / 2];
  return pts.flatMap(p => zs.map(z => ({ ...p, z })));
}
/** Does box b touch a roof face (checked along its outline, at the roof's height there)? */
function roofTouch(b, r) {
  const pts = b.poly.flatMap((p, i) => { const q = b.poly[(i + 1) % b.poly.length]; return Array.from({ length: 10 }, (_, k) => G.lerp(p, q, k / 10)); });
  for (const p of pts) {
    let q = p;
    if (!G.pointInPolygon(p, r.poly)) { let best = Infinity; r.poly.forEach((a, i) => { const pr = G.projectOnSegment(p, a, r.poly[(i + 1) % r.poly.length]); if (pr.dist < best) { best = pr.dist; q = pr.point; } }); if (best > GAP) continue; }
    const under = planeZ(r.face.plane, q);
    if (Math.max(0, under - b.z1, b.z0 - (under + r.face.thick)) <= GAP) return true;
  }
  return false;
}
const NAMES = { wall: "a wall", floor: "a floor slab", roof: "the roof", component: "a component", detail: "another added part", cladding: "cladding" };

/**
 * Checks a new or changed element (its parts) against the model. `skip` holds ids to ignore (the element itself).
 * Throws a plain-words reason for the first problem found.
 */
export function checkParts(doc, parts, { id, kind, skip = new Set() } = {}) {
  const boxes = parts.flatMap(partBoxes);
  if (!boxes.length) throw new Error("It has no shape.");
  const top = Math.max(...boxes.map(b => b.z1));
  if (top > MAX_HEIGHT_MM + 0.5) throw new Error(`It would reach ${(top / 1000).toFixed(2)} m; the building height limit is 40 m.`);
  const ign = new Set([...skip, id].filter(Boolean));
  // 1. doors and windows stay clear
  for (const z of openingZones(doc)) for (const b of boxes) if (penetration(b, z) > 5) throw new Error(`It blocks ${z.what} ${z.id}. Keep it clear of the opening (move it, shorten it, or put it above or below the opening).`);
  const { solids, roofs } = modelSolids(doc, ign);
  // 2. no cutting through walls, floors, components or other added parts (cladding may touch everything)
  for (const s of solids) {
    if (kind === "cladding" || s.what === "cladding") { if (s.what === "wall" || s.what === "floor" || s.what === "cladding") continue; }
    for (const b of boxes) { const p = penetration(b, s); if (p > PEN) throw new Error(`It cuts ${Math.round(p)} mm into ${NAMES[s.what]} (${s.id}). Move it so it sits against it instead.`); }
  }
  // 3. roofs: points inside the roof slab
  for (const r of roofs) for (const b of boxes) for (const p of samples(b)) {
    if (!G.pointInPolygon(p, r.poly)) continue;
    const under = planeZ(r.face.plane, p);
    if (p.z > under + PEN && p.z < under + r.face.thick - PEN) throw new Error(`It cuts through the roof (${r.id}). Put it below or on top of the roof.`);
  }
  // 4. attached: some part touches a wall, floor, roof, other part or the ground
  const ground = Math.min(...doc.levels.map(l => l.elevation));
  const touches = boxes.some(b => b.z0 <= ground + GAP)
    || solids.some(s => boxes.some(b => boxGap(b, s) <= GAP))
    || roofs.some(r => boxes.some(b => boxGap(b, r) <= GAP && roofTouch(b, r)));
  if (!touches) throw new Error("It would float: no part of it touches a wall, floor, roof, the ground or another part. Attach it to something.");
}
