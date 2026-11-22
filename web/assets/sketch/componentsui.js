// In-place components in the workspace: Extrusion / Sweep (solid or void) in sketch mode, Wall Sweep and
// Wall Reveal, Parapet, Reference Planes; their plan, 3D and Properties.
import * as G from "./geom.js";
import * as C from "./components.js";
import * as S from "./solids.js";
import { checkSketch, floorParts } from "./floors.js";
import { makeLine, makeArc } from "./elements.js";
import { COLORS } from "./plan.js";
import { newId, levelLabel } from "./model.js";
import { makeWall, wallHeights, checkWall, wallType } from "./walls.js";
import * as LV from "./levels.js";

const REF_COLOR = "#4ade80";
export const SKETCH_TITLES = { floor: "Modify | Create Floor Boundary", extrusion: "Modify | Create Extrusion", sweep: "Modify | Sweep > Path" };

// --------------------------------------------------------------------------- sketch mode for components
export function startComponentSketch(app, kind, opts = {}) {
  if (app.sketch) { app.toast("Finish or cancel the sketch you are in first."); return; }
  const comp = opts.editId && app.doc.components.find(c => c.id === opts.editId);
  const p = app.prefs[kind] || {};
  app.sketch = {
    id: newId("sk"), kind, levelId: comp ? comp.levelId : app.levelId, editId: comp?.id || null, bad: new Set(), message: "",
    isVoid: comp ? comp.isVoid : !!opts.isVoid,
    start: comp?.start ?? p.start ?? 0, end: comp?.end ?? p.end ?? 1000, material: comp?.material || p.material || (kind === "sweep" ? "#d9d4ca" : "#c8c2b6"),
    height: comp?.height ?? p.height ?? 0, profileId: comp?.profileId || p.profileId || "pf-cornice", rectW: comp?.rectW ?? p.rectW ?? 100, rectH: comp?.rectH ?? p.rectH ?? 100, flip: comp?.flip ?? false,
  };
  if (comp) {
    if (comp.levelId !== app.levelId) app.setLevel(comp.levelId);
    const curves = kind === "sweep" ? comp.path : comp.boundary;
    app.commit("Edit sketch", doc => {
      for (const c of curves) { const l = c.shape === "arc" ? makeArc("sketch", comp.levelId, "sketch", c) : makeLine("sketch", comp.levelId, "sketch", c.a, c.b); l.sketchId = app.sketch.id; doc.lines.push(l); }
    });
  }
  app.selection.clear();
  app.prefs.boundary = { ...(app.prefs.boundary || {}), mode: kind === "sweep" ? "line" : (app.prefs.boundary?.mode || "line") };
  app.setTool("boundary");
  app.sketchChanged();
}

export async function finishComponentSketch(app, ui) {
  const sk = app.sketch;
  const lines = app.doc.lines.filter(l => l.kind === "sketch" && l.sketchId === sk.id);
  const curves = lines.map(l => (l.shape === "arc" ? { shape: "arc", c: l.c, r: l.r, start: l.start, sweep: l.sweep } : { shape: "line", a: l.a, b: l.b }));
  let error = "";
  if (sk.kind === "extrusion") { const r = checkSketch(curves); if (!r.ok) { error = r.message; sk.bad = new Set(r.bad.map(i => lines[i].id)); } }
  else { try { C.chainPath(curves); } catch (e) { error = e.message; sk.bad = new Set(lines.map(l => l.id)); } }
  if (!error && sk.kind === "extrusion" && Math.abs(sk.end - sk.start) < 1) error = "Extrusion Start and End must differ.";
  if (error) {
    sk.message = error; app.redraw();
    ui.openDialog(`<h3>Cannot finish</h3><p>${ui.esc(error)}</p><div class="actions"><button class="btn primary" type="button" id="fOk">Continue sketching</button></div>`, d => { d.querySelector("#fOk").onclick = ui.closeDialog; });
    return;
  }
  const ids = new Set(lines.map(l => l.id));
  const id = app.commit(sk.kind === "extrusion" ? (sk.isVoid ? "Void extrusion" : "Extrusion") : (sk.isVoid ? "Void sweep" : "Sweep"), doc => {
    doc.lines = doc.lines.filter(l => !ids.has(l.id));
    const fields = sk.kind === "extrusion"
      ? { levelId: sk.levelId, start: sk.start, end: sk.end, boundary: curves, material: sk.material, isVoid: sk.isVoid }
      : { levelId: sk.levelId, height: sk.height, path: curves, profileId: sk.profileId, rectW: sk.rectW, rectH: sk.rectH, flip: sk.flip, material: sk.material, isVoid: sk.isVoid };
    let c = sk.editId && doc.components.find(x => x.id === sk.editId);
    if (c) Object.assign(c, fields);
    else { c = sk.kind === "extrusion" ? C.makeExtrusion(doc, fields) : C.makeSweep(doc, fields); doc.components.push(c); }
    return c.id;
  });
  if (!id) return;
  app.sketch = null; app.setTool("select"); app.selection.clear(); app.selection.add(id); app.sketchChanged();
}

export function componentSketchProps(app, esc) {
  const sk = app.sketch, doc = app.doc;
  const lv = doc.levels.find(l => l.id === sk.levelId);
  const common = `<div class="prow"><span>Solid / Void</span><select id="ckVoid"><option value="solid"${sk.isVoid ? "" : " selected"}>Solid</option><option value="void"${sk.isVoid ? " selected" : ""}>Void (cuts walls and floors)</option></select></div>
    <div class="prow"><span>Material</span><input id="ckMat" type="color" value="${sk.material}"${sk.isVoid ? " disabled" : ""}></div>
    <div class="prow"><span>Work Plane</span><input readonly value="Level : ${esc(lv?.name || "")}"></div>`;
  if (sk.kind === "extrusion") return `<div class="ptype"><div class="row"><span>${sk.isVoid ? "Void Extrusion" : "Extrusion"}</span><span>Sketch mode</span></div></div>
    <div class="pgroup">Constraints</div>
    <div class="prow"><span>Extrusion Start</span><input id="ckStart" type="number" step="50" value="${sk.start}"></div>
    <div class="prow"><span>Extrusion End</span><input id="ckEnd" type="number" step="50" value="${sk.end}"></div>
    ${common}
    <div class="pnote">Draw the profile as closed loops on the level (an inner loop is a hole), set Start and End in mm from the level, then choose Finish Edit Mode.${sk.message ? `<br><span style="color:#ff8a8d">${esc(sk.message)}</span>` : ""}</div>`;
  const profiles = C.defaultProfiles().concat(doc.profiles || []);
  return `<div class="ptype"><div class="row"><span>${sk.isVoid ? "Void Sweep" : "Sweep"}</span><span>Sketch mode</span></div></div>
    <div class="pgroup">Profile</div>
    <div class="prow"><span>Profile</span><select id="ckProf">${profiles.map(p => `<option value="${esc(p.id)}"${p.id === sk.profileId ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
    ${profiles.find(p => p.id === sk.profileId)?.rect ? `<div class="prow"><span>Width</span><input id="ckW" type="number" step="10" min="5" value="${sk.rectW}"></div><div class="prow"><span>Height</span><input id="ckH" type="number" step="10" min="5" value="${sk.rectH}"></div>` : ""}
    <div class="prow"><span>Flip profile</span><input id="ckFlip" type="checkbox"${sk.flip ? " checked" : ""}></div>
    <div class="pgroup">Constraints</div>
    <div class="prow"><span>Height above level</span><input id="ckHt" type="number" step="50" value="${sk.height}"></div>
    ${common}
    <div class="pnote">Draw or pick the path (one chain of lines and arcs; Pick Walls follows a wall face), choose the profile, then Finish Edit Mode. The profile stands out to the left of the path; tick Flip for the other side.${sk.message ? `<br><span style="color:#ff8a8d">${esc(sk.message)}</span>` : ""}</div>`;
}

export function wireComponentSketchProps(app, rerender) {
  const $ = s => document.querySelector(s), sk = app.sketch;
  const save = () => { app.prefs[sk.kind] = { start: sk.start, end: sk.end, material: sk.material, height: sk.height, profileId: sk.profileId, rectW: sk.rectW, rectH: sk.rectH }; app.savePrefs(); };
  const num = (id, k) => { const el = $(id); if (el) el.onchange = () => { const v = parseFloat(el.value); if (Number.isFinite(v)) { sk[k] = v; save(); } }; };
  num("#ckStart", "start"); num("#ckEnd", "end"); num("#ckHt", "height"); num("#ckW", "rectW"); num("#ckH", "rectH");
  $("#ckVoid").onchange = e => { sk.isVoid = e.target.value === "void"; rerender(); app.sketchChanged(); };
  $("#ckMat").onchange = e => { sk.material = e.target.value; save(); };
  const pr = $("#ckProf"); if (pr) pr.onchange = e => { sk.profileId = e.target.value; save(); rerender(); };
  const fl = $("#ckFlip"); if (fl) fl.onchange = e => { sk.flip = e.target.checked; };
}

// --------------------------------------------------------------------------- plan
const ext = (pts, closed) => (closed ? [...pts, pts[0]] : pts);
function drawPoly(view, pts, color, px = 1, dash) { for (let i = 0; i < pts.length - 1; i++) view.segment(pts[i], pts[i + 1], color, px, dash); }

/** Plan outline of a swept band: the path offset to the profile's two sides. */
function bandOutline(view, pts, closed, prof, color, dash) {
  const xs = prof.map(p => p.x), lo = Math.min(...xs), hi = Math.max(...xs);
  for (const x of [lo, hi]) {
    const rings = S.sweepRings(pts, 0, [{ x, y: 0 }], closed);
    drawPoly(view, rings.map(r => r[0]), color, 1, dash);
  }
  if (!closed) for (const i of [0, pts.length - 1]) { const r = S.sweepRings(pts, 0, [{ x: lo, y: 0 }, { x: hi, y: 0 }], false)[i]; view.segment(r[0], r[1], color, 1, dash); }
}

export function drawComponents(view, app) {
  const doc = app.doc;
  for (const c of doc.components) {
    if (c.id === app.sketch?.editId) continue;
    const sel = app.selection.has(c.id), hov = app.hoverId === c.id;
    const base = c.isVoid || c.reveal ? "#ff8a8d" : "#bdb7aa";
    const col = sel ? COLORS.sel : hov ? COLORS.hover : base, dash = c.isVoid || c.reveal ? [6, 4] : null;
    try {
      if (c.kind === "extrusion" && c.levelId === app.levelId) {
        const r = checkSketch(c.boundary); if (r.ok) for (const l of r.loops) view.polygon(l, sel ? "rgba(59,130,246,.12)" : null, null), drawPoly(view, ext(l, true), col, sel ? 2 : 1, dash);
      } else if (c.kind === "sweep" && c.levelId === app.levelId) {
        const g = C.sweepGeometry(doc, c); bandOutline(view, g.pts, g.closed, g.prof, col, dash);
      } else if (c.kind === "wallSweep") {
        const w0 = doc.walls.find(w => w.id === c.wallIds[0]); if (!w0 || w0.baseLevelId !== app.levelId) continue;
        if (c.reveal) { for (const p of C.wallSweepPaths(doc, c)) drawPoly(view, ext(p.pts, p.closed), col, 1, [6, 4]); }
        else for (const g of C.wallSweepGeometry(doc, c)) bandOutline(view, g.pts, g.closed, g.prof, col, dash);
      }
    } catch { /* an incomplete component draws nothing */ }
  }
}

export function drawRefPlanes(view, app) {
  for (const rp of app.doc.referencePlanes) {
    const sel = app.selection.has(rp.id), hov = app.hoverId === rp.id;
    const u = G.norm(G.sub(rp.b, rp.a)), extra = view.px(30);
    const a = G.sub(rp.a, G.mul(u, extra)), b = G.add(rp.b, G.mul(u, extra));
    view.segment(a, b, sel ? COLORS.sel : hov ? COLORS.hover : REF_COLOR, sel ? 1.6 : 1, [12, 4, 2, 4]);
    if (rp.name) view.label(b, rp.name, { color: REF_COLOR, ang: G.angleOf(u), offsetPx: 10, size: 11 });
  }
}

export function componentsAt(app, p, tol) {
  const doc = app.doc, out = [];
  for (const rp of doc.referencePlanes) { const d = G.projectOnSegment(p, rp.a, rp.b).dist; if (d <= tol) out.push({ id: rp.id, d: d + 0.3 }); }
  for (const c of doc.components) {
    try {
      let d = Infinity;
      if (c.kind === "extrusion" && c.levelId === app.levelId) {
        const r = checkSketch(c.boundary); if (!r.ok) continue;
        for (const l of r.loops) { if (G.pointInPolygon(p, l)) d = Math.min(d, tol * 0.9); l.forEach((q, i) => { d = Math.min(d, G.projectOnSegment(p, q, l[(i + 1) % l.length]).dist); }); }
      } else if (c.kind === "sweep" && c.levelId === app.levelId) {
        const g = C.sweepGeometry(doc, c), half = Math.max(...g.prof.map(q => Math.abs(q.x)));
        const pts = ext(g.pts, g.closed); for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, Math.max(0, G.projectOnSegment(p, pts[i], pts[i + 1]).dist - half));
      } else if (c.kind === "wallSweep") {
        const w0 = doc.walls.find(w => w.id === c.wallIds[0]); if (!w0 || w0.baseLevelId !== app.levelId) continue;
        for (const path of C.wallSweepPaths(doc, c)) { const pts = ext(path.pts, path.closed); for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, G.projectOnSegment(p, pts[i], pts[i + 1]).dist); }
      }
      if (d <= tol) out.push({ id: c.id, d: d + 0.25 });
    } catch { /* skip */ }
  }
  return out;
}

// --------------------------------------------------------------------------- cutting walls and floors
/** Walls cut by reveals and void extrusions (3D). */
export function cutWallSolids(doc, w, solids) {
  let out = solids;
  for (const r of C.revealsFor(doc, w)) out = S.applyReveal(out, r);
  const voids = C.voidCutters(doc);
  if (voids.length) out = S.applyVoids(out, voids);
  return out;
}

/** Wall plan pieces cut at the cut plane by voids and reveals there. */
export function cutWallPlan(doc, w, pieces, cutZ) {
  let out = pieces;
  for (const r of C.revealsFor(doc, w)) if (r.z0 <= cutZ && r.z1 >= cutZ) out = out.map(p => S.clipHalf(p, r.origin, r.n, r.max)).filter(Boolean);
  for (const v of C.voidCutters(doc)) if (v.z0 <= cutZ && v.z1 >= cutZ) for (const vp of v.polys) out = S.subtractPolygon(out, vp);
  return out;
}

/** Voids that pass right through a floor and lie inside it become holes. */
export function floorVoidHoles(doc, part, top, bottom) {
  return C.voidCutters(doc).filter(v => v.z0 <= bottom + 0.5 && v.z1 >= top - 0.5).flatMap(v => v.polys).filter(vp => vp.every(q => G.pointInPolygon(q, part.outer)));
}

// --------------------------------------------------------------------------- 3D
function sweepMesh(THREE, rings, closed, prof) {
  const pos = [], idx = [], m = prof.length;
  const V = q => [q.x / 1000, q.z / 1000, -q.y / 1000];
  rings.forEach(r => r.forEach(q => pos.push(...V(q))));
  for (let i = 0; i < rings.length - 1; i++) for (let k = 0; k < m; k++) {
    const a = i * m + k, b = i * m + ((k + 1) % m), c = (i + 1) * m + k, d = (i + 1) * m + ((k + 1) % m);
    idx.push(a, c, b, b, c, d);
  }
  if (!closed) {
    const tris = THREE.ShapeUtils.triangulateShape(prof.map(p => new THREE.Vector2(p.x, p.y)), []);
    const last = (rings.length - 1) * m;
    for (const [a, b, c] of tris) { idx.push(a, c, b); idx.push(last + a, last + b, last + c); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

export function buildComponents3D(group, THREE, app, visible) {
  const doc = app.doc, style = app.prefs.visual || "shaded";
  const mat = (hex, sel) => style === "hidden" ? new THREE.MeshBasicMaterial({ color: 0xf2f2f2, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
    : style === "consistent" ? new THREE.MeshBasicMaterial({ color: sel ? 0x3b82f6 : new THREE.Color(hex), side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ color: sel ? 0x3b82f6 : new THREE.Color(hex), roughness: 0.85, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const edgeCol = style === "hidden" ? 0x111111 : style === "wire" ? 0xe8e8ec : 0x1b1b20;
  const add = (geo, c) => {
    if (style !== "wire") { const m = new THREE.Mesh(geo, mat(c.material || "#cccccc", app.selection.has(c.id))); m.userData.id = c.id; m.castShadow = m.receiveShadow = style === "realistic"; group.add(m); }
    group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: app.selection.has(c.id) && style === "wire" ? 0x3b82f6 : edgeCol })));
  };
  for (const c of doc.components) {
    if (c.isVoid || c.reveal || c.id === app.sketch?.editId) continue;
    try {
      if (c.kind === "extrusion") {
        if (visible && !visible.has(c.levelId)) continue;
        const r = checkSketch(c.boundary); if (!r.ok) continue;
        const { z0, z1 } = C.extrusionRange(doc, c);
        for (const part of floorParts(r.loops)) {
          const shape = new THREE.Shape(part.outer.map(p => new THREE.Vector2(p.x / 1000, p.y / 1000)));
          for (const h of part.holes) shape.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p.x / 1000, p.y / 1000))));
          const geo = new THREE.ExtrudeGeometry(shape, { depth: (z1 - z0) / 1000, bevelEnabled: false });
          geo.rotateX(-Math.PI / 2); geo.translate(0, z0 / 1000, 0);
          add(geo, c);
        }
      } else if (c.kind === "sweep") {
        if (visible && !visible.has(c.levelId)) continue;
        const g = C.sweepGeometry(doc, c); add(sweepMesh(THREE, g.rings, g.closed, g.prof), c);
      } else if (c.kind === "wallSweep") {
        const w0 = doc.walls.find(w => w.id === c.wallIds[0]); if (!w0 || (visible && !visible.has(w0.baseLevelId))) continue;
        for (const g of C.wallSweepGeometry(doc, c)) add(sweepMesh(THREE, g.rings, g.closed, g.prof), c);
      }
    } catch { /* incomplete */ }
  }
}

// --------------------------------------------------------------------------- tools and dialogs
/** Ref Plane (RP): two clicks. */
export class RefPlaneTool {
  constructor(app) { this.app = app; this.name = "refPlane"; this.title = "Reference Plane"; this.pts = []; this.cursor = null; this.wantsSnap = true; }
  options() { return [{ type: "text", text: "Reference Plane", cls: "modename" }, { type: "text", text: "Reference planes show on every plan; use them to line things up and as snap guides." }]; }
  prompt() { return this.pts.length ? "Click the end of the reference plane." : "Click the start of the reference plane."; }
  hasFrom() { return this.pts.length > 0; }
  constrainFrom() { return this.pts[0] || null; }
  move(c) { this.cursor = c.pt; this.app.redraw(); }
  down(c) {
    if (!this.pts.length) { this.pts.push(c.pt); this.app.toolChanged(); return; }
    if (G.dist(this.pts[0], c.pt) < 10) return;
    const a = this.pts[0], b = c.pt; this.pts = [];
    this.app.commit("Reference plane", doc => { doc.referencePlanes.push(C.makeRefPlane(a, b, `RP ${doc.referencePlanes.length + 1}`)); });
    this.app.toolChanged();
  }
  typed(v) { if (!this.pts.length || !(v > 0)) return false; const from = this.pts[0], cur = this.cursor || G.add(from, { x: 1, y: 0 }); this.down({ pt: G.add(from, G.mul(G.norm(G.sub(cur, from)), v)) }); return true; }
  escape() { if (this.pts.length) { this.pts = []; this.app.toolChanged(); return true; } return false; }
  drawPreview(view) { if (this.pts.length && this.cursor) { view.segment(this.pts[0], this.cursor, REF_COLOR, 1, [12, 4, 2, 4]); view.tempDim(this.pts[0], this.cursor, String(Math.round(G.dist(this.pts[0], this.cursor)))); } }
}

export function modelInPlaceDialog(app, ui) {
  ui.openDialog(`<h3>Model In-Place</h3><p>Choose what to make. Solid adds to the model; Void cuts walls and floors it passes through.</p>
    <div class="list">
      <button type="button" data-k="extrusion"><span>Extrusion</span><small>a closed profile pushed up from the level</small></button>
      <button type="button" data-k="sweep"><span>Sweep</span><small>a profile run along a path (bands, copings, cornices)</small></button>
      <button type="button" data-k="vextrusion"><span>Void Extrusion</span><small>cuts a hole or niche through walls and floors</small></button>
      <button type="button" data-k="vsweep"><span>Void Sweep</span><small>a profile cut along a path (shown, not yet cutting)</small></button>
    </div><div class="actions"><button class="btn" type="button" id="mCancel">Cancel</button></div>`, d => {
    d.querySelector("#mCancel").onclick = ui.closeDialog;
    d.querySelectorAll("[data-k]").forEach(b => b.onclick = () => {
      ui.closeDialog();
      const k = b.dataset.k;
      startComponentSketch(app, k.includes("extrusion") ? "extrusion" : "sweep", { isVoid: k.startsWith("v") });
    });
  });
}

/** Wall Sweep / Wall Reveal on the selected walls. */
export function wallSweepDialog(app, ui, reveal) {
  const ids = [...app.selection].filter(id => app.isWall(id));
  if (!ids.length) { app.toast(`Select the walls first, then choose Wall ${reveal ? "Reveal" : "Sweep"}.`); return; }
  const p = app.prefs[reveal ? "reveal" : "wallSweep"] || {};
  const profiles = C.defaultProfiles().filter(x => !x.centred);
  ui.openDialog(`<h3>Wall ${reveal ? "Reveal" : "Sweep"}</h3><p>${reveal ? "Cuts a horizontal groove into" : "Runs a horizontal band along"} the ${ids.length} selected wall${ids.length > 1 ? "s" : ""}, turning corners where they meet.</p>
    <table>
      <tr><td>Profile</td><td><select id="wProf">${profiles.map(x => `<option value="${x.id}"${x.id === (p.profileId || (reveal ? "pf-rect" : "pf-plinth")) ? " selected" : ""}>${ui.esc(x.name)}</option>`).join("")}</select></td></tr>
      <tr><td>${reveal ? "Depth" : "Width"} x Height (rectangle)</td><td><input id="wW" type="number" min="5" step="5" value="${p.rectW ?? (reveal ? 20 : 50)}" style="width:45%"> x <input id="wH" type="number" min="5" step="5" value="${p.rectH ?? 50}" style="width:45%"></td></tr>
      <tr><td>Face</td><td><select id="wSide"><option value="exterior">Exterior</option><option value="interior"${p.side === "interior" ? " selected" : ""}>Interior</option></select></td></tr>
      <tr><td>Measured from</td><td><select id="wFrom"><option value="base">Base</option><option value="top"${p.from === "top" ? " selected" : ""}>Top</option></select></td></tr>
      <tr><td>Distance (mm)</td><td><input id="wDist" type="number" step="50" value="${p.distance ?? (reveal ? 1200 : 0)}"></td></tr>
      ${reveal ? "" : `<tr><td>Offset From Wall (mm)</td><td><input id="wOff" type="number" step="5" value="${p.offset ?? 0}"></td></tr>`}
    </table><div id="wErr"></div>
    <div class="actions"><button class="btn" type="button" id="wCancel">Cancel</button><button class="btn primary" type="button" id="wOk">Add ${reveal ? "reveal" : "sweep"}</button></div>`, d => {
    d.querySelector("#wCancel").onclick = ui.closeDialog;
    d.querySelector("#wOk").onclick = () => {
      const v = { profileId: d.querySelector("#wProf").value, rectW: parseFloat(d.querySelector("#wW").value) || 20, rectH: parseFloat(d.querySelector("#wH").value) || 50, side: d.querySelector("#wSide").value, from: d.querySelector("#wFrom").value, distance: parseFloat(d.querySelector("#wDist").value) || 0, offset: reveal ? 0 : (parseFloat(d.querySelector("#wOff").value) || 0) };
      app.prefs[reveal ? "reveal" : "wallSweep"] = v; app.savePrefs();
      try {
        app.history.transact(reveal ? "Wall reveal" : "Wall sweep", doc => {
          const c = C.makeWallSweep(doc, { ...v, reveal, wallIds: ids });
          if (reveal) {
            const prof = C.profilePts(doc, c), depth = Math.max(...prof.map(q => q.x)) - Math.min(...prof.map(q => q.x));
            for (const id of ids) { const w = doc.walls.find(x => x.id === id); if (depth >= wallType(doc, w).thickness - 10) throw new Error("The reveal is deeper than the wall."); }
          }
          doc.components.push(c);
        });
        ui.closeDialog();
      } catch (e) { d.querySelector("#wErr").innerHTML = `<div class="err">${ui.esc(e.message)}</div>`; }
    };
  });
}

/** Parapet on the selected walls: walls on top, flush with their outer faces, with a coping sweep. */
export function parapetDialog(app, ui) {
  const ids = [...app.selection].filter(id => app.isWall(id));
  if (!ids.length) { app.toast("Select the outer walls the parapet stands on, then choose Parapet."); return; }
  const p = app.prefs.parapet || {};
  ui.openDialog(`<h3>Parapet</h3><p>Adds a parapet on top of the ${ids.length} selected wall${ids.length > 1 ? "s" : ""}, flush with their outside faces, with a coping on top.</p>
    <table><tr><td>Height (mm)</td><td><input id="pH" type="number" min="100" step="50" value="${p.height ?? 900}"></td></tr>
    <tr><td>Thickness (mm)</td><td><input id="pT" type="number" min="100" step="5" value="${p.thickness ?? 225}"></td></tr>
    <tr><td>Coping 300 x 75 with drip</td><td><input id="pC" type="checkbox"${p.coping === false ? "" : " checked"}></td></tr></table>
    <div id="pErr"></div><div class="actions"><button class="btn" type="button" id="pCancel">Cancel</button><button class="btn primary" type="button" id="pOk">Add parapet</button></div>`, d => {
    d.querySelector("#pCancel").onclick = ui.closeDialog;
    d.querySelector("#pOk").onclick = () => {
      const H = parseFloat(d.querySelector("#pH").value), T = parseFloat(d.querySelector("#pT").value), coping = d.querySelector("#pC").checked;
      if (!(H >= 100) || !(T >= 100)) { d.querySelector("#pErr").innerHTML = `<div class="err">Height and thickness must be at least 100 mm.</div>`; return; }
      app.prefs.parapet = { height: H, thickness: T, coping }; app.savePrefs();
      try { app.history.transact("Parapet", doc => addParapet(doc, ids, H, T, coping)); ui.closeDialog(); app.toast("Parapet added."); }
      catch (e) { d.querySelector("#pErr").innerHTML = `<div class="err">${ui.esc(e.message)}</div>`; }
    };
  });
}

export function addParapet(doc, wallIds, H, T, coping = true) {
  let type = doc.wallTypes.find(t => t.function === "exterior" && t.thickness === T && /parapet/i.test(t.name));
  if (!type) { type = { id: newId("wt"), name: `Parapet - ${T} mm`, thickness: T, core: T, function: "exterior", color: "#d9d4ca" }; doc.wallTypes.push(type); }
  const paths = C.wallSweepPaths(doc, C.makeWallSweep(doc, { wallIds, side: "exterior", offset: 0, from: "top", distance: 0 }));
  const made = [];
  for (const path of paths) {
    const src = doc.walls.find(w => w.id === wallIds[0]);
    const lv = LV.sorted(doc), z = path.z;
    // base the parapet on the highest level at or below the wall top
    const base = [...lv].reverse().find(l => l.elevation <= z + 0.5) || lv[0];
    const n = path.pts.length, segs = path.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = path.pts[i], b = path.pts[(i + 1) % n];
      const w = makeWall(doc, { a, b, typeId: type.id, locationLine: "finish-ext", baseLevelId: base.id, baseOffset: z - base.elevation, unconnectedHeight: H, flipped: !path.outIsLeft });
      checkWall(doc, w); doc.walls.push(w); made.push(w.id);
    }
    if (coping) {
      // coping centred on the parapet: the outer face path moved in by half the thickness
      const inward = path.outIsLeft ? -1 : 1;
      const ring = S.sweepRings(path.pts, 0, [{ x: inward * T / 2, y: 0 }], path.closed).map(r => ({ x: r[0].x, y: r[0].y }));
      if (path.closed) ring.pop();
      const curves = ring.slice(0, path.closed ? ring.length : ring.length - 1).map((p, i) => ({ shape: "line", a: p, b: ring[(i + 1) % ring.length] }));
      doc.components.push(C.makeSweep(doc, { levelId: base.id, height: z - base.elevation + H, path: curves, profileId: "pf-coping", material: "#c9c4b8", name: "Coping" }));
    }
  }
  if (!made.length) throw new Error("Select straight walls for the parapet.");
  LV.checkLevels(doc);
  return made;
}

export function componentProps(app, ids, esc) {
  const doc = app.doc, cs = ids.map(id => doc.components.find(c => c.id === id) || doc.referencePlanes.find(r => r.id === id));
  if (cs.length !== 1) return `<div class="pnote">${cs.length} components selected.</div>`;
  const c = cs[0];
  if (!c.kind) return `<div class="ptype"><div class="row"><span>Reference Plane</span></div></div><div class="prow"><span>Name</span><input id="cName" value="${esc(c.name || "")}" maxlength="40"></div><div class="prow"><span>Length</span><input readonly value="${Math.round(G.dist(c.a, c.b))}"></div>`;
  const lv = doc.levels.find(l => l.id === c.levelId);
  if (c.kind === "extrusion") return `<div class="ptype"><div class="row"><span>${c.isVoid ? "Void Extrusion" : "Extrusion"}</span><button class="btn" type="button" id="cEdit">Edit</button></div></div>
    <div class="pgroup">Constraints</div><div class="prow"><span>Work Plane</span><input readonly value="Level : ${esc(lv?.name || "")}"></div>
    <div class="prow"><span>Extrusion Start</span><input id="cStart" type="number" step="50" value="${c.start}"></div><div class="prow"><span>Extrusion End</span><input id="cEnd" type="number" step="50" value="${c.end}"></div>
    ${c.isVoid ? "" : `<div class="prow"><span>Material</span><input id="cMat" type="color" value="${c.material}"></div>`}<div class="pnote">Double-click to edit the profile.</div>`;
  if (c.kind === "sweep") return `<div class="ptype"><div class="row"><span>${c.name || "Sweep"}</span><button class="btn" type="button" id="cEdit">Edit path</button></div></div>
    <div class="prow"><span>Profile</span><select id="cProf">${C.defaultProfiles().map(p => `<option value="${p.id}"${p.id === c.profileId ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
    <div class="prow"><span>Height above level</span><input id="cHt" type="number" step="50" value="${c.height}"></div>
    <div class="prow"><span>Flip profile</span><input id="cFlip" type="checkbox"${c.flip ? " checked" : ""}></div>
    ${c.isVoid ? "" : `<div class="prow"><span>Material</span><input id="cMat" type="color" value="${c.material}"></div>`}`;
  return `<div class="ptype"><div class="row"><span>Wall ${c.reveal ? "Reveal" : "Sweep"}</span><span>${c.wallIds.length} wall${c.wallIds.length > 1 ? "s" : ""}</span></div></div>
    <div class="prow"><span>Face</span><select id="cSide"><option value="exterior">Exterior</option><option value="interior"${c.side === "interior" ? " selected" : ""}>Interior</option></select></div>
    <div class="prow"><span>Measured from</span><select id="cFrom"><option value="base">Base</option><option value="top"${c.from === "top" ? " selected" : ""}>Top</option></select></div>
    <div class="prow"><span>Distance</span><input id="cDist" type="number" step="50" value="${c.distance}"></div>
    ${c.reveal ? "" : `<div class="prow"><span>Offset From Wall</span><input id="cOff" type="number" step="5" value="${c.offset}"></div>`}`;
}

export function wireComponentProps(app, ids, renderProps) {
  const $ = s => document.querySelector(s), id = ids[0];
  const edit = (label, fn) => app.commit(label, doc => fn(doc.components.find(c => c.id === id) || doc.referencePlanes.find(r => r.id === id))) === undefined && renderProps();
  const num = (sel, k) => { const el = $(sel); if (el) el.onchange = () => { const v = parseFloat(el.value); if (Number.isFinite(v)) edit("Edit component", c => { c[k] = v; }); }; };
  num("#cStart", "start"); num("#cEnd", "end"); num("#cHt", "height"); num("#cDist", "distance"); num("#cOff", "offset");
  const set = (sel, k, f = x => x) => { const el = $(sel); if (el) el.onchange = () => edit("Edit component", c => { c[k] = f(el.type === "checkbox" ? el.checked : el.value); }); };
  set("#cMat", "material"); set("#cProf", "profileId"); set("#cFlip", "flip"); set("#cSide", "side"); set("#cFrom", "from"); set("#cName", "name", v => String(v).slice(0, 40));
  const e = $("#cEdit"); if (e) e.onclick = () => { const c = app.doc.components.find(x => x.id === id); startComponentSketch(app, c.kind, { editId: id }); };
}

export function workPlaneDialog(app, ui) {
  const L = LV.sorted(app.doc), cur = app.sketch?.levelId || app.levelId;
  ui.openDialog(`<h3>Work Plane</h3><p>Extrusions and sweeps are drawn on a level and measured from it. Vertical work planes (a reference plane or a wall face) need an elevation or section view to draw in; they come with those views in phase 8.</p>
    <div class="list">${L.map(l => `<button type="button" data-l="${l.id}"><span>Level : ${ui.esc(l.name)}${l.id === cur ? " (current)" : ""}</span><small>${levelLabel(l.elevation)}</small></button>`).join("")}</div>
    <div class="actions"><button class="btn" type="button" id="wpClose">Close</button></div>`, d => {
    d.querySelector("#wpClose").onclick = ui.closeDialog;
    d.querySelectorAll("[data-l]").forEach(b => b.onclick = () => {
      ui.closeDialog();
      if (app.sketch) { app.sketch.levelId = b.dataset.l; app.sketchChanged(); app.toast(`Work plane: ${app.doc.levels.find(l => l.id === b.dataset.l).name}. Start and End are measured from it.`); }
      else app.setLevel(b.dataset.l);
    });
  });
}
