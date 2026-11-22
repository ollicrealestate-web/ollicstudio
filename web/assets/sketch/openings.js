// Doors and windows: always hosted in a straight wall. Position is the distance from the wall's start
// (along its location line) to the centre of the opening. Geometry is cut from the wall, never stored.
import * as G from "./geom.js";
import { newId } from "./model.js";
import { wallHeights, wallType, centrePolyline } from "./walls.js";

export const isDoor = o => o.kind === "door";
export function openingType(doc, o) { return (isDoor(o) ? doc.doorTypes : doc.windowTypes).find(t => t.id === o.typeId) || (isDoor(o) ? doc.doorTypes[0] : doc.windowTypes[0]); }
export const hostOf = (doc, o) => doc.walls.find(w => w.id === o.hostWallId);

/** Type mark shown in tags and schedules: D1, D2 … for doors and W1, W2 … for windows, by type order. */
export function typeMark(doc, o) {
  const list = isDoor(o) ? doc.doorTypes : doc.windowTypes;
  const t = openingType(doc, o);
  return t.mark || `${isDoor(o) ? "D" : "W"}${list.indexOf(t) + 1}`;
}

export function makeOpening(doc, kind, typeId, hostWallId, position, extra = {}) {
  const t = (kind === "door" ? doc.doorTypes : doc.windowTypes).find(x => x.id === typeId);
  return { id: newId(kind === "door" ? "dr" : "wn"), kind, typeId, hostWallId, positionAlongWall: position, sillHeight: kind === "door" ? 0 : (t?.sill ?? 900), flipFacing: false, flipHand: false, ...extra };
}

/** Axis of a straight host wall: centreline start, unit direction, left normal, length, half thickness. */
export function wallAxis(doc, w) {
  const type = wallType(doc, w), c = centrePolyline(w, type);
  const u = G.norm(G.sub(c[1], c[0]));
  return { c0: c[0], u, n: G.perp(u), L: G.dist(w.a, w.b), h: type.thickness / 2 };
}

/** Plan and height extents of an opening. */
export function openingFrame(doc, o) {
  const w = hostOf(doc, o);
  if (!w || w.shape !== "line") return null;
  const t = openingType(doc, o), ax = wallAxis(doc, w), { z0 } = wallHeights(doc, w);
  const s0 = o.positionAlongWall - t.width / 2, s1 = o.positionAlongWall + t.width / 2;
  const at = s => G.add(ax.c0, G.mul(ax.u, s));
  const corners = [G.add(at(s0), G.mul(ax.n, ax.h)), G.add(at(s1), G.mul(ax.n, ax.h)), G.sub(at(s1), G.mul(ax.n, ax.h)), G.sub(at(s0), G.mul(ax.n, ax.h))];
  return { w, t, ax, s0, s1, mid: at(o.positionAlongWall), corners, zSill: z0 + o.sillHeight, zHead: z0 + o.sillHeight + t.height };
}

/** Throws a plain-words error when an opening does not fit its wall. */
export function checkOpening(doc, o) {
  const w = hostOf(doc, o);
  const name = isDoor(o) ? "door" : "window";
  if (!w) throw new Error(`This ${name} has no wall.`);
  if (w.shape !== "line") throw new Error(`Doors and windows go in straight walls in this version.`);
  const t = openingType(doc, o), L = G.dist(w.a, w.b), { z0, z1 } = wallHeights(doc, w);
  if (o.positionAlongWall - t.width / 2 < -0.5 || o.positionAlongWall + t.width / 2 > L + 0.5) throw new Error(`The ${name} (${t.width} mm wide) does not fit within the wall's length of ${Math.round(L)} mm.`);
  if (o.sillHeight < 0) throw new Error(`The ${name}'s sill cannot be below its level.`);
  if (z0 + o.sillHeight + t.height > z1 + 0.5) throw new Error(`The ${name} (${t.height} mm high${o.sillHeight ? ` on a ${o.sillHeight} mm sill` : ""}) is taller than the wall (${Math.round(z1 - z0)} mm).`);
  for (const other of doc.openings) {
    if (other.id === o.id || other.hostWallId !== o.hostWallId) continue;
    const ot = openingType(doc, other);
    const gap = Math.abs(other.positionAlongWall - o.positionAlongWall) - (ot.width + t.width) / 2;
    const zOverlap = Math.min(o.sillHeight + t.height, other.sillHeight + ot.height) - Math.max(o.sillHeight, other.sillHeight);
    if (gap < -0.5 && zOverlap > 0) throw new Error(`The ${name} overlaps another opening in the same wall.`);
  }
}

/** After a wall's start point moves (stretch or trim), keeps its openings where they were in space. */
export function keepOpeningsInPlace(doc, before) {
  for (const o of doc.openings) {
    const w = hostOf(doc, o), b = before.get(o.hostWallId);
    if (!w || !b || w.shape !== "line") continue;
    const lenBefore = G.dist(b.a, b.b), lenNow = G.dist(w.a, w.b);
    if (Math.abs(lenBefore - lenNow) < 0.01 || G.dist(b.a, w.a) < 0.01) continue; // moved as a whole, or only the end moved
    const u = G.norm(G.sub(w.b, w.a));
    o.positionAlongWall += G.dot(G.sub(b.a, w.a), u);
  }
}

// --------------------------------------------------------------------------- cutting the wall
/** Clips a polygon to s >= lo and s <= hi, where s = dot(p - origin, u) (Sutherland–Hodgman). */
export function clipBand(poly, origin, u, lo, hi) {
  const s = p => G.dot(G.sub(p, origin), u);
  const clip = (pts, keep, cross) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], ka = keep(a), kb = keep(b);
      if (ka) out.push(a);
      if (ka !== kb) { const sa = s(a), sb = s(b), t = (cross - sa) / (sb - sa); out.push(G.lerp(a, b, t)); }
    }
    return out;
  };
  let pts = poly;
  if (lo > -Infinity) pts = clip(pts, p => s(p) >= lo - 1e-9, lo);
  if (pts.length && hi < Infinity) pts = clip(pts, p => s(p) <= hi + 1e-9, hi);
  return pts.length >= 3 && Math.abs(G.polygonArea(pts)) > 1e-6 ? pts : null;
}

/**
 * Splits a wall's footprint into solids for 3D: full-height parts between openings, and the parts
 * below each sill and above each head. Returns [{ poly, z0, z1 }].
 */
export function wallSolids(doc, w, fp) {
  const { z0, z1 } = wallHeights(doc, w);
  const ops = doc.openings.filter(o => o.hostWallId === w.id).map(o => openingFrame(doc, o)).filter(Boolean).sort((a, b) => a.s0 - b.s0);
  if (!ops.length || w.shape !== "line") return fp.pieces.map(poly => ({ poly, z0, z1 }));
  const { c0, u } = ops[0].ax;
  const out = [];
  for (const piece of fp.pieces) {
    let cursor = -Infinity;
    for (const f of ops) {
      const full = clipBand(piece, c0, u, cursor, f.s0); if (full) out.push({ poly: full, z0, z1 });
      const mid = clipBand(piece, c0, u, f.s0, f.s1);
      if (mid) {
        if (f.zSill > z0 + 0.5) out.push({ poly: mid, z0, z1: Math.min(z1, f.zSill) });
        if (f.zHead < z1 - 0.5) out.push({ poly: mid, z0: Math.max(z0, f.zHead), z1 });
      }
      cursor = f.s1;
    }
    const last = clipBand(piece, c0, u, cursor, Infinity); if (last) out.push({ poly: last, z0, z1 });
  }
  return out;
}

/** Plan pieces of a wall cut at height cutZ: openings that pass through the cut plane leave gaps. */
export function wallPlanPieces(doc, w, fp, cutZ) {
  const ops = doc.openings.filter(o => o.hostWallId === w.id).map(o => openingFrame(doc, o)).filter(f => f && f.zSill <= cutZ && f.zHead >= cutZ).sort((a, b) => a.s0 - b.s0);
  if (!ops.length) return fp.pieces;
  const { c0, u } = ops[0].ax;
  const out = [];
  for (const piece of fp.pieces) {
    let cursor = -Infinity;
    for (const f of ops) { const part = clipBand(piece, c0, u, cursor, f.s0); if (part) out.push(part); cursor = f.s1; }
    const last = clipBand(piece, c0, u, cursor, Infinity); if (last) out.push(last);
  }
  return out;
}

/** Volume of a list of solids (mm³). */
export const solidsVolume = solids => solids.reduce((v, s) => v + Math.abs(G.polygonArea(s.poly)) * (s.z1 - s.z0), 0);
