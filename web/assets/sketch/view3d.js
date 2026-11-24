// 3D view (three.js). The scene is rebuilt from the model; nothing here is stored.
// Model mm (x east, y north, z up)  ->  three.js metres (x, y up, -z north).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as G from "./geom.js";
import { Sky } from "three/addons/objects/Sky.js";
import { materialLook, addMetricUVs, setupLooks, loadSources } from "../materials/look.js";
import { shiftCameraClass, createCameraRig } from "../camerarig.js";

const ShiftCamera = shiftCameraClass(THREE);

export const toThree = (p, zMm = 0) => new THREE.Vector3(p.x / 1000, zMm / 1000, -p.y / 1000);

export class View3D {
  constructor(host, app) {
    this.host = host; this.app = app;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x0c0c0e);
    host.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new ShiftCamera(45, 1, 0.05, 2000);
    this.camera.position.set(14, 11, 16);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(5, 0, -4);
    // left drag orbits, middle or right drag pans, wheel zooms; Shift+middle orbits as in Revit
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.renderer.domElement.addEventListener("pointerdown", e => {
      this.controls.mouseButtons.MIDDLE = e.button === 1 && e.shiftKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    }, true);
    // free navigation (as in the Studio): the orbit turns round what is under the pointer, and zooming in keeps going
    this.controls.minDistance = 0.05;
    this.renderer.domElement.addEventListener("pointerdown", e => {
      if (e.button !== 0 || !this.root) return;
      const r = this.renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      const hit = ray.intersectObjects(this.root.children, true).find(h => h.object.isMesh);
      if (!hit) return;
      const fwd = new THREE.Vector3(); this.camera.getWorldDirection(fwd);
      const depth = hit.point.clone().sub(this.camera.position).dot(fwd);
      if (depth > 0.1) this.controls.target.copy(this.camera.position).addScaledVector(fwd, depth);
    }, true);
    this.renderer.domElement.addEventListener("wheel", e => {
      if (e.deltaY >= 0) return;
      const d = this.camera.position.distanceTo(this.controls.target), near = 0.8;
      if (d > near) return;
      const fwd = new THREE.Vector3(); this.camera.getWorldDirection(fwd);
      this.camera.position.addScaledVector(fwd, near * 0.6); this.controls.target.addScaledVector(fwd, near * 0.6); this.needsRender = true;
    }, { capture: true, passive: true });
    this.controls.addEventListener("change", () => {
      const d = this.camera.position.distanceTo(this.controls.target); let changed = false;
      if (d < this.camera.near * 30) { this.camera.near = Math.max(0.02, d / 200); changed = true; }
      if (d * 40 > this.camera.far) { this.camera.far = d * 60; changed = true; }
      if (changed) this.camera.updateProjectionMatrix();
    });
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
      if (this.rig?.picking) {   // "Make this side the front": the wall clicked
        const r = this.renderer.domElement.getBoundingClientRect();
        ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
        this.rig.picked(ray.intersectObjects(this.root.children, true).find(h => h.object.isMesh && h.face) || null); return;
      }
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
    // camera angles (the Camera panel): the same ready-made angles, lens, front and saved views as the Studio
    this.rig = createCameraRig({ THREE, host, camera: this.camera, controls: this.controls, scene: this.scene,
      box: () => this.modelBox(),
      doors: () => {   // the doors (openings of kind door) as boxes, for finding the main entrance
        const list = (app.doc?.openings || []).filter(o => o.kind === "door"), ids = new Set(list.map(d => d.id)), by = new Map();
        this.root.traverse(o => { const id = o.userData?.id; if (o.isMesh && ids.has(id)) (by.get(id) || by.set(id, new THREE.Box3()).get(id)).expandByObject(o); });
        return [...by].map(([id, box]) => { const d = list.find(x => x.id === id); return { box, name: `${d?.name || ""} ${d?.mark || ""}` }; });
      },
      projectFront: () => ({ south: [0, 1], north: [0, -1], east: [1, 0], west: [-1, 0] })[app.doc?.settings?.front] || null,
      redraw: () => { this.needsRender = true; },
      drawLines: (w, h) => this.drawLines(w, h), drawView: (w, h) => this.snapshot(w, h) });
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

  /**
   * The current 3D view as a picture: same camera and visual style, at the size asked for (pixels), on a dark or
   * white background, without the grid. Returns a canvas. The view on screen is put back as it was.
   */
  snapshot(width, height, { background = "dark", edgesDark = true } = {}) {
    if (this.dirty) { this.dirty = false; this.rebuild(); }
    const r = this.renderer, size = r.getSize(new THREE.Vector2()), ratio = r.getPixelRatio(), aspect = this.camera.aspect;
    const clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha(), grid = this.grid.visible, hi = this.edgeHi?.visible;
    const max = r.capabilities.maxTextureSize || 4096;
    const k = Math.min(1, max / width, max / height), W = Math.round(width * k), H = Math.round(height * k);
    try {
      r.setPixelRatio(1); r.setSize(W, H, false);
      if (this.rig?.pic) this.rig.applyOutput(W / H); else { this.camera.aspect = W / H; this.camera.updateProjectionMatrix(); }
      this.grid.visible = false; if (this.edgeHi) this.edgeHi.visible = false;
      r.setClearColor(background === "white" ? 0xffffff : 0x0c0c0e, 1);
      r.render(this.scene, this.camera);
      const out = document.createElement("canvas"); out.width = W; out.height = H;
      out.getContext("2d").drawImage(r.domElement, 0, 0, W, H);
      return out;
    } finally {
      r.setClearColor(clear, alpha); this.grid.visible = grid; if (this.edgeHi) this.edgeHi.visible = hi;
      r.setPixelRatio(ratio); r.setSize(size.x, size.y, false);
      if (this.rig?.pic) this.rig.applyOutput(aspect); else { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
      this.needsRender = true;
    }
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + "px"; this.renderer.domElement.style.height = h + "px";
    if (this.rig?.pic) { this.rig.applyOutput(w / h); this.rig.drawFrame(); }
    else { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
    this.needsRender = true;
  }
  /** The model's extent (metres, y up), without the grid, ground or helpers. */
  modelBox() {
    if (this.dirty) { this.dirty = false; this.rebuild(); }
    const b = new THREE.Box3(); this.root.traverse(o => { if (o.isMesh && o.visible) b.expandByObject(o); });
    return b;
  }
  /** The model's lines from the current camera at w x h: light lines on black, as pixels (top row first). */
  drawLines(w, h) {
    if (this.dirty) { this.dirty = false; this.rebuild(); }
    const r = this.renderer, size = r.getSize(new THREE.Vector2()), ratio = r.getPixelRatio();
    const clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha(), keep = [], added = [];
    const black = new THREE.MeshBasicMaterial({ color: 0x000000, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const white = new THREE.LineBasicMaterial({ color: 0xffffff });
    const env = this.scene.environment, bg = this.scene.background;
    const hidden = [this.grid, this.ground, this.edgeHi].filter(o => o && o.visible);
    try {
      this.root.traverse(o => {
        if (o.isMesh) {
          keep.push([o, o.material]); o.material = black;
          const e = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 30), white); e.matrixAutoUpdate = false; e.matrix.copy(o.matrixWorld); added.push(e);
        } else if (o.isLine) { keep.push([o, o.material]); o.material = white; }
      });
      for (const e of added) this.scene.add(e);
      hidden.forEach(o => { o.visible = false; });
      this.scene.environment = null; this.scene.background = null;
      r.setPixelRatio(1); r.setSize(w, h, false); r.setClearColor(0x000000, 1);
      r.render(this.scene, this.camera);
      const gl = r.getContext(), raw = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) data.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      return { data, width: w, height: h };
    } finally {
      for (const [o, m] of keep) o.material = m;
      for (const e of added) { this.scene.remove(e); e.geometry.dispose(); }
      black.dispose(); white.dispose();
      hidden.forEach(o => { o.visible = true; });
      this.scene.environment = env; this.scene.background = bg;
      r.setClearColor(clear, alpha); r.setPixelRatio(ratio); r.setSize(size.x, size.y, false);
      this.needsRender = true;
    }
  }

  clear() {
    for (const o of [...this.root.children]) {
      this.root.remove(o);
      o.traverse(n => { n.geometry?.dispose?.(); if (n.material) [].concat(n.material).forEach(m => { if (!m.userData?.lib) m.dispose(); }); });   // library looks are shared
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
    if ((this.app.prefs?.visual || "shaded") === "realistic") this.realistic();
    else if (this.scene.environment && this._env) this.scene.environment = null;
    // frame the model the first time there is something to see
    if (!this.fitted && this.root.children.length) { this.fitted = true; this.fit(); }
  }

  /**
   * The Realistic style: every surface with a library material shows the Studio's photographed texture at its real
   * size (the same library and pictures as the Studio's 3D preview), lit by a sunny sky that also gives reflections.
   */
  realistic() {
    if (!this._env) {
      const sky = new Sky(); sky.scale.setScalar(100);
      const u = sky.material.uniforms; u.turbidity.value = 2.2; u.rayleigh.value = 1.6; u.sunPosition.value.set(0.6, 0.75, 0.3);
      const sk = new THREE.Scene(); sk.add(sky);
      this._env = new THREE.PMREMGenerator(this.renderer).fromScene(sk, 0.02).texture;
      setupLooks({ redraw: () => { this.needsRender = true; } });
      loadSources().then(() => { this.needsRender = true; });
    }
    this.scene.environment = this._env; this.scene.environmentIntensity = 0.6;
    this.root.traverse(o => {
      const id = o.userData?.mat;
      if (!o.isMesh || typeof id !== "string" || !id.startsWith("mt-") || this.app.selection?.has(o.userData.id)) return;
      const look = materialLook(id, { quality: "high" });
      if (!look) return;
      if (!o.geometry.attributes.uv || !o.geometry.userData.metric) { addMetricUVs(o.geometry); o.geometry.userData.metric = true; }
      [].concat(o.material).forEach(m => m.dispose());
      o.material = look;
    });
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
    if (this.rig?.pic && this.fitted) this.rig.freeCamera();   // zoom to fit leaves a set camera angle
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
  /** Looks from a direction (three.js x, y, z; y up), then fits the model. */
  lookDir(d) {
    const t = this.controls.target, dist = this.camera.position.distanceTo(t);
    this.camera.position.copy(t.clone().add(new THREE.Vector3(...d).normalize().multiplyScalar(dist)));
    this.fit();
  }
  lookFrom(dirName) {
    const d = { ne: [1, 0.8, -1], nw: [-1, 0.8, -1], se: [1, 0.8, 1], sw: [-1, 0.8, 1], top: [0, 1, 0.0001] }[dirName] || [1, 0.8, 1];
    const t = this.controls.target, dist = this.camera.position.distanceTo(t);
    this.camera.position.copy(t.clone().add(new THREE.Vector3(...d).normalize().multiplyScalar(dist)));
    this.fit();
  }
}
