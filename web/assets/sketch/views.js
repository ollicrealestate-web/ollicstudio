// Building elevations (North, South, East, West) with level lines you can drag, and the 3D Section Box.
import * as THREE from "three";
import * as LV from "./levels.js";
import { levelLabel } from "./model.js";

/** Horizontal axis of each elevation, as seen by someone standing outside that side, looking at it. */
export const ELEVATIONS = {
  north: { name: "North", u: p => -p.x, dir: [0, 0, -1] }, // stands north (three -z), looks south
  south: { name: "South", u: p => p.x, dir: [0, 0, 1] },
  east: { name: "East", u: p => p.y, dir: [1, 0, 0] },
  west: { name: "West", u: p => -p.y, dir: [-1, 0, 0] },
};

export class ElevationView {
  constructor(host, app) {
    this.host = host; this.app = app; this.side = "south";
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0xf3f2ee);
    this.gl = this.renderer.domElement; this.gl.className = "sk-elev-gl";
    this.over = document.createElement("canvas"); this.over.className = "sk-elev-over"; this.over.tabIndex = 0;
    this.over.setAttribute("aria-label", "Elevation drawing area");
    host.append(this.gl, this.over);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 5000);
    this.s = 0.05; this.cu = 5000; this.cz = 3000; // px per mm, centre (mm along the view, mm up)
    this.drag = null; this.open = false; this.dirty = true;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.wire();
    const loop = () => {
      if (this.open && this.dirty) { this.dirty = false; this.overlayDirty = false; this.render(); }
      else if (this.open && this.overlayDirty) { this.overlayDirty = false; this.drawLevels(); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  show(side) { this.side = side; this.open = true; this.hover = null; this.drag = null; this.host.hidden = false; this.resize(); this.fit(); }
  hide() { this.open = false; this.host.hidden = true; }
  invalidate() { this.dirty = true; }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height); this.dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(this.dpr); this.renderer.setSize(this.w, this.h, false);
    for (const c of [this.gl, this.over]) { c.style.width = this.w + "px"; c.style.height = this.h + "px"; }
    this.over.width = Math.round(this.w * this.dpr); this.over.height = Math.round(this.h * this.dpr);
    this.dirty = true;
  }

  // screen <-> elevation coordinates (u along the view in mm, z up in mm)
  toScreen(u, z) { return { x: (u - this.cu) * this.s + this.w / 2, y: this.h / 2 - (z - this.cz) * this.s }; }
  toModel(x, y) { return { x: (x - this.w / 2) / this.s + this.cu, y: this.zAt(y) }; }
  /** The element under a point (u, z) of this elevation, front-most first. */
  pickId(p) {
    const s = this.toScreen(p.x, p.y), ndc = new THREE.Vector2((s.x / this.w) * 2 - 1, -(s.y / this.h) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera);
    const meshes = []; this.app.view3d.root.traverse(o => { if (o.isMesh && o.userData.id) meshes.push(o); });
    return ray.intersectObjects(meshes, false)[0]?.object.userData.id || null;
  }
  invalidateOverlay() { this.overlayDirty = true; }
  zAt(sy) { return (this.h / 2 - sy) / this.s + this.cz; }

  /** Model extent in this view: u range and z range (mm) of everything in 3D plus the levels. */
  extent() {
    const v3 = this.app.view3d; if (v3.dirty) { v3.dirty = false; v3.rebuild(); }
    const box = new THREE.Box3().setFromObject(v3.root), E = ELEVATIONS[this.side];
    const levels = this.app.doc.levels.map(l => l.elevation);
    if (box.isEmpty()) return { u0: -1000, u1: 11000, z0: Math.min(0, ...levels) - 500, z1: Math.max(3000, ...levels) + 500 };
    const us = [];
    for (const x of [box.min.x, box.max.x]) for (const z of [box.min.z, box.max.z]) us.push(E.u({ x: x * 1000, y: -z * 1000 }));
    return { u0: Math.min(...us), u1: Math.max(...us), z0: Math.min(box.min.y * 1000, ...levels), z1: Math.max(box.max.y * 1000, ...levels) };
  }

  fit() {
    const e = this.extent(), padL = 60, padR = 170; // room for level heads on the right
    const w = Math.max(2000, e.u1 - e.u0), h = Math.max(2000, e.z1 - e.z0);
    this.s = Math.min((this.w - padL - padR) / w, (this.h - 80) / h);
    this.cu = (e.u0 + e.u1) / 2 + (padR - padL) / 2 / this.s; this.cz = (e.z0 + e.z1) / 2;
    this.dirty = true;
  }

  render() {
    const v3 = this.app.view3d, E = ELEVATIONS[this.side];
    if (v3.dirty) { v3.dirty = false; v3.rebuild(); }
    // camera: orthographic, looking at the side, centred on (cu, cz)
    const halfW = this.w / 2 / this.s / 1000, halfH = this.h / 2 / this.s / 1000;
    Object.assign(this.camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    const d = new THREE.Vector3(...E.dir), far = 500;
    // centre point in three.js coords: u is along the screen's right; work out x/z from it
    const right = new THREE.Vector3().crossVectors(d.clone().negate(), new THREE.Vector3(0, 1, 0)).normalize(); // screen right = forward x up
    // a model point p maps to u = E.u(p); with p in three coords (x, -z): u = right . (x, 0, z) * 1000
    const c = right.clone().multiplyScalar(this.cu / 1000).setY(this.cz / 1000);
    this.camera.position.copy(c.clone().add(d.clone().multiplyScalar(far)));
    this.camera.up.set(0, 1, 0); this.camera.lookAt(c);
    this.camera.near = 0.01; this.camera.far = far * 2; this.camera.updateProjectionMatrix();
    const keep = [v3.grid.visible, v3.ground.visible];
    v3.grid.visible = false; v3.ground.visible = false;
    this.renderer.render(v3.scene, this.camera);
    [v3.grid.visible, v3.ground.visible] = keep;
    this.drawLevels();
  }

  /** Level lines across the view with heads on the right; drag a head to change the level's height. */
  drawLevels() {
    const ctx = this.over.getContext("2d"), dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, this.w, this.h);
    this.heads = [];
    for (const l of LV.sorted(this.app.doc)) {
      const z = this.drag?.id === l.id ? this.drag.z : l.elevation;
      const y = Math.round(this.toScreen(0, z).y) + 0.5, x1 = this.w - 150;
      const on = this.drag?.id === l.id || this.hover === l.id;
      ctx.strokeStyle = on ? "#2563eb" : "#4b5563"; ctx.lineWidth = on ? 1.5 : 1; ctx.setLineDash([12, 4, 3, 4]);
      ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.setLineDash([]);
      // head: circle with a cross, then name and height
      ctx.beginPath(); ctx.arc(x1 + 9, y, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x1 + 2, y); ctx.lineTo(x1 + 16, y); ctx.moveTo(x1 + 9, y - 7); ctx.lineTo(x1 + 9, y + 7); ctx.stroke();
      ctx.fillStyle = on ? "#1d4ed8" : "#1f2937"; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
      ctx.font = "600 12px Archivo, system-ui, sans-serif"; ctx.fillText(l.name, x1 + 22, y - 3);
      ctx.font = "12px Archivo, system-ui, sans-serif"; ctx.fillText(levelLabel(z), x1 + 22, y + 12);
      this.heads.push({ id: l.id, y, x0: x1 - 4, x1: this.w });
    }
    this.app.drawElevSketch?.(ctx, this);
    // view name
    ctx.fillStyle = "#374151"; ctx.font = "600 12px Archivo, system-ui, sans-serif"; ctx.textAlign = "left"; ctx.fillText(`${ELEVATIONS[this.side].name} Elevation`, 12, this.h - 12);
  }

  headAt(x, y) { return (this.heads || []).find(h => Math.abs(h.y - y) <= 9 && x >= 30) || null; }

  wire() {
    const el = this.over;
    let pan = null;
    const tool = () => (this.app.tool?.elev && this.app.sketch?.elev === this.side ? this.app.tool : null);
    el.addEventListener("contextmenu", e => e.preventDefault());
    el.addEventListener("pointerdown", e => {
      const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      el.focus();
      if (tool() && e.button === 0) { tool().elevDown(this, this.toModel(x, y), e.shiftKey); this.overlayDirty = true; return; }
      const h = e.button === 0 && !tool() && this.headAt(x, y);
      if (h) { const lv = this.app.doc.levels.find(l => l.id === h.id); this.drag = { id: h.id, z: lv.elevation, y0: y, z0: lv.elevation }; el.setPointerCapture(e.pointerId); this.dirty = true; return; }
      pan = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", e => {
      const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (this.drag) { this.drag.z = Math.round((this.drag.z0 + (this.drag.y0 - y) / this.s) / 10) * 10; this.dirty = true; this.app.setPrompt?.(`Level height ${levelLabel(this.drag.z)}. Release to set it.`); return; }
      if (pan) { this.cu -= (e.clientX - pan.x) / this.s; this.cz += (e.clientY - pan.y) / this.s; pan = { x: e.clientX, y: e.clientY }; this.dirty = true; return; }
      if (tool()) { tool().elevMove(this, this.toModel(x, y), e.shiftKey); el.style.cursor = "crosshair"; this.overlayDirty = true; this.app.setPrompt?.(); return; }
      const h = this.headAt(x, y); el.style.cursor = h ? "ns-resize" : "grab";
      if ((h?.id || null) !== (this.hover || null)) { this.hover = h?.id || null; this.dirty = true; }
    });
    el.addEventListener("pointerup", () => {
      pan = null;
      const d = this.drag; this.drag = null; this.dirty = true;
      if (!d || d.z === d.z0) return;
      this.app.commit("Move level", doc => LV.setElevation(doc, d.id, d.z));
      this.app.setPrompt?.();
    });
    el.addEventListener("dblclick", async e => {
      const r = el.getBoundingClientRect(), h = this.headAt(e.clientX - r.left, e.clientY - r.top); if (!h) return;
      const lv = this.app.doc.levels.find(l => l.id === h.id);
      const v = await this.app.askText(`Height of ${lv.name} in metres`, (lv.elevation / 1000).toFixed(3));
      if (v == null) return;
      const m = parseFloat(String(v).replace(",", "."));
      if (!Number.isFinite(m)) { this.app.toast("Type the height in metres, for example 3.000.", true); return; }
      this.app.commit("Level height", doc => LV.setElevation(doc, h.id, Math.round(m * 1000)));
    });
    el.addEventListener("wheel", e => {
      e.preventDefault();
      const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const u = (x - this.w / 2) / this.s + this.cu, z = this.zAt(y), f = Math.exp(-e.deltaY * 0.0015);
      this.s = Math.min(2, Math.max(0.002, this.s * f));
      this.cu = u - (x - this.w / 2) / this.s; this.cz = z - (this.h / 2 - y) / this.s; this.dirty = true;
    }, { passive: false });
  }
}

// --------------------------------------------------------------------------- Section Box
/** Default box: the model's extent plus 500 mm, in model mm (x east, y north, z up). */
export function modelBoxMm(v3) {
  const b = new THREE.Box3().setFromObject(v3.root);
  if (b.isEmpty()) return { x0: -1000, x1: 11000, y0: -1000, y1: 9000, z0: -500, z1: 4000 };
  const m = 500;
  return { x0: Math.round(b.min.x * 1000 - m), x1: Math.round(b.max.x * 1000 + m), y0: Math.round(-b.max.z * 1000 - m), y1: Math.round(-b.min.z * 1000 + m), z0: Math.round(b.min.y * 1000 - m), z1: Math.round(b.max.y * 1000 + m) };
}

/** Applies (or clears) the section box on the 3D view: six clipping planes and a thin box outline. */
export function applySectionBox(v3, box) {
  if (v3.boxLines) { v3.scene.remove(v3.boxLines); v3.boxLines.geometry.dispose(); v3.boxLines = null; }
  if (!box) { v3.renderer.clippingPlanes = []; v3.needsRender = true; return; }
  const m = k => box[k] / 1000;
  // keep x >= x0, x <= x1, y(up) >= z0, y <= z1, north: three z = -y, so -z >= y0 -> z <= -y0, -z <= y1 -> z >= -y1
  v3.renderer.clippingPlanes = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -m("x0")), new THREE.Plane(new THREE.Vector3(-1, 0, 0), m("x1")),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -m("z0")), new THREE.Plane(new THREE.Vector3(0, -1, 0), m("z1")),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), -m("y0")), new THREE.Plane(new THREE.Vector3(0, 0, 1), m("y1")),
  ];
  const g = new THREE.Box3(new THREE.Vector3(m("x0"), m("z0"), -m("y1")), new THREE.Vector3(m("x1"), m("z1"), -m("y0")));
  g.expandByScalar(-0.003); // just inside the planes, so the outline is not cut away
  v3.boxLines = new THREE.Box3Helper(g, 0x3b82f6);
  v3.scene.add(v3.boxLines);
  v3.needsRender = true;
}
