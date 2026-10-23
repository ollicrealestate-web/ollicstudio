// Reads an IFC file on the architect's own computer (a background worker, so the page stays
// responsive) and makes what the server used to make: the 3D file (GLB), the list of building
// parts and the model check. Same layout as backend/app/bim/importer.py: one node per element,
// named by its GlobalId, with { globalId, ifcType, name, storey, family, predefined } as extras,
// y-up, centred on the building and standing on the ground. Triangles keep their own corners,
// so the viewer works out flat normals itself (as for server-made files).
//
// web-ifc (That Open Company, MPL-2.0) reads the IFC: web/vendor/web-ifc.

import * as W from "../vendor/web-ifc/web-ifc-api.js";
import { PRODUCT_FAMILY } from "./ifctypes.js";

const GUID_RE = /^[0-9A-Za-z_$]{22}$/;
const MAX_ELEMENTS = 20000;
const PSETS = new Set(["Pset_WallCommon", "Pset_DoorCommon", "Pset_WindowCommon", "Pset_SlabCommon", "Ollic_Layout", "Qto_SpaceBaseQuantities_Ollic"]);
const DEFAULT_COLOURS = {
  IfcWall: [0.93, 0.92, 0.89, 1], IfcWallStandardCase: [0.93, 0.92, 0.89, 1], IfcSlab: [0.62, 0.61, 0.59, 1], IfcRoof: [0.36, 0.33, 0.32, 1],
  IfcDoor: [0.45, 0.3, 0.18, 1], IfcWindow: [0.55, 0.72, 0.85, 0.45], IfcSpace: [0.85, 0.85, 0.95, 0.15], IfcColumn: [0.7, 0.7, 0.7, 1],
  IfcBeam: [0.7, 0.7, 0.7, 1], IfcStair: [0.75, 0.74, 0.72, 1], IfcFooting: [0.6, 0.6, 0.58, 1], IfcPile: [0.6, 0.6, 0.58, 1],
  IfcFurniture: [0.72, 0.62, 0.5, 1], IfcFurnishingElement: [0.72, 0.62, 0.5, 1], IfcRailing: [0.4, 0.4, 0.42, 1], IfcCurtainWall: [0.55, 0.72, 0.85, 0.45],
};
const UNIT_NAMES = { 1: "metres", 0.001: "millimetres", 0.01: "centimetres", 0.3048: "feet", 0.0254: "inches" };
const PREFIX = { MILLI: 0.001, CENTI: 0.01, DECI: 0.1, KILO: 1000 };

class ReadFailed extends Error {}

/** What a part is made of, for the viewer's realistic look: from the architect's material names,
 *  the part's colour (see-through: glass) and its IFC type. */
const MATERIAL_WORDS = [
  ["glass", /glass|glaz|vitr/i], ["metal", /alumin|steel|metal|iron|chrom|brass|zinc|copper|stainless|anodi/i], ["wood", /wood|timber|oak|walnut|teak|ply|veneer|mahogany|pine|bamboo/i],
  ["brick", /brick|masonry unit|clay block/i], ["tile", /tile|ceramic|porcelain|mosaic/i], ["stone", /marble|granite|stone|travertine|slate|limestone|terrazzo/i],
  ["grass", /grass|lawn|turf|soil|earth|planting|vegetation/i], ["asphalt", /asphalt|bitumen|tarmac/i], ["paving", /paving|paver|interlock|cobble/i],
  ["concrete", /concrete|cement|screed|precast|cast.in/i], ["plaster", /plaster|render|stucco|paint|gypsum|drywall|emulsion|finish/i],
];
const TYPE_CLASS = { IfcWindow: "metal", IfcDoor: "wood", IfcRailing: "metal", IfcMember: "metal", IfcCurtainWall: "glass", IfcPlate: "glass", IfcRoof: "roof",
  IfcSlab: "concrete", IfcColumn: "concrete", IfcBeam: "concrete", IfcFooting: "concrete", IfcPile: "concrete", IfcStair: "concrete", IfcStairFlight: "concrete",
  IfcWall: "plaster", IfcWallStandardCase: "plaster", IfcCovering: "plaster", IfcFurnishingElement: "furniture", IfcFurniture: "furniture", IfcSpace: "space",
  IfcFlowTerminal: "ceramic", IfcSanitaryTerminal: "ceramic" };
function materialClass(type, names, rgba, parts) {
  if (type === "IfcSpace") return "space";
  if (rgba && rgba[3] < 0.95) return "glass";
  const words = names.filter(n => !(parts > 1 && /glass|glaz/i.test(n)));   // a part that is not see-through is not the glass of a window
  for (const [cls, re] of MATERIAL_WORDS) if (cls !== "glass" && words.some(n => re.test(n))) return cls;
  if (parts === 1 && names.some(n => /glass|glaz/i.test(n))) return "glass";
  if (type === "IfcPlate" || type === "IfcCurtainWall") return rgba && rgba[3] >= 0.95 ? "metal" : "glass";
  return TYPE_CLASS[type] || "paint";
}
const v = x => (x && typeof x === "object" && "value" in x ? x.value : x);
const ref = x => (x && typeof x === "object" && "value" in x ? x.value : x);

export async function readIfc(bytes, progress = () => {}) {
  const api = new W.IfcAPI();
  api.SetWasmPath(new URL("../vendor/web-ifc/", import.meta.url).href, true);
  await api.Init(undefined, true);   // single-threaded: works on every site, no special server headers
  progress("Reading the IFC file", 0.02);
  let id;
  try { id = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false }); }
  catch { throw new ReadFailed("The IFC file could not be read. It may be damaged or cut off. Export it from Revit again (File > Export > IFC)."); }
  if (id < 0) throw new ReadFailed("The IFC file could not be read. It may be damaged or cut off. Export it from Revit again (File > Export > IFC).");
  try { return build(api, id, progress); }
  finally { try { api.CloseModel(id); } catch { /* already closed */ } }
}

function idsOf(api, id, type) {
  if (type === undefined) return [];
  try { const vec = api.GetLineIDsWithType(id, type, false); const out = []; for (let i = 0; i < vec.size(); i++) out.push(vec.get(i)); return out; }
  catch { return []; }   // not in this schema (e.g. IfcMapConversion in IFC2X3)
}
const line = (api, id, eid) => { try { return api.GetLine(id, eid, false); } catch { return null; } };

function build(api, id, progress) {
  const checks = [];
  const check = (key, status, message, extra = {}) => checks.push({ key, status, message, ...extra });
  const schema = api.GetModelSchema(id) || "IFC";
  if (!/^IFC(2X3|4)/i.test(schema)) throw new ReadFailed(`This IFC uses the ${schema} schema. Ollic reads IFC2X3, IFC4 and IFC4X3.`);
  check("schema", "pass", `Schema ${schema}`);

  const project = idsOf(api, id, W.IFCPROJECT)[0];
  if (project === undefined) throw new ReadFailed("The file has no IfcProject, so it is not a complete building model. Export the whole model from Revit.");
  check("project", "pass", `Project: ${v(line(api, id, project)?.Name) || "unnamed"}`);

  // length unit, for the report (web-ifc already gives the geometry in metres)
  let scale = 1;
  for (const u of idsOf(api, id, W.IFCSIUNIT)) {
    const l = line(api, id, u);
    if (v(l?.UnitType) === "LENGTHUNIT") { scale = PREFIX[v(l.Prefix)] || 1; break; }
  }
  for (const u of idsOf(api, id, W.IFCCONVERSIONBASEDUNIT)) {
    const l = line(api, id, u);
    if (v(l?.UnitType) === "LENGTHUNIT") { const n = String(v(l.Name) || "").toLowerCase(); scale = n.includes("foot") || n.includes("feet") ? 0.3048 : n.includes("inch") ? 0.0254 : scale; }
  }
  check("units", "pass", `Lengths in ${UNIT_NAMES[scale] || `${scale} m per unit`}`);

  const storeyIds = idsOf(api, id, W.IFCBUILDINGSTOREY);
  const storeys = storeyIds.map(s => ({ id: s, l: line(api, id, s) })).map(s => ({ id: s.id, name: v(s.l?.Name) || "unnamed", elev: Number(v(s.l?.Elevation)) || 0 }))
    .sort((a, b) => a.elev - b.elev);
  const storeyName = new Map(storeys.map(s => [s.id, s.name]));
  if (storeys.length) check("storeys", "pass", `${storeys.length} storey${storeys.length !== 1 ? "s" : ""}: ` + storeys.slice(0, 8).map(s => s.name).join(", "));
  else check("storeys", "warn", "No storeys are defined, so the model cannot be split by floor.");

  // the building's elements: every IfcProduct type except spatial structure, openings, annotation and grids (spaces are kept)
  progress("Finding the building's elements", 0.08);
  const products = [];   // { eid, type, family }
  for (const t of api.GetAllTypesOfModel(id)) {
    const name = api.GetNameFromTypeCode(t.typeID);
    const fam = PRODUCT_FAMILY[name];
    if (!fam || fam === "x") continue;
    for (const eid of idsOf(api, id, t.typeID)) products.push({ eid, type: name, family: fam });
  }
  if (products.length > MAX_ELEMENTS) throw new ReadFailed(`This model has ${products.length.toLocaleString()} elements. Ollic currently reads up to ${MAX_ELEMENTS.toLocaleString()}.`);
  const byEid = new Map(products.map(p => [p.eid, p]));

  // where each element is: its storey, or its parent's (stair flights, curtain wall panels), or the storey a space belongs to
  const container = new Map(), parent = new Map();
  for (const r of idsOf(api, id, W.IFCRELCONTAINEDINSPATIALSTRUCTURE)) {
    const l = line(api, id, r); if (!l) continue;
    const s = ref(l.RelatingStructure);
    for (const e of l.RelatedElements || []) container.set(ref(e), s);
  }
  for (const r of idsOf(api, id, W.IFCRELAGGREGATES)) {
    const l = line(api, id, r); if (!l) continue;
    const p = ref(l.RelatingObject);
    for (const e of l.RelatedObjects || []) parent.set(ref(e), p);
  }
  const storeyOf = eid => {
    for (let k = 0, x = eid; k < 8 && x !== undefined; k++, x = parent.get(x)) {
      if (storeyName.has(container.get(x))) return storeyName.get(container.get(x));
      if (storeyName.has(parent.get(x))) return storeyName.get(parent.get(x));
    }
    return null;
  };

  // properties the app shows (a few common sets)
  const props = new Map();
  for (const r of idsOf(api, id, W.IFCRELDEFINESBYPROPERTIES)) {
    const l = line(api, id, r); if (!l) continue;
    const ps = line(api, id, ref(l.RelatingPropertyDefinition));
    const psName = v(ps?.Name);
    if (!ps || !PSETS.has(psName)) continue;
    const vals = {};
    for (const p of ps.HasProperties || []) { const pl = line(api, id, ref(p)); if (pl && v(pl.Name)) vals[`${psName}.${v(pl.Name)}`] = v(pl.NominalValue) ?? null; }
    for (const e of l.RelatedObjects || []) props.set(ref(e), { ...(props.get(ref(e)) || {}), ...vals });
  }

  // the materials the architect set (IfcRelAssociatesMaterial): names like "Concrete - Cast In Situ", "Glass", "Aluminium"
  const matNames = new Map();
  const namesOf = (mid, depth = 0) => {
    const m = line(api, id, mid); if (!m || depth > 3) return [];
    if (v(m.Name) && !m.ForLayerSet && !m.MaterialLayers && !m.Materials && !m.MaterialConstituents && !m.MaterialProfiles) return [String(v(m.Name))];
    const out = [];
    if (m.ForLayerSet) out.push(...namesOf(ref(m.ForLayerSet), depth + 1));
    if (m.ForProfileSet) out.push(...namesOf(ref(m.ForProfileSet), depth + 1));
    for (const key of ["MaterialLayers", "Materials", "MaterialConstituents", "MaterialProfiles"])
      for (const x of m[key] || []) { const xl = line(api, id, ref(x)); if (!xl) continue; if (xl.Material) out.push(...namesOf(ref(xl.Material), depth + 1)); else out.push(...namesOf(ref(x), depth + 1)); }
    if (!out.length && v(m.Name)) out.push(String(v(m.Name)));
    return out;
  };
  const matCache = new Map();
  for (const r of idsOf(api, id, W.IFCRELASSOCIATESMATERIAL)) {
    const l = line(api, id, r); if (!l) continue;
    const mid = ref(l.RelatingMaterial);
    if (!matCache.has(mid)) matCache.set(mid, [...new Set(namesOf(mid))].slice(0, 6));
    for (const e of l.RelatedObjects || []) matNames.set(ref(e), matCache.get(mid));
  }

  const comps = new Map();   // eid -> component
  const ids = [];
  for (const p of products) {
    const l = line(api, id, p.eid) || {};
    const gid = v(l.GlobalId) || "";
    ids.push(gid);
    let pre = v(l.PredefinedType) || null;
    if (pre === "USERDEFINED") pre = v(l.ObjectType) || pre;
    if (pre === "NOTDEFINED") pre = null;
    const mats = matNames.get(p.eid) || [];
    const pr = props.get(p.eid) || {};
    if (mats.length) pr["Ollic.Materials"] = mats.join("; ").slice(0, 400);
    comps.set(p.eid, { global_id: gid, ifc_type: p.type, name: (v(l.Name) || "").slice(0, 200) || null, family: p.family, storey: storeyOf(p.eid),
      has_geometry: false, properties: pr, predefined: pre, materials: mats });
  }
  const seen = new Map(); ids.forEach(g => seen.set(g, (seen.get(g) || 0) + 1));
  const dupes = [...seen].filter(([, n]) => n > 1).map(([g]) => g), bad = ids.filter(g => !GUID_RE.test(g || ""));
  if (dupes.length || bad.length) check("global_ids", "warn", `${dupes.length} duplicated and ${bad.length} malformed GlobalIds. Those elements may not animate reliably.`, { examples: [...dupes, ...bad].slice(0, 5) });
  else check("global_ids", "pass", `All ${ids.length.toLocaleString()} GlobalIds are present and unique`);

  const counts = {}, families = {};
  for (const p of products) { counts[p.type] = (counts[p.type] || 0) + 1; families[p.family] = (families[p.family] || 0) + 1; }
  if (!((counts.IfcWall || 0) + (counts.IfcWallStandardCase || 0)) && !counts.IfcSlab) check("elements", "fail", "No walls or slabs were found. Ollic needs at least the building's walls or floors.");
  else check("elements", "pass", `${products.length.toLocaleString()} elements`, { by_type: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1])) });
  const mep = families.mep || 0;
  check("mep", mep ? "pass" : "info", mep ? `${mep.toLocaleString()} modelled MEP elements (pipes, ducts, cables, fittings, equipment)`
    : "No MEP elements are modelled in this file. The MEP view will say so rather than invent services.");

  // ---------------------------------------------------------------- geometry
  progress("Building the 3D geometry", 0.15);
  const meshes = [];   // { eid, parts: [{ pos: Float32Array (unwelded, world, y-up), rgba, cls }] }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const all = products.map(p => p.eid);
  api.StreamMeshes(id, all, (mesh, index, total) => {
    // the element's parts, one per colour (a window: its frame and its glass), each with its material class
    const groups = new Map();
    for (let i = 0; i < mesh.geometries.size(); i++) {
      const pg = mesh.geometries.get(i);
      const g = api.GetGeometry(id, pg.geometryExpressID);
      const vd = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
      const ix = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
      const c = pg.color, key = [c.x, c.y, c.z, c.w].map(x => Math.round(x * 1000) / 1000).join(",");
      if (!groups.has(key)) groups.set(key, { rgba: key.split(",").map(Number), list: [], n: 0 });
      const gr = groups.get(key); gr.list.push({ vd: vd.slice(), ix: ix.slice(), m: pg.flatTransformation.slice() }); gr.n += ix.length;
      g.delete();
    }
    const comp = comps.get(mesh.expressID);
    const out = [];
    for (const gr of groups.values()) {
      if (!gr.n) continue;
      const pos = new Float32Array(gr.n * 3);
      let o = 0;
      for (const { vd, ix, m } of gr.list) {
        for (let k = 0; k < ix.length; k++) {
          const b = ix[k] * 6, x = vd[b], y = vd[b + 1], z = vd[b + 2];
          const X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13], Z = m[2] * x + m[6] * y + m[10] * z + m[14];
          pos[o++] = X; pos[o++] = Y; pos[o++] = Z;
          if (X < lo[0]) lo[0] = X; if (Y < lo[1]) lo[1] = Y; if (Z < lo[2]) lo[2] = Z;
          if (X > hi[0]) hi[0] = X; if (Y > hi[1]) hi[1] = Y; if (Z > hi[2]) hi[2] = Z;
        }
      }
      out.push({ pos, rgba: gr.rgba, cls: materialClass(comp?.ifc_type, comp?.materials || [], gr.rgba, groups.size) });
    }
    if (out.length) { meshes.push({ eid: mesh.expressID, parts: out }); if (comp) comp.has_geometry = true; }
    if (index % 50 === 0) progress(`Building the 3D geometry (${index + 1} of ${total})`, 0.15 + 0.7 * (index + 1) / Math.max(1, total));
  });
  if (!meshes.length) throw new ReadFailed("None of the elements have geometry Ollic can display. Check that the export includes 3D views (Revit: IFC export setup > Geometry).");
  const noGeom = [...comps.values()].filter(c => !c.has_geometry && c.ifc_type !== "IfcSpace").length;
  // elements with no shape at all (ports, virtual elements) are not counted as failures
  const failed = [...comps.entries()].filter(([eid, c]) => !c.has_geometry && line(api, id, eid)?.Representation).length;
  if (failed) check("geometry", "warn", `${failed.toLocaleString()} elements have shapes that could not be converted and are not shown.`);
  else check("geometry", "pass", `Geometry built for ${meshes.length.toLocaleString()} elements`);

  const size = [hi[0] - lo[0], hi[2] - lo[2], hi[1] - lo[1]];   // across, deep, tall (metres)
  if (Math.max(...size) > 500) check("size", "warn", `The model is ${size[0].toFixed(0)} x ${size[1].toFixed(0)} m across, which is large for a building. Check the export units.`);
  else if (Math.max(...size) < 2) check("size", "warn", `The model is only ${size[0].toFixed(2)} x ${size[1].toFixed(2)} m across. Check the export units.`);
  else check("size", "pass", `Building is ${size[0].toFixed(1)} m x ${size[1].toFixed(1)} m and ${size[2].toFixed(1)} m tall`);
  const mapped = idsOf(api, id, W.IFCMAPCONVERSION).length > 0 || idsOf(api, id, W.IFCSITE).some(s => (line(api, id, s)?.RefLatitude || []).length);
  check("location", mapped ? "pass" : "info", mapped ? "The model is georeferenced" : "The model is not georeferenced. You can place it on the map later (Google Earth site view).");

  progress("Writing the 3D model", 0.9);
  const centre = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
  const glb = writeGlb(meshes, comps, centre);
  const components = [...comps.values()].map(({ predefined, materials, ...c }) => c);
  const status = checks.some(c => c.status === "fail") ? "fail" : checks.some(c => c.status === "warn") ? "warn" : "pass";
  const report = { status, schema, units: UNIT_NAMES[scale] || `${scale} m per unit`, checks, counts, families, storeys: storeys.map(s => s.name),
    size_m: size.map(x => Math.round(x * 100) / 100), elements: products.length, with_geometry: meshes.length, read_on: "browser" };
  void noGeom;
  return { glb, report, components, stats: { elements: products.length, with_geometry: meshes.length, glb_bytes: glb.byteLength, mep } };
}

function writeGlb(meshes, comps, centre) {
  const views = [], accessors = [], glMeshes = [], nodes = [], materials = [], matIndex = new Map();
  let total = 0;
  for (const m of meshes) for (const q of m.parts) total += q.pos.byteLength;
  const bin = new Uint8Array(total);
  let offset = 0;
  for (const m of meshes) {
    const c = comps.get(m.eid) || {};
    const prims = [];
    for (const q of m.parts) {
      let rgba = q.rgba && q.rgba.length === 4 ? q.rgba : DEFAULT_COLOURS[c.ifc_type] || [0.8, 0.8, 0.8, 1];
      if (c.ifc_type === "IfcSpace") rgba = [rgba[0], rgba[1], rgba[2], Math.min(rgba[3], 0.15)];
      rgba = rgba.map(x => Math.round(x * 1e4) / 1e4);
      const key = `${q.cls}|${rgba.join(",")}`;
      if (!matIndex.has(key)) {
        matIndex.set(key, materials.length);
        // the material's name carries its class (glass, metal, brick...) for the viewer's realistic look
        materials.push({ name: `ollic:${q.cls}`, pbrMetallicRoughness: { baseColorFactor: rgba, metallicFactor: q.cls === "metal" ? 0.8 : 0, roughnessFactor: q.cls === "glass" ? 0.05 : 0.85 },
          alphaMode: rgba[3] < 0.99 ? "BLEND" : "OPAQUE", doubleSided: true });
      }
      const p = q.pos, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < p.length; k += 3) {
        p[k] -= centre[0]; p[k + 1] -= centre[1]; p[k + 2] -= centre[2];
        for (let a = 0; a < 3; a++) { if (p[k + a] < mn[a]) mn[a] = p[k + a]; if (p[k + a] > mx[a]) mx[a] = p[k + a]; }
      }
      bin.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), offset);
      views.push({ buffer: 0, byteOffset: offset, byteLength: p.byteLength, target: 34962 });
      offset += p.byteLength;   // float32 data: always a multiple of 4
      accessors.push({ bufferView: views.length - 1, componentType: 5126, count: p.length / 3, type: "VEC3", min: mn, max: mx });
      prims.push({ attributes: { POSITION: accessors.length - 1 }, material: matIndex.get(key) });
      q.pos = null;
    }
    glMeshes.push({ name: c.global_id, primitives: prims });
    nodes.push({ name: c.global_id, mesh: glMeshes.length - 1,
      extras: { globalId: c.global_id, ifcType: c.ifc_type, name: c.name, storey: c.storey, family: c.family, predefined: c.predefined ?? null,
        materials: (c.materials || []).slice(0, 4) } });
  }
  const doc = { asset: { version: "2.0", generator: "Ollic Design Studio (read in the browser)" }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes, meshes: glMeshes, materials, accessors, bufferViews: views, buffers: [{ byteLength: offset }] };
  let json = new TextEncoder().encode(JSON.stringify(doc));
  const pad = (4 - (json.length % 4)) % 4;
  if (pad) { const j = new Uint8Array(json.length + pad); j.set(json); j.fill(0x20, json.length); json = j; }
  const out = new Uint8Array(12 + 8 + json.length + 8 + offset), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, json.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(json, 20);
  const b = 20 + json.length;
  dv.setUint32(b, offset, true); dv.setUint32(b + 4, 0x004e4942, true); out.set(bin, b + 8);
  return out.buffer;
}

// as a worker: { bytes } in; { progress }, { done: { glb, report, components, stats } } or { error } out
if (typeof self !== "undefined" && typeof window === "undefined" && typeof self.postMessage === "function") {
  self.onmessage = async e => {
    try {
      const out = await readIfc(new Uint8Array(e.data.bytes), (stage, k) => self.postMessage({ progress: { stage, k } }));
      self.postMessage({ done: out }, [out.glb]);
    } catch (err) {
      self.postMessage({ error: err instanceof ReadFailed ? err.message : "This IFC could not be read on this computer.", detail: String(err?.stack || err) });
    }
  };
}
