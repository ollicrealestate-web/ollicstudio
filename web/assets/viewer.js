// 3D viewer for architects' IFC models.
// Looks: every part gets a realistic material from what the architect set in the IFC (looks.js),
// a real sky gives reflections in the glass, soft sun shadows, and ambient occlusion in corners
// (drawn once the view is still, so moving stays smooth).
// Moving around: orbit, pan, zoom to the pointer, double-click to fly to a spot, quick views
// (front, back, left, right, top, corner), a section cut through any floor (inside view), and a
// first-person walk with keys, mouse or touch that follows floors and stairs, stops at walls,
// passes through doors, and goes up and down floors.
// Loads the GLB made by Ollic: one node per element, named by its IFC GlobalId, with
// { globalId, ifcType, name, storey, family } in its extras; parts may carry "ollic:<class>" materials.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Sky } from "three/addons/objects/Sky.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { addUVs, grassTexture, guessClass, lookFor } from "./looks.js";

const PLAN_CUT = 1.3;                 // the section cut: 1.3 m above a floor, as on a floor plan
const SOLID_FOR_WALKING = new Set(["IfcWall", "IfcWallStandardCase", "IfcColumn", "IfcCurtainWall", "IfcRailing", "IfcWindow", "IfcPlate", "IfcMember", "IfcBuildingElementProxy", "IfcStair", "IfcStairFlight", "IfcFurnishingElement", "IfcFurniture"]);
const lowPower = matchMedia("(pointer: coarse)").matches || (navigator.hardwareConcurrency || 8) <= 4;

export function createViewer(host, { onSelect } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.72;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#c9d3dc");
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.zoomToCursor = true;          // zoom towards whatever is under the pointer
  controls.screenSpacePanning = true;
  controls.maxPolarAngle = Math.PI * 0.495;

  // sky, sun and the sky's light in reflections
  const sky = new Sky();
  sky.scale.setScalar(4500);
  sky.material.uniforms.turbidity.value = 2.2; sky.material.uniforms.rayleigh.value = 3.2;
  sky.material.uniforms.mieCoefficient.value = 0.004; sky.material.uniforms.mieDirectionalG.value = 0.82;
  scene.add(sky);
  const SUN_AZ = 0.65, SUN_EL = 0.72;   // afternoon sun from the south-west
  const sunDir = new THREE.Vector3(Math.cos(SUN_EL) * Math.cos(SUN_AZ), Math.sin(SUN_EL), Math.cos(SUN_EL) * Math.sin(SUN_AZ));
  sky.material.uniforms.sunPosition.value.copy(sunDir);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const skyScene = new THREE.Scene(); const skyCopy = new Sky(); skyCopy.scale.setScalar(4500); skyCopy.material = sky.material; skyScene.add(skyCopy);
  const env = pmrem.fromScene(skyScene, 0.02).texture;
  scene.environment = env;
  scene.environmentIntensity = 0.55;

  const hemi = new THREE.HemisphereLight("#dfe9ff", "#4a4436", 0.3);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight("#ffeacc", 3.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(lowPower ? 2048 : 4096, lowPower ? 2048 : 4096);
  sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.03; sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  const grass = grassTexture().clone(); grass.needsUpdate = true; grass.repeat.set(160, 160);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(900, 96), new THREE.MeshStandardMaterial({ color: "#ffffff", map: grass, roughness: 1, envMapIntensity: 0.35 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);
  const groundLook = ground.material;

  // ambient occlusion, drawn when the view has been still for a moment
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const ao = new GTAOPass(scene, camera, 1, 1);
  ao.output = GTAOPass.OUTPUT.Default; ao.blendIntensity = 0.9;
  composer.addPass(ao);
  composer.addPass(new OutputPass());
  let stillTimer = 0, finalDone = false;

  const labels = document.createElement("div");
  labels.className = "viewer-labels";
  host.append(labels);

  let model = null, elements = [], storeys = [], storeyLow = {}, mode = "exterior", storey = null, selected = null, frame = 0, dirty = true;
  let owner = null;       // the construction animation, while it drives the camera and the scene
  let frameBox = new THREE.Box3();   // the building, without a large plot around it
  let groundY = 0;        // finished ground level: the bottom of the lowest storey's walls, not of its footings
  const cut = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  // walking: eye height, look direction, movement, floors underfoot and walls in front
  const EYE = 1.6, SPEED = 1.5, TURN = 1.6, STEP = 0.45, RADIUS = 0.45;
  let yaw = 0, pitch = 0, room = null, last = performance.now(), feet = 0, near = [], nearAt = 0;
  const keys = new Set(), hold = { fwd: 0, turn: 0, up: 0 };
  let fly = null;          // a camera move in progress
  const redraw = () => { dirty = true; finalDone = false; };
  controls.addEventListener("change", redraw);
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();

  function resize() {
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    composer.setSize(w, h); ao.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    redraw();
  }
  new ResizeObserver(resize).observe(host);

  async function load(url) {
    const gltf = await new GLTFLoader().loadAsync(url);
    if (model) scene.remove(model);
    model = gltf.scene;
    elements = [];
    model.traverse(o => {
      if (!o.isMesh) return;
      const x = { ...(o.parent?.userData || {}), ...(o.userData || {}) };
      o.userData = x;
      // older 3D files from Ollic leave normals out (each triangle has its own corners), so they are made here
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      const src = o.material, named = /^ollic:(\w+)/.exec(src?.name || "");
      const cls = named ? named[1] : guessClass(x.ifcType, src?.opacity ?? 1);
      const look = lookFor(cls, src?.color || new THREE.Color("#cccccc"), src?.opacity ?? 1);
      if (look.userData.metres && !o.geometry.attributes.uv) addUVs(o.geometry, look.userData.metres);
      o.material = look;
      o.userData.cls = cls;
      o.castShadow = cls !== "glass" && cls !== "space";
      o.receiveShadow = cls !== "space";
      o.geometry.computeBoundingBox(); o.geometry.computeBoundingSphere();
      elements.push(o);
    });
    scene.add(model);
    // storeys from bottom to top, by the lowest point of their elements
    storeyLow = {};
    for (const e of elements) {
      const s = e.userData.storey; if (!s) continue;
      storeyLow[s] = Math.min(storeyLow[s] ?? Infinity, e.geometry.boundingBox.min.y);
    }
    storeys = Object.keys(storeyLow).sort((a, b) => storeyLow[a] - storeyLow[b]);
    const BELOW = new Set(["IfcFooting", "IfcPile", "IfcSpace"]);
    const first = elements.filter(e => !BELOW.has(e.userData.ifcType) && !(e.userData.ifcType === "IfcSlab" && e.userData.predefined === "BASESLAB")
      && (!storeys.length || e.userData.storey === storeys[0]));
    groundY = first.length ? Math.min(...first.map(e => e.geometry.boundingBox.min.y)) : new THREE.Box3().setFromObject(model).min.y;
    ground.position.y = groundY - 0.02;
    frameBox = buildingBox(elements);
    frameAll();
    apply();
    redraw();
    return { storeys, count: elements.length };
  }

  /** The building itself, for placing the camera: models often include the whole plot (paving,
   * ground slabs, boundary walls), many times larger than the building. Parts much bigger than the
   * building's core are left out of the frame (they are still shown). */
  function buildingBox(list) {
    let boxes = list.filter(e => e.userData.ifcType !== "IfcSpace").map(e => new THREE.Box3().setFromObject(e)).filter(b => !b.isEmpty());
    const all = new THREE.Box3(); boxes.forEach(b => all.union(b));
    if (boxes.length < 12) return all;
    const low = all.min.y, tall = all.max.y - all.min.y;
    const raised = boxes.filter(b => b.max.y > low + Math.min(3.2, tall * 0.25));
    if (raised.length >= 8) boxes = raised;
    const pct = (arr, q) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
    const cx = boxes.map(b => (b.min.x + b.max.x) / 2), cz = boxes.map(b => (b.min.z + b.max.z) / 2);
    const x0 = pct(cx, 0.1), x1 = pct(cx, 0.9), z0 = pct(cz, 0.1), z1 = pct(cz, 0.9);
    const core = Math.max(4, x1 - x0, z1 - z0), limit = core * 1.5 + 2;
    const keep = new THREE.Box3();
    for (const b of boxes) {
      const w = Math.max(b.max.x - b.min.x, b.max.z - b.min.z), mx = (b.min.x + b.max.x) / 2, mz = (b.min.z + b.max.z) / 2;
      const m = core * 0.5;
      if (w <= limit && mx >= x0 - m && mx <= x1 + m && mz >= z0 - m && mz <= z1 + m) keep.union(b);
    }
    if (keep.isEmpty()) return all;
    keep.min.y = Math.min(keep.min.y, all.min.y);
    return keep;
  }

  function fitDistance(radius, fov = camera.fov) {
    const vfov = THREE.MathUtils.degToRad(fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    return radius / Math.sin(Math.min(vfov, hfov) / 2) * 0.92;
  }
  function placeSun(c, r) {
    sun.position.copy(c).addScaledVector(sunDir, r * 2.4);
    sun.target.position.copy(c);
    const s = r * 0.85;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 0.1, far: r * 6 });
    sun.shadow.camera.updateProjectionMatrix();
  }
  function frameAll() {
    const box = frameBox.clone();
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const radius = size.length() / 2, d = fitDistance(radius);
    const dir = new THREE.Vector3(0.62, 0.48, 0.62).normalize();
    controls.target.copy(c);
    camera.position.copy(c).addScaledVector(dir, d);
    camera.near = Math.max(0.05, d / 300); camera.far = Math.max(5000, d * 40); camera.updateProjectionMatrix();
    placeSun(c, Math.max(size.x, size.z, size.y));
    ao.updateGtaoMaterial({ radius: Math.max(0.25, Math.min(2.5, radius * 0.02)), distanceExponent: 1.2, thickness: Math.max(1, radius * 0.03), scale: 1, samples: 16 });
    controls.update();
  }

  /** Quick views: front, back, left, right, top and corner, flown to smoothly. */
  function view(name) {
    if (mode === "walk") leaveWalk();
    const box = frameBox, size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const d = fitDistance(size.length() / 2);
    const dirs = { front: [0, 0.18, 1], back: [0, 0.18, -1], left: [-1, 0.18, 0], right: [1, 0.18, 0], top: [0.001, 1, 0.002], corner: [0.62, 0.48, 0.62] };
    const dir = new THREE.Vector3(...(dirs[name] || dirs.corner)).normalize();
    flyTo(c.clone().addScaledVector(dir, d), c);
  }
  function flyTo(pos, target, ms = 700) {
    fly = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, start: performance.now(), ms };
    redraw();
  }
  function stepFly(now) {
    if (!fly) return;
    const k = Math.min(1, (now - fly.start) / fly.ms), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    camera.position.lerpVectors(fly.p0, fly.p1, e); controls.target.lerpVectors(fly.t0, fly.t1, e);
    if (k >= 1) fly = null;
    redraw();
  }

  // inside view: a section cut 1.3 m above the chosen floor (the top floor if none), so rooms can be seen from above
  function planStorey() {
    if (storey) return storey;
    const n = {};
    for (const e of elements) if (/^Ifc(Wall|WallStandardCase|Door)$/.test(e.userData.ifcType) && e.userData.storey) n[e.userData.storey] = (n[e.userData.storey] || 0) + 1;
    let best = storeys[storeys.length - 1], top = 0;
    for (const s of storeys) if ((n[s] || 0) >= top && (n[s] || 0) > 0) { top = n[s]; best = s; }
    return best;
  }
  function cutHeight() {
    const s = planStorey();
    if (!s) return frameBox.max.y - 0.5;
    const i = storeys.indexOf(s), nextLow = storeyLow[storeys[i + 1]];
    return Math.min(storeyLow[s] + PLAN_CUT, nextLow !== undefined ? nextLow - 0.05 : Infinity);
  }
  /** Inside view: fly to a high corner looking down into the cut floor, so its rooms can be read. */
  function lookInto() {
    const c = frameBox.getCenter(new THREE.Vector3()), size = frameBox.getSize(new THREE.Vector3());
    c.y = cut.constant - PLAN_CUT;
    const r = Math.hypot(size.x, size.z) / 2, d = fitDistance(r) * 0.95;
    const dir = new THREE.Vector3(0.45, 1.1, 0.6).normalize();
    flyTo(c.clone().addScaledVector(dir, d), c, 800);
  }
  function visible(x) {
    if (mode === "exterior" || mode === "walk") return x.ifcType !== "IfcSpace";
    return true;
  }
  function apply() {
    for (const e of elements) e.visible = visible(e.userData);
    if (mode === "interior") { cut.constant = cutHeight(); renderer.clippingPlanes = [cut]; ground.visible = true; }
    else renderer.clippingPlanes = [];
    drawLabels();
    redraw();
  }

  function drawLabels() {
    labels.replaceChildren();
    if (mode !== "interior") return;
    const top = cut.constant;
    for (const e of elements) {
      if (e.userData.ifcType !== "IfcSpace") continue;
      const b = e.geometry.boundingBox;
      if (b.min.y > top || b.max.y < top - 4 || (storey && e.userData.storey !== storey)) continue;
      const tag = document.createElement("span");
      tag.textContent = e.userData.name || "Room";
      tag._anchor = b.getCenter(new THREE.Vector3()); tag._anchor.y = b.min.y + 0.1;
      labels.append(tag);
    }
  }
  function placeLabels() {
    const w = host.clientWidth, h = host.clientHeight;
    for (const tag of labels.children) {
      const p = tag._anchor.clone().project(camera);
      tag.style.transform = `translate(-50%,-50%) translate(${(p.x + 1) / 2 * w}px, ${(1 - p.y) / 2 * h}px)`;
      tag.hidden = p.z > 1;
    }
  }

  // ---------------------------------------------------------------- pointer: look (walking), pick, double-click to fly
  renderer.domElement.addEventListener("pointerdown", e => {
    ptr.down = [e.clientX, e.clientY]; ptr.last = [e.clientX, e.clientY];
    if (mode === "walk") try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
    renderer.domElement.focus({ preventScroll: true });
  });
  renderer.domElement.addEventListener("pointermove", e => {
    if (mode !== "walk" || !ptr.last || !e.buttons) return;
    yaw -= (e.clientX - ptr.last[0]) * 0.0042;
    pitch = Math.max(-1.3, Math.min(1.3, pitch - (e.clientY - ptr.last[1]) * 0.0042));
    ptr.last = [e.clientX, e.clientY];
    aim();
  });
  const hitAt = e => {
    const r = renderer.domElement.getBoundingClientRect();
    ptr.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const top = mode === "interior" ? cut.constant : Infinity;
    return ray.intersectObjects(elements.filter(o => o.visible && o.userData.ifcType !== "IfcSpace"), false).find(h => h.point.y <= top + 1e-3);
  };
  renderer.domElement.addEventListener("pointerup", e => {
    const moved = !ptr.down || Math.hypot(e.clientX - ptr.down[0], e.clientY - ptr.down[1]) > 6;
    ptr.last = null;
    if (moved) return;
    const hit = hitAt(e);
    select(hit ? hit.object : null);
  });
  renderer.domElement.addEventListener("dblclick", e => {
    const hit = hitAt(e);
    if (!hit) return;
    if (mode === "walk") {   // walk to the spot (on a floor), or turn to face it
      if (hit.face && Math.abs(hit.face.normal.y) > 0.7 && hit.point.y < camera.position.y) { camera.position.set(hit.point.x, hit.point.y + EYE, hit.point.z); feet = hit.point.y; aim(); }
      return;
    }
    const dir = camera.position.clone().sub(controls.target);
    const dist = Math.max(2.5, dir.length() * 0.45);
    flyTo(hit.point.clone().addScaledVector(dir.normalize(), dist), hit.point.clone());
  });
  renderer.domElement.tabIndex = 0;
  const MOVE_KEYS = ["w", "a", "s", "d", "q", "e", "arrowup", "arrowdown", "arrowleft", "arrowright", "pageup", "pagedown", "shift"];
  renderer.domElement.addEventListener("keydown", e => {
    if (mode !== "walk") return;
    const k = e.key.toLowerCase();
    if (MOVE_KEYS.includes(k)) { keys.add(k); e.preventDefault(); }
  });
  renderer.domElement.addEventListener("keyup", e => keys.delete(e.key.toLowerCase()));
  renderer.domElement.addEventListener("blur", () => keys.clear());

  function forward() { return new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)); }
  function aim() { camera.lookAt(camera.position.clone().add(forward())); redraw(); }

  function rooms() {
    return elements.filter(e => e.userData.ifcType === "IfcSpace").map(e => {
      const b = new THREE.Box3().setFromObject(e);
      return { name: e.userData.name || "Room", storey: e.userData.storey || null, box: b };
    }).sort((a, b) => (storeys.indexOf(a.storey) - storeys.indexOf(b.storey)) || a.name.localeCompare(b.name));
  }

  function enterWalk() {
    mode = "walk"; controls.enabled = false; fly = null; hemi.intensity = 0.75;
    camera.fov = 70; camera.near = 0.05; camera.far = 3000; camera.updateProjectionMatrix();
    renderer.clippingPlanes = [];
  }
  function walkTo(which) {
    const all = rooms();
    // no room chosen: the main room of a typical floor (a living room if named so, else the largest)
    const main = () => {
      const s = planStorey(), on = all.filter(x => x.storey === s), list = on.length ? on : all;
      const area = x => (x.box.max.x - x.box.min.x) * (x.box.max.z - x.box.min.z) * (/living|lounge|sitting|family|salon|parlou?r/i.test(x.name) ? 3 : 1);
      return list.reduce((a, b) => (area(b) > area(a) ? b : a), list[0]);
    };
    const r = (typeof which === "number" ? all[which] : which ? all.find(x => x.name === which) : null) || main();
    enterWalk();
    if (!r) {      // no rooms in the file: start in the most open spot of a typical floor
      room = null;
      const y = storeys.length ? storeyLow[planStorey()] : groundY;
      const spot = openSpot(y);
      if (spot) { feet = spot.feet; camera.position.set(spot.x, feet + EYE, spot.z); yaw = spot.yaw; }
      else {
        const c = frameBox.getCenter(new THREE.Vector3());
        feet = floorBelow(new THREE.Vector3(c.x, y + 2.5, c.z), 4) ?? y; camera.position.set(c.x, feet + EYE, c.z); yaw = 0;
      }
      pitch = -0.05; apply(); aim(); return null;
    }
    room = r.name;
    const spot = openSpot(r.box.min.y, null, r.box);
    if (spot) {
      feet = spot.feet; camera.position.set(spot.x, feet + EYE, spot.z); yaw = spot.yaw; pitch = -0.06;
      apply(); aim(); return all.indexOf(r);
    }
    const c = r.box.getCenter(new THREE.Vector3()), size = r.box.getSize(new THREE.Vector3());
    // stand near one end of the room's longer side and look along it, so most of the room is in view
    const alongX = size.x >= size.z;
    yaw = alongX ? -Math.PI / 2 : 0;
    const back = alongX ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, 0, 1);
    feet = r.box.min.y;
    camera.position.set(c.x, feet + EYE, c.z).addScaledVector(back, (alongX ? size.x : size.z) * 0.32);
    pitch = -0.06;
    apply(); aim();
    return all.indexOf(r);
  }
  // the most open place to stand on a floor at height y: a grid of spots inside the building, each
  // scored by how far one can see around it at eye height; faces its longest view
  const DIRS = Array.from({ length: 12 }, (_, i) => { const a = i / 12 * Math.PI * 2; return { yaw: a, v: new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a)) }; });
  function openSpot(y, near0 = null, inBox = null) {
    const band = elements.filter(o => o.visible && o.userData.ifcType !== "IfcSpace" && o.geometry.boundingBox
      && (() => { const b = new THREE.Box3().setFromObject(o); return b.max.y > y + 0.2 && b.min.y < y + 2.6; })());
    const floors = elements.filter(o => o.visible && o.userData.ifcType !== "IfcSpace" && (() => { const b = new THREE.Box3().setFromObject(o); return b.max.y > y - 0.6 && b.min.y < y + 0.9; })());
    const b = inBox || frameBox, N = inBox ? 7 : 11, best = { score: -1 };
    const r = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x = near0 ? near0.x + (i - (N - 1) / 2) * 0.8 : b.min.x + (b.max.x - b.min.x) * (0.1 + 0.8 * i / (N - 1));
      const z = near0 ? near0.z + (j - (N - 1) / 2) * 0.8 : b.min.z + (b.max.z - b.min.z) * (0.1 + 0.8 * j / (N - 1));
      r.set(new THREE.Vector3(x, y + 1.2, z), down); r.far = 2;
      const f = r.intersectObjects(floors, false).find(h => h.face && Math.abs(h.face.normal.y) > 0.7);
      if (!f) continue;                     // no floor here (outside, or a void)
      const eye = new THREE.Vector3(x, f.point.y + 1.2, z);
      // how far one sees in each direction (windows count as the room's edge); faces the widest open view
      const dist = DIRS.map(d => { r.set(eye, d.v); r.far = 15; const h = r.intersectObjects(band, false)[0]; return h ? h.distance : 15; });
      const open = dist.filter(v => v >= 15).length, nearest = Math.min(...dist);
      if (nearest < 0.8 || open > 6) continue;   // against a wall, or outside the building
      let score = dist.reduce((s, v) => s + Math.min(v, 8), 0), far = -1, fy = 0;
      dist.forEach((v, k) => { const w = Math.min(v, 10) + 0.5 * (Math.min(dist[(k + 1) % 12], 10) + Math.min(dist[(k + 11) % 12], 10)); if (w > far) { far = w; fy = DIRS[k].yaw; } });
      if (near0) score -= Math.hypot(x - near0.x, z - near0.z) * 0.5;
      if (score > best.score) Object.assign(best, { score, x, z, feet: f.point.y, yaw: fy });
    }
    return best.score > 0 ? best : null;
  }
  /** Walking: up or down one floor, to the same spot on the next floor (or the nearest open one). */
  function changeFloor(step) {
    if (mode !== "walk" || !storeys.length) return false;
    let i = 0; storeys.forEach((s, k) => { if (storeyLow[s] <= feet + 0.3) i = k; });
    const j = Math.max(0, Math.min(storeys.length - 1, i + step));
    if (j === i) return false;
    const y = storeyLow[storeys[j]];
    const spot = openSpot(y, camera.position);
    if (spot) { camera.position.x = spot.x; camera.position.z = spot.z; feet = spot.feet; yaw = spot.yaw; pitch = -0.05; }
    else feet = floorBelow(new THREE.Vector3(camera.position.x, y + 1.2, camera.position.z), 2) ?? y;
    near = []; nearAt = 0;
    camera.position.y = feet + EYE; room = null; aim();
    return storeys[j];
  }

  function goTo(p, roomName = null) {
    if (p.mode === "walk") {
      enterWalk(); room = roomName;
      camera.fov = p.fov || 70; camera.updateProjectionMatrix();
      camera.position.fromArray(p.position); feet = camera.position.y - EYE;
      const d = new THREE.Vector3().fromArray(p.target).sub(camera.position).normalize();
      pitch = Math.asin(Math.max(-1, Math.min(1, d.y))); yaw = Math.atan2(-d.x, -d.z);
      apply(); aim();
    } else {
      if (mode === "walk") leaveWalk();
      camera.fov = p.fov || 45; camera.updateProjectionMatrix();
      camera.position.fromArray(p.position); controls.target.fromArray(p.target); controls.update(); redraw();
    }
  }

  function leaveWalk() {
    mode = "exterior"; room = null; keys.clear(); controls.enabled = true; hemi.intensity = 0.3;
    camera.fov = 45; camera.updateProjectionMatrix(); frameAll(); apply();
  }

  // floors underfoot and walls in front, checked against the parts near the walker only
  function nearby(now) {
    if (now - nearAt < 400) return near;
    nearAt = now;
    const p = camera.position, s = new THREE.Sphere();
    near = elements.filter(o => o.visible && o.userData.ifcType !== "IfcSpace" && o.userData.ifcType !== "IfcDoor" && o.userData.cls !== "glass" && o.geometry.boundingSphere
      && s.copy(o.geometry.boundingSphere).distanceToPoint(p) < 6);
    return near;
  }
  function floorBelow(from, depth) {
    ray.set(from, new THREE.Vector3(0, -1, 0)); ray.far = depth;
    const list = [...(near.length ? near : elements.filter(o => o.visible && o.userData.ifcType !== "IfcSpace")), ground];
    const hit = ray.intersectObjects(list, false).find(h => h.face && Math.abs(h.face.normal.y) > 0.3);   // a floor, a stair tread or the ground
    ray.far = Infinity;
    return hit ? hit.point.y : null;
  }
  function blocked(dirFlat, dist) {
    const list = near.filter(o => SOLID_FOR_WALKING.has(o.userData.ifcType));
    for (const h of [0.45, 1.2]) {   // knee and chest height
      ray.set(new THREE.Vector3(camera.position.x, feet + h, camera.position.z), dirFlat); ray.far = dist + RADIUS;
      if (ray.intersectObjects(list, false).length) { ray.far = Infinity; return true; }
    }
    ray.far = Infinity;
    return false;
  }
  function stepWalk(dt, now) {
    let f = hold.fwd, t = hold.turn, side = 0, up = hold.up;
    if (keys.has("w") || keys.has("arrowup")) f += 1;
    if (keys.has("s") || keys.has("arrowdown")) f -= 1;
    if (keys.has("arrowleft")) t += 1;
    if (keys.has("arrowright")) t -= 1;
    if (keys.has("a")) side -= 1;
    if (keys.has("d")) side += 1;
    if (keys.has("e") || keys.has("pageup")) up += 1;
    if (keys.has("q") || keys.has("pagedown")) up -= 1;
    if (!f && !t && !side && !up) return;
    nearby(now);
    const speed = SPEED * (keys.has("shift") ? 2.5 : 1);
    yaw += t * TURN * dt;
    const flat = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const move = flat.multiplyScalar(f).addScaledVector(right, side);
    if (move.lengthSq() > 0) {
      const dist = speed * dt * Math.min(1, move.length());
      move.normalize();
      if (!blocked(move, dist)) camera.position.addScaledVector(move, dist);
    }
    if (up) { feet += up * speed * dt; }
    else {   // follow the floor: up stairs a step at a time, down to the floor below
      const floor = floorBelow(new THREE.Vector3(camera.position.x, feet + STEP + 0.05, camera.position.z), STEP + 3);
      if (floor !== null) feet = feet + (floor - feet) * Math.min(1, dt * 12);
    }
    camera.position.y = feet + EYE;
    aim();
  }

  function select(obj) {
    if (selected?._look) { selected.material = selected._look; selected._look = null; }
    selected = obj;
    if (obj) { obj._look = obj.material; obj.material = obj.material.clone(); obj.material.emissive?.set("#5a0a0d"); }
    onSelect?.(obj ? obj.userData : null);
    redraw();
  }

  function draw(final) {
    if (final && !lowPower && !owner) composer.render();
    else renderer.render(scene, camera);
    if (final) finalDone = true;
  }
  // Draw only when something changed (camera moved, mode, selection, resize): saves battery on phones.
  // When the view stops, it is drawn once more with ambient occlusion.
  function tick() {
    frame = requestAnimationFrame(tick);
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (owner) return;   // the animation draws its own frames
    stepFly(now);
    if (mode === "walk") stepWalk(dt, now); else controls.update();
    if (dirty) {
      dirty = false; stillTimer = now;
      if (labels.children.length) placeLabels();
      draw(false);
    } else if (!finalDone && now - stillTimer > 220) {
      draw(true);
    }
  }
  resize();
  tick();

  return {
    load,
    setMode(m) {
      if (mode === "walk" && m !== "walk") leaveWalk();
      const was = mode; mode = m; apply();
      if (m === "interior" && was !== "interior") lookInto();
    },
    rooms() { return rooms().map((r, i) => ({ index: i, name: r.name, storey: r.storey })); },
    walkTo,
    leaveWalk,
    changeFloor,
    view,
    goTo,
    get room() { return room; },
    get mode() { return mode; },
    hold(fwd, turn, up = 0) { hold.fwd = fwd; hold.turn = turn; hold.up = up; redraw(); },
    pose() {
      const t = mode === "walk" ? camera.position.clone().add(forward()) : controls.target.clone();
      return { mode: mode === "walk" ? "walk" : "orbit", position: camera.position.toArray().map(v => +v.toFixed(3)), target: t.toArray().map(v => +v.toFixed(3)), fov: camera.fov };
    },
    setStorey(s) { storey = s || null; apply(); if (mode === "interior") lookInto(); },
    reset() { if (mode === "walk") leaveWalk(); frameAll(); redraw(); },
    /** The view as a picture, at full quality (with ambient occlusion). */
    snapshot() { draw(true); return renderer.domElement.toDataURL("image/png"); },
    dispose() { cancelAnimationFrame(frame); composer.dispose(); pmrem.dispose(); renderer.dispose(); host.replaceChildren(); },
    get storeys() { return storeys; },
    /** Hands the scene to the construction animation (on) or takes it back (off). */
    takeOver(on) {
      if (on) {
        if (mode === "walk") leaveWalk();
        owner = true; controls.enabled = false; labels.replaceChildren(); select(null); fly = null;
        renderer.clippingPlanes = []; sky.visible = false; scene.environment = null; hemi.intensity = 1.25;
        for (const e of elements) e.visible = e.userData.ifcType !== "IfcSpace";
      } else {
        owner = null; controls.enabled = true; mode = "exterior";
        sky.visible = true; scene.environment = env; hemi.intensity = 0.3; ground.material = groundLook; ground.material.opacity = 1;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        camera.fov = 45; resize(); frameAll(); apply();
      }
    },
    engine() { return { THREE, scene, camera, renderer, elements, storeys, sun, hemi, ground, groundY, frame: frameBox.clone(), host, render: () => renderer.render(scene, camera), resize }; },
  };
}
