// Doors and windows in the workspace: placing, plan symbols, tags, 3D, Properties, types and the schedule.
import * as G from "./geom.js";
import { matColor } from "./library.js";
import * as O from "./openings.js";
import { wallHeights, wallType, locationPolyline } from "./walls.js";
import { COLORS } from "./plan.js";
import { newId, levelLabel } from "./model.js";

const TAG_OFFSET = 650; // mm from the wall centre to the tag

/** Nearest straight wall on this level to point p, with the position along it. */
export function wallUnder(app, p, tolMm) {
  let best = null;
  const fp = app.footprints(app.levelId);
  for (const w of app.wallsOnLevel()) {
    if (w.shape !== "line") continue;
    const f = fp.get(w.id);
    const inside = f?.pieces.some(pc => G.pointInPolygon(p, pc));
    const pr = G.projectOnSegment(p, w.a, w.b);
    const d = inside ? 0 : pr.dist;
    if (d <= tolMm && (!best || d < best.d)) best = { w, d, s: pr.t * G.dist(w.a, w.b), side: Math.sign(G.cross(G.sub(w.b, w.a), G.sub(p, w.a))) || 1 };
  }
  return best;
}

/** Faces of the walls that meet or cross a host wall, plus the host's own ends, as distances along the host. */
export function referencesAlong(app, w) {
  const doc = app.doc, ax = O.wallAxis(doc, w), refs = [0, ax.L];
  const fp = app.footprints(w.baseLevelId);
  for (const o of doc.walls) {
    if (o.id === w.id || o.baseLevelId !== w.baseLevelId || o.shape !== "line") continue;
    const f = fp.get(o.id); if (!f) continue;
    const c = f.centre, uo = G.norm(G.sub(c[1], c[0])), Lo = G.dist(c[0], c[1]);
    const sinA = Math.abs(G.cross(ax.u, uo));
    if (sinA < 0.05) continue; // parallel walls are not references along this wall
    const hit = G.lineIntersect(ax.c0, G.add(ax.c0, ax.u), c[0], c[1]);
    const reach = (ax.h + 5) / Lo;
    if (!hit || hit.u < -reach || hit.u > 1 + reach) continue; // the other wall must reach this wall
    const at = G.dot(G.sub(hit.point, ax.c0), ax.u), half = f.h / sinA;
    for (const r of [at - half, at + half]) if (r > -ax.h - 1 && r < ax.L + ax.h + 1) refs.push(r);
  }
  return [...new Set(refs.map(r => Math.round(r * 10) / 10))].sort((a, b) => a - b);
}

/** Distances from the opening's edges to the nearest reference on each side (for temporary dimensions). */
function edgeDims(app, w, s0, s1) {
  const refs = referencesAlong(app, w);
  const left = refs.filter(r => r <= s0 + 0.5).pop(), right = refs.find(r => r >= s1 - 0.5);
  return { left, right };
}

// --------------------------------------------------------------------------- tool
export class OpeningTool {
  constructor(app, kind) {
    this.app = app; this.kind = kind; this.name = kind; this.title = kind === "door" ? "Door" : "Window";
    const p = app.prefs[kind] || (app.prefs[kind] = {});
    const list = this.types();
    this.typeId = list.some(t => t.id === p.typeId) ? p.typeId : list[0].id;
    this.tag = p.tag ?? true;
    this.sill = p.sill ?? null;
    this.flip = false; this.hover = null; this.wantsSnap = false;
  }
  types() { return this.kind === "door" ? this.app.doc.doorTypes : this.app.doc.windowTypes; }
  type() { return this.types().find(t => t.id === this.typeId) || this.types()[0]; }
  savePrefs() { this.app.prefs[this.kind] = { typeId: this.typeId, tag: this.tag, sill: this.sill }; this.app.savePrefs(); }
  sillValue() { return this.kind === "door" ? 0 : (this.sill ?? this.type().sill ?? 900); }
  options() {
    const o = [{ type: "text", text: this.title, cls: "modename" },
      { type: "select", label: "Type", value: this.typeId, items: this.types().map(t => ({ value: t.id, label: t.name })), onChange: v => { this.typeId = v; this.sill = null; this.savePrefs(); this.app.toolChanged(); } },
      { type: "check", label: "Tag on placement", value: this.tag, onChange: v => { this.tag = v; this.savePrefs(); } }];
    if (this.kind === "window") o.push({ type: "number", label: "Sill Height", value: this.sillValue(), step: 50, min: 0, onChange: v => { if (v >= 0) { this.sill = v; this.savePrefs(); } } });
    o.push({ type: "text", text: "Space flips the side it opens to." });
    return o;
  }
  prompt() { return this.hover ? `Click to place the ${this.title.toLowerCase()} (${this.type().width} x ${this.type().height}).` : `Move over a wall to place a ${this.title.toLowerCase()}.`; }
  placement(c) {
    const app = this.app, hit = wallUnder(app, c.raw, app.plan.px(12));
    if (!hit) return null;
    const t = this.type(), L = G.dist(hit.w.a, hit.w.b);
    if (t.width > L) return { w: hit.w, bad: `This ${this.title.toLowerCase()} (${t.width} mm) is wider than the wall (${Math.round(L)} mm).` };
    const s = Math.max(t.width / 2, Math.min(L - t.width / 2, hit.s));
    return { w: hit.w, s, side: hit.side };
  }
  move(c) { this.hover = this.placement(c); this.app.redraw(); }
  down(c) {
    const pl = this.placement(c);
    if (!pl) { this.app.toast(`Click on a straight wall to place the ${this.title.toLowerCase()}.`); return; }
    if (pl.bad) { this.app.toast(pl.bad, true); return; }
    const app = this.app;
    const id = app.commit(`Place ${this.title}`, doc => {
      const o = O.makeOpening(doc, this.kind, this.typeId, pl.w.id, pl.s, { sillHeight: this.sillValue(), flipFacing: this.flip !== (pl.side < 0) });
      O.checkOpening(doc, o);
      doc.openings.push(o);
      if (this.tag) doc.tags.push({ id: newId("tg"), hostId: o.id, viewId: `plan:${app.levelId}` });
      return o.id;
    });
    if (id) { app.selection.clear(); app.selection.add(id); }
  }
  key(e) { if (e.key === " ") { this.flip = !this.flip; this.app.redraw(); return true; } return false; }
  escape() { return false; }
  drawPreview(view) {
    const pl = this.hover; if (!pl || pl.bad) return;
    const doc = this.app.doc, fake = { id: "_preview", kind: this.kind, typeId: this.typeId, hostWallId: pl.w.id, positionAlongWall: pl.s, sillHeight: this.sillValue(), flipFacing: this.flip !== (pl.side < 0), flipHand: false };
    const f = O.openingFrame({ ...doc, openings: [] }, fake);
    if (!f) return;
    view.polygon(f.corners, "rgba(255,74,79,.18)", COLORS.preview, 1.5);
    drawSymbol(view, f, fake, COLORS.preview);
    const { left, right } = edgeDims(this.app, pl.w, f.s0, f.s1);
    const at = s => G.add(f.ax.c0, G.mul(f.ax.u, s)), off = G.mul(f.ax.n, f.ax.h + view.px(18));
    if (left !== undefined && f.s0 - left > 1) view.tempDim(G.add(at(left), off), G.add(at(f.s0), off), String(Math.round(f.s0 - left)), { offsetPx: 0 });
    if (right !== undefined && right - f.s1 > 1) view.tempDim(G.add(at(f.s1), off), G.add(at(right), off), String(Math.round(right - f.s1)), { offsetPx: 0 });
  }
}

// --------------------------------------------------------------------------- plan
/** Door and window symbols. The door swings to the facing side; the hinge is at the start unless flipped. */
export function drawSymbol(view, f, o, color) {
  const { ax, s0, s1, t } = f;
  const face = o.flipFacing ? -1 : 1, n = G.mul(ax.n, face), h = ax.h;
  const at = (s, k = 0) => G.add(G.add(ax.c0, G.mul(ax.u, s)), G.mul(n, k));
  const W = s1 - s0;
  if (O.isDoor(o)) {
    const leaf = (hingeS, closedS, width) => {
      const hinge = at(hingeS, h), open = G.add(hinge, G.mul(n, width)), closed = at(closedS, h);
      view.segment(hinge, open, color, 2);
      const a0 = G.angleOf(G.sub(open, hinge)), a1 = G.angleOf(G.sub(closed, hinge));
      let sw = a1 - a0; if (sw > Math.PI) sw -= G.TAU; if (sw < -Math.PI) sw += G.TAU;
      view.drawLine({ shape: "arc", c: hinge, r: width, start: a0, sweep: sw, style: "thin" }, color);
    };
    const style = t.style || "single";
    const hingeAtStart = !o.flipHand;
    if (style === "double") { leaf(s0, s0 + W / 2, W / 2); leaf(s1, s1 - W / 2, W / 2); }
    else if (style === "sliding") { view.segment(at(s0, h * 0.35), at(s0 + W * 0.55, h * 0.35), color, 2); view.segment(at(s1 - W * 0.55, -h * 0.35), at(s1, -h * 0.35), color, 2); }
    else if (style === "garage") { view.segment(at(s0, 0), at(s1, 0), color, 1, [8, 5]); view.segment(at(s0, h), at(s1, h), color, 1.5); }
    else if (hingeAtStart) leaf(s0, s1, W); else leaf(s1, s0, W);
    view.segment(at(s0, -h), at(s0, h), color, 1); view.segment(at(s1, -h), at(s1, h), color, 1);
  } else {
    const style = t.style || "casement";
    view.segment(at(s0, h), at(s1, h), color, 1); view.segment(at(s0, -h), at(s1, -h), color, 1);
    if (style === "sliding") { view.segment(at(s0, h * 0.2), at(s0 + W * 0.55, h * 0.2), color, 1.5); view.segment(at(s1 - W * 0.55, -h * 0.2), at(s1, -h * 0.2), color, 1.5); }
    else if (style === "fixed") view.segment(at(s0, 0), at(s1, 0), color, 1.5);
    else { view.segment(at(s0, h * 0.15), at(s1, h * 0.15), color, 1); view.segment(at(s0, -h * 0.15), at(s1, -h * 0.15), color, 1); }
    view.segment(at(s0, -h), at(s0, h), color, 1); view.segment(at(s1, -h), at(s1, h), color, 1);
    // sill line on the outside face
    view.segment(at(s0 - 40, (h + 40) * -face * face), at(s1 + 40, (h + 40) * -face * face), color, 1);
  }
}

export function drawOpenings(view, app) {
  const doc = app.doc, lvWalls = new Set(app.wallsOnLevel().map(w => w.id));
  for (const o of doc.openings) {
    if (!lvWalls.has(o.hostWallId)) continue;
    const f = O.openingFrame(doc, o); if (!f) continue;
    const col = app.selection.has(o.id) ? COLORS.sel : app.hoverId === o.id ? COLORS.hover : COLORS.line;
    if (app.selection.has(o.id) || app.hoverId === o.id) view.polygon(f.corners, "rgba(59,130,246,.15)", null);
    drawSymbol(view, f, o, col);
  }
  // tags
  const vid = `plan:${app.levelId}`;
  for (const tg of doc.tags) {
    if (tg.viewId !== vid) continue;
    const o = doc.openings.find(x => x.id === tg.hostId); if (!o) continue;
    const f = O.openingFrame(doc, o); if (!f) continue;
    const face = o.flipFacing ? 1 : -1; // tags sit on the side away from the swing
    const p = G.add(f.mid, G.mul(f.ax.n, face * (f.ax.h + TAG_OFFSET)));
    const text = O.typeMark(doc, o), s = view.toScreen(p), ctx = view.ctx;
    ctx.font = "600 11px Archivo, system-ui, sans-serif";
    const w = Math.max(24, ctx.measureText(text).width + 10);
    ctx.fillStyle = "#0c0c0e"; ctx.strokeStyle = app.selection.has(o.id) ? COLORS.sel : "#c9c9d2"; ctx.lineWidth = 1;
    if (O.isDoor(o)) { ctx.beginPath(); ctx.ellipse(s.x, s.y, w / 2, 10, 0, 0, G.TAU); ctx.fill(); ctx.stroke(); }
    else { ctx.fillRect(s.x - w / 2, s.y - 9, w, 18); ctx.strokeRect(s.x - w / 2 + 0.5, s.y - 9 + 0.5, w, 18); }
    ctx.fillStyle = "#e8e8ec"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(text, s.x, s.y + 0.5);
  }
}

/** Temporary dimensions and flip arrows for one selected opening. */
export function drawOpeningDims(view, app, o, inlineEdit) {
  const doc = app.doc, f = O.openingFrame(doc, o); if (!f) return;
  const { left, right } = edgeDims(app, f.w, f.s0, f.s1);
  const at = s => G.add(f.ax.c0, G.mul(f.ax.u, s)), off = G.mul(f.ax.n, -(f.ax.h + view.px(18)) * (o.flipFacing ? -1 : 1));
  const move = (label, newPos) => app.commit(label, dd => { const x = dd.openings.find(q => q.id === o.id); x.positionAlongWall = newPos; O.checkOpening(dd, x); });
  if (left !== undefined && f.s0 - left > 0.5) {
    const v = Math.round(f.s0 - left);
    view.tempDim(G.add(at(left), off), G.add(at(f.s0), off), String(v), { offsetPx: 0, onClick: box => inlineEdit(box, v, nv => move("Move opening", o.positionAlongWall + (nv - v))) });
  }
  if (right !== undefined && right - f.s1 > 0.5) {
    const v = Math.round(right - f.s1);
    view.tempDim(G.add(at(f.s1), off), G.add(at(right), off), String(v), { offsetPx: 0, onClick: box => inlineEdit(box, v, nv => move("Move opening", o.positionAlongWall - (nv - v))) });
  }
  // flip controls: facing (across the wall) and hand (along the wall)
  const arrows = (p, dir, onClick) => {
    const s = view.toScreen(p), q = view.toScreen(G.add(p, dir)), dx = q.x - s.x, dy = q.y - s.y, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, ctx = view.ctx;
    ctx.strokeStyle = COLORS.sel; ctx.lineWidth = 1.6; ctx.beginPath();
    ctx.moveTo(s.x - ux * 7, s.y - uy * 7); ctx.lineTo(s.x + ux * 7, s.y + uy * 7);
    for (const k of [1, -1]) { ctx.moveTo(s.x + ux * 7 * k, s.y + uy * 7 * k); ctx.lineTo(s.x + ux * 3 * k - uy * 4, s.y + uy * 3 * k + ux * 4); ctx.moveTo(s.x + ux * 7 * k, s.y + uy * 7 * k); ctx.lineTo(s.x + ux * 3 * k + uy * 4, s.y + uy * 3 * k - ux * 4); }
    ctx.stroke();
    view.hits.push({ x0: s.x - 10, y0: s.y - 10, x1: s.x + 10, y1: s.y + 10, cx: s.x, cy: s.y, onClick });
  };
  const face = o.flipFacing ? -1 : 1;
  arrows(G.add(f.mid, G.mul(f.ax.n, face * (f.ax.h + view.px(30)))), f.ax.n, () => app.commit("Flip facing", dd => { const x = dd.openings.find(q => q.id === o.id); x.flipFacing = !x.flipFacing; }));
  if (O.isDoor(o)) arrows(G.add(at(f.s1 + view.px(16)), G.mul(f.ax.n, face * f.ax.h)), f.ax.u, () => app.commit("Flip hand", dd => { const x = dd.openings.find(q => q.id === o.id); x.flipHand = !x.flipHand; }));
}

/** Openings under a point (for hover and click), as {id, d}. */
export function openingsAt(app, p) {
  const lvWalls = new Set(app.wallsOnLevel().map(w => w.id)), out = [];
  for (const o of app.doc.openings) {
    if (!lvWalls.has(o.hostWallId)) continue;
    const f = O.openingFrame(app.doc, o); if (!f) continue;
    const grown = f.corners.map(c => G.add(c, G.mul(G.norm(G.sub(c, f.mid)), app.plan.px(4))));
    if (G.pointInPolygon(p, grown)) out.push({ id: o.id, d: 0.2 });
  }
  return out;
}

// --------------------------------------------------------------------------- 3D
export function buildOpenings3D(group, THREE, app, visible) {
  const doc = app.doc, style = app.prefs.visual || "shaded";
  for (const o of doc.openings) {
    const w = O.hostOf(doc, o); if (!w || (visible && !visible.has(w.baseLevelId))) continue;
    const f = O.openingFrame(doc, o); if (!f) continue;
    const sel = app.selection.has(o.id);
    const ang = Math.atan2(f.ax.u.y, f.ax.u.x), width = (f.s1 - f.s0) / 1000, hgt = (f.zHead - f.zSill) / 1000, thick = (f.ax.h * 2) / 1000;
    const g = new THREE.Group();
    g.position.set(f.mid.x / 1000, f.zSill / 1000, -f.mid.y / 1000);
    g.rotation.y = ang;
    const fr = (f.t.frame || 50) / 1000;
    const frameMat = style === "wire" ? null : new THREE.MeshStandardMaterial({ color: sel ? 0x3b82f6 : (app.matOf?.(o) ?? o.material) ? new THREE.Color(matColor(app.matOf?.(o) ?? o.material)) : 0x6b4a2f, roughness: 0.8 });
    const box = (sx, sy, sz, x, y, z, mat) => { const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat); m.position.set(x, y, z); m.userData.id = o.id; g.add(m); return m; };
    if (frameMat) {
      box(fr, hgt, thick, -width / 2 + fr / 2, hgt / 2, 0, frameMat); box(fr, hgt, thick, width / 2 - fr / 2, hgt / 2, 0, frameMat);
      box(width, fr, thick, 0, hgt - fr / 2, 0, frameMat);
      if (!O.isDoor(o)) box(width, fr, thick, 0, fr / 2, 0, frameMat);
      if (O.isDoor(o)) {
        const leaf = new THREE.MeshStandardMaterial({ color: sel ? 0x6aa0ff : 0x8a6440, roughness: 0.7 });
        box(width - 2 * fr, hgt - fr, 0.04, 0, (hgt - fr) / 2, 0, leaf);
      } else {
        const glass = new THREE.MeshStandardMaterial({ color: 0x9ec9e6, transparent: true, opacity: 0.35, roughness: 0.05, metalness: 0.1, depthWrite: false });
        box(width - 2 * fr, hgt - 2 * fr, 0.01, 0, hgt / 2, 0, glass);
      }
    }
    // outline of the hole through the wall
    const hole = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(width, hgt, thick)), new THREE.LineBasicMaterial({ color: style === "wire" ? (sel ? 0x3b82f6 : 0xe8e8ec) : style === "hidden" ? 0x111111 : 0x1b1b20 }));
    hole.position.y = hgt / 2; g.add(hole);
    group.add(g);
  }
}

// --------------------------------------------------------------------------- properties
export function openingProps(app, ids, esc) {
  const doc = app.doc, ops = ids.map(id => doc.openings.find(o => o.id === id));
  const kind = ops.every(o => o.kind === ops[0].kind) ? ops[0].kind : null;
  const one = ops.length === 1 ? ops[0] : null;
  if (!kind) return `<div class="pnote">${ops.length} doors and windows selected.</div>`;
  const types = kind === "door" ? doc.doorTypes : doc.windowTypes;
  const typeId = ops.every(o => o.typeId === ops[0].typeId) ? ops[0].typeId : "";
  const sill = ops.every(o => o.sillHeight === ops[0].sillHeight) ? ops[0].sillHeight : "";
  const t = one ? O.openingType(doc, one) : null, w = one ? O.hostOf(doc, one) : null;
  const lv = w ? doc.levels.find(l => l.id === w.baseLevelId) : null;
  return `<div class="ptype"><div class="row"><span>${kind === "door" ? "Door" : "Window"}${one ? "" : `s (${ops.length})`}</span><button class="btn" type="button" id="pEditType"${typeId ? "" : " disabled"}>Edit Type</button></div>
    <select id="pType" aria-label="Type">${typeId ? "" : `<option value="" selected>(varies)</option>`}${types.map(x => `<option value="${esc(x.id)}"${x.id === typeId ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select></div>
    <div class="pgroup">Constraints</div>
    <div class="prow"><span>Level</span><input readonly value="${esc(lv?.name || "")}"></div>
    <div class="prow"><span>Sill Height</span><input id="pSill" type="number" step="50" value="${sill}"></div>
    ${one ? `<div class="prow"><span>Head Height</span><input id="pHead" type="number" step="50" value="${one.sillHeight + t.height}"></div>` : ""}
    <div class="pgroup">Identity Data</div>
    ${one ? `<div class="prow"><span>Type Mark</span><input readonly value="${esc(O.typeMark(doc, one))}"></div>
    <div class="prow"><span>Size</span><input readonly value="${t.width} x ${t.height}"></div>
    <div class="prow"><span>Host</span><input readonly value="Basic Wall : ${esc(wallType(doc, w).name)}"></div>` : ""}
    <div class="prow"><span></span><span><button class="btn" type="button" id="pFlipF">Flip facing</button>${kind === "door" ? ` <button class="btn" type="button" id="pFlipH">Flip hand</button>` : ""}</span></div>
    <div class="pnote">Space flips the facing too. Click a blue dimension in the plan to set the distance to the next wall.</div>`;
}

export function wireOpeningProps(app, ids, renderProps, ui) {
  const $ = s => document.querySelector(s);
  const edit = (label, fn) => app.commit(label, doc => { for (const id of ids) { const o = doc.openings.find(x => x.id === id); fn(o, doc); O.checkOpening(doc, o); } }) === undefined && renderProps();
  $("#pType").onchange = e => e.target.value && edit("Change type", o => { o.typeId = e.target.value; });
  $("#pSill").onchange = e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) edit("Sill height", o => { o.sillHeight = v; }); };
  const head = $("#pHead");
  if (head) head.onchange = e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) edit("Head height", (o, doc) => { o.sillHeight = v - O.openingType(doc, o).height; }); };
  $("#pFlipF").onclick = () => edit("Flip facing", o => { o.flipFacing = !o.flipFacing; });
  const fh = $("#pFlipH"); if (fh) fh.onclick = () => edit("Flip hand", o => { o.flipHand = !o.flipHand; });
  const et = $("#pEditType"); if (et) et.onclick = () => openingTypeDialog(app, app.doc.openings.find(o => o.id === ids[0]), ui);
}

export function openingTypeDialog(app, o, ui) {
  const doc = app.doc, kind = o.kind, list = kind === "door" ? "doorTypes" : "windowTypes", t = doc[list].find(x => x.id === o.typeId);
  const count = doc.openings.filter(x => x.typeId === t.id).length;
  const styles = kind === "door" ? [["single", "Single"], ["double", "Double"], ["sliding", "Sliding"], ["garage", "Garage"]] : [["casement", "Casement"], ["sliding", "Sliding"], ["fixed", "Fixed glass"]];
  ui.openDialog(`<h3>Type Properties</h3><p>${kind === "door" ? "Door" : "Window"} type ${ui.esc(t.name)}, used ${count} time${count === 1 ? "" : "s"}. Changes apply to every ${kind} of this type; any that would no longer fit are refused.</p>
    <table><tr><th>Parameter</th><th>Value</th></tr>
      <tr><td>Type name</td><td><input id="tName" value="${ui.esc(t.name)}" maxlength="80"></td></tr>
      <tr><td>Type Mark</td><td><input id="tMark" value="${ui.esc(O.typeMark(doc, o))}" maxlength="12"></td></tr>
      <tr><td>Width (mm)</td><td><input id="tW" type="number" min="300" max="6000" step="50" value="${t.width}"></td></tr>
      <tr><td>Height (mm)</td><td><input id="tH" type="number" min="300" max="6000" step="50" value="${t.height}"></td></tr>
      <tr><td>Frame (mm)</td><td><input id="tF" type="number" min="20" max="200" step="5" value="${t.frame || 50}"></td></tr>
      <tr><td>Style</td><td><select id="tS">${styles.map(([v, l]) => `<option value="${v}"${(t.style || styles[0][0]) === v ? " selected" : ""}>${l}</option>`).join("")}</select></td></tr>
      ${kind === "window" ? `<tr><td>Default sill (mm)</td><td><input id="tSill" type="number" min="0" step="50" value="${t.sill ?? 900}"></td></tr>` : ""}
    </table><div id="tErr"></div>
    <div class="actions"><button class="btn" type="button" id="tDup">Duplicate…</button><button class="btn" type="button" id="tCancel">Cancel</button><button class="btn primary" type="button" id="tOk">OK</button></div>`, d => {
    const read = () => ({ name: d.querySelector("#tName").value.trim(), mark: d.querySelector("#tMark").value.trim(), width: parseFloat(d.querySelector("#tW").value), height: parseFloat(d.querySelector("#tH").value), frame: parseFloat(d.querySelector("#tF").value), style: d.querySelector("#tS").value, ...(kind === "window" ? { sill: parseFloat(d.querySelector("#tSill").value) } : {}) });
    const err = m => { d.querySelector("#tErr").innerHTML = `<div class="err">${ui.esc(m)}</div>`; };
    const valid = (v, selfId) => {
      if (!v.name) return "Give the type a name.";
      if (!(v.width >= 300 && v.width <= 6000) || !(v.height >= 300 && v.height <= 6000)) return "Width and height must be between 300 and 6000 mm.";
      if (doc[list].some(x => x.id !== selfId && x.name.toLowerCase() === v.name.toLowerCase())) return "Another type already has that name.";
      return "";
    };
    d.querySelector("#tCancel").onclick = ui.closeDialog;
    d.querySelector("#tOk").onclick = () => {
      const v = read(), e = valid(v, t.id); if (e) return err(e);
      try { app.history.transact("Edit type", dd => { Object.assign(dd[list].find(x => x.id === t.id), v); for (const x of dd.openings) if (x.typeId === t.id) O.checkOpening(dd, x); }); ui.closeDialog(); }
      catch (ex) { err(ex.message); }
    };
    d.querySelector("#tDup").onclick = async () => {
      const v = read();
      const name = await ui.askText("Name for the new type", `${kind === "door" ? "D" : "W"} ${v.width}x${v.height}`);
      if (!name) return;
      const nv = { ...t, ...v, id: newId(kind === "door" ? "dt" : "wn"), name, mark: "" };
      const e = valid(nv, nv.id); if (e) return err(e);
      app.commit("Duplicate type", dd => { dd[list].push(nv); const x = dd.openings.find(q => q.id === o.id); x.typeId = nv.id; O.checkOpening(dd, x); });
      ui.closeDialog();
    };
  });
}

/** Door and window schedule: type, size, count and levels. */
export function scheduleDialog(app, ui) {
  const doc = app.doc;
  const rows = [];
  for (const kind of ["door", "window"]) {
    const types = kind === "door" ? doc.doorTypes : doc.windowTypes;
    for (const t of types) {
      const ops = doc.openings.filter(o => o.kind === kind && o.typeId === t.id);
      if (!ops.length) continue;
      const levels = [...new Set(ops.map(o => O.hostOf(doc, o)?.baseLevelId))].map(id => doc.levels.find(l => l.id === id)?.name).filter(Boolean);
      rows.push(`<tr><td>${ui.esc(O.typeMark(doc, ops[0]))}</td><td>${ui.esc(t.name)}</td><td>${t.width} x ${t.height}</td><td>${kind === "window" ? ops.map(o => o.sillHeight).filter((v, i, a) => a.indexOf(v) === i).join(", ") : "—"}</td><td>${ops.length}</td><td>${ui.esc(levels.join(", "))}</td></tr>`);
    }
  }
  ui.openDialog(`<h3>Door and Window Schedule</h3><p>From the model, so it is always up to date.</p>
    <table><tr><th>Mark</th><th>Type</th><th>Size (mm)</th><th>Sill (mm)</th><th>Count</th><th>Levels</th></tr>${rows.join("") || `<tr><td colspan="6">No doors or windows yet.</td></tr>`}</table>
    <div class="actions"><button class="btn primary" type="button" id="sOk">Close</button></div>`, d => { d.querySelector("#sOk").onclick = ui.closeDialog; });
}

/** Tags every selected opening in this view (or every untagged one if nothing is selected). */
export function tagOpenings(app) {
  const vid = `plan:${app.levelId}`, lvWalls = new Set(app.wallsOnLevel().map(w => w.id));
  const sel = [...app.selection].filter(id => app.doc.openings.some(o => o.id === id));
  const targets = (sel.length ? sel : app.doc.openings.filter(o => lvWalls.has(o.hostWallId)).map(o => o.id)).filter(id => !app.doc.tags.some(t => t.hostId === id && t.viewId === vid));
  if (!targets.length) { app.toast("Everything here is already tagged."); return; }
  app.commit("Tag", doc => { for (const id of targets) doc.tags.push({ id: newId("tg"), hostId: id, viewId: vid }); });
  app.toast(`Tagged ${targets.length}.`);
}
