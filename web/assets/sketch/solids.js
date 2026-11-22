// Vertical prisms ({ poly, z0, z1 }) and the cuts the model needs: by height, by a half-plane
// (reveals), and by void extrusions (any profile, split into convex pieces). Plus sweeps along a path.
import * as G from "./geom.js";

/** Keeps the part of a polygon where dot(p - origin, n) <= max (Sutherland–Hodgman, one half-plane). */
export function clipHalf(poly, origin, n, max) {
  const s = p => G.dot(G.sub(p, origin), n);
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], sa = s(a), sb = s(b);
    if (sa <= max + 1e-9) out.push(a);
    if ((sa <= max) !== (sb <= max)) out.push(G.lerp(a, b, (max - sa) / (sb - sa)));
  }
  return out.length >= 3 && Math.abs(G.polygonArea(out)) > 1e-6 ? out : null;
}

const ccw = poly => (G.polygonArea(poly) < 0 ? [...poly].reverse() : poly);

/** Splits a simple polygon into triangles (ear clipping). */
export function triangulate(poly) {
  // repeated points (a quad that has closed to a triangle) would stop every ear from being found
  const pts = ccw(poly).map(p => ({ x: p.x, y: p.y })).filter((p, i, a) => G.dist(p, a[(i + 1) % a.length]) > 1e-6);
  if (pts.length < 3) return [];
  const tris = [];
  const isEar = (i, idx) => {
    const a = pts[idx[(i - 1 + idx.length) % idx.length]], b = pts[idx[i]], c = pts[idx[(i + 1) % idx.length]];
    if (G.cross(G.sub(b, a), G.sub(c, b)) <= 1e-9) return false;
    for (const k of idx) { const p = pts[k]; if (p === a || p === b || p === c) continue; if (G.pointInPolygon(p, [a, b, c])) return false; }
    return true;
  };
  const idx = pts.map((_, i) => i);
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) if (isEar(i, idx)) { tris.push([pts[idx[(i - 1 + idx.length) % idx.length]], pts[idx[i]], pts[idx[(i + 1) % idx.length]]]); idx.splice(i, 1); cut = true; break; }
    if (!cut) break; // degenerate: give up on the rest
  }
  if (idx.length === 3) tris.push(idx.map(k => pts[k]));
  return tris;
}

/** subject minus a convex polygon, as disjoint pieces. */
export function subtractConvex(subject, convex) {
  const c = ccw(convex), pieces = [];
  let rest = subject;
  for (let i = 0; i < c.length && rest; i++) {
    const a = c[i], b = c[(i + 1) % c.length];
    const n = G.perp(G.norm(G.sub(b, a))); // inward normal for a ccw polygon
    // the part outside this edge is outside the convex polygon: keep it; continue with the part inside
    const outside = clipHalf(rest, a, n, 0);
    if (outside) pieces.push(outside);
    rest = clipHalf(rest, a, G.mul(n, -1), 0);
  }
  return pieces;
}

/** subject minus any simple polygon (split into triangles, subtracted one by one). */
export function subtractPolygon(subjectPieces, poly) {
  let pieces = subjectPieces;
  for (const t of triangulate(poly)) pieces = pieces.flatMap(p => subtractConvex(p, t));
  return pieces;
}

/** Cuts prisms by void prisms (each { polys, z0, z1 }). */
export function applyVoids(solids, voids) {
  let out = solids;
  for (const v of voids) {
    const next = [];
    for (const s of out) {
      const lo = Math.max(s.z0, v.z0), hi = Math.min(s.z1, v.z1);
      if (hi - lo < 0.5) { next.push(s); continue; }
      if (lo > s.z0 + 0.5) next.push({ ...s, z1: lo });
      if (hi < s.z1 - 0.5) next.push({ ...s, z0: hi });
      let pieces = [s.poly];
      for (const p of v.polys) pieces = subtractPolygon(pieces, p);
      for (const p of pieces) next.push({ ...s, poly: p, z0: lo, z1: hi });
    }
    out = next;
  }
  return out;
}

/** Cuts a band (z0..z1) of depth d into the face of prisms: keeps dot(p - origin, n) <= max within the band. */
export function applyReveal(solids, r) {
  const out = [];
  for (const s of solids) {
    const lo = Math.max(s.z0, r.z0), hi = Math.min(s.z1, r.z1);
    if (hi - lo < 0.5) { out.push(s); continue; }
    if (lo > s.z0 + 0.5) out.push({ ...s, z1: lo });
    if (hi < s.z1 - 0.5) out.push({ ...s, z0: hi });
    const kept = clipHalf(s.poly, r.origin, r.n, r.max);
    if (kept) out.push({ ...s, poly: kept, z0: lo, z1: hi });
  }
  return out;
}

export const prismVolume = solids => solids.reduce((v, s) => v + Math.abs(G.polygonArea(s.poly)) * (s.z1 - s.z0), 0);

// --------------------------------------------------------------------------- sweeps
/**
 * Places a profile along a horizontal path (points at height z). Profile points are {x, y}:
 * x across the path (positive to the left of the direction of travel), y up. Corners are mitred.
 * Returns rings: for each path point, the profile's 3D points [{x, y, z}] (plan x/y, height z).
 */
export function sweepRings(path, z, profile, closed = false) {
  const n = path.length, rings = [];
  for (let i = 0; i < n; i++) {
    const prev = closed ? path[(i - 1 + n) % n] : path[Math.max(0, i - 1)], next = closed ? path[(i + 1) % n] : path[Math.min(n - 1, i + 1)];
    const dIn = i === 0 && !closed ? null : G.norm(G.sub(path[i], prev));
    const dOut = i === n - 1 && !closed ? null : G.norm(G.sub(next, path[i]));
    const nIn = dIn && G.perp(dIn), nOut = dOut && G.perp(dOut);
    let m, k = 1;
    if (nIn && nOut) { m = G.norm(G.add(nIn, nOut)); const c = G.dot(m, nOut); k = 1 / Math.max(0.2, c); }
    else m = nIn || nOut;
    rings.push(profile.map(q => ({ x: path[i].x + m.x * q.x * k, y: path[i].y + m.y * q.x * k, z: z + q.y })));
  }
  if (closed) rings.push(rings[0]);
  return rings;
}

/** Volume of a straight-segment sweep (profile area times the length of the path through its centroid). */
export function sweepVolume(path, profile, closed = false) {
  const A = Math.abs(G.polygonArea(profile));
  const cx = profile.reduce((s, p, i) => { const q = profile[(i + 1) % profile.length]; return s + (p.x + q.x) * (p.x * q.y - q.x * p.y); }, 0) / (6 * G.polygonArea(profile));
  // the centroid line is the path offset by cx: its length changes by the turn at each corner
  let L = 0; const n = path.length, segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) L += G.dist(path[i], path[(i + 1) % n]);
  let turn = 0;
  const corners = closed ? n : n - 2;
  for (let c = 0; c < corners; c++) {
    const i = closed ? c : c + 1;
    const a = path[(i - 1 + n) % n], b = path[i], d = path[(i + 1) % n];
    const t = Math.atan2(G.cross(G.sub(b, a), G.sub(d, b)), G.dot(G.sub(b, a), G.sub(d, b)));
    turn += 2 * Math.tan(t / 2);
  }
  return A * (L - cx * turn);
}
