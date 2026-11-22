// Annotate: Aligned Dimension (DI) and Text (TX). Both belong to the plan of one level.
import * as G from "./geom.js";
import { newId } from "./model.js";
import { COLORS } from "./plan.js";

export function makeDimension(levelId, a, b, offset) { return { id: newId("dm"), levelId, a: { ...a }, b: { ...b }, offset }; }
export function makeText(levelId, p, text, size = 2.5) { return { id: newId("tx"), levelId, p: { ...p }, text: String(text).slice(0, 500), size }; }
export const dimValue = d => Math.round(G.dist(d.a, d.b));
const scaleOf = app => parseFloat(app.prefs.scale || "100") || 100;

/** Dimension line points: the two witness ends pushed out by the offset. */
export function dimLine(d) {
  const u = G.norm(G.sub(d.b, d.a)), n = G.perp(u);
  return { a2: G.add(d.a, G.mul(n, d.offset)), b2: G.add(d.b, G.mul(n, d.offset)), u, n };
}

// --------------------------------------------------------------------------- tools
export class DimensionTool {
  constructor(app) { this.app = app; this.name = "dimension"; this.title = "Aligned Dimension"; this.pts = []; this.cursor = null; this.wantsSnap = true; }
  options() { return [{ type: "text", text: "Aligned", cls: "modename" }, { type: "text", text: "Click two points (snaps find wall faces, ends and centres), then click where the dimension line goes." }]; }
  prompt() { return ["Click the first point to dimension.", "Click the second point.", "Click to place the dimension line."][this.pts.length]; }
  hasFrom() { return this.pts.length === 1; }
  constrainFrom() { return this.pts.length === 1 ? this.pts[0] : null; }
  move(c) { this.cursor = c.pt; this.app.redraw(); }
  offsetAt(p) { const [a, b] = this.pts; return G.dot(G.sub(p, a), G.perp(G.norm(G.sub(b, a)))); }
  down(c) {
    if (this.pts.length < 2) { if (this.pts.length === 1 && G.dist(this.pts[0], c.pt) < 1) return; this.pts.push(c.pt); this.app.toolChanged(); return; }
    const [a, b] = this.pts, off = this.offsetAt(c.pt), app = this.app; this.pts = [];
    app.commit("Dimension", doc => { doc.dimensions.push(makeDimension(app.levelId, a, b, off)); });
    app.toolChanged();
  }
  escape() { if (this.pts.length) { this.pts = []; this.app.toolChanged(); return true; } return false; }
  drawPreview(view) {
    if (!this.cursor) return;
    if (this.pts.length === 1) { view.segment(this.pts[0], this.cursor, COLORS.preview, 1, [4, 3]); return; }
    if (this.pts.length === 2) drawDim(view, makeDimension("", this.pts[0], this.pts[1], this.offsetAt(this.cursor)), COLORS.preview);
  }
}

export class TextTool {
  constructor(app) { this.app = app; this.name = "text"; this.title = "Text"; this.cursor = null; this.wantsSnap = false; }
  options() { return [{ type: "text", text: "Text", cls: "modename" }, { type: "number", label: "Size on paper (mm)", value: this.app.prefs.textSize ?? 2.5, step: 0.5, min: 1, max: 20, onChange: v => { if (v >= 1 && v <= 20) { this.app.prefs.textSize = v; this.app.savePrefs(); } } }]; }
  prompt() { return "Click where the text goes, then type it."; }
  move(c) { this.cursor = c.pt; this.app.redraw(); }
  async down(c) {
    const app = this.app, p = c.pt;
    const t = await app.askText("Text", "");
    if (!t || !t.trim()) return;
    let id;
    app.commit("Text", doc => { const x = makeText(app.levelId, p, t.trim(), app.prefs.textSize ?? 2.5); doc.texts.push(x); id = x.id; });
  }
  escape() { return false; }
  drawPreview(view) { if (this.cursor) view.label(this.cursor, "Text", { color: COLORS.preview, size: 12 }); }
}

// --------------------------------------------------------------------------- plan
function drawDim(view, d, col) {
  const { a2, b2, u, n } = dimLine(d), s = Math.sign(d.offset) || 1, ext = view.px(3) * s;
  view.segment(a2, b2, col, 1);
  for (const [p, q] of [[d.a, a2], [d.b, b2]]) view.segment(G.add(p, G.mul(n, view.px(2) * s)), G.add(q, G.mul(n, ext)), col, 1);
  const tick = view.px(4);
  for (const q of [a2, b2]) view.segment(G.add(q, G.mul(G.add(u, n), -tick)), G.add(q, G.mul(G.add(u, n), tick)), col, 1.6);
  return view.label(G.mid(a2, b2), String(dimValue(d)), { color: col, ang: G.angleOf(u), offsetPx: 8 * s, size: 12 });
}

export function drawAnnotations(view, app) {
  const doc = app.doc;
  for (const d of doc.dimensions || []) {
    if (d.levelId !== app.levelId || !d.a || !d.b) continue;
    drawDim(view, d, view.colorFor(d.id, view.print ? "#e8e8ec" : "#c9d4e6"));
  }
  const sc = scaleOf(app);
  for (const t of doc.texts || []) {
    if (t.levelId !== app.levelId) continue;
    const px = Math.max(7, (t.size || 2.5) * sc * view.s); // paper size x scale, in screen pixels
    view.label(t.p, t.text, { color: view.colorFor(t.id, "#e8e8ec"), size: px });
  }
}

/** Hover candidates: dimension lines and text. */
export function annotationsAt(app, p, tol) {
  const out = [], sc = scaleOf(app);
  for (const d of app.doc.dimensions || []) {
    if (d.levelId !== app.levelId || !d.a) continue;
    const { a2, b2 } = dimLine(d);
    const dd = Math.min(G.projectOnSegment(p, a2, b2).dist, G.dist(p, G.mid(a2, b2)) - tol * 0.5);
    if (dd <= tol) out.push({ id: d.id, d: Math.max(0, dd) });
  }
  for (const t of app.doc.texts || []) {
    if (t.levelId !== app.levelId) continue;
    const h = (t.size || 2.5) * sc, w = h * 0.6 * t.text.length;
    if (Math.abs(p.x - t.p.x) <= w / 2 + tol && Math.abs(p.y - t.p.y) <= h / 2 + tol) out.push({ id: t.id, d: 0.2 });
  }
  return out;
}

export function annotationBox(app, levelId) {
  const sc = scaleOf(app), pts = [];
  for (const d of app.doc.dimensions || []) if (d.levelId === levelId && d.a) { const { a2, b2 } = dimLine(d); pts.push(d.a, d.b, a2, b2); }
  for (const t of app.doc.texts || []) if (t.levelId === levelId) { const h = (t.size || 2.5) * sc, w = h * 0.6 * t.text.length; pts.push({ x: t.p.x - w / 2, y: t.p.y - h }, { x: t.p.x + w / 2, y: t.p.y + h }); }
  return pts.length ? [{ x0: Math.min(...pts.map(q => q.x)), y0: Math.min(...pts.map(q => q.y)), x1: Math.max(...pts.map(q => q.x)), y1: Math.max(...pts.map(q => q.y)) }] : [];
}

// --------------------------------------------------------------------------- properties
export function annotationProps(app, ids, esc) {
  const els = ids.map(id => app.lookup(id));
  if (els.every(e => e.text != null)) {
    const one = els.length === 1 ? els[0] : null;
    return `<div class="ptype"><div class="row"><span>${one ? "Text" : `Text (${els.length})`}</span></div></div>
      <div class="pgroup">Text</div>
      ${one ? `<div class="prow"><span>Text</span><input id="atText" value="${esc(one.text)}" maxlength="500"></div>` : ""}
      <div class="prow"><span>Size on paper (mm)</span><input id="atSize" type="number" step="0.5" min="1" max="20" value="${els.every(e => e.size === els[0].size) ? els[0].size : ""}"></div>`;
  }
  const one = els.length === 1 ? els[0] : null;
  return `<div class="ptype"><div class="row"><span>${one ? "Aligned Dimension" : `Dimensions (${els.length})`}</span></div></div>
    <div class="pgroup">Other</div>
    ${one ? `<div class="prow"><span>Value</span><input readonly value="${dimValue(one)}"></div>` : ""}
    <div class="pnote">Dimensions measure between the points you clicked. Move them with Move (MV) or delete them; they do not follow walls that move afterwards.</div>`;
}
export function wireAnnotationProps(app, ids, renderProps) {
  const $ = s => document.querySelector(s);
  const t = $("#atText"); if (t) t.onchange = e => { const v = e.target.value.trim(); if (!v) { app.toast("Text cannot be empty. Delete it instead.", true); renderProps(); return; } app.commit("Text", doc => { doc.texts.find(x => x.id === ids[0]).text = v.slice(0, 500); }); };
  const z = $("#atSize"); if (z) z.onchange = e => { const v = parseFloat(e.target.value); if (v >= 1 && v <= 20) app.commit("Text size", doc => ids.forEach(id => { doc.texts.find(x => x.id === id).size = v; })); else { app.toast("Size must be 1 to 20 mm.", true); renderProps(); } };
}
