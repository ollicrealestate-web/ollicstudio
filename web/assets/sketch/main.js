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
import { Store, readLocal, readPrefs, writePrefs } from "./store.js";
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
app.redraw = (with3d = false) => { if (with3d) app.geomVer++; app.plan.invalidate(); if (with3d) app.view3d.invalidate(); };
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
  // faces of walls being dragged are left out, so a moving wall does not snap to itself
  const skip = app.excludeFromSnap || new Set();
  const faces = [...fp.entries()].filter(([id]) => !skip.has(id)).flatMap(([, f]) => f.pieces);
  for (const [a, b] of outlineEdges(faces)) out.push({ type: "seg", a, b, id: "face" });
  return out;
};
const JOIN = 2;
/** Moves elements; walls joined to moved walls stretch so the joins hold (as in Revit). */
app.translateWithJoins = (doc, ids, delta) => {
  const set = new Set(ids);
  const moved = doc.walls.filter(w => set.has(w.id) && w.shape === "line");
  const ends = moved.flatMap(w => [w.a, w.b]).map(p => ({ ...p }));
  for (const id of ids) { const el = findById(doc, id)?.el; if (el) translateEl(el, delta); }
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
  const start = app.doc.walls.find(w => w.id === id);
  if (!start) return [];
  const same = app.doc.walls.filter(w => w.baseLevelId === start.baseLevelId);
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
app.drawModel = view => drawWalls(view, app);
app.drawUnderlay = view => drawUnderlay(view, app);
app.build3D = (v3, THREE) => buildWalls3D(v3, THREE, app);
app.extraBoxes = () => [...app.footprints(app.levelId).values()].flatMap(f => f.pieces).map(p => ({ x0: Math.min(...p.map(q => q.x)), y0: Math.min(...p.map(q => q.y)), x1: Math.max(...p.map(q => q.x)), y1: Math.max(...p.map(q => q.y)) }));
app.pick3D = id => { app.selection.clear(); if (id) app.selection.add(id); app.selectionChanged(); };
const ui = { openDialog: (h, w) => openDialog(h, w), closeDialog: () => closeDialog(), esc, ask: (m, ok) => app.ask(m, ok), askText: (l, v) => app.askText(l, v) };
app.toast = (msg, bad = false) => {
  const t = $("#toast"); t.textContent = msg; t.classList.toggle("bad", !!bad); t.classList.add("show");
  clearTimeout(app._toastT); app._toastT = setTimeout(() => t.classList.remove("show"), bad ? 4200 : 2600);
};
app.commit = (label, fn) => {
  try { return app.history.transact(label, fn); }
  catch (err) { app.toast(err.message || "That change could not be made.", true); return undefined; }
};
app.hoverCandidate = () => app.hoverId;
app.selectionChanged = () => { renderProps(); renderOptions(); setPrompt(); app.redraw(true); };
app.toolChanged = () => { renderOptions(); renderProps(); setPrompt(); app.redraw(); };
app.renameSilently = name => { app.doc.name = name; $("#projName").value = name; };
app.visibleLevels3D = () => null;

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
  const list = cands.filter(x => x.d <= tol).sort((a, b) => a.d - b.d).map(x => x.id);
  // Tab can also pick the whole chain of joined walls under the cursor
  const firstWall = list.find(id => app.isWall(id));
  if (firstWall && app.chainOf(firstWall).length > 1) list.push(`chain:${firstWall}`);
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

/** Blue length dimension on one selected straight line; click the number to type a new length. */
app.drawSelectionDims = view => {
  if (app.tool.name !== "select" || app.tool.drag || app.selection.size !== 1) return;
  const el = app.lookup([...app.selection][0]);
  if (el && app.isWall(el.id)) { drawWallDims(view, app, el, inlineEdit); return; }
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
  wall: () => new WallTool(app),
};
app.setTool = name => {
  if (!TOOLS[name]) return;
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
      { id: "door", label: "Door", icon: "door", key: "DR", ...SOON(4) },
      { id: "window", label: "Window", icon: "window", key: "WN", ...SOON(4) },
      { id: "component", label: "Component", icon: "component", ...SOON(6) },
      { id: "floor", label: "Floor", icon: "floor", key: "SB", ...SOON(5) },
      { id: "roof", label: "Roof", icon: "roof", ...SOON(7) },
    ] },
    { label: "Model", items: [{ id: "modelLine", label: "Model Line", icon: "line", key: "LI", tool: "modelLine" }] },
    { label: "Work Plane", items: [{ id: "refPlane", label: "Ref Plane", icon: "section", key: "RP", ...SOON(6) }] },
  ] },
  { tab: "Modify", groups: [
    { label: "Select", items: [{ id: "select", label: "Modify", icon: "modify", key: "MD", tool: "select" }] },
    { label: "Modify", items: [
      { id: "align", label: "Align", icon: "align", key: "AL", ...SOON(3) },
      { id: "offset", label: "Offset", icon: "offset", key: "OF", ...SOON(3) },
      { id: "mirrorPick", label: "Mirror - Pick Axis", icon: "mirror", key: "MM", ...SOON(3) },
      { id: "mirrorDraw", label: "Mirror - Draw Axis", icon: "mirror", key: "DM", ...SOON(3) },
      { id: "move", label: "Move", icon: "move", key: "MV", ...SOON(3) },
      { id: "copy", label: "Copy", icon: "copy", key: "CO", ...SOON(3) },
      { id: "rotate", label: "Rotate", icon: "rotate", key: "RO", ...SOON(3) },
      { id: "trim", label: "Trim/Extend", icon: "trim", key: "TR", ...SOON(3) },
      { id: "split", label: "Split", icon: "split", key: "SL", ...SOON(3) },
      { id: "array", label: "Array", icon: "array", key: "AR", ...SOON(3) },
      { id: "scale", label: "Scale", icon: "scale", key: "RE", ...SOON(3) },
      { id: "chamfer", label: "Chamfer", icon: "chamfer", key: "CH", ...SOON(3) },
      { id: "fillet", label: "Fillet", icon: "fillet", key: "FL", ...SOON(3) },
      { id: "pin", label: "Pin", icon: "pin", key: "PN", ...SOON(3) },
      { id: "delete", label: "Delete", icon: "del", key: "DE", run: () => deleteSelection() },
    ] },
    { label: "Levels", items: [{ id: "copyLevels", label: "Copy to Levels", icon: "levels", run: () => copyToLevelsDialog(app, ui) }] },
    { label: "Undo", items: [
      { id: "undo", label: "Undo", icon: "undo", hint: "Ctrl+Z", run: () => undo() },
      { id: "redo", label: "Redo", icon: "redo", hint: "Ctrl+Y", run: () => redo() },
    ] },
  ] },
  { tab: "Annotate", groups: [
    { label: "Detail", items: [{ id: "detailLine", label: "Detail Line", icon: "detail", key: "DL", tool: "detailLine" }] },
    { label: "Dimension", items: [{ id: "dimAligned", label: "Aligned", icon: "dim", key: "DI", ...SOON(8) }] },
    { label: "Tag", items: [{ id: "tag", label: "Tag", icon: "tag", key: "TG", ...SOON(4) }, { id: "text", label: "Text", icon: "text", key: "TX", ...SOON(8) }] },
  ] },
  { tab: "View", groups: [
    { label: "Create", items: [{ id: "view3d", label: "3D View", icon: "threed", run: () => setLayout("tile") }] },
    { label: "Windows", items: [
      { id: "tile", label: "Tile", icon: "tile", key: "WT", run: () => setLayout("tile") },
      { id: "planOnly", label: "Plan", icon: "plan", run: () => setLayout("plan-only") },
      { id: "threeOnly", label: "3D", icon: "threed", run: () => setLayout("three-only") },
    ] },
    { label: "Navigate", items: [{ id: "zoomFit", label: "Zoom to Fit", icon: "fit", key: "ZF", run: () => zoomFit() }] },
    { label: "Graphics", items: [{ id: "sectionBox", label: "Section Box", icon: "section", key: "BX", ...SOON(8) }] },
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
const ALL_ITEMS = RIBBON.flatMap(t => t.groups.flatMap(g => g.items));
const SHORTCUTS = Object.fromEntries(ALL_ITEMS.filter(i => i.key).map(i => [i.key, i]));
SHORTCUTS.ZE = SHORTCUTS.ZA = SHORTCUTS.ZF;
let ribbonTab = app.prefs.ribbonTab || "Architecture";

function runItem(it) {
  if (it.soon) { app.toast(`${it.label}: ${it.soon.toLowerCase()}.`); return; }
  if (it.tool) app.setTool(it.tool);
  else it.run?.();
}

function renderRibbon() {
  $("#ribbonTabs").innerHTML = RIBBON.map(t => `<button role="tab" type="button" aria-selected="${t.tab === ribbonTab}" data-tab="${t.tab}">${t.tab}</button>`).join("");
  $("#ribbonTabs").querySelectorAll("button").forEach(b => b.onclick = () => { ribbonTab = b.dataset.tab; app.prefs.ribbonTab = ribbonTab; app.savePrefs(); renderRibbon(); });
  const tab = RIBBON.find(t => t.tab === ribbonTab) || RIBBON[0];
  $("#ribbonPanel").innerHTML = tab.groups.map(g => `<div class="sk-group"><div class="items">${g.items.map(it => {
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
      const n = document.createElement("input"); n.type = "number"; n.value = o.value; if (o.min != null) n.min = o.min; if (o.max != null) n.max = o.max; n.step = o.step || 1;
      n.onchange = () => o.onChange(parseFloat(n.value)); lab.append(n);
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
      ${node("Floor Plans", "disabled", "head")}<ul>${lv.map(l => node(`${l.name}  ${levelLabel(l.elevation)}`, `data-level="${l.id}" role="treeitem"`, l.id === app.levelId ? "on" : "")).join("")}</ul>
      ${node("3D Views", "disabled", "head")}<ul>${node("{3D}", `data-view="3d" role="treeitem"`)}</ul>
      ${node("Elevations (Building Elevation)", "disabled", "head")}<ul>${["East", "North", "South", "West"].map(n => node(n, `disabled title="Arrives in phase 8"`)).join("")}</ul>
      ${node("Sheets", "disabled", "head")}
    </ul></ul>`;
  $("#browser").querySelectorAll("[data-level]").forEach(b => b.onclick = () => { setLevel(b.dataset.level); });
  $("#browser").querySelector("[data-view='3d']").onclick = () => { setLayout(app.prefs.layout === "plan-only" ? "tile" : app.prefs.layout || "tile"); app.view3d.fit(); };
}

function setLevel(id) {
  app.levelId = id; app.selection.clear(); app.view3d.invalidate();
  $("#planTitle").textContent = `Floor Plan: ${app.levelName()}`;
  renderBrowser(); app.toolChanged();
}

function renderViewBars() {
  const scale = app.prefs.scale || "100";
  $("#planBar").innerHTML = `<label>Scale <select id="vScale">${["50", "100", "200"].map(s => `<option value="${s}"${s === scale ? " selected" : ""}>1 : ${s}</option>`).join("")}</select></label>
    <button type="button" id="vFit" title="Zoom to fit (ZF)">Zoom to fit</button>
    <label><input type="checkbox" id="vUnder"${app.prefs.underlay ? " checked" : ""}> Underlay: level below</label>
    <span>Snaps: ${app.snapsEnabled.size ? "on" : "off"}</span>`;
  $("#vScale").onchange = e => { app.prefs.scale = e.target.value; app.savePrefs(); };
  $("#vFit").onclick = () => app.plan.fit(app.plan.contentBox());
  $("#vUnder").onchange = e => { app.prefs.underlay = e.target.checked; app.savePrefs(); app.redraw(); };
  const vs = app.prefs.visual || "shaded";
  $("#bar3d").innerHTML = `<label>Visual style <select id="vStyle">${[["wire", "Wireframe"], ["hidden", "Hidden Line"], ["shaded", "Shaded"], ["consistent", "Consistent Colours"], ["realistic", "Realistic"]].map(([k, v]) => `<option value="${k}"${k === vs ? " selected" : ""}>${v}</option>`).join("")}</select></label>
    <button type="button" id="v3Fit">Zoom to fit</button>
    <details class="lvpick"><summary>Levels</summary><div>${LV.sorted(app.doc).map(l => `<label><input type="checkbox" data-l3="${l.id}"${(app.prefs.hidden3D || []).includes(l.id) ? "" : " checked"}> ${esc(l.name)}</label>`).join("")}</div></details>
    <button type="button" data-corner="sw">SW</button><button type="button" data-corner="se">SE</button><button type="button" data-corner="ne">NE</button><button type="button" data-corner="nw">NW</button><button type="button" data-corner="top">Top</button>`;
  $("#vStyle").onchange = e => { app.prefs.visual = e.target.value; app.savePrefs(); app.view3d.style = e.target.value; app.view3d.invalidate(); };
  $("#v3Fit").onclick = () => app.view3d.fit();
  $("#bar3d").querySelectorAll("[data-l3]").forEach(c => c.onchange = () => {
    app.prefs.hidden3D = [...$("#bar3d").querySelectorAll("[data-l3]")].filter(x => !x.checked).map(x => x.dataset.l3);
    app.savePrefs(); app.redraw(true);
  });
  $("#bar3d").querySelectorAll("[data-corner]").forEach(b => b.onclick = () => app.view3d.lookFrom(b.dataset.corner));
}

function setLayout(layout) {
  app.prefs.layout = layout; app.savePrefs();
  const v = $("#views"); v.classList.remove("tile", "plan-only", "three-only"); v.classList.add(layout);
}

function zoomFit() {
  if (app.prefs.layout !== "three-only") app.plan.fit(app.plan.contentBox());
  if (app.prefs.layout !== "plan-only") app.view3d.fit();
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
    doc.openings = doc.openings.filter(o => !ids.includes(o.id) && !ids.includes(o.hostWallId));
  });
  app.selection.clear(); app.selectionChanged();
}
function undo() { const l = app.history.undo(); if (l) app.toast(`Undone: ${l}`); else app.toast("Nothing to undo."); }
function redo() { const l = app.history.redo(); if (l) app.toast(`Redone: ${l}`); else app.toast("Nothing to redo."); }

app.history.onChange(info => {
  // drop selections of elements that no longer exist
  for (const id of [...app.selection]) if (!app.lookup(id)) app.selection.delete(id);
  app.geomVer++;
  if (info.kind === "reset") return;
  app.redraw(true);
  renderProps(); renderRibbon(); setPrompt();
  if (info.ops?.some(o => o.k === "levels")) { if (!app.doc.levels.some(l => l.id === app.levelId)) app.levelId = LV.sorted(app.doc)[0].id; renderBrowser(); renderViewBars(); $("#planTitle").textContent = `Floor Plan: ${app.levelName()}`; }
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
    pan = { x: ev.clientX, y: ev.clientY, moved: false }; canvas.classList.add("pan"); ev.preventDefault(); return;
  }
  if (ev.button === 2) { pan = { x: ev.clientX, y: ev.clientY, right: true, moved: false }; return; }
  const r = canvas.getBoundingClientRect();
  const hit = app.plan.hitLabel(ev.clientX - r.left, ev.clientY - r.top);
  // open the box after the browser has finished moving focus for this click
  if (hit && app.tool.name === "select") { ev.preventDefault(); setTimeout(() => hit.onClick(hit), 0); return; }
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
    if (!app.tool.escape()) { if (app.tool.name !== "select") app.setTool("select"); }
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
document.addEventListener("keyup", ev => { if (ev.key === " ") spaceDown = false; });

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
$("#fileExport").onclick = () => {
  const blob = new Blob([JSON.stringify(app.doc, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `${app.doc.name.replace(/[^\w\- ]+/g, "").trim() || "sketch"}.ollic-sketch.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$("#fileImport").onclick = () => $("#importInput").click();
$("#importInput").onchange = async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try { const doc = normalize(JSON.parse(await f.text())); app.store.startNew(doc); app.toast(`Opened ${doc.name}. Save to keep it in your account.`); }
  catch (err) { app.toast(err instanceof SyntaxError ? "That file is not readable JSON." : err.message, true); }
};

// --------------------------------------------------------------------------- start
function renderAll() { renderRibbon(); renderOptions(); renderProps(); renderBrowser(); renderViewBars(); setPrompt(); $("#planTitle").textContent = `Floor Plan: ${app.levelName()}`; }

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
