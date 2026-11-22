// Roofs by footprint. The roof surface comes from a weighted straight skeleton: every edge that defines
// a slope moves inwards at 1/tan(slope) per unit of height; edges that do not define a slope stay put
// (gables). Where the moving edges meet, they make hips, valleys and ridges. Works for any simple
// footprint (L, T, U ...), mixed slopes, gables and mono-pitch roofs. A slope arrow makes one plane.
import * as G from "./geom.js";
import { newId } from "./model.js";
import { checkSketch, boundaryFromWall } from "./floors.js";
import * as S from "./solids.js";
import { wallType, centrePolyline, extSign, wallHeights, roofHooks } from "./walls.js";

const EPS = 1e-6;

/** "30", "30°", "1:2", "300/1000" -> slope angle in radians. Throws in plain words. */
export function parseSlope(text) {
  const s = String(text).trim().replace(",", ".");
  let m;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/))) { const r = +m[1], run = +m[2]; if (!(r >= 0 && run > 0)) throw new Error("A rise:run slope needs a run above 0."); return Math.atan(r / run); }
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*°?$/))) { const d = +m[1]; if (!(d >= 0 && d < 89)) throw new Error("A slope in degrees must be from 0 to 89."); return (d * Math.PI) / 180; }
  throw new Error(`"${text}" is not a slope. Type degrees (30) or rise:run (1:2 or 300/1000).`);
}
export function slopeLabel(rad, style = "deg") {
  if (style === "ratio") { const k = Math.tan(rad); return k > 0 ? `1:${Math.round(1 / k * 100) / 100}` : "flat"; }
  return `${Math.round((rad * 180) / Math.PI * 100) / 100}°`;
}

// --------------------------------------------------------------------------- weighted straight skeleton
/**
 * poly: simple polygon (any orientation), slopes[i]: slope of edge i (poly[i] -> poly[i+1]) in radians, or null for no slope.
 * Returns { faces: [{ edge, pts: [{x,y,z}] }], arcs: [{ a:{x,y,z}, b:{x,y,z}, from }], maxZ }  (z measured up from the eaves).
 */
export function skeleton(polyIn, slopesIn) {
  let poly = polyIn.map(p => ({ x: p.x, y: p.y })), slopes = [...slopesIn];
  if (G.polygonArea(poly) < 0) { // make it counter-clockwise; edge i becomes edge n-2-i
    const n = poly.length;
    poly = [...poly].reverse();
    slopes = Array.from({ length: n }, (_, i) => slopesIn[(n - 2 - i + n) % n]);
  }
  const n = poly.length;
  const E = poly.map((p, i) => {
    const q = poly[(i + 1) % n], d = G.norm(G.sub(q, p));
    const s = slopes[i] == null ? 0 : 1 / Math.tan(slopes[i]);
    return { i: polyIn.length === n && G.polygonArea(polyIn) < 0 ? (n - 2 - i + n) % n : i, P: p, n: G.perp(d), d, s };
  });
  const velocity = (a, b) => {
    const A = E[a], B = E[b], det = A.n.x * B.n.y - A.n.y * B.n.x;
    if (Math.abs(det) < 1e-9) return G.mul(A.n, (A.s + B.s) / 2); // straight-through: move with the edge
    return { x: (A.s * B.n.y - B.s * A.n.y) / det, y: (B.s * A.n.x - A.s * B.n.x) / det };
  };
  const mk = (p, a, b, t) => ({ p: { ...p }, a, b, v: velocity(a, b), t0: t, start: { ...p, z: t } });
  let loops = [poly.map((p, k) => mk(p, (k - 1 + n) % n, k, 0))];
  const faces = [], arcs = [];
  let t = 0;
  const pushQuad = (edge, pts) => {
    if (!(E[edge].s > 0)) return;
    const q = pts.filter((p, k) => G.dist(p, pts[(k + 1) % pts.length]) > 1e-6 || Math.abs(p.z - pts[(k + 1) % pts.length].z) > 1e-6);
    if (q.length >= 3) faces.push({ edge: E[edge].i, pts: q });
  };
  const finishVertex = v => { arcs.push({ a: v.start, b: { ...v.p, z: t }, from: v.reflex ? "valley" : "hip" }); };
  const ridge = (a, b) => { if (G.dist(a, b) > 1e-3) arcs.push({ a: { ...a, z: t }, b: { ...b, z: t }, from: "ridge" }); };
  const isReflex = (L, k) => G.cross(E[L[k].a].d, E[L[k].b].d) < -1e-9;
  loops[0].forEach((v, k) => { v.reflex = isReflex(loops[0], k); });

  for (let guard = 0; guard < 400 && loops.length; guard++) {
    // ---- next event ----
    let best = Infinity, split = null;
    for (const L of loops) {
      for (let k = 0; k < L.length; k++) {
        const A = L[k], B = L[(k + 1) % L.length];
        const s = G.sub(B.p, A.p), dv = G.sub(B.v, A.v), dd = G.dot(dv, dv);
        if (dd > EPS) { const tau = -G.dot(s, dv) / dd; if (tau > EPS && G.len(G.add(s, G.mul(dv, tau))) < 1e-3 * Math.max(1, G.len(s)) + 1e-6) best = Math.min(best, tau); }
      }
      for (let k = 0; k < L.length; k++) {
        if (!isReflex(L, k)) continue;
        const V = L[k];
        for (let j = 0; j < L.length; j++) {
          const X = L[j], Y = L[(j + 1) % L.length];
          if (X === V || Y === V) continue;
          const e = E[X.b], rate = G.dot(V.v, e.n) - e.s;
          if (rate > -EPS) continue;
          const tau = (e.s * t - G.dot(G.sub(V.p, e.P), e.n)) / rate;
          if (!(tau > EPS) || tau >= best - 1e-7 * (1 + best)) continue; // ties go to the edge event
          const hit = G.add(V.p, G.mul(V.v, tau)), x = G.add(X.p, G.mul(X.v, tau)), y = G.add(Y.p, G.mul(Y.v, tau));
          const seg = G.sub(y, x), u = G.dot(G.sub(hit, x), seg) / Math.max(EPS, G.dot(seg, seg));
          if (u > 1e-6 && u < 1 - 1e-6) { best = tau; split = { L, k, j }; }
        }
      }
    }
    if (!isFinite(best)) break;
    // ---- move every vertex to the event, emitting the faces swept on the way ----
    const t1 = t + best;
    for (const L of loops) {
      const old = L.map(v => ({ ...v.p }));
      L.forEach(v => { v.p = G.add(v.p, G.mul(v.v, best)); });
      for (let k = 0; k < L.length; k++) {
        const A = L[k], B = L[(k + 1) % L.length];
        pushQuad(A.b, [{ ...old[k], z: t }, { ...old[(k + 1) % L.length], z: t }, { ...B.p, z: t1 }, { ...A.p, z: t1 }]);
      }
    }
    t = t1;
    // ---- split event: the reflex vertex divides the loop in two ----
    let next = [];
    if (split && split.L.length) {
      const { L, k, j } = split, V = L[k], X = L[j];
      const N = L.length;
      finishVertex(V);
      const v1 = mk(V.p, V.a, X.b, t), v2 = mk(V.p, X.b, V.b, t);
      const loop1 = [v1], loop2 = [v2];
      for (let m = (j + 1) % N; m !== k; m = (m + 1) % N) loop1.push(L[m]);
      for (let m = (k + 1) % N; m !== (j + 1) % N; m = (m + 1) % N) loop2.push(L[m]);
      loops = loops.filter(x => x !== L).concat([loop1, loop2]);
      for (const LL of [loop1, loop2]) LL.forEach((v, m) => { if (v === v1 || v === v2) v.reflex = isReflex(LL, m); });
    }
    // ---- edge events: merge vertices that met ----
    for (const L of loops) {
      let merged = true;
      while (merged && L.length > 2) {
        merged = false;
        for (let k = 0; k < L.length; k++) {
          const A = L[k], B = L[(k + 1) % L.length];
          if (G.dist(A.p, B.p) < 1e-3) {
            finishVertex(A); finishVertex(B);
            const nv = mk(A.p, A.a, B.b, t);
            L.splice(k, 1, nv); L.splice((k + 1) % (L.length), 1);
            merged = true; break;
          }
        }
      }
      // spikes: a vertex where the loop doubles back on itself (a wing has closed to a ridge line)
      let spiked = true;
      while (spiked && L.length > 2) {
        spiked = false;
        for (let k = 0; k < L.length; k++) {
          const P = L[(k - 1 + L.length) % L.length], S = L[k], N = L[(k + 1) % L.length];
          const dP = G.dist(P.p, S.p), dN = G.dist(S.p, N.p);
          if (dP < 1e-3 || dN < 1e-3) continue;
          const din = G.mul(G.sub(S.p, P.p), 1 / dP), dout = G.mul(G.sub(N.p, S.p), 1 / dN);
          if (Math.abs(G.cross(din, dout)) > 1e-6 || G.dot(din, dout) > -0.999) continue;
          finishVertex(S);
          if (dN <= dP) { ridge(S.p, N.p); finishVertex(N); const nv = mk(N.p, P.b, N.b, t); L.splice(k, 1); L[k % L.length] = nv; }
          else { ridge(P.p, S.p); finishVertex(P); const nv = mk(P.p, P.a, S.b, t); L.splice(k, 1); L[(k - 1 + L.length) % L.length] = nv; }
          spiked = true; break;
        }
      }
      L.forEach((v, m) => { v.v = velocity(v.a, v.b); if (L.length > 2) v.reflex = isReflex(L, m); });
    }
    for (const L of loops) {
      const area = L.length > 2 ? Math.abs(G.polygonArea(L.map(v => v.p))) : 0;
      if (L.length < 3 || area < 1) { L.forEach(finishVertex); for (let m = 0; m + 1 < L.length + (L.length > 2 ? 1 : 0); m++) ridge(L[m].p, L[(m + 1) % L.length].p); continue; }
      next.push(L);
    }
    loops = next;
  }
  for (const L of loops) L.forEach(finishVertex); // gable-only remains
  const maxZ = arcs.reduce((m, a) => Math.max(m, a.a.z, a.b.z), 0);
  const seen = new Set(), key = p => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
  const kept = arcs.filter(a => {
    if (G.dist(a.a, a.b) <= 1e-3 && Math.abs(a.a.z - a.b.z) <= 1e-3) return false;
    const k1 = key(a.a) + "|" + key(a.b), k2 = key(a.b) + "|" + key(a.a);
    if (seen.has(k1) || seen.has(k2)) return false;
    seen.add(k1); return true;
  });
  return { faces: faces.filter(f => Math.abs(G.polygonArea(f.pts)) > 1), arcs: kept, maxZ };
}

/** Height of the roof surface (above the eaves) at plan point p, or null if outside. */
export function surfaceZ(sk, p) {
  for (const f of sk.faces) {
    const plan = f.pts;
    if (!G.pointInPolygon(p, plan)) continue;
    // plane through three non-collinear points
    for (let i = 0; i + 2 < plan.length; i++) {
      const a = plan[0], b = plan[i + 1], c = plan[i + 2];
      const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
      const nx = ab.y * ac.z - ab.z * ac.y, ny = ab.z * ac.x - ab.x * ac.z, nz = ab.x * ac.y - ab.y * ac.x;
      if (Math.abs(nz) < 1e-9) continue;
      return a.z - (nx * (p.x - a.x) + ny * (p.y - a.y)) / nz;
    }
  }
  return null;
}

// --------------------------------------------------------------------------- planes
/** Plane z = a*x + b*y + c through a planar polygon with heights. */
export function planeOf(pts) {
  for (let i = 0; i + 2 < pts.length + 1; i++) {
    const a = pts[0], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
    const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
    const nx = ab.y * ac.z - ab.z * ac.y, ny = ab.z * ac.x - ab.x * ac.z, nz = ab.x * ac.y - ab.y * ac.x;
    if (Math.abs(nz) < 1e-6 * (Math.hypot(nx, ny) + 1)) continue;
    return { a: -nx / nz, b: -ny / nz, c: a.z + (nx * a.x + ny * a.y) / nz };
  }
  return { a: 0, b: 0, c: pts[0]?.z ?? 0 };
}
export const planeZ = (pl, p) => pl.a * p.x + pl.b * p.y + pl.c;
const isConvex = poly => { let sgn = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length], c = poly[(i + 2) % poly.length]; const k = G.cross(G.sub(b, a), G.sub(c, b)); if (Math.abs(k) < 1e-6) continue; if (sgn && Math.sign(k) !== sgn) return false; sgn = Math.sign(k); } return true; };

// --------------------------------------------------------------------------- roof records
export const RAFTER_CUTS = { plumb: "Plumb Cut", "two-cut-plumb": "Two Cut - Plumb" };
export function roofType(doc, r) { return doc.roofTypes.find(t => t.id === r.typeId) || doc.roofTypes[0]; }

const edgeCopy = e => (e.shape === "arc" ? { shape: "arc", c: { ...e.c }, r: e.r, start: e.start, sweep: e.sweep } : { shape: "line", a: { ...e.a }, b: { ...e.b } });
export function makeRoof(doc, init) {
  return { id: newId("rf"), method: "footprint", typeId: init.typeId || "rt-200", baseLevelId: init.baseLevelId, baseOffset: init.baseOffset ?? 0,
    rafterCut: init.rafterCut || "plumb", fasciaDepth: init.fasciaDepth ?? 0,
    boundary: init.boundary.map(e => ({ ...edgeCopy(e), definesSlope: e.definesSlope ?? true, slope: e.slope ?? Math.PI / 6, overhang: e.overhang || 0 })),
    slopeArrows: (init.slopeArrows || []).map(a => ({ tail: { ...a.tail }, head: { ...a.head }, tailHeight: a.tailHeight ?? 0, headHeight: a.headHeight ?? 300 })) };
}
/** Roof by Extrusion: a profile (s along a->b, h up) drawn on a vertical plane through a-b, extruded from `start` to `end` square to it. */
export function makeExtrusionRoof(doc, init) {
  return { id: newId("rf"), method: "extrusion", typeId: init.typeId || "rt-200", baseLevelId: init.baseLevelId, baseOffset: init.baseOffset ?? 0,
    a: { ...init.a }, b: { ...init.b }, profile: init.profile.map(p => ({ s: p.s, h: p.h })), start: init.start ?? 0, end: init.end ?? 5000 };
}

/** The footprint polygon of a roof and, per polygon edge, its slope (null = no slope) and overhang. */
export function roofFootprint(r) {
  const res = checkSketch(r.boundary);
  if (!res.ok) throw new Error(res.message.replace("floor", "roof"));
  if (res.loops.length !== 1) throw new Error("A roof footprint must be one closed loop, with no holes.");
  const loop = res.loops[0];
  const distTo = (m, c) => (c.shape === "arc" ? Math.abs(G.dist(m, c.c) - c.r) : G.projectOnSegment(m, c.a, c.b).dist);
  const owner = loop.map((p, i) => { const m = G.mid(p, loop[(i + 1) % loop.length]); let best = null, bd = Infinity; for (const c of r.boundary) { const d = distTo(m, c); if (d < bd) { bd = d; best = c; } } return best; });
  return { poly: loop, slopes: owner.map(e => (e && e.definesSlope && e.slope > 1e-6 ? e.slope : null)), overhangs: owner.map(e => e?.overhang || 0) };
}

export function roofBaseZ(doc, r) { return (doc.levels.find(l => l.id === r.baseLevelId)?.elevation ?? 0) + (r.baseOffset || 0); }

const cache = new Map();
/**
 * The roof's underside as planar faces (absolute mm): [{ pts:[{x,y,z}], plane, slope, eaveZ }], plus plan lines
 * (ridges, hips, valleys) and the plan outline. Cached on the roof's data.
 */
export function roofGeometry(doc, r) {
  const key = JSON.stringify(r, (k, v) => (k === "topZ" || k === "patches" ? undefined : v)) + "|" + roofBaseZ(doc, r) + "|" + roofType(doc, r).thickness;
  if (cache.has(key)) return cache.get(key);
  const g = r.method === "extrusion" ? extrusionGeometry(doc, r) : footprintGeometry(doc, r);
  if (cache.size > 60) cache.clear();
  cache.set(key, g);
  return g;
}

function footprintGeometry(doc, r) {
  const base = roofBaseZ(doc, r), T = roofType(doc, r).thickness;
  const { poly, slopes, overhangs } = roofFootprint(r);
  const arrow = r.slopeArrows?.[0];
  let faces, lines = [];
  if (arrow) {
    const u = G.norm(G.sub(arrow.head, arrow.tail)), L = G.dist(arrow.tail, arrow.head) || 1;
    const k = ((arrow.headHeight ?? 0) - (arrow.tailHeight ?? 0)) / L;
    const z = p => base + (arrow.tailHeight ?? 0) + k * G.dot(G.sub(p, arrow.tail), u);
    faces = [{ pts: poly.map(p => ({ ...p, z: z(p) })), slope: Math.atan(Math.abs(k)) }];
  } else if (slopes.every(s => s == null)) {
    faces = [{ pts: poly.map(p => ({ ...p, z: base })), slope: 0 }];
  } else {
    const sk = skeleton(poly, slopes);
    // the slope is measured from the plate line (the wall face), so the overhang hangs below the base
    faces = sk.faces.map(f => { const drop = (overhangs[f.edge] || 0) * Math.tan(slopes[f.edge]); return { pts: f.pts.map(p => ({ ...p, z: p.z + base - drop })), slope: slopes[f.edge], edge: f.edge }; });
    const drop0 = Math.max(0, ...poly.map((_, i) => (slopes[i] ? (overhangs[i] || 0) * Math.tan(slopes[i]) : 0)));
    lines = sk.arcs.map(a => ({ a: { ...a.a, z: a.a.z + base - drop0 }, b: { ...a.b, z: a.b.z + base - drop0 }, kind: a.from }));
  }
  faces.forEach(f => { f.plane = planeOf(f.pts); f.thick = T / Math.cos(f.slope || 0); });
  // two cuts at the eaves: a plumb fascia of the given depth, then a level soffit
  const eaveTop = Math.min(...faces.flatMap(f => f.pts.filter(p => poly.some((q, i) => G.projectOnSegment(p, q, poly[(i + 1) % poly.length]).dist < 1)).map(p => p.z + f.thick)));
  const soffit = r.rafterCut === "two-cut-plumb" && r.fasciaDepth > 0 ? eaveTop - r.fasciaDepth : -Infinity;
  const top = Math.max(...faces.flatMap(f => f.pts.map(p => p.z + f.thick)));
  return { faces, lines, outline: poly, soffit, top, bottom: Math.min(...faces.flatMap(f => f.pts.map(p => Math.max(p.z, soffit)))) };
}

/** Offsets an open polyline (in the s/h profile plane) downwards by d, square to each segment, mitred. */
function offsetDown(pts, d) {
  const n = pts.length, segN = [];
  for (let i = 0; i < n - 1; i++) { const u = G.norm(G.sub(pts[i + 1], pts[i])); segN.push({ x: u.y, y: -u.x }); } // right of travel = down for left-to-right
  return pts.map((p, i) => {
    const a = segN[Math.max(0, i - 1)], b = segN[Math.min(n - 2, i)];
    const m = G.norm(G.add(a, b)), k = 1 / Math.max(0.2, G.dot(m, b));
    return G.add(p, G.mul(m, d * k));
  });
}

function extrusionGeometry(doc, r) {
  const base = roofBaseZ(doc, r), T = roofType(doc, r).thickness;
  const prof = [...r.profile].sort((p, q) => p.s - q.s).map(p => ({ x: p.s, y: p.h }));
  if (prof.length < 2) throw new Error("A roof profile needs at least two points.");
  const L = G.dist(r.a, r.b); if (L < 100) throw new Error("Draw the profile line at least 100 mm long.");
  const u = G.norm(G.sub(r.b, r.a)), n = G.perp(u), d0 = Math.min(r.start, r.end), d1 = Math.max(r.start, r.end);
  if (d1 - d0 < 100) throw new Error("Extrusion Start and End must be at least 100 mm apart.");
  const P = (s, d) => G.add(G.add(r.a, G.mul(u, s)), G.mul(n, d));
  const lower = offsetDown(prof, T);
  const faces = [];
  for (let i = 0; i < prof.length - 1; i++) {
    const A = lower[i], B = lower[i + 1];
    const pts = [{ ...P(A.x, d0), z: base + A.y }, { ...P(B.x, d0), z: base + B.y }, { ...P(B.x, d1), z: base + B.y }, { ...P(A.x, d1), z: base + A.y }];
    const slope = Math.atan2(Math.abs(B.y - A.y), Math.abs(B.x - A.x) || 1e-9);
    faces.push({ pts, slope, plane: planeOf(pts), thick: T / Math.cos(slope) });
  }
  const lines = prof.slice(1, -1).map(q => ({ a: { ...P(q.x, d0), z: base + q.y }, b: { ...P(q.x, d1), z: base + q.y }, kind: "ridge" }));
  const sMin = Math.min(prof[0].x, lower[0].x), sMax = Math.max(prof.at(-1).x, lower.at(-1).x);
  return { faces, lines, outline: [P(sMin, d0), P(sMax, d0), P(sMax, d1), P(sMin, d1)], soffit: -Infinity, extrusion: { prof, lower, d0, d1, P, base },
    top: base + Math.max(...prof.map(q => q.y)), bottom: base + Math.min(...lower.map(q => q.y)) };
}

/** Convex patches of the underside, for cutting walls: [{ poly, plane }]. */
export function undersidePatches(doc, r) {
  const g = roofGeometry(doc, r);
  if (g.patches) return g.patches;
  g.patches = g.faces.flatMap(f => (isConvex(f.pts) ? [f.pts] : S.triangulate(f.pts)).map(poly => ({ poly: poly.map(p => ({ x: p.x, y: p.y })), plane: f.plane })));
  return g.patches;
}

/** Underside height at a plan point, or null outside the roof. */
export function undersideAt(doc, r, p) {
  for (const pt of undersidePatches(doc, r)) if (G.pointInPolygon(p, pt.poly) || pt.poly.some((q, i) => G.projectOnSegment(p, q, pt.poly[(i + 1) % pt.poly.length]).dist < 0.5)) return planeZ(pt.plane, p);
  return null;
}

/** Highest underside over a set of plan points and over the roof's corners and ridge points that fall inside `polys`. */
export function maxUndersideOver(doc, r, samples, polys = []) {
  let m = -Infinity;
  for (const p of samples) { const z = undersideAt(doc, r, p); if (z != null) m = Math.max(m, z); }
  for (const pt of undersidePatches(doc, r)) for (const q of pt.poly) if (polys.some(pl => G.pointInPolygon(q, pl))) m = Math.max(m, planeZ(pt.plane, q));
  return m;
}

/**
 * Cuts prisms ({ poly, z0, z1 }) to stay under the roof: inside the roof, the top follows the underside
 * (solids get top: plane); outside it they keep `outsideTop` at most.
 */
export function clipUnderRoof(doc, r, solids, outsideTop) {
  const patches = undersidePatches(doc, r), out = [];
  for (const s of solids) {
    // outside the roof
    let rest = [s.poly];
    for (const pt of patches) rest = rest.flatMap(p => S.subtractConvex(p, pt.poly));
    const zo = Math.min(s.z1, outsideTop);
    if (zo > s.z0 + 0.5) for (const p of rest) out.push({ ...s, poly: p, z1: zo });
    // under each patch
    for (const pt of patches) {
      let piece = s.poly;
      const c = ccwPoly(pt.poly);
      for (let i = 0; i < c.length && piece; i++) { const a = c[i], b = c[(i + 1) % c.length]; piece = S.clipHalf(piece, a, G.mul(G.perp(G.norm(G.sub(b, a))), -1), 0); }
      if (!piece) continue;
      const g = { x: pt.plane.a, y: pt.plane.b }, gl = Math.hypot(g.x, g.y);
      if (gl < 1e-9) { const z = Math.min(s.z1, pt.plane.c); if (z > s.z0 + 0.5) out.push({ ...s, poly: piece, z1: z }); continue; }
      // where the underside is above the solid's top: unchanged; below it: sloped top; below the base: gone
      const above = S.clipHalf(piece, G.P(0, 0), G.mul(g, -1), -(s.z1 - pt.plane.c));
      if (above) out.push({ ...s, poly: above });
      let under = S.clipHalf(piece, G.P(0, 0), g, s.z1 - pt.plane.c);
      if (under) under = S.clipHalf(under, G.P(0, 0), G.mul(g, -1), -(s.z0 + 0.5 - pt.plane.c));
      if (under) out.push({ ...s, poly: under, z1: Math.min(s.z1, Math.max(...under.map(q => planeZ(pt.plane, q)))), top: pt.plane });
    }
  }
  return out;
}
const ccwPoly = poly => (G.polygonArea(poly) < 0 ? [...poly].reverse() : poly);

/** Triangles of a roof's solid for 3D (mm, z up): top, underside, soffit and edges. */
export function roofMesh(doc, r) {
  const g = roofGeometry(doc, r), tris = [], edges = [];
  const add = (a, b, c) => tris.push([a, b, c]);
  const P3 = (p, z) => ({ x: p.x, y: p.y, z });
  if (g.extrusion) {
    const { prof, lower, d0, d1, P, base } = g.extrusion;
    const ring = [...prof, ...[...lower].reverse()];
    const at = (q, d) => ({ ...P(q.x, d), z: base + q.y });
    for (let i = 0; i < ring.length; i++) { const q = ring[i], w = ring[(i + 1) % ring.length]; add(at(q, d0), at(w, d0), at(w, d1)); add(at(q, d0), at(w, d1), at(q, d1)); edges.push([at(q, d0), at(w, d0)], [at(q, d1), at(w, d1)]); }
    for (let i = 0; i < prof.length; i++) edges.push([at(prof[i], d0), at(prof[i], d1)], [at(lower[i], d0), at(lower[i], d1)]);
    for (const t of S.triangulate(ring)) { add(...t.map(q => at(q, d0))); add(...t.map(q => at(q, d1))); }
    return { tris, edges };
  }
  const outline = g.outline, onOutline = (a, b) => outline.some((q, i) => { const w = outline[(i + 1) % outline.length]; return G.projectOnSegment(a, q, w).dist < 1 && G.projectOnSegment(b, q, w).dist < 1; });
  const bottomZ = (f, p) => Math.max(planeZ(f.plane, p), g.soffit);
  for (const f of g.faces) {
    const topZ = p => planeZ(f.plane, p) + f.thick;
    for (const t of S.triangulate(f.pts)) {
      add(...t.map(p => P3(p, topZ(p))));
      // underside: split where the soffit takes over
      const gvec = { x: f.plane.a, y: f.plane.b };
      const parts = isFinite(g.soffit) && Math.hypot(gvec.x, gvec.y) > 1e-9
        ? [S.clipHalf(t, G.P(0, 0), gvec, g.soffit - f.plane.c), S.clipHalf(t, G.P(0, 0), G.mul(gvec, -1), f.plane.c - g.soffit)].filter(Boolean)
        : [t];
      for (const part of parts) for (const tt of S.triangulate(part)) add(...tt.map(p => P3(p, bottomZ(f, p))));
    }
    const n = f.pts.length;
    for (let i = 0; i < n; i++) {
      const a = f.pts[i], b = f.pts[(i + 1) % n];
      if (G.dist(a, b) < 1) continue;
      edges.push([P3(a, topZ(a)), P3(b, topZ(b))]);
      if (!onOutline(a, b)) continue;
      // eave or verge: a plumb face from the underside (or soffit) to the top, split where the soffit starts
      const za = planeZ(f.plane, a), zb = planeZ(f.plane, b);
      const pts = [a];
      if (isFinite(g.soffit) && (za - g.soffit) * (zb - g.soffit) < 0) pts.push(G.lerp(a, b, (g.soffit - za) / (zb - za)));
      pts.push(b);
      for (let k = 0; k + 1 < pts.length; k++) {
        const p = pts[k], q = pts[k + 1];
        add(P3(p, bottomZ(f, p)), P3(q, bottomZ(f, q)), P3(q, topZ(q))); add(P3(p, bottomZ(f, p)), P3(q, topZ(q)), P3(p, topZ(p)));
        edges.push([P3(p, bottomZ(f, p)), P3(q, bottomZ(f, q))]);
      }
      edges.push([P3(a, bottomZ(f, a)), P3(a, topZ(a))]);
    }
  }
  return { tris, edges };
}

/** Pick Walls for roofs: the wall's exterior (or core) face pushed out by the overhang. */
export function roofEdgeFromWall(doc, w, { overhang = 0, extendToCore = false } = {}) {
  const t = wallType(doc, w), c = centrePolyline(w, t);
  let outside;
  if (w.shape === "arc") { const m = G.arcMid(w), out = G.norm(G.sub(m, w.c)); outside = G.add(m, G.mul(out, extSign(w) * (w.sweep > 0 ? -1 : 1) * 1e5)); }
  else { const u = G.norm(G.sub(c[1], c[0])); outside = G.add(G.mid(c[0], c[1]), G.mul(G.perp(u), extSign(w) * 1e5)); }
  return { ...boundaryFromWall(doc, w, outside, { extendToCore, offset: overhang }), overhang };
}

/** Walls whose top reaches the roof's base and that stand under it. */
export function wallsUnderRoof(doc, r) {
  const base = roofBaseZ(doc, r), outline = roofGeometry(doc, r).outline;
  return doc.walls.filter(w => {
    if (w.attachTopTo) return false;
    const { z1 } = wallHeights(doc, w);
    if (Math.abs(z1 - base) > 300) return false;
    const pts = w.shape === "arc" ? [G.arcStart(w), G.arcMid(w), G.arcEnd(w)] : [G.lerp(w.a, w.b, 0.1), G.mid(w.a, w.b), G.lerp(w.a, w.b, 0.9)];
    return pts.every(p => G.pointInPolygon(p, outline));
  }).map(w => w.id);
}

// walls ask roofs how high to go when attached (set here to keep walls.js free of a roof import)
roofHooks.maxUnderside = (doc, w, baseTop) => {
  const r = doc.roofs?.find(x => x.id === w.attachTopTo); if (!r) return null;
  let g; try { g = roofGeometry(doc, r); } catch { return null; }
  const t = wallType(doc, w), c = centrePolyline(w, t), half = t.thickness / 2;
  const samples = [];
  for (let i = 0; i < c.length - 1; i++) {
    const u = G.norm(G.sub(c[i + 1], c[i])), n = G.perp(u);
    for (let k = 0; k <= 16; k++) { const p = G.lerp(c[i], c[i + 1], k / 16); samples.push(p, G.add(p, G.mul(n, half)), G.sub(p, G.mul(n, half))); }
  }
  const z = maxUndersideOver(doc, r, samples);
  return isFinite(z) ? Math.max(baseTop, z) : null;
};
