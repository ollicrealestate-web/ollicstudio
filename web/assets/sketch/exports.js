// Exports: plan sheets (PNG and PDF at true scale), DXF of a plan, GLB of the 3D model.
// Everything is written here in plain JavaScript; no outside library is loaded.
import * as G from "./geom.js";
import { PlanView } from "./plan.js";
import { levelLabel } from "./model.js";

// --------------------------------------------------------------------------- paper
export const PAPER = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] }; // landscape, mm
const MARGIN = 12, TITLE_H = 22;

/** Smallest landscape sheet that holds the box (model mm) at 1:scale with margins and a title strip. */
export function choosePaper(box, scale) {
  const w = (box.x1 - box.x0) / scale, h = (box.y1 - box.y0) / scale;
  for (const [name, [pw, ph]] of Object.entries(PAPER)) if (w <= pw - 2 * MARGIN && h <= ph - 2 * MARGIN - TITLE_H) return { name, w: pw, h: ph };
  throw new Error(`At 1:${scale} this plan (${(w / 10).toFixed(0)} x ${(h / 10).toFixed(0)} cm on paper) is bigger than A0. Choose a smaller scale, like 1:${scale === 50 ? 100 : 200}.`);
}

/** Draws the plan of one level, as it is drawn on screen but without grid, selection or tools, onto a 2D context. */
function drawPlanOn(app, levelId, ctx, { w, h, s, cx, cy, dpr }) {
  const view = Object.create(PlanView.prototype);
  Object.assign(view, { canvas: ctx.canvas, ctx, app, cx, cy, s, dpr, w, h, hits: [], print: true });
  const keep = { level: app.levelId, sel: app.selection, hover: app.hoverId, hoverSet: app.hoverSet, tool: app.tool, snap: app.snap, rubber: app.rubber, sketch: app.sketch };
  try {
    app.levelId = levelId; app.selection = new Set(); app.hoverId = null; app.hoverSet = null; app.snap = null; app.rubber = null; app.sketch = null;
    app.tool = { name: "print" };
    view.draw();
  } finally {
    app.levelId = keep.level; app.selection = keep.sel; app.hoverId = keep.hover; app.hoverSet = keep.hoverSet; app.tool = keep.tool; app.snap = keep.snap; app.rubber = keep.rubber; app.sketch = keep.sketch;
  }
  return view;
}

/** The model box of a level's plan (what is drawn), with a little room for tags and text. */
export function planBox(app, levelId) {
  const keep = app.levelId;
  try { app.levelId = levelId; const b = app.plan.contentBox(); return b && isFinite(b.x0) ? { x0: b.x0 - 600, y0: b.y0 - 600, x1: b.x1 + 600, y1: b.y1 + 600 } : null; }
  finally { app.levelId = keep; }
}

/** A plan sheet at true scale: white paper, black lines, title strip and scale bar. Returns a canvas. */
export function planSheet(app, levelId, scale, dpi = 150) {
  const box = planBox(app, levelId);
  if (!box) throw new Error("This level's plan is empty. Draw something first.");
  const paper = choosePaper(box, scale);
  const cssPerMm = 96 / 25.4, dpr = dpi / 96;
  const W = paper.w * cssPerMm, H = paper.h * cssPerMm;
  const sheet = document.createElement("canvas");
  sheet.width = Math.round(W * dpr); sheet.height = Math.round(H * dpr);
  // draw the plan dark (as on screen) then lay it on white paper inverted, so lines print black and colours keep their hue
  const drawH = H - TITLE_H * cssPerMm;
  const plan = document.createElement("canvas"); plan.width = sheet.width; plan.height = Math.round(drawH * dpr);
  const s = cssPerMm / scale; // CSS px per model mm
  drawPlanOn(app, levelId, plan.getContext("2d"), { w: W, h: drawH, s, cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, dpr });
  const ctx = sheet.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.filter = "invert(1) hue-rotate(180deg)"; ctx.drawImage(plan, 0, 0); ctx.filter = "none";
  // border and title strip
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const m = MARGIN * cssPerMm / 2;
  ctx.strokeStyle = "#111"; ctx.lineWidth = 1.2; ctx.strokeRect(m, m, W - 2 * m, H - 2 * m);
  const ty = H - TITLE_H * cssPerMm;
  ctx.beginPath(); ctx.moveTo(m, ty); ctx.lineTo(W - m, ty); ctx.stroke();
  const lv = app.doc.levels.find(l => l.id === levelId);
  ctx.fillStyle = "#111"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  ctx.font = "600 15px Archivo, system-ui, sans-serif"; ctx.fillText(app.doc.name || "Untitled sketch", m + 14, ty + 22);
  ctx.font = "12px Archivo, system-ui, sans-serif";
  ctx.fillText(`Floor Plan: ${lv?.name || ""}  ${levelLabel(lv?.elevation || 0)}    Scale 1:${scale} on ${paper.name}    ${new Date().toISOString().slice(0, 10)}    Ollic Sketch`, m + 14, ty + 46);
  // scale bar: 0 to 5 m (1:50 and 1:100) or 10 m (1:200)
  const len = scale >= 200 ? 10000 : 5000, step = len / 5, bx = W - m - 14 - len * s, by = ty + 30;
  for (let i = 0; i < 5; i++) { ctx.fillStyle = i % 2 ? "#fff" : "#111"; ctx.fillRect(bx + i * step * s, by, step * s, 6); }
  ctx.strokeRect(bx, by, len * s, 6);
  ctx.fillStyle = "#111"; ctx.textAlign = "center"; ctx.font = "10px Archivo, system-ui, sans-serif";
  ctx.fillText("0", bx, by - 8); ctx.fillText(`${len / 1000} m`, bx + len * s, by - 8);
  // north arrow
  const nx = W - m - 22, ny = m + 34;
  ctx.beginPath(); ctx.moveTo(nx, ny - 18); ctx.lineTo(nx + 8, ny + 10); ctx.lineTo(nx, ny + 4); ctx.lineTo(nx - 8, ny + 10); ctx.closePath(); ctx.fillStyle = "#111"; ctx.fill();
  ctx.font = "600 12px Archivo, system-ui, sans-serif"; ctx.fillText("N", nx, ny - 28);
  return { canvas: sheet, paper, scale, dpi, pxPerMm: (s * dpr) };
}

// --------------------------------------------------------------------------- PDF (one page, one JPEG image)
export async function pdfFromCanvas(canvas, paperWmm, paperHmm) {
  const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", 0.92));
  const jpg = new Uint8Array(await blob.arrayBuffer());
  const wPt = (paperWmm * 72) / 25.4, hPt = (paperHmm * 72) / 25.4;
  const enc = new TextEncoder(), parts = [], offsets = [];
  let len = 0;
  const push = x => { const b = typeof x === "string" ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push("\nendobj\n"); };
  push("%PDF-1.4\n%\xC7\xEC\x8F\xA2\n");
  const content = `q ${wPt.toFixed(2)} 0 0 ${hPt.toFixed(2)} 0 0 cm /Im0 Do Q`;
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
  obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  obj(4, () => { push(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`); push(jpg); push("\nendstream"); });
  obj(5, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  const xref = len;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map(n => `${String(offsets[n]).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}

// --------------------------------------------------------------------------- DXF (records the plan as it is drawn)
/** A stand-in 2D context that records strokes and text in model mm, with transforms. */
class Recorder {
  constructor(view) { this.view = view; this.m = [1, 0, 0, 1, 0, 0]; this.stack = []; this.path = []; this.cur = null; this.out = { lines: [], arcs: [], texts: [] }; this.strokeStyle = "#fff"; this.fillStyle = "#fff"; this.font = "12px sans-serif"; this.lineWidth = 1; this.canvas = { width: 1, height: 1 }; }
  // transforms
  tp(x, y) { const [a, b, c, d, e, f] = this.m; return { x: a * x + c * y + e, y: b * x + d * y + f }; }
  mm(x, y) { const p = this.tp(x, y); return this.view.toModel(p.x, p.y); }
  setTransform(a, b, c, d, e, f) { this.m = [a, b, c, d, e, f]; }
  save() { this.stack.push([...this.m]); }
  restore() { this.m = this.stack.pop() || [1, 0, 0, 1, 0, 0]; }
  translate(x, y) { const [a, b, c, d, e, f] = this.m; this.m = [a, b, c, d, a * x + c * y + e, b * x + d * y + f]; }
  rotate(t) { const [a, b, c, d, e, f] = this.m, cs = Math.cos(t), sn = Math.sin(t); this.m = [a * cs + c * sn, b * cs + d * sn, c * cs - a * sn, d * cs - b * sn, e, f]; }
  scale(sx, sy) { const [a, b, c, d, e, f] = this.m; this.m = [a * sx, b * sx, c * sy, d * sy, e, f]; }
  // paths
  beginPath() { this.path = []; this.cur = null; this.start = null; }
  moveTo(x, y) { this.cur = this.mm(x, y); this.start = this.cur; }
  lineTo(x, y) { const p = this.mm(x, y); if (this.cur) this.path.push({ t: "l", a: this.cur, b: p }); else this.start = p; this.cur = p; }
  closePath() { if (this.cur && this.start && G.dist(this.cur, this.start) > 1e-6) this.path.push({ t: "l", a: this.cur, b: this.start }); this.cur = this.start; }
  rect(x, y, w, h) { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath(); }
  arc(x, y, r, a0, a1, ccw = false) {
    const c = this.mm(x, y), R = r * Math.hypot(this.m[0], this.m[1]) / this.view.s, rot = Math.atan2(this.m[1], this.m[0]);
    // screen angles (y down) to model angles (y up): negate; direction reverses
    let s0 = -(a0 + rot), s1 = -(a1 + rot);
    let sweep = ccw ? s1 - s0 : s1 - s0;
    if (!ccw) { while (sweep > 0) sweep -= G.TAU; if (Math.abs(a1 - a0) >= G.TAU - 1e-9) sweep = -G.TAU; } else { while (sweep < 0) sweep += G.TAU; if (Math.abs(a1 - a0) >= G.TAU - 1e-9) sweep = G.TAU; }
    this.path.push({ t: "a", c, r: R, start: s0, sweep });
    this.cur = G.add(c, { x: R * Math.cos(s0 + sweep), y: R * Math.sin(s0 + sweep) });
  }
  ellipse(x, y, rx, ry, rot, a0, a1) { const n = 24; for (let k = 0; k <= n; k++) { const t = a0 + ((a1 - a0) * k) / n, px = x + rx * Math.cos(t), py = y + ry * Math.sin(t); k ? this.lineTo(px, py) : this.moveTo(px, py); } }
  stroke() { const col = this.strokeStyle; for (const s of this.path) (s.t === "l" ? this.out.lines : this.out.arcs).push({ ...s, col }); }
  fill() {}
  fillRect() {}
  strokeRect(x, y, w, h) { this.beginPath(); this.rect(x, y, w, h); this.stroke(); }
  clearRect() {}
  setLineDash() {}
  measureText(t) { return { width: String(t).length * (parseFloat(this.font) || 12) * 0.55 }; }
  fillText(text, x, y) {
    const size = (parseFloat(String(this.font).match(/([\d.]+)px/)?.[1]) || 12) * Math.hypot(this.m[0], this.m[1]) / this.view.s;
    this.out.texts.push({ p: this.mm(x, y), text: String(text), h: size * 0.7, ang: -Math.atan2(this.m[1], this.m[0]), align: this.textAlign || "left", col: this.fillStyle });
  }
}

const ACI = col => { // nearest AutoCAD colour for a CSS colour
  const m = String(col).match(/^#([0-9a-f]{6})/i); if (!m) return 7;
  const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const table = [[1, 255, 0, 0], [2, 255, 255, 0], [3, 0, 255, 0], [4, 0, 255, 255], [5, 0, 0, 255], [6, 255, 0, 255], [7, 255, 255, 255], [8, 128, 128, 128], [9, 192, 192, 192]];
  if (Math.max(r, g, b) - Math.min(r, g, b) < 40) return r > 170 ? 7 : r > 110 ? 9 : 8;
  return table.reduce((best, t) => { const d = (t[1] - r) ** 2 + (t[2] - g) ** 2 + (t[3] - b) ** 2; return d < best.d ? { d, i: t[0] } : best; }, { d: Infinity, i: 7 }).i;
};

/** DXF (AutoCAD R12 text) of a level's plan: everything drawn on the plan, in millimetres. */
export function planDxf(app, levelId) {
  const box = planBox(app, levelId);
  if (!box) throw new Error("This level's plan is empty. Draw something first.");
  const view = Object.create(PlanView.prototype);
  const s = 0.05, w = (box.x1 - box.x0) * s, h = (box.y1 - box.y0) * s;
  Object.assign(view, { app, cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, s, w, h, dpr: 1, hits: [], print: true });
  const rec = new Recorder(view);
  view.ctx = rec; view.canvas = rec.canvas;
  const keep = { level: app.levelId, sel: app.selection, hover: app.hoverId, hoverSet: app.hoverSet, tool: app.tool, snap: app.snap, rubber: app.rubber, sketch: app.sketch };
  try { app.levelId = levelId; app.selection = new Set(); app.hoverId = null; app.hoverSet = null; app.snap = null; app.rubber = null; app.sketch = null; app.tool = { name: "print" }; view.draw(); }
  finally { app.levelId = keep.level; app.selection = keep.sel; app.hoverId = keep.hover; app.hoverSet = keep.hoverSet; app.tool = keep.tool; app.snap = keep.snap; app.rubber = keep.rubber; app.sketch = keep.sketch; }
  const { lines, arcs, texts } = rec.out;
  const f = v => (Math.round(v * 1000) / 1000).toString();
  const out = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "9", "$INSUNITS", "70", "4", "9", "$EXTMIN", "10", f(box.x0), "20", f(box.y0), "9", "$EXTMAX", "10", f(box.x1), "20", f(box.y1), "0", "ENDSEC",
    "0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", "2",
    "0", "LAYER", "2", "PLAN", "70", "0", "62", "7", "6", "CONTINUOUS", "0", "LAYER", "2", "TEXT", "70", "0", "62", "7", "6", "CONTINUOUS",
    "0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"];
  const seen = new Set();
  for (const l of lines) {
    if (G.dist(l.a, l.b) < 0.5) continue;
    const k = [l.a.x, l.a.y, l.b.x, l.b.y].map(v => Math.round(v)).join(","), k2 = [l.b.x, l.b.y, l.a.x, l.a.y].map(v => Math.round(v)).join(",");
    if (seen.has(k) || seen.has(k2)) continue; seen.add(k);
    out.push("0", "LINE", "8", "PLAN", "62", String(ACI(l.col)), "10", f(l.a.x), "20", f(l.a.y), "30", "0", "11", f(l.b.x), "21", f(l.b.y), "31", "0");
  }
  for (const a of arcs) {
    if (a.r < 0.5) continue;
    if (Math.abs(Math.abs(a.sweep) - G.TAU) < 1e-6) { out.push("0", "CIRCLE", "8", "PLAN", "62", String(ACI(a.col)), "10", f(a.c.x), "20", f(a.c.y), "30", "0", "40", f(a.r)); continue; }
    let s0 = a.sweep >= 0 ? a.start : a.start + a.sweep, s1 = s0 + Math.abs(a.sweep);
    const deg = t => (((t * 180) / Math.PI) % 360 + 360) % 360;
    out.push("0", "ARC", "8", "PLAN", "62", String(ACI(a.col)), "10", f(a.c.x), "20", f(a.c.y), "30", "0", "40", f(a.r), "50", f(deg(s0)), "51", f(deg(s1)));
  }
  for (const t of texts) {
    const al = t.align === "center" ? "1" : t.align === "right" ? "2" : "0";
    const ang = ((t.ang * 180) / Math.PI);
    out.push("0", "TEXT", "8", "TEXT", "62", String(ACI(t.col)), "10", f(t.p.x), "20", f(t.p.y), "30", "0", "40", f(t.h), "1", t.text.replace(/[\r\n]+/g, " "), "50", f(ang), "72", al, "73", "2", "11", f(t.p.x), "21", f(t.p.y), "31", "0");
  }
  out.push("0", "ENDSEC", "0", "EOF");
  return { text: out.join("\r\n") + "\r\n", counts: { lines: seen.size, arcs: arcs.length, texts: texts.length } };
}

// --------------------------------------------------------------------------- GLB (binary glTF 2.0) of the 3D model
/** Writes every solid in the 3D view (y up, metres) as one glTF mesh per object, coloured by its material. */
export function modelGlb(root, THREE) {
  root.updateMatrixWorld(true);
  const nodes = [], meshes = [], materials = [], accessors = [], views = [], chunks = [];
  const matIndex = new Map();
  let byteLen = 0;
  const addView = (arr, target) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), pad = (4 - (bytes.length % 4)) % 4;
    views.push({ buffer: 0, byteOffset: byteLen, byteLength: bytes.length, target });
    chunks.push(bytes); if (pad) chunks.push(new Uint8Array(pad));
    byteLen += bytes.length + pad; return views.length - 1;
  };
  root.traverse(o => {
    if (!o.isMesh || !o.geometry?.attributes?.position || o.visible === false) return;
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    const pos = g.attributes.position.array instanceof Float32Array ? g.attributes.position.array : new Float32Array(g.attributes.position.array);
    if (!pos.length) return;
    g.computeVertexNormals();
    const nor = new Float32Array(g.attributes.normal.array);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
    const pv = addView(new Float32Array(pos), 34962), nv = addView(nor, 34962);
    accessors.push({ bufferView: pv, componentType: 5126, count: pos.length / 3, type: "VEC3", min, max });
    accessors.push({ bufferView: nv, componentType: 5126, count: nor.length / 3, type: "VEC3" });
    const m = [].concat(o.material)[0], col = m?.color ? [m.color.r, m.color.g, m.color.b] : [0.8, 0.8, 0.8], op = m?.transparent ? m.opacity : 1;
    const key = col.map(v => v.toFixed(3)).join(",") + op;
    if (!matIndex.has(key)) { matIndex.set(key, materials.length); materials.push({ pbrMetallicRoughness: { baseColorFactor: [...col, op], metallicFactor: 0, roughnessFactor: 0.85 }, doubleSided: true, ...(op < 1 ? { alphaMode: "BLEND" } : {}) }); }
    meshes.push({ primitives: [{ attributes: { POSITION: accessors.length - 2, NORMAL: accessors.length - 1 }, material: matIndex.get(key) }] });
    nodes.push({ mesh: meshes.length - 1, name: String(o.userData.id || `object${nodes.length}`) });
    g.dispose();
  });
  if (!nodes.length) throw new Error("There is nothing in 3D to export yet.");
  const json = { asset: { version: "2.0", generator: "Ollic Sketch" }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, materials, accessors, bufferViews: views, buffers: [{ byteLength: byteLen }] };
  const enc = new TextEncoder(); let js = enc.encode(JSON.stringify(json));
  const jpad = (4 - (js.length % 4)) % 4; if (jpad) { const t = new Uint8Array(js.length + jpad); t.set(js); t.fill(0x20, js.length); js = t; }
  const total = 12 + 8 + js.length + 8 + byteLen;
  const head = new DataView(new ArrayBuffer(12 + 8)); head.setUint32(0, 0x46546c67, true); head.setUint32(4, 2, true); head.setUint32(8, total, true); head.setUint32(12, js.length, true); head.setUint32(16, 0x4e4f534a, true);
  const binHead = new DataView(new ArrayBuffer(8)); binHead.setUint32(0, byteLen, true); binHead.setUint32(4, 0x004e4942, true);
  return { blob: new Blob([head.buffer, js, binHead.buffer, ...chunks], { type: "model/gltf-binary" }), objects: nodes.length };
}

export function download(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export const safeName = s => (String(s || "").replace(/[^\w\- ]+/g, "").trim() || "sketch");
