// Ollic Sketch workspace: wires the model, the views, the tools and the panels together.
import { newProject, normalize, findById, levelLabel } from "./model.js";
import { History } from "./history.js";
import * as G from "./geom.js";
import { findSnap, OVERRIDES, SNAP_KINDS } from "./snaps.js";
import { planCurves, linesInPlan, inRect, distanceTo, LINE_STYLES, lineLength, setLineLength, bbox, unionBox, translate as translateEl } from "./elements.js";
import { PlanView } from "./plan.js";
import { View3D } from "./view3d.js";
import { SelectTool, LineTool } from "./tools.js";
import { WallTool, drawWalls, drawUnderlay, drawWallDims, buildWalls3D, wallProps, wireWallProps, wallTypeDialog, levelsDialog, copyToLevelsDialog } from "./wallsui.js";
import { wallFootprints, outlineEdges, locationPolyline, checkWall } from "./walls.js";
import * as LV from "./levels.js";
import { MoveTool, RotateTool, MirrorTool, ScaleTool, ArrayTool, OffsetTool, TrimTool, SplitTool, AlignTool, CornerTool } from "./modifytools.js";
import { enforceLocks, moveOpening, translation, canTransform } from "./modify.js";
import { OpeningTool, drawOpenings, drawOpeningDims, openingsAt, buildOpenings3D, openingProps, wireOpeningProps, scheduleDialog, tagOpenings } from "./openingsui.js";
import * as OP from "./openings.js";
import { startFloorSketch, cancelSketch, finishSketch, BoundaryTool, drawFloors, floorsAt, buildFloors3D, floorProps, wireFloorProps, sketchProps, wireSketchProps, attachTopDialog } from "./floorsui.js";
import { floorLoops, floorParts, curvePoints as curvePts } from "./floors.js";
import { SKETCH_TITLES, startComponentSketch, finishComponentSketch, componentSketchProps, wireComponentSketchProps, drawComponents, drawRefPlanes, componentsAt, cutWallSolids, cutWallPlan, floorVoidHoles, buildComponents3D, RefPlaneTool, modelInPlaceDialog, wallSweepDialog, parapetDialog, componentProps, wireComponentProps, workPlaneDialog } from "./componentsui.js";
import { checkSketch } from "./floors.js";
import { chainPath as sweepChain, sweepPlanStrip } from "./components.js";
import { Store, readLocal, readPrefs, writePrefs } from "./store.js";
import { startRoofSketch, finishRoofSketch, RoofBoundaryTool, SlopeArrowTool, RoofExtrusionTool, drawRoofs, roofsAt, buildRoofs3D, cutWallsByRoof, slopedPrismGeometry, roofSketchProps, wireRoofSketchProps, roofLineProps, wireRoofLineProps, roofProps, wireRoofProps, editRoof, roofOnPlan, drawRoofSketchMarks } from "./roofsui.js";
import { roofGeometry } from "./roofs.js";
import { DimensionTool, TextTool, drawAnnotations, annotationsAt, annotationBox, annotationProps, wireAnnotationProps } from "./annotate.js";
import { ElevationView, ELEVATIONS, modelBoxMm, applySectionBox } from "./views.js";
import { planSheet, pdfFromCanvas, planDxf, modelGlb, download, safeName, choosePaper, planBox } from "./exports.js";
import * as THREE from "three";
import { ElevSketchTool, drawElevSketch } from "./elevsketch.js";
import { icon } from "./icons.js";

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// --------------------------------------------------------------------------- app state
const app = {
  doc: newProject(),
  levelId: "lv-1",
  selection: new Set(),
  hoverId: null, hoverList: [], hoverIdx: 0,
  snap: null, rubber: null, dragGrip: null, excludeFromSnap: null,
  snapsEnabled: new Set(SNAP_KINDS), snapOverride: null,
  prefs: readPrefs(),
  typed: "",
  lastTool: null,
};
app.history = new History(app.doc);
if (Array.isArray(app.prefs.snaps)) app.snapsEnabled = new Set(app.prefs.snaps);

app.savePrefs = () => writePrefs(app.prefs);
app.lookup = id => findById(app.doc, id)?.el || null;
app.levelName = () => app.doc.levels.find(l => l.id === app.levelId)?.name || "Level";
app.geomVer = 0;
app.redraw = (with3d = false) => { if (with3d) app.geomVer++; app.plan.invalidate(); app.elev?.invalidateOverlay(); if (with3d) { app.view3d.invalidate(); app.elev?.invalidate(); } };
app.drawElevSketch = (ctx, ev) => drawElevSketch(ctx, ev, app);
const fpCache = new Map();
/** Wall footprints of a level, recomputed only when the model changed. */
app.footprints = levelId => {
  const key = `${app.geomVer}|${levelId}`;
  if (!fpCache.has(key)) { if (fpCache.size > 40) fpCache.clear(); fpCache.set(key, wallFootprints(app.doc, levelId)); }
  return fpCache.get(key);
};
app.isWall = id => app.doc.walls.some(w => w.id === id);
app.wallsOnLevel = () => app.doc.walls.filter(w => w.baseLevelId === app.levelId);
/** Curves the snaps can use on this plan: lines, wall location lines and the visible wall faces. */
app.snapCurves = () => {
  const fp = app.footprints(app.levelId);
  const out = planCurves(app.doc, app.levelId);
  for (const w of app.wallsOnLevel()) {
    if (w.shape === "arc") out.push({ type: "arc", c: w.c, r: w.r, start: w.start, sweep: w.sweep, id: w.id });
    else out.push({ type: "seg", a: w.a, b: w.b, id: w.id });
  }
  for (const rp of app.doc.referencePlanes) out.push({ type: "seg", a: rp.a, b: rp.b, id: rp.id });
  for (const f of app.doc.floors) if (f.levelId === app.levelId && f.id !== app.sketch?.editFloorId) for (const l of floorLoops(f)) l.forEach((p, i) => out.push({ type: "seg", a: p, b: l[(i + 1) % l.length], id: f.id }));
  // faces of walls being dragged are left out, so a moving wall does not snap to itself
  const skip = app.excludeFromSnap || new Set();
  const faces = [...fp.entries()].filter(([id]) => !skip.has(id)).flatMap(([, f]) => f.pieces);
  for (const [a, b] of outlineEdges(faces)) out.push({ type: "seg", a, b, id: "face" });
  return out;
};
const JOIN = 2;
/** Moves elements; walls joined to moved walls stretch so the joins hold (as in Revit). */
/** Plan outline(s) of any element, for previews while moving, rotating or mirroring: [{ pts, closed }]. */
app.outlineOf = id => {
  const doc = app.doc, el = app.lookup(id); if (!el) return [];
  const curvesPts = list => (list || []).map(c => ({ pts: curvePts(c) }));
  if (doc.walls.includes(el) || doc.lines.includes(el)) return [{ pts: locationPolyline(el) }];
  if (doc.openings.includes(el)) { const f = OP.openingFrame(doc, el); return f ? [{ pts: f.corners, closed: true }] : []; }
  if (doc.floors.includes(el)) return curvesPts(el.boundary);
  if (doc.roofs.includes(el)) { try { return [{ pts: roofGeometry(doc, el).outline, closed: true }]; } catch { return []; } }
  if (doc.components.includes(el)) {
    if (el.kind === "extrusion") return curvesPts(el.boundary);
    if (el.kind === "sweep") return el.plane ? [{ pts: sweepPlanStrip(doc, el), closed: true }] : curvesPts(el.path);
    return [];
  }
  if (doc.dimensions.includes(el)) return [{ pts: [el.a, el.b] }];
  if (doc.texts.includes(el)) { const r = 300; return [{ pts: [G.add(el.p, { x: -r, y: -r }), G.add(el.p, { x: r, y: -r }), G.add(el.p, { x: r, y: r }), G.add(el.p, { x: -r, y: r })], closed: true }]; }
  if (doc.referencePlanes.includes(el)) return [{ pts: [el.a, el.b] }];
  return [];
};
app.translateWithJoins = (doc, ids, delta) => {
  const set = new Set(ids);
  const moved = doc.walls.filter(w => set.has(w.id) && w.shape === "line");
  const ends = moved.flatMap(w => [w.a, w.b]).map(p => ({ ...p }));
  for (const id of ids) {
    const el = findById(doc, id)?.el; if (!el) continue;
    const o = doc.openings.find(x => x.id === id);
    if (o) { if (!set.has(o.hostWallId)) moveOpening(doc, o, translation(delta), { wallAxis: OP.wallAxis }); continue; }
    const comp = doc.components.find(x => x.id === id);
    if (comp?.kind === "wallSweep") continue; // goes with its walls
    if (comp?.kind === "sweep" && comp.plane) { comp.plane.o = G.add(comp.plane.o, delta); continue; }
    translateEl(el, delta);
  }
  for (const w of doc.walls) {
    if (set.has(w.id) || w.shape !== "line") continue;
    for (const k of ["a", "b"]) if (ends.some(p => G.dist(p, w[k]) <= JOIN)) w[k] = G.add(w[k], delta);
  }
};
/** Moves one end of a wall; other walls joined at that end follow. */
app.stretchWallEnd = (doc, id, key, p) => {
  const w = doc.walls.find(x => x.id === id);
  const old = { ...w[key] };
  for (const o of doc.walls) if (o.id !== id && o.shape === "line" && o.baseLevelId === w.baseLevelId) for (const k of ["a", "b"]) if (G.dist(o[k], old) <= JOIN) o[k] = { x: p.x, y: p.y };
  w[key] = { x: p.x, y: p.y };
};
/** Walls connected end to end with this one (the chain Tab selects). */
app.chainOf = id => {
  const wall = app.doc.walls.find(w => w.id === id);
  const line = !wall && app.doc.lines.find(l => l.id === id);
  const start = wall || line;
  if (!start) return [];
  const same = wall ? app.doc.walls.filter(w => w.baseLevelId === start.baseLevelId)
    : linesInPlan(app.doc, app.levelId).filter(l => l.kind === line.kind);
  const endsOf = w => { const p = locationPolyline(w); return [p[0], p.at(-1)]; };
  const seen = new Set([id]), queue = [start];
  while (queue.length) {
    const w = queue.pop();
    for (const e of endsOf(w)) for (const o of same) if (!seen.has(o.id) && endsOf(o).some(q => G.dist(q, e) <= JOIN)) { seen.add(o.id); queue.push(o); }
  }
  return [...seen];
};
app.setLevel = id => setLevel(id);
app.visibleLevels3D = () => { const hidden = new Set(app.prefs.hidden3D || []); return hidden.size ? new Set(app.doc.levels.filter(l => !hidden.has(l.id)).map(l => l.id)) : null; };
app.drawModel = view => { drawFloors(view, app); drawRoofs(view, app); drawWalls(view, app); drawAnnotations(view, app); drawOpenings(view, app); drawComponents(view, app); drawRefPlanes(view, app); };
app.cutWallSolids = (w, solids) => cutWallsByRoof(app.doc, w, cutWallSolids(app.doc, w, solids));
app.drawSketchMarks = view => drawRoofSketchMarks(view, app);
app.cutWallByRoof = (w, solids) => cutWallsByRoof(app.doc, w, solids);
app.slopedPrism = (THREE, s) => slopedPrismGeometry(THREE, s);
app.buildRoofs3D = (group, THREE, visible) => buildRoofs3D(group, THREE, app, visible);
app.cutWallPlan = (w, pieces, cutZ) => cutWallPlan(app.doc, w, pieces, cutZ);
app.floorVoidHoles = (part, top, bottom) => floorVoidHoles(app.doc, part, top, bottom);
app.buildComponents3D = (group, THREE, visible) => buildComponents3D(group, THREE, app, visible);
app.buildFloors3D = (group, THREE, visible) => buildFloors3D(group, THREE, app, visible);
app.sketch = null;
app.sketchChanged = () => { renderRibbon(); renderOptions(); renderProps(); setPrompt(); app.redraw(true); };
app.buildOpenings3D = (group, THREE, visible) => buildOpenings3D(group, THREE, app, visible);
app.drawUnderlay = view => drawUnderlay(view, app);
app.build3D = (v3, THREE) => buildWalls3D(v3, THREE, app);
app.report3DProblems = list => {
  const key = list.join("|");
  if (list.length && key !== app._last3DProblem) { app.toast(`Part of the model could not be shown in 3D (${list[0]}). The rest is shown. Undo the last change if it looks wrong.`, true); console.warn("3D:", list); }
  app._last3DProblem = key;
};
const boxOf = p => ({ x0: Math.min(...p.map(q => q.x)), y0: Math.min(...p.map(q => q.y)), x1: Math.max(...p.map(q => q.x)), y1: Math.max(...p.map(q => q.y)) });
app.extraBoxes = () => [
  ...[...app.footprints(app.levelId).values()].flatMap(f => f.pieces).map(boxOf),
  ...app.doc.floors.filter(f => f.levelId === app.levelId).flatMap(f => floorLoops(f)).filter(l => l.length).map(boxOf),
  ...app.doc.roofs.filter(r => roofOnPlan(app.doc, r, app.levelId)).map(r => { try { return boxOf(roofGeometry(app.doc, r).outline); } catch { return null; } }).filter(Boolean),
  ...annotationBox(app, app.levelId),
];
app.pick3D = id => { app.selection.clear(); if (id) app.selection.add(id); app.selectionChanged(); };
const ui = { openDialog: (h, w) => openDialog(h, w), closeDialog: () => closeDialog(), esc, ask: (m, ok) => app.ask(m, ok), askText: (l, v) => app.askText(l, v) };
app.ui = ui;
app.toast = (msg, bad = false) => {
  const t = $("#toast"); t.textContent = msg; t.classList.toggle("bad", !!bad); t.classList.add("show");
  clearTimeout(app._toastT); app._toastT = setTimeout(() => t.classList.remove("show"), bad ? 4200 : 2600);
};
app.commit = (label, fn) => {
  try {
    return app.history.transact(label, doc => {
      const ends = new Map(doc.walls.filter(w => w.shape === "line").map(w => [w.id, { a: { ...w.a }, b: { ...w.b } }]));
      const r = fn(doc);
      // doors and windows stay put when their wall is stretched or trimmed at its start, and must still fit
      OP.keepOpeningsInPlace(doc, ends);
      doc.openings = doc.openings.filter(o => doc.walls.some(w => w.id === o.hostWallId));
      doc.tags = doc.tags.filter(t => doc.openings.some(o => o.id === t.hostId));
      for (const w of doc.walls) if (w.attachTopTo && !doc.floors.some(f => f.id === w.attachTopTo) && !doc.roofs.some(r => r.id === w.attachTopTo)) delete w.attachTopTo;
      // roofs: must be buildable, and under the 40 m limit
      for (const r of doc.roofs) {
        const g = roofGeometry(doc, r);
        if (g.top > 40000) throw new Error(`That roof would reach ${(g.top / 1000).toFixed(3)} m. The building height limit is 40 m.`);
        if (r.topZ == null || Math.abs(r.topZ - g.top) > 0.01) r.topZ = Math.round(g.top * 100) / 100;
      }
      // wall sweeps and reveals lose deleted walls, and go when none are left
      const wallIds = new Set(doc.walls.map(w => w.id));
      for (const c of doc.components) if (c.kind === "wallSweep") c.wallIds = c.wallIds.filter(id => wallIds.has(id));
      doc.components = doc.components.filter(c => c.kind !== "wallSweep" || c.wallIds.length);
      // locked alignments hold whatever moved; then every wall must still be valid
      if (doc.constraints?.length) enforceLocks(doc, w => wallFootprints(doc, w.baseLevelId).get(w.id), (dd, id, d) => app.translateWithJoins(dd, [id], d));
      for (const w of doc.walls) checkWall(doc, w);
      for (const o of doc.openings) OP.checkOpening(doc, o);
      return r;
    });
  }
  catch (err) { app.toast(err.message || "That change could not be made.", true); return undefined; }
};
app.hoverCandidate = () => app.hoverId;
app.selectionChanged = () => { renderProps(); renderOptions(); setPrompt(); app.redraw(true); };
app.toolChanged = () => { renderOptions(); renderProps(); setPrompt(); app.redraw(); };
app.renameSilently = name => { app.doc.name = name; $("#projName").value = name; };

app.elementsInRect = (r, crossing) => {
  const ids = linesInPlan(app.doc, app.levelId).filter(l => inRect(l, r, crossing)).map(l => l.id);
  const fp = app.footprints(app.levelId);
  const inside = p => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
  const corners = [G.P(r.x0, r.y0), G.P(r.x1, r.y0), G.P(r.x1, r.y1), G.P(r.x0, r.y1)];
  for (const w of app.wallsOnLevel()) {
    const pieces = fp.get(w.id)?.pieces || [];
    const pts = pieces.flat();
    if (!pts.length) continue;
    const fully = pts.every(inside);
    const touched = fully || (crossing && (pts.some(inside) || corners.some(c => pieces.some(pc => G.pointInPolygon(c, pc))) ||
      pieces.some(pc => pc.some((a, i) => corners.some((c, k) => G.segIntersect(a, pc[(i + 1) % pc.length], c, corners[(k + 1) % 4]))))));
    if (touched) ids.push(w.id);
  }
  for (const c of app.doc.components) {
    if (app.sketch) break;
    let pts = [];
    try {
      if (c.kind === "extrusion" && c.levelId === app.levelId) { const r = checkSketch(c.boundary); pts = r.ok ? r.loops.flat() : []; }
      else if (c.kind === "sweep" && c.levelId === app.levelId) pts = sweepChain(c.path).pts;
    } catch { pts = []; }
    if (pts.length && (crossing ? pts.some(inside) : pts.every(inside))) ids.push(c.id);
  }
  for (const rp of app.doc.referencePlanes) if (crossing ? [rp.a, rp.b].some(inside) : [rp.a, rp.b].every(inside)) ids.push(rp.id);
  for (const r of app.doc.roofs) {
    if (!roofOnPlan(app.doc, r, app.levelId) || app.sketch) continue;
    let pts = []; try { pts = roofGeometry(app.doc, r).outline; } catch { pts = []; }
    if (pts.length && (crossing ? pts.some(inside) : pts.every(inside))) ids.push(r.id);
  }
  for (const fl of app.doc.floors) {
    if (fl.levelId !== app.levelId || app.sketch) continue;
    const pts = floorLoops(fl).flat();
    if (pts.length && (crossing ? pts.some(inside) : pts.every(inside))) ids.push(fl.id);
  }
  for (const d of app.doc.dimensions) if (d.levelId === app.levelId && d.a && (crossing ? [d.a, d.b].some(inside) : [d.a, d.b].every(inside))) ids.push(d.id);
  for (const t of app.doc.texts) if (t.levelId === app.levelId && inside(t.p)) ids.push(t.id);
  for (const o of app.doc.openings) {
    const f = OP.openingFrame(app.doc, o);
    if (!f || f.w.baseLevelId !== app.levelId) continue;
    if (crossing ? f.corners.some(inside) : f.corners.every(inside)) ids.push(o.id);
  }
  return ids;
};

app.updateHover = c => {
  const tol = app.plan.px(7);
  const fp = app.footprints(app.levelId);
  const cands = linesInPlan(app.doc, app.levelId).map(l => ({ id: l.id, d: distanceTo(l, c.raw) }));
  for (const w of app.wallsOnLevel()) {
    const pieces = fp.get(w.id)?.pieces || [];
    const inside = pieces.some(p => G.pointInPolygon(c.raw, p));
    const loc = locationPolyline(w);
    let d = inside ? 0 : Infinity;
    for (const p of pieces) for (let i = 0; i < p.length; i++) d = Math.min(d, G.projectOnSegment(c.raw, p[i], p[(i + 1) % p.length]).dist);
    for (let i = 0; i < loc.length - 1; i++) d = Math.min(d, G.projectOnSegment(c.raw, loc[i], loc[i + 1]).dist);
    cands.push({ id: w.id, d: inside ? 0.5 : d }); // lines drawn on top of a wall win when right on them
  }
  cands.push(...openingsAt(app, c.raw));
  if (!app.sketch) cands.push(...floorsAt(app, c.raw, tol), ...roofsAt(app, c.raw, tol), ...componentsAt(app, c.raw, tol), ...annotationsAt(app, c.raw, tol));
  const list = cands.filter(x => x.d <= tol).sort((a, b) => a.d - b.d).map(x => x.id);
  // Tab can also pick the whole chain of joined walls under the cursor
  const first = list[0];
  if (first && app.chainOf(first).length > 1) list.push(`chain:${first}`);
  const same = list.length === app.hoverList.length && list.every((id, i) => id === app.hoverList[i]);
  // a Tab choice holds while the pointer stays still; moving it starts again from the nearest element
  const movedAway = app.tabAt && Math.hypot(c.sx - app.tabAt.x, c.sy - app.tabAt.y) > 4;
  if (!same || movedAway) { app.hoverList = list; app.hoverIdx = 0; app.tabAt = null; }
  const next = app.hoverList[app.hoverIdx] || null;
  if (next !== app.hoverId) { app.hoverId = next; app.hoverSet = next?.startsWith("chain:") ? new Set(app.chainOf(next.slice(6))) : null; app.redraw(); }
};

app.loadDoc = doc => {
  app.doc = doc;
  app.history.reset(doc);
  app.levelId = doc.levels[0].id;
  app.selection.clear();
  $("#projName").value = doc.name;
  renderAll();
  app.plan.fit(app.plan.contentBox());
  app.view3d.fitted = false;
  app.view3d.invalidate();
};

// --------------------------------------------------------------------------- views
app.plan = new PlanView($("#planCanvas"), app);
app.view3d = new View3D($("#view3d"), app);
app.elev = new ElevationView($("#elevView"), app);

// --------------------------------------------------------------------------- elevations and section box
function openElevation(side) {
  if (app.sketch) { app.toast("Finish or cancel the sketch first."); return; }
  if (app.prefs.layout === "three-only") setLayout("tile");
  app.elevSide = side; app.setTool("select");
  $("#planCanvas").style.visibility = "hidden";
  app.elev.show(side);
  setTitle();
  renderBrowser(); setPrompt();
}
function setTitle() { $("#planTitle").textContent = app.elevSide ? `Elevation: ${ELEVATIONS[app.elevSide].name}` : `Floor Plan: ${app.levelName()}`; }
function closeElevation() {
  if (!app.elevSide) return;
  app.elevSide = null; app.elev.hide(); $("#planCanvas").style.visibility = "";
  setTitle();
}
app.openElevation = openElevation; app.closeElevation = closeElevation;
function toggleSectionBox(on = !app.prefs.sectionBox) {
  if (app.prefs.layout === "plan-only") setLayout("tile");
  app.prefs.sectionBox = on ? (app.prefs.sectionBoxMm || modelBoxMm(app.view3d)) : false;
  if (on) app.prefs.sectionBoxMm = app.prefs.sectionBox;
  app.savePrefs(); applySectionBox(app.view3d, app.prefs.sectionBox || null); renderViewBars();
  app.toast(on ? "Section Box on: drag the sliders under the 3D view to cut the model." : "Section Box off.");
}
app.toggleSectionBox = toggleSectionBox;
if (app.prefs.sectionBox) applySectionBox(app.view3d, app.prefs.sectionBox);

/** Blue length dimension on one selected straight line; click the number to type a new length. */
app.drawSelectionDims = view => {
  if (app.tool.name !== "select" || app.tool.drag || app.selection.size !== 1) return;
  const el = app.lookup([...app.selection][0]);
  if (el && app.isWall(el.id)) { drawWallDims(view, app, el, inlineEdit); return; }
  if (el && app.doc.openings.some(o => o.id === el.id)) { drawOpeningDims(view, app, el, inlineEdit); return; }
  if (!el || el.kind === undefined) return;
  if (el.shape === "line" && G.dist(el.a, el.b) > 1) {
    view.tempDim(el.a, el.b, String(Math.round(lineLength(el))), {
      onClick: box => inlineEdit(box, Math.round(lineLength(el)), v => app.commit("Change length", () => setLineLength(app.lookup(el.id), v))),
    });
  } else if (el.shape === "arc") {
    const box = view.label(G.arcMid(el), `R ${Math.round(el.r)}`, { offsetPx: 14, bg: "rgba(12,12,14,.85)" });
    view.hits.push({ ...box, onClick: b => inlineEdit(b, Math.round(el.r), v => app.commit("Change radius", () => { app.lookup(el.id).r = v; })) });
  }
};

function inlineEdit(box, value, apply) {
  const inp = $("#inlineInput");
  const r = $("#planCanvas").getBoundingClientRect();
  inp.style.left = `${r.left + box.cx - 45}px`; inp.style.top = `${r.top + box.cy - 14}px`;
  inp.value = String(value); inp.hidden = false; inp.focus(); inp.select();
  const done = ok => {
    inp.onkeydown = inp.onblur = null; inp.hidden = true;
    if (ok) { const v = parseFloat(inp.value.replace(/,/g, "")); if (v > 0) apply(v); else app.toast("Type a length in millimetres, more than 0.", true); }
    $("#planCanvas").focus();
  };
  inp.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.preventDefault(); done(false); } e.stopPropagation(); };
  inp.onblur = () => done(false);
}

// --------------------------------------------------------------------------- tools
const TOOLS = {
  select: () => new SelectTool(app),
  modelLine: () => new LineTool(app, "model"),
  detailLine: () => new LineTool(app, "detail"),
  dimension: () => new DimensionTool(app),
  text: () => new TextTool(app),
  wall: () => new WallTool(app),
  door: () => new OpeningTool(app, "door"),
  boundary: () => (app.sketch?.elev ? new ElevSketchTool(app) : app.sketch?.kind === "roof" ? new RoofBoundaryTool(app) : new BoundaryTool(app)),
  elevSketch: () => new ElevSketchTool(app),
  slopeArrow: () => new SlopeArrowTool(app),
  roofExtrusion: () => new RoofExtrusionTool(app),
  refPlane: () => new RefPlaneTool(app),
  window: () => new OpeningTool(app, "window"),
  move: () => new MoveTool(app, false),
  copy: () => new MoveTool(app, true),
  rotate: () => new RotateTool(app),
  mirrorPick: () => new MirrorTool(app, false),
  mirrorDraw: () => new MirrorTool(app, true),
  scale: () => new ScaleTool(app),
  array: () => new ArrayTool(app),
  offset: () => new OffsetTool(app),
  trim: () => new TrimTool(app),
  split: () => new SplitTool(app),
  align: () => new AlignTool(app),
  chamfer: () => new CornerTool(app, "chamfer"),
  fillet: () => new CornerTool(app, "fillet"),
};
app.setTool = name => {
  if (!TOOLS[name]) return;
  const SELECT_FIRST = ["move", "copy", "rotate", "mirrorPick", "mirrorDraw", "scale", "array"];
  if (SELECT_FIRST.includes(name) && ![...app.selection].some(id => canTransform(app.doc, id))) {
    app.toast("Select what to change first (walls, doors, windows, floors, roofs, components, text...), then choose the tool again.");
    if (app.tool?.name !== "select") { app.tool = TOOLS.select(); renderRibbon(); app.toolChanged(); }
    return;
  }
  app.tool?.cancelDrag?.();
  if (name !== "select") app.lastTool = name;
  app.tool = TOOLS[name]();
  app.typed = ""; app.snap = null; app.snapOverride = null;
  if (name !== "select") { app.hoverId = null; }
  renderRibbon(); app.toolChanged();
  $("#planCanvas").focus();
};

// Ribbon. Tools not built yet are shown (so the layout is familiar) but disabled, with the phase that brings them.
const SOON = phase => ({ soon: `Arrives in phase ${phase}` });
const RIBBON = [
  { tab: "Architecture", groups: [
    { label: "Build", items: [
      { id: "wall", label: "Wall", icon: "wall", key: "WA", tool: "wall" },
      { id: "door", label: "Door", icon: "door", key: "DR", tool: "door" },
      { id: "window", label: "Window", icon: "window", key: "WN", tool: "window" },
      { id: "component", label: "Component", icon: "component", run: () => modelInPlaceDialog(app, ui) },
      { id: "floor", label: "Floor", icon: "floor", key: "SB", run: () => startFloorSketch(app) },
      { id: "roof", label: "Roof by Footprint", icon: "roof", key: "RF", run: () => startRoofSketch(app) },
      { id: "roofExtrusion", label: "Roof by Extrusion", icon: "roof", tool: "roofExtrusion" },
    ] },
    { label: "Wall details", items: [
      { id: "wallSweep", label: "Wall Sweep", icon: "sweep", run: () => wallSweepDialog(app, ui, false) },
      { id: "wallReveal", label: "Wall Reveal", icon: "sweep", run: () => wallSweepDialog(app, ui, true) },
      { id: "parapet", label: "Parapet", icon: "wall", run: () => parapetDialog(app, ui) },
    ] },
    { label: "Model", items: [{ id: "modelLine", label: "Model Line", icon: "line", key: "LI", tool: "modelLine" }] },
    { label: "Work Plane", items: [{ id: "refPlane", label: "Ref Plane", icon: "section", key: "RP", tool: "refPlane" }, { id: "workPlane", label: "Set", icon: "levels", run: () => workPlaneDialog(app, ui) }] },
  ] },
  { tab: "Modify", groups: [
    { label: "Select", items: [{ id: "select", label: "Modify", icon: "modify", key: "MD", tool: "select" }] },
    { label: "Modify", items: [
      { id: "align", label: "Align", icon: "align", key: "AL", tool: "align" },
      { id: "offset", label: "Offset", icon: "offset", key: "OF", tool: "offset" },
      { id: "mirrorPick", label: "Mirror - Pick Axis", icon: "mirror", key: "MM", tool: "mirrorPick" },
      { id: "mirrorDraw", label: "Mirror - Draw Axis", icon: "mirror", key: "DM", tool: "mirrorDraw" },
      { id: "move", label: "Move", icon: "move", key: "MV", tool: "move" },
      { id: "copy", label: "Copy", icon: "copy", key: "CO", tool: "copy" },
      { id: "rotate", label: "Rotate", icon: "rotate", key: "RO", tool: "rotate" },
      { id: "trim", label: "Trim/Extend", icon: "trim", key: "TR", tool: "trim" },
      { id: "split", label: "Split", icon: "split", key: "SL", tool: "split" },
      { id: "array", label: "Array", icon: "array", key: "AR", tool: "array" },
      { id: "scale", label: "Scale", icon: "scale", key: "RE", tool: "scale" },
      { id: "chamfer", label: "Chamfer", icon: "chamfer", key: "CH", tool: "chamfer" },
      { id: "fillet", label: "Fillet", icon: "fillet", key: "FL", tool: "fillet" },
      { id: "pin", label: "Pin", icon: "pin", key: "PN", run: () => setPinned(true) },
      { id: "unpin", label: "Unpin", icon: "pin", key: "UP", run: () => setPinned(false) },
      { id: "delete", label: "Delete", icon: "del", key: "DE", run: () => deleteSelection() },
    ] },
    { label: "Levels", items: [{ id: "copyLevels", label: "Copy to Levels", icon: "levels", run: () => copyToLevelsDialog(app, ui) }] },
    { label: "Modify Wall", items: [{ id: "attachTop", label: "Attach Top/Base", icon: "roof", run: () => attachTopDialog(app, ui) }] },
    { label: "Undo", items: [
      { id: "undo", label: "Undo", icon: "undo", hint: "Ctrl+Z", run: () => undo() },
      { id: "redo", label: "Redo", icon: "redo", hint: "Ctrl+Y", run: () => redo() },
    ] },
  ] },
  { tab: "Annotate", groups: [
    { label: "Detail", items: [{ id: "detailLine", label: "Detail Line", icon: "detail", key: "DL", tool: "detailLine" }] },
    { label: "Dimension", items: [{ id: "dimAligned", label: "Aligned", icon: "dim", key: "DI", tool: "dimension" }] },
    { label: "Tag", items: [{ id: "tag", label: "Tag", icon: "tag", key: "TG", run: () => tagOpenings(app) }, { id: "text", label: "Text", icon: "text", key: "TX", tool: "text" }] },
  ] },
  { tab: "View", groups: [
    { label: "Create", items: [{ id: "view3d", label: "3D View", icon: "threed", run: () => setLayout("tile") }] },
    { label: "Windows", items: [
      { id: "tile", label: "Tile", icon: "tile", key: "WT", run: () => setLayout("tile") },
      { id: "planOnly", label: "Plan", icon: "plan", run: () => setLayout("plan-only") },
      { id: "threeOnly", label: "3D", icon: "threed", run: () => setLayout("three-only") },
      { id: "live3d", label: "Live 3D", icon: "threed", key: "LV", run: () => setLive3D(app.prefs.layout === "plan-only") },
      { id: "fullScreen", label: "Full Screen", icon: "fit", key: "FS", run: () => toggleFullScreen() },
    ] },
    { label: "Schedules", items: [{ id: "schedule", label: "Door/Window Schedule", icon: "types", run: () => scheduleDialog(app, ui) }] },
    { label: "Navigate", items: [{ id: "zoomFit", label: "Zoom to Fit", icon: "fit", key: "ZF", run: () => zoomFit() }] },
    { label: "Elevations", items: ["north", "south", "east", "west"].map(k => ({ id: `elev-${k}`, label: ELEVATIONS[k].name, icon: "section", run: () => openElevation(k) })) },
    { label: "Graphics", items: [{ id: "sectionBox", label: "Section Box", icon: "section", key: "BX", run: () => toggleSectionBox() }] },
  ] },
  { tab: "Manage", groups: [
    { label: "Project", items: [
      { id: "levels", label: "Levels", icon: "levels", key: "LL", run: () => levelsDialog(app, ui) },
      { id: "wallTypes", label: "Wall Types", icon: "types", run: () => wallTypeDialog(app, (app.tool.name === "wall" && app.tool.typeId) || app.doc.wallTypes[0].id, ui) },
      { id: "units", label: "Units", icon: "units", key: "UN", run: () => unitsDialog() },
    ] },
    { label: "Settings", items: [
      { id: "snapsDlg", label: "Snaps", icon: "snaps", run: () => snapsDialog() },
      { id: "shortcuts", label: "Shortcuts", icon: "text", key: "KS", run: () => shortcutsDialog() },
    ] },
  ] },
];
const SKETCH_TAB = { tab: "Modify | Create Floor Boundary", groups: [
  { label: "Mode", items: [
    { id: "finishSketch", label: "Finish Edit Mode", icon: "fit", run: () => (app.sketch?.kind === "floor" ? finishSketch(app, ui) : app.sketch?.kind === "roof" ? finishRoofSketch(app, ui) : finishComponentSketch(app, ui)) },
    { id: "cancelSketch", label: "Cancel Edit Mode", icon: "del", run: () => cancelSketch(app) },
  ] },
  { label: "Draw", items: [{ id: "boundaryLine", label: "Boundary Line", icon: "line", key: "BL", tool: "boundary" }, { id: "slopeArrow", label: "Slope Arrow", icon: "move", tool: "slopeArrow", roofOnly: true }, { id: "workPlane", label: "Set Work Plane", icon: "levels", run: () => workPlaneDialog(app, ui) }] },
  { label: "Modify", items: [
    { id: "select", label: "Modify", icon: "modify", key: "MD", tool: "select" },
    { id: "trim", label: "Trim/Extend", icon: "trim", key: "TR", tool: "trim" },
    { id: "offset", label: "Offset", icon: "offset", key: "OF", tool: "offset" },
    { id: "split", label: "Split", icon: "split", key: "SL", tool: "split" },
    { id: "move", label: "Move", icon: "move", key: "MV", tool: "move" },
    { id: "copy", label: "Copy", icon: "copy", key: "CO", tool: "copy" },
    { id: "delete", label: "Delete", icon: "del", key: "DE", run: () => deleteSelection() },
  ] },
  { label: "Undo", items: [{ id: "undo", label: "Undo", icon: "undo", run: () => undo() }, { id: "redo", label: "Redo", icon: "redo", run: () => redo() }] },
] };
const SKETCH_OK = new Set(SKETCH_TAB.groups.flatMap(g => g.items.map(i => i.id)).concat(["workPlane", "zoomFit", "tile", "planOnly", "threeOnly", "view3d", "units", "snapsDlg", "shortcuts", "align", "mirrorPick", "mirrorDraw", "rotate", "chamfer", "fillet", "array", "scale"]));
const ALL_ITEMS = [...RIBBON, SKETCH_TAB].flatMap(t => t.groups.flatMap(g => g.items));
const SHORTCUTS = Object.fromEntries(ALL_ITEMS.filter(i => i.key).map(i => [i.key, i]));
SHORTCUTS.ZE = SHORTCUTS.ZA = SHORTCUTS.ZF;
SHORTCUTS.BL = ALL_ITEMS.find(i => i.id === "boundaryLine");
let ribbonTab = app.prefs.ribbonTab || "Architecture";

function runItem(it) {
  if (app.sketch && !SKETCH_OK.has(it.id)) { app.toast("Finish or cancel the sketch first (Finish Edit Mode / Cancel Edit Mode)."); return; }
  if (it.roofOnly && app.sketch?.kind !== "roof") { app.toast("A slope arrow is for roof footprints."); return; }
  if (it.soon) { app.toast(`${it.label}: ${it.soon.toLowerCase()}.`); return; }
  // drawing tools work on a plan: leave the elevation first
  if (app.elevSide && !app.sketch?.elev && !/^(elev-|sectionBox|tile|planOnly|threeOnly|view3d|schedule|levels|units|snapsDlg|shortcuts|undo|redo|wallTypes|zoomFit|component|live3d|fullScreen)/.test(it.id)) closeElevation();
  if (it.tool) app.setTool(it.tool);
  else it.run?.();
}

function renderRibbon() {
  SKETCH_TAB.tab = SKETCH_TITLES[app.sketch?.kind] || SKETCH_TITLES.floor;
  SKETCH_TAB.groups[1].items[0].label = app.sketch?.kind === "sweep" ? "Path Line" : "Boundary Line";
  const TABS = app.sketch ? [SKETCH_TAB, ...RIBBON.filter(t => t.tab === "View")] : RIBBON;
  if (app.sketch && !TABS.some(t => t.tab === ribbonTab)) ribbonTab = SKETCH_TAB.tab;
  if (!app.sketch && Object.values(SKETCH_TITLES).includes(ribbonTab)) ribbonTab = "Architecture";
  $("#ribbonTabs").innerHTML = TABS.map(t => `<button role="tab" type="button" aria-selected="${t.tab === ribbonTab}" data-tab="${t.tab}">${t.tab}</button>`).join("");
  $("#ribbonTabs").querySelectorAll("button").forEach(b => b.onclick = () => { ribbonTab = b.dataset.tab; app.prefs.ribbonTab = ribbonTab; app.savePrefs(); renderRibbon(); });
  const tab = TABS.find(t => t.tab === ribbonTab) || TABS[0];
  $("#ribbonPanel").innerHTML = tab.groups.map(g => `<div class="sk-group"><div class="items">${g.items.filter(it => !it.roofOnly || app.sketch?.kind === "roof").map(it => {
    const tip = `${it.label}${it.key ? ` (${it.key})` : it.hint ? ` (${it.hint})` : ""}${it.soon ? ` · ${it.soon}` : ""}`;
    const pressed = it.tool && app.tool?.name === it.tool;
    return `<button type="button" class="sk-tool" data-id="${it.id}" title="${esc(tip)}" aria-pressed="${pressed}"${it.soon ? " disabled" : ""}${it.id === "undo" && !app.history.canUndo() ? " disabled" : ""}${it.id === "redo" && !app.history.canRedo() ? " disabled" : ""}>${icon(it.icon)}<span>${esc(it.label)}</span></button>`;
  }).join("")}</div><div class="glabel">${esc(g.label)}</div></div>`).join("");
  $("#ribbonPanel").querySelectorAll(".sk-tool").forEach(b => b.onclick = () => runItem(ALL_ITEMS.find(i => i.id === b.dataset.id)));
}

// --------------------------------------------------------------------------- options bar
function renderOptions() {
  const bar = $("#optionsBar");
  const opts = app.tool?.options?.() || [];
  bar.innerHTML = "";
  for (const o of opts) {
    if (o.type === "text") { const s = document.createElement("span"); s.className = o.cls || "lab"; s.textContent = o.text; bar.append(s); continue; }
    const lab = document.createElement("label");
    if (o.label) { const t = document.createElement("span"); t.className = "lab"; t.textContent = o.label + (o.type === "check" ? "" : ":"); lab.append(t); }
    if (o.type === "seg") {
      const seg = document.createElement("span"); seg.className = "seg"; seg.setAttribute("role", "group");
      for (const it of o.items) {
        const b = document.createElement("button"); b.type = "button"; b.title = it.title; b.setAttribute("aria-pressed", String(it.on)); b.setAttribute("aria-label", it.title);
        b.innerHTML = icon(it.icon); b.onclick = () => o.onPick(it.key); seg.append(b);
      }
      lab.append(seg);
    } else if (o.type === "select") {
      const s = document.createElement("select");
      s.innerHTML = o.items.map(it => `<option value="${esc(it.value)}"${it.value === o.value ? " selected" : ""}>${esc(it.label)}</option>`).join("");
      s.onchange = () => o.onChange(s.value); lab.append(s);
    } else if (o.type === "number") {
      const n = document.createElement("input"); n.type = "number"; n.value = o.value; if (o.placeholder) n.placeholder = o.placeholder; if (o.min != null) n.min = o.min; if (o.max != null) n.max = o.max; n.step = o.step || 1;
      n.onchange = () => o.onChange(parseFloat(n.value)); lab.append(n);
    } else if (o.type === "button") {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn"; b.textContent = o.label; b.onclick = o.onClick; bar.append(b); continue;
    } else if (o.type === "check") {
      const c = document.createElement("input"); c.type = "checkbox"; c.checked = !!o.value; c.onchange = () => o.onChange(c.checked); lab.prepend(c);
    }
    bar.append(lab);
  }
}

// --------------------------------------------------------------------------- properties
function renderProps() {
  const box = $("#props");
  const t = app.tool;
  if (app.sketch && (t?.name === "boundary" || ![...app.selection].some(id => app.lookup(id)))) {
    if (app.sketch.kind === "floor") { box.innerHTML = sketchProps(app, esc); wireSketchProps(app); }
    else if (app.sketch.kind === "roof") { box.innerHTML = roofSketchProps(app, esc); wireRoofSketchProps(app, renderProps); }
    else { box.innerHTML = componentSketchProps(app, esc); wireComponentSketchProps(app, renderProps); }
    return;
  }
  if (t && t.name === "wall") {
    box.innerHTML = `<div class="ptype"><div class="row"><span>Basic Wall</span><button class="btn" type="button" id="pEditType">Edit Type</button></div>
      <select id="pType" aria-label="Wall type">${app.doc.wallTypes.map(w => `<option value="${esc(w.id)}"${w.id === t.typeId ? " selected" : ""}>${esc(w.name)}</option>`).join("")}</select></div>
      <div class="pgroup">Constraints</div>
      <div class="prow"><span>Base Constraint</span><input readonly value="${esc(app.levelName())}"></div>
      <div class="prow"><span>Thickness</span><input readonly value="${t.type().thickness}"></div>
      <div class="pnote">Draw clockwise to keep the exterior side outside. Type a length and press Enter; Space flips the side while drawing.</div>`;
    $("#pType").onchange = e => { t.typeId = e.target.value; t.savePrefs(); renderProps(); app.redraw(); };
    $("#pEditType").onclick = () => wallTypeDialog(app, t.typeId, ui);
    return;
  }
  if (t && (t.name === "door" || t.name === "window")) {
    const ty = t.type();
    box.innerHTML = `<div class="ptype"><div class="row"><span>${t.title}</span></div>
      <select id="pType" aria-label="Type">${t.types().map(x => `<option value="${esc(x.id)}"${x.id === t.typeId ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select></div>
      <div class="pgroup">Dimensions</div>
      <div class="prow"><span>Width</span><input readonly value="${ty.width}"></div>
      <div class="prow"><span>Height</span><input readonly value="${ty.height}"></div>
      ${t.kind === "window" ? `<div class="prow"><span>Sill Height</span><input readonly value="${t.sillValue()}"></div>` : ""}
      <div class="pnote">Move over a wall: the blue numbers show the distance to the next walls. Space flips the side it opens to.</div>`;
    $("#pType").onchange = e => { t.typeId = e.target.value; t.sill = null; t.savePrefs(); app.toolChanged(); };
    return;
  }
  if (t && t.name !== "select") {
    box.innerHTML = `<div class="ptype"><div class="row"><span>Lines</span><span>${esc(t.title)}</span></div>
      <select id="pStyle" aria-label="Line style">${Object.entries(LINE_STYLES).map(([k, v]) => `<option value="${k}"${k === t.style ? " selected" : ""}>${esc(v.label)}</option>`).join("")}</select></div>
      <div class="pgroup">Constraints</div>
      <div class="prow"><span>Work Plane</span><input readonly value="Level : ${esc(app.levelName())}"></div>
      <div class="pnote">${t.kind === "detail" ? "Detail lines belong to this view only, for notes and drawing details." : "Model lines exist in 3D on the level's plane. Later they can become walls with Wall > Pick Lines."}</div>`;
    $("#pStyle").onchange = e => { t.style = e.target.value; t.savePrefs(); renderOptions(); };
    return;
  }
  const ids = [...app.selection].filter(id => app.lookup(id));
  if (!ids.length) {
    const lv = app.doc.levels.find(l => l.id === app.levelId);
    box.innerHTML = `<div class="ptype"><div class="row"><span>Floor Plan</span><span>${esc(lv?.name || "")}</span></div></div>
      <div class="pgroup">Identity Data</div>
      <div class="prow"><span>View Name</span><input readonly value="${esc(lv?.name || "")}"></div>
      <div class="prow"><span>Associated Level</span><input readonly value="${esc(lv?.name || "")}"></div>
      <div class="prow"><span>Elevation</span><input readonly value="${levelLabel(lv?.elevation || 0)}"></div>
      <div class="pnote">Nothing selected. Draw with <b>Model Line</b> (LI) or <b>Detail Line</b> (DL); type a length while drawing and press Enter.</div>`;
    return;
  }
  const els = ids.map(app.lookup);
  if (els.every(e => app.doc.components.some(c => c.id === e.id) || app.doc.referencePlanes.some(r => r.id === e.id))) { box.innerHTML = componentProps(app, ids, esc); wireComponentProps(app, ids, renderProps); return; }
  if (els.every(e => app.doc.floors.some(f => f.id === e.id))) { box.innerHTML = floorProps(app, ids, esc); wireFloorProps(app, ids, renderProps, ui); return; }
  if (els.every(e => app.doc.dimensions.some(d => d.id === e.id) || app.doc.texts.some(t => t.id === e.id)) && (els.every(e => e.text != null) || els.every(e => e.text == null))) { box.innerHTML = annotationProps(app, ids, esc); wireAnnotationProps(app, ids, renderProps); return; }
  if (els.every(e => app.doc.roofs.some(r => r.id === e.id))) { box.innerHTML = roofProps(app, ids, esc); wireRoofProps(app, ids, renderProps, ui); return; }
  if (app.sketch?.kind === "roof" && els.every(e => e.kind === "sketch")) { box.innerHTML = roofLineProps(app, ids, esc); wireRoofLineProps(app, ids, renderProps); return; }
  if (els.every(e => app.doc.openings.some(o => o.id === e.id))) { box.innerHTML = openingProps(app, ids, esc); wireOpeningProps(app, ids, renderProps, ui); return; }
  if (els.every(e => app.isWall(e.id))) { box.innerHTML = wallProps(app, ids, esc); wireWallProps(app, ids, renderProps, typeId => wallTypeDialog(app, typeId, ui)); return; }
  const allLines = els.every(e => e.shape && e.kind);
  if (!allLines) { box.innerHTML = `<div class="pnote">${ids.length} elements selected.</div>`; return; }
  const style = els.every(e => e.style === els[0].style) ? els[0].style : "";
  const one = els.length === 1 ? els[0] : null;
  box.innerHTML = `<div class="ptype"><div class="row"><span>${one ? (one.kind === "detail" ? "Detail Line" : "Model Line") : `Lines (${els.length})`}</span><span>${one?.pinned ? "Pinned" : ""}</span></div>
    <select id="pStyle" aria-label="Line style">${style ? "" : `<option value="" selected>(varies)</option>`}${Object.entries(LINE_STYLES).map(([k, v]) => `<option value="${k}"${k === style ? " selected" : ""}>${esc(v.label)}</option>`).join("")}</select></div>
    <div class="pgroup">Constraints</div>
    <div class="prow"><span>Work Plane</span><input readonly value="Level : ${esc(app.doc.levels.find(l => l.id === (one || els[0]).levelId)?.name || "")}"></div>
    <div class="pgroup">Dimensions</div>
    ${one ? `<div class="prow"><span>${one.shape === "arc" ? "Radius" : "Length"}</span><input id="pLen" type="number" step="1" value="${Math.round(one.shape === "arc" ? one.r : lineLength(one))}"></div>` : `<div class="prow"><span>Total length</span><input readonly value="${Math.round(els.reduce((s, e) => s + lineLength(e), 0))}"></div>`}
    ${one?.shape === "arc" ? `<div class="prow"><span>Arc length</span><input readonly value="${Math.round(lineLength(one))}"></div>` : ""}`;
  $("#pStyle").onchange = e => { const v = e.target.value; if (v) app.commit("Line style", () => ids.forEach(id => { app.lookup(id).style = v; })); };
  const pl = $("#pLen");
  if (pl) pl.onchange = () => {
    const v = parseFloat(pl.value);
    if (!(v > 0)) { app.toast("Type a value in millimetres, more than 0.", true); renderProps(); return; }
    app.commit(one.shape === "arc" ? "Change radius" : "Change length", () => { const e = app.lookup(one.id); if (e.shape === "arc") e.r = v; else setLineLength(e, v); });
  };
}

// --------------------------------------------------------------------------- project browser and view bars
function renderBrowser() {
  const lv = app.doc.levels;
  const node = (label, attrs = "", cls = "") => `<li><button type="button" class="node ${cls}" ${attrs}>${esc(label)}</button>`;
  $("#browser").innerHTML = `<ul class="tree">
    ${node("Views (all)", "disabled", "head")}<ul>
      ${node("Floor Plans", "disabled", "head")}<ul>${lv.map(l => node(`${l.name}  ${levelLabel(l.elevation)}`, `data-level="${l.id}" role="treeitem"`, l.id === app.levelId && !app.elevSide ? "on" : "")).join("")}</ul>
      ${node("3D Views", "disabled", "head")}<ul>${node("{3D}", `data-view="3d" role="treeitem"`)}</ul>
      ${node("Elevations (Building Elevation)", "disabled", "head")}<ul>${["east", "north", "south", "west"].map(k => node(ELEVATIONS[k].name, `data-elev="${k}" role="treeitem"`, app.elevSide === k ? "on" : "")).join("")}</ul>
      ${node("Sheets", "disabled", "head")}
    </ul></ul>`;
  $("#browser").querySelectorAll("[data-level]").forEach(b => b.onclick = () => { closeElevation(); setLevel(b.dataset.level); });
  $("#browser").querySelectorAll("[data-elev]").forEach(b => b.onclick = () => openElevation(b.dataset.elev));
  $("#browser").querySelector("[data-view='3d']").onclick = () => { setLayout(app.prefs.layout === "plan-only" ? "tile" : app.prefs.layout || "tile"); fit3D(); };
}

function setLevel(id) {
  if (app.sketch && id !== app.sketch.levelId) { app.toast("Finish or cancel the sketch before changing level."); renderBrowser(); return; }
  closeElevation();
  app.levelId = id; app.selection.clear(); app.view3d.invalidate();
  setTitle();
  renderBrowser(); app.toolChanged();
}

function renderViewBars() {
  const scale = app.prefs.scale || "100";
  $("#planBar").innerHTML = `<label>Scale <select id="vScale">${["50", "100", "200"].map(s => `<option value="${s}"${s === scale ? " selected" : ""}>1 : ${s}</option>`).join("")}</select></label>
    <button type="button" id="vFit" title="Zoom to fit (ZF)">Zoom to fit</button>
    <label title="Show the 3D view beside the plan and update it as you draw (LV)"><input type="checkbox" id="vLive"${app.prefs.layout === "plan-only" ? "" : " checked"}> Live 3D</label>
    <label><input type="checkbox" id="vUnder"${app.prefs.underlay ? " checked" : ""}> Underlay: level below</label>
    <span>Snaps: ${app.snapsEnabled.size ? "on" : "off"}</span>`;
  $("#vScale").onchange = e => { app.prefs.scale = e.target.value; app.savePrefs(); };
  $("#vFit").onclick = () => (app.elevSide ? app.elev.fit() : app.plan.fit(app.plan.contentBox()));
  $("#vUnder").onchange = e => { app.prefs.underlay = e.target.checked; app.savePrefs(); app.redraw(); };
  $("#vLive").onchange = e => setLive3D(e.target.checked);
  const vs = app.prefs.visual || "shaded";
  $("#bar3d").innerHTML = `<label>Visual style <select id="vStyle">${[["wire", "Wireframe"], ["hidden", "Hidden Line"], ["shaded", "Shaded"], ["consistent", "Consistent Colours"], ["realistic", "Realistic"]].map(([k, v]) => `<option value="${k}"${k === vs ? " selected" : ""}>${v}</option>`).join("")}</select></label>
    <button type="button" id="v3Fit">Zoom to fit</button>
    <details class="lvpick"><summary>Levels</summary><div>${LV.sorted(app.doc).map(l => `<label><input type="checkbox" data-l3="${l.id}"${(app.prefs.hidden3D || []).includes(l.id) ? "" : " checked"}> ${esc(l.name)}</label>`).join("")}</div></details>
    <button type="button" data-corner="sw">SW</button><button type="button" data-corner="se">SE</button><button type="button" data-corner="ne">NE</button><button type="button" data-corner="nw">NW</button><button type="button" data-corner="top">Top</button>`;
  $("#vStyle").onchange = e => { app.prefs.visual = e.target.value; app.savePrefs(); app.view3d.style = e.target.value; app.view3d.invalidate(); };
  $("#v3Fit").onclick = () => fit3D();
  $("#bar3d").querySelectorAll("[data-l3]").forEach(c => c.onchange = () => {
    app.prefs.hidden3D = [...$("#bar3d").querySelectorAll("[data-l3]")].filter(x => !x.checked).map(x => x.dataset.l3);
    app.savePrefs(); app.redraw(true);
  });
  $("#bar3d").querySelectorAll("[data-corner]").forEach(b => b.onclick = () => app.view3d.lookFrom(b.dataset.corner));
  // section box: one slider per face, within the model's extent plus a margin
  const sb = app.prefs.sectionBox;
  if (sb) {
    const full = modelBoxMm(app.view3d), lim = k => ({ min: Math.min(full[k[0] + "0"], sb[k[0] + "0"]) - 2000, max: Math.max(full[k[0] + "1"], sb[k[0] + "1"]) + 2000 });
    const faces = [["x0", "West"], ["x1", "East"], ["y0", "South"], ["y1", "North"], ["z0", "Bottom"], ["z1", "Top"]];
    const div = document.createElement("details"); div.className = "lvpick sk-sbox"; div.open = !!app.sbOpen;
    div.ontoggle = () => { app.sbOpen = div.open; };
    div.innerHTML = `<summary>Section Box</summary><div>${faces.map(([k, n]) => { const L = lim(k); return `<label>${n} <input type="range" data-sb="${k}" min="${L.min}" max="${L.max}" step="50" value="${sb[k]}"></label>`; }).join("")}<button type="button" id="sbReset">Reset</button><button type="button" id="sbOff">Off</button></div>`;
    $("#bar3d").appendChild(div);
    div.querySelectorAll("[data-sb]").forEach(r => r.oninput = () => {
      const k = r.dataset.sb, v = +r.value, other = k.endsWith("0") ? k[0] + "1" : k[0] + "0", box = { ...app.prefs.sectionBox };
      box[k] = k.endsWith("0") ? Math.min(v, box[other] - 100) : Math.max(v, box[other] + 100);
      app.prefs.sectionBox = app.prefs.sectionBoxMm = box; applySectionBox(app.view3d, box);
    });
    div.querySelectorAll("[data-sb]").forEach(r => r.onchange = () => app.savePrefs());
    $("#sbReset").onclick = () => { app.prefs.sectionBox = app.prefs.sectionBoxMm = modelBoxMm(app.view3d); app.savePrefs(); applySectionBox(app.view3d, app.prefs.sectionBox); renderViewBars(); };
    $("#sbOff").onclick = () => toggleSectionBox(false);
  }
  // the bar scrolls sideways on small screens, which would clip these drop-downs: show them fixed above their button
  $("#bar3d").querySelectorAll("details.lvpick").forEach(dt => {
    const place = () => {
      const panel = dt.querySelector(":scope > div"); if (!dt.open || !panel) return;
      const r = dt.querySelector("summary").getBoundingClientRect();
      Object.assign(panel.style, { position: "fixed", bottom: `${window.innerHeight - r.top + 6}px`, top: "auto", left: "auto", right: "auto", zIndex: 40 });
      const w = panel.offsetWidth;
      panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    };
    dt.addEventListener("toggle", place); place();
  });
}

function setLayout(layout) {
  app.prefs.layout = layout; app.savePrefs();
  const v = $("#views"); v.classList.remove("tile", "plan-only", "three-only"); v.classList.add(layout);
  // Live 3D is off when only the plan shows: the 3D view stops rebuilding while you draw
  const live = layout !== "plan-only";
  if (!!app.view3d.paused === live) { app.view3d.paused = !live; if (live) { app.view3d.invalidate(); app.view3d.resize(); } }
  const t = $("#vLive"); if (t) t.checked = live;
}
function setLive3D(on) {
  if (on) setLayout(app.prefs.lastLayout && app.prefs.lastLayout !== "plan-only" ? app.prefs.lastLayout : "tile");
  else { if (app.prefs.layout !== "plan-only") app.prefs.lastLayout = app.prefs.layout; setLayout("plan-only"); }
  app.toast(on ? "Live 3D on: the 3D view follows every change." : "Live 3D off: the plan uses the whole width. Turn it on again any time.");
}
app.setLive3D = setLive3D;

// --------------------------------------------------------------------------- full screen
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
function toggleFullScreen() {
  const root = document.documentElement;
  if (fsEl()) { (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); return; }
  const req = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!req) { app.toast("This browser cannot go full screen from the page. Use its own full-screen option (on iPad: Share > Add to Home Screen).", true); return; }
  try { const r = req.call(root, { navigationUI: "hide" }); if (r?.catch) r.catch(() => app.toast("The browser did not allow full screen just now. Try the button again.", true)); }
  catch { app.toast("The browser did not allow full screen just now. Try the button again.", true); }
}
app.toggleFullScreen = toggleFullScreen;
const syncFull = () => { const on = !!fsEl(), b = $("#viewFull"); b.title = on ? "Exit full screen (Esc)" : "Full screen (FS). Esc leaves it."; b.setAttribute("aria-label", on ? "Exit full screen" : "Full screen"); b.classList.toggle("on", on); document.body.classList.toggle("sk-full", on); renderRibbon(); };
document.addEventListener("fullscreenchange", syncFull); document.addEventListener("webkitfullscreenchange", syncFull);
$("#viewFull").onclick = toggleFullScreen;

/** Zoom to fit in 3D, and when nothing can be seen, say why and put it right. */
function fit3D() {
  const v3 = app.view3d;
  if (v3.paused) setLive3D(true);
  if (v3.dirty) { v3.dirty = false; v3.rebuild(); }
  const hidden = app.prefs.hidden3D || [];
  if (hidden.length && app.doc.levels.every(l => hidden.includes(l.id))) { app.prefs.hidden3D = []; app.savePrefs(); v3.rebuild(); renderViewBars(); app.toast("Every level was hidden in 3D: all levels are shown again."); }
  const sb = app.prefs.sectionBox;
  if (sb) { // a section box that misses the model cuts everything away: fit it to the model
    const m = modelBoxMm(v3), misses = sb.x1 < m.x0 || sb.x0 > m.x1 || sb.y1 < m.y0 || sb.y0 > m.y1 || sb.z1 < m.z0 || sb.z0 > m.z1;
    if (misses) { app.prefs.sectionBox = app.prefs.sectionBoxMm = m; app.savePrefs(); applySectionBox(v3, m); renderViewBars(); app.toast("The section box was away from the model: it now fits the model."); }
  }
  let n = 0; v3.root.traverse(o => { if (o.isMesh) n++; });
  if (!n && app.doc.walls.length + app.doc.floors.length + app.doc.roofs.length + app.doc.components.length) app.toast("Nothing can be shown in 3D on the levels ticked under Levels.", true);
  v3.fit();
}
app.fit3D = fit3D;
function zoomFit() {
  if (app.prefs.layout !== "three-only") { if (app.elevSide) app.elev.fit(); else app.plan.fit(app.plan.contentBox()); }
  if (app.prefs.layout !== "plan-only") fit3D();
}

// --------------------------------------------------------------------------- status bar
function setPrompt() {
  $("#statusPrompt").textContent = app.tool?.prompt?.() || "Ready";
  const ov = app.snapOverride;
  $("#statusSnap").textContent = ov ? `Next pick: ${ov === "off" ? "snaps off" : ov}` : "";
  const t = $("#statusTyped"); t.hidden = !app.typed; t.textContent = app.typed ? `${app.typed} mm  ⏎` : "";
}

// --------------------------------------------------------------------------- editing commands
function deleteSelection() {
  const ids = [...app.selection].filter(id => app.lookup(id));
  if (!ids.length) { app.toast("Select something to delete."); return; }
  const pinned = ids.filter(id => app.lookup(id).pinned);
  if (pinned.length) { app.toast("Pinned elements cannot be deleted. Unpin them first.", true); return; }
  app.commit("Delete", doc => {
    doc.lines = doc.lines.filter(l => !ids.includes(l.id));
    doc.walls = doc.walls.filter(w => !ids.includes(w.id));
    doc.floors = doc.floors.filter(f => !ids.includes(f.id));
    doc.roofs = doc.roofs.filter(r => !ids.includes(r.id));
    doc.dimensions = doc.dimensions.filter(d => !ids.includes(d.id));
    doc.texts = doc.texts.filter(t => !ids.includes(t.id));
    doc.components = doc.components.filter(c => !ids.includes(c.id));
    doc.referencePlanes = doc.referencePlanes.filter(r => !ids.includes(r.id));
    doc.openings = doc.openings.filter(o => !ids.includes(o.id) && !ids.includes(o.hostWallId));
    doc.tags = doc.tags.filter(t => !ids.includes(t.id) && doc.openings.some(o => o.id === t.hostId));
    doc.constraints = (doc.constraints || []).filter(k => !ids.includes(k.ref) && !ids.includes(k.el));
  });
  app.selection.clear(); app.selectionChanged();
}
function setPinned(on) {
  const ids = [...app.selection].filter(id => app.lookup(id)?.shape);
  if (!ids.length) { app.toast("Select walls or lines first."); return; }
  app.commit(on ? "Pin" : "Unpin", doc => { for (const id of ids) { const el = findById(doc, id).el; if (on) el.pinned = true; else delete el.pinned; } });
  app.toast(on ? `Pinned ${ids.length}: they cannot be moved or deleted until unpinned (UP).` : `Unpinned ${ids.length}.`);
}
function undo() { const l = app.history.undo(); if (l) app.toast(`Undone: ${l}`); else app.toast("Nothing to undo."); }
function redo() { const l = app.history.redo(); if (l) app.toast(`Redone: ${l}`); else app.toast("Nothing to redo."); }

app.history.onChange(info => {
  // drop selections of elements that no longer exist
  for (const id of [...app.selection]) if (!app.lookup(id)) app.selection.delete(id);
  app.geomVer++;
  if (info.kind === "reset") return;
  app.redraw(true); app.elev?.invalidate();
  renderProps(); renderRibbon(); setPrompt();
  if (info.ops?.some(o => o.k === "levels")) { if (!app.doc.levels.some(l => l.id === app.levelId)) app.levelId = LV.sorted(app.doc)[0].id; renderBrowser(); renderViewBars(); setTitle(); }
  if (info.ops?.some(o => o.op === "doc")) $("#projName").value = app.doc.name;
  app.store.changed();
});

// --------------------------------------------------------------------------- pointer input on the plan
const canvas = $("#planCanvas");
let pan = null, spaceDown = false, touches = new Map(), pinch = null, longPress = 0, lastMiddle = 0;

function pickContext(ev) {
  const r = canvas.getBoundingClientRect();
  const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
  const raw = app.plan.toModel(sx, sy);
  let pt = { x: raw.x, y: raw.y }, snap = null;
  const tool = app.tool;
  const wants = tool.wantsSnap && (tool.wantsSnapNow ?? true);
  const from = tool.constrainFrom?.() || null;
  if (wants) {
    let curves = app.snapCurves();
    if (app.excludeFromSnap) curves = curves.filter(c => !app.excludeFromSnap.has(c.id));
    snap = findSnap(raw, curves, { radius: app.plan.px(10), from, enabled: app.snapsEnabled, override: app.snapOverride, grid: app.snapsEnabled.has("grid") ? gridStep() : 0 });
    if (snap) pt = snap.point;
    if (from && (!snap || snap.kind === "nearest" || snap.kind === "grid")) {
      const q = G.constrainAngle(from, raw, { ortho: ev.shiftKey });
      if (q.angleSnapped) { pt = { x: q.x, y: q.y }; snap = null; }
    }
    if (!snap) pt = { x: Math.round(pt.x), y: Math.round(pt.y) };
  }
  app.snap = snap;
  return { ev, sx, sy, raw, pt, snap };
}
function gridStep() { const steps = [100, 500, 1000, 5000]; return steps.find(s => s * app.plan.s >= 30) || 5000; }

canvas.addEventListener("contextmenu", e => e.preventDefault());
canvas.addEventListener("dblclick", () => {
  const h = app.hoverId;
  if (app.tool.name === "select" && h && app.doc.floors.some(f => f.id === h)) startFloorSketch(app, h);
  if (app.tool.name === "select" && h && app.doc.roofs.some(r => r.id === h)) editRoof(app, ui, h);
  const comp = h && app.doc.components.find(c => c.id === h && (c.kind === "extrusion" || c.kind === "sweep"));
  if (app.tool.name === "select" && comp) startComponentSketch(app, comp.kind, { editId: comp.id });
});
canvas.addEventListener("pointerdown", ev => {
  canvas.focus();
  canvas.setPointerCapture(ev.pointerId);
  if (ev.pointerType === "touch") {
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (touches.size === 2) { app.tool.cancelDrag?.(); clearTimeout(longPress); const [a, b] = [...touches.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; return; }
    const c = pickContext(ev);
    longPress = setTimeout(() => { touches.clear(); app.tool.cancelDrag?.(); openContextMenu(ev.clientX, ev.clientY); }, 600);
    // one finger on empty space in Modify pans
    if (app.tool.name === "select" && !app.hoverList.length) { app.updateHover(c); if (!app.hoverId) { pan = { x: ev.clientX, y: ev.clientY, touch: true }; return; } }
    app.tool.down(c);
    return;
  }
  if (ev.button === 1 || (ev.button === 0 && spaceDown)) {
    if (ev.button === 1 && performance.now() - lastMiddle < 350) { zoomFit(); lastMiddle = 0; return; }
    if (ev.button === 1) lastMiddle = performance.now();
    pan = { x: ev.clientX, y: ev.clientY, moved: false }; if (spaceDown) app.spacePanned = true; canvas.classList.add("pan"); ev.preventDefault(); return;
  }
  if (ev.button === 2) { pan = { x: ev.clientX, y: ev.clientY, right: true, moved: false }; return; }
  const r = canvas.getBoundingClientRect();
  const hit = app.plan.hitLabel(ev.clientX - r.left, ev.clientY - r.top);
  // open the box after the browser has finished moving focus for this click
  if (hit) { ev.preventDefault(); setTimeout(() => hit.onClick(hit), 0); return; }
  const c = pickContext(ev);
  app.tool.down(c);
  if (app.snapOverride && app.tool.name !== "select") { app.snapOverride = null; }
  setPrompt(); renderOptions(); app.redraw();
});

canvas.addEventListener("pointermove", ev => {
  if (ev.pointerType === "touch" && touches.has(ev.pointerId)) {
    const prev = touches.get(ev.pointerId);
    if (Math.hypot(ev.clientX - prev.x, ev.clientY - prev.y) > 6) clearTimeout(longPress);
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch && touches.size === 2) {
      const [a, b] = [...touches.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const r = canvas.getBoundingClientRect();
      app.plan.panBy(mx - pinch.mx, my - pinch.my);
      app.plan.zoomAt(mx - r.left, my - r.top, d / pinch.d);
      pinch = { d, mx, my };
      return;
    }
  }
  if (pan) {
    const dx = ev.clientX - pan.x, dy = ev.clientY - pan.y;
    if (pan.right && Math.hypot(dx, dy) < 4) return;
    pan.moved = true; app.plan.panBy(dx, dy); pan.x = ev.clientX; pan.y = ev.clientY; canvas.classList.add("pan");
    return;
  }
  const c = pickContext(ev);
  app.lastPointer = { x: c.sx, y: c.sy };
  $("#statusXY").textContent = `X ${Math.round(c.pt.x)}  Y ${Math.round(c.pt.y)}`;
  app.tool.move(c);
  if (!app.tool.wantsSnap) app.snap = null;
  setPrompt();
  app.redraw();
});

function endPointer(ev) {
  if (ev.pointerType === "touch") { touches.delete(ev.pointerId); clearTimeout(longPress); if (touches.size < 2) pinch = null; }
  if (pan) {
    const wasRight = pan.right && !pan.moved;
    pan = null; canvas.classList.remove("pan");
    if (wasRight) openContextMenu(ev.clientX, ev.clientY);
    return;
  }
  if (ev.type === "pointercancel") { app.tool.cancelDrag?.(); return; }
  app.tool.up?.(pickContext(ev));
  setPrompt();
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("pointerleave", () => { app.snap = null; app.redraw(); });
canvas.addEventListener("wheel", ev => {
  ev.preventDefault();
  const r = canvas.getBoundingClientRect();
  app.plan.zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * (ev.deltaMode ? 0.05 : 0.0015)));
}, { passive: false });

// --------------------------------------------------------------------------- keyboard
let keyBuf = "", keyTimer = 0;
document.addEventListener("keydown", ev => {
  const t = ev.target;
  const typing = t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
  if (!$("#askWrap").hidden) return;
  if (!$("#dialogWrap").hidden) { if (ev.key === "Escape") closeDialog(); return; }
  if (typing) { if (ev.key === "Escape") t.blur(); return; }
  const k = ev.key, ctrl = ev.ctrlKey || ev.metaKey;
  if (ctrl && k.toLowerCase() === "z" && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
  if (ctrl && (k.toLowerCase() === "y" || (k.toLowerCase() === "z" && ev.shiftKey))) { ev.preventDefault(); redo(); return; }
  if (ctrl && k.toLowerCase() === "s") { ev.preventDefault(); app.store.save(); return; }
  if (ctrl) return;
  if (app.tool.key?.(ev)) { ev.preventDefault(); return; }
  if (k === " ") { spaceDown = true; ev.preventDefault(); return; }
  if (k === "Escape") {
    hideMenu();
    if (app.typed) { app.typed = ""; setPrompt(); return; }
    if (app.snapOverride) { app.snapOverride = null; setPrompt(); return; }
    if (!app.tool.escape()) { if (app.tool.name !== "select") app.setTool("select"); else if (app.sketch) app.toast("Choose Finish Edit Mode or Cancel Edit Mode to leave the sketch."); }
    app.toolChanged();
    return;
  }
  if (k === "Tab") {
    ev.preventDefault();
    if (app.hoverList.length > 1) { app.tabAt = app.lastPointer; app.hoverIdx = (app.hoverIdx + 1) % app.hoverList.length; app.hoverId = app.hoverList[app.hoverIdx]; app.redraw(); app.toast(`${app.hoverIdx + 1} of ${app.hoverList.length} under the cursor`); }
    return;
  }
  const canType = app.tool.hasFrom?.();
  if (canType && /^[0-9.]$/.test(k)) { app.typed += k; setPrompt(); ev.preventDefault(); return; }
  if (k === "Backspace" && app.typed) { app.typed = app.typed.slice(0, -1); setPrompt(); ev.preventDefault(); return; }
  if (k === "Enter" && app.typed) {
    const v = parseFloat(app.typed); app.typed = "";
    if (!app.tool.typed?.(v)) app.toast("Type a value more than 0.");
    setPrompt(); app.redraw(); ev.preventDefault(); return;
  }
  if (k === "Delete" || k === "Backspace") { if (app.tool.name === "select") { ev.preventDefault(); deleteSelection(); } return; }
  if (/^[a-zA-Z]$/.test(k)) {
    ev.preventDefault(); // a shortcut that opens a dialog must not also type its letter into it
    keyBuf += k.toUpperCase();
    clearTimeout(keyTimer); keyTimer = setTimeout(() => { keyBuf = ""; }, 1500);
    if (OVERRIDES[keyBuf]) { app.snapOverride = OVERRIDES[keyBuf]; keyBuf = ""; setPrompt(); app.toast(app.snapOverride === "off" ? "Snaps off for the next pick." : `Next pick snaps to: ${app.snapOverride}.`); return; }
    if (SHORTCUTS[keyBuf]) { const it = SHORTCUTS[keyBuf]; keyBuf = ""; runItem(it); return; }
    const prefix = Object.keys(SHORTCUTS).concat(Object.keys(OVERRIDES)).some(s => s.startsWith(keyBuf));
    if (!prefix) keyBuf = k.toUpperCase();
  }
});
document.addEventListener("keyup", ev => {
  if (ev.key !== " ") return;
  spaceDown = false;
  if (app.spacePanned) { app.spacePanned = false; return; }
  const ops = [...app.selection].filter(id => app.doc.openings.some(o => o.id === id));
  if (app.tool.name === "select" && ops.length) app.commit("Flip facing", doc => ops.forEach(id => { const o = doc.openings.find(x => x.id === id); o.flipFacing = !o.flipFacing; }));
});

// --------------------------------------------------------------------------- right-click menu
function openContextMenu(x, y) {
  const m = $("#ctxMenu");
  const last = app.lastTool && ALL_ITEMS.find(i => i.tool === app.lastTool);
  const items = [
    { label: "Cancel", key: "Esc", run: () => { if (!app.tool.escape()) app.setTool("select"); app.toolChanged(); } },
    { label: last ? `Repeat [${last.label}]` : "Repeat last command", key: "Enter", disabled: !last, run: () => app.setTool(app.lastTool) },
    { label: "Zoom to Fit", key: "ZF", run: () => zoomFit() },
    ...(app.selection.size ? [{ label: "Delete", key: "DE", run: () => deleteSelection() }] : []),
    { label: "Undo", key: "Ctrl+Z", disabled: !app.history.canUndo(), run: undo },
  ];
  m.innerHTML = items.map((it, i) => `<button type="button" role="menuitem" data-i="${i}"${it.disabled ? " disabled" : ""}><span>${esc(it.label)}</span><kbd>${esc(it.key)}</kbd></button>`).join("");
  m.querySelectorAll("button").forEach(b => b.onclick = () => { hideMenu(); items[+b.dataset.i].run(); });
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`; m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  m.querySelector("button:not(:disabled)")?.focus();
}
function hideMenu() { $("#ctxMenu").hidden = true; }
document.addEventListener("pointerdown", e => { if (!$("#ctxMenu").contains(e.target)) hideMenu(); });

// --------------------------------------------------------------------------- dialogs
function openDialog(html, wire) {
  $("#dialog").innerHTML = html; $("#dialogWrap").hidden = false;
  wire?.($("#dialog"));
  $("#dialog").querySelector("input, button")?.focus();
}
function closeDialog() { $("#dialogWrap").hidden = true; $("#planCanvas").focus(); }

/** In-page confirmation (browser confirm boxes are not used): resolves true or false. */
app.ask = (message, okLabel = "OK") => new Promise(resolve => {
  const w = $("#askWrap"), box = $("#ask");
  box.innerHTML = `<p style="color:var(--ink)">${esc(message)}</p><div class="actions"><button class="btn" type="button" id="askNo">Cancel</button><button class="btn primary" type="button" id="askYes">${esc(okLabel)}</button></div>`;
  w.hidden = false;
  const done = v => { w.hidden = true; document.removeEventListener("keydown", key, true); resolve(v); };
  const key = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); done(false); } };
  document.addEventListener("keydown", key, true);
  box.querySelector("#askNo").onclick = () => done(false);
  box.querySelector("#askYes").onclick = () => done(true);
  box.querySelector("#askYes").focus();
});
/** In-page text question: resolves the text, or null when cancelled. */
app.askText = (label, value = "") => new Promise(resolve => {
  const w = $("#askWrap"), box = $("#ask");
  box.innerHTML = `<label style="display:grid;gap:6px"><span>${esc(label)}</span><input type="text" class="wide" id="askIn" maxlength="80" value="${esc(value)}"></label><div class="actions"><button class="btn" type="button" id="askNo">Cancel</button><button class="btn primary" type="button" id="askYes">OK</button></div>`;
  w.hidden = false;
  const inp = box.querySelector("#askIn");
  const done = v => { w.hidden = true; resolve(v); };
  inp.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); done(inp.value.trim() || null); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); } };
  box.querySelector("#askNo").onclick = () => done(null);
  box.querySelector("#askYes").onclick = () => done(inp.value.trim() || null);
  inp.focus(); inp.select();
});
$("#dialogWrap").addEventListener("pointerdown", e => { if (e.target === $("#dialogWrap")) closeDialog(); });

function snapsDialog() {
  const names = { endpoint: "Endpoints", midpoint: "Midpoints", intersection: "Intersections", centre: "Centres", perpendicular: "Perpendicular", tangent: "Tangents", nearest: "Nearest", grid: "Grid" };
  openDialog(`<h3>Snaps</h3><p>Turn snaps on or off. For one pick only, type SE, SM, SI, SC, SP, ST, SN, or SO for no snap.</p>
    ${SNAP_KINDS.map(k => `<label class="chk"><input type="checkbox" data-k="${k}"${app.snapsEnabled.has(k) ? " checked" : ""}> ${names[k]}</label>`).join("")}
    <div class="actions"><button class="btn" type="button" id="dOff">Snaps off</button><button class="btn" type="button" id="dAll">All on</button><button class="btn primary" type="button" id="dOk">Done</button></div>`, d => {
    const sync = () => { app.snapsEnabled = new Set([...d.querySelectorAll("[data-k]")].filter(c => c.checked).map(c => c.dataset.k)); app.prefs.snaps = [...app.snapsEnabled]; app.savePrefs(); renderViewBars(); };
    d.querySelectorAll("[data-k]").forEach(c => c.onchange = sync);
    d.querySelector("#dOff").onclick = () => { d.querySelectorAll("[data-k]").forEach(c => { c.checked = false; }); sync(); };
    d.querySelector("#dAll").onclick = () => { d.querySelectorAll("[data-k]").forEach(c => { c.checked = true; }); sync(); };
    d.querySelector("#dOk").onclick = closeDialog;
  });
}

function unitsDialog() {
  openDialog(`<h3>Project Units</h3><p>Lengths are in millimetres (for example 3600). Levels show in metres with 3 decimals (for example +3.000). Angles in degrees.</p>
    <table><tr><th>Discipline</th><th>Unit</th><th>Example</th></tr><tr><td>Length</td><td>Millimetres</td><td>3600</td></tr><tr><td>Level</td><td>Metres</td><td>+3.000</td></tr><tr><td>Angle</td><td>Degrees</td><td>30°</td></tr><tr><td>Slope</td><td>Degrees or rise/run</td><td>30° or 1:2</td></tr></table>
    <div class="actions"><button class="btn primary" type="button" id="dOk">Close</button></div>`, d => { d.querySelector("#dOk").onclick = closeDialog; });
}

function shortcutsDialog() {
  const rows = ALL_ITEMS.filter(i => i.key).map(i => `<tr><td>${esc(i.key)}</td><td>${esc(i.label)}</td><td>${i.soon ? esc(i.soon) : "Ready"}</td></tr>`).join("");
  openDialog(`<h3>Keyboard Shortcuts</h3><p>Type the letters with no modifier keys, as in your modelling software.</p>
    <table><tr><th>Keys</th><th>Command</th><th></th></tr>${rows}
    <tr><td>SE SM SI SC SP ST SN</td><td>Snap override for one pick</td><td>Ready</td></tr><tr><td>SO</td><td>No snap for one pick</td><td>Ready</td></tr>
    <tr><td>Ctrl+Z / Ctrl+Y</td><td>Undo / Redo</td><td>Ready</td></tr><tr><td>Shift</td><td>Hold to draw at 0 or 90 degrees</td><td>Ready</td></tr>
    <tr><td>Tab</td><td>Cycle overlapping elements</td><td>Ready</td></tr><tr><td>Esc</td><td>Once ends the chain, twice leaves the tool</td><td>Ready</td></tr>
    <tr><td>Wheel / middle drag / Space+drag</td><td>Zoom / pan / pan</td><td>Ready</td></tr><tr><td>Double-click wheel</td><td>Zoom to fit</td><td>Ready</td></tr></table>
    <div class="actions"><button class="btn primary" type="button" id="dOk">Close</button></div>`, d => { d.querySelector("#dOk").onclick = closeDialog; });
}

async function openDialogList() {
  let rows;
  try { rows = await app.store.list(); }
  catch (err) { app.toast(err.status === 401 ? "Sign in on the studio page to open sketches from your account." : err.message, true); return; }
  openDialog(`<h3>Open a sketch</h3><p>Sketches saved to your account.</p>
    <div class="list">${rows.length ? rows.map(r => `<button type="button" data-id="${esc(r.id)}"><span>${esc(r.name)}</span><small>${new Date(r.updated_at).toLocaleString()}</small></button>`).join("") : `<p>No saved sketches yet.</p>`}</div>
    <div class="actions"><button class="btn" type="button" id="dCancel">Cancel</button></div>`, d => {
    d.querySelector("#dCancel").onclick = closeDialog;
    d.querySelectorAll("[data-id]").forEach(b => b.onclick = async () => {
      closeDialog();
      try { const r = await app.store.open(b.dataset.id); if (r.recovered) app.toast("Recovered your newer changes from this browser."); }
      catch (err) { app.toast(err.message, true); }
    });
  });
}

// --------------------------------------------------------------------------- file buttons
$("#projName").addEventListener("change", e => {
  const v = e.target.value.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!v) { e.target.value = app.doc.name; return; }
  app.commit("Rename", doc => { doc.name = v; });
});
$("#fileNew").onclick = async () => {
  if (app.store.signedIn && app.store.unsaved() && !(await app.ask("Start a new sketch? Changes to this one that are not saved to your account yet will be lost.", "Start new"))) return;
  app.store.startNew(newProject());
};
$("#fileOpen").onclick = openDialogList;
$("#fileSave").onclick = () => app.store.save();
$("#fileCopy").onclick = () => app.store.save({ asCopy: true });
$("#fileExport").onclick = () => exportDialog();
function exportDialog() {
  const lvs = LV.sorted(app.doc), scale = app.prefs.exportScale || "100";
  openDialog(`<h3>Export</h3><div class="sk-export">
    <div class="opt"><div><b>Plan sheet</b><small>The floor plan at true scale on the smallest sheet it fits (A4 to A0), with title and scale bar.</small>
      <label>Level <select id="xLevel">${lvs.map(l => `<option value="${esc(l.id)}"${l.id === app.levelId ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select></label>
      <label>Scale <select id="xScale">${["50", "100", "200"].map(s => `<option value="${s}"${s === scale ? " selected" : ""}>1 : ${s}</option>`).join("")}</select></label></div>
      <div><button class="btn" type="button" id="xPng">PNG</button> <button class="btn primary" type="button" id="xPdf">PDF</button></div></div>
    <div class="opt"><div><b>DXF (CAD drawing)</b><small>The chosen level's plan as lines, arcs and text in millimetres; opens in AutoCAD, BricsCAD, LibreCAD and others.</small></div><div><button class="btn" type="button" id="xDxf">DXF</button></div></div>
    <div class="opt"><div><b>3D model (GLB)</b><small>Everything shown in the 3D view (levels you have hidden are left out), with colours. Opens in Blender, Windows 3D Viewer and online viewers.</small></div><div><button class="btn" type="button" id="xGlb">GLB</button></div></div>
    <div class="opt"><div><b>Project file</b><small>The whole sketch, to open again with Import.</small></div><div><button class="btn" type="button" id="xJson">JSON</button></div></div>
    <div class="opt"><div><b>IFC for the studio</b><small>Not available yet: a proper IFC needs walls, slabs, roofs and openings written as building objects, which comes in a later update. Use GLB or DXF for now.</small></div><div><button class="btn" type="button" disabled>IFC</button></div></div>
    <div id="xErr"></div></div><div class="actions"><button class="btn" type="button" id="xClose">Close</button></div>`, d => {
    const name = safeName(app.doc.name), lvId = () => d.querySelector("#xLevel").value, sc = () => +d.querySelector("#xScale").value;
    const lvName = () => safeName(app.doc.levels.find(l => l.id === lvId())?.name);
    const err = e => { d.querySelector("#xErr").innerHTML = `<div class="err">${esc(e.message || String(e))}</div>`; };
    const ok = msg => { d.querySelector("#xErr").innerHTML = ""; app.toast(msg); };
    d.querySelector("#xClose").onclick = closeDialog;
    d.querySelector("#xScale").onchange = e => { app.prefs.exportScale = e.target.value; app.savePrefs(); };
    d.querySelector("#xPng").onclick = async () => { try { const sh = planSheet(app, lvId(), sc()); const blob = await new Promise(r => sh.canvas.toBlob(r, "image/png")); download(blob, `${name} - ${lvName()} 1-${sc()}.png`); ok(`Plan exported: ${sh.paper.name} at 1:${sc()}.`); } catch (e) { err(e); } };
    d.querySelector("#xPdf").onclick = async () => { try { const sh = planSheet(app, lvId(), sc()); download(await pdfFromCanvas(sh.canvas, sh.paper.w, sh.paper.h), `${name} - ${lvName()} 1-${sc()}.pdf`); ok(`PDF exported: ${sh.paper.name} at 1:${sc()}. Print at 100% (actual size) to keep the scale.`); } catch (e) { err(e); } };
    d.querySelector("#xDxf").onclick = () => { try { const r = planDxf(app, lvId()); download(new Blob([r.text], { type: "application/dxf" }), `${name} - ${lvName()}.dxf`); ok(`DXF exported: ${r.counts.lines} lines, ${r.counts.arcs} arcs, ${r.counts.texts} texts, in millimetres.`); } catch (e) { err(e); } };
    d.querySelector("#xGlb").onclick = () => { try { const v3 = app.view3d; if (v3.dirty) { v3.dirty = false; v3.rebuild(); } const r = modelGlb(v3.root, THREE); download(r.blob, `${name}.glb`); ok(`3D model exported: ${r.objects} objects.`); } catch (e) { err(e); } };
    d.querySelector("#xJson").onclick = () => { download(new Blob([JSON.stringify(app.doc, null, 1)], { type: "application/json" }), `${name}.ollic-sketch.json`); ok("Project file exported."); };
  });
}
$("#fileImport").onclick = () => $("#importInput").click();
$("#importInput").onchange = async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try { const doc = normalize(JSON.parse(await f.text())); app.store.startNew(doc); app.toast(`Opened ${doc.name}. Save to keep it in your account.`); }
  catch (err) { app.toast(err instanceof SyntaxError ? "That file is not readable JSON." : err.message, true); }
};

// --------------------------------------------------------------------------- start
function renderAll() { renderRibbon(); renderOptions(); renderProps(); renderBrowser(); renderViewBars(); setPrompt(); setTitle(); }

app.store = new Store(app);
app.setTool("select");
setLayout(app.prefs.layout || "tile");
renderAll();
window.__sketch = app; // test hook: lets the browser tests read the model

(async () => {
  await start();
  app.ready = true;
})();

async function start() {
  await app.store.init();
  const id = new URLSearchParams(location.search).get("id");
  if (id && app.store.signedIn) {
    try { const r = await app.store.open(id); if (r.recovered) app.toast("Recovered your newer changes from this browser."); return; }
    catch (err) { app.toast(`Could not open that sketch: ${err.message}`, true); }
  }
  const local = readLocal();
  if (local?.doc) {
    try {
      const doc = normalize(local.doc);
      app.store.cloudId = local.cloudId || null;
      app.loadDoc(doc);
      if (local.cloudVersionSaved && app.store.cloudId) app.store.cloudSavedVersion = app.history.version;
      app.store.render();
      if (doc.lines.length || doc.walls.length) app.toast("Your last sketch was restored from this browser.");
      return;
    } catch { /* fall through to a new sketch */ }
  }
  app.loadDoc(newProject());
}

export { app };
