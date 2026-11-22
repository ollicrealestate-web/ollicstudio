// Floor plan view on a canvas. Model units are millimetres with y pointing north (up on screen).
import * as G from "./geom.js";
import { LINE_STYLES, linesInPlan, grips, bbox, unionBox } from "./elements.js";

export const COLORS = {
  bg: "#0c0c0e", gridMinor: "#1a1a20", gridMajor: "#2a2a32", axis: "#3a3a46",
  line: "#e8e8ec", detail: "#c9c9d2", underlay: "#4a4a54",
  sel: "#3b82f6", hover: "#7fb0ff", snap: "#fbbf24", preview: "#ff4a4f", dim: "#5ea0ff",
};

export class PlanView {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.app = app;
    this.cx = 5000; this.cy = 4000; this.s = 0.06; // px per mm
    this.dpr = 1;
    this.dirty = true;
    this.hits = []; // clickable labels: [{x0,y0,x1,y1, onClick}] in CSS px
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    const loop = () => { if (this.dirty) { this.dirty = false; this.draw(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  invalidate() { this.dirty = true; }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
    this.invalidate();
  }

  toScreen(p) { return { x: (p.x - this.cx) * this.s + this.w / 2, y: this.h / 2 - (p.y - this.cy) * this.s }; }
  toModel(sx, sy) { return { x: (sx - this.w / 2) / this.s + this.cx, y: (this.h / 2 - sy) / this.s + this.cy }; }
  /** mm covered by n screen pixels */
  px(n) { return n / this.s; }

  zoomAt(sx, sy, factor) {
    const before = this.toModel(sx, sy);
    this.s = Math.min(5, Math.max(0.0015, this.s * factor));
    const after = this.toModel(sx, sy);
    this.cx += before.x - after.x; this.cy += before.y - after.y;
    this.invalidate();
  }

  panBy(dxPx, dyPx) { this.cx -= dxPx / this.s; this.cy += dyPx / this.s; this.invalidate(); }

  fit(box) {
    if (!box) box = { x0: -1000, y0: -1000, x1: 12000, y1: 10000 };
    const w = Math.max(2000, box.x1 - box.x0), h = Math.max(2000, box.y1 - box.y0);
    this.s = Math.min(this.w / (w * 1.15), this.h / (h * 1.15));
    this.cx = (box.x0 + box.x1) / 2; this.cy = (box.y0 + box.y1) / 2;
    this.invalidate();
  }

  contentBox() {
    const doc = this.app.doc;
    return unionBox(linesInPlan(doc, this.app.levelId).map(bbox).concat((this.app.extraBoxes?.() || [])));
  }

  // ---- drawing ----
  draw() {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, this.w, this.h);
    this.hits = [];
    this.drawGrid();
    const app = this.app;
    app.drawUnderlay?.(this);
    for (const l of linesInPlan(app.doc, app.levelId)) this.drawLine(l, this.colorFor(l.id, l.kind === "detail" ? COLORS.detail : COLORS.line));
    app.drawModel?.(this);
    // selection grips
    for (const id of app.selection) {
      const el = app.lookup(id);
      if (!el || el.pinned) continue;
      for (const g of grips(el)) this.grip(g.point, app.dragGrip && app.dragGrip.key === g.key && app.dragGrip.id === id);
    }
    app.drawSelectionDims?.(this);
    app.tool?.drawPreview?.(this);
    if (app.rubber) this.drawRubber(app.rubber);
    if (app.snap) this.drawSnap(app.snap);
  }

  colorFor(id, base) {
    if (this.app.selection.has(id)) return COLORS.sel;
    if (this.app.hoverId === id || this.app.hoverSet?.has(id)) return COLORS.hover;
    return base;
  }

  drawGrid() {
    const { ctx } = this;
    const steps = [10, 50, 100, 500, 1000, 5000, 10000, 50000];
    const minor = steps.find(st => st * this.s >= 12) || 50000;
    const major = minor * (String(minor).startsWith("5") ? 2 : 5);
    const tl = this.toModel(0, 0), br = this.toModel(this.w, this.h);
    const lines = (step, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) { const sx = Math.round(this.toScreen({ x, y: 0 }).x) + 0.5; ctx.moveTo(sx, 0); ctx.lineTo(sx, this.h); }
      for (let y = Math.floor(br.y / step) * step; y <= tl.y; y += step) { const sy = Math.round(this.toScreen({ x: 0, y }).y) + 0.5; ctx.moveTo(0, sy); ctx.lineTo(this.w, sy); }
      ctx.stroke();
    };
    lines(minor, COLORS.gridMinor);
    lines(major, COLORS.gridMajor);
    const o = this.toScreen({ x: 0, y: 0 });
    ctx.strokeStyle = COLORS.axis; ctx.beginPath(); ctx.moveTo(o.x + 0.5, 0); ctx.lineTo(o.x + 0.5, this.h); ctx.moveTo(0, o.y + 0.5); ctx.lineTo(this.w, o.y + 0.5); ctx.stroke();
  }

  stroke(color, px, dash) {
    const { ctx } = this;
    ctx.strokeStyle = color; ctx.lineWidth = px; ctx.setLineDash(dash || []); ctx.lineCap = "round"; ctx.lineJoin = "round";
  }

  /** Draws a model/detail line element (or any {shape} object). */
  drawLine(l, color, styleOverride) {
    const st = LINE_STYLES[styleOverride || l.style] || LINE_STYLES.thin;
    this.stroke(color, st.px, st.dash);
    this.pathShape(l);
    this.ctx.stroke();
    this.ctx.setLineDash([]);
  }

  pathShape(l) {
    const { ctx } = this;
    ctx.beginPath();
    if (l.shape === "arc") {
      const c = this.toScreen(l.c);
      // screen y is flipped, so angles are negated and direction reverses
      ctx.arc(c.x, c.y, l.r * this.s, -l.start, -(l.start + l.sweep), l.sweep > 0);
    } else {
      const a = this.toScreen(l.a), b = this.toScreen(l.b);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
  }

  segment(a, b, color, px = 1, dash) { this.stroke(color, px, dash); const A = this.toScreen(a), B = this.toScreen(b); this.ctx.beginPath(); this.ctx.moveTo(A.x, A.y); this.ctx.lineTo(B.x, B.y); this.ctx.stroke(); this.ctx.setLineDash([]); }

  polygon(pts, fill, stroke, px = 1) {
    const { ctx } = this;
    ctx.beginPath();
    pts.forEach((p, i) => { const s = this.toScreen(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { this.stroke(stroke, px); ctx.stroke(); }
  }

  grip(p, active) {
    const s = this.toScreen(p), { ctx } = this;
    ctx.fillStyle = active ? COLORS.sel : "#0c0c0e"; ctx.strokeStyle = COLORS.sel; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(s.x, s.y, 4.5, 0, G.TAU); ctx.fill(); ctx.stroke();
  }

  /** Text at a model point, rotated along `ang` (radians, model), kept readable. Returns the screen box. */
  label(p, text, { color = COLORS.dim, ang = 0, size = 12, bg = null, offsetPx = 0 } = {}) {
    const { ctx } = this;
    const s = this.toScreen(p);
    let a = -ang; // screen angle
    if (a > Math.PI / 2 + 1e-6) a -= Math.PI; else if (a < -Math.PI / 2 - 1e-6) a += Math.PI;
    ctx.save();
    ctx.translate(s.x, s.y); ctx.rotate(a); ctx.translate(0, -offsetPx);
    ctx.font = `${size}px Archivo, system-ui, sans-serif`;
    const w = ctx.measureText(text).width;
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(-w / 2 - 4, -size / 2 - 3, w + 8, size + 6); }
    ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, 0, 0);
    ctx.restore();
    // approximate clickable box (axis-aligned around the rotated text)
    const cx = s.x + Math.sin(a) * offsetPx, cy = s.y - Math.cos(a) * offsetPx;
    const half = Math.max(w / 2 + 6, size);
    return { x0: cx - half, y0: cy - half * 0.6, x1: cx + half, y1: cy + half * 0.6, cx, cy };
  }

  /** A temporary dimension between two model points (blue), optionally clickable to type a value. */
  tempDim(a, b, text, { offsetPx = 14, onClick = null, color = COLORS.dim } = {}) {
    const u = G.norm(G.sub(b, a)), n = G.perp(u), off = this.px(offsetPx);
    const a2 = G.add(a, G.mul(n, off)), b2 = G.add(b, G.mul(n, off));
    this.segment(a2, b2, color, 1);
    for (const [p, q] of [[a, a2], [b, b2]]) this.segment(p, G.add(q, G.mul(n, this.px(3))), color, 1);
    const tick = this.px(4);
    for (const q of [a2, b2]) this.segment(G.add(q, G.mul(G.add(u, n), -tick)), G.add(q, G.mul(G.add(u, n), tick)), color, 1.5);
    const box = this.label(G.mid(a2, b2), text, { color, ang: G.angleOf(u), offsetPx: 9, bg: onClick ? "rgba(12,12,14,.85)" : null });
    if (onClick) this.hits.push({ ...box, onClick });
    return box;
  }

  drawRubber(r) {
    const { ctx } = this;
    const a = this.toScreen(r.a), b = this.toScreen(r.b);
    const crossing = r.b.x < r.a.x;
    ctx.fillStyle = crossing ? "rgba(74,222,128,.08)" : "rgba(59,130,246,.10)";
    ctx.strokeStyle = crossing ? "#4ade80" : COLORS.sel; ctx.lineWidth = 1; ctx.setLineDash(crossing ? [6, 4] : []);
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.setLineDash([]);
  }

  drawSnap(snap) {
    const { ctx } = this;
    const s = this.toScreen(snap.point), r = 6;
    ctx.strokeStyle = COLORS.snap; ctx.lineWidth = 1.6; ctx.setLineDash([]);
    ctx.beginPath();
    switch (snap.kind) {
      case "endpoint": ctx.rect(s.x - r, s.y - r, 2 * r, 2 * r); break;
      case "midpoint": ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x + r, s.y + r * 0.8); ctx.lineTo(s.x - r, s.y + r * 0.8); ctx.closePath(); break;
      case "intersection": ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x + r, s.y + r); ctx.moveTo(s.x + r, s.y - r); ctx.lineTo(s.x - r, s.y + r); break;
      case "centre": ctx.arc(s.x, s.y, r, 0, G.TAU); ctx.moveTo(s.x - 2, s.y); ctx.lineTo(s.x + 2, s.y); break;
      case "perpendicular": ctx.moveTo(s.x - r, s.y + r); ctx.lineTo(s.x + r, s.y + r); ctx.moveTo(s.x - r, s.y + r); ctx.lineTo(s.x - r, s.y - r); ctx.moveTo(s.x - r, s.y); ctx.lineTo(s.x, s.y); ctx.lineTo(s.x, s.y + r); break;
      case "tangent": ctx.arc(s.x, s.y + 2, r - 1, 0, G.TAU); ctx.moveTo(s.x - r - 2, s.y - r + 1); ctx.lineTo(s.x + r + 2, s.y - r + 1); break;
      case "nearest": ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x + r, s.y - r); ctx.lineTo(s.x - r, s.y + r); ctx.lineTo(s.x + r, s.y + r); ctx.closePath(); break;
      default: ctx.moveTo(s.x - r, s.y); ctx.lineTo(s.x + r, s.y); ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x, s.y + r);
    }
    ctx.stroke();
    const name = { endpoint: "Endpoint", midpoint: "Midpoint", intersection: "Intersection", centre: "Centre", perpendicular: "Perpendicular", tangent: "Tangent", nearest: "Nearest", grid: "Grid" }[snap.kind];
    if (name) {
      ctx.font = "11.5px Archivo, system-ui, sans-serif";
      const w = ctx.measureText(name).width;
      ctx.fillStyle = "rgba(12,12,14,.92)"; ctx.fillRect(s.x + 10, s.y + 9, w + 10, 18);
      ctx.fillStyle = COLORS.snap; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(name, s.x + 15, s.y + 18);
    }
  }

  hitLabel(sx, sy) { return this.hits.find(h => sx >= h.x0 && sx <= h.x1 && sy >= h.y0 && sy <= h.y1) || null; }
}
