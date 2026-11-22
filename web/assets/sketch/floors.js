// Floors: a boundary sketch (lines and arcs) on a level; closed loops, outer edges and holes.
// The sketch is checked like Revit's: every line must be part of a closed loop, and no lines may cross or overlap.
import * as G from "./geom.js";
import { newId } from "./model.js";
import { wallType, centrePolyline } from "./walls.js";

const TOL = 1; // mm

export const curveEnds = c => (c.shape === "arc" ? [G.arcStart(c), G.arcEnd(c)] : [c.a, c.b]);

/** Points along a boundary curve, from its start to its end. */
export function curvePoints(c) {
  if (c.shape !== "arc") return [c.a, c.b];
  const n = Math.max(8, Math.ceil(Math.abs(c.sweep) / (Math.PI / 48)));
  return Array.from({ length: n + 1 }, (_, k) => G.arcPoint(c, c.start + (c.sweep * k) / n));
}

/**
 * Checks a boundary sketch. Returns { ok, loops: [[points]], bad: [indices], message }.
 * loops are closed polygons (last point not repeated).
 */
export function checkSketch(curves) {
  if (!curves.length) return { ok: false, loops: [], bad: [], message: "Draw the floor's boundary first." };
  // crossings and overlaps
  const bad = new Set();
  for (let i = 0; i < curves.length; i++) for (let j = i + 1; j < curves.length; j++) {
    if (curvesCross(curves[i], curves[j])) { bad.add(i); bad.add(j); }
  }
  if (bad.size) return { ok: false, loops: [], bad: [...bad], message: "Lines must not cross or overlap. The highlighted lines do." };
  // closed loops: every end must meet exactly one other end
  const ends = curves.flatMap((c, i) => { const [a, b] = curveEnds(c); return [{ i, at: 0, p: a }, { i, at: 1, p: b }]; });
  const open = new Set();
  for (const e of ends) {
    if (G.isCircle(curves[e.i])) continue;
    const meets = ends.filter(f => f !== e && !(f.i === e.i && f.at === e.at) && G.dist(f.p, e.p) <= TOL);
    if (meets.length !== 1) open.add(e.i);
  }
  if (open.size) return { ok: false, loops: [], bad: [...open], message: "Lines must be in closed loops. The highlighted lines are open, or more than two lines meet at one point." };
  // chain into loops
  const used = new Set(), loops = [];
  for (let s = 0; s < curves.length; s++) {
    if (used.has(s)) continue;
    used.add(s);
    if (G.isCircle(curves[s])) { const pts = curvePoints(curves[s]); pts.pop(); loops.push(pts); continue; }
    const pts = [...curvePoints(curves[s])];
    let tail = pts.at(-1), guard = 0;
    while (G.dist(tail, pts[0]) > TOL && guard++ < curves.length + 2) {
      const k = curves.findIndex((c, i) => !used.has(i) && curveEnds(c).some(p => G.dist(p, tail) <= TOL));
      if (k < 0) break;
      used.add(k);
      let next = curvePoints(curves[k]);
      if (G.dist(next[0], tail) > TOL) next = [...next].reverse();
      pts.push(...next.slice(1)); tail = pts.at(-1);
    }
    pts.pop(); // closing point repeats the first
    loops.push(pts);
  }
  // loops must not cross each other (checked above) and each must have an area
  if (loops.some(l => Math.abs(G.polygonArea(l)) < 1)) return { ok: false, loops: [], bad: curves.map((_, i) => i), message: "A loop has no area. Check for lines drawn on top of each other." };
  return { ok: true, loops, bad: [], message: "" };
}

function curvesCross(c1, c2) {
  const ends1 = curveEnds(c1), ends2 = curveEnds(c2);
  const sharedEnd = p => ends1.some(q => G.dist(q, p) <= TOL) && ends2.some(q => G.dist(q, p) <= TOL);
  if (c1.shape !== "arc" && c2.shape !== "arc") {
    const r = G.sub(c1.b, c1.a), s = G.sub(c2.b, c2.a);
    if (Math.abs(G.cross(r, s)) < 1e-6 * G.len(r) * G.len(s)) {
      // parallel: overlapping if collinear and their spans share more than a point
      if (G.projectOnSegment(c2.a, c1.a, c1.b).dist > TOL && G.projectOnSegment(c1.a, c2.a, c2.b).dist > TOL) return false;
      const u = G.norm(r), t = p => G.dot(G.sub(p, c1.a), u);
      const lo = Math.max(0, Math.min(t(c2.a), t(c2.b))), hi = Math.min(G.len(r), Math.max(t(c2.a), t(c2.b)));
      return hi - lo > TOL;
    }
    const h = G.segIntersect(c1.a, c1.b, c2.a, c2.b, 0.01);
    return !!h && !sharedEnd(h.point);
  }
  // with arcs: sample both and test the pieces
  const p1 = curvePoints(c1), p2 = curvePoints(c2);
  for (let i = 0; i < p1.length - 1; i++) for (let j = 0; j < p2.length - 1; j++) {
    const h = G.segIntersect(p1[i], p1[i + 1], p2[j], p2[j + 1], 0.01);
    if (h && !sharedEnd(h.point)) return true;
  }
  return false;
}

/** Groups loops into floor parts: each outer loop with the loops directly inside it as holes. */
export function floorParts(loops) {
  const depth = loops.map((l, i) => loops.filter((m, j) => j !== i && G.pointInPolygon(l[0], m)).length);
  return loops.map((l, i) => ({ l, i })).filter(x => depth[x.i] % 2 === 0).map(({ l, i }) => ({
    outer: l,
    holes: loops.filter((m, j) => depth[j] === depth[i] + 1 && G.pointInPolygon(m[0], l)),
  }));
}

export function floorArea(parts) { return parts.reduce((s, p) => s + Math.abs(G.polygonArea(p.outer)) - p.holes.reduce((h, q) => h + Math.abs(G.polygonArea(q)), 0), 0); }

export function floorType(doc, f) { return doc.floorTypes.find(t => t.id === f.typeId) || doc.floorTypes[0]; }

/** Top and bottom of a floor slab (mm). */
export function floorLevels(doc, f) {
  const lv = doc.levels.find(l => l.id === f.levelId);
  const top = (lv?.elevation || 0) + (f.heightOffset || 0);
  return { top, bottom: top - floorType(doc, f).thickness };
}

export function makeFloor(doc, init) {
  return { id: newId("fl"), typeId: init.typeId || "ft-rc150", levelId: init.levelId, heightOffset: init.heightOffset ?? 0, structural: init.structural ?? true, boundary: init.boundary.map(c => JSON.parse(JSON.stringify(c))) };
}

/** The loops of a stored floor (its boundary is always a checked sketch). */
export function floorLoops(f) { const r = checkSketch(f.boundary); return r.ok ? r.loops : []; }

/**
 * Pick Walls: a boundary line on the face of a wall on the side of point `side`.
 * extendToCore puts it on the core face instead; offset moves it further out from the wall.
 */
export function boundaryFromWall(doc, w, side, { extendToCore = false, offset = 0 } = {}) {
  const t = wallType(doc, w), c = centrePolyline(w, t);
  const d = (extendToCore ? (t.core ?? t.thickness) : t.thickness) / 2 + offset;
  if (w.shape === "arc") {
    const out = G.dist(side, w.c) > w.r ? 1 : -1;
    // the centreline radius differs from the location radius by the location-line offset
    const rc = G.dist(c[0], w.c);
    return { shape: "arc", c: { ...w.c }, r: rc + out * d, start: w.start, sweep: w.sweep };
  }
  const u = G.norm(G.sub(c[1], c[0])), n = G.perp(u);
  const s = Math.sign(G.dot(G.sub(side, c[0]), n)) || 1;
  const off = G.mul(n, s * d);
  // reach past both ends so neighbouring picks can be trimmed to a corner
  const ext = t.thickness;
  return { shape: "line", a: G.add(G.sub(c[0], G.mul(u, ext)), off), b: G.add(G.add(c[1], G.mul(u, ext)), off) };
}

/** Trims a new straight boundary line and existing ones to corners where they meet near their ends (as Pick Walls does). */
export function autoTrim(curves, k, reach) {
  const c = curves[k];
  if (c.shape !== "line") return;
  for (let i = 0; i < curves.length; i++) {
    const o = curves[i];
    if (i === k || o.shape !== "line") continue;
    const h = G.lineIntersect(c.a, c.b, o.a, o.b);
    if (!h) continue;
    const Lc = G.dist(c.a, c.b), Lo = G.dist(o.a, o.b);
    const nearEnd = (t, L) => t * L >= -reach && t * L <= reach ? 0 : (1 - t) * L >= -reach && (1 - t) * L <= reach ? 1 : -1;
    const ec = nearEnd(h.t, Lc), eo = nearEnd(h.u, Lo);
    if (ec < 0 || eo < 0) continue;
    if (ec === 0) c.a = h.point; else c.b = h.point;
    if (eo === 0) o.a = h.point; else o.b = h.point;
  }
}
