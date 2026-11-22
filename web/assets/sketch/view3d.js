// 3D view (three.js). The scene is rebuilt from the model; nothing here is stored.
// Model mm (x east, y north, z up)  ->  three.js metres (x, y up, -z north).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as G from "./geom.js";

export const toThree = (p, zMm = 0) => new THREE.Vector3(p.x / 1000, zMm / 1000, -p.y / 1000);

export class View3D {
  constructor(host, app) {
    this.host = host; this.app = app;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x0c0c0e);
    host.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
    this.camera.position.set(14, 11, 16);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(5, 0, -4);
    // left drag orbits, middle or right drag pans, wheel zooms; Shift+middle orbits as in Revit
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.renderer.domElement.addEventListener("pointerdown", e => {
      this.controls.mouseButtons.MIDDLE = e.button === 1 && e.shiftKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    }, true);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a30, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(20, 30, 10);
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 120 });
    this.sun = sun;
    this.scene.add(sun);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x8c8a84, roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2; this.ground.position.y = -0.001; this.ground.receiveShadow = true; this.ground.visible = false;
    this.scene.add(this.ground);
    // click (without dragging) to select in 3D
    const ray = new THREE.Raycaster(); let downAt = null;
    this.renderer.domElement.addEventListener("pointerdown", e => { downAt = { x: e.clientX, y: e.clientY, b: e.button }; });
    this.renderer.domElement.addEventListener("pointerup", e => {
      if (!downAt || downAt.b !== 0 || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
      // while sketching with Pick Lines, a click picks a model edge instead of selecting
      if (this.app.pickEdge3D?.active()) { const ed = this.edgeAt(e); if (ed) this.app.pickEdge3D.add(ed.a, ed.b); else this.app.toast("Click on an edge (a line of the model)."); this.setEdgeHi(null); return; }
      const r = this.renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      const hit = ray.intersectObjects(this.root.children, true).find(h => h.object.isMesh && h.object.userData.id);
      this.app.pick3D?.(hit ? hit.object.userData.id : null);
    });
    this.renderer.domElement.addEventListener("pointermove", e => {
      if (e.buttons || !this.app.pickEdge3D?.active()) { if (this.edgeHi) this.setEdgeHi(null); return; }
      this.setEdgeHi(this.edgeAt(e));
    });
    this.grid = new THREE.GridHelper(60, 60, 0x2e2e36, 0x1b1b20);
    this.grid.position.set(5, 0, -5);
    this.scene.add(this.grid);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.style = "shaded";
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.dirty = true;
    this.controls.addEventListener("change", () => { this.needsRender = true; });
    const loop = () => {
      if (this.paused) { requestAnimationFrame(loop); return; } // Live 3D off: nothing is rebuilt or drawn while you draw
      if (this.dirty) { this.dirty = false; this.rebuild(); this.needsRender = true; }
      if (this.controls.update() || this.needsRender) { this.needsRender = false; this.renderer.render(this.scene, this.camera); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  invalidate() { this.dirty = true; }

  setShadows(on) {
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
    this.ground.visible = on;
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + "px"; this.renderer.domElement.style.height = h + "px";
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  clear() {
    for (const o of [...this.root.children]) {
      this.root.remove(o);
      o.traverse(n => { n.geometry?.dispose?.(); if (n.material) [].concat(n.material).forEach(m => m.dispose()); });
    }
  }

  rebuild() {
    this.clear();
    const doc = this.app.doc;
    const elev = new Map(doc.levels.map(l => [l.id, l.elevation]));
    const visible = this.app.visibleLevels3D?.() || null;
    // model lines exist in 3D on their level's plane; detail lines belong to one view only
    const pts = [];
    const selPts = [];
    for (const l of doc.lines) {
      if (l.kind !== "model") continue;
      if (visible && !visible.has(l.levelId)) continue;
      const z = elev.get(l.levelId) ?? 0;
      const out = this.app.selection.has(l.id) ? selPts : pts;
      if (l.shape === "arc") {
        const n = Math.max(8, Math.ceil(Math.abs(l.sweep) / (Math.PI / 32)));
        for (let k = 0; k < n; k++) out.push(toThree(G.arcPoint(l, l.start + (l.sweep * k) / n), z), toThree(G.arcPoint(l, l.start + (l.sweep * (k + 1)) / n), z));
      } else out.push(toThree(l.a, z), toThree(l.b, z));
    }
    const addLines = (arr, color) => {
      if (!arr.length) return;
      const g = new THREE.BufferGeometry().setFromPoints(arr);
      this.root.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color })));
    };
    addLines(pts, 0xe8e8ec);
    addLines(selPts, 0x3b82f6);
    this.app.build3D?.(this, THREE);
    // frame the model the first time there is something to see
    if (!this.fitted && this.root.children.length) { this.fitted = true; this.fit(); }
  }

  /** The model edge (from the 3D outlines) under the mouse: { a, b } in model mm (x east, y north, z up), or null. */
  edgeAt(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    // a pick distance of about 6 pixels at the target's distance
    const dist = this.camera.position.distanceTo(this.controls.target);
    ray.params.Line = { threshold: (dist * Math.tan((this.camera.fov * Math.PI) / 360) * 2 * 6) / Math.max(1, r.height) };
    const lines = []; this.root.traverse(o => { if (o.isLineSegments && o.visible) lines.push(o); });
    const hit = ray.intersectObjects(lines, false)[0];
    if (!hit || hit.index == null) return null;
    const pos = hit.object.geometry.attributes.position, i = hit.index - (hit.index % 2);
    const P = k => new THREE.Vector3().fromBufferAttribute(pos, k).applyMatrix4(hit.object.matrixWorld);
    const A = P(i), B = P(i + 1);
    const M = v => ({ x: Math.round(v.x * 10000) / 10, y: Math.round(-v.z * 10000) / 10, z: Math.round(v.y * 10000) / 10 });
    return { a: M(A), b: M(B), three: [A, B] };
  }
  setEdgeHi(ed) {
    if (this.edgeHi) { this.scene.remove(this.edgeHi); this.edgeHi.geometry.dispose(); this.edgeHi = null; }
    if (ed) {
      this.edgeHi = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ed.three), new THREE.LineBasicMaterial({ color: 0x3b82f6, depthTest: false }));
      this.edgeHi.renderOrder = 10; this.scene.add(this.edgeHi);
    }
    this.needsRender = true;
  }

  /** Frames everything in view. */
  fit() {
    const box = new THREE.Box3().setFromObject(this.root);
    if (box.isEmpty()) { box.min.set(-1, 0, -9); box.max.set(11, 3, 1); }
    const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
    const r = Math.max(4, size.length() / 2);
    const v = (this.camera.fov * Math.PI) / 360, h = Math.atan(Math.tan(v) * (this.camera.aspect || 1)); // half angles; narrow views fit the width
    const dist = r / Math.sin(Math.min(v, h)) * 0.95;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(centre);
    this.camera.position.copy(centre.clone().add(dir.multiplyScalar(dist)));
    this.camera.near = Math.max(0.01, dist / 200); this.camera.far = dist * 50; this.camera.updateProjectionMatrix();
    this.controls.update(); this.camera.updateMatrixWorld();
    this.needsRender = true;
  }

  /** Looks from a named corner (for screenshots and the view cube). */
  lookFrom(dirName) {
    const d = { ne: [1, 0.8, -1], nw: [-1, 0.8, -1], se: [1, 0.8, 1], sw: [-1, 0.8, 1], top: [0, 1, 0.0001] }[dirName] || [1, 0.8, 1];
    const t = this.controls.target, dist = this.camera.position.distanceTo(t);
    this.camera.position.copy(t.clone().add(new THREE.Vector3(...d).normalize().multiplyScalar(dist)));
    this.fit();
  }
}
