// Walls: footprints computed from the model with clean joins.
// - Ends that meet at one point (L, Y, + of wall ends) are mitred round a shared hub, so the pieces
//   tile exactly, even with different thicknesses.
// - An end that stops on another wall (T) is trimmed to that wall's face; the other wall runs through.
// - Walls that cross (X): the lower-priority wall is cut where it passes through the other.
// Nothing here is stored: it is all recomputed from the walls' location lines and types.
import * as G from "./geom.js";
import { newId, MAX_HEIGHT_MM } from "./model.js";

export const LOCATION_LINES = {
  "wall-centre": "Wall Centreline",
  "core-centre": "Core Centreline",
  "finish-ext": "Finish Face: Exterior",
  "finish-int": "Finish Face: Interior",
  "core-ext": "Core Face: Exterior",
  "core-int": "Core Face: Interior",
};

const JOIN_TOL = 2; // mm: wall ends closer than this are joined

export function wallType(doc, w) { return doc.wallTypes.find(t => t.id === w.typeId) || doc.wallTypes[0]; }

/**
 * Offset of the wall centreline from its location line, measured towards the exterior side.
 * The exterior side is left of the drawing direction (draw clockwise and it ends up outside), or right if flipped.
 */
export function centreOffset(w, type) {
  const t = type.thickness, c = type.core ?? t;
  switch (w.locationLine) {
    case "finish-ext": return -t / 2;
    case "finish-int": return t / 2;
    case "core-ext": return -c / 2;
    case "core-int": return c / 2;
    default: return 0; // wall and core centrelines coincide: layers are symmetric
  }
}

export const extSign = w => (w.flipped ? -1 : 1);

/** Location line as a polyline (arcs are sampled finely enough for clean joins). */
export function locationPolyline(w) {
  if (w.shape === "arc") {
    const n = Math.max(6, Math.ceil(Math.abs(w.sweep) / (Math.PI / 36)));
    return Array.from({ length: n + 1 }, (_, k) => G.arcPoint(w, w.start + (w.sweep * k) / n));
  }
  return [w.a, w.b];
}

/** Offsets a polyline to the left by d (mitred inner joints). */
export function offsetPolyline(pts, d) {
  if (pts.length < 2 || Math.abs(d) < 1e-9) return pts.map(p => ({ ...p }));
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const n = G.perp(G.norm(G.sub(pts[i + 1], pts[i])));
    segs.push([G.add(pts[i], G.mul(n, d)), G.add(pts[i + 1], G.mul(n, d))]);
  }
  const out = [segs[0][0]];
  for (let i = 0; i < segs.length - 1; i++) {
    const hit = G.lineIntersect(segs[i][0], segs[i][1], segs[i + 1][0], segs[i + 1][1]);
    out.push(hit ? hit.point : segs[i][1]);
  }
  out.push(segs[segs.length - 1][1]);
  return out;
}

export function centrePolyline(w, type) {
  const off = centreOffset(w, type) * extSign(w);
  return offsetPolyline(locationPolyline(w), off);
}

export function levelElevation(doc, id) { return doc.levels.find(l => l.id === id)?.elevation ?? 0; }

export function wallHeights(doc, w) {
  const z0 = levelElevation(doc, w.baseLevelId) + (w.baseOffset || 0);
  // Attach Top: the wall stops at the underside of a floor (or later a roof)
  const fl = w.attachTopTo && (doc.floors || []).find(f => f.id === w.attachTopTo);
  if (fl) {
    const t = doc.floorTypes.find(x => x.id === fl.typeId) || doc.floorTypes[0];
    return { z0, z1: levelElevation(doc, fl.levelId) + (fl.heightOffset || 0) - t.thickness };
  }
  // Top Offset applies when the top is constrained to a level, as in Revit
  const z1 = w.topLevelId && doc.levels.some(l => l.id === w.topLevelId)
    ? levelElevation(doc, w.topLevelId) + (w.topOffset || 0)
    : z0 + (w.unconnectedHeight || 3000);
  return { z0, z1 };
}

export function wallLength(w) { return w.shape === "arc" ? G.arcLength(w) : G.dist(w.a, w.b); }

export function makeWall(doc, init) {
  return {
    id: newId("wl"), typeId: init.typeId || "wt-ext225", shape: init.shape || "line",
    ...(init.shape === "arc" ? { c: { ...init.c }, r: init.r, start: init.start, sweep: init.sweep } : { a: { ...init.a }, b: { ...init.b } }),
    locationLine: init.locationLine || "wall-centre",
    baseLevelId: init.baseLevelId, baseOffset: init.baseOffset || 0,
    topLevelId: init.topLevelId || null, unconnectedHeight: init.unconnectedHeight ?? 3000, topOffset: init.topOffset || 0,
    flipped: !!init.flipped, roomBounding: init.roomBounding ?? true, structural: !!init.structural,
  };
}

/** Throws a plain-words error when a wall's heights make no sense or pass the 40 m limit. */
export function checkWall(doc, w) {
  const { z0, z1 } = wallHeights(doc, w);
  if (z1 <= z0 + 1) throw new Error("The wall's top must be above its base. Check Top Constraint and Top Offset.");
  if (z1 > MAX_HEIGHT_MM) throw new Error(`That wall would reach ${(z1 / 1000).toFixed(3)} m. The building height limit is 40 m.`);
  if (wallLength(w) < 10) throw new Error("A wall must be at least 10 mm long.");
}

// --------------------------------------------------------------------------- footprints
const priority = (doc, w, idx) => {
  const t = wallType(doc, w);
  return (t.function === "exterior" ? 1e9 : 0) + t.thickness * 1e4 - idx;
};

function lineHit(p1, d1, p2, d2) {
  const h = G.lineIntersect(p1, G.add(p1, d1), p2, G.add(p2, d2));
  return h ? h.point : null;
}

/**
 * Computes the plan footprint of every wall on a level (or all walls).
 * Returns Map(wallId -> { pieces: [[points]], centre: [points], h, z0, z1, type }).
 */
export function wallFootprints(doc, levelId = null) {
  const walls = doc.walls.filter(w => !levelId || w.baseLevelId === levelId);
  const info = walls.map((w, idx) => {
    const type = wallType(doc, w);
    const centre = centrePolyline(w, type);
    const loc = locationPolyline(w);
    const n = centre.length;
    return {
      w, idx, type, h: type.thickness / 2, centre, loc,
      u0: G.norm(G.sub(centre[1], centre[0])), u1: G.norm(G.sub(centre[n - 1], centre[n - 2])),
      prio: priority(doc, w, idx), caps: [null, null], cuts: [],
    };
  });

  // ---- ends that share a point (location endpoints, or centreline endpoints) ----
  const ends = [];
  info.forEach(I => {
    ends.push({ I, at: 0, loc: I.loc[0], q: I.centre[0], d: I.u0 });
    ends.push({ I, at: 1, loc: I.loc[I.loc.length - 1], q: I.centre[I.centre.length - 1], d: G.mul(I.u1, -1) });
  });
  const used = new Set();
  for (let i = 0; i < ends.length; i++) {
    if (used.has(i)) continue;
    const group = [i];
    for (let j = i + 1; j < ends.length; j++) {
      if (used.has(j) || ends[j].I === ends[i].I) continue;
      if (G.dist(ends[i].loc, ends[j].loc) <= JOIN_TOL || G.dist(ends[i].q, ends[j].q) <= JOIN_TOL) group.push(j);
    }
    if (group.length < 2) continue;
    group.forEach(k => used.add(k));
    const g = group.map(k => ends[k]).map(e => ({ ...e, ang: G.angleOf(e.d) }));
    g.sort((a, b) => a.ang - b.ang);
    const corners = g.map(() => ({ left: null, right: null }));
    for (let k = 0; k < g.length; k++) {
      const A = g[k], B = g[(k + 1) % g.length];
      const nA = G.perp(A.d), nB = G.perp(B.d);
      const pA = G.add(A.q, G.mul(nA, A.I.h)), pB = G.sub(B.q, G.mul(nB, B.I.h));
      let gap = G.wrap(B.ang - A.ang); if (g.length === 1) gap = G.TAU;
      let pt = Math.abs(Math.sin(gap)) > 1e-3 ? lineHit(pA, A.d, pB, B.d) : null;
      // very sharp or straight-through junctions: square ends rather than long spikes
      const limit = 6 * Math.max(A.I.h, B.I.h);
      if (pt && (G.dist(pt, A.q) > limit || G.dist(pt, B.q) > limit)) pt = null;
      corners[k].left = pt || pA;
      corners[(k + 1) % g.length].right = pt || pB;
    }
    const all = corners.flatMap(c => [c.left, c.right]);
    const hub = { x: all.reduce((s, p) => s + p.x, 0) / all.length, y: all.reduce((s, p) => s + p.y, 0) / all.length };
    g.forEach((e, k) => { e.I.caps[e.at] = { right: corners[k].right, left: corners[k].left, hub }; });
  }

  // ---- ends that stop on another wall (T): trim to that wall's face ----
  for (let i = 0; i < ends.length; i++) {
    if (used.has(i)) continue;
    const e = ends[i];
    let best = null;
    for (const O of info) {
      if (O === e.I) continue;
      for (let s = 0; s < O.centre.length - 1; s++) {
        const a = O.centre[s], b = O.centre[s + 1];
        const pr = G.projectOnSegment(e.loc, a, b), prq = G.projectOnSegment(e.q, a, b);
        const near = Math.min(pr.dist, prq.dist);
        const segLen = G.dist(a, b);
        const along = (prq.tRaw ?? prq.t) * segLen;
        const inside = O.centre.length > 2 ? along >= -1 && along <= segLen + 1 : along > O.h * 0.5 && along < segLen - O.h * 0.5;
        if (near <= O.h + JOIN_TOL && inside && (!best || near < best.near)) best = { O, a, b, near };
      }
    }
    if (!best) continue;
    const nO = G.perp(G.norm(G.sub(best.b, best.a)));
    const side = Math.sign(G.dot(e.d, nO)) || 1; // which side of the other wall this wall's body lies on
    const fa = G.add(best.a, G.mul(nO, best.O.h * side)), fdir = G.sub(best.b, best.a);
    const n = G.perp(e.d);
    const left = lineHit(G.add(e.q, G.mul(n, e.I.h)), e.d, fa, fdir);
    const right = lineHit(G.sub(e.q, G.mul(n, e.I.h)), e.d, fa, fdir);
    if (left && right) { e.I.caps[e.at] = { left, right, hub: null }; used.add(i); }
  }

  // ---- walls that cross (X): cut the lower-priority straight wall where it passes through ----
  for (const A of info) for (const B of info) {
    if (A === B || A.w.shape !== "line" || B.w.shape !== "line" || A.prio >= B.prio) continue;
    const hit = G.segIntersect(A.centre[0], A.centre[1], B.centre[0], B.centre[1]);
    if (!hit) continue;
    const LA = G.dist(A.centre[0], A.centre[1]), LB = G.dist(B.centre[0], B.centre[1]);
    if (hit.t * LA <= B.h + JOIN_TOL || (1 - hit.t) * LA <= B.h + JOIN_TOL) continue; // A ends at B: that is a T
    if (hit.u * LB <= A.h + JOIN_TOL || (1 - hit.u) * LB <= A.h + JOIN_TOL) continue; // B ends at A
    const nB = G.perp(B.u0), dB = G.sub(B.centre[1], B.centre[0]);
    A.cuts.push({ t: hit.t, faces: [G.add(B.centre[0], G.mul(nB, B.h)), G.sub(B.centre[0], G.mul(nB, B.h))], dir: dB });
  }

  // ---- polygons ----
  const out = new Map();
  for (const I of info) {
    const { w, h, centre } = I;
    const L = offsetPolyline(centre, h), R = offsetPolyline(centre, -h);
    const n = centre.length - 1;
    const c0 = I.caps[0], c1 = I.caps[1];
    // start cap: outgoing direction = wall direction, so its left is the wall's left
    const L0 = c0 ? c0.left : L[0], R0 = c0 ? c0.right : R[0];
    // end cap: outgoing direction is reversed, so its left is the wall's right
    const Ln = c1 ? c1.right : L[n], Rn = c1 ? c1.left : R[n];
    const Lp = [L0, ...L.slice(1, n), Ln], Rp = [R0, ...R.slice(1, n), Rn];
    let pieces;
    if (I.cuts.length && w.shape === "line") {
      pieces = [];
      const u = I.u0, nn = G.perp(u);
      const cuts = [...I.cuts].sort((p, q) => p.t - q.t);
      let startL = Lp[0], startR = Rp[0], startHub = c0?.hub || null;
      for (const cut of cuts) {
        // intersect this wall's edges with both faces of the other wall; the nearer face ends this piece
        const fl = cut.faces.map(f => lineHit(G.add(centre[0], G.mul(nn, h)), u, f, cut.dir));
        const fr = cut.faces.map(f => lineHit(G.sub(centre[0], G.mul(nn, h)), u, f, cut.dir));
        const along = p => G.dot(G.sub(p, centre[0]), u);
        const nearIdx = along(fl[0]) < along(fl[1]) ? 0 : 1, farIdx = 1 - nearIdx;
        pieces.push(poly(startR, fr[nearIdx], fl[nearIdx], startL, null, startHub));
        startL = fl[farIdx]; startR = fr[farIdx]; startHub = null;
      }
      pieces.push(poly(startR, Rp[1], Lp[1], startL, c1?.hub || null, startHub));
    } else {
      pieces = [[...Rp, ...(c1?.hub ? [c1.hub] : []), ...[...Lp].reverse(), ...(c0?.hub ? [c0.hub] : [])]];
    }
    const { z0, z1 } = wallHeights(doc, w);
    out.set(w.id, { pieces, centre, h, z0, z1, type: I.type });
  }
  return out;
}

function poly(r0, r1, l1, l0, endHub, startHub) {
  return [r0, r1, ...(endHub ? [endHub] : []), l1, l0, ...(startHub ? [startHub] : [])];
}

/**
 * Edges of the wall footprints that are on the outside of the wall mass (shared internal edges removed),
 * for the heavy plan outline. Vertices of neighbouring pieces are inserted into long edges first,
 * so a T junction removes exactly the short shared stretch.
 */
export function outlineEdges(polys) {
  const keyOf = p => `${Math.round(p.x * 2)},${Math.round(p.y * 2)}`;
  const allPts = polys.flat();
  const split = [];
  for (const pts of polys) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const L = G.dist(a, b);
      if (L < 0.5) continue;
      const mids = [];
      for (const p of allPts) {
        const pr = G.projectOnSegment(p, a, b);
        if (pr.dist < 0.5 && pr.t > 1e-6 && pr.t < 1 - 1e-6) mids.push(pr.t);
      }
      const ts = [0, ...[...new Set(mids.map(t => Math.round(t * 1e6) / 1e6))].sort((x, y) => x - y), 1];
      for (let k = 0; k < ts.length - 1; k++) split.push([G.lerp(a, b, ts[k]), G.lerp(a, b, ts[k + 1])]);
    }
  }
  const count = new Map();
  for (const [a, b] of split) {
    const k = [keyOf(a), keyOf(b)].sort().join("|");
    count.set(k, (count.get(k) || 0) + 1);
  }
  return split.filter(([a, b]) => G.dist(a, b) > 0.5 && count.get([keyOf(a), keyOf(b)].sort().join("|")) === 1);
}

/** Walls whose location line ends at point p (for stretching joined walls when one moves). */
export function wallsEndingAt(doc, p, levelId, exclude = new Set()) {
  const res = [];
  for (const w of doc.walls) {
    if (exclude.has(w.id) || w.baseLevelId !== levelId || w.shape !== "line") continue;
    if (G.dist(w.a, p) <= JOIN_TOL) res.push({ w, key: "a" });
    if (G.dist(w.b, p) <= JOIN_TOL) res.push({ w, key: "b" });
  }
  return res;
}
