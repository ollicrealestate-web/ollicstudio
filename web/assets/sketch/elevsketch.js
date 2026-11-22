// Sketching in an elevation: a sweep's path drawn on the face of a wall, with snaps to the model's edges
// as seen in that elevation (wall ends, openings, slab edges, roof lines, levels) and Pick Lines on those edges.
import * as G from "./geom.js";
import * as THREE from "three";
import * as C from "./components.js";
import { ELEVATIONS } from "./views.js";
import { findSnap } from "./snaps.js";
import { makeLine, makeArc } from "./elements.js";
import { newId, levelLabel } from "./model.js";
import { wallAxis } from "./openings.js";
import * as LV from "./levels.js";
import { checkSketch } from "./floors.js";

/** In plan: the direction towards someone looking at that side, and the elevation's left-to-right direction. */
export const TOWARD_VIEWER = { south: { x: 0, y: -1 }, north: { x: 0, y: 1 }, east: { x: 1, y: 0 }, west: { x: -1, y: 0 } };
export const RIGHT = { south: { x: 1, y: 0 }, north: { x: -1, y: 0 }, east: { x: 0, y: 1 }, west: { x: 0, y: -1 } };
const SK = "#ff4fd8", BAD = "#ff3b3b";

// --------------------------------------------------------------------------- the model's edges, seen in an elevation
/** Every 3D edge line projected into (u along the elevation, z up), in mm. Cached per model change and side. */
export function elevationEdges(app, side) {
  const key = `${app.geomVer}|${side}|${app.view3d.version || 0}`;
  if (app._elevEdges?.key === key) return app._elevEdges.list;
  const v3 = app.view3d; if (v3.dirty) { v3.dirty = false; v3.rebuild(); }
  v3.root.updateMatrixWorld(true);
  const E = ELEVATIONS[side], list = [], seen = new Set(), P = new THREE.Vector3();
  v3.root.traverse(o => {
    if (!o.isLineSegments || !o.geometry?.attributes?.position) return;
    const a = o.geometry.attributes.position;
    for (let i = 0; i + 1 < a.count; i += 2) {
      const q = [i, i + 1].map(k => { P.fromBufferAttribute(a, k).applyMatrix4(o.matrixWorld); return { x: Math.round(E.u({ x: P.x * 1000, y: -P.z * 1000 }) * 10) / 10, y: Math.round(P.y * 10000) / 10 }; });
      if (G.dist(q[0], q[1]) < 1) continue;
      const k = q[0].x < q[1].x || (q[0].x === q[1].x && q[0].y < q[1].y) ? `${q[0].x},${q[0].y},${q[1].x},${q[1].y}` : `${q[1].x},${q[1].y},${q[0].x},${q[0].y}`;
      if (seen.has(k)) continue; seen.add(k);
      list.push({ type: "seg", a: q[0], b: q[1], id: o.userData.id || null });
    }
  });
  app._elevEdges = { key, list };
  return list;
}

/** Level lines across the elevation, as snap and pick lines. */
function levelEdges(app, ev) {
  const u0 = (0 - ev.w / 2) / ev.s + ev.cu, u1 = (ev.w - 150 - ev.w / 2) / ev.s + ev.cu;
  return app.doc.levels.map(l => ({ type: "seg", a: { x: u0, y: l.elevation }, b: { x: u1, y: l.elevation }, id: l.id, level: true }));
}

const sketchCurves = app => app.doc.lines.filter(l => l.kind === "sketch" && l.sketchId === app.sketch?.id);
const asSnap = l => (l.shape === "arc" ? { type: "arc", c: l.c, r: l.r, start: l.start, sweep: l.sweep, id: l.id } : { type: "seg", a: l.a, b: l.b, id: l.id });

// --------------------------------------------------------------------------- sketch mode
/** Starts a sweep or extrusion sketched in the open elevation (or edits one): first pick a wall face as the work plane. */
export function startElevSketch(app, kind, opts = {}) {
  if (app.sketch) { app.toast("Finish or cancel the sketch you are in first."); return; }
  const comp = opts.editId && app.doc.components.find(c => c.id === opts.editId);
  const side = comp?.plane?.side || app.elevSide;
  if (!side) { app.toast(`Open an elevation first (View > Elevations), then choose ${kind === "sweep" ? "Sweep" : "Extrusion"}.`); return; }
  if (app.elevSide !== side) app.openElevation(side);
  const isVoid = comp ? comp.isVoid : !!opts.isVoid;
  const p = app.prefs[kind === "sweep" ? "sweep" : isVoid ? "elevVoid" : "elevExtrusion"] || {};
  app.sketch = {
    id: newId("sk"), kind, elev: side, plane: comp ? { ...comp.plane } : null, levelId: comp?.levelId || app.levelId, editId: comp?.id || null,
    bad: new Set(), message: "", isVoid: comp ? comp.isVoid : !!opts.isVoid, material: comp?.material || p.material || (kind === "sweep" ? "#d9d4ca" : "#c8c2b6"), height: 0,
    profileId: comp?.profileId || p.profileId || "pf-cornice", rectW: comp?.rectW ?? p.rectW ?? 100, rectH: comp?.rectH ?? p.rectH ?? 100, flip: comp?.flip ?? false,
    // extrusion: from Start to End, measured out from the face (negative goes into the wall)
    start: comp?.start ?? p.start ?? 0, end: comp?.end ?? p.end ?? (opts.isVoid ? -300 : 250),
  };
  if (comp) app.commit("Edit sketch", doc => { for (const c of (kind === "sweep" ? comp.path : comp.boundary)) { const l = c.shape === "arc" ? makeArc("sketch", null, "sketch", c) : makeLine("sketch", null, "sketch", c.a, c.b); Object.assign(l, { sketchId: app.sketch.id, elev: true, levelId: null }); doc.lines.push(l); } });
  app.selection.clear();
  app.setTool("elevSketch");
  app.sketchChanged();
}

/** The face of a straight wall that looks towards this elevation, as a vertical plane where s = the elevation's u. */
export function planeFromWall(doc, w, side) {
  if (w.shape !== "line") throw new Error("Pick a straight wall: a sweep is sketched on a flat face.");
  const ax = wallAxis(doc, w), V = TOWARD_VIEWER[side], R = RIGHT[side];
  const nf = G.mul(ax.n, G.dot(ax.n, V) >= 0 ? 1 : -1);
  if (G.dot(nf, V) < 0.97) throw new Error(`That wall does not face the ${ELEVATIONS[side].name} elevation. Pick a wall you see square-on here.`);
  const face = G.add(ax.c0, G.mul(nf, ax.h));
  return { o: G.sub(face, G.mul(R, G.dot(face, R))), u: { ...R }, n: nf, side, wallId: w.id };
}

export const startElevSweep = (app, opts) => startElevSketch(app, "sweep", opts);

export async function finishElevSketch(app, ui) {
  const sk = app.sketch, lines = sketchCurves(app);
  const curves = lines.map(l => (l.shape === "arc" ? { shape: "arc", c: l.c, r: l.r, start: l.start, sweep: l.sweep } : { shape: "line", a: l.a, b: l.b }));
  let error = !sk.plane ? "Pick the wall face to sketch on first." : !curves.length ? "Draw the shape first." : "";
  if (!error && sk.kind === "sweep") try { C.chainPath(curves); } catch (e) { error = e.message; sk.bad = new Set(lines.map(l => l.id)); }
  if (!error && sk.kind === "extrusion") { const r = checkSketch(curves); if (!r.ok) { error = r.message.replace(/floor/g, "extrusion"); sk.bad = new Set(r.bad.map(i => lines[i]?.id).filter(Boolean)); } }
  if (!error && sk.kind === "extrusion" && Math.abs(sk.end - sk.start) < 1) error = "Extrusion Start and End must differ.";
  if (error) {
    sk.message = error; app.redraw();
    ui.openDialog(`<h3>Cannot finish</h3><p>${ui.esc(error)}</p><div class="actions"><button class="btn primary" type="button" id="fOk">Continue sketching</button></div>`, d => { d.querySelector("#fOk").onclick = ui.closeDialog; });
    return;
  }
  // it shows on the plan of the highest level at or below its lowest point
  const zMin = Math.min(...curves.flatMap(c => (c.shape === "arc" ? [c.c.y - c.r] : [c.a.y, c.b.y])));
  const lv = [...LV.sorted(app.doc)].reverse().find(l => l.elevation <= zMin + 1) || LV.sorted(app.doc)[0];
  const ids = new Set(lines.map(l => l.id));
  const ext = sk.kind === "extrusion";
  const id = app.commit(ext ? (sk.isVoid ? "Void extrusion" : "Extrusion") : (sk.isVoid ? "Void sweep" : "Sweep"), doc => {
    doc.lines = doc.lines.filter(l => !ids.has(l.id));
    const fields = ext
      ? { levelId: lv.id, boundary: curves, plane: { ...sk.plane }, start: sk.start, end: sk.end, material: sk.material, isVoid: sk.isVoid }
      : { levelId: lv.id, height: 0, path: curves, plane: { ...sk.plane }, profileId: sk.profileId, rectW: sk.rectW, rectH: sk.rectH, flip: sk.flip, material: sk.material, isVoid: sk.isVoid };
    let c = sk.editId && doc.components.find(x => x.id === sk.editId);
    if (c) Object.assign(c, fields); else { c = ext ? C.makeExtrusion(doc, fields) : C.makeSweep(doc, fields); Object.assign(c, { plane: fields.plane, start: fields.start ?? c.start, end: fields.end ?? c.end }); doc.components.push(c); }
    return c.id;
  });
  if (!id) return;
  if (ext) app.prefs[sk.isVoid ? "elevVoid" : "elevExtrusion"] = { start: sk.start, end: sk.end, material: sk.material };
  else app.prefs.sweep = { ...(app.prefs.sweep || {}), profileId: sk.profileId, rectW: sk.rectW, rectH: sk.rectH, material: sk.material };
  app.savePrefs();
  app.sketch = null; app.setTool("select"); app.selection.clear(); app.selection.add(id); app.sketchChanged();
}

// --------------------------------------------------------------------------- the tool
const MODES = [["line", "Line"], ["rect", "Rectangle"], ["arc3", "Arc by 3 points"], ["pick", "Pick Lines"]];
export class ElevSketchTool {
  constructor(app) {
    this.app = app; this.name = "elevSketch"; this.title = "Sweep path"; this.elev = true;
    this.prefs = app.prefs.elevSketch || (app.prefs.elevSketch = { mode: "line", chain: true });
    this.pts = []; this.cursor = null; this.snap = null; this.hoverEdge = null;
  }
  get mode() { return this.prefs.mode || "line"; }
  /** An edge picked in the 3D view, laid flat onto the work plane. */
  add3DEdge(a, b) {
    const pl = this.app.sketch?.plane;
    if (!pl) { this.app.toast("Click a wall in the elevation first: its face is where the shape is drawn.", true); return; }
    const to = p => ({ x: Math.round(G.dot(G.sub(p, pl.o), pl.u) * 10) / 10, y: Math.round(p.z * 10) / 10 });
    const A = to(a), B = to(b);
    if (G.dist(A, B) < 1) { this.app.toast("That edge points straight at the face: pick one that runs along it.", true); return; }
    this.add([{ shape: "line", a: A, b: B }], "Pick edge");
  }
  options() {
    const app = this.app;
    if (!app.sketch?.plane) return [{ type: "text", text: "Work Plane", cls: "modename" }, { type: "text", text: "Click a wall in this elevation: the path is sketched on its face." }];
    const o = [{ type: "text", text: "Draw", cls: "modename" },
      { type: "seg", label: "Draw", items: MODES.map(([k, title]) => ({ key: k, title, icon: k === "line" ? "line" : k === "rect" ? "rect" : k === "arc3" ? "arc3" : "pick", on: this.mode === k })), onPick: k => { this.prefs.mode = k; this.pts = []; app.savePrefs(); app.toolChanged(); } }];
    if (this.mode === "line") o.push({ type: "check", label: "Chain", value: this.prefs.chain !== false, onChange: v => { this.prefs.chain = v; app.savePrefs(); } });
    return o;
  }
  prompt() {
    if (!this.app.sketch?.plane) return `Click a wall you see square-on: the ${this.app.sketch?.kind === "extrusion" ? "extrusion's shape" : "sweep's path"} is sketched on its face.`;
    const n = this.pts.length;
    if (this.mode === "pick") return "Click an edge of the model here or in the 3D view (a wall end or top, window, slab or level line) to use it.";
    if (this.mode === "rect") return n ? "Click the opposite corner." : "Click the first corner.";
    if (this.mode === "arc3") return ["Click the start of the arc.", "Click the end of the arc.", "Click a point the arc passes through."][n];
    return n ? "Click the next point, or type a length and press Enter. Esc ends the chain." : "Click the start of the path.";
  }
  hasFrom() { return this.pts.length > 0 && this.mode !== "pick"; }
  curves(ev) { return [...elevationEdges(this.app, ev.side), ...levelEdges(this.app, ev), ...sketchCurves(this.app).map(asSnap)]; }
  /** Raw point (u, z) to a snapped point. */
  resolve(ev, raw, shift) {
    const app = this.app, from = this.pts.at(-1) || null, r = 10 / ev.s;
    let pt = raw, snap = null;
    const near = this.curves(ev).filter(c => c.type !== "seg" || G.projectOnSegment(raw, c.a, c.b).dist <= r * 2);
    snap = findSnap(raw, near, { radius: r, from, enabled: app.snapsEnabled, override: app.snapOverride });
    if (snap) pt = snap.point;
    if (from && (!snap || snap.kind === "nearest")) { const q = G.constrainAngle(from, raw, { ortho: shift }); if (q.angleSnapped) { pt = { x: q.x, y: q.y }; snap = null; } }
    if (!snap) pt = { x: Math.round(pt.x), y: Math.round(pt.y) };
    return { pt, snap };
  }
  elevMove(ev, raw, shift) {
    if (!this.app.sketch?.plane) { this.cursor = raw; return; }
    if (this.mode === "pick") {
      // the nearest edge; where edges lie on top of each other (a wall's outside and inside top edge), the longest
      const r = 10 / ev.s, tie = 0.5 / ev.s; let best = null;
      for (const c of this.curves(ev)) {
        if (c.type !== "seg") continue;
        const d = G.projectOnSegment(raw, c.a, c.b).dist, L = G.dist(c.a, c.b);
        if (d <= r && (!best || d < best.d - tie || (Math.abs(d - best.d) <= tie && L > best.L))) best = { c, d, L };
      }
      this.hoverEdge = best?.c || null; this.cursor = raw; return;
    }
    const r = this.resolve(ev, raw, shift); this.cursor = r.pt; this.snap = r.snap;
  }
  add(list, label) {
    const app = this.app, sid = app.sketch.id;
    app.commit(label, doc => { for (const e of list) { const l = e.shape === "arc" ? makeArc("sketch", null, "sketch", e) : makeLine("sketch", null, "sketch", e.a, e.b); Object.assign(l, { sketchId: sid, elev: true, levelId: null }); doc.lines.push(l); } });
    app.sketch.bad.clear();
  }
  elevDown(ev, raw, shift) {
    const app = this.app;
    if (!app.sketch.plane) {
      const id = ev.pickId(raw);
      const w = id && app.doc.walls.find(x => x.id === id);
      if (!w) { app.toast("Click a wall to sketch on its face."); return; }
      try { app.sketch.plane = planeFromWall(app.doc, w, ev.side); } catch (e) { app.toast(e.message, true); return; }
      app.toast(`Work plane: the face of that wall. Now draw the ${app.sketch.kind === "extrusion" ? "shape" : "path"}.`); app.toolChanged(); app.sketchChanged(); return;
    }
    if (this.mode === "pick") { if (this.hoverEdge) this.add([{ shape: "line", a: { ...this.hoverEdge.a }, b: { ...this.hoverEdge.b } }], "Pick line"); return; }
    const p = this.resolve(ev, raw, shift).pt;
    if (this.mode === "rect") {
      if (!this.pts.length) { this.pts.push(p); app.toolChanged(); return; }
      const a = this.pts[0]; this.pts = [];
      if (Math.abs(p.x - a.x) < 1 || Math.abs(p.y - a.y) < 1) { app.toast("Make the rectangle wider and taller than 1 mm."); return; }
      const q = [a, { x: p.x, y: a.y }, p, { x: a.x, y: p.y }];
      this.add(q.map((x, i) => ({ shape: "line", a: x, b: q[(i + 1) % 4] })), "Rectangle"); app.toolChanged(); return;
    }
    if (this.mode === "arc3") {
      this.pts.push(p); if (this.pts.length < 3) { app.toolChanged(); return; }
      const [a, b, m] = this.pts; this.pts = [];
      const arc = G.arcFrom3(a, m, b);
      if (!arc) { app.toast("Those three points are in a line. Click a point off the line."); app.toolChanged(); return; }
      this.add([{ shape: "arc", ...arc }], "Arc"); app.toolChanged(); return;
    }
    // line
    if (!this.pts.length) { this.pts.push(p); app.toolChanged(); return; }
    const a = this.pts.at(-1);
    if (G.dist(a, p) < 1) return;
    this.add([{ shape: "line", a, b: p }], "Line");
    this.pts = this.prefs.chain !== false ? [p] : [];
    app.toolChanged();
  }
  typed(v) {
    if (!(v > 0) || !this.pts.length || this.mode !== "line") return false;
    const a = this.pts.at(-1), cur = this.cursor && G.dist(this.cursor, a) > 1 ? this.cursor : G.add(a, { x: 1, y: 0 });
    const p = G.add(a, G.mul(G.norm(G.sub(cur, a)), v));
    this.add([{ shape: "line", a, b: p }], "Line"); this.pts = this.prefs.chain !== false ? [p] : []; this.app.toolChanged(); return true;
  }
  escape() { if (this.pts.length) { this.pts = []; this.app.toolChanged(); return true; } return false; }
  drawPreview() {}
}

// --------------------------------------------------------------------------- drawing in the elevation
export function drawElevSketch(ctx, ev, app) {
  const sk = app.sketch; if (!sk?.elev || sk.elev !== ev.side) return;
  const S = (p) => ev.toScreen(p.x, p.y);
  const seg = (a, b, col, w = 2, dash = []) => { const A = S(a), B = S(b); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke(); ctx.setLineDash([]); };
  const arc = (c, col, w = 2) => { const P = []; for (let k = 0; k <= 48; k++) { const t = c.start + (c.sweep * k) / 48; P.push({ x: c.c.x + c.r * Math.cos(t), y: c.c.y + c.r * Math.sin(t) }); } for (let k = 0; k < 48; k++) seg(P[k], P[k + 1], col, w); };
  // the work plane's wall, outlined
  if (sk.plane?.wallId) for (const e of elevationEdges(app, ev.side)) if (e.id === sk.plane.wallId) seg(e.a, e.b, "rgba(37,99,235,.55)", 1.5);
  for (const l of sketchCurves(app)) { const col = sk.bad.has(l.id) ? BAD : SK; l.shape === "arc" ? arc(l, col) : seg(l.a, l.b, col); }
  const t = app.tool; if (!t?.elev) return;
  if (t.mode === "pick" && t.hoverEdge) seg(t.hoverEdge.a, t.hoverEdge.b, "#2563eb", 3);
  if (t.cursor && t.pts.length) {
    const a = t.pts.at(-1), c = t.cursor;
    if (t.mode === "line") { seg(a, c, SK, 1.5, [6, 4]); const m = S(G.mid(a, c)); ctx.fillStyle = "#111827"; ctx.font = "12px Archivo, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText(String(Math.round(G.dist(a, c))), m.x, m.y - 8); }
    if (t.mode === "rect") { const p = t.pts[0], q = [p, { x: c.x, y: p.y }, c, { x: p.x, y: c.y }]; q.forEach((x, i) => seg(x, q[(i + 1) % 4], SK, 1.5, [6, 4])); }
    if (t.mode === "arc3") { if (t.pts.length === 1) seg(t.pts[0], c, SK, 1.5, [6, 4]); else { const g = G.arcFrom3(t.pts[0], c, t.pts[1]); if (g) arc(g, SK, 1.5); } }
  }
  if (t.snap) { const p = S(t.snap.point); ctx.strokeStyle = "#16a34a"; ctx.lineWidth = 2; ctx.strokeRect(p.x - 5, p.y - 5, 10, 10); }
  if (!sk.plane && t.cursor) { const p = S(t.cursor); ctx.fillStyle = "#1d4ed8"; ctx.font = "600 12px Archivo, system-ui, sans-serif"; ctx.textAlign = "left"; ctx.fillText("Click a wall", p.x + 12, p.y - 10); }
}

export function elevSweepProps(app, esc) {
  const sk = app.sketch, doc = app.doc, profiles = C.defaultProfiles().concat(doc.profiles || []);
  if (sk.kind === "extrusion") return `<div class="ptype"><div class="row"><span>${sk.isVoid ? "Void Extrusion" : "Extrusion"}</span><span>Sketch mode</span></div></div>
    <div class="pgroup">Constraints</div>
    <div class="prow"><span>Extrusion Start</span><input id="ckStart" type="number" step="10" value="${sk.start}"></div>
    <div class="prow"><span>Extrusion End</span><input id="ckEnd" type="number" step="10" value="${sk.end}"></div>
    <div class="prow"><span>Solid / Void</span><select id="ckVoid"><option value="solid"${sk.isVoid ? "" : " selected"}>Solid</option><option value="void"${sk.isVoid ? " selected" : ""}>Void (cuts walls and floors)</option></select></div>
    <div class="prow"><span>Material</span><input id="ckMat" type="color" value="${sk.material}"${sk.isVoid ? " disabled" : ""}></div>
    <div class="prow"><span>Work Plane</span><input readonly value="${sk.plane ? `Wall face (${ELEVATIONS[sk.elev].name} elevation)` : "Pick a wall"}"></div>
    <div class="pnote">Draw the shape as closed loops on the wall face (an inner loop is a hole): Line, Rectangle, Arc, or <b>Pick Lines</b> on edges here or in the 3D view. Start and End are in mm out from the face; negative goes into the wall, so a Void from 0 to -300 cuts a 300 deep recess or, through a thinner wall, an opening. Then choose <b>Finish Edit Mode</b>.${sk.message ? `<br><span style="color:#ff8a8d">${esc(sk.message)}</span>` : ""}</div>`;
  const w = sk.plane?.wallId && doc.walls.find(x => x.id === sk.plane.wallId);
  return `<div class="ptype"><div class="row"><span>${sk.isVoid ? "Void Sweep" : "Sweep"}</span><span>Sketch mode</span></div></div>
    <div class="pgroup">Profile</div>
    <div class="prow"><span>Profile</span><select id="ckProf">${profiles.map(p => `<option value="${esc(p.id)}"${p.id === sk.profileId ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
    ${profiles.find(p => p.id === sk.profileId)?.rect ? `<div class="prow"><span>Width</span><input id="ckW" type="number" step="10" min="5" value="${sk.rectW}"></div><div class="prow"><span>Height</span><input id="ckH" type="number" step="10" min="5" value="${sk.rectH}"></div>` : ""}
    <div class="prow"><span>Flip profile</span><input id="ckFlip" type="checkbox"${sk.flip ? " checked" : ""}></div>
    <div class="prow"><span>Material</span><input id="ckMat" type="color" value="${sk.material}"></div>
    <div class="prow"><span>Work Plane</span><input readonly value="${sk.plane ? `Wall face (${ELEVATIONS[sk.elev].name} elevation)` : "Pick a wall"}"></div>
    <div class="pnote">Sketch the path on the wall face in this elevation: Line, Rectangle, Arc, or <b>Pick Lines</b> to use an edge of the model (a window head, wall end, slab edge or level line). The profile stands out from the face: with the path drawn left to right, it sits above the line; tick Flip to put it below. Then choose <b>Finish Edit Mode</b>.${sk.message ? `<br><span style="color:#ff8a8d">${esc(sk.message)}</span>` : ""}${w ? "" : ""}</div>`;
}
export function wireElevSweepProps(app, renderProps) {
  const $ = s => document.querySelector(s), sk = app.sketch;
  if (sk.kind === "extrusion") {
    for (const [id, k] of [["#ckStart", "start"], ["#ckEnd", "end"]]) $(id).onchange = e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) sk[k] = v; else { app.toast("Type a distance in mm.", true); renderProps(); } };
    $("#ckVoid").onchange = e => { sk.isVoid = e.target.value === "void"; renderProps(); };
    $("#ckMat").onchange = e => { sk.material = e.target.value; };
    return;
  }
  $("#ckProf").onchange = e => { sk.profileId = e.target.value; renderProps(); };
  const w = $("#ckW"); if (w) w.onchange = e => { const v = parseFloat(e.target.value); if (v >= 5) sk.rectW = v; };
  const h = $("#ckH"); if (h) h.onchange = e => { const v = parseFloat(e.target.value); if (v >= 5) sk.rectH = v; };
  $("#ckFlip").onchange = e => { sk.flip = e.target.checked; };
  $("#ckMat").onchange = e => { sk.material = e.target.value; };
}
void levelLabel;
