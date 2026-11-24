// Camera angles the way an architect sets them: a lens in millimetres, a camera height in metres, an angle around
// the building from its front, straight vertical lines (the camera stays level and the picture slides, like a shift
// lens) and a picture shape. Pure maths on plain numbers, so the live view, the guides, Photo mode, the films and
// the tests all use exactly the same camera.
//
// Coordinates: y up; the building's footprint in x and z. front: a horizontal unit vector [x, z] pointing from the
// building out of its front. Azimuth: degrees around the building from the front, positive toward the right of a
// person facing the front (front-right corner = +45).

export const SENSOR = 36;   // full-frame: 36 x 24 mm
const D = Math.PI / 180;

/** The angle of view across the long side of the picture for a lens (degrees). 24 mm: 73.7; 35 mm: 54.4. */
export const longAngle = mm => 2 * Math.atan(SENSOR / (2 * mm)) / D;
/** Horizontal and vertical angles of view (degrees) for a lens and a picture shape (width / height). */
export function anglesOf(mm, aspect) {
  const t = Math.tan(longAngle(mm) * D / 2);
  const th = aspect >= 1 ? t : t * aspect, tv = aspect >= 1 ? t / aspect : t;
  return { h: 2 * Math.atan(th) / D, v: 2 * Math.atan(tv) / D };
}
/** The lens (mm) that gives a horizontal angle of view (degrees) at a picture shape (for matching a picture). */
export function lensFor(hDeg, aspect) {
  const th = Math.tan(hDeg * D / 2), t = aspect >= 1 ? th : th / aspect;
  return SENSOR / (2 * t);
}

export const SHAPES = { "3:2": 1.5, "16:9": 16 / 9, "4:5": 0.8, "1:1": 1, "9:16": 9 / 16 };

/**
 * The ready-made angles. height: metres above the ground (or heightK x the building's height); fill: the share of
 * the picture the building fills; straight: vertical lines kept straight; pitch: degrees down (positive) or up
 * (negative) when not straight; foreground: what the render shows in front.
 */
export const PRESETS = {
  "front-eye": { name: "Front, eye level", words: "eye-level frontal elevation", azimuth: 0, height: 1.6, lens: 35, straight: true, fill: 0.85, ground: 0.06 },
  "front-raised": { name: "Front, raised", words: "frontal view from a raised position across the street", azimuth: 0, height: 6.5, lens: 32, straight: true, fill: 0.8, ground: 0.12 },
  "corner-eye-left": { name: "Corner, eye level (front-left)", words: "three-quarter corner view from the front-left at eye level, two-point perspective", azimuth: -45, height: 1.6, lens: 26, straight: true, fill: 0.8, ground: 0.07 },
  "corner-eye-right": { name: "Corner, eye level (front-right)", words: "three-quarter corner view from the front-right at eye level, two-point perspective", azimuth: 45, height: 1.6, lens: 26, straight: true, fill: 0.8, ground: 0.07 },
  "drone-corner-left": { name: "Drone corner (front-left)", words: "elevated three-quarter corner view from the front-left at low drone height, two-point perspective", azimuth: -45, heightK: 1.35, lens: 24, straight: true, fill: 0.72, ground: 0.2, foreground: "street" },
  "drone-corner-right": { name: "Drone corner (front-right)", words: "elevated three-quarter corner view from the front-right at low drone height, two-point perspective", azimuth: 45, heightK: 1.35, lens: 24, straight: true, fill: 0.72, ground: 0.2, foreground: "street" },
  aerial: { name: "High aerial", words: "high aerial view looking down at about 40 degrees over the whole site", azimuth: 30, lens: 35, straight: false, pitch: 40, fill: 0.6 },
  "hero-low": { name: "Low hero angle", words: "dramatic low-angle hero view from near the ground by the entrance, looking up", azimuth: 15, height: 0.4, lens: 19, straight: false, pitch: -12, fill: 0.92 },
  side: { name: "Side (right)", words: "side elevation from the right at eye level", azimuth: 90, height: 1.6, lens: 35, straight: true, fill: 0.85, ground: 0.06 },
  "side-left": { name: "Side (left)", words: "side elevation from the left at eye level", azimuth: -90, height: 1.6, lens: 35, straight: true, fill: 0.85, ground: 0.06 },
  rear: { name: "Rear", words: "rear elevation at eye level", azimuth: 180, height: 1.6, lens: 35, straight: true, fill: 0.85, ground: 0.06 },
  "rear-left": { name: "Corner (rear-left)", words: "three-quarter view from the rear-left corner at eye level", azimuth: -135, height: 1.6, lens: 26, straight: true, fill: 0.8, ground: 0.07 },
  "rear-right": { name: "Corner (rear-right)", words: "three-quarter view from the rear-right corner at eye level", azimuth: 135, height: 1.6, lens: 26, straight: true, fill: 0.8, ground: 0.07 },
  entrance: { name: "Entrance close-up", words: "eye-level close-up of the main entrance", azimuth: 0, height: 1.6, lens: 50, straight: true, fill: 0.7, ground: 0.08, target: "entrance" },
  plan: { name: "Site plan from above", words: "site plan seen straight down from above, no perspective", plan: true, lens: 600, fill: 0.85 },
  "interior-one": { name: "Interior, one-point", words: "interior one-point perspective at 1.2 m, vertical lines straight", interior: "one", height: 1.2, lens: 18, straight: true },
  "interior-two": { name: "Interior, two-point", words: "interior two-point perspective from a corner at 1.2 m, vertical lines straight", interior: "two", height: 1.2, lens: 18, straight: true },
};
export const DEFAULTS = { preset: "front-eye", lens: 35, height: 1.6, distance: "fit", azimuth: 0, pitch: 0, straight: true, shiftX: 0, shiftY: 0, aspect: "3:2", fill: 0.85 };

/** A preset's settings (a building height turns low drone into metres). */
export function presetSettings(key, buildingHeight = 12) {
  const p = PRESETS[key];
  if (!p) return null;
  return {
    preset: key, lens: p.lens, azimuth: p.azimuth ?? 0, height: p.heightK ? +(p.heightK * buildingHeight).toFixed(2) : p.height ?? 1.6,
    pitch: p.straight ? 0 : p.pitch ?? 0, straight: !!p.straight, distance: "fit", shiftX: 0, shiftY: 0, fill: p.fill ?? 0.85, ground: p.ground ?? 0.08,
    foreground: p.foreground || null, plan: !!p.plan, interior: p.interior || null, target: p.target || null,
  };
}

// ---------------------------------------------------------------- the solver
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
/** The camera's own axes for a horizontal heading (unit [x, z], where it looks) and a pitch (degrees down). */
function basis(heading, pitchDeg) {
  const p = -pitchDeg * D, f = norm([heading[0] * Math.cos(p), Math.sin(p), heading[1] * Math.cos(p)]);
  const r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
  return { f, r, u };
}
/** Where points fall in the picture (-1 to 1 across and up) from a camera; null for a point behind it. */
export function project(points, cam) {
  const { f, r, u } = basis(cam.heading, cam.pitch), th = Math.tan(cam.h * D / 2), tv = Math.tan(cam.v * D / 2);
  return points.map(p => { const d = sub(p, cam.position), z = dot(d, f); return z <= 0.05 ? null : [dot(d, r) / z / th + cam.shift[0] * 2, dot(d, u) / z / tv + cam.shift[1] * 2]; });
}
const cornersOf = b => { const o = []; for (let i = 0; i < 8; i++) o.push([i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]); return o; };
const rotate = ([x, z], deg) => { const a = deg * D; return [x * Math.cos(a) - z * Math.sin(a), x * Math.sin(a) + z * Math.cos(a)]; };

/**
 * The camera for settings on a building. box: { min: [x, y, z], max: [...] } (the building), ground: the ground's y,
 * front: [x, z], aspect: the picture's width / height, entrance: [x, y, z] (the main entrance, if known).
 * Returns { position, target, heading, pitch, h, v (angles of view, degrees), shift: [x, y] (fractions of the
 * picture), straight, distance, lens, aspect }.
 */
export function solve(s, { box, ground = box.min[1], front = [0, 1], aspect = 1.5, entrance = null }) {
  const lens = s.lens || 35, { h, v } = anglesOf(lens, aspect);
  const c = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const H = box.max[1] - ground, size = Math.hypot(box.max[0] - box.min[0], box.max[2] - box.min[2], H);
  if (s.plan) {   // straight down from far away with a long lens: no perspective to speak of
    const span = Math.max(box.max[0] - box.min[0], box.max[2] - box.min[2]) / (s.fill || 0.85);
    const dist = span / 2 / Math.tan(Math.min(h, v) * D / 2);
    const up = rotate(front, 180);   // the front at the bottom of the picture
    return { position: [c[0] + up[0] * 1e-4, box.max[1] + dist, c[2] + up[1] * 1e-4], target: [c[0], c[1], c[2]], heading: up, pitch: 90,
      h, v, shift: [0, 0], straight: false, distance: dist, lens, aspect, plan: true, up: [-front[0], 0, -front[1]] };
  }
  const out = rotate(front, -(s.azimuth || 0));         // from the building toward the camera (positive: to the right of a person facing the front)
  const heading = [-out[0], -out[1]];                   // where the camera looks
  const straight = s.straight !== false, pitch = straight ? 0 : (s.pitch || 0);
  const pts = cornersOf({ min: [box.min[0], ground, box.min[2]], max: box.max });
  const focus = s.target === "entrance" && entrance ? entrance : c;
  const focusPts = s.target === "entrance" && entrance ? cornersOf({ min: [entrance[0] - 2.2, ground, entrance[2] - 2.2], max: [entrance[0] + 2.2, ground + 3.2, entrance[2] + 2.2] }) : pts;
  const fill = s.fill || 0.85, camY = ground + (s.height ?? 1.6);
  const place = dist => {
    // horizontal distance from the focus, along the camera's line; the height is the set height (or, for a pitched
    // camera without a set height, along the pitch)
    const y = !straight && s.height == null ? focus[1] + Math.sin(pitch * D) * dist : camY;
    return [focus[0] + out[0] * dist, y, focus[2] + out[1] * dist];
  };
  const camAt = (dist, shift = [0, 0]) => ({ position: place(dist), heading, pitch: straight ? 0 : aimPitch(place(dist)), h, v, shift });
  // a pitched camera looks at the focus
  const aimPitch = p => { const dx = Math.hypot(focus[0] - p[0], focus[2] - p[2]); return Math.atan2(p[1] - focus[1], dx) / D; };
  const extent = dist => {
    const q = project(focusPts, camAt(dist));
    if (q.some(x => !x)) return null;
    const xs = q.map(x => x[0]), ys = q.map(x => x[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  // the distance at which the building fills its share of the picture (2 = the full picture in these units)
  const fits = e => e && (e.x1 - e.x0) <= 2 * fill && (e.y1 - e.y0) <= 2 * fill;
  let dist = s.distance === "fit" || s.distance == null ? null : +s.distance;
  if (dist == null) {
    let lo = 0.5, hi = size * 60;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (fits(extent(m))) hi = m; else lo = m; }
    dist = hi;
  }
  const e = extent(dist) || { x0: -1, x1: 1, y0: -1, y1: 1 };
  // straight vertical lines: the picture slides (shift) so the building sits where it should: centred across, and
  // up and down with a little ground below it (ground: the share of the picture under the building)
  let shift = [0, 0];
  if (straight) {
    const gy = s.ground ?? 0.08, bottom = -1 + 2 * gy, top = bottom + (e.y1 - e.y0);
    shift = [-(e.x0 + e.x1) / 4, (bottom - e.y0) / 2];
    if (top > 1) shift[1] = (-(e.y0 + e.y1) / 2) / 2;   // taller than the picture: centre it
  }
  shift = [shift[0] + (s.shiftX || 0), shift[1] + (s.shiftY || 0)];
  const cam = camAt(dist, shift);
  const { f } = basis(heading, cam.pitch);
  const p = cam.position, target = [p[0] + f[0] * dist, p[1] + f[1] * dist, p[2] + f[2] * dist];
  return { position: p, target, heading, pitch: cam.pitch, h, v, shift, straight, distance: dist, lens, aspect };
}

/**
 * The same camera drawn into a picture of another shape (the live view's canvas, or a guide): the set picture fits
 * inside it, so its angles of view and its shift change, but what the set picture shows does not.
 */
export function forOutput(cam, outAspect) {
  const a = cam.aspect;
  if (Math.abs(outAspect - a) < 1e-6) return { v: cam.v, shift: cam.shift };
  const tv = Math.tan(cam.v * D / 2), th = Math.tan(cam.h * D / 2);
  if (outAspect > a) return { v: cam.v, shift: [cam.shift[0] * a / outAspect, cam.shift[1]] };       // wider: same height
  const tvOut = th / outAspect;                                                                       // narrower: same width
  return { v: 2 * Math.atan(tvOut) / D, shift: [cam.shift[0], cam.shift[1] * (tv / tvOut)] };
}

// ---------------------------------------------------------------- words
const NUM = s => parseFloat(String(s).replace(",", "."));
/**
 * Camera settings from a description ("elevated three-quarter corner view, low drone height, two-point perspective
 * with vertical lines kept straight, 24 mm wide-angle lens, street intersection in foreground"). Without any AI: a
 * table of the words architects use. Returns the settings it understood and what it took them from.
 */
export function fromWords(text, buildingHeight = 12) {
  const t = ` ${String(text || "").toLowerCase()} `, said = [];
  const has = re => re.test(t);
  let key = "front-eye";
  const left = has(/front[- ]?left|left[- ]?(hand )?(front )?corner|from the left corner/), right = has(/front[- ]?right|right[- ]?(hand )?(front )?corner|from the right corner/);
  const corner = has(/corner|three[- ]?quarter|3\/4|two[- ]point|2[- ]point|oblique|angled/);
  const drone = has(/drone|elevated|bird|aerial|from above|high (angle|view)|raised/);
  const high = has(/high aerial|bird'?s[- ]eye|overhead|top[- ]down|looking down at (about )?[3-6]\d/);
  if (has(/site plan|plan view|straight down|top view/)) key = "plan";
  else if (has(/interior|inside|living room|bedroom|kitchen|lobby/)) key = has(/two[- ]point|corner/) ? "interior-two" : "interior-one";
  else if (has(/worm'?s|low[- ]angle|hero|looking up|from the ground/)) key = "hero-low";
  else if (has(/entrance|front door|close[- ]?up|detail/)) key = "entrance";
  else if (high) key = "aerial";
  else if (has(/\brear\b|\bback\b/)) key = corner ? (left ? "rear-left" : "rear-right") : "rear";
  else if (has(/\bside\b/) && !corner) key = left ? "side-left" : "side";
  else if (corner && drone) key = left ? "drone-corner-left" : "drone-corner-right";
  else if (corner) key = left ? "corner-eye-left" : "corner-eye-right";
  else if (drone) key = "front-raised";
  said.push(PRESETS[key].name);
  const s = presetSettings(key, buildingHeight);
  const mm = t.match(/(\d{2,3}(?:[.,]\d)?)\s*-?\s*mm/);
  if (mm) { s.lens = Math.min(135, Math.max(14, NUM(mm[1]))); said.push(`${s.lens} mm`); }
  else if (has(/ultra[- ]wide/)) { s.lens = 16; said.push("16 mm (ultra-wide)"); }
  else if (has(/wide[- ]angle/) && !mm) { s.lens = Math.min(s.lens, 24); said.push(`${s.lens} mm (wide-angle)`); }
  else if (has(/telephoto|long lens|compressed/)) { s.lens = 85; said.push("85 mm (long lens)"); }
  const hm = t.match(/(\d+(?:[.,]\d+)?)\s*(m|metres|meters)\b\s*(high|up|above|height)?/);
  if (hm && hm[3] && key !== "plan") { s.height = NUM(hm[1]); said.push(`${s.height} m up`); }
  else if (has(/eye[- ]level|standing|person'?s height/) && !drone) { s.height = 1.6; said.push("eye level (1.6 m)"); }
  else if (has(/low drone/)) { s.height = +(1.35 * buildingHeight).toFixed(2); said.push(`low drone (${s.height} m)`); }
  const deg = t.match(/(\d{2})\s*(°|deg|degrees?)\b/);
  if (deg && (key === "corner-eye-left" || key === "corner-eye-right" || key.startsWith("drone"))) { s.azimuth = Math.sign(s.azimuth || 1) * NUM(deg[1]); said.push(`${NUM(deg[1])}° off the front`); }
  if (has(/vertical(s| lines)? (kept )?straight|two[- ]point|2[- ]point|straight verticals|shift lens|no converging/)) { s.straight = true; s.pitch = 0; said.push("vertical lines straight"); }
  else if (has(/converg|three[- ]point|3[- ]point/)) { s.straight = false; said.push("vertical lines converging"); }
  if (has(/street|road|junction|intersection/) && has(/foreground|in front/)) { s.foreground = "street"; said.push("street in the foreground"); }
  if (has(/portrait|vertical (picture|format)/)) { s.aspect = "4:5"; said.push("portrait 4:5"); }
  else if (has(/16:9|widescreen|cinematic/)) { s.aspect = "16:9"; said.push("16:9"); }
  else if (has(/square/)) { s.aspect = "1:1"; said.push("square"); }
  else if (has(/9:16|reel|story|phone/)) { s.aspect = "9:16"; said.push("9:16"); }
  return { settings: s, understood: said };
}

/** The camera in words, for the render instructions. */
export function describe(s, buildingHeight = 12) {
  const p = PRESETS[s.preset] || {};
  const parts = [p.words || "a view of the building"];
  if (!p.plan) {
    parts.push(`camera ${s.height >= 3 ? `about ${Math.round(s.height)} m` : `${(+s.height).toFixed(1)} m`} above the ground`);
    const kind = s.lens <= 20 ? "ultra-wide" : s.lens <= 28 ? "wide-angle" : s.lens <= 40 ? "normal" : s.lens <= 70 ? "standard" : "long";
    parts.push(`${Math.round(s.lens)} mm ${kind} lens`);
    parts.push(s.straight ? (Math.abs(s.azimuth % 90) > 10 ? "two-point perspective with vertical lines kept perfectly straight and parallel" : "vertical lines perfectly straight and parallel") : "vertical lines converging naturally");
  }
  if (s.foreground === "street") parts.push("the street or junction in the foreground");
  parts.push("keep exactly this camera position, height, lens and framing; do not change the angle");
  void buildingHeight;
  return parts.join(", ");
}
