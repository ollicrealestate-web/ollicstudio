// Plane geometry in millimetres. Points are {x, y}; plan y points north (up on screen).
export const EPS = 1e-6;
export const TAU = Math.PI * 2;

export const P = (x, y) => ({ x, y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const len = a => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = a => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
/** Left-hand normal (90 degrees counter-clockwise). */
export const perp = a => ({ x: -a.y, y: a.x });
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const mid = (a, b) => lerp(a, b, 0.5);
export const angleOf = v => Math.atan2(v.y, v.x);
export const fromAngle = (ang, r = 1) => ({ x: Math.cos(ang) * r, y: Math.sin(ang) * r });
export const same = (a, b, tol = 0.5) => dist(a, b) <= tol;
export const round = (v, step = 1) => Math.round(v / step) * step;

/** Normalises an angle to [0, 2π). */
export const wrap = a => ((a % TAU) + TAU) % TAU;

export function projectOnSegment(p, a, b) {
  const ab = sub(b, a), L2 = dot(ab, ab);
  if (L2 < EPS) return { t: 0, point: a, dist: dist(p, a) };
  const tRaw = dot(sub(p, a), ab) / L2;
  const t = Math.max(0, Math.min(1, tRaw));
  const point = lerp(a, b, t);
  return { t, tRaw, point, dist: dist(p, point) };
}

/** Intersection of lines AB and CD. Returns {point, t, u} (parameters on AB and CD) or null if parallel. */
export function lineIntersect(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c), den = cross(r, s);
  if (Math.abs(den) < EPS * Math.max(1, len(r) * len(s))) return null;
  const t = cross(sub(c, a), s) / den, u = cross(sub(c, a), r) / den;
  return { point: add(a, mul(r, t)), t, u };
}

/** Intersection of segments (both parameters within [0,1], with a small tolerance in mm). */
export function segIntersect(a, b, c, d, tolMm = 0.01) {
  const hit = lineIntersect(a, b, c, d);
  if (!hit) return null;
  const ta = tolMm / (dist(a, b) || 1), tc = tolMm / (dist(c, d) || 1);
  if (hit.t < -ta || hit.t > 1 + ta || hit.u < -tc || hit.u > 1 + tc) return null;
  return hit;
}

/** Intersections of the infinite line AB with a circle. */
export function lineCircle(a, b, c, r) {
  const d = sub(b, a), f = sub(a, c);
  const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - r * r;
  const disc = B * B - 4 * A * C;
  if (A < EPS || disc < -EPS) return [];
  const s = Math.sqrt(Math.max(0, disc));
  const ts = disc < EPS ? [-B / (2 * A)] : [(-B - s) / (2 * A), (-B + s) / (2 * A)];
  return ts.map(t => ({ t, point: add(a, mul(d, t)) }));
}

export function circleCircle(c1, r1, c2, r2) {
  const d = dist(c1, c2);
  if (d < EPS || d > r1 + r2 + EPS || d < Math.abs(r1 - r2) - EPS) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const u = norm(sub(c2, c1)), m = add(c1, mul(u, a));
  if (h < EPS) return [m];
  const n = perp(u);
  return [add(m, mul(n, h)), sub(m, mul(n, h))];
}

// ---- arcs: {c, r, start, sweep} with sweep signed in radians; |sweep| = 2π is a full circle ----
export const isCircle = arc => Math.abs(Math.abs(arc.sweep) - TAU) < 1e-9;
export const arcPoint = (arc, ang) => add(arc.c, fromAngle(ang, arc.r));
export const arcStart = arc => arcPoint(arc, arc.start);
export const arcEnd = arc => arcPoint(arc, arc.start + arc.sweep);
export const arcMid = arc => arcPoint(arc, arc.start + arc.sweep / 2);
export const arcLength = arc => Math.abs(arc.sweep) * arc.r;

/** True when angle `ang` lies on the arc. */
export function onArc(arc, ang, tol = 1e-7) {
  if (isCircle(arc)) return true;
  const s = arc.sweep >= 0 ? arc.start : arc.start + arc.sweep;
  const sw = Math.abs(arc.sweep);
  return wrap(ang - s) <= sw + tol;
}

/** Arc through three points (start, a point on it, end), or null if they are in a line. */
export function arcFrom3(p1, p2, p3) {
  const a = mid(p1, p2), b = mid(p2, p3);
  const hit = lineIntersect(a, add(a, perp(sub(p2, p1))), b, add(b, perp(sub(p3, p2))));
  if (!hit) return null;
  const c = hit.point, r = dist(c, p1);
  const a1 = angleOf(sub(p1, c)), a2 = angleOf(sub(p2, c)), a3 = angleOf(sub(p3, c));
  let sweep = wrap(a3 - a1);
  if (wrap(a2 - a1) > sweep) sweep -= TAU; // p2 not on the ccw arc: go clockwise
  return { c, r, start: a1, sweep };
}

/** Arc by start, end and radius; `side` > 0 bulges to the left of start→end. */
export function arcFromEndsRadius(p1, p2, r, side = 1) {
  const chord = dist(p1, p2);
  if (r < chord / 2 - EPS) return null;
  const m = mid(p1, p2), h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
  const n = perp(norm(sub(p2, p1)));
  const c = sub(m, mul(n, h * Math.sign(side || 1)));
  const a1 = angleOf(sub(p1, c)), a2 = angleOf(sub(p2, c));
  let sweep = wrap(a2 - a1);
  if (side < 0) sweep -= TAU;
  return { c, r, start: a1, sweep };
}

export function nearestOnArc(arc, p) {
  const ang = angleOf(sub(p, arc.c));
  if (onArc(arc, ang)) { const q = arcPoint(arc, ang); return { point: q, dist: dist(p, q), ang }; }
  const s = arcStart(arc), e = arcEnd(arc);
  return dist(p, s) < dist(p, e) ? { point: s, dist: dist(p, s), ang: arc.start } : { point: e, dist: dist(p, e), ang: arc.start + arc.sweep };
}

/** Tangent points on a circle seen from an outside point. */
export function tangentPoints(c, r, p) {
  const d = dist(c, p);
  if (d <= r + EPS) return [];
  const base = angleOf(sub(p, c)), off = Math.acos(r / d);
  return [arcPoint({ c, r }, base + off), arcPoint({ c, r }, base - off)];
}

/** Signed polygon area (positive counter-clockwise). */
export function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a.x * b.y - b.x * a.y; }
  return s / 2;
}

/** Point in polygon (even-odd). */
export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Holds a direction to 0/90 degrees (orthogonal) or the nearest multiple of `stepDeg`. */
export function constrainAngle(from, p, { ortho = false, stepDeg = 15, tolDeg = 3 } = {}) {
  const v = sub(p, from), L = len(v);
  if (L < EPS) return p;
  const ang = angleOf(v);
  const step = (ortho ? 90 : stepDeg) * Math.PI / 180;
  const snapped = Math.round(ang / step) * step;
  if (ortho || Math.abs(snapped - ang) <= tolDeg * Math.PI / 180) {
    const q = add(from, fromAngle(snapped, L));
    return { x: q.x, y: q.y, angleSnapped: true, deg: Math.round((snapped * 180 / Math.PI + 360) % 360) };
  }
  return p;
}

/** Regular polygon corners: inscribed (corners on the circle) or circumscribed (edges touch it). */
export function regularPolygon(c, radiusPoint, sides, mode = "inscribed") {
  const r0 = dist(c, radiusPoint), a0 = angleOf(sub(radiusPoint, c));
  const r = mode === "circumscribed" ? r0 / Math.cos(Math.PI / sides) : r0;
  const start = mode === "circumscribed" ? a0 + Math.PI / sides : a0;
  return Array.from({ length: sides }, (_, i) => add(c, fromAngle(start + (i * TAU) / sides, r)));
}

/** Rectangle corners from two opposite corners, counter-clockwise. */
export function rectangle(p1, p2) {
  return [P(p1.x, p1.y), P(p2.x, p1.y), P(p2.x, p2.y), P(p1.x, p2.y)];
}

export function fmtMm(v) { return String(Math.round(v)); }
export function fmtDeg(rad) { return `${(Math.round(((rad * 180) / Math.PI) * 100) / 100).toString()}°`; }
