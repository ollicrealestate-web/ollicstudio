// IFC4 export: the model as building objects (walls, slabs, roofs, doors, windows, other parts) on their storeys,
// with the shapes exactly as the 3D view shows them (triangulated face sets, millimetres, with colours).
// Written as a plain STEP text file (ISO 10303-21); no library is needed.

const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
/** A new IFC GlobalId: 128 random bits written as 22 characters. */
export function ifcGuid() {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; // a version 4 UUID, as IFC tools expect
  let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x);
  let s = ""; for (let i = 0; i < 22; i++) { s = B64[Number(n & 63n)] + s; n >>= 6n; }
  return s;
}
/** Text for a STEP string: quotes doubled, non-ASCII as \X2\ hex. */
export function ifcText(s) {
  let out = "";
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0);
    if (ch === "'") out += "''"; else if (ch === "\\") out += "\\\\";
    else if (c >= 32 && c < 127) out += ch;
    else if (c < 0x10000) out += `\\X2\\${c.toString(16).toUpperCase().padStart(4, "0")}\\X0\\`;
  }
  return `'${out}'`;
}
import { detailIfc } from "./details.js";
import { matName } from "./library.js";
import { hasProposal } from "./options.js";
const num = v => { const r = Math.round(v * 1000) / 1000; return Number.isInteger(r) ? `${r}.` : String(r); };

/**
 * Builds the IFC text. `app` gives the model and its 3D view; every element's meshes are read from a fresh build
 * of the 3D view with all levels shown.
 */
export function modelIfc(app, THREE, { name = "Sketch", typeMark = () => "" } = {}) {
  const doc = app.doc, v3 = app.view3d;
  if (hasProposal(doc)) throw new Error("Accept or discard the AI proposal first, so nothing half-finished is exported.");
  // a fresh 3D build with every level shown and nothing selected (selection colours would be exported)
  const keep = { hidden: app.prefs.hidden3D, sel: app.selection };
  app.prefs.hidden3D = []; app.selection = new Set();
  let groups;
  try { v3.rebuild(); v3.root.updateMatrixWorld(true); groups = collectMeshes(v3.root, THREE); }
  finally { app.prefs.hidden3D = keep.hidden; app.selection = keep.sel; v3.invalidate(); }

  const lines = []; let id = 0;
  const add = s => { lines.push(`#${++id}=${s};`); return `#${id}`; };
  const levels = [...doc.levels].sort((a, b) => a.elevation - b.elevation);

  // ---- project, units, context
  const origin = add("IFCCARTESIANPOINT((0.,0.,0.))");
  const axis = add(`IFCAXIS2PLACEMENT3D(${origin},$,$)`);
  const north = add("IFCDIRECTION((0.,1.))");
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${axis},${north})`);
  const body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const units = [add("IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)"), add("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)"), add("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)"), add("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)")];
  const ua = add(`IFCUNITASSIGNMENT((${units.join(",")}))`);
  const project = add(`IFCPROJECT('${ifcGuid()}',$,${ifcText(name)},$,$,$,$,(${ctx}),${ua})`);
  const sitePl = add(`IFCLOCALPLACEMENT($,${axis})`);
  const site = add(`IFCSITE('${ifcGuid()}',$,'Site',$,$,${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldPl = add(`IFCLOCALPLACEMENT(${sitePl},${axis})`);
  const building = add(`IFCBUILDING('${ifcGuid()}',$,${ifcText(name)},$,$,${bldPl},$,$,.ELEMENT.,$,$,$)`);
  add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${project},(${site}))`);
  add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${site},(${building}))`);
  const storeys = new Map();
  for (const l of levels) {
    const p = add(`IFCCARTESIANPOINT((0.,0.,${num(l.elevation)}))`), a = add(`IFCAXIS2PLACEMENT3D(${p},$,$)`), pl = add(`IFCLOCALPLACEMENT(${bldPl},${a})`);
    storeys.set(l.id, { ref: add(`IFCBUILDINGSTOREY('${ifcGuid()}',$,${ifcText(l.name)},$,$,${pl},$,$,.ELEMENT.,${num(l.elevation)})`), pl, elevation: l.elevation, items: [] });
  }
  add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${building},(${[...storeys.values()].map(s => s.ref).join(",")}))`);

  // ---- colours, shared between elements
  const styles = new Map();
  // a surface style is named after its material (as Revit names them), so readers know what each face is made of
  const styleFor = (rgb, alpha, mat) => {
    const k = rgb.map(v => v.toFixed(3)).join(",") + "|" + alpha.toFixed(2) + "|" + (mat || "");
    if (!styles.has(k)) { const c = add(`IFCCOLOURRGB($,${rgb.map(num).join(",")})`), sh = add(`IFCSURFACESTYLERENDERING(${c},${num(1 - alpha)},$,$,$,$,$,$,.NOTDEFINED.)`); styles.set(k, add(`IFCSURFACESTYLE(${mat ? ifcText(matName(mat)) : "$"},.BOTH.,(${sh}))`)); }
    return styles.get(k);
  };

  // ---- elements
  const counts = {}, mats = new Map();
  const level = (lid) => storeys.get(lid) || storeys.get(levels[0].id);
  const elementOf = eid => {
    const w = doc.walls.find(x => x.id === eid); if (w) return { cls: "IFCWALL", name: (doc.wallTypes.find(t => t.id === w.typeId)?.name) || "Wall", lid: w.baseLevelId, pre: ".STANDARD.", material: w.material };
    const f = doc.floors.find(x => x.id === eid); if (f) return { cls: "IFCSLAB", name: (doc.floorTypes.find(t => t.id === f.typeId)?.name) || "Floor", lid: f.levelId, pre: ".FLOOR.", material: f.material };
    const r = doc.roofs.find(x => x.id === eid); if (r) return { cls: "IFCROOF", name: (doc.roofTypes.find(t => t.id === r.typeId)?.name) || "Roof", lid: r.baseLevelId, pre: ".NOTDEFINED.", material: r.material };
    const o = doc.openings.find(x => x.id === eid);
    if (o) { const host = doc.walls.find(x => x.id === o.hostWallId), t = (o.kind === "door" ? doc.doorTypes : doc.windowTypes).find(x => x.id === o.typeId) || {}; return { cls: o.kind === "door" ? "IFCDOOR" : "IFCWINDOW", name: t.name || (o.kind === "door" ? "Door" : "Window"), lid: host?.baseLevelId, w: t.width, h: t.height, mark: typeMark(o) }; }
    const dt = (doc.details || []).find(x => x.id === eid);
    if (dt) { const [cls, pre, ot] = detailIfc(dt); return { cls, pre, ot, name: dt.name, lid: dt.levelId, src: dt, material: dt.args?.material }; }
    const c = doc.components.find(x => x.id === eid);
    if (c?.ifc) return { cls: c.ifc[0], pre: c.ifc[1], ot: c.ifc[2], name: c.name || "Component", lid: c.levelId || doc.walls.find(w => w.id === c.wallIds?.[0])?.baseLevelId, src: c, material: c.material };
    if (c) return { cls: "IFCBUILDINGELEMENTPROXY", name: c.name || (c.kind === "wallSweep" ? (c.reveal ? "Reveal" : "Wall sweep") : c.kind === "sweep" ? "Sweep" : "Extrusion"), lid: c.levelId || doc.walls.find(w => w.id === c.wallIds?.[0])?.baseLevelId, pre: ".NOTDEFINED." };
    return null;
  };
  for (const [eid, parts] of groups) {
    const el = elementOf(eid); if (!el) continue;
    const st = level(el.lid), dz = st.elevation;
    const items = [];
    for (const part of parts) {
      // one face set per colour; points in mm relative to the storey
      const pts = [], index = new Map(), tris = [];
      const vid = (x, y, z) => { const k = `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`; if (!index.has(k)) { index.set(k, pts.length + 1); pts.push(`(${num(x)},${num(y)},${num(z - dz)})`); } return index.get(k); };
      for (const t of part.tris) { const a = vid(...t[0]), b = vid(...t[1]), c = vid(...t[2]); if (a !== b && b !== c && a !== c) tris.push(`(${a},${b},${c})`); }
      if (!tris.length) continue;
      const pl = add(`IFCCARTESIANPOINTLIST3D((${pts.join(",")}))`);
      const fs = add(`IFCTRIANGULATEDFACESET(${pl},$,$,(${tris.join(",")}),$)`);
      add(`IFCSTYLEDITEM(${fs},(${styleFor(part.rgb, part.alpha, part.mat)}),$)`);
      items.push(fs);
    }
    if (!items.length) continue;
    const rep = add(`IFCSHAPEREPRESENTATION(${body},'Body','Tessellation',(${items.join(",")}))`);
    const pds = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`);
    const pl = add(`IFCLOCALPLACEMENT(${st.pl},${axis})`);
    const head = `'${ifcGuid()}',$,${ifcText(el.name)},$,${el.ot ? ifcText(el.ot) : "$"},${pl},${pds},${ifcText(el.mark || eid)}`;
    let ref;
    if (el.cls === "IFCDOOR") ref = add(`IFCDOOR(${head},${el.h ? num(el.h) : "$"},${el.w ? num(el.w) : "$"},.DOOR.,$,$)`);
    else if (el.cls === "IFCWINDOW") ref = add(`IFCWINDOW(${head},${el.h ? num(el.h) : "$"},${el.w ? num(el.w) : "$"},.WINDOW.,$,$)`);
    else ref = add(`${el.cls}(${head},${el.pre})`);
    st.items.push(ref);
    counts[el.cls] = (counts[el.cls] || 0) + 1;
    // finishing details: their material, and where they came from
    if (el.material && !/^#/.test(el.material)) { if (!mats.has(el.material)) mats.set(el.material, { ref: add(`IFCMATERIAL(${ifcText(matName(el.material))},$,$)`), els: [] }); mats.get(el.material).els.push(ref); }
    if (el.src) {
      const src = el.src, P = (n, v) => add(`IFCPROPERTYSINGLEVALUE(${ifcText(n)},$,${v},$)`);
      const props = [P("Source", `IFCLABEL(${ifcText(src.source === "ai" ? "ai" : "user")})`), P("PlanItem", src.planItem != null ? `IFCLABEL(${ifcText(String(src.planItem))})` : "$"), P("ReferenceImage", src.refImage != null ? `IFCLABEL(${ifcText(String(src.refImage))})` : "$")];
      if (el.material) props.push(P("Material", `IFCLABEL(${ifcText(matName(el.material))})`));
      const ps = add(`IFCPROPERTYSET('${ifcGuid()}',$,'Pset_OllicSource',$,(${props.join(",")}))`);
      add(`IFCRELDEFINESBYPROPERTIES('${ifcGuid()}',$,$,$,(${ref}),${ps})`);
    }
  }
  for (const m of mats.values()) add(`IFCRELASSOCIATESMATERIAL('${ifcGuid()}',$,$,$,(${m.els.join(",")}),${m.ref})`);
  for (const st of storeys.values()) if (st.items.length) add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${ifcGuid()}',$,$,$,(${st.items.join(",")}),${st.ref})`);

  const now = new Date().toISOString().slice(0, 19);
  const text = ["ISO-10303-21;", "HEADER;", "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
    `FILE_NAME(${ifcText(name + ".ifc")},'${now}',(''),('OLLIC'),'Ollic Sketch','Ollic Sketch','');`, "FILE_SCHEMA(('IFC4'));", "ENDSEC;", "DATA;", ...lines, "ENDSEC;", "END-ISO-10303-21;", ""].join("\n");
  if (!Object.keys(counts).length) throw new Error("There is nothing in 3D to export yet.");
  return { text, counts };
}

/** Meshes of the 3D view grouped by element id, then by colour: Map(id -> [{ rgb, alpha, tris: [[x,y,z]x3] }]) in model mm, z up. */
function collectMeshes(root, THREE) {
  const out = new Map(), v = new THREE.Vector3();
  root.traverse(o => {
    if (!o.isMesh || !o.userData.id || !o.geometry?.attributes?.position || o.visible === false) return;
    const g = o.geometry, pos = g.attributes.position, idx = g.index;
    const m = [].concat(o.material)[0], rgb = m?.color ? [m.color.r, m.color.g, m.color.b] : [0.8, 0.8, 0.8], alpha = m?.transparent ? m.opacity : 1;
    const P = k => { v.fromBufferAttribute(pos, k).applyMatrix4(o.matrixWorld); return [v.x * 1000, -v.z * 1000, v.y * 1000]; };
    const n = idx ? idx.count : pos.count, at = k => (idx ? idx.getX(k) : k);
    if (!out.has(o.userData.id)) out.set(o.userData.id, []);
    const mat = typeof o.userData.mat === "string" && !o.userData.mat.startsWith("#") ? o.userData.mat : null;   // a library material
    const parts = out.get(o.userData.id), key = rgb.map(x => x.toFixed(3)).join(",") + alpha + (mat || "");
    let part = parts.find(p => p.key === key); if (!part) { part = { key, rgb, alpha, mat, tris: [] }; parts.push(part); }
    // keep the faces facing out of the solid as three.js does (counter-clockwise from outside), mirrored or not
    const flip = o.matrixWorld.determinant() < 0;
    for (let k = 0; k + 2 < n; k += 3) { const a = P(at(k)), b = P(at(k + 1)), c = P(at(k + 2)); part.tris.push(flip ? [a, c, b] : [a, b, c]); }
  });
  return out;
}
