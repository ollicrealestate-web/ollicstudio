// Levels: Level 1 at ±0.000, up to 10 levels, nothing above 40 m. Every change goes through
// these functions so the rules hold however the edit is made (table, elevation view, Properties).
import { MAX_LEVELS, MAX_HEIGHT_MM, DEFAULT_STOREY_MM, newId, levelLabel } from "./model.js";
import { wallHeights } from "./walls.js";

export const sorted = doc => [...doc.levels].sort((a, b) => a.elevation - b.elevation);

/** Floor-to-floor height from a level to the one above (null for the top level). */
export function heightAbove(doc, levelId) {
  const L = sorted(doc), i = L.findIndex(l => l.id === levelId);
  return i >= 0 && i < L.length - 1 ? L[i + 1].elevation - L[i].elevation : null;
}

/** Highest point of the model: top level, and the tops of walls (later floors and roofs too). */
export function modelTop(doc) {
  let top = Math.max(...doc.levels.map(l => l.elevation));
  for (const w of doc.walls) top = Math.max(top, wallHeights(doc, w).z1);
  for (const f of doc.floors || []) { const lv = doc.levels.find(l => l.id === f.levelId); if (lv) top = Math.max(top, lv.elevation + (f.heightOffset || 0)); }
  for (const r of doc.roofs || []) if (r.topZ != null) top = Math.max(top, r.topZ);
  return top;
}

export function checkLevels(doc) {
  if (doc.levels.length > MAX_LEVELS) throw new Error(`A sketch can have up to ${MAX_LEVELS} levels.`);
  const L = sorted(doc);
  for (let i = 1; i < L.length; i++) if (L[i].elevation - L[i - 1].elevation < 1000) throw new Error(`${L[i].name} must be at least 1000 mm above ${L[i - 1].name}.`);
  const names = new Set();
  for (const l of L) { const k = l.name.trim().toLowerCase(); if (!k) throw new Error("Every level needs a name."); if (names.has(k)) throw new Error(`There are two levels called ${l.name}.`); names.add(k); }
  const top = modelTop(doc);
  if (top > MAX_HEIGHT_MM) throw new Error(`That would make the building ${levelLabel(top)} m high. The limit is 40 m (+40.000).`);
}

function nextName(doc) {
  for (let n = doc.levels.length + 1; ; n++) { const name = `Level ${n}`; if (!doc.levels.some(l => l.name === name)) return name; }
}

/** Adds a level above the top one. Throws (without changing anything) when a rule would break. */
export function addLevelAbove(doc, height = DEFAULT_STOREY_MM, name) {
  if (doc.levels.length >= MAX_LEVELS) throw new Error(`A sketch can have up to ${MAX_LEVELS} levels. Delete one to add another.`);
  const top = sorted(doc).at(-1);
  const lv = { id: newId("lv"), name: name || nextName(doc), elevation: top.elevation + height };
  if (lv.elevation > MAX_HEIGHT_MM) throw new Error(`A level at ${levelLabel(lv.elevation)} would pass the 40 m limit.`);
  doc.levels.push(lv);
  checkLevels(doc);
  return lv;
}

/** Changes the floor-to-floor height above a level; every level above moves with it. */
export function setHeightAbove(doc, levelId, height) {
  const L = sorted(doc), i = L.findIndex(l => l.id === levelId);
  if (i < 0 || i === L.length - 1) throw new Error("The top level has no level above it.");
  const delta = height - (L[i + 1].elevation - L[i].elevation);
  for (let k = i + 1; k < L.length; k++) L[k].elevation += delta;
  checkLevels(doc);
}

/** Moves a level to a new elevation; the levels above move by the same amount, keeping their heights. */
export function setElevation(doc, levelId, elevation) {
  const L = sorted(doc), i = L.findIndex(l => l.id === levelId);
  if (i < 0) throw new Error("Level not found.");
  const delta = elevation - L[i].elevation;
  for (let k = i; k < L.length; k++) L[k].elevation += delta;
  checkLevels(doc);
}

export function rename(doc, levelId, name) {
  const lv = doc.levels.find(l => l.id === levelId);
  if (!lv) throw new Error("Level not found.");
  lv.name = String(name).trim().replace(/\s+/g, " ").slice(0, 60);
  checkLevels(doc);
}

/** What would be removed with a level (for the warning). */
export function elementsOn(doc, levelId) {
  return {
    walls: doc.walls.filter(w => w.baseLevelId === levelId).length,
    lines: doc.lines.filter(l => l.levelId === levelId).length,
    floors: (doc.floors || []).filter(f => f.levelId === levelId).length,
    topped: doc.walls.filter(w => w.topLevelId === levelId && w.baseLevelId !== levelId).length,
  };
}

export function deleteLevel(doc, levelId) {
  if (doc.levels.length <= 1) throw new Error("A sketch needs at least one level.");
  const lv = doc.levels.find(l => l.id === levelId);
  if (!lv) throw new Error("Level not found.");
  const gone = new Set(doc.walls.filter(w => w.baseLevelId === levelId).map(w => w.id));
  doc.walls = doc.walls.filter(w => !gone.has(w.id));
  doc.openings = (doc.openings || []).filter(o => !gone.has(o.hostWallId));
  doc.lines = doc.lines.filter(l => l.levelId !== levelId);
  doc.floors = (doc.floors || []).filter(f => f.levelId !== levelId);
  // walls that went up to this level keep their current height, now unconnected
  for (const w of doc.walls) if (w.topLevelId === levelId) {
    const { z0, z1 } = wallHeights(doc, w);
    w.topLevelId = null; w.topOffset = 0; w.unconnectedHeight = z1 - z0;
  }
  doc.levels = doc.levels.filter(l => l.id !== levelId);
}
