// The camera angles for a three.js view that is not the Studio's viewer (Ollic Sketch's 3D view): the same settings,
// ready-made angles, front, framing guides and picture overlay as the Studio (see camera.js and viewer.js), behind the
// same calls, so the same Camera panel (camerapanel.js) drives it.
import { SHAPES, anglesOf, presetSettings, solve, forOutput, describe as describeCamera } from "./camera.js";

/** A perspective camera whose picture can be shifted (a tilt-shift lens: vertical lines stay straight). */
export function shiftCameraClass(THREE) {
  return class ShiftCamera extends THREE.PerspectiveCamera {
    constructor(...a) { super(...a); this.shift = [0, 0]; }
    updateProjectionMatrix() {
      super.updateProjectionMatrix();
      if (this.shift && (this.shift[0] || this.shift[1])) {
        const e = this.projectionMatrix.elements;
        e[8] -= 2 * this.shift[0]; e[9] -= 2 * this.shift[1];
        this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
      }
    }
    copy(src, recursive) { super.copy(src, recursive); this.shift = [...(src.shift || [0, 0])]; return this; }
  };
}

/**
 * host: the element the view is drawn in. camera: a ShiftCamera. controls: OrbitControls. scene: for the front arrow.
 * box(): the model's Box3 (metres, y up). doors(): [{ box: Box3, name }] of the doors. projectFront(): the project's
 * own front ([x, z] out of it) or null. redraw(): draw the view again. drawLines(w, h): the model's lines as pixels
 * (light on black, top row first). drawView(w, h): the view as a canvas.
 */
export function createCameraRig({ THREE, host, camera, controls, scene, box, doors = () => [], projectFront = () => null, redraw, drawLines, drawView }) {
  let pic = null, camSet = null, lastSolve = null, front = [0, 1], frontFrom = "guessed", entrance = null, onFront = null, frontPick = null;
  let frameGuides = { thirds: false, centre: false, horizon: false, safe: false }, overlay = { url: null, opacity: 0.5 };
  const ground = () => { const b = box(); return b.isEmpty() ? 0 : b.min.y; };
  const buildingHeight = () => { const b = box(); return b.isEmpty() ? 10 : Math.max(3, b.max.y - b.min.y); };
  const shapeOf = s => SHAPES[s?.aspect] || (Number.isFinite(+s?.aspect) && +s?.aspect > 0 ? +s.aspect : 1.5);
  const outAspect = () => host.clientWidth / Math.max(1, host.clientHeight);

  /** The camera drawn into a picture of the given shape: the set picture fits inside it. */
  function applyOutput(a = outAspect()) {
    camera.aspect = a;
    controls.maxPolarAngle = pic ? Math.PI * 0.8 : Math.PI;
    if (pic) {
      const h = 2 * Math.atan(Math.tan(pic.v * Math.PI / 360) * pic.aspect) * 180 / Math.PI;
      const o = forOutput({ aspect: pic.aspect, v: pic.v, h, shift: pic.shift }, a);
      camera.fov = o.v; camera.shift = [...o.shift];
    } else camera.shift = [0, 0];
    camera.updateProjectionMatrix();
  }

  function detectFront() {
    entrance = null;
    const own = projectFront();
    if (own) { front = own; frontFrom = "project"; return; }
    front = [0, 1]; frontFrom = "guessed";
    const b = box(); if (b.isEmpty()) return;
    const ds = doors().filter(d => !d.box.isEmpty());
    if (!ds.length) return;
    const low = Math.min(...ds.map(d => d.box.min.y));
    let best = null;
    for (const d of ds.filter(d => d.box.min.y < low + 1.5)) {
      const c = d.box.getCenter(new THREE.Vector3());
      const side = [[b.min.x - c.x, [-1, 0]], [c.x - b.max.x, [1, 0]], [b.min.z - c.z, [0, -1]], [c.z - b.max.z, [0, 1]]]
        .map(([gap, dir]) => ({ gap: Math.abs(gap), dir })).sort((x, y) => x.gap - y.gap)[0];
      const named = /main|entrance|entry|front/i.test(d.name || "") ? -0.6 : 0;
      const wide = -(d.box.max.x - d.box.min.x + d.box.max.z - d.box.min.z) * 0.05;
      const score = side.gap + named + wide;
      if (!best || score < best.score) best = { score, dir: side.dir, c, d };
    }
    if (best && best.d.box.min.y < b.min.y + Math.max(1.5, (b.max.y - b.min.y) * 0.3)) { front = best.dir; frontFrom = "entrance"; entrance = [best.c.x, best.d.box.min.y + 1.1, best.c.z]; }
  }

  function setCamera(settings) {
    const b = box(); if (b.isEmpty()) return null;
    if (frontFrom !== "you") detectFront();
    const base = settings.preset && !settings.custom ? presetSettings(settings.preset, buildingHeight()) : {};
    const st = { aspect: "3:2", ...base, ...settings };
    if (st.interior) return interiorCamera(st, b);
    const c = solve(st, { box: { min: b.min.toArray(), max: b.max.toArray() }, ground: ground(), front, aspect: shapeOf(st), entrance });
    camSet = st; lastSolve = { st, c };
    pic = { aspect: shapeOf(st), v: c.v, shift: c.shift };
    camera.up.set(0, 1, 0);
    if (c.plan) camera.up.set(...(c.up || [0, 0, -1]));
    camera.position.fromArray(c.position); controls.target.fromArray(c.target);
    camera.near = Math.max(0.05, Math.min(0.5, c.distance / 300)); camera.far = Math.max(5000, c.distance * 40);
    applyOutput(); camera.lookAt(controls.target); controls.update();
    drawFrame(); redraw();
    return info(c);
  }
  /** Inside (Sketch has no walk mode): from the middle of the ground floor, level, looking across to the back. */
  function interiorCamera(st, b) {
    const c = b.getCenter(new THREE.Vector3()), y = ground() + (st.height ?? 1.2);
    const back = new THREE.Vector3(-front[0], 0, -front[1]);
    if (st.interior === "two") back.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
    const depth = Math.abs(front[0]) > 0.5 ? b.max.x - b.min.x : b.max.z - b.min.z;
    const pos = new THREE.Vector3(c.x, y, c.z).addScaledVector(back, -depth * 0.3);
    camera.up.set(0, 1, 0); camera.position.copy(pos); controls.target.copy(pos.clone().add(back));
    camera.near = 0.05; camera.far = 2000;
    camSet = st; lastSolve = null;
    pic = { aspect: shapeOf(st), v: anglesOf(st.lens || 18, shapeOf(st)).v, shift: [0, 0] };
    applyOutput(); camera.lookAt(controls.target); controls.update(); drawFrame(); redraw();
    return info();
  }
  function info(c = camSet && lastSolve?.st === camSet ? lastSolve.c : null) {
    const a = pic ? anglesOf(camSet?.lens || 35, pic.aspect) : null;
    return { settings: camSet ? { ...camSet } : null, aspect: pic?.aspect || null, angles: a, shift: pic ? [...pic.shift] : [0, 0], front: [...front], frontFrom,
      buildingHeight: +buildingHeight().toFixed(2), height: +(camera.position.y - ground()).toFixed(3), distance: c ? +c.distance.toFixed(2) : null,
      words: camSet ? describeCamera(camSet, buildingHeight()) : null };
  }
  function freeCamera() { pic = null; camSet = null; camera.up.set(0, 1, 0); camera.fov = 45; applyOutput(); drawFrame(); redraw(); }

  function setFront(dir, from = "you") {
    const l = Math.hypot(dir[0], dir[1]) || 1;
    front = [dir[0] / l, dir[1] / l]; frontFrom = from;
    placeArrow();
    if (camSet) setCamera(camSet);
    onFront?.({ front: [...front], from });
  }
  const arrow = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape([[-0.5, 0], [0.5, 0], [0.5, 1.2], [1.1, 1.2], [0, 2.4], [-1.1, 1.2], [-0.5, 1.2]].map(([x, y]) => new THREE.Vector2(x, y)))),
    new THREE.MeshBasicMaterial({ color: "#e5484d", side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.9 }));
  arrow.visible = false; arrow.renderOrder = 10; scene.add(arrow);
  function placeArrow() {
    const b = box(); if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3()), half = Math.abs(front[0]) > 0.5 ? (b.max.x - b.min.x) / 2 : (b.max.z - b.min.z) / 2, k = Math.max(1, buildingHeight() / 8);
    arrow.scale.setScalar(k);
    arrow.position.set(c.x + front[0] * (half + 1.5 * k), ground() + 0.05, c.z + front[1] * (half + 1.5 * k));
    arrow.rotation.set(-Math.PI / 2, 0, Math.atan2(-front[0], front[1]));
    redraw();
  }

  // the set picture's outline and the framing guides, over the view
  const frameEl = document.createElement("div");
  frameEl.className = "cam-frame"; frameEl.setAttribute("aria-hidden", "true");
  frameEl.style.cssText = "position:absolute;pointer-events:none;box-shadow:0 0 0 9999px rgba(10,12,16,.45);outline:1px solid rgba(255,255,255,.7);display:none;z-index:2";
  host.style.overflow = "hidden"; if (getComputedStyle(host).position === "static") host.style.position = "relative";
  host.append(frameEl);
  function drawFrame() {
    if (!pic) { frameEl.style.display = "none"; return; }
    const W = host.clientWidth, H = host.clientHeight, A = W / Math.max(1, H), a = pic.aspect;
    const w = a >= A ? W : H * a, h = a >= A ? W / a : H;
    Object.assign(frameEl.style, { display: "block", left: `${(W - w) / 2}px`, top: `${(H - h) / 2}px`, width: `${w}px`, height: `${h}px` });
    const L = [], line = (x1, y1, x2, y2, dash = "") => L.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(255,255,255,.75)" stroke-width="1" ${dash ? `stroke-dasharray="${dash}"` : ""}/>`);
    if (frameGuides.thirds) { line(w / 3, 0, w / 3, h); line(2 * w / 3, 0, 2 * w / 3, h); line(0, h / 3, w, h / 3); line(0, 2 * h / 3, w, 2 * h / 3); }
    if (frameGuides.centre) { line(w / 2, 0, w / 2, h, "6 4"); line(0, h / 2, w, h / 2, "6 4"); }
    if (frameGuides.safe) L.push(`<rect x="${w * 0.05}" y="${h * 0.05}" width="${w * 0.9}" height="${h * 0.9}" fill="none" stroke="rgba(255,255,255,.6)" stroke-dasharray="3 3"/>`);
    if (frameGuides.horizon) {
      const dir = new THREE.Vector3(); camera.updateMatrixWorld(); camera.getWorldDirection(dir); dir.y = 0;
      if (dir.lengthSq() > 1e-6) {
        const p = camera.position.clone().addScaledVector(dir.normalize(), 1e4).project(camera), yIn = (1 - p.y) / 2 * H - (H - h) / 2;
        if (yIn > -2 && yIn < h + 2) L.push(`<line x1="0" y1="${yIn}" x2="${w}" y2="${yIn}" stroke="#ffd166" stroke-width="1.5"/>`);
      }
    }
    frameEl.innerHTML = (overlay.url ? `<img src="${overlay.url}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:fill;opacity:${overlay.opacity}">` : "")
      + (L.length ? `<svg width="${w}" height="${h}" style="position:absolute;inset:0">${L.join("")}</svg>` : "");
  }
  controls.addEventListener("change", () => { if (frameGuides.horizon) drawFrame(); });
  controls.addEventListener("start", () => { if (camSet && !camSet.custom) camSet = { ...camSet, custom: true }; });

  function currentPose() {
    const p = { mode: "orbit", position: camera.position.toArray(), target: controls.target.toArray(), fov: camera.fov };
    if (pic) Object.assign(p, { fov: pic.v, aspect: pic.aspect, shift: [...pic.shift], ...(camera.up.y !== 1 ? { up: camera.up.toArray() } : {}), ...(camSet ? { camera: { ...camSet } } : {}) });
    return p;
  }
  function showPose(p) {
    camera.up.set(0, 1, 0); if (p.up) camera.up.fromArray(p.up);
    camera.position.fromArray(p.position); controls.target.fromArray(p.target);
    pic = p.aspect ? { aspect: p.aspect, v: p.fov, shift: p.shift || [0, 0] } : null;
    camSet = p.camera ? { ...p.camera } : null;
    if (!pic) camera.fov = p.fov || 45;
    applyOutput(); camera.lookAt(controls.target); controls.update(); drawFrame(); redraw();
  }
  /** Draws with the camera of a pose at w x h, then puts the view back. */
  function withPose(pose, w, h, draw) {
    const keep = { pic, camSet, up: camera.up.clone(), pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov, arrow: arrow.visible };
    try {
      if (pose) { camera.up.set(0, 1, 0); if (pose.up) camera.up.fromArray(pose.up); camera.position.fromArray(pose.position); controls.target.fromArray(pose.target); pic = pose.aspect ? { aspect: pose.aspect, v: pose.fov, shift: pose.shift || [0, 0] } : null; if (!pic) camera.fov = pose.fov || 45; }
      arrow.visible = false;
      applyOutput(w / h); camera.lookAt(controls.target); camera.updateMatrixWorld();
      return draw();
    } finally {
      pic = keep.pic; camSet = keep.camSet; camera.up.copy(keep.up); camera.position.copy(keep.pos); controls.target.copy(keep.target); camera.fov = keep.fov; arrow.visible = keep.arrow;
      applyOutput(); camera.lookAt(controls.target); camera.updateMatrixWorld(); redraw();
    }
  }

  return {
    get pic() { return pic; },
    applyOutput, drawFrame,
    setCamera, get camera() { return info(); }, freeCamera,
    currentPose, showPose,
    setFront: (dir, from = "you") => setFront(dir, from),
    get front() { return { dir: [...front], from: frontFrom, entrance: entrance ? [...entrance] : null }; },
    onFront(fn) { onFront = fn; },
    detectFront() { if (frontFrom !== "you") detectFront(); placeArrow(); },
    pickFront() { return new Promise(res => { frontPick = res; }); },
    /** For the view's click: while "Make this side the front" waits, a click on a wall sets it (returns true). */
    picked(hit) {
      if (!frontPick) return false;
      const done = frontPick; frontPick = null;
      const n = hit?.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
      if (!n) { done(null); return true; }
      n.y = 0; if (n.lengthSq() < 1e-6) { done(null); return true; }
      n.normalize();
      const c = box().getCenter(new THREE.Vector3());
      if (n.dot(hit.point.clone().sub(c).setY(0)) < 0) n.negate();
      setFront([n.x, n.z]); done([...front]);
      return true;
    },
    get picking() { return !!frontPick; },
    showFront(on) { arrow.visible = !!on; placeArrow(); },
    setFrameGuides(g) { frameGuides = { ...frameGuides, ...g }; drawFrame(); },
    setOverlay(url, opacity = overlay.opacity) { overlay = { url, opacity }; drawFrame(); },
    linePixels(w, h) { return withPose(null, w, h, () => drawLines(w, h)); },
    /** Pictures from a pose (only "view" here): { view: data URL }. */
    guides(w, h, kinds = ["view"], pose = null) {
      const out = {};
      if (kinds.includes("view")) out.view = withPose(pose, w, h, () => drawView(w, h)).toDataURL("image/jpeg", 0.85);
      return out;
    },
  };
}
