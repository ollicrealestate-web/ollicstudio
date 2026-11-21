#!/usr/bin/env node
// Ollic Sketch hub: lets Claude design and edit buildings in the architect's own licensed tools.
// Today: Revit (architecture, structure, MEP, drawings) plus the Ollic Naira BoQ.
// Next: AutoCAD / Civil 3D and Blender (renders and animations) plug in the same way.
import { McpServer, S } from "./mcp.js";
import { call, status } from "./connectors.js";
import { price, asTable, saveRates, loadRates } from "./boq.js";

const VERSION = "0.2.0";

const INSTRUCTIONS = `You are working inside Ollic Sketch, which connects you to the architect's own Revit and Blender.
Every change you make happens in their real Revit model, each command as one undoable step (Ctrl+Z in Revit).

Units and axes: all lengths in millimetres. x = east (right on plan), y = north (up on plan), z = up.

Working method:
1. Start with revit_get_project_info to see levels, counts and what is selected. Read before you change.
2. Build in this order: levels, grids, walls, floors, doors and windows, rooms, roof; then structure (foundations, columns, beams); then MEP; then views, sheets and exports.
3. Batch work: one revit_create_walls call with all walls of a floor, not one call per wall.
4. When the architect says "this" or "these", use revit_get_selection.
5. After building, check: list what you made, and run revit_find_clashes once structure and MEP exist.
6. Before deleting more than a few elements, or anything you did not create in this conversation, say what will be deleted and wait for a yes.
7. Report what changed in plain language with key dimensions. Mention any Revit warnings returned.
8. If a tool says Revit or Blender is not connected, ask the architect to open it, then try again.

Visuals (Blender): renders, walkthrough videos, construction films and 3D buyer tours.
- Get the model into Blender one of two ways: from Revit (revit_export_fbx, then blender_import_model with that file), or straight from a plan image or sketch the architect shares (read every wall, door, window and room with dimensions, confirm anything unclear, then blender_build_from_plan).
- Walkthrough: blender_set_camera_path (automatic route through every room by door, or points the architect gives, at 1500 mm eye height), then blender_render_video kind=walkthrough. Rendering runs in the background: report the job and check it with blender_render_status.
- For an AI-styled film without invented walls: render style=clay first. That grey video is the exact guide a video AI tool restyles frame by frame, so every wall stays where it is drawn.
- Construction film: blender_render_video kind=construction (foundation, slab, frame, walls, floors, roof, openings, MEP, finishes, furniture).
- Buyer tour: blender_export_tour with a short selling point per room. It makes one HTML file buyers open on a phone: guided tour, walk, dollhouse, time of day, music.
- Lighting: blender_set_time_of_day (hour 6-22; Nigeria latitude by default).

Nigerian residential defaults (use unless told otherwise): external walls 225 mm sandcrete block, internal 150 mm; floor-to-floor 3150 mm (3000 mm wall + 150 mm slab); doors 900 x 2100 (main entrance 1200); windows 1200 x 1200 with 900 mm sill; stairs 175 mm risers and 250 mm goings; columns 230 x 230 mm; ring/lintel beams 230 x 450 mm on walls; strip footings 675 mm wide; pitched roofs 20-30 degrees with long-span aluminium sheets and 600 mm overhang.

Engineering sizes you propose are first drafts: say that structural and MEP designs must be checked and signed by qualified engineers.`;

const server = new McpServer({ name: "ollic-sketch", version: VERSION, instructions: INSTRUCTIONS });

// ---------- Schema pieces ----------
const pt = S.obj({ x: S.num(), y: S.num(), z: S.num() }, ["x", "y"], "Point in mm");
const lvl = S.any(["string", "number"], "Level name, or elevation in mm. Defaults to the level of the active view.");
const n = S.num, s = S.str, b = S.bool;
const ids = S.arr(S.num(), "Revit element ids");

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1).slice(0, 60000) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: e.message || String(e) }] });

/** Registers a tool that runs one command inside Revit. */
function revit(name, description, properties = {}, required = []) {
  server.tool("revit_" + name, description, { properties, ...(required.length && { required }) }, async (args) => {
    try { return text(await call("revit", name, args)); } catch (e) { return fail(e); }
  });
}

// ---------- Connection ----------
server.tool("connection_status", "Shows which design tools are connected to Ollic Sketch right now (the Revit versions open on this computer).", {}, async () => {
  try { return text(await status()); } catch (e) { return fail(e); }
});

// ---------- Reading the model ----------
revit("get_project_info", "Project name, levels with elevations, element counts, active view and selection count. Call this first.");
revit("get_selection", "Details of the elements the architect has selected in Revit (walls with start/end/thickness, doors, rooms and so on).");
revit("list_elements", "Lists elements of one category with geometry (walls: start, end, thickness, height; rooms: name, area; doors/windows: host wall, sill).", {
  category: S.enm(["walls", "doors", "windows", "floors", "roofs", "rooms", "stairs", "columns", "beams", "foundations", "pipes", "ducts", "plumbing_fixtures", "lighting_fixtures", "electrical_fixtures", "furniture", "grids", "levels", "sheets"]),
  level: lvl, limit: n(),
}, ["category"]);
revit("list_types", "Lists the types loaded in the project for one kind of element, for example the wall types and their thicknesses, or the door families.", {
  kind: S.enm(["wall", "floor", "roof", "door", "window", "column", "beam", "foundation", "pipe", "duct", "titleblock", "plumbing_fixture", "furniture"]),
}, ["kind"]);

// ---------- Architecture ----------
revit("create_levels", "Creates levels (storeys) and a floor plan view for each. Existing levels at the same elevation are reused.", {
  levels: S.arr(S.obj({ name: s(), elevation_mm: n(), create_plan: b() }, ["name", "elevation_mm"])),
}, ["levels"]);
revit("create_grids", "Creates structural grid lines.", {
  grids: S.arr(S.obj({ name: s(), start: pt, end: pt }, ["start", "end"])),
}, ["grids"]);
revit("create_walls", "Creates walls along centre-lines. Give thickness_mm (picks the closest wall type) or a type name. Height defaults to 3000 mm, or set top_level. Top-level fields apply to every wall that does not set its own.", {
  walls: S.arr(S.obj({ start: pt, end: pt, level: lvl, thickness_mm: n(), type: s(), height_mm: n(), top_level: lvl, structural: b() }, ["start", "end"])),
  level: lvl, thickness_mm: n(), type: s(), height_mm: n(), top_level: lvl, structural: b(),
}, ["walls"]);
revit("create_floors", "Creates floor slabs from boundary points, or from the outline of the walls on a level when no boundary is given.", {
  floors: S.arr(S.obj({ level: lvl, boundary: S.arr(pt), outline_from_level: lvl, type: s(), offset_mm: n(), structural: b() })),
}, ["floors"]);
revit("create_roof", "Creates a roof on a level (usually a 'Roof' level at the top of the walls). Uses the outline of the walls on the level below unless a footprint is given.", {
  level: lvl, style: S.enm(["gable", "hip", "mono", "flat"]), pitch_degrees: n(), overhang_mm: n(),
  footprint: S.arr(pt), outline_from_level: lvl, type: s(), base_offset_mm: n(),
});
revit("place_openings", "Places doors and windows in walls. Locate each by wall_id + offset_mm (distance from the wall start to the opening centre), or by a point near the wall. width_mm/height_mm pick or create the right size.", {
  openings: S.arr(S.obj({
    kind: S.enm(["door", "window"]), wall_id: n(), offset_mm: n(), point: pt, level: lvl,
    type: s(), width_mm: n(), height_mm: n(), sill_mm: n(), flip_facing: b(), flip_hand: b(),
  }, ["kind"])),
}, ["openings"]);
revit("create_rooms", "Places named rooms at points inside enclosed walls, or set auto_level to fill every enclosed space on a level.", {
  rooms: S.arr(S.obj({ point: pt, level: lvl, name: s(), number: s() }, ["point"])), auto_level: lvl,
});
revit("place_components", "Places loaded families such as WCs, basins, showers, lights, sockets, distribution boards, AC units and furniture at points.", {
  components: S.arr(S.obj({
    category: S.enm(["plumbing_fixture", "lighting_fixture", "electrical_fixture", "electrical_equipment", "mechanical_equipment", "furniture", "casework", "generic", "planting"]),
    type: s(), point: pt, level: lvl, rotation_degrees: n(),
  }, ["category", "point"])),
}, ["components"]);
revit("modify_elements", "Moves, rotates, changes type or thickness, or sets parameters of elements. Parameter lengths are mm, angles degrees.", {
  ids, move: S.obj({ x: n(), y: n(), z: n() }, [], "Move by this many mm"), rotate_degrees: n(), about: pt,
  type: s(), thickness_mm: n(), parameters: S.obj({}, [], "Parameter name to new value"),
}, ["ids"]);
revit("delete_elements", "Deletes elements by id. Confirm with the architect first unless they asked for this exact deletion.", { ids }, ["ids"]);

// ---------- Structure ----------
revit("create_columns", "Places structural columns at points or at every grid intersection, from base_level to top_level (default: the level above). width_mm/depth_mm create the size if needed.", {
  points: S.arr(pt), at_grid_intersections: b(), base_level: lvl, top_level: lvl, type: s(), width_mm: n(), depth_mm: n(),
});
revit("create_beams", "Places beams between points, or along every wall of a level (ring beams / lintel bands), at a level plus offset.", {
  beams: S.arr(S.obj({ start: pt, end: pt }, ["start", "end"])), on_walls_of_level: lvl, level: lvl, offset_mm: n(),
  type: s(), width_mm: n(), depth_mm: n(),
});
revit("create_foundations", "Creates strip footings under all walls of a level and/or pad footings at points or under every column.", {
  strip_under_walls_of_level: lvl, strip_type: s(), strip_width_mm: n(),
  pads: S.arr(S.obj({ point: pt, level: lvl }, ["point"])), pads_under_columns: b(), level: lvl,
  pad_type: s(), pad_width_mm: n(), pad_length_mm: n(), pad_thickness_mm: n(),
});

// ---------- MEP and coordination ----------
revit("create_pipes", "Draws pipe runs through points (z = height above the level, mm). Segments are joined with elbows. Needs pipe types in the project (use an MEP or combined template).", {
  runs: S.arr(S.obj({ points: S.arr(pt, null, { minItems: 2 }), level: lvl, diameter_mm: n(), system: s("e.g. Domestic Cold Water, Sanitary"), type: s() }, ["points"])),
}, ["runs"]);
revit("create_ducts", "Draws duct runs through points (z = height above the level, mm), rectangular (width/height) or round (diameter).", {
  runs: S.arr(S.obj({ points: S.arr(pt, null, { minItems: 2 }), level: lvl, width_mm: n(), height_mm: n(), diameter_mm: n(), system: s(), type: s() }, ["points"])),
}, ["runs"]);
revit("find_clashes", "Finds hard clashes, by default pipes and ducts against beams, columns, walls, floors and foundations.", {
  group_a: S.arr(s()), group_b: S.arr(s()), limit: n(),
});

// ---------- Drawings and output ----------
revit("create_views", "Creates floor, ceiling or structural plans, a section between two points, all four elevations, or a 3D view.", {
  views: S.arr(S.obj({
    kind: S.enm(["floor_plan", "ceiling_plan", "structural_plan", "section", "elevations", "3d"]), level: lvl, name: s(), scale: n(),
    start: pt, end: pt, depth_mm: n(), bottom_mm: n(), top_mm: n(),
  }, ["kind"])),
}, ["views"]);
revit("create_sheets", "Creates drawing sheets with the project's title block and places the given views on them.", {
  sheets: S.arr(S.obj({ number: s(), name: s(), view_ids: S.arr(n()), titleblock: s() }, ["number", "name"])),
}, ["sheets"]);
revit("open_view", "Opens a view in Revit so the architect can see the result.", { view_id: n(), name: s() });
revit("export_pdf", "Exports sheets (default: all sheets) or views to one PDF in Documents\\Ollic Sketch\\Exports.", {
  sheet_ids: S.arr(n()), view_ids: S.arr(n()), all_sheets: b(), folder: s(), file_name: s(),
});
revit("export_image", "Exports a realistic, shaded or hidden-line image of a 3D view (creates one if no view_id is given).", {
  view_id: n(), style: S.enm(["realistic", "shaded", "hidden"]), width_px: n(), folder: s(), file_name: s(),
});

revit("export_fbx", "Exports the 3D model to an FBX file for Blender (renders, walkthroughs, construction films, buyer tours). Uses a 3D view (creates one if needed).", {
  view_id: n(), folder: s(), file_name: s(),
});

// ---------- Blender: visuals ----------
/** Registers a tool that runs one command inside Blender. */
function blender(name, description, properties = {}, required = []) {
  server.tool("blender_" + name, description, { properties, ...(required.length && { required }) }, async (args) => {
    try { return text(await call("blender", name, args)); } catch (e) { return fail(e); }
  });
}
const wall = S.obj({ start: pt, end: pt, thickness_mm: n(), height_mm: n() }, ["start", "end"]);
const opening = S.obj({ wall: S.num("Index of the wall in this level's walls list, from 0"), kind: S.enm(["door", "window"]),
  offset_mm: S.num("Distance from the wall start to the opening centre"), width_mm: n(), height_mm: n(), sill_mm: n() }, ["wall", "kind"]);
const room = S.obj({ name: s(), x0: n(), y0: n(), x1: n(), y1: n(), floor: S.enm(["tiles", "wood", "concrete"]) }, ["name", "x0", "y0", "x1", "y1"]);
const stair = S.obj({ x: n(), y: n(), direction: S.enm(["up", "down", "left", "right"], "Walking direction on plan; up = north"), width_mm: n() }, ["x", "y"]);
blender("get_scene_info", "What is in Blender now: size, rooms, objects per construction stage, cameras, time of day and render jobs.");
blender("build_from_plan", "Builds a full 3D model in Blender from a dimensioned plan: walls with doors and windows cut in, slabs, floor finishes, ceilings, stairs, roof with gable walls, foundations, site and simple furniture per room.", {
  title: s(),
  levels: S.arr(S.obj({ name: s(), elevation_mm: n(), height_mm: n(), walls: S.arr(wall), openings: S.arr(opening), rooms: S.arr(room), stairs: S.arr(stair) }, ["walls"])),
  roof: S.obj({ style: S.enm(["gable", "hip", "mono", "flat", "none"]), pitch_degrees: n(), overhang_mm: n(), ridge: S.enm(["auto", "x", "y"]), color: S.str("Hex colour, e.g. #3d4246") }),
  site: b(), clear: b(),
}, ["levels"]);
blender("import_model", "Imports a model file (FBX from revit_export_fbx, or glTF/OBJ). Size is checked and scaled to metres; each part is sorted into a construction stage.", {
  path: s(), unit: S.enm(["auto", "m", "mm", "cm", "ft", "in"]), clear: b(),
}, ["path"]);
blender("apply_style", "Sets the look: clay (plain grey, the guide for AI video) or realistic materials. Optional wall and roof colours (hex) and floor finish.", {
  style: S.enm(["clay", "realistic"]), wall_color: s(), roof_color: s(), floor: S.enm(["tiles", "wood", "concrete"]),
}, ["style"]);
blender("set_time_of_day", "Moves the sun for the hour (6 morning to 22 night); evening and night switch on room lights.", {
  hour: n(), latitude: n(), north_degrees: S.num("Rotation of north from the top of the plan, degrees"),
}, ["hour"]);
blender("set_camera_path", "Sets the walkthrough route at eye height. Without points it walks from outside the main entrance through every room via the doors, pausing in each. With points (mm) it follows them; hold_seconds pauses and label names the room.", {
  points: S.arr(S.obj({ x: n(), y: n(), hold_seconds: n(), label: s() }, ["x", "y"])), level: S.any(["string", "number"]),
  eye_height_mm: n(), speed_m_per_s: n(), fps: n(), lens_mm: n(),
});
blender("render_video", "Starts rendering a video in the background: kind walkthrough (along the camera path) or construction (foundation to furnished, orbiting camera). Returns a job id; follow it with blender_render_status.", {
  kind: S.enm(["walkthrough", "construction"]), style: S.enm(["clay", "realistic"]), quality: S.enm(["preview", "final", "cycles"]),
  hour: n(), seconds_per_stage: n(), max_seconds: n(), width: n(), height: n(), name: s(), folder: s(),
}, ["kind"]);
blender("render_status", "Progress of render jobs: frames done, minutes left, and the video file when finished.", { id: s() });
blender("cancel_render", "Stops a render job.", { id: s() }, ["id"]);
blender("render_still", "Renders one image: exterior (three-quarter view), aerial, or walk (a frame of the walkthrough).", {
  view: S.enm(["exterior", "aerial", "walk"]), style: S.enm(["clay", "realistic"]), hour: n(), frame: n(), angle_degrees: n(),
  quality: S.enm(["preview", "final", "cycles"]), width: n(), height: n(), path: s(),
});
blender("export_tour", "Exports a 3D buyer tour: one HTML file that opens on any phone or computer, with a guided tour (room name, size, selling point), free walking, dollhouse view with the roof off, time-of-day slider and soft music.", {
  title: s(), subtitle: s(), selling_points: S.obj({}, [], "Room name to one short selling point"), units: S.enm(["m2", "ft2"]), path: s(),
});
blender("save", "Saves the Blender file.", { path: s() });

// ---------- Quantities and cost (Ollic layer) ----------
revit("get_quantities", "Measured quantities from the model: wall areas by thickness, slab, roof, column, beam and footing volumes, door and window counts, pipe and duct lengths, room areas.");
server.tool("ollic_bill_of_quantities", "Builds a priced bill of quantities in Naira from the Revit model, using the architect's saved rates.", {}, async () => {
  try {
    const q = await call("revit", "get_quantities", {});
    const boq = price(q);
    return text(asTable(boq) + `\nRates file: ${boq.rates_file}. Quantities exclude reinforcement schedules and external works.`);
  } catch (e) { return fail(e); }
});
server.tool("ollic_rates", "Shows the Naira rates used for the bill of quantities, or updates some of them (give rate keys and new values).", {
  properties: { update: S.obj({}, [], "Rate key to new Naira rate, e.g. {\"block_225\": 900}") },
}, async ({ update }) => {
  try { return text(update && Object.keys(update).length ? saveRates(update) : loadRates()); } catch (e) { return fail(e); }
});

server.listen();
