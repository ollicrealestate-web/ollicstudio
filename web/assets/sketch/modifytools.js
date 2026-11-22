// Modify tools (Move, Copy, Rotate, Mirror, Scale, Array, Offset, Trim/Extend, Split, Align, Chamfer, Fillet).
// Each works on walls and lines, step by step, with the status bar saying what to click next.
import * as G from "./geom.js";
import * as M from "./modify.js";
import { COLORS } from "./plan.js";
import { locationPolyline } from "./walls.js";
import { wallAxis } from "./openings.js";

const fake = () => ({ walls: [], lines: [] });
const deg = r => Math.round((r * 180) / Math.PI * 100) / 100;

/** The element under the cursor (wall or line) and the point on it nearest the cursor. */
function picked(app, c) {
  // the hovered element if it is a wall or line; otherwise the first wall or line under the cursor (e.g. behind a door)
  let id = app.hoverCandidate();
  if (!id || id.startsWith("chain:") || !M.isCurve(app.lookup(id))) id = app.hoverList.find(h => !h.startsWith("chain:") && M.isCurve(app.lookup(h)));
  if (!id) return null;
  const el = app.lookup(id);
  const pts = locationPolyline(el);
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) { const pr = G.projectOnSegment(c.raw, pts[i], pts[i + 1]); if (!best || pr.dist < best.dist) best = pr; }
  return { id, el, at: best ? best.point : c.raw };
}

function ghost(view, el, color = COLORS.preview, dash = [6, 4]) {
  if (el.shape === "line") view.segment(el.a, el.b, color, 2, dash);
  else view.drawLine({ ...el, style: "medium" }, color);
}

/** Ghosts of the selected elements as they would be after the transform. */
function ghostIds(view, app, ids, Mx, color = COLORS.preview) {
  for (const id of ids) for (const o of app.outlineOf(id)) {
    const p = o.pts.map(q => M.apply(Mx, q));
    for (let i = 0; i < p.length - 1; i++) view.segment(p[i], p[i + 1], color, 2, [6, 4]);
    if (o.closed && p.length > 2) view.segment(p.at(-1), p[0], color, 2, [6, 4]);
  }
}
const HOOKS = { wallAxis };

function selectionCentre(app, ids) {
  const pts = ids.flatMap(id => app.outlineOf(id).flatMap(o => o.pts));
  if (!pts.length) return { x: 0, y: 0 };
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

class StepTool {
  constructor(app, name, title) {
    this.app = app; this.name = name; this.title = title;
    this.picks = []; this.cursor = null; this.wantsSnap = true;
    this.prefs = app.prefs[name] || (app.prefs[name] = {});
  }
  save() { this.app.savePrefs(); }
  hasFrom() { return this.picks.length > 0; }
  constrainFrom() { return this.picks.at(-1)?.x !== undefined ? this.picks.at(-1) : null; }
  move(c) { this.cursor = c.pt; this.app.updateHover(c); this.app.redraw(); }
  escape() { if (this.picks.length) { this.picks = []; this.app.toolChanged(); return true; } return false; }
  done(label) { this.picks = []; this.app.toolChanged(); if (label) this.app.toast(label); }
  get ids() { return [...this.app.selection].filter(id => M.canTransform(this.app.doc, id)); }
}

// ------------------------------------------------------------------ Move / Copy
export class MoveTool extends StepTool {
  constructor(app, copy = false) {
    super(app, copy ? "copy" : "move", copy ? "Copy" : "Move");
    this.copy = copy; this.needsSelection = true;
  }
  options() {
    const p = this.prefs, o = [{ type: "text", text: this.title, cls: "modename" },
      { type: "check", label: "Constrain", value: !!p.constrain, onChange: v => { p.constrain = v; this.save(); } }];
    if (!this.copy) o.push({ type: "check", label: "Disjoin", value: !!p.disjoin, onChange: v => { p.disjoin = v; this.save(); } });
    else o.push({ type: "check", label: "Multiple", value: !!p.multiple, onChange: v => { p.multiple = v; this.save(); } });
    return o;
  }
  prompt() { return this.picks.length ? "Click the destination, or type a distance and press Enter." : `Click a start point to ${this.copy ? "copy" : "move"} from.`; }
  down(c) {
    if (!this.picks.length) { this.picks.push(c.pt); this.app.toolChanged(); return; }
    this.apply(G.sub(c.pt, this.picks[0]));
  }
  constrainedDelta(d) {
    if (!this.prefs.constrain) return d;
    return Math.abs(d.x) >= Math.abs(d.y) ? { x: d.x, y: 0 } : { x: 0, y: d.y };
  }
  apply(delta) {
    delta = this.constrainedDelta(delta);
    const ids = this.ids, app = this.app;
    if (!ids.length) { app.toast("Nothing is selected."); return; }
    const made = app.commit(this.title, doc => {
      if (this.copy) return M.transformIds(doc, ids, M.translation(delta), { copy: true, hooks: HOOKS });
      if (ids.some(id => app.lookup(id)?.pinned)) throw new Error("A pinned element cannot move. Unpin it first (UP).");
      if (this.prefs.disjoin) M.transformIds(doc, ids, M.translation(delta), { hooks: HOOKS });
      else app.translateWithJoins(doc, ids, delta);
      return ids;
    });
    if (!made) return;
    if (this.copy && this.prefs.multiple) { this.app.toolChanged(); return; } // keep the start point for more copies
    if (this.copy) { app.selection.clear(); made.forEach(id => app.selection.add(id)); }
    this.picks = [];
    app.setTool("select");
  }
  typed(v) {
    if (!this.picks.length) return false;
    const from = this.picks[0], cur = this.cursor || G.add(from, { x: 1, y: 0 });
    const dir = G.dist(cur, from) > 1e-6 ? G.norm(G.sub(cur, from)) : { x: 1, y: 0 };
    this.apply(G.mul(dir, v));
    return true;
  }
  drawPreview(view) {
    if (!this.picks.length || !this.cursor) return;
    const d = this.constrainedDelta(G.sub(this.cursor, this.picks[0]));
    ghostIds(view, this.app, this.ids, M.translation(d));
    view.segment(this.picks[0], G.add(this.picks[0], d), COLORS.dim, 1, [4, 4]);
    if (G.len(d) > 1) view.tempDim(this.picks[0], G.add(this.picks[0], d), String(Math.round(G.len(d))));
  }
}

// ------------------------------------------------------------------ Rotate
export class RotateTool extends StepTool {
  constructor(app) { super(app, "rotate", "Rotate"); this.needsSelection = true; this.centre = selectionCentre(app, this.ids); this.placing = false; }
  options() {
    return [{ type: "text", text: "Rotate", cls: "modename" },
      { type: "check", label: "Copy", value: !!this.prefs.copy, onChange: v => { this.prefs.copy = v; this.save(); } },
      { type: "button", label: "Place centre", onClick: () => { this.placing = true; this.picks = []; this.app.toolChanged(); } },
      { type: "number", label: "Angle", value: "", step: 15, placeholder: "degrees", onChange: v => { if (Number.isFinite(v) && v !== 0) this.apply((v * Math.PI) / 180); } }];
  }
  prompt() {
    if (this.placing) return "Click the centre of rotation.";
    return this.picks.length ? "Click the end of the rotation, or type an angle in degrees and press Enter." : "Click a point to start the rotation from (the centre is shown as a blue cross), or type the angle in the Options Bar.";
  }
  hasFrom() { return true; }
  constrainFrom() { return this.centre; }
  down(c) {
    if (this.placing) { this.centre = c.pt; this.placing = false; this.app.toolChanged(); return; }
    if (!this.picks.length) { this.picks.push(c.pt); this.app.toolChanged(); return; }
    const a0 = G.angleOf(G.sub(this.picks[0], this.centre)), a1 = G.angleOf(G.sub(c.pt, this.centre));
    this.apply(a1 - a0);
  }
  apply(ang) {
    const app = this.app, ids = this.ids;
    const made = app.commit("Rotate", doc => M.transformIds(doc, ids, M.rotation(this.centre, ang), { copy: !!this.prefs.copy, hooks: HOOKS }));
    if (!made) return;
    if (this.prefs.copy) { app.selection.clear(); made.forEach(id => app.selection.add(id)); }
    this.picks = []; app.setTool("select"); app.toast(`Rotated ${deg(ang)}°`);
  }
  typed(v) { this.apply((v * Math.PI) / 180); return true; }
  drawPreview(view) {
    const c = this.centre, s = view.px(8);
    view.segment(G.add(c, { x: -s, y: 0 }), G.add(c, { x: s, y: 0 }), COLORS.sel, 2); view.segment(G.add(c, { x: 0, y: -s }), G.add(c, { x: 0, y: s }), COLORS.sel, 2);
    if (!this.cursor || this.placing) return;
    if (!this.picks.length) { view.segment(c, this.cursor, COLORS.dim, 1, [4, 4]); return; }
    const a = G.angleOf(G.sub(this.cursor, c)) - G.angleOf(G.sub(this.picks[0], c));
    view.segment(c, this.picks[0], COLORS.dim, 1, [4, 4]); view.segment(c, this.cursor, COLORS.dim, 1, [4, 4]);
    ghostIds(view, this.app, this.ids, M.rotation(c, a));
    view.label(G.add(c, { x: 0, y: view.px(-22) }), `${deg(((a % G.TAU) + G.TAU) % G.TAU)}°`, { color: COLORS.dim });
  }
}

// ------------------------------------------------------------------ Mirror (pick axis / draw axis)
export class MirrorTool extends StepTool {
  constructor(app, draw) { super(app, draw ? "mirrorDraw" : "mirrorPick", draw ? "Mirror - Draw Axis" : "Mirror - Pick Axis"); this.draw = draw; this.needsSelection = true; if (this.prefs.copy === undefined) this.prefs.copy = true; }
  options() { return [{ type: "text", text: this.title, cls: "modename" }, { type: "check", label: "Copy", value: !!this.prefs.copy, onChange: v => { this.prefs.copy = v; this.save(); } }]; }
  prompt() { return this.draw ? (this.picks.length ? "Click the end of the mirror axis." : "Click the start of the mirror axis.") : "Click a line or wall to mirror about."; }
  down(c) {
    if (!this.draw) {
      const p = picked(this.app, c);
      if (!p || p.el.shape !== "line") { this.app.toast("Click a straight line or wall to use as the axis."); return; }
      this.apply(p.el.a, p.el.b); return;
    }
    if (!this.picks.length) { this.picks.push(c.pt); this.app.toolChanged(); return; }
    if (G.dist(this.picks[0], c.pt) < 1) return;
    this.apply(this.picks[0], c.pt);
  }
  apply(a, b) {
    const app = this.app, ids = this.ids;
    const made = app.commit("Mirror", doc => M.transformIds(doc, ids, M.mirrorAcross(a, b), { copy: !!this.prefs.copy, hooks: HOOKS }));
    if (!made) return;
    app.selection.clear(); made.forEach(id => app.selection.add(id));
    this.picks = []; app.setTool("select");
  }
  drawPreview(view) {
    if (!this.cursor) return;
    let a, b;
    if (this.draw) { if (!this.picks.length) return; a = this.picks[0]; b = this.cursor; }
    else { const h = this.app.hoverId && this.app.lookup(this.app.hoverId); if (!h || h.shape !== "line") return; a = h.a; b = h.b; }
    if (G.dist(a, b) < 1) return;
    view.segment(a, b, COLORS.dim, 1, [10, 4, 2, 4]);
    ghostIds(view, this.app, this.ids, M.mirrorAcross(a, b));
  }
}

// ------------------------------------------------------------------ Scale
export class ScaleTool extends StepTool {
  constructor(app) { super(app, "scale", "Scale"); this.needsSelection = true; this.prefs.mode = this.prefs.mode || "graphical"; this.prefs.factor = this.prefs.factor || 2; }
  options() {
    return [{ type: "text", text: "Scale", cls: "modename" },
      { type: "select", label: "", value: this.prefs.mode, items: [{ value: "graphical", label: "Graphical" }, { value: "numerical", label: "Numerical" }], onChange: v => { this.prefs.mode = v; this.picks = []; this.save(); this.app.toolChanged(); } },
      ...(this.prefs.mode === "numerical" ? [{ type: "number", label: "Scale", value: this.prefs.factor, step: 0.1, min: 0.01, onChange: v => { if (v > 0) { this.prefs.factor = v; this.save(); } } }] : [])];
  }
  prompt() {
    if (this.prefs.mode === "numerical") return `Click the origin; the selection scales by ${this.prefs.factor} about it. Walls keep their thickness.`;
    return ["Click the origin.", "Click a reference point (sets the first length).", "Click the new point (sets the second length)."][this.picks.length] || "";
  }
  down(c) {
    this.picks.push(c.pt);
    if (this.prefs.mode === "numerical") return this.apply(this.picks[0], this.prefs.factor);
    if (this.picks.length === 3) {
      const r1 = G.dist(this.picks[0], this.picks[1]), r2 = G.dist(this.picks[0], this.picks[2]);
      if (r1 < 1) { this.picks = []; this.app.toast("The reference point must be away from the origin."); return; }
      return this.apply(this.picks[0], r2 / r1);
    }
    this.app.toolChanged();
  }
  apply(origin, k) {
    if (!(k > 0)) { this.app.toast("The scale must be more than 0.", true); return; }
    const made = this.app.commit("Scale", doc => M.transformIds(doc, this.ids, M.scaling(origin, k), { hooks: HOOKS }));
    this.picks = [];
    if (made) { this.app.setTool("select"); this.app.toast(`Scaled by ${Math.round(k * 1000) / 1000}`); }
  }
  drawPreview(view) {
    if (this.prefs.mode !== "graphical" || this.picks.length < 2 || !this.cursor) return;
    const k = G.dist(this.picks[0], this.cursor) / Math.max(1, G.dist(this.picks[0], this.picks[1]));
    ghostIds(view, this.app, this.ids, M.scaling(this.picks[0], k));
  }
}

// ------------------------------------------------------------------ Array
export class ArrayTool extends StepTool {
  constructor(app) {
    super(app, "array", "Array"); this.needsSelection = true;
    const p = this.prefs; p.kind = p.kind || "linear"; p.n = p.n || 3; p.to = p.to || "2nd"; p.angle = p.angle ?? 360;
    this.centre = selectionCentre(app, this.ids); this.placing = false;
  }
  options() {
    const p = this.prefs;
    const o = [{ type: "text", text: "Array", cls: "modename" },
      { type: "select", label: "", value: p.kind, items: [{ value: "linear", label: "Linear" }, { value: "radial", label: "Radial" }], onChange: v => { p.kind = v; this.picks = []; this.save(); this.app.toolChanged(); } },
      { type: "number", label: "Number", value: p.n, min: 2, max: 200, step: 1, onChange: v => { p.n = Math.max(2, Math.min(200, Math.round(v) || 2)); this.save(); this.app.redraw(); } },
      { type: "select", label: "Move To", value: p.to, items: [{ value: "2nd", label: "2nd" }, { value: "last", label: "Last" }], onChange: v => { p.to = v; this.save(); this.app.redraw(); } }];
    if (p.kind === "radial") o.push({ type: "number", label: "Angle", value: p.angle, step: 15, onChange: v => { p.angle = v; this.save(); } }, { type: "button", label: "Place centre", onClick: () => { this.placing = true; this.app.toolChanged(); } }, { type: "button", label: "Make array", onClick: () => this.applyRadial() });
    o.push({ type: "text", text: "Copies are separate elements (grouping comes later)." });
    return o;
  }
  prompt() {
    if (this.prefs.kind === "radial") return this.placing ? "Click the centre of the array." : `Set Number and Angle, then press Enter or Make array. The centre is the blue cross.`;
    return this.picks.length ? `Click the ${this.prefs.to === "last" ? "last" : "second"} item's position, or type a distance and press Enter.` : "Click a start point.";
  }
  hasFrom() { return this.prefs.kind === "linear" ? this.picks.length > 0 : true; }
  down(c) {
    if (this.prefs.kind === "radial") { if (this.placing) { this.centre = c.pt; this.placing = false; this.app.toolChanged(); } return; }
    if (!this.picks.length) { this.picks.push(c.pt); this.app.toolChanged(); return; }
    this.applyLinear(G.sub(c.pt, this.picks[0]));
  }
  applyLinear(vec) {
    const made = this.app.commit("Array", doc => M.arrayLinear(doc, this.ids, vec, this.prefs.n, this.prefs.to === "last", HOOKS));
    this.picks = []; if (made) this.app.setTool("select");
  }
  applyRadial() {
    const ang = (this.prefs.angle * Math.PI) / 180;
    const full = Math.abs(Math.abs(this.prefs.angle) - 360) < 1e-6 && this.prefs.to === "last";
    // a full turn spread to the "last" would put the last copy on the original, so divide by n instead
    const made = this.app.commit("Array", doc => full ? M.arrayRadial(doc, this.ids, this.centre, ang / this.prefs.n, this.prefs.n, false, HOOKS) : M.arrayRadial(doc, this.ids, this.centre, ang, this.prefs.n, this.prefs.to === "last", HOOKS));
    if (made) this.app.setTool("select");
  }
  typed(v) {
    if (this.prefs.kind === "radial") { this.prefs.angle = v; this.applyRadial(); return true; }
    if (!this.picks.length) return false;
    const from = this.picks[0], cur = this.cursor || G.add(from, { x: 1, y: 0 });
    this.applyLinear(G.mul(G.dist(cur, from) > 1e-6 ? G.norm(G.sub(cur, from)) : { x: 1, y: 0 }, v));
    return true;
  }
  drawPreview(view) {
    const p = this.prefs;
    if (p.kind === "radial") { const c = this.centre, s = view.px(8); view.segment(G.add(c, { x: -s, y: 0 }), G.add(c, { x: s, y: 0 }), COLORS.sel, 2); view.segment(G.add(c, { x: 0, y: -s }), G.add(c, { x: 0, y: s }), COLORS.sel, 2); return; }
    if (!this.picks.length || !this.cursor) return;
    const vec = G.sub(this.cursor, this.picks[0]), step = p.to === "last" ? G.mul(vec, 1 / (p.n - 1)) : vec;
    for (let i = 1; i < p.n; i++) ghostIds(view, this.app, this.ids, M.translation(G.mul(step, i)));
  }
}

// ------------------------------------------------------------------ Offset
export class OffsetTool extends StepTool {
  constructor(app) {
    super(app, "offset", "Offset");
    const p = this.prefs; p.mode = p.mode || "numerical"; p.dist = p.dist ?? 1200; if (p.copy === undefined) p.copy = true;
    this.wantsSnap = false; this.chainMode = false;
  }
  options() {
    const p = this.prefs;
    return [{ type: "text", text: "Offset", cls: "modename" },
      { type: "select", label: "", value: p.mode, items: [{ value: "graphical", label: "Graphical" }, { value: "numerical", label: "Numerical" }], onChange: v => { p.mode = v; this.picks = []; this.save(); this.app.toolChanged(); } },
      ...(p.mode === "numerical" ? [{ type: "number", label: "Offset", value: p.dist, step: 50, min: 1, onChange: v => { if (v > 0) { p.dist = v; this.save(); this.app.redraw(); } } }] : []),
      { type: "check", label: "Copy", value: !!p.copy, onChange: v => { p.copy = v; this.save(); } }];
  }
  prompt() {
    if (this.prefs.mode === "graphical") return this.picks.length ? "Click to set the distance (or type it and press Enter)." : "Click a wall or line to offset. Tab picks the whole chain.";
    return `Hover over a wall or line: the dashed preview shows the side. Click to offset ${this.prefs.dist} mm. Tab picks the whole chain.`;
  }
  hasFrom() { return this.prefs.mode === "graphical" && this.picks.length > 0; }
  constrainFrom() { return null; }
  move(c) { this.cursor = c.raw; this.app.updateHover(c); this.app.redraw(); }
  targets() {
    const app = this.app, h = this.prefs.mode === "graphical" && this.picks.length ? this.picks[0].hover : app.hoverId;
    if (!h) return null;
    if (h.startsWith("chain:")) return { chain: true, els: app.chainOf(h.slice(6)).map(app.lookup) };
    const el = app.lookup(h);
    return M.isCurve(el) ? { chain: false, els: [el] } : null;
  }
  result(doc, t, dist, side, copy) {
    if (t.chain) return M.offsetChain(doc, t.els, dist, side, copy);
    return [M.offsetElement(doc, t.els[0], dist, side, copy)];
  }
  distFor(t) {
    if (this.prefs.mode === "numerical") return this.prefs.dist;
    if (!this.cursor) return 0;
    const el = t.els[0];
    return el.shape === "line" ? G.projectOnSegment(this.cursor, el.a, el.b).dist : Math.abs(G.dist(this.cursor, el.c) - el.r);
  }
  down(c) {
    const t = this.targets();
    if (this.prefs.mode === "graphical" && !this.picks.length) {
      if (!t) { this.app.toast("Click a wall or line."); return; }
      this.picks.push({ hover: this.app.hoverId }); this.app.toolChanged(); return;
    }
    if (!t) { this.app.toast("Hover over a wall or line, then click."); return; }
    this.apply(t, this.distFor(t), c.raw);
  }
  apply(t, dist, side) {
    if (!(dist > 0.5)) { this.app.toast("Move further from the element to set a distance."); return; }
    const copy = !!this.prefs.copy;
    this.app.commit("Offset", doc => {
      const live = { ...t, els: t.els.map(e => doc.walls.find(w => w.id === e.id) || doc.lines.find(l => l.id === e.id)) };
      this.result(doc, live, dist, side, copy);
    });
    this.picks = []; this.app.toolChanged();
  }
  typed(v) {
    if (this.prefs.mode !== "graphical" || !this.picks.length) return false;
    const t = this.targets(); if (!t) return false;
    this.apply(t, v, this.cursor || t.els[0].a);
    return true;
  }
  drawPreview(view) {
    const t = this.targets();
    if (!t || !this.cursor) return;
    const dist = this.distFor(t);
    if (!(dist > 0.5)) return;
    try {
      const f = fake();
      for (const e of this.result(f, { ...t, els: t.els.map(M.copyOf) }, dist, this.cursor, true)) ghost(view, e);
      if (this.prefs.mode === "graphical" && t.els[0].shape === "line") { const pr = G.projectOnSegment(this.cursor, t.els[0].a, t.els[0].b); view.tempDim(pr.point, G.add(pr.point, G.mul(G.norm(G.sub(this.cursor, pr.point)), dist)), String(Math.round(dist)), { offsetPx: 0 }); }
    } catch { /* not offsettable here */ }
  }
}

// ------------------------------------------------------------------ Trim / Extend
export class TrimTool extends StepTool {
  constructor(app) { super(app, "trim", "Trim/Extend"); this.prefs.mode = this.prefs.mode || "corner"; this.wantsSnap = false; }
  options() {
    return [{ type: "seg", label: "", items: [["corner", "Trim/Extend to Corner", "trim"], ["single", "Trim/Extend Single Element", "split"], ["multiple", "Trim/Extend Multiple Elements", "array"]].map(([k, t, i]) => ({ key: k, title: t, icon: i, on: this.prefs.mode === k })), onPick: k => { this.prefs.mode = k; this.picks = []; this.save(); this.app.toolChanged(); } },
      { type: "text", text: { corner: "Trim/Extend to Corner", single: "Trim/Extend Single Element", multiple: "Trim/Extend Multiple Elements" }[this.prefs.mode], cls: "modename" }];
  }
  prompt() {
    const n = this.picks.length;
    if (this.prefs.mode === "corner") return n ? "Click the second wall or line, on the part to keep." : "Click the first wall or line, on the part to keep.";
    return n ? `Click the ${this.prefs.mode === "multiple" ? "walls or lines" : "wall or line"} to trim or extend, on the part to keep.` : "Click the boundary (the wall or line to trim or extend to).";
  }
  move(c) { this.cursor = c.raw; this.app.updateHover(c); this.app.redraw(); }
  down(c) {
    const p = picked(this.app, c);
    if (!p) { this.app.toast("Click on a wall or line."); return; }
    if (p.el.shape !== "line") { this.app.toast("Trim/Extend works on straight walls and lines."); return; }
    if (!this.picks.length) { this.picks.push(p); this.app.toolChanged(); return; }
    const first = this.picks[0];
    if (first.id === p.id) { this.app.toast("Pick a different element."); return; }
    const app = this.app;
    const ok = app.commit("Trim/Extend", doc => {
      const live = id => doc.walls.find(w => w.id === id) || doc.lines.find(l => l.id === id);
      if (this.prefs.mode === "corner") M.trimCorner(live(first.id), first.at, live(p.id), p.at);
      else { const b = live(first.id); M.trimTo(live(p.id), b.a, b.b, p.at); }
      return true;
    });
    if (this.prefs.mode === "multiple") { this.app.toolChanged(); return; } // keep the boundary for more
    this.picks = []; if (ok) this.app.toolChanged();
  }
  drawPreview(view) { for (const p of this.picks) { const el = this.app.lookup(p.id); if (el) ghost(view, el, COLORS.sel, []); } }
}

// ------------------------------------------------------------------ Split / Split with Gap
export class SplitTool extends StepTool {
  constructor(app) { super(app, "split", "Split Element"); const p = this.prefs; p.mode = p.mode || "split"; p.gap = p.gap ?? 20; this.wantsSnap = true; }
  options() {
    const p = this.prefs;
    return [{ type: "select", label: "", value: p.mode, items: [{ value: "split", label: "Split Element" }, { value: "gap", label: "Split with Gap" }], onChange: v => { p.mode = v; this.picks = []; this.save(); this.app.toolChanged(); } },
      ...(p.mode === "gap" ? [{ type: "number", label: "Joint Gap", value: p.gap, min: 1, max: 1000, step: 5, onChange: v => { if (v > 0) { p.gap = v; this.save(); } } }]
        : [{ type: "check", label: "Delete Inner Segment", value: !!p.inner, onChange: v => { p.inner = v; this.picks = []; this.save(); this.app.toolChanged(); } }])];
  }
  prompt() { return this.prefs.inner && this.prefs.mode === "split" ? (this.picks.length ? "Click the second point on the same element; the piece between is removed." : "Click the first point on a wall or line.") : "Click a point on a wall or line to split it there."; }
  constrainFrom() { return null; }
  down(c) {
    const p = picked(this.app, c);
    if (!p) { this.app.toast("Click on a wall or line."); return; }
    const at = c.snap ? c.pt : p.at;
    const app = this.app;
    if (this.prefs.mode === "split" && this.prefs.inner) {
      if (!this.picks.length) { this.picks.push({ id: p.id, at }); this.app.toolChanged(); return; }
      if (this.picks[0].id !== p.id) { this.app.toast("Click the same element again."); return; }
      const first = this.picks[0]; this.picks = [];
      app.commit("Split", doc => M.deleteBetween(doc, doc.walls.find(w => w.id === p.id) || doc.lines.find(l => l.id === p.id), first.at, at));
      return;
    }
    app.commit("Split", doc => M.split(doc, doc.walls.find(w => w.id === p.id) || doc.lines.find(l => l.id === p.id), at, this.prefs.mode === "gap" ? this.prefs.gap : 0));
  }
}

// ------------------------------------------------------------------ Align
export class AlignTool extends StepTool {
  constructor(app) { super(app, "align", "Align"); this.wantsSnap = false; this.lastLock = null; }
  options() { return [{ type: "text", text: "Align", cls: "modename" }, { type: "text", text: "After aligning, click the padlock to lock the alignment." }]; }
  prompt() { return this.picks.length ? "Click the line on the element to align with the reference (a wall face or centre, or a line)." : "Click the reference line (a wall face or centre, or a line)."; }
  move(c) { this.cursor = c.raw; this.app.updateHover(c); this.app.redraw(); }
  lineAt(c) {
    const p = picked(this.app, c);
    if (!p || p.el.shape !== "line") return null;
    const fp = M.isWallEl(p.el) ? this.app.footprints(p.el.baseLevelId).get(p.id) : null;
    const lines = M.alignLines(p.el, fp);
    let best = null;
    lines.forEach((l, i) => { const d = G.projectOnSegment(c.raw, l.a, l.b).dist; if (!best || d < best.d) best = { i, d, line: l }; });
    return best && { id: p.id, idx: best.i, line: best.line };
  }
  down(c) {
    const hit = this.lineAt(c);
    if (!hit) { this.app.toast("Click a straight wall or line."); return; }
    if (!this.picks.length) { this.picks.push(hit); this.lastLock = null; this.app.toolChanged(); return; }
    const ref = this.picks[0];
    if (ref.id === hit.id) { this.app.toast("Pick a different element to align."); return; }
    const app = this.app;
    const ok = app.commit("Align", doc => {
      const el = doc.walls.find(w => w.id === hit.id) || doc.lines.find(l => l.id === hit.id);
      if (el.pinned) throw new Error("A pinned element cannot move. Unpin it first (UP).");
      const d = M.alignMove(ref.line, hit.line);
      if (M.isWallEl(el)) app.translateWithJoins(doc, [el.id], d); else { el.a = G.add(el.a, d); el.b = G.add(el.b, d); }
      return true;
    });
    if (ok) this.lastLock = { ref: ref.id, refIdx: ref.idx, el: hit.id, elIdx: hit.idx, at: G.mid(ref.line.a, ref.line.b) };
    this.picks = []; this.app.toolChanged();
  }
  drawPreview(view) {
    if (this.picks.length) view.segment(this.picks[0].line.a, this.picks[0].line.b, COLORS.sel, 2, [8, 4]);
    if (!this.lastLock) return;
    const s = view.toScreen(this.lastLock.at), ctx = view.ctx, locked = (this.app.doc.constraints || []).some(k => k.ref === this.lastLock.ref && k.el === this.lastLock.el);
    ctx.strokeStyle = COLORS.sel; ctx.lineWidth = 1.6; ctx.beginPath();
    ctx.rect(s.x - 6, s.y - 2, 12, 9); ctx.moveTo(s.x - 4, s.y - 2); ctx.arc(s.x, s.y - 4, 4, Math.PI, locked ? 0 : -0.6 * Math.PI, false); ctx.stroke();
    view.hits.push({ x0: s.x - 10, y0: s.y - 12, x1: s.x + 10, y1: s.y + 10, cx: s.x, cy: s.y, onClick: () => this.toggleLock() });
  }
  toggleLock() {
    const L = this.lastLock; if (!L) return;
    this.app.commit("Lock alignment", doc => {
      doc.constraints = doc.constraints || [];
      const i = doc.constraints.findIndex(k => k.ref === L.ref && k.el === L.el);
      if (i >= 0) doc.constraints.splice(i, 1); else doc.constraints.push({ id: `lk-${Date.now().toString(36)}`, ref: L.ref, refIdx: L.refIdx, el: L.el, elIdx: L.elIdx });
    });
    this.app.redraw();
  }
}

// ------------------------------------------------------------------ Chamfer / Fillet
export class CornerTool extends StepTool {
  constructor(app, kind) {
    super(app, kind, kind === "chamfer" ? "Chamfer" : "Fillet"); this.kind = kind; this.wantsSnap = false;
    const p = this.prefs; p.d1 = p.d1 ?? 300; p.d2 = p.d2 ?? 300; p.angle = p.angle ?? 45; p.method = p.method || "distances"; p.r = p.r ?? 500;
  }
  options() {
    const p = this.prefs;
    if (this.kind === "fillet") return [{ type: "text", text: "Fillet", cls: "modename" }, { type: "number", label: "Radius", value: p.r, min: 0, step: 50, onChange: v => { if (v >= 0) { p.r = v; this.save(); } } }];
    return [{ type: "text", text: "Chamfer", cls: "modename" },
      { type: "select", label: "", value: p.method, items: [{ value: "distances", label: "Two distances" }, { value: "angle", label: "Distance and angle" }], onChange: v => { p.method = v; this.save(); this.app.toolChanged(); } },
      { type: "number", label: "Distance 1", value: p.d1, min: 1, step: 50, onChange: v => { if (v > 0) { p.d1 = v; this.save(); } } },
      ...(p.method === "angle" ? [{ type: "number", label: "Angle", value: p.angle, min: 1, max: 89, step: 5, onChange: v => { if (v > 0 && v < 90) { p.angle = v; this.save(); } } }] : [{ type: "number", label: "Distance 2", value: p.d2, min: 1, step: 50, onChange: v => { if (v > 0) { p.d2 = v; this.save(); } } }])];
  }
  prompt() { return this.picks.length ? "Click the second wall or line." : "Click the first wall or line (on the part to keep)."; }
  move(c) { this.cursor = c.raw; this.app.updateHover(c); this.app.redraw(); }
  down(c) {
    const p = picked(this.app, c);
    if (!p || p.el.shape !== "line") { this.app.toast("Click a straight wall or line."); return; }
    if (!this.picks.length) { this.picks.push(p); this.app.toolChanged(); return; }
    const first = this.picks[0]; this.picks = [];
    if (first.id === p.id) { this.app.toast("Pick a different element."); this.app.toolChanged(); return; }
    const pr = this.prefs;
    this.app.commit(this.title, doc => {
      const live = id => doc.walls.find(w => w.id === id) || doc.lines.find(l => l.id === id);
      const e1 = live(first.id), e2 = live(p.id);
      if (this.kind === "fillet") return M.fillet(doc, e1, first.at, e2, p.at, pr.r) || true;
      let d2 = pr.d2;
      if (pr.method === "angle") {
        // distance along the first, angle between the first and the cut: solve the triangle for the second distance
        const hit = G.lineIntersect(e1.a, e1.b, e2.a, e2.b); if (!hit) throw new Error("These are parallel, so they have no corner.");
        const u1 = G.norm(G.sub(e1.b, e1.a)), u2 = G.norm(G.sub(e2.b, e2.a));
        const corner = Math.acos(Math.min(1, Math.abs(G.dot(u1, u2))));
        const a = (pr.angle * Math.PI) / 180, third = Math.PI - corner - a;
        if (third <= 0) throw new Error("That angle does not fit this corner.");
        d2 = (pr.d1 * Math.sin(a)) / Math.sin(third);
      }
      return M.chamfer(doc, e1, first.at, e2, p.at, pr.d1, d2);
    });
    this.app.toolChanged();
  }
  drawPreview(view) { for (const p of this.picks) { const el = this.app.lookup(p.id); if (el) ghost(view, el, COLORS.sel, []); } }
}
