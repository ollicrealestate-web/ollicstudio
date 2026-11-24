// The commands the assistant (and the Finishing ribbon) use to add details. Each command checks its input, runs as
// one undoable step, and returns new element ids or a plain-words error. The assistant can change the model only
// through these commands. Rules are enforced here, in code:
//  - elements you drew are locked: the assistant may only add elements, or set materials on yours;
//  - each new element is checked (no blocking openings, no cutting through solids, nothing floating, 40 m limit);
//  - sizes outside the normal range need a reason.
import * as G from "./geom.js";
import { newId, findById, clone } from "./model.js";
import { checkSketch } from "./floors.js";
import { wallHeights } from "./walls.js";
import { defaultProfiles, makeWallSweep, makeExtrusion, wallSweepGeometry, extrusionPrisms, planeExtrusionBands } from "./components.js";
import { KINDS, buildDetail, wallFace, hostEdges } from "./details.js";
import { checkParts, partBoxes, modelSolids, penetration } from "./checks.js";
import { MATERIALS, checkMaterial } from "./library.js";
import { inProposal, proposeMaterial } from "./options.js";
import { modelSummary } from "./summary.js";

const fail = msg => { throw new Error(msg); };

/** Normal sizes (mm). Outside these the assistant must give a reason. */
export const RANGES = {
  railing: { height: [1000, 1100] }, fins: { depth: [100, 600] }, canopy: { depth: [600, 3000], thickness: [75, 300] },
  cladding: { thickness: [10, 150] }, parapet: { height: [450, 1200] }, steps: { riser: [120, 180], tread: [250, 400] },
  pergola: { height: [2200, 3600] }, soffit: { thickness: [10, 50] }, planter: { height: [300, 1200] }, screen: { height: [900, 3000] },
};
function checkRanges(kind, a, ctx) {
  if (ctx.source !== "ai") return;
  for (const [k, [lo, hi]] of Object.entries(RANGES[kind] || {})) {
    if (a[k] == null) continue;
    const v = Number(a[k]);
    if ((v < lo || v > hi) && !(typeof a.reason === "string" && a.reason.trim().length > 3)) fail(`${k} ${v} mm is outside the normal range (${lo}-${hi} mm). Use a normal size, or give a reason.`);
  }
}

// ---- JSON schemas, shared pieces
const mm = d => ({ type: "number", description: `${d} (mm)` });
const ids = d => ({ type: "array", items: { type: "string" }, description: d });
const MAT = { type: "string", description: "Material id from list_materials" };
const PT = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, y] in mm, plan coordinates" };
const EDGES = ids("Floor or roof edges: \"<id>:e<k>\" (numbered as in the model summary), \"<id>:all\", or \"<id>:exposed\" (edges with no wall on or under them, e.g. balcony edges)");
const COMMON = { plan_item: { type: "integer", description: "Plan item number this belongs to" }, reference_image: { type: "integer", description: "Reference image number it comes from" }, reason: { type: "string", description: "Why, when a size is outside the normal range" } };
const tool = (name, description, properties, required = [], extra = {}) => ({ name, description, input_schema: { type: "object", properties: { ...properties, ...(extra.read ? {} : COMMON) }, required }, ...extra });

/** Stamps who made an element. */
function stamp(el, ctx, a) {
  el.source = ctx.source === "ai" ? "ai" : "user";
  if (ctx.session) el.session = ctx.session;
  if (ctx.option) el.option = ctx.option;
  const item = a.plan_item ?? ctx.planItem, img = a.reference_image ?? ctx.refImage;
  if (item != null) el.planItem = item;
  if (img != null) el.refImage = img;
  return el;
}
/** The assistant may change only what it added (in this session). */
function mayChange(el, ctx) {
  if (ctx.source !== "ai") return;
  if (el.source !== "ai") fail(`${el.id} was drawn by you and is locked: Ollic AI can only add elements or set materials. Ask in the chat if it should change.`);
  if (ctx.session && el.session && el.session !== ctx.session) fail(`${el.id} was added in an earlier session; Ollic AI can change only what it added in this session.`);
}
const cleanArgs = a => { const o = { ...a }; for (const k of ["plan_item", "reference_image"]) delete o[k]; return o; };

// ---- components made by commands (wall sweeps, extrusions, voids)
function wallSweepIfc(profileId) {
  if (/coping/.test(profileId)) return ["IFCCOVERING", ".USERDEFINED.", "COPING"];
  if (/fascia/.test(profileId)) return ["IFCCOVERING", ".USERDEFINED.", "FASCIA"];
  return ["IFCCOVERING", ".MOLDING."];
}
const COMPONENT_BUILDERS = {
  add_wall_sweep(doc, a) {
    const wallIds = a.wall_ids || fail("Give wall_ids.");
    for (const id of wallIds) { const w = doc.walls.find(x => x.id === id); if (!w) fail(`There is no wall "${id}".`); if (w.shape !== "line") fail(`Wall ${id} is curved; wall sweeps go on straight walls.`); }
    const pid = a.profile || "pf-band", prof = (doc.profiles || []).find(p => p.id === pid) || defaultProfiles().find(p => p.id === pid) || fail(`"${pid}" is not in the profile library. Call list_profiles.`);
    if (a.material) checkMaterial(a.material);
    const from = a.height_from === "top" ? "top" : "base";
    const c = makeWallSweep(doc, { wallIds, profileId: pid, side: a.side === "interior" ? "interior" : "exterior", from, distance: Number(a.distance ?? 0), offset: Number(a.offset ?? 0), material: a.material || "mt-paint-white", rectW: a.rect_width, rectH: a.rect_height });
    c.name = prof.name; c.ifc = wallSweepIfc(pid);
    const parts = wallSweepGeometry(doc, c).map(g => ({ sweep: g, mat: c.material }));
    if (!parts.length) fail("The wall sweep has no path.");
    return { el: c, parts, kind: "wallSweep" };
  },
  add_extrusion(doc, a) { return extrusionFrom(doc, a, false); },
  add_void(doc, a) { return extrusionFrom(doc, a, true); },
};
const IFC_CLASSES = { IfcBuildingElementProxy: "IFCBUILDINGELEMENTPROXY", IfcMember: "IFCMEMBER", IfcCovering: "IFCCOVERING", IfcColumn: "IFCCOLUMN", IfcBeam: "IFCBEAM", IfcSlab: "IFCSLAB", IfcPlate: "IFCPLATE", IfcShadingDevice: "IFCSHADINGDEVICE" };
function extrusionFrom(doc, a, isVoid) {
  const wp = a.work_plane || fail("Give work_plane: { level_id } or { wall_id, side }.");
  const loops = a.profile_loops;
  if (!Array.isArray(loops) || !loops.length) fail("Give profile_loops: closed loops of [x, y] points.");
  let plane = null, levelId, z0 = 0;
  if (wp.wall_id) {
    const w = doc.walls.find(x => x.id === wp.wall_id) || fail(`There is no wall "${wp.wall_id}".`);
    if (w.shape !== "line") fail("Pick a straight wall for the work plane.");
    const f = wallFace(doc, w, wp.side === "interior" ? "interior" : "exterior"), n = f.out;
    const side = Math.abs(n.y) >= Math.abs(n.x) ? (n.y > 0 ? "north" : "south") : n.x > 0 ? "east" : "west";
    plane = { o: f.o, u: f.u, n, side, wallId: w.id }; levelId = w.baseLevelId; z0 = wallHeights(doc, w).z0;
  } else {
    levelId = wp.level_id || fail("Give work_plane.level_id or work_plane.wall_id.");
    if (!doc.levels.some(l => l.id === levelId)) fail(`There is no level "${levelId}".`);
  }
  const boundary = [];
  loops.forEach((loop, li) => {
    if (!Array.isArray(loop) || loop.length < 3) fail(`Loop ${li + 1} needs at least 3 points.`);
    const pts = loop.map(p => G.P(Number(p[0]), plane ? z0 + Number(p[1]) : Number(p[1])));
    if (pts.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) fail(`Loop ${li + 1} has a point that is not [x, y].`);
    pts.forEach((p, i) => boundary.push({ shape: "line", a: p, b: pts[(i + 1) % pts.length] }));
  });
  const ok = checkSketch(boundary); if (!ok.ok) fail(ok.message);
  if (!isVoid && a.material) checkMaterial(a.material);
  const c = makeExtrusion(doc, { isVoid, levelId, start: Number(a.start ?? 0), end: Number(a.end ?? (isVoid ? -100 : 200)), boundary, material: isVoid ? undefined : a.material || "mt-paint-white", name: a.name || (isVoid ? "Void" : "Extrusion") });
  if (plane) c.plane = plane;
  if (Math.abs(c.end - c.start) < 1) fail("start and end must be at least 1 mm apart.");
  if (isVoid) {
    const targets = a.target_ids || fail("Give target_ids: the elements the void cuts.");
    for (const t of targets) if (!findById(doc, t)) fail(`There is no element "${t}".`);
    c.targets = [...targets];
  } else {
    const cls = a.ifc_class || "IfcBuildingElementProxy";
    if (!IFC_CLASSES[cls]) fail(`ifc_class must be one of: ${Object.keys(IFC_CLASSES).join(", ")}.`);
    c.ifc = [IFC_CLASSES[cls], cls === "IfcShadingDevice" ? ".USERDEFINED." : ".NOTDEFINED.", ...(cls === "IfcShadingDevice" ? [c.name] : [])];
  }
  const parts = plane ? planeExtrusionBands(doc, c).flatMap(b => b.polys.map(poly => ({ poly, z0: b.z0, z1: b.z1, mat: c.material }))) : extrusionPrisms(doc, c).map(p => ({ ...p, mat: c.material }));
  if (!parts.length) fail("The extrusion has no shape.");
  return { el: c, parts, kind: isVoid ? "void" : "extrusion" };
}

/** A void must cut into at least one of its targets. */
function checkVoid(doc, c, parts) {
  const { solids } = modelSolids(doc, new Set([c.id]));
  const hit = solids.filter(s => c.targets.includes(s.id)).some(s => parts.some(p => penetration(p, s) > 1));
  if (!hit) fail("The void does not cut into any of its target elements. Check the work plane, the shape and start/end.");
}

// ---- the commands
const DETAIL_TOOLS = {
  add_cladding: ["cladding", "A cladding layer on wall faces, cut round doors and windows and stopped at slabs (IfcCovering CLADDING).", {
    wall_ids: ids("Walls to clad"), side: { type: "string", enum: ["exterior", "interior"] }, thickness: mm("Layer thickness, e.g. 30 for stone, 20 for composite"),
    material: MAT, from_level: { type: "string", description: "Only walls on this level or above (level id)" }, to_level: { type: "string", description: "Only walls on this level or below (level id)" },
    start_height: mm("Start above each wall's base, default 0"), end_height: mm("End above each wall's base, default the wall top"), panel_joints: mm("Height of each panel (horizontal joints), 0 for none"),
  }, ["wall_ids", "material"]],
  add_edge_sweep: ["edgeSweep", "A profile along floor or roof edges, hanging from the top of the edge and standing out from it: fascias, curved fascias, slab edge bands.", {
    edges: EDGES, profile: { type: "string", description: "Profile id from list_profiles, e.g. pf-fascia-curved, pf-slabedge" }, material: MAT, offset: mm("Raise (+) or lower (-) the profile, default 0"),
  }, ["edges", "profile", "material"]],
  add_railing: ["railing", "A railing along floor edges (set in by `inset`) or along points. Glass: frameless glass in a base shoe. Baluster: posts, rails, balusters at 120 mm. Solid: a 150 mm upstand.", {
    edges: EDGES, points: { type: "array", items: PT, description: "Or a path of points (with level_id)" }, level_id: { type: "string" }, base_height: mm("Above the level, with points"),
    type: { type: "string", enum: ["glass", "baluster", "solid"] }, height: mm("Height to the top, normally 1000-1100"), inset: mm("Distance in from the slab edge, default 75"), material: MAT, panel_material: MAT,
  }, ["type", "height"]],
  add_fins: ["fins", "Vertical fins or horizontal louvres standing out from wall faces. Keep them clear of doors and windows using from/to and heights.", {
    wall_ids: ids("Walls whose face carries the fins"), side: { type: "string", enum: ["exterior", "interior"] }, orientation: { type: "string", enum: ["vertical", "horizontal"] },
    count: { type: "integer", description: "Number of fins (or give spacing)" }, spacing: mm("Centre to centre"), depth: mm("Out from the face, normally 100-600"), width: mm("Fin thickness"),
    height: mm("Height of the fin zone, default to the wall top"), start_height: mm("Above the wall base, default 0"), from: mm("Start along the wall from its start, default 0"), to: mm("End along the wall, default its length"),
    offset: mm("Gap between the face and the fins, e.g. the cladding thickness"), material: MAT, ifc: { type: "string", enum: ["louvre", "member"] },
  }, ["wall_ids", "depth", "material"]],
  add_canopy: ["canopy", "A canopy slab out from a wall face over a door (opening_id) or at a position along a wall.", {
    opening_id: { type: "string" }, wall_id: { type: "string" }, position: mm("Centre along the wall from its start (with wall_id)"), width: mm("Along the wall"), depth: mm("Out from the wall"),
    thickness: mm("Slab thickness"), height: mm("Underside above the wall base, default 200 above the door head"), supports: { type: "string", enum: ["none", "posts"] }, material: MAT, post_material: MAT,
  }, ["depth", "material"]],
  add_pergola: ["pergola", "A pergola: posts, two beams along the first side of the area, slats across at spacing (IfcMember).", {
    level_id: { type: "string" }, area: { type: "array", items: PT, description: "Corners of the area; the first two points set the beam direction" }, base_height: mm("Above the level"),
    height: mm("Top of the beams above the base"), beam_width: mm(""), beam_depth: mm(""), slat_width: mm(""), slat_depth: mm(""), spacing: mm("Slats centre to centre"), posts: { type: "boolean" }, post_size: mm(""), material: MAT,
  }, ["level_id", "area", "material"]],
  add_soffit: ["soffit", "Finish under roof overhangs (level eaves) or under a slab where it projects past the floor below (IfcCovering CEILING). Optional warm light line.", {
    host_id: { type: "string", description: "Roof id or floor (slab) id" }, material: MAT, thickness: mm("Default 20"), lighting_line: { type: "boolean" },
  }, ["host_id", "material"]],
  add_parapet: ["parapet", "A parapet wall along floor or roof edges with a coping on top (IfcWall PARAPET).", {
    edges: EDGES, height: mm("Above the slab"), thickness: mm("Default 225"), coping_profile: { type: "string", description: "Profile id, or \"none\"" }, material: MAT, coping_material: MAT,
  }, ["edges", "height", "material"]],
  add_planter: ["planter", "A built planter box with soil (IfcBuildingElementProxy).", {
    level_id: { type: "string" }, area: { type: "array", items: PT, description: "Outline corners" }, base_height: mm("Above the level"), height: mm(""), wall_thickness: mm(""), material: MAT, soil: { type: "boolean" },
  }, ["level_id", "area", "material"]],
  add_steps: ["steps", "External steps rising in `direction` from `at` (the centre of the bottom front edge) (IfcStair).", {
    level_id: { type: "string" }, at: PT, direction: { ...PT, description: "Direction the steps rise towards, e.g. [0, 1]" }, base_height: mm("Above the level"),
    width: mm(""), count: { type: "integer" }, riser: mm("Normally 120-180"), tread: mm("Normally 250-400"), material: MAT,
  }, ["level_id", "at", "direction", "count", "material"]],
  add_screen: ["screen", "A slatted or breeze-block screen standing on a line (IfcBuildingElementProxy).", {
    level_id: { type: "string" }, line: { type: "array", items: PT, minItems: 2, maxItems: 2 }, base_height: mm("Above the level"), height: mm(""),
    pattern: { type: "string", enum: ["vertical_slats", "horizontal_slats", "breeze_block"] }, slat_width: mm(""), slat_depth: mm(""), gap: mm(""), material: MAT,
  }, ["level_id", "line", "material"]],
};

export const TOOLS = [
  ...Object.entries(DETAIL_TOOLS).map(([name, [kind, desc, props, req]]) => tool(name, desc, props, req, { kind })),
  tool("add_wall_sweep", "A profile along wall faces: bands, cornices, copings (from the top), plinths, sill bands (IfcCovering).", {
    wall_ids: ids("Walls"), profile: { type: "string", description: "Profile id from list_profiles" }, side: { type: "string", enum: ["exterior", "interior"] },
    height_from: { type: "string", enum: ["base", "top"] }, distance: mm("From the base or down from the top"), offset: mm("Out from the face"), material: MAT,
  }, ["wall_ids", "profile", "material"], { component: true }),
  tool("add_extrusion", "Any solid: a shape (loops of points) pushed from start to end. On a level: x, y in plan, start/end are heights above the level. On a wall face: x along the wall from its start, y above the wall base, start/end out from the face.", {
    work_plane: { type: "object", properties: { level_id: { type: "string" }, wall_id: { type: "string" }, side: { type: "string", enum: ["exterior", "interior"] } } },
    profile_loops: { type: "array", items: { type: "array", items: PT }, description: "Closed loops; an inner loop is a hole" }, start: mm(""), end: mm(""), material: MAT,
    ifc_class: { type: "string", enum: Object.keys(IFC_CLASSES) }, name: { type: "string" },
  }, ["work_plane", "profile_loops", "start", "end", "material"], { component: true }),
  tool("add_void", "Cut a recess or reveal into the target elements: like add_extrusion, but removes material (on a wall face, use a negative end to cut into the wall).", {
    target_ids: ids("Elements to cut"), work_plane: { type: "object", properties: { level_id: { type: "string" }, wall_id: { type: "string" }, side: { type: "string", enum: ["exterior", "interior"] } } },
    profile_loops: { type: "array", items: { type: "array", items: PT } }, start: mm(""), end: mm(""),
  }, ["target_ids", "work_plane", "profile_loops", "start", "end"], { component: true }),
  tool("set_material", "Set the material of elements (yours or added ones). For walls, face exterior or interior finishes only that face.", {
    element_ids: ids("Elements"), face: { type: "string", enum: ["exterior", "interior"] }, material: MAT,
  }, ["element_ids", "material"]),
  tool("edit_element", "Change the settings of an element Ollic AI added in this session (same settings as the command that made it).", {
    id: { type: "string" }, changes: { type: "object", description: "Settings to change" },
  }, ["id", "changes"]),
  tool("delete_element", "Delete an element Ollic AI added in this session.", { id: { type: "string" } }, ["id"]),
  tool("get_element", "The full data of one element.", { id: { type: "string" } }, ["id"], { read: true }),
  tool("get_edges", "The numbered edges of a floor or roof: ends, length, height, outward direction, whether a wall stands on or under it.", { host_id: { type: "string" } }, ["host_id"], { read: true }),
  tool("list_materials", "The material library: ids, names, categories.", {}, [], { read: true }),
  tool("list_profiles", "The profile library for sweeps: ids, names, sizes.", {}, [], { read: true }),
  tool("get_model_summary", "The model summary (levels, walls, openings, floors and roofs with numbered edges, what was added), for all or part of the model.", {
    scope: { type: "object", properties: { levels: { type: "array", items: { type: "string" } }, ids: { type: "array", items: { type: "string" } } } },
  }, [], { read: true }),
  tool("capture_views", "Pictures of the model: clay (white) or material views from corners (ne, nw, se, sw) and the front, and plans of each level with ids.", {
    views: { type: "array", items: { type: "string", enum: ["ne", "nw", "se", "sw", "front"] } }, style: { type: "string", enum: ["clay", "material"] }, plans: { type: "boolean" },
  }, [], { read: true, browser: true }),
];
export const TOOL_BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]));
/** Tool definitions in the shape the assistant expects. */
export const toolSchemas = (names = null) => TOOLS.filter(t => !names || names.includes(t.name)).map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

// ---- running a command
function makeDetail(doc, kind, a, ctx, keepId) {
  checkRanges(kind, a, ctx);
  const b = buildDetail(doc, kind, cleanArgs(a));
  const el = { id: keepId || newId("dt"), kind, name: b.name || KINDS[kind].label, args: cleanArgs(a), levelId: b.levelId, hosts: b.hosts };
  return { el, parts: b.parts, note: b.note };
}
function check(doc, el, parts, kind) {
  if (kind === "void") return checkVoid(doc, el, parts);
  checkParts(doc, parts, { id: el.id, kind });
}

const READ = {
  get_element(doc, a) {
    const f = findById(doc, a.id) || fail(`There is no element "${a.id}".`);
    const el = clone(f.el), out = { collection: f.coll, element: el };
    if (f.coll === "details") { const b = buildDetail(doc, el.kind, el.args); const bx = b.parts.flatMap(partBoxes); out.parts = b.parts.length; out.top = Math.round(Math.max(...bx.map(x => x.z1))); out.bottom = Math.round(Math.min(...bx.map(x => x.z0))); }
    return out;
  },
  get_edges(doc, a) { return hostEdges(doc, a.host_id).map(e => ({ ref: e.ref, a: [Math.round(e.a.x), Math.round(e.a.y)], b: [Math.round(e.b.x), Math.round(e.b.y)], length: Math.round(e.len), top: Math.round(e.zA), out: [+e.out.x.toFixed(3), +e.out.y.toFixed(3)], level: Math.abs(e.zA - e.zB) < 5, exposed: e.exposed })); },
  get_model_summary: (doc, a) => modelSummary(doc, a.scope || {}),
  list_materials: () => MATERIALS.map(m => ({ id: m.id, name: m.name, category: m.category })),
  list_profiles: doc => [...defaultProfiles(), ...(doc.profiles || [])].map(p => ({ id: p.id, name: p.name, width: Math.round(Math.max(...p.pts.map(q => q.x)) - Math.min(...p.pts.map(q => q.x))), height: Math.round(Math.max(...p.pts.map(q => q.y)) - Math.min(...p.pts.map(q => q.y))), centred: !!p.centred })),
};

/**
 * Runs a command on the model. `history` is the undo history (its doc is the model). ctx: { source: "ai" | "user",
 * session, option, planItem, refImage }. Returns { ok: true, ids, message } / { ok: true, result } or { ok: false, error }.
 */
export function runTool(history, name, input = {}, ctx = {}) {
  const T = TOOL_BY_NAME[name];
  if (!T) return { ok: false, error: `There is no command "${name}".` };
  const a = input || {};
  try {
    if (READ[name]) return { ok: true, result: READ[name](history.doc, a, ctx) };
    let out;
    history.transact(labelFor(name, a), doc => { out = WRITE(doc, name, T, a, ctx); });
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}
const labelFor = (name, a) => (a.plan_item != null ? `Item ${a.plan_item}: ` : "") + name.replace(/^add_/, "Add ").replace(/_/g, " ");

function WRITE(doc, name, T, a, ctx) {
  if (T.kind) {
    const { el, parts, note } = makeDetail(doc, T.kind, a, ctx);
    stamp(el, ctx, a); check(doc, el, parts, T.kind);
    doc.details.push(el);
    return { ids: [el.id], message: `Added ${el.name.toLowerCase()} ${el.id}.${note ? " " + note : ""}` };
  }
  if (T.component) {
    const { el, parts, kind } = COMPONENT_BUILDERS[name](doc, a);
    el.tool = name; el.args = cleanArgs(a);
    stamp(el, ctx, a); check(doc, el, parts, kind);
    doc.components.push(el);
    return { ids: [el.id], message: `Added ${(el.name || kind).toLowerCase()} ${el.id}.` };
  }
  if (name === "set_material") {
    const m = a.material; checkMaterial(m);
    const list = a.element_ids || fail("Give element_ids.");
    for (const id of list) {
      const f = findById(doc, id) || fail(`There is no element "${id}".`), el = f.el;
      if (!["walls", "floors", "roofs", "openings", "components", "details"].includes(f.coll)) fail(`${id} cannot take a material.`);
      if (f.coll === "components" && el.isVoid) fail(`${id} is a void; it has no material.`);
      if (a.face && f.coll === "walls" && el.shape !== "line") fail(`Wall ${id} is curved; face finishes go on straight walls.`);
      // working in a design option: your element keeps its material; the new one is proposed until you accept it
      if (ctx.option && !inProposal(el)) { proposeMaterial(el, m, f.coll === "walls" && a.face ? (a.face === "interior" ? "interior" : "exterior") : null, a.plan_item ?? ctx.planItem); continue; }
      if (f.coll === "details") { el.args = { ...el.args, material: m }; continue; } // materials may be set on any element
      if (f.coll === "components" && el.isVoid) fail(`${id} is a void; it has no material.`);
      if (a.face && f.coll === "walls") { if (el.shape !== "line") fail(`Wall ${id} is curved; face finishes go on straight walls.`); el.finishes = { ...(el.finishes || {}), [a.face === "interior" ? "interior" : "exterior"]: m }; }
      else el.material = m;
    }
    return { ids: [...list], message: `Set ${list.length} element${list.length > 1 ? "s" : ""} to ${MATERIALS.find(x => x.id === m).name}.` };
  }
  if (name === "edit_element" || name === "delete_element") {
    const f = findById(doc, a.id) || fail(`There is no element "${a.id}".`), el = f.el;
    if (ctx.source === "ai") mayChange(el, ctx);
    else if (!(f.coll === "details" || (f.coll === "components" && el.tool))) fail(`${a.id} was not made by a finishing command; edit it in Properties instead.`);
    const i = doc[f.coll].indexOf(el);
    if (name === "delete_element") { doc[f.coll].splice(i, 1); return { ids: [a.id], message: `Deleted ${a.id}.` }; }
    const changes = a.changes || fail("Give changes.");
    const merged = { ...(el.args || {}), ...changes };
    const keep = { source: el.source, session: el.session, option: el.option, planItem: el.planItem, refImage: el.refImage };
    let next, parts, kind;
    doc[f.coll].splice(i, 1); // checked without its old self
    if (f.coll === "details") { ({ el: next, parts } = makeDetail(doc, el.kind, merged, ctx, el.id)); kind = el.kind; }
    else { ({ el: next, parts, kind } = COMPONENT_BUILDERS[el.tool](doc, merged)); next.id = el.id; next.tool = el.tool; next.args = cleanArgs(merged); }
    for (const [k, v] of Object.entries(keep)) if (v !== undefined) next[k] = v;
    check(doc, next, parts, kind);
    doc[f.coll].splice(i, 0, next);
    return { ids: [el.id], message: `Changed ${el.id}.` };
  }
  fail(`"${name}" cannot be run here.`);
}

/** Every element made by the assistant in a session (or all assistant elements). */
export const aiElements = (doc, session = null) => [...doc.details, ...doc.components].filter(e => e.source === "ai" && (!session || e.session === session));
