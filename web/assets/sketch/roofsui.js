// Roofs in the workspace: Roof by Footprint in sketch mode (Pick Walls with Overhang, per-edge Defines Slope,
// Slope Arrow), Roof by Extrusion, plan lines and slope arrows, 3D, Properties, attaching walls, parapets.
import * as G from "./geom.js";
import * as R from "./roofs.js";
import * as S from "./solids.js";
import * as C from "./components.js";
import { checkSketch, autoTrim as FTrim } from "./floors.js";
import { BoundaryTool, SKETCH_COLOR, sketchLines } from "./floorsui.js";
import { makeLine, makeArc } from "./elements.js";
import { COLORS } from "./plan.js";
import { newId, levelLabel } from "./model.js";
import { makeWall, checkWall, wallHeights } from "./walls.js";
import * as LV from "./levels.js";

const deg = r => Math.round((r * 180) / Math.PI * 100) / 100;
const lineCurve = l => (l.shape === "arc" ? { shape: "arc", c: l.c, r: l.r, start: l.start, sweep: l.sweep } : { shape: "line", a: l.a, b: l.b });
const isArrow = l => !!l.arrow;
const roofPrefs = app => app.prefs.roof || {};

// --------------------------------------------------------------------------- sketch mode
export function startRoofSketch(app, roofId = null) {
  if (app.sketch) { app.toast("Finish or cancel the sketch you are in first."); return; }
  const roof = roofId && app.doc.roofs.find(r => r.id === roofId);
  const p = roofPrefs(app);
  // as in Revit, a roof sketched on a plan with a level above sits on that level (where the walls end)
  const L = LV.sorted(app.doc), i = L.findIndex(l => l.id === app.levelId), up = !roof && i >= 0 && i < L.length - 1 ? L[i + 1] : null;
  app.sketch = {
    id: newId("sk"), kind: "roof", levelId: roof ? roof.baseLevelId : app.levelId, baseLevelId: roof ? roof.baseLevelId : (up?.id || app.levelId), editRoofId: roof?.id || null,
    typeId: roof?.typeId || (app.doc.roofTypes.some(t => t.id === p.typeId) ? p.typeId : app.doc.roofTypes[0].id),
    baseOffset: roof ? roof.baseOffset : (p.baseOffset ?? 0), rafterCut: roof?.rafterCut || p.rafterCut || "plumb", fasciaDepth: roof?.fasciaDepth ?? p.fasciaDepth ?? 0,
    bad: new Set(), message: "",
  };
  if (roof) {
    if (!roofOnPlan(app.doc, roof, app.levelId)) app.setLevel(roof.baseLevelId);
    app.sketch.levelId = app.levelId;
    const lv = app.levelId;
    app.commit("Edit footprint", doc => {
      for (const c of roof.boundary) {
        const l = c.shape === "arc" ? makeArc("sketch", lv, "sketch", c) : makeLine("sketch", lv, "sketch", c.a, c.b);
        Object.assign(l, { sketchId: app.sketch.id, definesSlope: c.definesSlope, slope: c.slope, overhang: c.overhang || 0 });
        doc.lines.push(l);
      }
      for (const a of roof.slopeArrows || []) { const l = makeLine("sketch", lv, "sketch", a.tail, a.head); Object.assign(l, { sketchId: app.sketch.id, arrow: true, tailHeight: a.tailHeight, headHeight: a.headHeight }); doc.lines.push(l); }
    });
  }
  app.selection.clear();
  app.prefs.boundary = { ...(app.prefs.boundary || {}), mode: roof ? "line" : "walls" };
  app.setTool("boundary");
  app.sketchChanged();
  if (up) app.toast(`The roof will sit on ${up.name}, the level above. Change Base Level in Properties.`);
}

/** Builds the roof record the sketch describes (throws in plain words). */
function roofFromSketch(app) {
  const sk = app.sketch, lines = sketchLines(app), edges = lines.filter(l => !isArrow(l)), arrows = lines.filter(isArrow);
  if (arrows.length > 1) throw Object.assign(new Error("Use one slope arrow per roof."), { bad: arrows.map(l => l.id) });
  const curves = edges.map(l => ({ ...lineCurve(l), definesSlope: arrows.length ? false : l.definesSlope !== false, slope: l.slope ?? Math.PI / 6, overhang: l.overhang || 0 }));
  const res = checkSketch(curves);
  if (!res.ok) throw Object.assign(new Error(res.message.replace(/floor/g, "roof")), { bad: res.bad.map(i => edges[i]?.id).filter(Boolean) });
  if (res.loops.length > 1) throw Object.assign(new Error("A roof footprint is one closed loop. For a roof with a hole (a courtyard), make two roofs."), { bad: edges.map(l => l.id) });
  const roof = R.makeRoof(app.doc, { baseLevelId: sk.baseLevelId, baseOffset: sk.baseOffset, typeId: sk.typeId, rafterCut: sk.rafterCut, fasciaDepth: sk.fasciaDepth, boundary: curves,
    slopeArrows: arrows.map(l => ({ tail: l.a, head: l.b, tailHeight: l.tailHeight ?? 0, headHeight: l.headHeight ?? 300 })) });
  if (arrows.length && !G.pointInPolygon(G.mid(arrows[0].a, arrows[0].b), res.loops[0])) throw Object.assign(new Error("The slope arrow must be inside the footprint."), { bad: [arrows[0].id] });
  R.roofGeometry(app.doc, roof);
  return { roof, ids: new Set(lines.map(l => l.id)) };
}

export async function finishRoofSketch(app, ui) {
  const sk = app.sketch; if (!sk) return;
  let built;
  try { built = roofFromSketch(app); }
  catch (err) {
    sk.bad = new Set(err.bad || []); sk.message = err.message; app.redraw();
    ui.openDialog(`<h3>Cannot finish the roof</h3><p>${ui.esc(err.message)}</p><p>Fix the lines shown in red, then choose Finish again. Trim/Extend (TR) closes corners; Delete removes extra lines.</p><div class="actions"><button class="btn primary" type="button" id="fOk">Continue sketching</button></div>`, d => { d.querySelector("#fOk").onclick = ui.closeDialog; });
    return;
  }
  const { roof, ids } = built;
  const roofId = app.commit(sk.editRoofId ? "Edit roof" : "Roof", doc => {
    doc.lines = doc.lines.filter(l => !ids.has(l.id));
    const old = sk.editRoofId && doc.roofs.find(r => r.id === sk.editRoofId);
    if (old) { const keep = old.id; Object.assign(old, roof, { id: keep }); return keep; }
    doc.roofs.push(roof); return roof.id;
  });
  if (!roofId) return;
  app.prefs.roof = { ...roofPrefs(app), typeId: sk.typeId, baseOffset: sk.baseOffset, rafterCut: sk.rafterCut, fasciaDepth: sk.fasciaDepth }; app.savePrefs();
  app.sketch = null;
  app.setTool("select");
  app.selection.clear(); app.selection.add(roofId);
  app.sketchChanged();
  await offerAttach(app, ui, roofId);
}

async function offerAttach(app, ui, roofId) {
  const r = app.doc.roofs.find(x => x.id === roofId); if (!r) return;
  let cands = [];
  try { cands = R.wallsUnderRoof(app.doc, r); } catch { cands = []; }
  if (cands.length && await ui.ask(`Attach the ${cands.length} wall${cands.length > 1 ? "s" : ""} below to this roof? They will rise to its underside, filling the gables.`, "Attach")) {
    app.commit("Attach walls to roof", doc => { for (const id of cands) doc.walls.find(x => x.id === id).attachTopTo = roofId; });
  }
}

// --------------------------------------------------------------------------- footprint lines, Pick Walls
export class RoofBoundaryTool extends BoundaryTool {
  constructor(app) {
    super(app);
    this.title = "Boundary Line";
    const p = roofPrefs(app);
    this.overhang = p.overhang ?? 600; this.definesSlope = p.definesSlope ?? true; this.slope = p.slope ?? Math.PI / 6;
  }
  saveRoof() { this.app.prefs.roof = { ...roofPrefs(this.app), overhang: this.overhang, definesSlope: this.definesSlope, slope: this.slope }; this.app.savePrefs(); }
  options() {
    const base = super.options().filter(x => !["Offset", "Extend into wall (to core)"].includes(x.label));
    base.push({ type: "check", label: "Defines Slope", value: this.definesSlope, onChange: v => { this.definesSlope = v; this.saveRoof(); this.app.toolChanged(); } });
    if (this.definesSlope) base.push({ type: "number", label: "Slope (°)", value: deg(this.slope), step: 1, min: 0, max: 80, onChange: v => { if (v >= 0 && v < 89) { this.slope = (v * Math.PI) / 180; this.saveRoof(); } else this.app.toast("Type a slope from 0 to 89°.", true); } });
    if (this.mode === "walls") base.push({ type: "number", label: "Overhang", value: this.overhang, step: 50, onChange: v => { this.overhang = v || 0; this.saveRoof(); this.app.redraw(); } }, { type: "check", label: "Extend to wall core", value: this.toCore, onChange: v => { this.toCore = v; this.savePrefs(); } });
    return base;
  }
  prompt() { return this.mode === "walls" ? "Click the walls round the roof. The edge sits outside each wall by the Overhang; corners trim themselves." : super.prompt(); }
  attrs(overhang = 0) { return { definesSlope: this.definesSlope, slope: this.slope, overhang }; }
  add(elements, label) {
    const app = this.app, lv = app.sketch.levelId, sid = app.sketch.id;
    app.commit(label, doc => { for (const e of elements) { const l = e.shape === "arc" ? makeArc("sketch", lv, "sketch", e) : makeLine("sketch", lv, "sketch", e.a, e.b); Object.assign(l, { sketchId: sid }, this.attrs(0)); doc.lines.push(l); } });
    app.sketch.bad.clear();
  }
  down(c) {
    if (this.mode !== "walls") return super.down(c);
    const app = this.app, id = app.hoverList.find(h => app.isWall(h));
    if (!id) { app.toast("Click a wall."); return; }
    const w = app.lookup(id), sid = app.sketch.id;
    app.commit("Pick Walls", doc => {
      const c0 = R.roofEdgeFromWall(doc, w, { overhang: this.overhang, extendToCore: this.toCore });
      const l = c0.shape === "arc" ? makeArc("sketch", app.sketch.levelId, "sketch", c0) : makeLine("sketch", app.sketch.levelId, "sketch", c0.a, c0.b);
      Object.assign(l, { sketchId: sid }, this.attrs(this.overhang)); doc.lines.push(l);
      const mine = doc.lines.filter(x => x.kind === "sketch" && x.sketchId === sid && !x.arrow);
      FTrim(mine, mine.indexOf(l), w.shape === "arc" ? 0 : 3 * ((doc.wallTypes.find(t => t.id === w.typeId)?.thickness || 300) + this.overhang));
    });
    app.sketch.bad.clear();
  }
  drawPreview(view) {
    if (this.mode === "walls") {
      const app = this.app, id = app.hoverList.find(h => app.isWall(h));
      if (id && this.cursor) { try { const c = R.roofEdgeFromWall(app.doc, app.lookup(id), { overhang: this.overhang, extendToCore: this.toCore }); view.drawLine({ ...c, style: "medium" }, SKETCH_COLOR); } catch { /* not pickable */ } }
      return;
    }
    super.drawPreview(view);
  }
}

/** Slope Arrow: tail to head, inside the footprint. With an arrow, the roof is one plane. */
export class SlopeArrowTool {
  constructor(app) { this.app = app; this.name = "slopeArrow"; this.title = "Slope Arrow"; this.pts = []; this.cursor = null; this.wantsSnap = true; }
  options() { return [{ type: "text", text: "Slope Arrow", cls: "modename" }, { type: "text", text: "Click the tail (low end), then the head. Set the heights at tail and head in Properties." }]; }
  prompt() { return this.pts.length ? "Click the head of the slope arrow (the way the roof rises or falls)." : "Click the tail of the slope arrow."; }
  hasFrom() { return this.pts.length > 0; }
  constrainFrom() { return this.pts[0] || null; }
  move(c) { this.cursor = c.pt; this.app.redraw(); }
  down(c) {
    if (!this.pts.length) { this.pts.push(c.pt); this.app.toolChanged(); return; }
    if (G.dist(this.pts[0], c.pt) < 100) return;
    const a = this.pts[0], b = c.pt, app = this.app; this.pts = [];
    let id;
    app.commit("Slope arrow", doc => { const l = makeLine("sketch", app.sketch.levelId, "sketch", a, b); Object.assign(l, { sketchId: app.sketch.id, arrow: true, tailHeight: 0, headHeight: 300 }); doc.lines.push(l); id = l.id; });
    app.setTool("select"); if (id) { app.selection.clear(); app.selection.add(id); app.selectionChanged(); }
  }
  typed(v) { if (!this.pts.length || !(v > 0)) return false; const from = this.pts[0], cur = this.cursor || G.add(from, { x: 1, y: 0 }); this.down({ pt: G.add(from, G.mul(G.norm(G.sub(cur, from)), v)) }); return true; }
  escape() { if (this.pts.length) { this.pts = []; this.app.toolChanged(); return true; } return false; }
  drawPreview(view) { if (this.pts.length && this.cursor) { drawArrow(view, this.pts[0], this.cursor, SKETCH_COLOR); view.tempDim(this.pts[0], this.cursor, String(Math.round(G.dist(this.pts[0], this.cursor)))); } }
}

// --------------------------------------------------------------------------- roof by extrusion
/** Three clicks in plan: the two ends of the profile line, then the depth. A dialog sets the profile. */
export class RoofExtrusionTool {
  constructor(app) { this.app = app; this.name = "roofExtrusion"; this.title = "Roof by Extrusion"; this.pts = []; this.cursor = null; this.wantsSnap = true; }
  options() { return [{ type: "text", text: "Roof by Extrusion", cls: "modename" }, { type: "text", text: `Work plane: vertical, through the line you click. Base: ${this.app.levelName()}` }]; }
  prompt() { return ["Click the start of the profile line (across the roof, e.g. along a gable wall).", "Click the end of the profile line.", "Click how far the roof extrudes (or type the depth and press Enter)."][this.pts.length]; }
  hasFrom() { return this.pts.length > 0; }
  constrainFrom() { return this.pts.at(-1) || null; }
  move(c) { this.cursor = c.pt; this.app.redraw(); }
  depthOf(p) { const [a, b] = this.pts, n = G.perp(G.norm(G.sub(b, a))); return G.dot(G.sub(p, a), n); }
  down(c) {
    if (this.pts.length < 2) { if (this.pts.length === 1 && G.dist(this.pts[0], c.pt) < 500) { this.app.toast("Make the profile line at least 500 mm long."); return; } this.pts.push(c.pt); this.app.toolChanged(); return; }
    const d = this.depthOf(c.pt);
    if (Math.abs(d) < 100) return;
    this.finish(d);
  }
  finish(d) { const [a, b] = this.pts; this.pts = []; this.app.toolChanged(); extrusionRoofDialog(this.app, this.app.ui, { a, b, start: 0, end: d }); }
  typed(v) { if (this.pts.length !== 2 || !(v > 0)) return false; const s = this.cursor ? Math.sign(this.depthOf(this.cursor)) || 1 : 1; this.finish(s * v); return true; }
  escape() { if (this.pts.length) { this.pts = []; this.app.toolChanged(); return true; } return false; }
  drawPreview(view) {
    if (!this.cursor || !this.pts.length) return;
    if (this.pts.length === 1) { view.segment(this.pts[0], this.cursor, SKETCH_COLOR, 2); view.tempDim(this.pts[0], this.cursor, String(Math.round(G.dist(this.pts[0], this.cursor)))); return; }
    const [a, b] = this.pts, n = G.perp(G.norm(G.sub(b, a))), d = this.depthOf(this.cursor), off = G.mul(n, d);
    view.polygon([a, b, G.add(b, off), G.add(a, off)], "rgba(255,79,216,.08)", SKETCH_COLOR, 1.5);
    view.tempDim(b, G.add(b, off), String(Math.round(Math.abs(d))));
  }
}

/** Profile points for a wall-to-wall width W and a rise H, continued past each wall by the overhang. */
const PROFILES = {
  gable: (W, H, o) => { const k = (2 * H) / W; return [{ s: -o, h: -o * k }, { s: W / 2, h: H }, { s: W + o, h: -o * k }]; },
  mono: (W, H, o) => { const k = H / W; return [{ s: -o, h: -o * k }, { s: W + o, h: H + o * k }]; },
  curved: (W, H, o) => Array.from({ length: 17 }, (_, i) => { const s = -o + ((W + 2 * o) * i) / 16, x = (2 * s) / W - 1; return { s, h: H * (1 - x * x) }; }),
};
export function extrusionRoofDialog(app, ui, init) {
  const doc = app.doc, roof = init.editId && doc.roofs.find(r => r.id === init.editId);
  const W = Math.round(G.dist(init.a, init.b));
  const p = roofPrefs(app).extrusion || {};
  const cur = roof ? roof.profile.map(q => `${Math.round(q.s)}, ${Math.round(q.h)}`).join("\n") : "";
  ui.openDialog(`<h3>${roof ? "Edit" : "New"} roof by extrusion</h3><p>The profile is drawn on the vertical plane through the line you clicked (${W} mm long), measured from its start, and pushed out ${Math.round(Math.abs(init.end - init.start))} mm.</p>
    <table><tr><td>Profile</td><td><select id="xShape"><option value="gable">Gable (two slopes)</option><option value="mono">Mono-pitch (one slope)</option><option value="curved">Curved (barrel)</option><option value="custom"${roof ? " selected" : ""}>Custom points</option></select></td></tr>
    <tr><td>Rise (mm)</td><td><input id="xRise" type="number" step="50" min="0" value="${p.rise ?? 1500}"></td></tr>
    <tr><td>Overhang each end (mm)</td><td><input id="xOver" type="number" step="50" min="0" value="${p.over ?? 0}"></td></tr>
    <tr><td>Custom points: "along, up" in mm, one per line</td><td><textarea id="xPts" rows="5" style="width:100%">${cur}</textarea></td></tr>
    <tr><td>Base Offset From Level (mm)</td><td><input id="xBase" type="number" step="50" value="${roof?.baseOffset ?? p.baseOffset ?? 3000}"></td></tr>
    <tr><td>Type</td><td><select id="xType">${doc.roofTypes.map(t => `<option value="${ui.esc(t.id)}"${t.id === (roof?.typeId || p.typeId) ? " selected" : ""}>${ui.esc(t.name)}</option>`).join("")}</select></td></tr></table>
    <div id="xErr"></div><div class="actions"><button class="btn" type="button" id="xCancel">Cancel</button><button class="btn primary" type="button" id="xOk">${roof ? "Apply" : "Make roof"}</button></div>`, d => {
    d.querySelector("#xCancel").onclick = ui.closeDialog;
    d.querySelector("#xOk").onclick = async () => {
      const shape = d.querySelector("#xShape").value, rise = parseFloat(d.querySelector("#xRise").value), over = parseFloat(d.querySelector("#xOver").value) || 0, base = parseFloat(d.querySelector("#xBase").value);
      const err = m => { d.querySelector("#xErr").innerHTML = `<div class="err">${ui.esc(m)}</div>`; };
      let profile;
      if (shape === "custom") {
        profile = d.querySelector("#xPts").value.split(/\n+/).map(s => s.trim()).filter(Boolean).map(s => s.split(/[,;\s]+/).map(Number)).map(([s, h]) => ({ s, h }));
        if (profile.length < 2 || profile.some(q => !Number.isFinite(q.s) || !Number.isFinite(q.h))) return err("Type at least two points, each as: along, up (for example 0, 0).");
      } else {
                if (!(rise > 0)) return err("Rise must be more than 0.");
        profile = PROFILES[shape](W, rise, over);
      }
      if (!Number.isFinite(base)) return err("Type the base offset in mm.");
      const typeId = d.querySelector("#xType").value;
      const fields = { baseLevelId: roof?.baseLevelId || app.levelId, baseOffset: base, typeId, a: init.a, b: init.b, start: init.start, end: init.end, profile };
      try { R.roofGeometry(doc, R.makeExtrusionRoof(doc, fields)); } catch (e) { return err(e.message); }
      app.prefs.roof = { ...roofPrefs(app), extrusion: { rise, over, baseOffset: base, typeId } }; app.savePrefs();
      const id = app.commit(roof ? "Edit roof" : "Roof by extrusion", dd => {
        const old = roof && dd.roofs.find(r => r.id === roof.id);
        const made = R.makeExtrusionRoof(dd, fields);
        if (old) { Object.assign(old, made, { id: old.id }); return old.id; }
        dd.roofs.push(made); return made.id;
      });
      if (!id) return;
      ui.closeDialog();
      app.setTool("select"); app.selection.clear(); app.selection.add(id); app.selectionChanged();
      if (!roof) await offerAttach(app, ui, id);
    };
  });
}

// --------------------------------------------------------------------------- plan
function drawArrow(view, a, b, color, label) {
  view.segment(a, b, color, 1.5);
  const B = view.toScreen(b), A = view.toScreen(a), ang = Math.atan2(B.y - A.y, B.x - A.x), ctx = view.ctx;
  ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(B.x, B.y);
  ctx.lineTo(B.x - 11 * Math.cos(ang - 0.38), B.y - 11 * Math.sin(ang - 0.38)); ctx.lineTo(B.x - 11 * Math.cos(ang + 0.38), B.y - 11 * Math.sin(ang + 0.38)); ctx.closePath(); ctx.fill();
  if (label) view.label(G.mid(a, b), label, { color, bg: "rgba(20,20,24,.75)" });
}

/** A roof shows on the plan of its base level and of the level just below (where its walls are). */
export function roofOnPlan(doc, r, levelId) {
  if (r.baseLevelId === levelId) return true;
  const L = LV.sorted(doc), i = L.findIndex(l => l.id === r.baseLevelId);
  return i > 0 && L[i - 1].id === levelId;
}

/** Roofs on the plan: outline, ridges, hips and valleys, and slope arrows. */
export function drawRoofs(view, app) {
  const doc = app.doc;
  for (const r of doc.roofs) {
    if (!roofOnPlan(doc, r, app.levelId) || r.id === app.sketch?.editRoofId) continue;
    let g; try { g = R.roofGeometry(doc, r); } catch { continue; }
    const sel = app.selection.has(r.id), hov = app.hoverId === r.id;
    const col = sel ? COLORS.sel : hov ? COLORS.hover : "#a39e94";
    view.polygon(g.outline, sel ? "rgba(59,130,246,.08)" : "rgba(160,150,130,.05)", col, sel || hov ? 2 : 1.2);
    for (const l of g.lines) view.segment(l.a, l.b, col, 1, l.kind === "valley" ? [6, 4] : null);
    if (r.method === "footprint") {
      const arrow = r.slopeArrows?.[0];
      if (arrow) { const L = G.dist(arrow.tail, arrow.head); drawArrow(view, arrow.tail, arrow.head, col, `${R.slopeLabel(Math.atan(Math.abs((arrow.headHeight - arrow.tailHeight) / L)), "ratio")}`); continue; }
      const { poly, slopes } = R.roofFootprint(r), inside = G.polygonArea(poly) > 0 ? 1 : -1;
      const seen = new Set();
      poly.forEach((p, i) => {
        if (slopes[i] == null) return;
        const q = poly[(i + 1) % poly.length], m = G.mid(p, q), key = `${Math.round(slopes[i] * 1e4)}:${Math.round(G.angleOf(G.sub(q, p)) * 100)}`;
        if (G.dist(p, q) < 600 || seen.has(key + Math.round(m.x / 2000) + Math.round(m.y / 2000))) return; seen.add(key + Math.round(m.x / 2000) + Math.round(m.y / 2000));
        const n = G.mul(G.perp(G.norm(G.sub(q, p))), inside), a = G.add(m, G.mul(n, view.px(10))), b = G.add(m, G.mul(n, view.px(46)));
        drawArrow(view, a, b, col, `${deg(slopes[i])}°`);
      });
    } else {
      const u = G.norm(G.sub(r.b, r.a)), n = G.perp(u), mid = G.add(G.mid(r.a, r.b), G.mul(n, (r.start + r.end) / 2));
      view.label(mid, "Roof by extrusion", { color: col, bg: "rgba(20,20,24,.75)" });
    }
  }
}

/** In a roof sketch, drawn over the faded model: slope marks on lines that define slope, and the slope arrow. */
export function drawRoofSketchMarks(view, app) {
  if (app.sketch?.kind === "roof") {
    const loop0 = sketchLines(app).filter(l => !l.arrow);
    const centre = loop0.length ? loop0.reduce((m, l) => ({ x: m.x + (l.a?.x ?? l.c.x) / loop0.length, y: m.y + (l.a?.y ?? l.c.y) / loop0.length }), { x: 0, y: 0 }) : null;
    for (const l of sketchLines(app)) {
      const bad = app.sketch.bad.has(l.id), col = bad ? "#ff5a5f" : SKETCH_COLOR;
      if (l.arrow) { drawArrow(view, l.a, l.b, col, `${Math.round(l.tailHeight ?? 0)} → ${Math.round(l.headHeight ?? 300)}`); continue; }
      if (l.definesSlope === false || l.shape !== "line" || G.dist(l.a, l.b) < 300) continue;
      const m = G.mid(l.a, l.b), u = G.norm(G.sub(l.b, l.a)), ctx = view.ctx;
      let n = G.perp(u); if (centre && G.dot(G.sub(centre, m), n) < 0) n = G.mul(n, -1); // the mark points into the roof
      const s = 7, A = view.toScreen(G.add(m, G.mul(u, view.px(-s)))), B = view.toScreen(G.add(m, G.mul(u, view.px(s)))), Cp = view.toScreen(G.add(m, G.mul(n, view.px(s * 1.4))));
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.lineTo(Cp.x, Cp.y); ctx.closePath(); ctx.fill();
      view.label(G.add(m, G.mul(n, view.px(24))), `${deg(l.slope ?? Math.PI / 6)}°`, { color: col, size: 11, bg: "rgba(20,20,24,.8)" });
    }
  }
}

export function roofsAt(app, p, tolMm) {
  const out = [];
  for (const r of app.doc.roofs) {
    if (!roofOnPlan(app.doc, r, app.levelId) || r.id === app.sketch?.editRoofId) continue;
    let g; try { g = R.roofGeometry(app.doc, r); } catch { continue; }
    const o = g.outline, edge = Math.min(...o.map((q, i) => G.projectOnSegment(p, q, o[(i + 1) % o.length]).dist));
    if (edge <= tolMm) out.push({ id: r.id, d: edge + 0.3 });
    else if (G.pointInPolygon(p, o)) out.push({ id: r.id, d: tolMm * 0.97 });
  }
  return out;
}

// --------------------------------------------------------------------------- 3D
export function buildRoofs3D(group, THREE, app, visible) {
  const doc = app.doc, style = app.prefs.visual || "shaded";
  for (const r of doc.roofs) {
    if ((visible && !visible.has(r.baseLevelId)) || r.id === app.sketch?.editRoofId) continue;
    let m; try { m = R.roofMesh(doc, r); } catch { continue; }
    const sel = app.selection.has(r.id);
    const V = q => [q.x / 1000, q.z / 1000, -q.y / 1000];
    if (style !== "wire") {
      const pos = []; for (const t of m.tris) for (const q of t) pos.push(...V(q));
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals();
      const colour = sel ? 0x3b82f6 : new THREE.Color(R.roofType(doc, r).color || "#5b6168").getHex();
      const opts = { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
      const mat = style === "hidden" ? new THREE.MeshBasicMaterial({ color: 0xf2f2f2, ...opts }) : style === "consistent" ? new THREE.MeshBasicMaterial({ color: colour, ...opts }) : new THREE.MeshStandardMaterial({ color: colour, roughness: 0.8, flatShading: true, ...opts });
      const mesh = new THREE.Mesh(geo, mat); mesh.userData.id = r.id; mesh.castShadow = mesh.receiveShadow = style === "realistic"; group.add(mesh);
    }
    const ep = []; for (const [a, b] of m.edges) ep.push(...V(a), ...V(b));
    const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.Float32BufferAttribute(ep, 3));
    const lines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: style === "wire" ? (sel ? 0x3b82f6 : 0xe8e8ec) : style === "hidden" ? 0x111111 : 0x1b1b20 }));
    lines.userData.id = r.id; group.add(lines);
  }
}

/** Wall solids under an attached roof follow its underside. */
export function cutWallsByRoof(doc, w, solids) {
  if (!w.attachTopTo) return solids;
  const r = doc.roofs.find(x => x.id === w.attachTopTo); if (!r) return solids;
  const h = wallHeights(doc, w);
  try { return R.clipUnderRoof(doc, r, solids, h.ownTop ?? h.z1); } catch { return solids; }
}

/** A prism with a sloped top (top: plane z = a x + b y + c) as three.js geometry. */
export function slopedPrismGeometry(THREE, s) {
  const zt = q => (s.top ? Math.min(s.z1, R.planeZ(s.top, q)) : s.z1);
  const poly = G.polygonArea(s.poly) < 0 ? [...s.poly].reverse() : s.poly;
  const V = (q, z) => [q.x / 1000, z / 1000, -q.y / 1000];
  const pos = [];
  for (const t of S.triangulate(poly)) { pos.push(...V(t[0], zt(t[0])), ...V(t[1], zt(t[1])), ...V(t[2], zt(t[2]))); pos.push(...V(t[0], s.z0), ...V(t[2], s.z0), ...V(t[1], s.z0)); }
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    pos.push(...V(a, s.z0), ...V(b, s.z0), ...V(b, zt(b)), ...V(a, s.z0), ...V(b, zt(b)), ...V(a, zt(a)));
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  return g;
}

// --------------------------------------------------------------------------- properties
export function roofSketchProps(app, esc) {
  const sk = app.sketch, doc = app.doc;
  return `<div class="ptype"><div class="row"><span>Basic Roof</span><span>Sketch mode</span></div>
    <select id="rkType" aria-label="Roof type">${doc.roofTypes.map(t => `<option value="${esc(t.id)}"${t.id === sk.typeId ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
    <div class="pgroup">Constraints</div>
    <div class="prow"><span>Base Level</span><select id="rkLevel">${LV.sorted(doc).map(l => `<option value="${esc(l.id)}"${l.id === sk.baseLevelId ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select></div>
    <div class="prow"><span>Base Offset From Level</span><input id="rkBase" type="number" step="50" value="${sk.baseOffset}"></div>
    <div class="pgroup">Construction</div>
    <div class="prow"><span>Rafter Cut</span><select id="rkCut">${Object.entries(R.RAFTER_CUTS).map(([k, v]) => `<option value="${k}"${k === sk.rafterCut ? " selected" : ""}>${v}</option>`).join("")}</select></div>
    <div class="prow"><span>Fascia Depth</span><input id="rkFascia" type="number" step="10" min="0" value="${sk.fasciaDepth}"${sk.rafterCut === "plumb" ? " disabled" : ""}></div>
    <div class="pnote">Pick the walls (or draw lines) round the roof as one closed loop. Select a line to set <b>Defines Slope</b> and its slope: all lines sloped make a hip roof, two opposite lines not sloped make a gable, one sloped line a mono-pitch, none a flat roof. A <b>Slope Arrow</b> makes one plane (a flat roof with a fall). Then choose <b>Finish Edit Mode</b>.${sk.message ? `<br><span style="color:#ff8a8d">${esc(sk.message)}</span>` : ""}</div>`;
}
export function wireRoofSketchProps(app, renderProps) {
  const $ = s => document.querySelector(s), sk = app.sketch;
  $("#rkType").onchange = e => { sk.typeId = e.target.value; };
  $("#rkLevel").onchange = e => { sk.baseLevelId = e.target.value; };
  $("#rkBase").onchange = e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) sk.baseOffset = v; };
  $("#rkCut").onchange = e => { sk.rafterCut = e.target.value; renderProps(); };
  $("#rkFascia").onchange = e => { const v = parseFloat(e.target.value); if (v >= 0) sk.fasciaDepth = v; };
}

/** Properties of selected footprint lines or a slope arrow in a roof sketch. */
export function roofLineProps(app, ids, esc) {
  const ls = ids.map(id => app.doc.lines.find(l => l.id === id));
  if (ls.length === 1 && ls[0].arrow) {
    const a = ls[0];
    return `<div class="ptype"><div class="row"><span>Slope Arrow</span></div></div>
      <div class="pgroup">Constraints</div>
      <div class="prow"><span>Height Offset at Tail</span><input id="raTail" type="number" step="10" value="${a.tailHeight ?? 0}"></div>
      <div class="prow"><span>Height Offset at Head</span><input id="raHead" type="number" step="10" value="${a.headHeight ?? 300}"></div>
      <div class="prow"><span>Length</span><input readonly value="${Math.round(G.dist(a.a, a.b))}"></div>
      <div class="pnote">Heights are from the roof's base. 100 mm over 10 m gives a 1% fall for a flat roof.</div>`;
  }
  const edges = ls.filter(l => !l.arrow);
  const allOn = edges.every(l => l.definesSlope !== false), slope = edges.every(l => Math.abs((l.slope ?? Math.PI / 6) - (edges[0].slope ?? Math.PI / 6)) < 1e-9) ? deg(edges[0].slope ?? Math.PI / 6) : "";
  return `<div class="ptype"><div class="row"><span>${edges.length === 1 ? "Roof Boundary Line" : `Boundary Lines (${edges.length})`}</span></div></div>
    <div class="pgroup">Constraints</div>
    <div class="prow"><span>Defines Roof Slope</span><input id="rlDef" type="checkbox"${allOn ? " checked" : ""}></div>
    <div class="prow"><span>Slope</span><input id="rlSlope" value="${slope === "" ? "" : `${slope}°`}" placeholder="30° or 1:2"${allOn ? "" : " disabled"}></div>
    <div class="prow"><span>Overhang</span><input readonly value="${edges.length === 1 ? Math.round(edges[0].overhang || 0) : ""}"></div>
    <div class="pnote">Type the slope in degrees (30) or as rise:run (1:2).</div>`;
}
export function wireRoofLineProps(app, ids, renderProps) {
  const $ = s => document.querySelector(s);
  const edit = (label, fn) => { app.commit(label, doc => ids.forEach(id => fn(doc.lines.find(l => l.id === id)))); renderProps(); };
  if ($("#raTail")) {
    $("#raTail").onchange = e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) edit("Slope arrow", l => { l.tailHeight = v; }); };
    $("#raHead").onchange = e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) edit("Slope arrow", l => { l.headHeight = v; }); };
    return;
  }
  $("#rlDef").onchange = e => edit("Defines slope", l => { if (!l.arrow) l.definesSlope = e.target.checked; });
  $("#rlSlope").onchange = e => { let v; try { v = R.parseSlope(e.target.value); } catch (err) { app.toast(err.message, true); renderProps(); return; } edit("Slope", l => { if (!l.arrow) l.slope = v; }); };
}

export function roofProps(app, ids, esc) {
  const doc = app.doc, rs = ids.map(id => doc.roofs.find(r => r.id === id)), one = rs.length === 1 ? rs[0] : null;
  const same = k => rs.every(r => r[k] === rs[0][k]) ? rs[0][k] : undefined, typeId = same("typeId"), lv = LV.sorted(doc);
  let g = null; try { g = one && R.roofGeometry(doc, one); } catch { g = null; }
  const fp = one?.method === "footprint" && !one.slopeArrows?.length ? one.boundary.filter(e => e.definesSlope) : [];
  const slope = fp.length && fp.every(e => Math.abs(e.slope - fp[0].slope) < 1e-9) ? `${deg(fp[0].slope)}°` : fp.length ? "" : null;
  return `<div class="ptype"><div class="row"><span>${one ? "Basic Roof" : `Roofs (${rs.length})`}</span><button class="btn" type="button" id="pEditType"${typeId ? "" : " disabled"}>Edit Type</button></div>
    <select id="pType" aria-label="Roof type">${typeId ? "" : `<option value="" selected>(varies)</option>`}${doc.roofTypes.map(t => `<option value="${esc(t.id)}"${t.id === typeId ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
    <div class="pgroup">Constraints</div>
    <div class="prow"><span>Base Level</span><select id="pLevel">${same("baseLevelId") ? "" : `<option value="" selected>(varies)</option>`}${lv.map(l => `<option value="${esc(l.id)}"${l.id === same("baseLevelId") ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select></div>
    <div class="prow"><span>Base Offset From Level</span><input id="pBase" type="number" step="50" value="${same("baseOffset") ?? ""}"></div>
    ${one?.method === "footprint" ? `<div class="pgroup">Construction</div>
    <div class="prow"><span>Rafter Cut</span><select id="pCut">${Object.entries(R.RAFTER_CUTS).map(([k, v]) => `<option value="${k}"${k === one.rafterCut ? " selected" : ""}>${v}</option>`).join("")}</select></div>
    <div class="prow"><span>Fascia Depth</span><input id="pFascia" type="number" step="10" min="0" value="${one.fasciaDepth || 0}"${one.rafterCut === "plumb" ? " disabled" : ""}></div>
    ${slope !== null ? `<div class="prow"><span>Slope</span><input id="pSlope" value="${slope}" placeholder="(varies)"></div>` : ""}` : ""}
    ${one?.method === "extrusion" ? `<div class="pgroup">Constraints</div>
    <div class="prow"><span>Extrusion Start</span><input id="pXs" type="number" step="50" value="${one.start}"></div>
    <div class="prow"><span>Extrusion End</span><input id="pXe" type="number" step="50" value="${one.end}"></div>` : ""}
    ${g ? `<div class="pgroup">Dimensions</div>
    <div class="prow"><span>Thickness</span><input readonly value="${R.roofType(doc, one).thickness}"></div>
    <div class="prow"><span>Top</span><input readonly value="${levelLabel(g.top)}"></div>
    <div class="prow"><span>Plan area</span><input readonly value="${(Math.abs(G.polygonArea(g.outline)) / 1e6).toFixed(2)} m²"></div>
    <div class="prow"><span></span><button class="btn" type="button" id="pEditR">${one.method === "extrusion" ? "Edit Profile" : "Edit Footprint"}</button></div>
    <div class="prow"><span></span><button class="btn" type="button" id="pAttach">Attach walls below</button></div>` : ""}
    <div class="pnote">Double-click a roof to edit its ${one?.method === "extrusion" ? "profile" : "footprint"}.</div>`;
}
export function wireRoofProps(app, ids, renderProps, ui) {
  const $ = s => document.querySelector(s);
  const edit = (label, fn) => app.commit(label, doc => { for (const id of ids) fn(doc.roofs.find(r => r.id === id)); LV.checkLevels(doc); }) === undefined && renderProps();
  $("#pType").onchange = e => e.target.value && edit("Roof type", r => { r.typeId = e.target.value; });
  $("#pLevel").onchange = e => e.target.value && edit("Roof level", r => { r.baseLevelId = e.target.value; });
  $("#pBase").onchange = e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) edit("Base offset", r => { r.baseOffset = v; }); };
  const cut = $("#pCut"); if (cut) cut.onchange = e => { edit("Rafter cut", r => { r.rafterCut = e.target.value; if (r.rafterCut !== "plumb" && !r.fasciaDepth) r.fasciaDepth = 100; }); renderProps(); };
  const fa = $("#pFascia"); if (fa) fa.onchange = e => { const v = parseFloat(e.target.value); if (v >= 0) edit("Fascia depth", r => { r.fasciaDepth = v; }); };
  const sl = $("#pSlope"); if (sl) sl.onchange = e => { let v; try { v = R.parseSlope(e.target.value); } catch (err) { app.toast(err.message, true); renderProps(); return; } edit("Slope", r => { for (const b of r.boundary) if (b.definesSlope) b.slope = v; }); };
  const xs = $("#pXs"); if (xs) xs.onchange = e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) edit("Extrusion start", r => { r.start = v; }); };
  const xe = $("#pXe"); if (xe) xe.onchange = e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) edit("Extrusion end", r => { r.end = v; }); };
  const er = $("#pEditR"); if (er) er.onclick = () => editRoof(app, ui, ids[0]);
  const at = $("#pAttach"); if (at) at.onclick = () => offerAttach(app, ui, ids[0]);
  const et = $("#pEditType"); if (et) et.onclick = () => roofTypeDialog(app, app.doc.roofs.find(r => r.id === ids[0]).typeId, ui);
}

export function editRoof(app, ui, id) {
  const r = app.doc.roofs.find(x => x.id === id); if (!r) return;
  if (r.method === "extrusion") extrusionRoofDialog(app, ui, { a: r.a, b: r.b, start: r.start, end: r.end, editId: r.id });
  else startRoofSketch(app, r.id);
}

export function roofTypeDialog(app, typeId, ui) {
  const doc = app.doc, t = doc.roofTypes.find(x => x.id === typeId); if (!t) return;
  ui.openDialog(`<h3>Type Properties</h3><p>Roof type ${ui.esc(t.name)}. Changes apply to every roof of this type.</p>
    <table><tr><td>Name</td><td><input id="tName" value="${ui.esc(t.name)}" maxlength="60"></td></tr>
    <tr><td>Thickness (mm)</td><td><input id="tThick" type="number" min="20" max="1000" step="5" value="${t.thickness}"></td></tr>
    <tr><td>Colour</td><td><input id="tCol" type="color" value="${t.color || "#5b6168"}"></td></tr></table>
    <div id="tErr"></div><div class="actions"><button class="btn" type="button" id="tDup">Duplicate…</button><button class="btn" type="button" id="tCancel">Cancel</button><button class="btn primary" type="button" id="tOk">OK</button></div>`, d => {
    const val = () => ({ name: d.querySelector("#tName").value.trim(), thickness: parseFloat(d.querySelector("#tThick").value), color: d.querySelector("#tCol").value });
    const bad = v => (!v.name ? "Give the type a name." : !(v.thickness >= 20 && v.thickness <= 1000) ? "Thickness must be from 20 to 1000 mm." : "");
    d.querySelector("#tCancel").onclick = ui.closeDialog;
    d.querySelector("#tOk").onclick = () => { const v = val(), e = bad(v); if (e) { d.querySelector("#tErr").innerHTML = `<div class="err">${e}</div>`; return; } app.commit("Roof type", dd => { Object.assign(dd.roofTypes.find(x => x.id === typeId), v); LV.checkLevels(dd); }); ui.closeDialog(); };
    d.querySelector("#tDup").onclick = async () => {
      const name = await ui.askText("Name of the new roof type", `${t.name} 2`); if (!name) return;
      const v = { ...val(), name: name.trim() }, e = bad(v); if (e) { app.toast(e, true); return; }
      const nt = { id: newId("rt"), ...v };
      app.commit("Duplicate roof type", dd => { dd.roofTypes.push(nt); });
      roofTypeDialog(app, nt.id, ui);
    };
  });
}

// --------------------------------------------------------------------------- parapet on a roof edge
/** Parapet walls standing on a roof's top, flush with its edge, with a coping. */
export function addRoofParapet(doc, roofId, H, T, coping = true) {
  const r = doc.roofs.find(x => x.id === roofId); if (!r) throw new Error("Select a roof.");
  const g = R.roofGeometry(doc, r);
  const flat = g.faces.every(f => (f.slope || 0) < Math.atan(0.05));
  if (!flat) throw new Error("A parapet goes on a flat roof (or one with a small fall). For sloped roofs, use the walls' Parapet instead.");
  let type = doc.wallTypes.find(t => t.function === "exterior" && t.thickness === T && /parapet/i.test(t.name));
  if (!type) { type = { id: newId("wt"), name: `Parapet - ${T} mm`, thickness: T, core: T, function: "exterior", color: "#d9d4ca" }; doc.wallTypes.push(type); }
  let path = g.outline.map(p => ({ x: p.x, y: p.y }));
  if (G.polygonArea(path) > 0) path = path.reverse(); // clockwise: the outside is on the left of travel
  const z = g.top, lv = LV.sorted(doc), base = [...lv].reverse().find(l => l.elevation <= z + 0.5) || lv[0];
  const made = [];
  for (let i = 0; i < path.length; i++) {
    const a = path[i], b = path[(i + 1) % path.length];
    if (G.dist(a, b) < 10) continue;
    const w = makeWall(doc, { a, b, typeId: type.id, locationLine: "finish-ext", baseLevelId: base.id, baseOffset: z - base.elevation, unconnectedHeight: H });
    checkWall(doc, w); doc.walls.push(w); made.push(w.id);
  }
  if (coping) {
    const ring = S.sweepRings(path, 0, [{ x: -T / 2, y: 0 }], true).map(q => ({ x: q[0].x, y: q[0].y })); ring.pop();
    doc.components.push(C.makeSweep(doc, { levelId: base.id, height: z - base.elevation + H, path: ring.map((p, i) => ({ shape: "line", a: p, b: ring[(i + 1) % ring.length] })), profileId: "pf-coping", material: "#c9c4b8", name: "Coping" }));
  }
  LV.checkLevels(doc);
  return made;
}
