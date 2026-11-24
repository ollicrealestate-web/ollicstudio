// Finishing details in the workspace: their plan outlines, 3D, Properties, and the Finishing ribbon dialogs (made
// from the same command definitions the assistant uses, so hand use and assistant use are the same commands).
import * as G from "./geom.js";
import { COLORS } from "./plan.js";
import { KINDS, detailParts, detailIfc, claddingParts } from "./details.js";
import { partBoxes } from "./checks.js";
import { TOOL_BY_NAME, runTool } from "./aitools.js";
import { MATERIALS, materialById, matColor, matName } from "./library.js";
import { defaultProfiles } from "./components.js";
import { floorLoops } from "./floors.js";
import { locationPolyline } from "./walls.js";

const DETAIL_COLOR = "#c8ad7f";

// --------------------------------------------------------------------------- plan
export function drawDetails(view, app) {
  for (const d of app.doc.details) {
    if (d.levelId !== app.levelId) continue;
    const sel = app.selection.has(d.id), col = sel ? COLORS.sel : app.hoverId === d.id ? COLORS.hover : DETAIL_COLOR;
    for (const p of detailParts(app.doc, d)) for (const b of partBoxes(p)) { view.polygon(b.poly, sel ? "rgba(59,130,246,.10)" : null, null); for (let i = 0; i < b.poly.length; i++) view.segment(b.poly[i], b.poly[(i + 1) % b.poly.length], col, sel ? 1.6 : 1); }
  }
}
export function detailsAt(app, p, tol) {
  const out = [];
  for (const d of app.doc.details) {
    if (d.levelId !== app.levelId) continue;
    let best = Infinity;
    for (const part of detailParts(app.doc, d)) for (const b of partBoxes(part)) {
      if (G.pointInPolygon(p, b.poly)) best = Math.min(best, tol * 0.85);
      b.poly.forEach((q, i) => { best = Math.min(best, G.projectOnSegment(p, q, b.poly[(i + 1) % b.poly.length]).dist); });
    }
    if (best <= tol) out.push({ id: d.id, d: best + 0.2 });
  }
  return out;
}
export const detailBoxes = (app, levelId) => app.doc.details.filter(d => d.levelId === levelId).flatMap(d => detailParts(app.doc, d).flatMap(partBoxes)).map(b => ({ x0: Math.min(...b.poly.map(q => q.x)), y0: Math.min(...b.poly.map(q => q.y)), x1: Math.max(...b.poly.map(q => q.x)), y1: Math.max(...b.poly.map(q => q.y)) }));

// --------------------------------------------------------------------------- 3D
/** A three.js material for a library material (or colour) in the current visual style. */
export function threeMaterial(THREE, style, m, sel) {
  const lib = materialById(m) || { color: matColor(m) };
  const off = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide };
  const glass = lib.opacity != null && lib.opacity < 1;
  if (style === "hidden") return new THREE.MeshBasicMaterial({ color: 0xf2f2f2, ...off });
  if (style === "clay") return new THREE.MeshStandardMaterial({ color: glass ? 0xe8eef2 : 0xf1efea, roughness: 0.95, transparent: glass, opacity: glass ? 0.45 : 1, ...off });
  const color = sel ? 0x3b82f6 : new THREE.Color(lib.color);
  if (style === "consistent") return new THREE.MeshBasicMaterial({ color, transparent: glass, opacity: lib.opacity ?? 1, ...off });
  return new THREE.MeshStandardMaterial({ color, roughness: lib.roughness ?? 0.85, metalness: lib.metalness ?? 0, transparent: glass, opacity: lib.opacity ?? 1, depthWrite: !glass, emissive: lib.emissive ? new THREE.Color(lib.emissive) : 0x000000, emissiveIntensity: lib.emissive ? 0.8 : 0, ...off });
}
function prismGeo(THREE, poly, z0, z1) {
  const shape = new THREE.Shape(poly.map(p => new THREE.Vector2(p.x / 1000, p.y / 1000)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.0005, (z1 - z0) / 1000), bevelEnabled: false });
  geo.rotateX(-Math.PI / 2); geo.translate(0, z0 / 1000, 0);
  return geo;
}
function sweepGeo(THREE, { rings, closed, prof }) {
  const pos = [], idx = [], m = prof.length;
  rings.forEach(r => r.forEach(q => pos.push(q.x / 1000, q.z / 1000, -q.y / 1000)));
  for (let i = 0; i < rings.length - 1; i++) for (let k = 0; k < m; k++) { const a = i * m + k, b = i * m + ((k + 1) % m), c = (i + 1) * m + k, d = (i + 1) * m + ((k + 1) % m); idx.push(a, c, b, b, c, d); }
  if (!closed) { const tris = THREE.ShapeUtils.triangulateShape(prof.map(p => new THREE.Vector2(p.x, p.y)), []); const last = (rings.length - 1) * m; for (const [a, b, c] of tris) { idx.push(a, c, b); idx.push(last + a, last + b, last + c); } }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
export function buildDetails3D(group, THREE, app, visible) {
  const doc = app.doc, style = app.prefs.visual || "shaded", failed = [];
  const edgeCol = style === "hidden" ? 0x111111 : style === "wire" ? 0xe8e8ec : style === "clay" ? 0x8a8a90 : 0x1b1b20;
  const add = (geo, id, m, sel, edges = true) => {
    if (style !== "wire") { const mesh = new THREE.Mesh(geo, threeMaterial(THREE, style, m, sel)); mesh.userData.id = id; mesh.castShadow = mesh.receiveShadow = style === "realistic" || style === "clay"; group.add(mesh); }
    if (edges) group.add(Object.assign(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: sel && style === "wire" ? 0x3b82f6 : edgeCol, transparent: style === "clay", opacity: style === "clay" ? 0.5 : 1 })), { userData: { id } }));
  };
  for (const d of doc.details) {
    if (visible && !visible.has(d.levelId)) continue;
    if (app.hiddenOption?.(d)) continue;
    const sel = app.selection.has(d.id);
    try { for (const p of detailParts(doc, d)) add(p.poly ? prismGeo(THREE, p.poly, p.z0, p.z1) : sweepGeo(THREE, p.sweep), d.id, p.mat ?? d.args.material, sel); }
    catch (e) { failed.push(`${d.name}: ${e.message}`); }
  }
  // face finishes set on walls: a thin skin in the finish material, part of the wall
  for (const w of doc.walls) {
    if (!w.finishes || (visible && !visible.has(w.baseLevelId))) continue;
    for (const [side, m] of Object.entries(w.finishes)) {
      try { for (const p of claddingParts(doc, [w], { side, t: 3, m })) add(prismGeo(THREE, p.poly, p.z0, p.z1), w.id, m, app.selection.has(w.id), false); } catch { /* skip */ }
    }
  }
  if (failed.length) app.report3DProblems?.(failed);
}

// --------------------------------------------------------------------------- dialogs (from the command definitions)
export const FINISHING = [
  { tool: "add_cladding", label: "Cladding", icon: "wall", hint: "Select walls first." },
  { tool: "add_edge_sweep", label: "Fascia / Edge", icon: "sweep", hint: "Select a floor or roof first." },
  { tool: "add_railing", label: "Railing", icon: "line", hint: "Select a balcony floor first." },
  { tool: "add_fins", label: "Fins / Louvres", icon: "array", hint: "Select walls first." },
  { tool: "add_canopy", label: "Canopy", icon: "roof", hint: "Select a door first." },
  { tool: "add_pergola", label: "Pergola", icon: "rect", hint: "Select a floor (its outline) or model lines for the area." },
  { tool: "add_soffit", label: "Soffit", icon: "floor", hint: "Select a roof or a balcony slab first." },
  { tool: "add_parapet", label: "Edge Parapet", icon: "wall", hint: "Select a floor or roof first." },
  { tool: "add_planter", label: "Planter", icon: "component", hint: "Select model lines (a closed shape) for the outline." },
  { tool: "add_steps", label: "Steps", icon: "levels", hint: "Type where the steps start and which way they rise." },
  { tool: "add_screen", label: "Screen", icon: "tile", hint: "Select a model line for where the screen stands." },
  { tool: "set_material", label: "Material", icon: "types", hint: "Select elements first." },
];
const SKIP = new Set(["plan_item", "reference_image", "reason", "changes"]);
const isMat = k => /material$/.test(k);
const ptText = p => `${Math.round(p.x)}, ${Math.round(p.y)}`;

/** Values taken from the selection to start a dialog with. */
function fromSelection(app, name) {
  const doc = app.doc, sel = [...app.selection].map(id => app.lookup(id)).filter(Boolean);
  const walls = sel.filter(e => doc.walls.includes(e)), floors = sel.filter(e => doc.floors.includes(e)), roofs = sel.filter(e => doc.roofs.includes(e));
  const ops = sel.filter(e => doc.openings.includes(e)), lines = sel.filter(e => doc.lines.includes(e) && e.shape === "line");
  const v = { level_id: app.levelId };
  if (walls.length) { v.wall_ids = walls.map(w => w.id).join(", "); v.wall_id = walls[0].id; v.target_ids = v.wall_ids; v.work_plane = `wall:${walls[0].id}:exterior`; }
  else v.work_plane = `level:${app.levelId}`;
  const hosts = [...floors.map(f => (name === "add_railing" || name === "add_parapet" ? `${f.id}:exposed` : `${f.id}:all`)), ...roofs.map(r => `${r.id}:all`)];
  if (hosts.length) v.edges = hosts.join(", ");
  if (floors[0] || roofs[0]) v.host_id = (roofs[0] || floors[0]).id;
  if (ops[0]) v.opening_id = ops[0].id;
  if (sel.length) v.element_ids = sel.map(e => e.id).join(", ");
  if (lines.length) { const pts = [lines[0].a, ...lines.map(l => l.b)]; v.points = pts.map(ptText).join("; "); v.line = [lines[0].a, lines[0].b].map(ptText).join("; "); v.area = (G.dist(pts[0], pts.at(-1)) < 2 ? pts.slice(0, -1) : pts).map(ptText).join("; "); }
  else if (floors[0]) { const l = floorLoops(floors[0])[0]; if (l) v.area = l.map(ptText).join("; "); }
  if (walls[0] && !lines.length) { const p = locationPolyline(walls[0]); v.line = [p[0], p.at(-1)].map(ptText).join("; "); }
  return v;
}
const levelOpts = (app, v, blank) => (blank ? `<option value="">(any)</option>` : "") + app.doc.levels.map(l => `<option value="${l.id}"${l.id === v ? " selected" : ""}>${app.ui.esc(l.name)}</option>`).join("");

function field(app, k, s, v, required) {
  const esc = app.ui.esc, id = `fd_${k}`, req = required ? "" : ' <span class="opt">(optional)</span>';
  const lab = k.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
  let input;
  if (isMat(k)) input = `<select id="${id}">${required ? "" : `<option value="">(default)</option>`}${MATERIALS.map(m => `<option value="${m.id}"${m.id === v ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select>`;
  else if (k === "profile" || k === "coping_profile") input = `<select id="${id}">${k === "coping_profile" ? `<option value="">(default coping)</option><option value="none"${v === "none" ? " selected" : ""}>None</option>` : ""}${defaultProfiles().filter(p => !p.rect).map(p => `<option value="${p.id}"${p.id === v ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>`;
  else if (k === "level_id" || k === "from_level" || k === "to_level") input = `<select id="${id}">${levelOpts(app, v, !required)}</select>`;
  else if (s.enum) input = `<select id="${id}">${required ? "" : `<option value="">(default)</option>`}${s.enum.map(e => `<option value="${e}"${e === v ? " selected" : ""}>${esc(e.replace(/_/g, " "))}</option>`).join("")}</select>`;
  else if (s.type === "boolean") input = `<input id="${id}" type="checkbox"${v ? " checked" : ""}>`;
  else if (s.type === "number" || s.type === "integer") input = `<input id="${id}" type="number" step="${s.type === "integer" ? 1 : 10}" value="${v ?? ""}" placeholder="${esc(s.description || "")}">`;
  else input = `<input id="${id}" class="wide" value="${esc(v ?? "")}" placeholder="${esc(s.type === "object" ? "level:<level id>  or  wall:<wall id>:exterior" : s.type === "array" && s.items?.type === "array" ? "x, y; x, y; ..." : s.type === "array" && s.items?.type === "number" ? "x, y" : s.type === "array" ? "ids, separated by commas" : "")}">`;
  return `<tr title="${esc(s.description || "")}"><td>${esc(lab)}${req}</td><td>${input}</td></tr>`;
}
const parsePts = t => String(t).split(";").map(x => x.trim()).filter(Boolean).map(x => x.split(",").map(Number));
function readField(d, k, s) {
  const el = d.querySelector(`#fd_${k}`); if (!el) return undefined;
  if (s.type === "boolean") return el.checked || undefined;
  const t = el.value.trim(); if (t === "") return undefined;
  if (s.type === "number" || s.type === "integer") return Number(t);
  if (s.type === "object") { const [kind, id, side] = t.split(":"); return kind === "wall" ? { wall_id: id, side: side || "exterior" } : { level_id: id }; }
  if (s.type === "array") {
    if (s.items?.type === "array" && s.items.items?.type === "array") return t.split("|").map(parsePts); // loops
    if (s.items?.type === "array") return parsePts(t);
    if (s.items?.type === "number") return parsePts(t)[0];
    return t.split(",").map(x => x.trim()).filter(Boolean);
  }
  return t;
}
const toText = (k, s, v) => {
  if (v == null) return v;
  if (s.type === "object") return v.wall_id ? `wall:${v.wall_id}:${v.side || "exterior"}` : `level:${v.level_id}`;
  if (s.type === "array") { if (s.items?.type === "array" && s.items.items?.type === "array") return v.map(l => l.map(p => p.join(", ")).join("; ")).join(" | "); if (s.items?.type === "array") return v.map(p => p.join(", ")).join("; "); if (s.items?.type === "number") return v.join(", "); return v.join(", "); }
  return v;
};

/** Opens the dialog for a finishing command; `editId` edits an existing detail with the same dialog. */
export function finishingDialog(app, name, editId = null) {
  const T = TOOL_BY_NAME[name], ui = app.ui, esc = ui.esc, item = FINISHING.find(f => f.tool === name) || { label: name };
  const editing = editId && app.lookup(editId);
  const props = Object.entries(T.input_schema.properties).filter(([k]) => !SKIP.has(k)), req = new Set(T.input_schema.required || []);
  const start = editing ? Object.fromEntries(props.map(([k, s]) => [k, toText(k, s, editing.args?.[k])])) : fromSelection(app, name);
  ui.openDialog(`<h3>${esc(editing ? `Edit ${editing.name}` : item.label)}</h3><p>${esc(T.description)}${editing ? "" : ` ${item.hint || ""}`}</p>
    <div class="fd-scroll"><table>${props.map(([k, s]) => field(app, k, s, start[k], req.has(k))).join("")}</table></div><div id="fdErr"></div>
    <div class="actions"><button class="btn" type="button" id="fdCancel">Cancel</button><button class="btn primary" type="button" id="fdOk">${editing ? "Apply" : "Add"}</button></div>`, d => {
    d.querySelector("#fdCancel").onclick = ui.closeDialog;
    d.querySelector("#fdOk").onclick = () => {
      const args = {}; for (const [k, s] of props) { const v = readField(d, k, s); if (v !== undefined) args[k] = v; }
      const r = editing ? runTool(app.history, "edit_element", { id: editId, changes: args }, { source: "user" }) : runTool(app.history, name, args, { source: "user" });
      if (!r.ok) { d.querySelector("#fdErr").innerHTML = `<div class="err">${esc(r.error)}</div>`; return; }
      ui.closeDialog(); app.toast(r.message);
      if (r.ids?.length && name !== "set_material") { app.selection = new Set(r.ids); app.selectionChanged?.(); }
    };
  });
}

// --------------------------------------------------------------------------- Properties
const PRETTY = { IFCCOVERING: "IfcCovering", IFCRAILING: "IfcRailing", IFCSHADINGDEVICE: "IfcShadingDevice", IFCMEMBER: "IfcMember", IFCSLAB: "IfcSlab", IFCWALL: "IfcWall", IFCSTAIR: "IfcStair", IFCBUILDINGELEMENTPROXY: "IfcBuildingElementProxy", IFCCOLUMN: "IfcColumn", IFCBEAM: "IfcBeam", IFCPLATE: "IfcPlate" };
export const ifcLabel = ifc => (PRETTY[ifc[0]] || ifc[0]) + (ifc[2] ? ` (${ifc[2]})` : /NOTDEFINED/.test(ifc[1] || "") ? "" : ` (${String(ifc[1]).replace(/\./g, "")})`);
export function detailProps(app, ids, esc) {
  const doc = app.doc, ds = ids.map(id => doc.details.find(d => d.id === id));
  if (ds.length !== 1) return `<div class="pnote">${ds.length} finishing details selected.</div><div class="prow"><span>Material</span><select id="dMat"><option value="">(varies)</option>${MATERIALS.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join("")}</select></div>`;
  const d = ds[0], ifc = detailIfc(d), lv = doc.levels.find(l => l.id === d.levelId);
  return `<div class="ptype"><div class="row"><span>${esc(d.name)}</span><button class="btn" type="button" id="dEdit">Edit</button></div></div>
    <div class="pgroup">Identity Data</div>
    <div class="prow"><span>Kind</span><input readonly value="${esc(KINDS[d.kind]?.label || d.kind)}"></div>
    <div class="prow"><span>IFC class</span><input readonly value="${esc(ifcLabel(ifc))}"></div>
    <div class="prow"><span>Level</span><input readonly value="${esc(lv?.name || "")}"></div>
    <div class="prow"><span>Added by</span><input readonly value="${d.source === "ai" ? `Ollic AI${d.planItem != null ? ` (plan item ${d.planItem})` : ""}` : "You"}"></div>
    <div class="pgroup">Materials and Finishes</div>
    <div class="prow"><span>Material</span><select id="dMat">${MATERIALS.map(m => `<option value="${m.id}"${m.id === d.args.material ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div>
    <div class="pnote">${esc(matName(d.args.material))}. Edit changes its sizes; it follows the walls, floors or roof it is on.</div>`;
}
export function wireDetailProps(app, ids, renderProps) {
  const $ = s => document.querySelector(s);
  const m = $("#dMat"); if (m) m.onchange = () => { if (!m.value) return; const r = runTool(app.history, "set_material", { element_ids: ids, material: m.value }, { source: "user" }); if (!r.ok) app.toast(r.error, true); renderProps(); };
  const e = $("#dEdit"); if (e) e.onclick = () => { const d = app.doc.details.find(x => x.id === ids[0]); const name = Object.keys(TOOL_BY_NAME).find(n => TOOL_BY_NAME[n].kind === d.kind); finishingDialog(app, name, d.id); };
}
