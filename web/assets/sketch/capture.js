// Pictures of the model for Ollic AI: clay (plain white, shaded) or material views from the four corners and the
// front, and a plan of each level with element ids and edge numbers written faintly, so it can refer to them.
import * as G from "./geom.js";
import { drawPlanOn, planBox } from "./exports.js";
import { locationPolyline } from "./walls.js";
import { openingFrame } from "./openings.js";
import { floorParts, floorLoops } from "./floors.js";
import { hostEdges } from "./details.js";
import { applySectionBox } from "./views.js";

export const CORNERS = { ne: [1, 0.75, -1], nw: [-1, 0.75, -1], se: [1, 0.75, 1], sw: [-1, 0.75, 1] };
/** three.js direction to look from, for the front (a compass side; plan +y is north, three.js z = -plan y). */
const FRONT = { south: [0, 0.18, 1], north: [0, 0.18, -1], east: [1, 0.18, 0], west: [-1, 0.18, 0] };
export const VIEW_NAMES = ["ne", "nw", "se", "sw", "front"];

/**
 * Renders the named 3D views. style "clay" (white) or "material" (as modelled). Returns [{ name, dataUrl, width, height }].
 * The 3D view on screen is put back as it was.
 */
export async function capture3D(app, names = VIEW_NAMES, { style = "clay", width = 1024, height = 768, quality = 0.85 } = {}) {
  const v = app.view3d, cam = v.camera.position.clone(), target = v.controls.target.clone();
  const keep = { visual: app.prefs.visual, hidden: app.prefs.hidden3D, sel: app.selection, box: app.prefs.sectionBox, paused: v.paused };
  const out = [];
  try {
    app.prefs.visual = "shaded"; app.prefs.hidden3D = []; app.selection = new Set();
    v.paused = false; v.dirty = false; v.rebuild(); if (keep.box) applySectionBox(v, null);
    const swapped = style === "clay" ? clay(v.root) : null;
    try {
      for (const name of names) {
        const front = app.doc.settings?.front || "south";
        v.lookDir(name === "front" ? FRONT[front] || FRONT.south : CORNERS[name] || CORNERS.sw);
        const c = v.snapshot(width, height, { background: style === "clay" ? "white" : "dark" });
        out.push({ name: name === "front" ? `front (${front})` : `corner ${name.toUpperCase()}`, kind: "3d", style, dataUrl: c.toDataURL("image/jpeg", quality), width: c.width, height: c.height });
      }
    } finally { swapped?.(); }
  } finally {
    Object.assign(app.prefs, { visual: keep.visual, hidden3D: keep.hidden }); app.selection = keep.sel; v.paused = keep.paused;
    if (keep.box) applySectionBox(v, keep.box);
    v.camera.position.copy(cam); v.controls.target.copy(target); v.controls.update?.(); v.invalidate();
  }
  return out;
}

/** Swaps every mesh to plain white clay (glass stays see-through) and greys the lines; returns the undo. */
function clay(root) {
  const undo = []; // materials are cloned from the originals
  root.traverse(o => {
    if (o.isMesh && o.material && !Array.isArray(o.material)) {
      const m = o.material, glass = m.transparent && m.opacity < 0.9, c = m.clone();
      if (c.color) c.color.setRGB(glass ? 0.86 : 0.95, glass ? 0.9 : 0.94, glass ? 0.93 : 0.92);
      if ("metalness" in c) { c.metalness = 0; c.roughness = 0.95; }
      if (c.emissive) c.emissive.setRGB(0, 0, 0);
      o.material = c; undo.push(() => { o.material = m; c.dispose(); });
    } else if (o.isLineSegments && o.material?.color) {
      const m = o.material, c = m.clone(); c.color.setRGB(0.45, 0.45, 0.48); o.material = c; undo.push(() => { o.material = m; c.dispose(); });
    }
  });
  return () => undo.forEach(f => f());
}

/**
 * A plan picture of a level on white, with ids written faintly: walls, doors and windows, floors (and their edge
 * numbers), roofs (and theirs), and added parts. Returns { name, dataUrl, labels }.
 */
export function capturePlan(app, levelId, { width = 1024, height = 768, quality = 0.9 } = {}) {
  const box = planBox(app, levelId); if (!box) return null;
  const s = Math.min(width / (box.x1 - box.x0), height / (box.y1 - box.y0));
  const dark = document.createElement("canvas"); dark.width = width; dark.height = height;
  const view = drawPlanOn(app, levelId, dark.getContext("2d"), { w: width, h: height, s, cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, dpr: 1 });
  const c = document.createElement("canvas"); c.width = width; c.height = height;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height);
  ctx.filter = "invert(1) hue-rotate(180deg)"; ctx.drawImage(dark, 0, 0); ctx.filter = "none";
  const doc = app.doc, labels = [];
  const put = (p, text, color, size = 11) => {
    const q = view.toScreen(p); ctx.font = `${size}px Archivo, system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const w = ctx.measureText(text).width + 6; ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.fillRect(q.x - w / 2, q.y - size / 2 - 2, w, size + 4);
    ctx.fillStyle = color; ctx.fillText(text, q.x, q.y); labels.push(text);
  };
  for (const f of doc.floors.filter(x => x.levelId === levelId)) {
    const parts = floorParts(floorLoops(f)); if (!parts.length) continue;
    const o = parts[0].outer, cen = o.reduce((a, p) => G.add(a, G.mul(p, 1 / o.length)), G.P(0, 0));
    put(cen, f.id, "rgba(30,110,60,.85)");
    for (const e of safe(() => hostEdges(doc, f.id))) put(G.add(G.mid(e.a, e.b), G.mul(e.out, 260)), e.ref.split(":")[1], e.exposed ? "rgba(30,110,60,.9)" : "rgba(30,110,60,.55)", 10);
  }
  for (const r of doc.roofs.filter(x => x.baseLevelId === levelId)) for (const e of safe(() => hostEdges(doc, r.id))) put(G.add(G.mid(e.a, e.b), G.mul(e.out, 200)), `${r.id}:${e.ref.split(":")[1]}`, "rgba(90,60,140,.8)", 10);
  for (const w of doc.walls.filter(x => x.baseLevelId === levelId)) { const p = locationPolyline(w); put(G.lerp(p[0], p.at(-1), 0.3), w.id, "rgba(40,70,140,.85)"); }
  for (const o of doc.openings) { const f = openingFrame(doc, o); if (f && f.w.baseLevelId === levelId) put(f.mid, o.id, "rgba(150,70,20,.85)", 10); }
  for (const d of (doc.details || []).filter(x => x.levelId === levelId)) labels.push(d.id);
  const lv = doc.levels.find(l => l.id === levelId);
  ctx.fillStyle = "#333"; ctx.font = "600 13px Archivo, system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(`Plan: ${lv?.name || levelId} (${levelId}). North is up.`, 10, 8);
  return { name: `plan ${lv?.name || levelId}`, kind: "plan", levelId, dataUrl: c.toDataURL("image/jpeg", quality), width, height, labels };
}
const safe = f => { try { return f(); } catch { return []; } };

/** Every picture: 3D views in the given style, plus a plan of each level that has something on it. */
export async function captureViews(app, { views = VIEW_NAMES, style = "clay", plans = true, width = 1024, height = 768 } = {}) {
  const out = await capture3D(app, views, { style, width, height });
  if (plans) for (const l of [...app.doc.levels].sort((a, b) => a.elevation - b.elevation)) { const p = capturePlan(app, l.id, { width, height }); if (p) out.push(p); }
  return out;
}
