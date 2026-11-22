// Element helpers: which elements show in a view, their curves (for snaps and picking),
// and simple edits (move an end, translate). Walls, doors and the rest join this file phase by phase.
import * as G from "./geom.js";
import { newId } from "./model.js";

export const LINE_STYLES = {
  thin: { label: "Thin lines", px: 1, dash: null },
  medium: { label: "Medium lines", px: 2, dash: null },
  wide: { label: "Wide lines", px: 3.5, dash: null },
  hidden: { label: "Hidden lines", px: 1, dash: [6, 4] },
  centre: { label: "Centre lines", px: 1, dash: [14, 4, 2, 4] },
  sketch: { label: "Sketch lines", px: 2, dash: null, hidden: true },
};

export const CATEGORY = { lines: "Lines", walls: "Walls", openings: "Doors and windows", floors: "Floors", roofs: "Roofs", components: "Components", dimensions: "Dimensions" };

/** A plan view is identified by its level: "plan:<levelId>". */
export const planViewId = levelId => `plan:${levelId}`;

export function makeLine(kind, levelId, style, a, b) {
  return { id: newId(kind === "detail" ? "dl" : kind === "sketch" ? "sl" : "ml"), kind, levelId, viewId: kind !== "model" ? planViewId(levelId) : null, style, shape: "line", a: { ...a }, b: { ...b } };
}

export function makeArc(kind, levelId, style, arc) {
  return { id: newId(kind === "detail" ? "dl" : kind === "sketch" ? "sl" : "ml"), kind, levelId, viewId: kind !== "model" ? planViewId(levelId) : null, style, shape: "arc",
    c: { ...arc.c }, r: arc.r, start: arc.start, sweep: arc.sweep };
}

/** Lines visible in a plan view: model lines on its level, detail lines drawn in it. */
export function linesInPlan(doc, levelId) {
  const vid = planViewId(levelId);
  return doc.lines.filter(l => (l.kind === "model" && l.levelId === levelId) || ((l.kind === "detail" || l.kind === "sketch") && l.viewId === vid));
}

export function lineCurve(l) {
  return l.shape === "arc" ? { type: "arc", c: l.c, r: l.r, start: l.start, sweep: l.sweep, id: l.id } : { type: "seg", a: l.a, b: l.b, id: l.id };
}

export function lineLength(l) { return l.shape === "arc" ? G.arcLength(l) : G.dist(l.a, l.b); }

/** Curves for snapping/picking from everything visible in a plan. */
export function planCurves(doc, levelId) {
  return linesInPlan(doc, levelId).map(lineCurve);
}

/** Distance from p to an element (for picking). */
export function distanceTo(el, p) {
  if (el.shape === "arc") return G.nearestOnArc(el, p).dist;
  if (el.shape === "line") return G.projectOnSegment(p, el.a, el.b).dist;
  return Infinity;
}

/** Bounding box of an element in plan. */
export function bbox(el) {
  if (el.shape === "line") return { x0: Math.min(el.a.x, el.b.x), y0: Math.min(el.a.y, el.b.y), x1: Math.max(el.a.x, el.b.x), y1: Math.max(el.a.y, el.b.y) };
  if (el.shape === "arc") {
    const pts = [G.arcStart(el), G.arcEnd(el)];
    for (let k = 0; k < 4; k++) { const ang = (k * Math.PI) / 2; if (G.onArc(el, ang)) pts.push(G.arcPoint(el, ang)); }
    return { x0: Math.min(...pts.map(p => p.x)), y0: Math.min(...pts.map(p => p.y)), x1: Math.max(...pts.map(p => p.x)), y1: Math.max(...pts.map(p => p.y)) };
  }
  return null;
}

export function unionBox(boxes) {
  const b = boxes.filter(Boolean);
  if (!b.length) return null;
  return { x0: Math.min(...b.map(q => q.x0)), y0: Math.min(...b.map(q => q.y0)), x1: Math.max(...b.map(q => q.x1)), y1: Math.max(...b.map(q => q.y1)) };
}

const inside = (p, r) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;

/** Window selection: fully inside. Crossing: anything touching. */
export function inRect(el, r, crossing) {
  const b = bbox(el);
  if (!b) return false;
  const fully = b.x0 >= r.x0 && b.x1 <= r.x1 && b.y0 >= r.y0 && b.y1 <= r.y1;
  if (fully) return true;
  if (!crossing) return false;
  if (b.x1 < r.x0 || b.x0 > r.x1 || b.y1 < r.y0 || b.y0 > r.y1) return false;
  if (el.shape === "line") {
    if (inside(el.a, r) || inside(el.b, r)) return true;
    const c = [G.P(r.x0, r.y0), G.P(r.x1, r.y0), G.P(r.x1, r.y1), G.P(r.x0, r.y1)];
    return c.some((q, i) => G.segIntersect(el.a, el.b, q, c[(i + 1) % 4]));
  }
  // arcs: sample
  for (let k = 0; k <= 32; k++) if (inside(G.arcPoint(el, el.start + (el.sweep * k) / 32), r)) return true;
  return false;
}

/** Grips shown on a selected element: [{id:"a", point}], dragging one calls moveGrip. */
export function grips(el) {
  if (el.shape === "line") return [{ key: "a", point: el.a }, { key: "b", point: el.b }];
  if (el.shape === "arc" && !G.isCircle(el)) return [{ key: "start", point: G.arcStart(el) }, { key: "end", point: G.arcEnd(el) }, { key: "mid", point: G.arcMid(el) }];
  if (el.shape === "arc") return [{ key: "radius", point: G.arcPoint(el, el.start) }];
  return [];
}

export function moveGrip(el, key, p) {
  if (el.shape === "line") { el[key] = { x: p.x, y: p.y }; return; }
  if (el.shape !== "arc") return;
  if (key === "radius") { el.r = Math.max(1, G.dist(el.c, p)); el.start = G.angleOf(G.sub(p, el.c)); return; }
  const s = G.arcStart(el), e = G.arcEnd(el), m = G.arcMid(el);
  const arc = key === "start" ? G.arcFrom3(p, m, e) : key === "end" ? G.arcFrom3(s, m, p) : G.arcFrom3(s, p, e);
  if (arc) Object.assign(el, { c: arc.c, r: arc.r, start: arc.start, sweep: arc.sweep });
}

export function translate(el, d) {
  if (el.shape === "line") { el.a = G.add(el.a, d); el.b = G.add(el.b, d); }
  else if (el.shape === "arc") el.c = G.add(el.c, d);
  else if (Array.isArray(el.boundary)) el.boundary.forEach(c => translate(c, d)); // floors
}

/** Sets a straight line's length by moving its end (b), keeping direction. */
export function setLineLength(el, L) {
  if (el.shape !== "line" || !(L > 0)) return;
  el.b = G.add(el.a, G.mul(G.norm(G.sub(el.b, el.a)), L));
}
