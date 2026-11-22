// Object snaps, as in Revit/AutoCAD: endpoint, midpoint, intersection, centre, perpendicular,
// tangent, nearest and grid. Works on "curves": {type:"seg", a, b} or {type:"arc", c, r, start, sweep}.
import * as G from "./geom.js";

export const SNAP_KINDS = ["endpoint", "intersection", "centre", "midpoint", "perpendicular", "tangent", "nearest", "grid"];
const PRIORITY = { endpoint: 0, intersection: 0, centre: 1, midpoint: 1, perpendicular: 2, tangent: 2, nearest: 4, grid: 5 };

/** Shortcut overrides (one pick only), as typed in Revit. */
export const OVERRIDES = { SE: "endpoint", SM: "midpoint", SI: "intersection", SN: "nearest", SC: "centre", SP: "perpendicular", ST: "tangent", SO: "off" };

export function curveNear(cv, p) {
  if (cv.type === "seg") { const r = G.projectOnSegment(p, cv.a, cv.b); return { point: r.point, dist: r.dist }; }
  const r = G.nearestOnArc(cv, p);
  return { point: r.point, dist: r.dist };
}

function curveIntersections(c1, c2) {
  if (c1.type === "seg" && c2.type === "seg") { const h = G.segIntersect(c1.a, c1.b, c2.a, c2.b); return h ? [h.point] : []; }
  if (c1.type === "arc" && c2.type === "arc") {
    return G.circleCircle(c1.c, c1.r, c2.c, c2.r).filter(q => G.onArc(c1, G.angleOf(G.sub(q, c1.c))) && G.onArc(c2, G.angleOf(G.sub(q, c2.c))));
  }
  const s = c1.type === "seg" ? c1 : c2, a = c1.type === "seg" ? c2 : c1;
  return G.lineCircle(s.a, s.b, a.c, a.r).filter(h => h.t >= -1e-6 && h.t <= 1 + 1e-6 && G.onArc(a, G.angleOf(G.sub(h.point, a.c)))).map(h => h.point);
}

/**
 * Finds the best snap for cursor `p` (model mm).
 * opts: { radius (mm), from (last picked point or null), enabled: Set of kinds, override: kind|"off"|null, grid (mm) }
 * Returns { point, kind, curve? } or null.
 */
export function findSnap(p, curves, opts) {
  const { radius, from = null, enabled = new Set(SNAP_KINDS), override = null, grid = 0 } = opts;
  if (override === "off") return null;
  const allow = k => (override ? override === k : enabled.has(k));
  const near = curves.filter(cv => curveNear(cv, p).dist <= radius * 1.5 || (cv.type === "arc" && G.dist(cv.c, p) <= radius));
  const cands = [];
  const push = (point, kind, curve) => { const d = G.dist(point, p); if (d <= radius) cands.push({ point, kind, curve, d }); };

  for (const cv of near) {
    if (cv.type === "seg") {
      if (allow("endpoint")) { push(cv.a, "endpoint", cv); push(cv.b, "endpoint", cv); }
      if (allow("midpoint")) push(G.mid(cv.a, cv.b), "midpoint", cv);
      if (allow("perpendicular") && from) {
        const hit = G.projectOnSegment(from, cv.a, cv.b);
        if (hit.tRaw > 1e-6 && hit.tRaw < 1 - 1e-6 && hit.dist > 1) push(hit.point, "perpendicular", cv);
      }
    } else {
      if (allow("centre")) push(cv.c, "centre", cv);
      if (!G.isCircle(cv)) {
        if (allow("endpoint")) { push(G.arcStart(cv), "endpoint", cv); push(G.arcEnd(cv), "endpoint", cv); }
        if (allow("midpoint")) push(G.arcMid(cv), "midpoint", cv);
      }
      if (from && allow("perpendicular")) {
        const ang = G.angleOf(G.sub(from, cv.c));
        for (const a of [ang, ang + Math.PI]) if (G.onArc(cv, a)) push(G.arcPoint(cv, a), "perpendicular", cv);
      }
      if (from && allow("tangent")) for (const q of G.tangentPoints(cv.c, cv.r, from)) if (G.onArc(cv, G.angleOf(G.sub(q, cv.c)))) push(q, "tangent", cv);
    }
  }
  if (allow("intersection")) {
    for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) for (const q of curveIntersections(near[i], near[j])) push(q, "intersection", near[i]);
  }
  if (allow("nearest")) for (const cv of near) { const r = curveNear(cv, p); push(r.point, "nearest", cv); }
  if (cands.length) {
    cands.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.d - b.d);
    // a much closer lower-priority snap (e.g. midpoint right under the cursor) still wins over a far endpoint
    const best = cands.reduce((acc, c) => (PRIORITY[c.kind] < 4 && c.d < acc.d * 0.35 ? c : acc), cands[0]);
    return { point: { x: best.point.x, y: best.point.y }, kind: best.kind, curve: best.curve };
  }
  if (grid > 0 && allow("grid")) {
    const q = { x: G.round(p.x, grid), y: G.round(p.y, grid) };
    if (G.dist(q, p) <= radius) return { point: q, kind: "grid" };
  }
  return null;
}
