// Drawing and editing tools. Each tool reacts to picks that the workspace has already snapped
// and constrained, and changes the model only through app.commit (one undo step per action).
import * as G from "./geom.js";
import { makeLine, makeArc, grips, moveGrip, translate, LINE_STYLES, lineCurve } from "./elements.js";
import { COLORS } from "./plan.js";

export const DRAW_MODES = {
  line: { label: "Line", icon: "line" },
  rect: { label: "Rectangle", icon: "rect" },
  polygon: { label: "Polygon", icon: "polygon" },
  circle: { label: "Circle", icon: "circle" },
  arcSER: { label: "Start-End-Radius Arc", icon: "arc3" },
  arcCE: { label: "Centre-Ends Arc", icon: "arcc" },
  pick: { label: "Pick Lines", icon: "pick" },
};

const mmText = v => String(Math.round(v));

// ------------------------------------------------------------------ Select / Modify
/** Copies of the editable collections, so a live drag preview can be undone exactly. */
function snapshot(doc) { return { walls: JSON.stringify(doc.walls), lines: JSON.stringify(doc.lines), openings: JSON.stringify(doc.openings) }; }
function restore(doc, snap) { doc.walls = JSON.parse(snap.walls); doc.lines = JSON.parse(snap.lines); doc.openings = JSON.parse(snap.openings); }
/** Dragging a straight wall's end also drags the ends of walls joined there. */
function gripEdit(app, doc, id, key, p) {
  const w = doc.walls.find(x => x.id === id);
  if (w && w.shape === "line" && (key === "a" || key === "b")) { app.stretchWallEnd(doc, id, key, p); return; }
  const el = doc.lines.find(x => x.id === id) || w;
  if (el) moveGrip(el, key, p);
}
export class SelectTool {
  constructor(app) { this.app = app; this.name = "select"; this.title = "Modify"; this.drag = null; }
  prompt() {
    const n = this.app.selection.size;
    if (this.drag?.kind === "rubber") return this.drag.b && this.drag.b.x < this.drag.a.x ? "Crossing: anything the box touches is selected." : "Window: only what is fully inside is selected.";
    return n ? `${n} selected. Drag to move, drag a blue dot to reshape, Delete to remove, Tab to cycle. Ctrl adds, Shift removes.` : "Click to select. Drag left-to-right for a window, right-to-left for a crossing. Tab cycles overlapping elements.";
  }
  options() { return [{ type: "text", text: this.app.selection.size ? `${this.app.selection.size} selected` : "Modify" }]; }

  down(c) {
    const app = this.app;
    // grip of a selected element?
    for (const id of app.selection) {
      const el = app.lookup(id);
      if (!el || el.pinned) continue;
      for (const g of grips(el)) {
        const s = app.plan.toScreen(g.point);
        if (Math.hypot(s.x - c.sx, s.y - c.sy) <= 8) {
          this.drag = { kind: "grip", id, key: g.key, snap: snapshot(app.doc), other: el.shape === "line" ? (g.key === "a" ? { ...el.b } : { ...el.a }) : null };
          app.dragGrip = { id, key: g.key };
          app.excludeFromSnap = new Set([id]);
          return;
        }
      }
    }
    const hit = app.hoverCandidate();
    if (hit) {
      const ev = c.ev;
      const ids = hit.startsWith("chain:") ? app.chainOf(hit.slice(6)) : [hit];
      if (ev.shiftKey) ids.forEach(id => app.selection.delete(id));
      else if (ev.ctrlKey || ev.metaKey) ids.forEach(id => app.selection.add(id));
      else if (!ids.every(id => app.selection.has(id))) { app.selection.clear(); ids.forEach(id => app.selection.add(id)); }
      app.selectionChanged();
      this.drag = { kind: "maybeMove", start: c.raw, sx: c.sx, sy: c.sy, base: c.pt };
      return;
    }
    if (!(c.ev.ctrlKey || c.ev.metaKey || c.ev.shiftKey)) { app.selection.clear(); app.selectionChanged(); }
    this.drag = { kind: "rubber", a: c.raw, b: c.raw, sx: c.sx, sy: c.sy, add: c.ev.ctrlKey || c.ev.metaKey, remove: c.ev.shiftKey };
  }

  move(c) {
    const app = this.app, d = this.drag;
    if (!d) { app.updateHover(c); return; }
    if (d.kind === "rubber") { d.b = c.raw; app.rubber = { a: d.a, b: d.b }; app.redraw(); return; }
    if (d.kind === "maybeMove" && Math.hypot(c.sx - d.sx, c.sy - d.sy) > 5) {
      const ids = [...app.selection].filter(id => !app.lookup(id)?.pinned);
      if (!ids.length) { app.toast("Pinned elements cannot move. Unpin them first."); this.drag = null; return; }
      d.kind = "move"; d.ids = ids; d.snap = snapshot(app.doc);
      app.excludeFromSnap = new Set(ids);
    }
    if (d.kind === "move") {
      const delta = G.sub(c.pt, d.base);
      restore(app.doc, d.snap);
      app.translateWithJoins(app.doc, d.ids, delta);
      d.delta = delta;
      app.redraw(true);
    }
    if (d.kind === "grip") {
      restore(app.doc, d.snap);
      gripEdit(app, app.doc, d.id, d.key, c.pt);
      d.to = c.pt;
      app.redraw(true);
    }
  }

  up() {
    const app = this.app, d = this.drag;
    this.drag = null; app.rubber = null; app.dragGrip = null; app.excludeFromSnap = null;
    if (!d) return;
    if (d.kind === "rubber") {
      const r = { x0: Math.min(d.a.x, d.b.x), y0: Math.min(d.a.y, d.b.y), x1: Math.max(d.a.x, d.b.x), y1: Math.max(d.a.y, d.b.y) };
      if (r.x1 - r.x0 > app.plan.px(3) || r.y1 - r.y0 > app.plan.px(3)) {
        const ids = app.elementsInRect(r, d.b.x < d.a.x);
        if (!d.add && !d.remove) app.selection.clear();
        for (const id of ids) d.remove ? app.selection.delete(id) : app.selection.add(id);
      }
      app.selectionChanged();
      return;
    }
    if (d.kind === "move" && d.delta) {
      restore(app.doc, d.snap);
      const delta = d.delta;
      if (G.len(delta) > 1e-6) app.commit("Move", doc => { app.translateWithJoins(doc, d.ids, delta); app.validate?.(doc, d.ids); });
      else app.redraw(true);
    }
    if (d.kind === "grip" && d.to) {
      restore(app.doc, d.snap);
      const { key, to } = d;
      app.commit("Drag end", doc => { gripEdit(app, doc, d.id, key, to); app.validate?.(doc, [d.id]); });
    }
    app.redraw(true);
  }

  /** Grip drags hold the other end straight with Shift. */
  constrainFrom() { return this.drag?.kind === "grip" ? this.drag.other : this.drag?.kind === "move" ? this.drag.base : null; }
  escape() { if (this.drag) { this.cancelDrag(); return true; } if (this.app.selection.size) { this.app.selection.clear(); this.app.selectionChanged(); return true; } return false; }
  cancelDrag() {
    const app = this.app, d = this.drag;
    if (d?.snap) restore(app.doc, d.snap);
    this.drag = null; app.rubber = null; app.dragGrip = null; app.excludeFromSnap = null; app.redraw(true);
  }
  get wantsSnap() { return this.drag?.kind === "move" || this.drag?.kind === "grip"; }
}

// ------------------------------------------------------------------ Model / detail lines
export class LineTool {
  constructor(app, kind) {
    this.app = app;
    this.kind = kind; // "model" | "detail"
    this.name = kind === "detail" ? "detailLine" : "modelLine";
    this.title = kind === "detail" ? "Detail Line" : "Model Line";
    const s = app.prefs.line || {};
    this.mode = s.mode || "line";
    this.style = s.style || (kind === "detail" ? "medium" : "thin");
    this.chain = s.chain ?? true;
    this.offset = s.offset || 0;
    this.sides = s.sides || 6;
    this.polyMode = s.polyMode || "inscribed";
    this.pts = [];
    this.cursor = null;
    this.sweepAcc = 0;
    this.wantsSnap = true;
  }

  savePrefs() { this.app.prefs.line = { mode: this.mode, style: this.style, chain: this.chain, offset: this.offset, sides: this.sides, polyMode: this.polyMode }; this.app.savePrefs(); }

  options() {
    const o = [
      { type: "seg", label: "Draw", items: Object.entries(DRAW_MODES).map(([k, v]) => ({ key: k, title: v.label, icon: v.icon, on: this.mode === k })), onPick: k => { this.mode = k; this.pts = []; this.savePrefs(); this.app.toolChanged(); } },
      { type: "text", text: DRAW_MODES[this.mode].label, cls: "modename" },
      { type: "select", label: "Line style", value: this.style, items: Object.entries(LINE_STYLES).map(([k, v]) => ({ value: k, label: v.label })), onChange: v => { this.style = v; this.savePrefs(); } },
    ];
    if (this.mode === "line") o.push({ type: "check", label: "Chain", value: this.chain, onChange: v => { this.chain = v; this.savePrefs(); } });
    if (this.mode === "line" || this.mode === "pick") o.push({ type: "number", label: "Offset", value: this.offset, step: 50, onChange: v => { this.offset = v || 0; this.savePrefs(); this.app.redraw(); } });
    if (this.mode === "polygon") {
      o.push({ type: "number", label: "Sides", value: this.sides, min: 3, max: 64, step: 1, onChange: v => { this.sides = Math.max(3, Math.min(64, Math.round(v) || 6)); this.savePrefs(); } });
      o.push({ type: "select", label: "", value: this.polyMode, items: [{ value: "inscribed", label: "Inscribed" }, { value: "circumscribed", label: "Circumscribed" }], onChange: v => { this.polyMode = v; this.savePrefs(); } });
    }
    o.push({ type: "text", text: `Placement plane: ${this.app.levelName()}` });
    return o;
  }

  prompt() {
    const n = this.pts.length;
    switch (this.mode) {
      case "line": return n ? "Click the end point, or type a length and press Enter. Esc ends the chain." : "Click to enter the line start point.";
      case "rect": return n ? "Click the opposite corner." : "Click the first corner of the rectangle.";
      case "polygon": return n ? "Click to set the radius, or type it and press Enter." : "Click the centre of the polygon.";
      case "circle": return n ? "Click to set the radius, or type it and press Enter." : "Click the centre of the circle.";
      case "arcSER": return n === 0 ? "Click the start of the arc." : n === 1 ? "Click the end of the arc." : "Move to set the radius, then click (or type the radius).";
      case "arcCE": return n === 0 ? "Click the centre of the arc." : n === 1 ? "Click the start of the arc (sets the radius)." : "Click the end of the arc.";
      case "pick": return "Click a line to copy it as a " + (this.kind === "detail" ? "detail line." : "model line.");
      default: return "";
    }
  }

  hasFrom() { return this.pts.length > 0; }
  constrainFrom() {
    if (!this.pts.length) return null;
    if (this.mode === "arcCE" && this.pts.length >= 1) return this.pts[0];
    if (this.mode === "polygon" || this.mode === "circle") return this.pts[0];
    return this.pts[this.pts.length - 1];
  }
  get wantsSnapNow() { return this.mode !== "pick"; }

  offsetSeg(a, b) {
    if (!this.offset) return [a, b];
    const n = G.mul(G.perp(G.norm(G.sub(b, a))), this.offset);
    return [G.add(a, n), G.add(b, n)];
  }

  add(elements, label) {
    const lv = this.app.levelId;
    this.app.commit(label, doc => { for (const e of elements) doc.lines.push(e.shape === "arc" ? makeArc(this.kind, lv, this.style, e) : makeLine(this.kind, lv, this.style, e.a, e.b)); });
  }

  down(c) {
    const p = c.pt;
    if (this.mode === "pick") {
      const id = this.app.hoverCandidate();
      const src = id && this.app.lookup(id);
      if (!src || !src.shape) { this.app.toast("Click on a line."); return; }
      if (src.shape === "arc") {
        if (this.offset) { const r = src.r + this.offset * Math.sign(src.sweep || 1); if (r <= 0) { this.app.toast("The offset is larger than the arc's radius."); return; } this.add([{ shape: "arc", c: src.c, r, start: src.start, sweep: src.sweep }], "Pick Lines"); }
        else this.add([{ shape: "arc", c: src.c, r: src.r, start: src.start, sweep: src.sweep }], "Pick Lines");
      } else { const [a, b] = this.offsetSeg(src.a, src.b); this.add([{ shape: "line", a, b }], "Pick Lines"); }
      return;
    }
    this.pts.push(p);
    this.sweepAcc = 0;
    if (this.mode === "arcCE" && this.pts.length === 2) this.lastAng = G.angleOf(G.sub(p, this.pts[0]));
    this.finishIfReady();
  }

  finishIfReady(typed) {
    const P = this.pts, n = P.length;
    if (this.mode === "line" && n === 2) {
      if (G.dist(P[0], P[1]) < 1) { P.pop(); return; }
      const [a, b] = this.offsetSeg(P[0], P[1]);
      this.add([{ shape: "line", a, b }], this.title);
      this.pts = this.chain ? [P[1]] : [];
    } else if (this.mode === "rect" && n === 2) {
      if (Math.abs(P[0].x - P[1].x) < 1 || Math.abs(P[0].y - P[1].y) < 1) { P.pop(); return; }
      const c = G.rectangle(P[0], P[1]);
      this.add(c.map((q, i) => ({ shape: "line", a: q, b: c[(i + 1) % 4] })), "Rectangle");
      this.pts = [];
    } else if (this.mode === "polygon" && n === 2) {
      if (G.dist(P[0], P[1]) < 1) { P.pop(); return; }
      const c = G.regularPolygon(P[0], P[1], this.sides, this.polyMode);
      this.add(c.map((q, i) => ({ shape: "line", a: q, b: c[(i + 1) % c.length] })), "Polygon");
      this.pts = [];
    } else if (this.mode === "circle" && n === 2) {
      const r = G.dist(P[0], P[1]);
      if (r < 1) { P.pop(); return; }
      this.add([{ shape: "arc", c: P[0], r, start: 0, sweep: G.TAU }], "Circle");
      this.pts = [];
    } else if (this.mode === "arcSER" && n === 3) {
      const arc = typed || G.arcFrom3(P[0], P[2], P[1]);
      if (!arc) { P.pop(); this.app.toast("The three points are in a straight line. Move off the line."); return; }
      this.add([{ shape: "arc", ...arc }], "Arc");
      this.pts = [];
    } else if (this.mode === "arcCE" && n === 3) {
      const c = P[0], r = G.dist(c, P[1]), start = G.angleOf(G.sub(P[1], c));
      const sweep = this.sweepAcc || G.wrap(G.angleOf(G.sub(P[2], c)) - start);
      if (Math.abs(sweep) < 1e-4 || r < 1) { P.pop(); return; }
      this.add([{ shape: "arc", c, r, start, sweep }], "Arc");
      this.pts = [];
    }
    this.app.toolChanged();
  }

  move(c) {
    if (this.mode === "pick") { this.app.updateHover(c); this.cursor = c.pt; return; }
    this.cursor = c.pt;
    if (this.mode === "arcCE" && this.pts.length === 2) {
      // follow the pointer round the centre so the arc can sweep either way, even past half a turn
      const a1 = G.angleOf(G.sub(this.cursor, this.pts[0]));
      let d = a1 - this.lastAng;
      if (d > Math.PI) d -= G.TAU; if (d < -Math.PI) d += G.TAU;
      this.sweepAcc = Math.max(-G.TAU, Math.min(G.TAU, this.sweepAcc + d));
      this.lastAng = a1;
    }
    this.app.redraw();
  }

  /** Typed number: a length for lines, a radius for circles, polygons and arcs. */
  typed(v) {
    if (!(v > 0)) return false;
    const P = this.pts, cur = this.cursor;
    if (!P.length) return false;
    if (this.mode === "line") {
      const from = P[P.length - 1];
      const dir = cur && G.dist(cur, from) > 1e-6 ? G.norm(G.sub(cur, from)) : { x: 1, y: 0 };
      P.push(G.add(from, G.mul(dir, v)));
      this.finishIfReady();
      return true;
    }
    if ((this.mode === "circle" || this.mode === "polygon") && P.length === 1) {
      const dir = cur && G.dist(cur, P[0]) > 1e-6 ? G.norm(G.sub(cur, P[0])) : { x: 1, y: 0 };
      P.push(G.add(P[0], G.mul(dir, v)));
      this.finishIfReady();
      return true;
    }
    if (this.mode === "arcSER" && P.length === 2) {
      const side = cur ? Math.sign(G.cross(G.sub(P[1], P[0]), G.sub(cur, P[0]))) || 1 : 1;
      const arc = G.arcFromEndsRadius(P[0], P[1], v, side);
      if (!arc) { this.app.toast(`The radius must be at least ${mmText(G.dist(P[0], P[1]) / 2)} mm for these ends.`); return true; }
      P.push(G.arcMid(arc));
      this.finishIfReady(arc);
      return true;
    }
    if (this.mode === "arcCE" && P.length === 1) {
      const dir = cur && G.dist(cur, P[0]) > 1e-6 ? G.norm(G.sub(cur, P[0])) : { x: 1, y: 0 };
      P.push(G.add(P[0], G.mul(dir, v)));
      this.sweepAcc = 0; this.lastAng = G.angleOf(dir);
      this.app.toolChanged();
      return true;
    }
    this.app.toast("Click a point here; typed values work for line lengths and radii.");
    return true;
  }

  escape() {
    if (this.pts.length) { this.pts = []; this.app.toolChanged(); return true; }
    return false;
  }

  drawPreview(view) {
    const P = this.pts, cur = this.cursor;
    if (!cur || !P.length) return;
    const col = COLORS.preview, st = LINE_STYLES[this.style];
    const seg = (a, b) => view.segment(a, b, col, Math.max(1.2, st.px), st.dash);
    const arc = a => { view.drawLine({ shape: "arc", ...a, style: this.style }, col); };
    if (this.mode === "line") {
      const from = P[P.length - 1];
      const [a, b] = this.offsetSeg(from, cur);
      if (this.offset) view.segment(from, cur, COLORS.dim, 1, [4, 4]);
      seg(a, b);
      if (G.dist(from, cur) > 1) {
        view.tempDim(a, b, mmText(G.dist(from, cur)));
        const ang = G.angleOf(G.sub(cur, from));
        view.label(G.add(from, G.mul(G.norm(G.sub(cur, from)), view.px(36))), `${Math.round(((ang * 180) / Math.PI + 360) % 360 * 100) / 100}°`, { color: COLORS.dim, size: 11, offsetPx: -14 });
      }
    } else if (this.mode === "rect") {
      const c = G.rectangle(P[0], cur);
      c.forEach((q, i) => seg(q, c[(i + 1) % 4]));
      view.tempDim(c[0], c[1], mmText(Math.abs(cur.x - P[0].x)), { offsetPx: cur.y < P[0].y ? 14 : -14 });
      view.tempDim(c[1], c[2], mmText(Math.abs(cur.y - P[0].y)), { offsetPx: cur.x > P[0].x ? 14 : -14 });
    } else if (this.mode === "polygon") {
      const c = G.regularPolygon(P[0], cur, this.sides, this.polyMode);
      c.forEach((q, i) => seg(q, c[(i + 1) % c.length]));
      view.segment(P[0], cur, COLORS.dim, 1, [4, 4]);
      view.tempDim(P[0], cur, mmText(G.dist(P[0], cur)));
    } else if (this.mode === "circle") {
      arc({ c: P[0], r: G.dist(P[0], cur), start: 0, sweep: G.TAU });
      view.segment(P[0], cur, COLORS.dim, 1, [4, 4]);
      view.tempDim(P[0], cur, "R " + mmText(G.dist(P[0], cur)));
    } else if (this.mode === "arcSER") {
      if (P.length === 1) seg(P[0], cur);
      else { const a = G.arcFrom3(P[0], cur, P[1]); if (a) { arc(a); view.label(G.arcMid(a), "R " + mmText(a.r), { offsetPx: 14 }); } else seg(P[0], P[1]); }
    } else if (this.mode === "arcCE") {
      const c = P[0];
      if (P.length === 1) { view.segment(c, cur, COLORS.dim, 1, [4, 4]); arc({ c, r: G.dist(c, cur), start: 0, sweep: G.TAU }); view.tempDim(c, cur, "R " + mmText(G.dist(c, cur))); }
      else {
        const r = G.dist(c, P[1]), start = G.angleOf(G.sub(P[1], c));
        const sweep = this.sweepAcc || G.wrap(G.angleOf(G.sub(cur, c)) - start);
        arc({ c, r, start, sweep: Math.max(-G.TAU, Math.min(G.TAU, sweep)) });
        view.segment(c, P[1], COLORS.dim, 1, [4, 4]); view.segment(c, G.arcPoint({ c, r }, start + sweep), COLORS.dim, 1, [4, 4]);
      }
    }
  }
}

export { lineCurve };
