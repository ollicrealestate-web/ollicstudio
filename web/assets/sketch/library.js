// Material library for finishing details (and for colouring walls, floors and roofs). Add a material by adding a line.
// Colours are what the 3D view shows; names are what the IFC file and the plan list show.

export const MATERIALS = [
  { id: "mt-paint-white", name: "Painted render - white", category: "Paint", color: "#f2efe8", roughness: 0.9 },
  { id: "mt-paint-offwhite", name: "Painted render - warm off-white", category: "Paint", color: "#e8dfcd", roughness: 0.9 },
  { id: "mt-paint-sand", name: "Painted render - sand", category: "Paint", color: "#d6c39f", roughness: 0.9 },
  { id: "mt-paint-grey", name: "Painted render - light grey", category: "Paint", color: "#c7c7c2", roughness: 0.9 },
  { id: "mt-paint-charcoal", name: "Painted render - charcoal", category: "Paint", color: "#3d3e41", roughness: 0.9 },
  { id: "mt-travertine", name: "Travertine stone", category: "Stone", color: "#d9ccb2", roughness: 0.75 },
  { id: "mt-stone-dark", name: "Dark slate stone", category: "Stone", color: "#57585c", roughness: 0.8 },
  { id: "mt-timber-teak", name: "Wood-look composite - teak", category: "Timber-look", color: "#9a6a3f", roughness: 0.7 },
  { id: "mt-timber-walnut", name: "Wood-look composite - walnut", category: "Timber-look", color: "#5f3e27", roughness: 0.7 },
  { id: "mt-concrete", name: "Fair-face concrete", category: "Concrete", color: "#a8a69f", roughness: 0.95 },
  { id: "mt-brick-red", name: "Face brick - red", category: "Brick", color: "#9b4a32", roughness: 0.9 },
  { id: "mt-alu-black", name: "Black aluminium", category: "Metal", color: "#1f2022", roughness: 0.45, metalness: 0.6 },
  { id: "mt-alu-bronze", name: "Bronze aluminium", category: "Metal", color: "#6b5236", roughness: 0.45, metalness: 0.6 },
  { id: "mt-steel-brushed", name: "Brushed steel", category: "Metal", color: "#b9bdc1", roughness: 0.35, metalness: 0.8 },
  { id: "mt-glass-clear", name: "Clear glass", category: "Glass", color: "#bcd9e6", roughness: 0.05, metalness: 0.1, opacity: 0.35 },
  { id: "mt-glass-frosted", name: "Frosted glass", category: "Glass", color: "#e3edf1", roughness: 0.3, opacity: 0.7 },
  { id: "mt-soil", name: "Planting soil and plants", category: "Landscape", color: "#4f6b35", roughness: 1 },
  { id: "mt-light-line", name: "Warm light line", category: "Lighting", color: "#ffd9a0", roughness: 0.5, emissive: "#ffb347" },
];

const BY_ID = new Map(MATERIALS.map(m => [m.id, m]));
export const materialById = id => BY_ID.get(id) || null;
/** The colour of a material id, or the value itself when it is already a colour. */
export function matColor(v, fallback = "#cccccc") {
  if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) return v;
  return BY_ID.get(v)?.color || fallback;
}
export const matName = v => BY_ID.get(v)?.name || (typeof v === "string" && v.startsWith("#") ? `Colour ${v}` : "Default");
/** Throws in plain words when a material is not in the library, naming the closest ones. */
export function checkMaterial(id) {
  if (BY_ID.has(id)) return BY_ID.get(id);
  const words = String(id || "").toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2);
  const near = MATERIALS.map(m => ({ m, s: words.filter(w => (m.id + " " + m.name).toLowerCase().includes(w)).length })).filter(x => x.s).sort((a, b) => b.s - a.s).slice(0, 3);
  throw new Error(`"${id}" is not in the material library.${near.length ? ` Closest: ${near.map(x => `${x.m.id} (${x.m.name})`).join(", ")}.` : " Call list_materials to see the library."}`);
}
