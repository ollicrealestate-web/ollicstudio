// A compact summary of the model for Ollic AI: levels, walls (with the compass direction their outer face looks),
// openings, floors and roofs with numbered edges, and what has been added already. Sizes in mm, areas in m².
import * as G from "./geom.js";
import { wallType, wallHeights, wallLength, extSign, centrePolyline } from "./walls.js";
import { openingType, openingFrame, isDoor } from "./openings.js";
import { floorParts, floorLoops, floorLevels, floorArea, floorType } from "./floors.js";
import { roofFootprint, roofType, roofGeometry } from "./roofs.js";
import { hostEdges, detailParts, KINDS } from "./details.js";
import { partBoxes } from "./checks.js";
import { matName } from "./library.js";

const DIRS = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"];
/** Compass direction of a plan vector (plan +y is north). */
export const compass = v => DIRS[((Math.round(Math.atan2(v.y, v.x) / (Math.PI / 4)) % 8) + 8) % 8];
const r0 = v => Math.round(v);
const pt = p => [r0(p.x), r0(p.y)];

/** Outward normal of a straight wall's exterior face. */
export function wallOut(doc, w) {
  const c = centrePolyline(w, wallType(doc, w)), u = G.norm(G.sub(c.at(-1), c[0]));
  return G.mul(G.perp(u), extSign(w));
}

/**
 * The summary. scope: { levels: [level ids], ids: [element ids] } to cut it down (walls, openings, floors, roofs and
 * details on those levels or with those ids); omitted = the whole model.
 */
export function modelSummary(doc, scope = {}) {
  const lv = [...doc.levels].sort((a, b) => a.elevation - b.elevation);
  const inLv = id => !scope.levels?.length || scope.levels.includes(id);
  const inIds = id => !scope.ids?.length || scope.ids.includes(id);
  const keep = (id, levelId) => inLv(levelId) && inIds(id);
  const out = {
    project: doc.name, units: "mm", north: "plan +y", front: doc.settings?.front || null,
    levels: lv.map((l, i) => ({ id: l.id, name: l.name, elevation: l.elevation, height_to_next: lv[i + 1] ? lv[i + 1].elevation - l.elevation : null })),
    walls: [], openings: [], floors: [], roofs: [], added: [],
  };
  for (const w of doc.walls) {
    if (!keep(w.id, w.baseLevelId)) continue;
    const t = wallType(doc, w), { z0, z1 } = wallHeights(doc, w);
    const e = { id: w.id, type: t.name, function: t.function, thickness: t.thickness, length: r0(wallLength(w)), level: w.baseLevelId, base: r0(z0), top: r0(z1) };
    if (w.shape === "line") { e.start = pt(w.a); e.end = pt(w.b); e.outer_face_faces = compass(wallOut(doc, w)); }
    else { e.curved = true; e.centre = pt(w.c); e.radius = r0(w.r); }
    if (w.material) e.material = w.material;
    if (w.finishes) e.finishes = w.finishes;
    e.openings = doc.openings.filter(o => o.hostWallId === w.id).map(o => o.id);
    out.walls.push(e);
  }
  for (const o of doc.openings) {
    const w = doc.walls.find(x => x.id === o.hostWallId); if (!w || !keep(o.id, w.baseLevelId) && !(scope.ids?.includes(w.id))) continue;
    const t = openingType(doc, o), f = openingFrame(doc, o);
    out.openings.push({ id: o.id, kind: isDoor(o) ? "door" : "window", type: t.name, width: t.width, height: t.height, sill: o.sillHeight, wall: w.id, centre_along_wall: r0(o.positionAlongWall), from_along_wall: r0(o.positionAlongWall - t.width / 2), to_along_wall: r0(o.positionAlongWall + t.width / 2), head: f ? r0(f.zHead) : null, faces: w.shape === "line" ? compass(wallOut(doc, w)) : null });
  }
  for (const f of doc.floors) {
    if (!keep(f.id, f.levelId)) continue;
    const { top } = floorLevels(doc, f);
    out.floors.push({ id: f.id, type: floorType(doc, f).name, level: f.levelId, top: r0(top), thickness: floorType(doc, f).thickness, area_m2: +(floorArea(floorParts(floorLoops(f))) / 1e6).toFixed(2), edges: edgesOut(doc, f.id) });
  }
  for (const r of doc.roofs) {
    if (!keep(r.id, r.baseLevelId)) continue;
    const e = { id: r.id, type: roofType(doc, r).name, method: r.method, base_level: r.baseLevelId };
    try {
      const g = roofGeometry(doc, r); e.top = r0(g.top); e.underside_lowest = r0(g.bottom);
      if (r.method !== "extrusion") {
        const { slopes, overhangs } = roofFootprint(r);
        e.shape = slopes.every(s => s == null) ? "flat" : slopes.filter(s => s != null).length === 1 ? "mono-pitch" : slopes.some(s => s == null) ? "gable" : "hip";
        e.slopes_deg = slopes.map(s => (s == null ? null : +(s * 180 / Math.PI).toFixed(1))); e.overhangs = overhangs.map(r0);
        e.edges = edgesOut(doc, r.id);
      }
    } catch (err) { e.problem = err.message; }
    if (r.material) e.material = r.material;
    out.roofs.push(e);
  }
  for (const d of doc.details || []) {
    if (!keep(d.id, d.levelId)) continue;
    const b = detailParts(doc, d).flatMap(partBoxes);
    out.added.push({ id: d.id, kind: KINDS[d.kind]?.label || d.kind, name: d.name, level: d.levelId, material: matName(d.args?.material), by: d.source === "ai" ? "Ollic AI" : "user", plan_item: d.planItem ?? null, in_proposal: d.option === "ai-proposal", bottom: b.length ? r0(Math.min(...b.map(x => x.z0))) : null, top: b.length ? r0(Math.max(...b.map(x => x.z1))) : null });
  }
  for (const c of doc.components) {
    if (!keep(c.id, c.levelId || doc.walls.find(w => w.id === c.wallIds?.[0])?.baseLevelId)) continue;
    out.added.push({ id: c.id, kind: c.kind === "wallSweep" ? (c.reveal ? "Wall reveal" : "Wall sweep") : c.isVoid ? "Void" : c.kind === "sweep" ? "Sweep" : "Extrusion", name: c.name || null, material: c.isVoid ? null : matName(c.material), by: c.source === "ai" ? "Ollic AI" : "user", plan_item: c.planItem ?? null, in_proposal: c.option === "ai-proposal" });
  }
  return out;
}
function edgesOut(doc, id) {
  try { return hostEdges(doc, id).map(e => ({ ref: e.ref, a: pt(e.a), b: pt(e.b), length: r0(e.len), faces: compass(e.out), top: r0(e.zA), level_edge: Math.abs(e.zA - e.zB) < 5, wall_on_or_under: !e.exposed })); }
  catch { return []; }
}

/** What must be in place before Ollic AI can complete the design; [] when ready. Plain words. */
export function readiness(doc) {
  const issues = [];
  if (!doc.levels.length) issues.push("There are no levels yet.");
  if (!doc.walls.some(w => wallType(doc, w).function === "exterior")) issues.push("There are no outer (exterior) walls yet.");
  const lv = [...doc.levels].sort((a, b) => a.elevation - b.elevation);
  for (const l of lv) {
    const walls = doc.walls.filter(w => w.baseLevelId === l.id && wallType(doc, w).function === "exterior");
    if (!walls.length) continue;
    if (!closedRing(walls)) issues.push(`The outer walls on ${l.name} do not close into a loop yet.`);
  }
  const withWalls = lv.filter(l => doc.walls.some(w => w.baseLevelId === l.id));
  for (const l of withWalls.slice(1)) if (!doc.floors.some(f => f.levelId === l.id)) issues.push(`${l.name} has no floor yet.`);
  if (!doc.floors.length && !doc.roofs.length) issues.push("Add a floor or a roof.");
  return issues;
}
/** Do these walls' ends all meet another wall's end (a closed loop or loops)? */
function closedRing(walls) {
  const ends = walls.flatMap(w => (w.shape === "arc" ? [G.arcStart(w), G.arcEnd(w)] : [w.a, w.b]));
  const onOther = (p, k) => walls.some((w, j) => j !== k && (w.shape === "arc" ? Math.abs(G.dist(p, w.c) - w.r) <= 5 : G.projectOnSegment(p, w.a, w.b).dist <= 5));
  return ends.every((p, i) => onOther(p, Math.floor(i / 2))) || walls.every(w => w.shape === "arc" && G.isCircle(w));
}
