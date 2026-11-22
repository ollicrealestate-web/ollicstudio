// Modify operations on walls and lines (both are "curves": straight {a,b} or arc {c,r,start,sweep}).
// Pure functions on the model; the tools in modifytools.js call them inside one undo step each.
import * as G from "./geom.js";
import { newId } from "./model.js";

export const isCurve = el => el && (el.shape === "line" || el.shape === "arc");
export const isWallEl = el => el && "typeId" in el && "baseLevelId" in el;
const collOf = el => (isWallEl(el) ? "walls" : "lines");

// ---------------------------------------------------------------- affine transforms
/** M = [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f */
export const apply = (M, p) => ({ x: M[0] * p.x + M[2] * p.y + M[4], y: M[1] * p.x + M[3] * p.y + M[5] });
export const translation = d => [1, 0, 0, 1, d.x, d.y];
export function rotation(c, ang) {
  const cs = Math.cos(ang), sn = Math.sin(ang);
  return [cs, sn, -sn, cs, c.x - cs * c.x + sn * c.y, c.y - sn * c.x - cs * c.y];
}
export function mirrorAcross(p, q) {
  const u = G.norm(G.sub(q, p)), a = u.x * u.x - u.y * u.y, b = 2 * u.x * u.y;
  // reflection matrix [[a, b], [b, -a]] about a line through p
  return [a, b, b, -a, p.x - a * p.x - b * p.y, p.y - b * p.x + a * p.y];
}
export const scaling = (c, k) => [k, 0, 0, k, c.x - k * c.x, c.y - k * c.y];
const det = M => M[0] * M[3] - M[1] * M[2];

/** Transforms a wall or line in place. A reflection keeps a wall's exterior on the mirrored side. */
export function transform(el, M) {
  if (el.shape === "line") { el.a = apply(M, el.a); el.b = apply(M, el.b); }
  else if (el.shape === "arc") {
    const s = apply(M, G.arcStart(el)), c = apply(M, el.c), k = Math.sqrt(Math.abs(det(M)));
    el.c = c; el.r *= k; el.start = G.angleOf(G.sub(s, c));
    if (det(M) < 0) el.sweep = -el.sweep;
  }
  if (det(M) < 0 && isWallEl(el)) el.flipped = !el.flipped;
}

export function copyOf(el) {
  const c = JSON.parse(JSON.stringify(el));
  c.id = newId(isWallEl(el) ? "wl" : el.kind === "detail" ? "dl" : "ml");
  delete c.pinned;
  return c;
}

// ---------------------------------------------------------------- every kind of element
/** Collections whose elements Move, Copy, Rotate, Mirror, Scale and Array work on. */
export const MOVABLE = ["walls", "lines", "openings", "floors", "roofs", "components", "dimensions", "texts", "referencePlanes"];
const PREFIX = { walls: "wl", openings: null, floors: "fl", roofs: "rf", dimensions: "dm", texts: "tx", referencePlanes: "rp" };
export function collectionOf(doc, id) { for (const k of MOVABLE) if ((doc[k] || []).some(x => x.id === id)) return k; return null; }
/** Wall sweeps and reveals belong to their walls: they move with them, not on their own. */
export const canTransform = (doc, id) => { const k = collectionOf(doc, id); if (!k) return false; if (k === "components") return doc.components.find(c => c.id === id).kind !== "wallSweep"; return true; };

const lin = (M, v) => ({ x: M[0] * v.x + M[2] * v.y, y: M[1] * v.x + M[3] * v.y });
/** Transforms any element in place (not walls' joins, not openings: see moveOpening). */
export function transformAny(doc, el, coll, Mx) {
  const each = (list, f) => (list || []).forEach(f);
  const mir = det(Mx) < 0;
  switch (coll) {
    case "walls": case "lines": transform(el, Mx); break;
    case "floors": each(el.boundary, c => transform(c, Mx)); break;
    case "roofs":
      if (el.method === "extrusion") { el.a = apply(Mx, el.a); el.b = apply(Mx, el.b); if (mir) { const s = el.start; el.start = -el.end; el.end = -s; } }
      else { each(el.boundary, c => transform(c, Mx)); each(el.slopeArrows, a => { a.tail = apply(Mx, a.tail); a.head = apply(Mx, a.head); }); }
      break;
    case "components":
      if (el.kind === "extrusion") each(el.boundary, c => transform(c, Mx));
      else if (el.kind === "sweep") {
        if (el.plane) { // drawn in an elevation: the path stays on its vertical plane; the plane moves
          el.plane.o = apply(Mx, el.plane.o);
          const k = Math.sqrt(Math.abs(det(Mx))) || 1;
          el.plane.u = G.mul(lin(Mx, el.plane.u), 1 / k); el.plane.n = G.mul(lin(Mx, el.plane.n), 1 / k);
          if (Math.abs(k - 1) > 1e-9) each(el.path, c => { if (c.shape === "line") { c.a = G.mul(c.a, k); c.b = G.mul(c.b, k); } else { c.c = G.mul(c.c, k); c.r *= k; } });
        } else { each(el.path, c => transform(c, Mx)); if (mir) el.flip = !el.flip; }
      }
      break;
    case "dimensions": el.a = apply(Mx, el.a); el.b = apply(Mx, el.b); if (mir) el.offset = -el.offset; break;
    case "texts": el.p = apply(Mx, el.p); break;
    case "referencePlanes": el.a = apply(Mx, el.a); el.b = apply(Mx, el.b); break;
  }
}

/** Moves a door or window by a transform: along its wall, or onto another straight wall on the same level. */
export function moveOpening(doc, o, Mx, hooks) {
  const host = doc.walls.find(w => w.id === o.hostWallId);
  if (!host || host.shape !== "line") throw new Error("Doors and windows move along straight walls in this version.");
  const ax0 = hooks.wallAxis(doc, host), p = apply(Mx, G.add(ax0.c0, G.mul(ax0.u, o.positionAlongWall)));
  let best = null;
  for (const w of doc.walls) {
    if (w.shape !== "line" || w.baseLevelId !== host.baseLevelId) continue;
    const ax = hooks.wallAxis(doc, w), s = G.dot(G.sub(p, ax.c0), ax.u), d = Math.abs(G.dot(G.sub(p, ax.c0), ax.n));
    if (s < 0 || s > ax.L || d > ax.h + 300) continue;
    const score = d - (w.id === host.id ? 1 : 0);
    if (!best || score < best.score) best = { w, s, score };
  }
  const name = o.kind === "door" ? "door" : "window";
  if (!best) throw new Error(`A ${name} must stay in a wall: move it along its wall or onto another wall.`);
  // keep which way it faces and which side it hinges, as transformed, on the new wall's axes
  const F = lin(Mx, G.mul(ax0.n, o.flipFacing ? -1 : 1)), Hd = lin(Mx, G.mul(ax0.u, o.flipHand ? -1 : 1)), ax1 = hooks.wallAxis(doc, best.w);
  o.flipFacing = G.dot(F, ax1.n) < 0; o.flipHand = G.dot(Hd, ax1.u) < 0;
  o.hostWallId = best.w.id; o.positionAlongWall = Math.round(best.s * 10) / 10;
}

/** Copies (or moves) elements by a transform. Returns the new ids for copies. */
export function transformIds(doc, ids, M, { copy = false, hooks } = {}) {
  const out = [], set = new Set(ids);
  for (const id of ids) {
    const coll = collectionOf(doc, id);
    if (coll && coll !== "walls" && coll !== "lines") {
      const el = doc[coll].find(x => x.id === id);
      if (coll === "components" && el.kind === "wallSweep") continue;
      if (coll === "openings" && set.has(el.hostWallId)) continue; // it goes with its wall
      if (!copy && el.pinned) throw new Error("A pinned element cannot move. Unpin it first (UP).");
      const target = copy ? JSON.parse(JSON.stringify(el)) : el;
      if (copy) { target.id = newId(coll === "openings" ? (el.kind === "door" ? "dr" : "wn") : coll === "components" ? el.id.slice(0, 2) : PREFIX[coll]); delete target.pinned; }
      if (coll === "openings") { if (!hooks) throw new Error("Doors and windows need their wall to move."); moveOpening(doc, target, M, hooks); }
      else transformAny(doc, target, coll, M);
      if (copy) { doc[coll].push(target); out.push(target.id); } else out.push(id);
      continue;
    }
    const el = doc.walls.find(w => w.id === id) || doc.lines.find(l => l.id === id);
    if (!el) continue;
    if (copy) {
      const c = copyOf(el); transform(c, M); doc[collOf(el)].push(c); out.push(c.id);
      // doors and windows go with a copied wall
      if (isWallEl(el)) for (const o of (doc.openings || []).filter(q => q.hostWallId === el.id)) {
        const oc = JSON.parse(JSON.stringify(o)); oc.id = newId(o.kind === "door" ? "dr" : "wn"); oc.hostWallId = c.id;
        if (det(M) < 0) oc.flipFacing = !oc.flipFacing;
        doc.openings.push(oc);
      }
    } else {
      if (el.pinned) throw new Error("A pinned element cannot move. Unpin it first (UP).");
      transform(el, M); out.push(id);
      if (det(M) < 0 && isWallEl(el)) for (const o of (doc.openings || []).filter(q => q.hostWallId === el.id)) o.flipFacing = !o.flipFacing;
    }
  }
  return out;
}

/** Linear array: n items in total (the original is the first); `step` is the vector to the 2nd item, or to the last with toLast. */
export function arrayLinear(doc, ids, vec, n, toLast = false, hooks) {
  if (!(n >= 2 && n <= 200)) throw new Error("An array needs between 2 and 200 items.");
  const step = toLast ? G.mul(vec, 1 / (n - 1)) : vec;
  const made = [];
  for (let i = 1; i < n; i++) made.push(...transformIds(doc, ids, translation(G.mul(step, i)), { copy: true, hooks }));
  return made;
}

/** Radial array round a centre; angle is to the 2nd item, or the whole sweep with toLast. */
export function arrayRadial(doc, ids, centre, angle, n, toLast = false, hooks) {
  if (!(n >= 2 && n <= 200)) throw new Error("An array needs between 2 and 200 items.");
  const step = toLast ? angle / (n - 1) : angle;
  const made = [];
  for (let i = 1; i < n; i++) made.push(...transformIds(doc, ids, rotation(centre, step * i), { copy: true, hooks }));
  return made;
}

// ---------------------------------------------------------------- offset
/** Offsets one element by `dist` towards the side of point `side`. Returns the moved/new element. */
export function offsetElement(doc, el, dist, side, copy = true) {
  const target = copy ? copyOf(el) : el;
  if (!copy && el.pinned) throw new Error("A pinned element cannot move. Unpin it first (UP).");
  if (el.shape === "line") {
    const n = G.perp(G.norm(G.sub(el.b, el.a)));
    const s = Math.sign(G.dot(G.sub(side, el.a), n)) || 1;
    const d = G.mul(n, s * dist);
    target.a = G.add(el.a, d); target.b = G.add(el.b, d);
  } else {
    const out = G.dist(side, el.c) > el.r ? 1 : -1;
    const r = el.r + out * dist;
    if (r <= 1) throw new Error("That offset would turn the arc inside out. Use a smaller distance.");
    target.r = r;
  }
  if (copy) doc[collOf(el)].push(target);
  return target;
}

/** Orders a chain of straight elements joined end to end into one path. Returns {pts, ids, flips, closed}. */
export function chainPath(els, tol = 2) {
  if (!els.length || els.some(e => e.shape !== "line")) throw new Error("Chain offset works on straight walls and lines.");
  const left = [...els];
  const first = left.shift();
  const path = [{ el: first, rev: false }];
  let head = first.a, tail = first.b;
  let grew = true;
  while (left.length && grew) {
    grew = false;
    for (let i = 0; i < left.length; i++) {
      const e = left[i];
      if (G.dist(e.a, tail) <= tol) { path.push({ el: e, rev: false }); tail = e.b; left.splice(i, 1); grew = true; break; }
      if (G.dist(e.b, tail) <= tol) { path.push({ el: e, rev: true }); tail = e.a; left.splice(i, 1); grew = true; break; }
      if (G.dist(e.b, head) <= tol) { path.unshift({ el: e, rev: false }); head = e.a; left.splice(i, 1); grew = true; break; }
      if (G.dist(e.a, head) <= tol) { path.unshift({ el: e, rev: true }); head = e.b; left.splice(i, 1); grew = true; break; }
    }
  }
  if (left.length) throw new Error("Those elements do not form one connected chain.");
  const pts = [path[0].rev ? path[0].el.b : path[0].el.a, ...path.map(p => (p.rev ? p.el.a : p.el.b))];
  const closed = path.length > 2 && G.dist(pts[0], pts.at(-1)) <= tol;
  return { pts, items: path, closed };
}

/** Offsets a whole chain, keeping its corners joined (mitred). side: a point on the side to offset towards. */
export function offsetChain(doc, els, dist, side, copy = true) {
  const { pts, items, closed } = chainPath(els);
  // which side is "left" of the path?
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) { const pr = G.projectOnSegment(side, pts[i], pts[i + 1]); if (!best || pr.dist < best.dist) best = { ...pr, i }; }
  const u = G.norm(G.sub(pts[best.i + 1], pts[best.i]));
  const s = Math.sign(G.cross(u, G.sub(side, best.point))) || 1;
  const d = s * dist;
  const lines = items.map((_, i) => { const n = G.perp(G.norm(G.sub(pts[i + 1], pts[i]))); return [G.add(pts[i], G.mul(n, d)), G.add(pts[i + 1], G.mul(n, d))]; });
  const corner = (i, j) => { const h = G.lineIntersect(lines[i][0], lines[i][1], lines[j][0], lines[j][1]); return h ? h.point : lines[i][1]; };
  const newPts = lines.map((l, i) => ({ a: i > 0 ? corner(i - 1, i) : closed ? corner(lines.length - 1, 0) : l[0], b: i < lines.length - 1 ? corner(i, i + 1) : closed ? corner(i, 0) : l[1] }));
  const result = [];
  items.forEach((it, i) => {
    const target = copy ? copyOf(it.el) : it.el;
    if (!copy && it.el.pinned) throw new Error("A pinned element cannot move. Unpin it first (UP).");
    const { a, b } = newPts[i];
    if (it.rev) { target.a = b; target.b = a; } else { target.a = a; target.b = b; }
    if (copy) doc[collOf(it.el)].push(target);
    result.push(target);
  });
  return result;
}

// ---------------------------------------------------------------- trim, extend, split
function paramOn(el, p) { return G.dot(G.sub(p, el.a), G.sub(el.b, el.a)) / Math.max(1e-9, G.dot(G.sub(el.b, el.a), G.sub(el.b, el.a))); }
const straight = (...els) => { if (els.some(e => e.shape !== "line")) throw new Error("This works on straight walls and lines. Arcs follow in a later version."); };

/** Trims or extends `el` to meet the infinite line through `bA, bB`, keeping the part where it was picked. */
export function trimTo(el, bA, bB, pick) {
  straight(el);
  if (el.pinned) throw new Error("A pinned element cannot change. Unpin it first (UP).");
  const hit = G.lineIntersect(el.a, el.b, bA, bB);
  if (!hit) throw new Error("These are parallel, so they never meet.");
  const X = hit.point, tx = hit.t, tp = paramOn(el, pick);
  if (tx < 0 || tx > 1) { if (tx < 0) el.a = X; else el.b = X; }       // extend the nearer end
  else if (tp < tx) el.b = X; else el.a = X;                           // trim: keep the picked side
  if (G.dist(el.a, el.b) < 1) throw new Error("That would leave nothing of the element.");
}

/** Trim/Extend to Corner: both elements meet at their intersection; the picked parts are kept. */
export function trimCorner(e1, p1, e2, p2) {
  straight(e1, e2);
  trimTo(e1, e2.a, e2.b, p1);
  trimTo(e2, e1.a, e1.b, p2);
}

/** Splits at point p (optionally with a gap). Returns the new second element. */
export function split(doc, el, p, gap = 0) {
  if (el.pinned) throw new Error("A pinned element cannot change. Unpin it first (UP).");
  if (el.shape === "line") {
    const t = Math.max(0, Math.min(1, paramOn(el, p))), L = G.dist(el.a, el.b), u = G.norm(G.sub(el.b, el.a));
    const at = t * L;
    if (at - gap / 2 < 1 || L - at - gap / 2 < 1) throw new Error("Pick a point inside the element, away from its ends.");
    const second = copyOf(el);
    second.a = G.add(el.a, G.mul(u, at + gap / 2));
    el.b = G.add(el.a, G.mul(u, at - gap / 2));
    doc[collOf(el)].push(second);
    if (isWallEl(el)) rehost(doc, el, second, at - gap / 2, at + gap / 2);
    return second;
  }
  if (G.isCircle(el)) throw new Error("A full circle cannot be split at one point.");
  const ang = G.angleOf(G.sub(p, el.c));
  let s = G.wrap(ang - el.start); if (el.sweep < 0) s = s - G.TAU;
  const g = gap / el.r * Math.sign(el.sweep);
  if (Math.abs(s) <= Math.abs(g / 2) || Math.abs(s) >= Math.abs(el.sweep) - Math.abs(g / 2)) throw new Error("Pick a point inside the arc, away from its ends.");
  const second = copyOf(el);
  second.start = el.start + s + g / 2; second.sweep = el.sweep - s - g / 2;
  el.sweep = s - g / 2;
  doc[collOf(el)].push(second);
  return second;
}

/** Removes the piece between two points on one straight element (Split with "Delete inner segment"). */
export function deleteBetween(doc, el, p, q) {
  straight(el);
  const [t1, t2] = [paramOn(el, p), paramOn(el, q)].sort((x, y) => x - y);
  if (t1 <= 0.0001 && t2 >= 0.9999) throw new Error("That would remove the whole element.");
  const a = el.a, b = el.b, A = G.lerp(a, b, t1), B = G.lerp(a, b, t2);
  if (t1 <= 0.0001) { el.a = B; return null; }
  if (t2 >= 0.9999) { el.b = A; return null; }
  const second = copyOf(el); second.a = B; second.b = b; el.b = A;
  doc[collOf(el)].push(second);
  if (isWallEl(el)) rehost(doc, el, second, t1 * G.dist(a, b), t2 * G.dist(a, b));
  return second;
}

/** After a wall is cut into [0, cutA] and [cutB, end], moves its doors and windows to the right piece. */
function rehost(doc, first, second, cutA, cutB) {
  for (const o of [...(doc.openings || [])].filter(q => q.hostWallId === first.id)) {
    const t = (o.kind === "door" ? doc.doorTypes : doc.windowTypes).find(x => x.id === o.typeId);
    const half = (t?.width || 0) / 2, s0 = o.positionAlongWall - half, s1 = o.positionAlongWall + half;
    if (s1 <= cutA + 0.5) continue;
    if (s0 >= cutB - 0.5) { o.hostWallId = second.id; o.positionAlongWall -= cutB; continue; }
    if (cutA === cutB || s0 < cutA - 0.5) throw new Error("That would cut through a door or window. Pick a point clear of it.");
    doc.openings.splice(doc.openings.indexOf(o), 1); // inside the removed piece
  }
}

// ---------------------------------------------------------------- chamfer and fillet
/** The corner of two straight elements and, for each, the direction along it away from the corner on its picked side. */
function corner(e1, p1, e2, p2) {
  straight(e1, e2);
  const hit = G.lineIntersect(e1.a, e1.b, e2.a, e2.b);
  if (!hit) throw new Error("These are parallel, so they have no corner.");
  const X = hit.point;
  const away = (e, p) => { const v = G.sub(p, X); const u = G.norm(G.sub(e.b, e.a)); return G.dot(v, u) >= 0 ? u : G.mul(u, -1); };
  return { X, u1: away(e1, p1), u2: away(e2, p2) };
}

function setEndNear(e, X, newPt) { if (G.dist(e.a, X) < G.dist(e.b, X)) e.a = newPt; else e.b = newPt; }

/** Cuts the corner with a straight piece d1 along the first and d2 along the second. Returns the new piece. */
export function chamfer(doc, e1, p1, e2, p2, d1, d2) {
  if (!(d1 > 0 && d2 > 0)) throw new Error("Both chamfer distances must be more than 0.");
  if (e1.pinned || e2.pinned) throw new Error("A pinned element cannot change. Unpin it first (UP).");
  trimCorner(e1, p1, e2, p2);
  const { X, u1, u2 } = corner(e1, p1, e2, p2);
  const A = G.add(X, G.mul(u1, d1)), B = G.add(X, G.mul(u2, d2));
  const far1 = G.dist(e1.a, X) < G.dist(e1.b, X) ? e1.b : e1.a, far2 = G.dist(e2.a, X) < G.dist(e2.b, X) ? e2.b : e2.a;
  if (G.dist(far1, X) <= d1 + 1 || G.dist(far2, X) <= d2 + 1) throw new Error("The chamfer is longer than the element.");
  setEndNear(e1, X, A); setEndNear(e2, X, B);
  const piece = copyOf(e1); piece.a = A; piece.b = B;
  doc[collOf(e1)].push(piece);
  return piece;
}

/** Rounds the corner with an arc of radius r (r = 0 just trims to the corner). Returns the arc. */
export function fillet(doc, e1, p1, e2, p2, r) {
  if (e1.pinned || e2.pinned) throw new Error("A pinned element cannot change. Unpin it first (UP).");
  trimCorner(e1, p1, e2, p2);
  if (!(r > 0)) return null;
  const { X, u1, u2 } = corner(e1, p1, e2, p2);
  const theta = Math.acos(Math.max(-1, Math.min(1, G.dot(u1, u2)))); // angle between the two legs
  if (theta < 1e-3 || theta > Math.PI - 1e-3) throw new Error("These lines are in line with each other; there is no corner to round.");
  const t = r / Math.tan(theta / 2);
  const far1 = G.dist(e1.a, X) < G.dist(e1.b, X) ? e1.b : e1.a, far2 = G.dist(e2.a, X) < G.dist(e2.b, X) ? e2.b : e2.a;
  if (G.dist(far1, X) <= t + 1 || G.dist(far2, X) <= t + 1) throw new Error("The radius is too large for these elements.");
  const T1 = G.add(X, G.mul(u1, t)), T2 = G.add(X, G.mul(u2, t));
  const bis = G.norm(G.add(u1, u2));
  const centre = G.add(X, G.mul(bis, r / Math.sin(theta / 2)));
  const mid = G.add(centre, G.mul(G.norm(G.sub(X, centre)), r));
  setEndNear(e1, X, T1); setEndNear(e2, X, T2);
  const arc = G.arcFrom3(T1, mid, T2);
  const piece = copyOf(e1);
  delete piece.a; delete piece.b;
  Object.assign(piece, { shape: "arc", c: arc.c, r: arc.r, start: arc.start, sweep: arc.sweep });
  doc[collOf(e1)].push(piece);
  return piece;
}

// ---------------------------------------------------------------- align
/** Reference lines an element offers for Align: its location line, and for walls its two faces. */
export function alignLines(el, footprint) {
  if (el.shape !== "line") return [];
  const out = [{ a: el.a, b: el.b, kind: "location" }];
  if (footprint) {
    const c0 = footprint.centre[0], c1 = footprint.centre.at(-1), n = G.perp(G.norm(G.sub(c1, c0))), h = footprint.h;
    out.push({ a: c0, b: c1, kind: "centre" }, { a: G.add(c0, G.mul(n, h)), b: G.add(c1, G.mul(n, h)), kind: "face" }, { a: G.sub(c0, G.mul(n, h)), b: G.sub(c1, G.mul(n, h)), kind: "face" });
  }
  return out;
}

/** Moves `el` so its line `own` (one of alignLines) lies on reference line ref. Lines must be parallel. Returns the move. */
export function alignMove(ref, own) {
  const u = G.norm(G.sub(ref.b, ref.a)), v = G.norm(G.sub(own.b, own.a));
  if (Math.abs(G.cross(u, v)) > 1e-3) throw new Error("Align needs parallel lines. Pick a reference parallel to the element.");
  const n = G.perp(u);
  return G.mul(n, G.dot(G.sub(ref.a, own.a), n));
}

/** Re-applies locked alignments after an edit: each locked pair keeps its two lines on one line. */
export function enforceLocks(doc, footprintOf, move = null) {
  for (const lock of doc.constraints || []) {
    const A = doc.walls.find(w => w.id === lock.ref) || doc.lines.find(l => l.id === lock.ref);
    const B = doc.walls.find(w => w.id === lock.el) || doc.lines.find(l => l.id === lock.el);
    if (!A || !B || A.shape !== "line" || B.shape !== "line") continue;
    const ra = alignLines(A, isWallEl(A) ? footprintOf(A) : null)[lock.refIdx];
    const rb = alignLines(B, isWallEl(B) ? footprintOf(B) : null)[lock.elIdx];
    if (!ra || !rb) continue;
    try {
      const d = alignMove(ra, rb);
      if (G.len(d) > 0.01) { if (move) move(doc, B.id, d); else { B.a = G.add(B.a, d); B.b = G.add(B.b, d); } }
    } catch { /* no longer parallel: the lock no longer applies */ }
  }
}
