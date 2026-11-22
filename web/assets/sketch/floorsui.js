// Floors in the workspace: sketch mode (magenta boundary lines, Pick Walls, Finish/Cancel), plan and 3D, Properties.
import * as G from "./geom.js";
import * as F from "./floors.js";
import { LineTool } from "./tools.js";
import { makeLine, makeArc } from "./elements.js";
import { COLORS } from "./plan.js";
import { newId, levelLabel } from "./model.js";
import { wallHeights } from "./walls.js";
import * as LV from "./levels.js";

export const SKETCH_COLOR = "#ff4fd8";

/** Boundary lines of the sketch being edited. */
export const sketchLines = app => (app.sketch ? app.doc.lines.filter(l => l.kind === "sketch" && l.sketchId === app.sketch.id) : []);

// --------------------------------------------------------------------------- entering and leaving sketch mode
export function startFloorSketch(app, floorId = null) {
  if (app.sketch) { app.toast("Finish or cancel the sketch you are in first."); return; }
  const floor = floorId && app.doc.floors.find(f => f.id === floorId);
  const p = app.prefs.floor || {};
  app.sketch = {
    id: newId("sk"), kind: "floor", levelId: floor ? floor.levelId : app.levelId, editFloorId: floor?.id || null,
    typeId: floor?.typeId || (app.doc.floorTypes.some(t => t.id === p.typeId) ? p.typeId : "ft-rc150"),
    heightOffset: floor ? floor.heightOffset : (p.heightOffset ?? 0), structural: floor ? floor.structural : true,
    bad: new Set(), message: "",
  };
  if (floor) {
    if (floor.levelId !== app.levelId) app.setLevel(floor.levelId);
    app.commit("Edit boundary", doc => {
      for (const c of floor.boundary) {
        const l = c.shape === "arc" ? makeArc("sketch", floor.levelId, "sketch", c) : makeLine("sketch", floor.levelId, "sketch", c.a, c.b);
        l.sketchId = app.sketch.id; doc.lines.push(l);
      }
    });
  }
  app.selection.clear();
  app.setTool("boundary");
  app.sketchChanged();
}

export function cancelSketch(app) {
  const sk = app.sketch; if (!sk) return;
  const ids = new Set(sketchLines(app).map(l => l.id));
  app.sketch = null;
  if (ids.size) app.commit("Cancel sketch", doc => { doc.lines = doc.lines.filter(l => !ids.has(l.id)); });
  app.setTool("select"); app.sketchChanged();
}

export async function finishSketch(app, ui) {
  const sk = app.sketch; if (!sk) return;
  const lines = sketchLines(app);
  const curves = lines.map(l => (l.shape === "arc" ? { shape: "arc", c: l.c, r: l.r, start: l.start, sweep: l.sweep } : { shape: "line", a: l.a, b: l.b }));
  const res = F.checkSketch(curves);
  if (!res.ok) {
    sk.bad = new Set(res.bad.map(i => lines[i].id)); sk.message = res.message;
    app.redraw();
    ui.openDialog(`<h3>Cannot finish the floor</h3><p>${ui.esc(res.message)}</p><p>Fix the lines shown in red, then choose Finish again. Trim/Extend (TR) closes corners; Delete removes extra lines.</p><div class="actions"><button class="btn primary" type="button" id="fOk">Continue sketching</button></div>`, d => { d.querySelector("#fOk").onclick = ui.closeDialog; });
    return;
  }
  const ids = new Set(lines.map(l => l.id));
  const floorId = app.commit(sk.editFloorId ? "Edit floor" : "Floor", doc => {
    doc.lines = doc.lines.filter(l => !ids.has(l.id));
    let f = sk.editFloorId && doc.floors.find(x => x.id === sk.editFloorId);
    if (f) { f.boundary = curves; f.typeId = sk.typeId; f.heightOffset = sk.heightOffset; f.structural = sk.structural; }
    else { f = F.makeFloor(doc, { levelId: sk.levelId, typeId: sk.typeId, heightOffset: sk.heightOffset, structural: sk.structural, boundary: curves }); doc.floors.push(f); }
    LV.checkLevels(doc);
    return f.id;
  });
  if (!floorId) return;
  app.sketch = null;
  app.setTool("select");
  app.selection.clear(); app.selection.add(floorId);
  app.sketchChanged();
  // Attach the walls below to the floor's bottom, as Revit offers
  const cands = wallsUnder(app, floorId);
  if (cands.length && await ui.ask(`Attach the ${cands.length} wall${cands.length > 1 ? "s" : ""} that rise to this floor's level to the floor's underside?`, "Attach")) {
    app.commit("Attach walls to floor", doc => { for (const id of cands) { const w = doc.walls.find(x => x.id === id); w.attachTopTo = floorId; } });
  }
}

/** Walls whose top reaches the floor's level and that sit under it (their centreline inside the floor, not in a hole). */
export function wallsUnder(app, floorId) {
  const doc = app.doc, f = doc.floors.find(x => x.id === floorId); if (!f) return [];
  const lv = doc.levels.find(l => l.id === f.levelId), parts = F.floorParts(F.floorLoops(f));
  const under = p => parts.some(pt => G.pointInPolygon(p, pt.outer) && !pt.holes.some(h => G.pointInPolygon(p, h)));
  return doc.walls.filter(w => {
    if (w.attachTopTo) return false;
    const { z1 } = wallHeights(doc, w);
    if (Math.abs(z1 - lv.elevation) > 1) return false;
    const pts = w.shape === "arc" ? [G.arcStart(w), G.arcMid(w), G.arcEnd(w)] : [G.lerp(w.a, w.b, 0.25), G.mid(w.a, w.b), G.lerp(w.a, w.b, 0.75)];
    return pts.every(under);
  }).map(w => w.id);
}

// --------------------------------------------------------------------------- boundary tool
export class BoundaryTool extends LineTool {
  constructor(app) {
    super(app, "sketch");
    this.name = "boundary"; this.title = "Boundary Line";
    const p = app.prefs.boundary || {};
    this.mode = p.mode || "walls";
    this.toCore = !!p.toCore; this.offset = p.offset || 0; this.chain = p.chain ?? true;
    this.style = "sketch";
  }
  savePrefs() { this.app.prefs.boundary = { mode: this.mode, toCore: this.toCore, offset: this.offset, chain: this.chain }; this.app.savePrefs(); }
  options() {
    const base = super.options().filter(x => x.label !== "Line style" && !String(x.text || "").startsWith("Placement"));
    const seg = base.find(x => x.type === "seg");
    seg.items.unshift({ key: "walls", title: "Pick Walls", icon: "wall", on: this.mode === "walls" });
    const name = base.find(x => x.cls === "modename"); if (name && this.mode === "walls") name.text = "Pick Walls";
    if (this.mode === "walls") base.push({ type: "number", label: "Offset", value: this.offset, step: 50, onChange: v => { this.offset = v || 0; this.savePrefs(); } }, { type: "check", label: "Extend into wall (to core)", value: this.toCore, onChange: v => { this.toCore = v; this.savePrefs(); } });
    return base;
  }
  prompt() { return this.mode === "walls" ? "Click the walls round the floor, on the side the floor is. Corners trim themselves." : super.prompt(); }
  get wantsSnapNow() { return this.mode !== "pick" && this.mode !== "walls"; }
  add(elements, label) {
    const app = this.app, lv = app.sketch.levelId, sid = app.sketch.id;
    app.commit(label, doc => { for (const e of elements) { const l = e.shape === "arc" ? makeArc("sketch", lv, "sketch", e) : makeLine("sketch", lv, "sketch", e.a, e.b); l.sketchId = sid; doc.lines.push(l); } });
    app.sketch.bad.clear();
  }
  move(c) { if (this.mode === "walls") { this.app.updateHover(c); this.cursor = c.raw; this.app.redraw(); return; } super.move(c); }
  down(c) {
    if (this.mode !== "walls") return super.down(c);
    const app = this.app;
    const id = app.hoverList.find(h => app.isWall(h));
    if (!id) { app.toast("Click a wall."); return; }
    const w = app.lookup(id);
    const sid = app.sketch.id;
    app.commit("Pick Walls", doc => {
      const c0 = F.boundaryFromWall(doc, w, c.raw, { extendToCore: this.toCore, offset: this.offset });
      const l = c0.shape === "arc" ? makeArc("sketch", app.sketch.levelId, "sketch", c0) : makeLine("sketch", app.sketch.levelId, "sketch", c0.a, c0.b);
      l.sketchId = sid; doc.lines.push(l);
      const mine = doc.lines.filter(x => x.kind === "sketch" && x.sketchId === sid);
      F.autoTrim(mine, mine.indexOf(l), w.shape === "arc" ? 0 : 3 * (doc.wallTypes.find(t => t.id === w.typeId)?.thickness || 300));
    });
    app.sketch.bad.clear();
  }
  drawPreview(view) {
    if (this.mode === "walls") {
      const app = this.app, id = app.hoverList.find(h => app.isWall(h));
      if (id && this.cursor) { try { const c = F.boundaryFromWall(app.doc, app.lookup(id), this.cursor, { extendToCore: this.toCore, offset: this.offset }); view.drawLine({ ...c, style: "medium" }, SKETCH_COLOR); } catch { /* not pickable */ } }
      return;
    }
    super.drawPreview(view);
  }
}

// --------------------------------------------------------------------------- plan, 3D, picking
export function drawFloors(view, app) {
  const doc = app.doc;
  for (const f of doc.floors) {
    if (f.levelId !== app.levelId || f.id === app.sketch?.editFloorId) continue;
    const sel = app.selection.has(f.id), hov = app.hoverId === f.id;
    const col = sel ? COLORS.sel : hov ? COLORS.hover : "#7a7a86";
    for (const part of F.floorParts(F.floorLoops(f))) {
      view.polygon(part.outer, sel ? "rgba(59,130,246,.10)" : hov ? "rgba(127,176,255,.07)" : "rgba(200,200,210,.035)", col, sel || hov ? 2 : 1);
      for (const h of part.holes) view.polygon(h, null, col, 1);
    }
  }
}

export function floorsAt(app, p, tolMm) {
  const out = [];
  for (const f of app.doc.floors) {
    if (f.levelId !== app.levelId || f.id === app.sketch?.editFloorId) continue;
    for (const part of F.floorParts(F.floorLoops(f))) {
      const inHole = part.holes.some(h => G.pointInPolygon(p, h));
      const edge = [part.outer, ...part.holes].reduce((m, l) => Math.min(m, ...l.map((q, i) => G.projectOnSegment(p, q, l[(i + 1) % l.length]).dist)), Infinity);
      if (edge <= tolMm) out.push({ id: f.id, d: edge + 0.4 });
      else if (G.pointInPolygon(p, part.outer) && !inHole) out.push({ id: f.id, d: tolMm * 0.95 }); // inside: lowest priority
    }
  }
  return out;
}

export function buildFloors3D(group, THREE, app, visible) {
  const doc = app.doc, style = app.prefs.visual || "shaded";
  for (const f of doc.floors) {
    if ((visible && !visible.has(f.levelId)) || f.id === app.sketch?.editFloorId) continue;
    const { top, bottom } = F.floorLevels(doc, f), sel = app.selection.has(f.id);
    for (const part of F.floorParts(F.floorLoops(f))) {
      const shape = new THREE.Shape(part.outer.map(p => new THREE.Vector2(p.x / 1000, p.y / 1000)));
      for (const h of [...part.holes, ...(app.floorVoidHoles?.(part, top, bottom) || [])]) shape.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p.x / 1000, p.y / 1000))));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: (top - bottom) / 1000, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2); geo.translate(0, bottom / 1000, 0);
      if (style !== "wire") {
        const colour = sel ? 0x3b82f6 : 0xb9b6ae;
        const mat = style === "hidden" ? new THREE.MeshBasicMaterial({ color: 0xf2f2f2, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
          : style === "consistent" ? new THREE.MeshBasicMaterial({ color: colour, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
          : new THREE.MeshStandardMaterial({ color: colour, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        const m = new THREE.Mesh(geo, mat); m.userData.id = f.id; m.castShadow = m.receiveShadow = style === "realistic"; group.add(m);
      }
      group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color: style === "wire" ? (sel ? 0x3b82f6 : 0xe8e8ec) : style === "hidden" ? 0x111111 : 0x1b1b20 })));
    }
  }
}

// --------------------------------------------------------------------------- properties
export function floorProps(app, ids, esc) {
  const doc = app.doc, fls = ids.map(id => doc.floors.find(f => f.id === id)), one = fls.length === 1 ? fls[0] : null;
  const same = k => fls.every(f => f[k] === fls[0][k]) ? fls[0][k] : undefined;
  const typeId = same("typeId"), lv = LV.sorted(doc);
  const area = one ? F.floorArea(F.floorParts(F.floorLoops(one))) / 1e6 : null;
  return `<div class="ptype"><div class="row"><span>Floor${one ? "" : `s (${fls.length})`}</span><button class="btn" type="button" id="pEditType"${typeId ? "" : " disabled"}>Edit Type</button></div>
    <select id="pType" aria-label="Floor type">${typeId ? "" : `<option value="" selected>(varies)</option>`}${doc.floorTypes.map(t => `<option value="${esc(t.id)}"${t.id === typeId ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
    <div class="pgroup">Constraints</div>
    <div class="prow"><span>Level</span><select id="pLevel">${same("levelId") ? "" : `<option value="" selected>(varies)</option>`}${lv.map(l => `<option value="${esc(l.id)}"${l.id === same("levelId") ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select></div>
    <div class="prow"><span>Height Offset From Level</span><input id="pHOff" type="number" step="10" value="${same("heightOffset") ?? ""}"></div>
    <div class="pgroup">Structural</div>
    <div class="prow"><span>Structural</span><input id="pStruct" type="checkbox"${fls.every(f => f.structural) ? " checked" : ""}></div>
    ${one ? `<div class="pgroup">Dimensions</div>
    <div class="prow"><span>Thickness</span><input readonly value="${F.floorType(doc, one).thickness}"></div>
    <div class="prow"><span>Area</span><input readonly value="${area.toFixed(2)} m²"></div>
    <div class="prow"><span>Top</span><input readonly value="${levelLabel(F.floorLevels(doc, one).top)}"></div>
    <div class="prow"><span></span><button class="btn" type="button" id="pEditB">Edit Boundary</button></div>` : ""}
    <div class="pnote">Double-click a floor to edit its boundary.</div>`;
}

export function wireFloorProps(app, ids, renderProps, ui) {
  const $ = s => document.querySelector(s);
  const edit = (label, fn) => app.commit(label, doc => { for (const id of ids) fn(doc.floors.find(f => f.id === id)); LV.checkLevels(doc); }) === undefined && renderProps();
  $("#pType").onchange = e => e.target.value && edit("Floor type", f => { f.typeId = e.target.value; });
  $("#pLevel").onchange = e => e.target.value && edit("Floor level", f => { f.levelId = e.target.value; });
  $("#pHOff").onchange = e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) edit("Height offset", f => { f.heightOffset = v; }); };
  $("#pStruct").onchange = e => edit("Structural", f => { f.structural = e.target.checked; });
  const eb = $("#pEditB"); if (eb) eb.onclick = () => startFloorSketch(app, ids[0]);
  const et = $("#pEditType"); if (et) et.onclick = () => floorTypeDialog(app, app.doc.floors.find(f => f.id === ids[0]).typeId, ui);
}

export function sketchProps(app, esc) {
  const sk = app.sketch, doc = app.doc;
  return `<div class="ptype"><div class="row"><span>Floor</span><span>Sketch mode</span></div>
    <select id="skType" aria-label="Floor type">${doc.floorTypes.map(t => `<option value="${esc(t.id)}"${t.id === sk.typeId ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
    <div class="pgroup">Constraints</div>
    <div class="prow"><span>Level</span><input readonly value="${esc(doc.levels.find(l => l.id === sk.levelId)?.name || "")}"></div>
    <div class="prow"><span>Height Offset From Level</span><input id="skHOff" type="number" step="10" value="${sk.heightOffset}"></div>
    <div class="prow"><span>Structural</span><input id="skStruct" type="checkbox"${sk.structural ? " checked" : ""}></div>
    <div class="pnote">Draw the boundary in magenta: closed loops, no crossings. An inner loop makes a hole (a stair void). Then choose <b>Finish Edit Mode</b>.${sk.message ? `<br><span style="color:#ff8a8d">${esc(sk.message)}</span>` : ""}</div>`;
}

export function wireSketchProps(app) {
  const $ = s => document.querySelector(s), sk = app.sketch;
  $("#skType").onchange = e => { sk.typeId = e.target.value; app.prefs.floor = { ...(app.prefs.floor || {}), typeId: sk.typeId }; app.savePrefs(); };
  $("#skHOff").onchange = e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { sk.heightOffset = v; app.prefs.floor = { ...(app.prefs.floor || {}), heightOffset: v }; app.savePrefs(); } };
  $("#skStruct").onchange = e => { sk.structural = e.target.checked; };
}

export function floorTypeDialog(app, typeId, ui) {
  const doc = app.doc, t = doc.floorTypes.find(x => x.id === typeId); if (!t) return;
  ui.openDialog(`<h3>Type Properties</h3><p>Floor type ${ui.esc(t.name)}. Changes apply to every floor of this type.</p>
    <table><tr><th>Parameter</th><th>Value</th></tr>
    <tr><td>Type name</td><td><input id="tName" value="${ui.esc(t.name)}" maxlength="80"></td></tr>
    <tr><td>Thickness (mm)</td><td><input id="tThick" type="number" min="50" max="1500" step="10" value="${t.thickness}"></td></tr>
    <tr><td>Function</td><td><select id="tFunc"><option value="structural"${t.function !== "finish" ? " selected" : ""}>Structural slab</option><option value="finish"${t.function === "finish" ? " selected" : ""}>Finish</option></select></td></tr></table>
    <div id="tErr"></div><div class="actions"><button class="btn" type="button" id="tDup">Duplicate…</button><button class="btn" type="button" id="tCancel">Cancel</button><button class="btn primary" type="button" id="tOk">OK</button></div>`, d => {
    const read = () => ({ name: d.querySelector("#tName").value.trim(), thickness: parseFloat(d.querySelector("#tThick").value), function: d.querySelector("#tFunc").value });
    const err = m => { d.querySelector("#tErr").innerHTML = `<div class="err">${ui.esc(m)}</div>`; };
    const bad = (v, id) => !v.name ? "Give the type a name." : !(v.thickness >= 50 && v.thickness <= 1500) ? "Thickness must be between 50 and 1500 mm." : doc.floorTypes.some(x => x.id !== id && x.name.toLowerCase() === v.name.toLowerCase()) ? "Another floor type already has that name." : "";
    d.querySelector("#tCancel").onclick = ui.closeDialog;
    d.querySelector("#tOk").onclick = () => { const v = read(), e = bad(v, t.id); if (e) return err(e); app.commit("Edit floor type", dd => Object.assign(dd.floorTypes.find(x => x.id === t.id), v)); ui.closeDialog(); };
    d.querySelector("#tDup").onclick = async () => { const v = read(); const name = await ui.askText("Name for the new type", `RC slab ${v.thickness} mm`); if (!name) return; const nt = { ...t, ...v, id: newId("ft"), name }; const e = bad(nt, nt.id); if (e) return err(e); app.commit("Duplicate floor type", dd => dd.floorTypes.push(nt)); ui.closeDialog(); };
  });
}

/** Attach Top: chooses a floor above the selected walls; Detach clears it. */
export function attachTopDialog(app, ui) {
  const doc = app.doc, ids = [...app.selection].filter(id => app.isWall(id));
  if (!ids.length) { app.toast("Select walls first."); return; }
  const minBase = Math.min(...ids.map(id => wallHeights(doc, doc.walls.find(w => w.id === id)).z0));
  const above = doc.floors.filter(f => F.floorLevels(doc, f).bottom > minBase + 100);
  ui.openDialog(`<h3>Attach Top/Base</h3><p>Attach the top of the ${ids.length} selected wall${ids.length > 1 ? "s" : ""} to the underside of a floor, or detach them.</p>
    <div class="list">${above.map(f => `<button type="button" data-f="${f.id}"><span>${ui.esc(F.floorType(doc, f).name)} on ${ui.esc(doc.levels.find(l => l.id === f.levelId)?.name || "")}</span><small>underside ${levelLabel(F.floorLevels(doc, f).bottom)}</small></button>`).join("") || "<p>No floor above these walls yet.</p>"}</div>
    <div class="actions"><button class="btn" type="button" id="aDetach">Detach Top</button><button class="btn" type="button" id="aCancel">Cancel</button></div>`, d => {
    d.querySelector("#aCancel").onclick = ui.closeDialog;
    d.querySelector("#aDetach").onclick = () => { app.commit("Detach top", dd => ids.forEach(id => { const w = dd.walls.find(x => x.id === id); const { z0, z1 } = wallHeights(dd, w); if (w.attachTopTo) { delete w.attachTopTo; if (!w.topLevelId) w.unconnectedHeight = z1 - z0; } })); ui.closeDialog(); };
    d.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { app.commit("Attach top", dd => ids.forEach(id => { dd.walls.find(x => x.id === id).attachTopTo = b.dataset.f; })); ui.closeDialog(); });
  });
}
