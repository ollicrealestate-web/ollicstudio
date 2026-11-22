// Walls in the workspace: the Wall tool, plan drawing, 3D, Properties and the type and level dialogs.
import * as G from "./geom.js";
import { LineTool } from "./tools.js";
import { makeWall, wallFootprints, outlineEdges, wallType, wallHeights, checkWall, LOCATION_LINES, centreOffset, extSign, wallLength } from "./walls.js";
import * as LV from "./levels.js";
import { levelLabel, newId } from "./model.js";
import { COLORS } from "./plan.js";

const CUT_PLANE = 1200; // walls are shown cut 1200 mm above the level, as in a plan view

// --------------------------------------------------------------------------- Wall tool
export class WallTool extends LineTool {
  constructor(app) {
    super(app, "wall");
    this.name = "wall"; this.title = "Wall";
    const s = app.prefs.wall || {};
    this.mode = s.mode && s.mode !== "pick" ? s.mode : (s.mode || "line");
    this.typeId = app.doc.wallTypes.some(t => t.id === s.typeId) ? s.typeId : "wt-ext225";
    this.locationLine = s.locationLine || "wall-centre";
    this.topLevelId = null;
    this.topMode = s.topMode || "unconnected";
    this.height = s.height || 3000;
    this.depthMode = s.depthMode || "height";
    this.chain = s.chain ?? true;
    this.offset = s.offset || 0;
    this.useRadius = !!s.useRadius; this.radius = s.radius || 1000;
    this.flip = false;
    this.prevWallId = null;
  }
  savePrefs() {
    this.app.prefs.wall = { mode: this.mode, typeId: this.typeId, locationLine: this.locationLine, topMode: this.topMode, height: this.height, depthMode: this.depthMode, chain: this.chain, offset: this.offset, useRadius: this.useRadius, radius: this.radius, sides: this.sides, polyMode: this.polyMode };
    this.app.savePrefs();
  }
  type() { return this.app.doc.wallTypes.find(t => t.id === this.typeId) || this.app.doc.wallTypes[0]; }

  options() {
    const app = this.app, lv = LV.sorted(app.doc), here = lv.findIndex(l => l.id === app.levelId);
    const o = super.options().filter(x => x.label !== "Line style" && !String(x.text || "").startsWith("Placement"));
    const topItems = [{ value: "unconnected", label: "Unconnected" }, ...lv.slice(here + 1).map(l => ({ value: l.id, label: `Up to level: ${l.name}` }))];
    if (this.topMode !== "unconnected" && !lv.slice(here + 1).some(l => l.id === this.topMode)) this.topMode = "unconnected";
    o.splice(2, 0,
      { type: "select", label: "", value: this.depthMode, items: [{ value: "height", label: "Height" }, { value: "depth", label: "Depth" }], onChange: v => { this.depthMode = v; this.savePrefs(); } },
      { type: "select", label: "", value: this.topMode, items: topItems, onChange: v => { this.topMode = v; this.savePrefs(); app.toolChanged(); } },
      ...(this.topMode === "unconnected" ? [{ type: "number", label: "", value: this.height, step: 100, min: 100, onChange: v => { this.height = Math.max(100, v || 3000); this.savePrefs(); } }] : []),
      { type: "select", label: "Location Line", value: this.locationLine, items: Object.entries(LOCATION_LINES).map(([value, label]) => ({ value, label })), onChange: v => { this.locationLine = v; this.savePrefs(); app.redraw(); } },
    );
    if (this.mode === "line") o.push({ type: "check", label: "Radius", value: this.useRadius, onChange: v => { this.useRadius = v; this.savePrefs(); } }, { type: "number", label: "", value: this.radius, step: 100, min: 10, onChange: v => { this.radius = Math.max(10, v || 1000); this.savePrefs(); } });
    return o;
  }

  prompt() {
    const base = super.prompt().replace(/line start point/, "wall start point").replace(/Click a line to copy it as a model line\./, "Click a model line to put a wall on it.");
    return base + (this.pts.length ? " Space flips the wall's exterior side." : "");
  }

  wallInit(extra) {
    const app = this.app, lv = app.levelId;
    const top = this.topMode === "unconnected" ? null : this.topMode;
    const init = { typeId: this.typeId, locationLine: this.locationLine, baseLevelId: lv, topLevelId: top, unconnectedHeight: this.height, flipped: this.flip, ...extra };
    if (this.depthMode === "depth") { init.topLevelId = null; init.baseOffset = -this.height; }
    return makeWall(app.doc, init);
  }

  add(elements, label) {
    const app = this.app;
    const ids = app.commit(label, doc => {
      const made = [];
      for (const e of elements) {
        const w = this.wallInit(e.shape === "arc" ? { shape: "arc", c: e.c, r: e.r, start: e.start, sweep: e.sweep } : { a: e.a, b: e.b });
        checkWall(doc, w);
        doc.walls.push(w); made.push(w.id);
      }
      LV.checkLevels(doc);
      return made;
    });
    if (ids?.length) this.prevWallId = ids[ids.length - 1];
  }

  finishIfReady(typed) {
    // Radius: round the corner between the previous wall of the chain and the next one
    if (this.mode === "line" && this.useRadius && this.pts.length === 2 && this.prevWallId) {
      const prev = this.app.lookup(this.prevWallId);
      const P1 = this.pts[0], P2 = this.pts[1];
      if (prev?.shape === "line" && G.dist(prev.b, P1) < 1 && G.dist(P1, P2) > 1) {
        const u1 = G.norm(G.sub(prev.b, prev.a)), u2 = G.norm(G.sub(P2, P1));
        const turn = Math.atan2(G.cross(u1, u2), G.dot(u1, u2));
        if (Math.abs(turn) > 1e-3 && Math.abs(turn) < Math.PI - 1e-3) {
          const d = this.radius * Math.tan(Math.abs(turn) / 2);
          if (d < G.dist(prev.a, prev.b) - 10 && d < G.dist(P1, P2) - 10) {
            const T1 = G.sub(P1, G.mul(u1, d)), T2 = G.add(P1, G.mul(u2, d));
            const centre = G.add(T1, G.mul(G.perp(u1), this.radius * Math.sign(turn)));
            const mid = G.add(centre, G.mul(G.norm(G.sub(P1, centre)), this.radius));
            const arc = G.arcFrom3(T1, mid, T2);
            const app = this.app;
            const ids = app.commit("Wall", doc => {
              const pw = doc.walls.find(w => w.id === prev.id); pw.b = T1; checkWall(doc, pw);
              const aw = this.wallInit({ shape: "arc", ...arc }); checkWall(doc, aw); doc.walls.push(aw);
              const nw = this.wallInit({ a: T2, b: P2 }); checkWall(doc, nw); doc.walls.push(nw);
              return nw.id;
            });
            if (ids) this.prevWallId = ids;
            this.pts = this.chain ? [P2] : [];
            this.app.toolChanged();
            return;
          } else this.app.toast("The radius is too large for these walls; the corner is left square.");
        }
      }
    }
    if (this.pts.length === 0) this.prevWallId = null;
    super.finishIfReady(typed);
  }

  escape() { this.prevWallId = null; return super.escape(); }

  key(e) {
    if (e.key === " " && this.pts.length) { this.flip = !this.flip; this.app.redraw(); return true; }
    return false;
  }

  /** Preview: the wall band at its true thickness, on the side the location line puts it. */
  drawPreview(view) {
    const P = this.pts, cur = this.cursor;
    if (this.mode === "pick" || !cur || !P.length) return super.drawPreview(view);
    const t = this.type(), fake = { locationLine: this.locationLine, flipped: this.flip };
    const off = centreOffset(fake, t) * extSign(fake), h = t.thickness / 2;
    const band = (a, b) => {
      if (G.dist(a, b) < 1) return;
      const n = G.perp(G.norm(G.sub(b, a)));
      const c0 = G.add(a, G.mul(n, off)), c1 = G.add(b, G.mul(n, off));
      view.polygon([G.add(c0, G.mul(n, h)), G.add(c1, G.mul(n, h)), G.sub(c1, G.mul(n, h)), G.sub(c0, G.mul(n, h))], "rgba(255,74,79,.16)", COLORS.preview, 1);
      // exterior side marker
      const m = G.mid(c0, c1), ext = G.mul(n, extSign(fake));
      view.segment(G.add(m, G.mul(ext, h)), G.add(m, G.mul(ext, h + view.px(10))), COLORS.preview, 1.5);
    };
    if (this.mode === "line") { const [a, b] = this.offsetSeg(P[P.length - 1], cur); band(a, b); }
    if (this.mode === "rect") { const c = G.rectangle(P[0], cur); c.forEach((q, i) => band(q, c[(i + 1) % 4])); }
    if (this.mode === "polygon") { const c = G.regularPolygon(P[0], cur, this.sides, this.polyMode); c.forEach((q, i) => band(q, c[(i + 1) % c.length])); }
    super.drawPreview(view);
  }

  down(c) {
    if (this.mode === "pick") {
      const id = this.app.hoverCandidate();
      const src = id && this.app.lookup(id);
      if (!src || !src.kind || src.kind !== "model") { this.app.toast("Click a model line. Draw model lines first with Model Line (LI)."); return; }
      if (src.shape === "arc") this.add([{ shape: "arc", c: src.c, r: src.r, start: src.start, sweep: src.sweep }], "Wall");
      else { const [a, b] = this.offsetSeg(src.a, src.b); this.add([{ shape: "line", a, b }], "Wall"); }
      return;
    }
    super.down(c);
  }
}

// --------------------------------------------------------------------------- plan drawing
export function drawWalls(view, app) {
  const doc = app.doc;
  const lv = doc.levels.find(l => l.id === app.levelId);
  const cutZ = (lv?.elevation || 0) + CUT_PLANE;
  const fp = app.footprints(app.levelId);
  const cut = [], below = [];
  for (const w of doc.walls) {
    if (w.baseLevelId !== app.levelId) continue;
    const f = fp.get(w.id);
    if (!f) continue;
    (f.z1 >= cutZ && f.z0 <= cutZ ? cut : below).push({ w, f });
  }
  // walls below the cut plane (e.g. low walls): thin lines, no fill
  for (const { w, f } of below) for (const p of f.pieces) view.polygon(p, null, view.colorFor(w.id, "#9a9aa6"), 1);
  // cut walls: poche fill, heavy outline round the joined mass only
  for (const { w, f } of cut) for (const p of f.pieces) view.polygon(p, app.selection.has(w.id) ? "rgba(59,130,246,.35)" : app.hoverId === w.id ? "rgba(127,176,255,.2)" : "#34343c", null);
  const edges = outlineEdges(cut.flatMap(x => x.f.pieces));
  view.stroke(COLORS.line, 2);
  const ctx = view.ctx;
  ctx.beginPath();
  for (const [a, b] of edges) { const A = view.toScreen(a), B = view.toScreen(b); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); }
  ctx.stroke();
  // selected / hovered walls: blue outline and location line
  for (const { w, f } of [...cut, ...below]) {
    const col = app.selection.has(w.id) ? COLORS.sel : (app.hoverId === w.id || app.hoverSet?.has(w.id)) ? COLORS.hover : null;
    if (!col) continue;
    for (const p of f.pieces) view.polygon(p, null, col, 2);
    if (app.selection.has(w.id)) view.drawLine({ ...w, style: "centre" }, col);
  }
}

/** Grey outline of the level below (toggle in the view bar). */
export function drawUnderlay(view, app) {
  if (!app.prefs.underlay) return;
  const L = LV.sorted(app.doc), i = L.findIndex(l => l.id === app.levelId);
  if (i <= 0) return;
  const below = L[i - 1];
  const fp = app.footprints(below.id);
  const edges = outlineEdges([...fp.values()].flatMap(f => f.pieces));
  view.stroke(COLORS.underlay, 1);
  view.ctx.beginPath();
  for (const [a, b] of edges) { const A = view.toScreen(a), B = view.toScreen(b); view.ctx.moveTo(A.x, A.y); view.ctx.lineTo(B.x, B.y); }
  view.ctx.stroke();
}

// --------------------------------------------------------------------------- temporary dimensions for a selected wall
/** Parallel straight walls on the same level, nearest on each side, measured centre to centre. */
export function neighbourDims(app, w) {
  if (w.shape !== "line") return [];
  const fp = app.footprints(w.baseLevelId), me = fp.get(w.id);
  if (!me) return [];
  const [c0, c1] = [me.centre[0], me.centre.at(-1)], u = G.norm(G.sub(c1, c0)), n = G.perp(u);
  const L = G.dist(c0, c1);
  const best = { 1: null, "-1": null };
  for (const o of app.doc.walls) {
    if (o.id === w.id || o.shape !== "line" || o.baseLevelId !== w.baseLevelId) continue;
    const f = fp.get(o.id); if (!f) continue;
    const [d0, d1] = [f.centre[0], f.centre.at(-1)], v = G.norm(G.sub(d1, d0));
    if (Math.abs(G.cross(u, v)) > 1e-3) continue;
    const s0 = G.dot(G.sub(d0, c0), u), s1 = G.dot(G.sub(d1, c0), u);
    if (Math.max(s0, s1) < -1 || Math.min(s0, s1) > L + 1) continue; // must face each other
    const dist = G.dot(G.sub(d0, c0), n);
    if (Math.abs(dist) < 1) continue;
    const side = Math.sign(dist);
    if (!best[side] || Math.abs(dist) < Math.abs(best[side].dist)) {
      const s = Math.max(0, Math.min(L, (Math.max(Math.min(s0, s1), 0) + Math.min(Math.max(s0, s1), L)) / 2));
      best[side] = { other: o, dist, at: G.add(c0, G.mul(u, s)), n };
    }
  }
  return Object.values(best).filter(Boolean);
}

export function drawWallDims(view, app, w, inlineEdit) {
  const fp = app.footprints(w.baseLevelId).get(w.id);
  if (!fp) return;
  if (w.shape === "line") {
    const len = Math.round(wallLength(w));
    view.tempDim(w.a, w.b, String(len), { offsetPx: 22, onClick: box => inlineEdit(box, len, v => app.commit("Change length", doc => { app.stretchWallEnd(doc, w.id, "b", G.add(w.a, G.mul(G.norm(G.sub(w.b, w.a)), v))); })) });
  }
  for (const nd of neighbourDims(app, w)) {
    const p = nd.at, q = G.add(p, G.mul(nd.n, nd.dist));
    const cur = Math.round(Math.abs(nd.dist));
    view.tempDim(p, q, String(cur), {
      offsetPx: 0,
      onClick: box => inlineEdit(box, cur, v => app.commit("Move wall", doc => {
        const delta = G.mul(nd.n, Math.sign(nd.dist) * (cur - v));
        app.translateWithJoins(doc, [w.id], delta);
      })),
    });
  }
  // flip arrows on the exterior side
  if (w.shape === "line") {
    const c0 = fp.centre[0], c1 = fp.centre.at(-1), m = G.mid(c0, c1), n = G.mul(G.perp(G.norm(G.sub(c1, c0))), extSign(w));
    const p = G.add(m, G.mul(n, fp.h + view.px(16)));
    const s = view.toScreen(p), ctx = view.ctx;
    ctx.strokeStyle = COLORS.sel; ctx.lineWidth = 1.6; ctx.beginPath();
    const dir = view.toScreen(G.add(p, n)); const dx = dir.x - s.x, dy = dir.y - s.y, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
    ctx.moveTo(s.x - ux * 7, s.y - uy * 7); ctx.lineTo(s.x + ux * 7, s.y + uy * 7);
    for (const k of [1, -1]) { ctx.moveTo(s.x + ux * 7 * k, s.y + uy * 7 * k); ctx.lineTo(s.x + ux * 3 * k - uy * 4, s.y + uy * 3 * k + ux * 4); ctx.moveTo(s.x + ux * 7 * k, s.y + uy * 7 * k); ctx.lineTo(s.x + ux * 3 * k + uy * 4, s.y + uy * 3 * k - ux * 4); }
    ctx.stroke();
    view.hits.push({ x0: s.x - 10, y0: s.y - 10, x1: s.x + 10, y1: s.y + 10, cx: s.x, cy: s.y, onClick: () => app.commit("Flip wall", doc => { const x = doc.walls.find(q => q.id === w.id); x.flipped = !x.flipped; }) });
  }
}

// --------------------------------------------------------------------------- 3D
const STYLE_COLORS = { exterior: 0xd9d4ca, interior: 0xe8e4dc };
export function buildWalls3D(v3, THREE, app) {
  const doc = app.doc, style = app.prefs.visual || "shaded";
  const visible = app.visibleLevels3D();
  const fpAll = new Map();
  for (const l of doc.levels) for (const [id, f] of app.footprints(l.id)) fpAll.set(id, f);
  const group = new THREE.Group();
  for (const w of doc.walls) {
    if (visible && !visible.has(w.baseLevelId)) continue;
    const f = fpAll.get(w.id); if (!f) continue;
    const sel = app.selection.has(w.id);
    const colour = sel ? 0x3b82f6 : new THREE.Color(f.type.color || STYLE_COLORS[f.type.function] || 0xdddddd).getHex();
    for (const piece of f.pieces) {
      const shape = new THREE.Shape(piece.map(p => new THREE.Vector2(p.x / 1000, p.y / 1000)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: (f.z1 - f.z0) / 1000, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2); geo.translate(0, f.z0 / 1000, 0);
      if (style !== "wire") {
        const mat = style === "hidden" ? new THREE.MeshBasicMaterial({ color: sel ? 0x9cc0ff : 0xf2f2f2, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
          : style === "consistent" ? new THREE.MeshBasicMaterial({ color: colour, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
          : new THREE.MeshStandardMaterial({ color: colour, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.userData.id = w.id;
        mesh.castShadow = mesh.receiveShadow = style === "realistic";
        group.add(mesh);
      }
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color: style === "hidden" ? 0x111111 : style === "wire" ? (sel ? 0x3b82f6 : 0xe8e8ec) : 0x1b1b20 }));
      edges.userData.id = w.id;
      group.add(edges);
    }
  }
  v3.root.add(group);
  v3.setShadows?.(style === "realistic");
}

// --------------------------------------------------------------------------- properties
export function wallProps(app, ids, esc) {
  const doc = app.doc, walls = ids.map(id => doc.walls.find(w => w.id === id));
  const one = walls.length === 1 ? walls[0] : null;
  const same = k => walls.every(w => w[k] === walls[0][k]) ? walls[0][k] : undefined;
  const lv = LV.sorted(doc);
  const typeId = same("typeId");
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
  const varies = `<option value="" selected>(varies)</option>`;
  const h = one ? wallHeights(doc, one) : null;
  const topId = same("topLevelId");
  return `<div class="ptype"><div class="row"><span>${one ? "Basic Wall" : `Walls (${walls.length})`}</span><button class="btn" type="button" id="pEditType"${typeId ? "" : " disabled"}>Edit Type</button></div>
    <select id="pType" aria-label="Wall type">${typeId ? "" : varies}${doc.wallTypes.map(t => opt(t.id, t.name, typeId)).join("")}</select></div>
    <div class="pgroup">Constraints</div>
    <div class="prow"><span>Location Line</span><select id="pLoc">${same("locationLine") ? "" : varies}${Object.entries(LOCATION_LINES).map(([k, v]) => opt(k, v, same("locationLine"))).join("")}</select></div>
    <div class="prow"><span>Base Constraint</span><select id="pBase">${same("baseLevelId") ? "" : varies}${lv.map(l => opt(l.id, l.name, same("baseLevelId"))).join("")}</select></div>
    <div class="prow"><span>Base Offset</span><input id="pBaseOff" type="number" step="10" value="${same("baseOffset") ?? ""}"></div>
    <div class="prow"><span>Top Constraint</span><select id="pTop">${topId === undefined ? varies : ""}${opt("", "Unconnected", topId === null ? "" : topId)}${lv.map(l => opt(l.id, `Up to level: ${l.name}`, topId)).join("")}</select></div>
    <div class="prow"><span>Unconnected Height</span><input id="pUH" type="number" step="10" value="${same("unconnectedHeight") ?? ""}"${topId ? " disabled" : ""}></div>
    <div class="prow"><span>Top Offset</span><input id="pTopOff" type="number" step="10" value="${same("topOffset") ?? ""}"${topId === null ? " disabled" : ""}></div>
    <div class="prow"><span>Room Bounding</span><input id="pRB" type="checkbox"${walls.every(w => w.roomBounding) ? " checked" : ""}></div>
    <div class="pgroup">Structural</div>
    <div class="prow"><span>Structural</span><input id="pStruct" type="checkbox"${walls.every(w => w.structural) ? " checked" : ""}></div>
    <div class="pgroup">Dimensions</div>
    ${one ? `<div class="prow"><span>Length</span><input id="pLen" type="number" step="1" value="${Math.round(wallLength(one))}"${one.shape === "arc" ? " readonly" : ""}></div>
    <div class="prow"><span>Height</span><input readonly value="${Math.round(h.z1 - h.z0)}"></div>
    <div class="prow"><span>Thickness</span><input readonly value="${wallType(doc, one).thickness}"></div>` : ""}
    <div class="pnote">${one ? `Base ${levelLabel(h.z0)}, top ${levelLabel(h.z1)}. ` : ""}Space or the blue arrows flip the exterior side.</div>
    <div class="prow"><span></span><button class="btn" type="button" id="pFlip">Flip</button></div>`;
}

export function wireWallProps(app, ids, renderProps, inlineEditType) {
  const $ = s => document.querySelector(s);
  const edit = (label, fn) => app.commit(label, doc => {
    for (const id of ids) { const w = doc.walls.find(x => x.id === id); fn(w, doc); checkWall(doc, w); }
    LV.checkLevels(doc);
  }) === undefined && renderProps();
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  $("#pType").onchange = e => e.target.value && edit("Wall type", w => { w.typeId = e.target.value; });
  $("#pLoc").onchange = e => e.target.value && edit("Location line", w => { w.locationLine = e.target.value; });
  $("#pBase").onchange = e => e.target.value && edit("Base constraint", w => { w.baseLevelId = e.target.value; });
  $("#pBaseOff").onchange = e => { const v = num(e.target.value); if (v !== null) edit("Base offset", w => { w.baseOffset = v; }); };
  $("#pTop").onchange = e => edit("Top constraint", (w, doc) => {
    const { z0, z1 } = wallHeights(doc, w);
    if (e.target.value) { w.topLevelId = e.target.value; w.topOffset = 0; } else { w.topLevelId = null; w.unconnectedHeight = z1 - z0; }
  });
  $("#pUH").onchange = e => { const v = num(e.target.value); if (v !== null) edit("Unconnected height", w => { w.unconnectedHeight = v; }); };
  $("#pTopOff").onchange = e => { const v = num(e.target.value); if (v !== null) edit("Top offset", w => { w.topOffset = v; }); };
  $("#pRB").onchange = e => edit("Room bounding", w => { w.roomBounding = e.target.checked; });
  $("#pStruct").onchange = e => edit("Structural", w => { w.structural = e.target.checked; });
  $("#pFlip").onclick = () => edit("Flip wall", w => { w.flipped = !w.flipped; });
  const len = $("#pLen");
  if (len && !len.readOnly) len.onchange = () => { const v = num(len.value); if (v > 10) app.commit("Change length", doc => { const w = doc.walls.find(x => x.id === ids[0]); app.stretchWallEnd(doc, w.id, "b", G.add(w.a, G.mul(G.norm(G.sub(w.b, w.a)), v))); checkWall(doc, w); }); else renderProps(); };
  const et = $("#pEditType");
  if (et) et.onclick = () => inlineEditType(app.doc.walls.find(w => w.id === ids[0]).typeId);
}

// --------------------------------------------------------------------------- dialogs
export function wallTypeDialog(app, typeId, ui) {
  const doc = app.doc, t = doc.wallTypes.find(x => x.id === typeId);
  if (!t) return;
  const count = doc.walls.filter(w => w.typeId === t.id).length;
  ui.openDialog(`<h3>Type Properties</h3><p>Family: Basic Wall · Type: ${ui.esc(t.name)} · used by ${count} wall${count === 1 ? "" : "s"}. Changes apply to every wall of this type; each stays on its location line.</p>
    <table>
      <tr><th>Parameter</th><th>Value</th></tr>
      <tr><td>Type name</td><td><input id="tName" value="${ui.esc(t.name)}" maxlength="80"></td></tr>
      <tr><td>Thickness (mm)</td><td><input id="tThick" type="number" min="20" max="1500" step="5" value="${t.thickness}"></td></tr>
      <tr><td>Core thickness (mm)</td><td><input id="tCore" type="number" min="20" max="1500" step="5" value="${t.core ?? t.thickness}"></td></tr>
      <tr><td>Function</td><td><select id="tFunc"><option value="exterior"${t.function === "exterior" ? " selected" : ""}>Exterior</option><option value="interior"${t.function !== "exterior" ? " selected" : ""}>Interior</option></select></td></tr>
      <tr><td>Colour in 3D</td><td><input id="tColor" type="color" value="${t.color || "#dddddd"}"></td></tr>
    </table>
    <div id="tErr"></div>
    <div class="actions"><button class="btn" type="button" id="tDup">Duplicate…</button><button class="btn" type="button" id="tCancel">Cancel</button><button class="btn primary" type="button" id="tOk">OK</button></div>`, d => {
    const read = () => ({ name: d.querySelector("#tName").value.trim(), thickness: parseFloat(d.querySelector("#tThick").value), core: parseFloat(d.querySelector("#tCore").value), function: d.querySelector("#tFunc").value, color: d.querySelector("#tColor").value });
    const valid = v => {
      if (!v.name) return "Give the type a name.";
      if (!(v.thickness >= 20 && v.thickness <= 1500)) return "Thickness must be between 20 and 1500 mm.";
      if (!(v.core >= 20 && v.core <= v.thickness)) return "The core must be at least 20 mm and no thicker than the wall.";
      if (doc.wallTypes.some(x => x.id !== t.id && x.name.toLowerCase() === v.name.toLowerCase())) return "Another wall type already has that name.";
      return "";
    };
    d.querySelector("#tCancel").onclick = ui.closeDialog;
    d.querySelector("#tOk").onclick = () => {
      const v = read(), err = valid(v);
      if (err) { d.querySelector("#tErr").innerHTML = `<div class="err">${ui.esc(err)}</div>`; return; }
      app.commit("Edit wall type", dd => { Object.assign(dd.wallTypes.find(x => x.id === t.id), v); });
      ui.closeDialog();
    };
    d.querySelector("#tDup").onclick = async () => {
      const v = read();
      const name = await ui.askText("Name for the new type", `${v.name || t.name} 2`);
      if (!name) return;
      if (doc.wallTypes.some(x => x.name.toLowerCase() === name.trim().toLowerCase())) { d.querySelector("#tErr").innerHTML = `<div class="err">Another wall type already has that name.</div>`; return; }
      const nt = { ...t, ...v, id: newId("wt"), name: name.trim() };
      app.commit("Duplicate wall type", dd => { dd.wallTypes.push(nt); });
      ui.closeDialog();
      wallTypeDialog(app, nt.id, ui);
    };
  });
}

export function levelsDialog(app, ui) {
  const doc = app.doc;
  const render = (err = "") => {
    const L = LV.sorted(doc);
    ui.openDialog(`<h3>Levels</h3><p>Up to 10 levels; nothing may rise above 40 m. Changing a floor-to-floor height moves every level above it. Each level gets its own floor plan.</p>
      <table><tr><th>Name</th><th>Elevation (m)</th><th>Height to next (mm)</th><th></th></tr>
      ${[...L].reverse().map(l => { const ha = LV.heightAbove(doc, l.id); return `<tr data-id="${l.id}"><td><input data-f="name" value="${ui.esc(l.name)}" maxlength="60"></td>
        <td><input data-f="elev" type="number" step="0.05" value="${(l.elevation / 1000).toFixed(3)}"></td>
        <td>${ha === null ? `<span class="muted">top level</span>` : `<input data-f="height" type="number" step="50" min="1000" value="${ha}">`}</td>
        <td><button class="btn" type="button" data-del="${l.id}"${L.length <= 1 ? " disabled" : ""}>Delete</button></td></tr>`; }).join("")}
      </table>
      ${err ? `<div class="err">${ui.esc(err)}</div>` : ""}
      <div class="actions"><label>Height of new level <input id="lvNewH" type="number" step="50" min="1000" value="${app.prefs.storey || 3000}" style="width:100px"> mm</label>
      <button class="btn" type="button" id="lvAdd"${L.length >= 10 ? " disabled" : ""}>Add level above</button><button class="btn primary" type="button" id="lvOk">Done</button></div>`, d => {
      // edits update the table in place, so a click on another button right after typing is not lost
      const refresh = () => {
        for (const tr of d.querySelectorAll("tr[data-id]")) {
          const l = doc.levels.find(x => x.id === tr.dataset.id); if (!l) continue;
          tr.querySelector('[data-f="name"]').value = l.name;
          tr.querySelector('[data-f="elev"]').value = (l.elevation / 1000).toFixed(3);
          const hh = tr.querySelector('[data-f="height"]'); if (hh) hh.value = LV.heightAbove(doc, l.id);
        }
        const e = d.querySelector(".err"); if (e) e.remove();
      };
      const commit = (label, fn, structural = false) => {
        try { app.history.transact(label, fn); structural ? render() : refresh(); }
        catch (e) { render(e.message); }
      };
      d.querySelectorAll("tr[data-id]").forEach(tr => {
        const id = tr.dataset.id;
        tr.querySelector('[data-f="name"]').onchange = e => commit("Rename level", dd => LV.rename(dd, id, e.target.value));
        tr.querySelector('[data-f="elev"]').onchange = e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) commit("Level elevation", dd => LV.setElevation(dd, id, Math.round(v * 1000))); };
        const hh = tr.querySelector('[data-f="height"]');
        if (hh) hh.onchange = e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) commit("Floor-to-floor height", dd => LV.setHeightAbove(dd, id, v)); };
      });
      d.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
        const id = b.dataset.del, on = LV.elementsOn(doc, id), lvName = doc.levels.find(l => l.id === id).name;
        const parts = [on.walls && `${on.walls} wall${on.walls > 1 ? "s" : ""}`, on.lines && `${on.lines} line${on.lines > 1 ? "s" : ""}`, on.floors && `${on.floors} floor${on.floors > 1 ? "s" : ""}`].filter(Boolean);
        const msg = parts.length ? `Delete ${lvName}? This also deletes ${parts.join(", ")} on it${on.topped ? `, and ${on.topped} wall${on.topped > 1 ? "s" : ""} that rise to it become unconnected at their current height` : ""}. Undo brings it all back.` : `Delete ${lvName}?`;
        if (!(await ui.ask(msg, "Delete level"))) return;
        commit("Delete level", dd => LV.deleteLevel(dd, id), true);
        if (app.levelId === id) app.setLevel(LV.sorted(app.doc)[0].id);
      });
      d.querySelector("#lvAdd").onclick = () => {
        const v = parseFloat(d.querySelector("#lvNewH").value) || 3000;
        app.prefs.storey = v; app.savePrefs();
        commit("Add level", dd => LV.addLevelAbove(dd, v), true);
      };
      d.querySelector("#lvOk").onclick = ui.closeDialog;
    });
  };
  render();
}

/** Copies the selected walls and lines to other levels at the same plan position (Paste Aligned). */
export function copyToLevelsDialog(app, ui) {
  const doc = app.doc, ids = [...app.selection].filter(id => doc.walls.some(w => w.id === id) || doc.lines.some(l => l.id === id && l.kind === "model"));
  if (!ids.length) { app.toast("Select walls or model lines first."); return; }
  const L = LV.sorted(doc).filter(l => l.id !== app.levelId);
  if (!L.length) { app.toast("Add another level first: Manage > Levels (LL)."); return; }
  ui.openDialog(`<h3>Copy to Levels</h3><p>Copies the ${ids.length} selected element${ids.length > 1 ? "s" : ""} to the levels you tick, in the same place on plan. Walls keep their height; a wall that ran up to the next level runs up to the next level above its new one.</p>
    ${L.map(l => `<label class="chk"><input type="checkbox" data-lv="${l.id}"> ${ui.esc(l.name)} ${levelLabel(l.elevation)}</label>`).join("")}
    <div id="cErr"></div>
    <div class="actions"><button class="btn" type="button" id="cCancel">Cancel</button><button class="btn primary" type="button" id="cOk">Copy</button></div>`, d => {
    d.querySelector("#cCancel").onclick = ui.closeDialog;
    d.querySelector("#cOk").onclick = () => {
      const targets = [...d.querySelectorAll("[data-lv]")].filter(c => c.checked).map(c => c.dataset.lv);
      if (!targets.length) { d.querySelector("#cErr").innerHTML = `<div class="err">Tick at least one level.</div>`; return; }
      try {
        app.history.transact("Copy to levels", dd => {
          const S = LV.sorted(dd), idx = id => S.findIndex(l => l.id === id);
          for (const lid of targets) for (const id of ids) {
            const w = dd.walls.find(x => x.id === id);
            if (w) {
              const c = JSON.parse(JSON.stringify(w)); c.id = newId("wl"); c.baseLevelId = lid;
              if (w.topLevelId) {
                const step = idx(w.topLevelId) - idx(w.baseLevelId), t = S[idx(lid) + step];
                if (t) c.topLevelId = t.id; else { const { z0, z1 } = wallHeights(dd, w); c.topLevelId = null; c.unconnectedHeight = z1 - z0; }
              }
              checkWall(dd, c); dd.walls.push(c); continue;
            }
            const l = dd.lines.find(x => x.id === id);
            if (l) { const c = JSON.parse(JSON.stringify(l)); c.id = newId("ml"); c.levelId = lid; dd.lines.push(c); }
          }
          LV.checkLevels(dd);
        });
        ui.closeDialog();
        app.toast(`Copied to ${targets.length} level${targets.length > 1 ? "s" : ""}.`);
      } catch (e) { d.querySelector("#cErr").innerHTML = `<div class="err">${ui.esc(e.message)}</div>`; }
    };
  });
}
