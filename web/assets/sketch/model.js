// The Sketch model: one JSON document is the single source of truth. Lengths in millimetres.
// Geometry (plan drawing, 3D) is always computed from this data; meshes are never stored.

export const SCHEMA_VERSION = 1;
export const MAX_LEVELS = 10;
export const MAX_HEIGHT_MM = 40000;
export const DEFAULT_STOREY_MM = 3000;

let counter = 0;
/** Short unique id with a readable prefix, e.g. "wl-k3f9a1". */
export function newId(prefix) {
  counter = (counter + 1) % 1679616;
  return `${prefix}-${Date.now().toString(36).slice(-4)}${counter.toString(36).padStart(4, "0")}${Math.random().toString(36).slice(2, 4)}`;
}

/** Nigerian defaults, editable per project. */
export function defaultTypes() {
  return {
    wallTypes: [
      { id: "wt-ext225", name: "Exterior - 225 mm block + render", thickness: 255, core: 225, function: "exterior", color: "#d9d4ca" },
      { id: "wt-int150", name: "Interior - 150 mm block", thickness: 150, core: 150, function: "interior", color: "#e8e4dc" },
      { id: "wt-int100", name: "Interior - 100 mm partition", thickness: 100, core: 100, function: "interior", color: "#ece9e2" },
      { id: "wt-par225", name: "Parapet - 225 mm", thickness: 225, core: 225, function: "exterior", color: "#d9d4ca" },
      { id: "wt-generic", name: "Generic - 200 mm", thickness: 200, core: 200, function: "interior", color: "#dddddd" },
    ],
    floorTypes: [
      { id: "ft-rc150", name: "RC slab 150 mm", thickness: 150, function: "structural" },
      { id: "ft-rc200", name: "RC slab 200 mm", thickness: 200, function: "structural" },
      { id: "ft-rc250", name: "RC slab 250 mm", thickness: 250, function: "structural" },
      { id: "ft-gfb150", name: "Ground floor bed 150 mm", thickness: 150, function: "structural" },
    ],
    roofTypes: [{ id: "rt-200", name: "Long-span roof 200 mm", thickness: 200, color: "#5b6168" }],
    doorTypes: [
      { id: "dt-900", name: "D 900x2100 single", width: 900, height: 2100, frame: 50, style: "single" },
      { id: "dt-750", name: "D 750x2100 toilet", width: 750, height: 2100, frame: 50, style: "single" },
      { id: "dt-1200", name: "D 1200x2100 double", width: 1200, height: 2100, frame: 50, style: "double" },
      { id: "dt-1800", name: "D 1800x2100 double", width: 1800, height: 2100, frame: 50, style: "double" },
      { id: "dt-slide2400", name: "D 2400x2100 sliding", width: 2400, height: 2100, frame: 50, style: "sliding" },
      { id: "dt-garage", name: "D 2700x2400 garage", width: 2700, height: 2400, frame: 75, style: "garage" },
    ],
    windowTypes: [
      { id: "wn-1200", name: "W 1200x1200 casement", width: 1200, height: 1200, frame: 50, style: "casement", sill: 900 },
      { id: "wn-600", name: "W 600x600 toilet", width: 600, height: 600, frame: 50, style: "casement", sill: 1500 },
      { id: "wn-1500", name: "W 1500x1200 sliding", width: 1500, height: 1200, frame: 50, style: "sliding", sill: 900 },
      { id: "wn-1800", name: "W 1800x1500", width: 1800, height: 1500, frame: 50, style: "casement", sill: 600 },
      { id: "wn-fixed", name: "W fixed glass 1200x1200", width: 1200, height: 1200, frame: 50, style: "fixed", sill: 900 },
    ],
    profiles: [], // the library of sweep profiles lives in components.js; custom profiles are added here
  };
}

export function newProject(name = "Untitled sketch") {
  return {
    schemaVersion: SCHEMA_VERSION,
    name,
    units: "mm",
    levels: [{ id: "lv-1", name: "Level 1", elevation: 0 }],
    ...defaultTypes(),
    walls: [], openings: [], floors: [], roofs: [], components: [],
    lines: [], dimensions: [], tags: [], referencePlanes: [], constraints: [],
    settings: { gridMm: 1000, defaultStoreyMm: DEFAULT_STOREY_MM },
  };
}

/** Collections that hold elements with ids; history and selection work over these. */
export const COLLECTIONS = ["levels", "wallTypes", "floorTypes", "roofTypes", "doorTypes", "windowTypes", "profiles",
  "walls", "openings", "floors", "roofs", "components", "lines", "dimensions", "tags", "referencePlanes", "constraints"];

/** Accepts older or partial documents and fills in what is missing. Throws on anything that is not a sketch. */
export function normalize(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.levels)) throw new Error("This file is not an Ollic sketch.");
  if ((doc.schemaVersion || 0) > SCHEMA_VERSION) throw new Error("This sketch was made by a newer version of Ollic. Reload the page.");
  const base = newProject(doc.name || "Untitled sketch");
  const out = { ...base, ...doc, schemaVersion: SCHEMA_VERSION, settings: { ...base.settings, ...(doc.settings || {}) } };
  for (const k of COLLECTIONS) if (!Array.isArray(out[k])) out[k] = base[k] || [];
  if (!out.levels.length) out.levels = base.levels;
  // keep shipped types available even in older files
  const types = defaultTypes();
  for (const k of ["wallTypes", "floorTypes", "roofTypes", "doorTypes", "windowTypes"]) {
    for (const t of types[k]) if (!out[k].some(x => x.id === t.id)) out[k].push(t);
  }
  out.levels.sort((a, b) => a.elevation - b.elevation);
  return out;
}

export const clone = v => (typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

export function findById(doc, id) {
  for (const k of COLLECTIONS) {
    const e = doc[k].find(x => x.id === id);
    if (e) return { coll: k, el: e };
  }
  return null;
}

/** "+3.000" style level label (metres, 3 decimals). */
export function levelLabel(mm) {
  const m = mm / 1000;
  if (Math.abs(m) < 0.0005) return "±0.000";
  return (m > 0 ? "+" : "−") + Math.abs(m).toFixed(3);
}
