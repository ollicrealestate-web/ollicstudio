// 3D viewer for architects' IFC models: orbit outside, inside with the roof off, and a
// first-person walkthrough room by room. Saved views become render and video shots.
// Loads the GLB made by the server: one node per element, named by its IFC GlobalId,
// with { globalId, ifcType, name, storey, family } in its extras.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const ROOFISH = new Set(["IfcRoof", "IfcCovering"]);

export function createViewer(host, { onSelect } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#c9d3dc");
  scene.fog = new THREE.Fog("#c9d3dc", 80, 260);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;

  const hemi = new THREE.HemisphereLight("#eef3ff", "#6b6256", 1.25);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight("#fff4e0", 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1536, 1536);
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 64), new THREE.MeshStandardMaterial({ color: "#8f9a7a", roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);

  const labels = document.createElement("div");
  labels.className = "viewer-labels";
  host.append(labels);

  let model = null, elements = [], storeys = [], mode = "exterior", storey = null, selected = null, frame = 0, dirty = true;
  let owner = null;       // the construction animation, while it drives the camera and the scene
  let frameBox = new THREE.Box3();   // the building, without a large plot around it
  let groundY = 0;        // finished ground level: the bottom of the lowest storey's walls, not of its footings
  // walkthrough: eye height, look direction and movement
  const EYE = 1.6, SPEED = 1.4, TURN = 1.6;
  let yaw = 0, pitch = 0, room = null, last = performance.now();
  const keys = new Set(), hold = { fwd: 0, turn: 0 };
  const redraw = () => { dirty = true; };
  controls.addEventListener("change", redraw);
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();

  function resize() {
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  }
  new ResizeObserver(resize).observe(host);

  async function load(url) {
    const gltf = await new GLTFLoader().loadAsync(url);
    if (model) scene.remove(model);
    model = gltf.scene;
    elements = [];
    model.traverse(o => {
      if (!o.isMesh) return;
      // 3D files from Ollic leave normals out (each triangle has its own corners), so they are made here
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      const x = { ...(o.parent?.userData || {}), ...(o.userData || {}) };
      o.userData = x;
      o.castShadow = x.ifcType !== "IfcSpace" && x.ifcType !== "IfcWindow";
      o.receiveShadow = true;
      if (o.material) o.material.side = THREE.DoubleSide;
      elements.push(o);
    });
    scene.add(model);
    // storeys from bottom to top, by the lowest point of their elements
    const lows = {};
    for (const e of elements) {
      const s = e.userData.storey; if (!s) continue;
      const y = new THREE.Box3().setFromObject(e).min.y;
      lows[s] = Math.min(lows[s] ?? Infinity, y);
    }
    storeys = Object.keys(lows).sort((a, b) => lows[a] - lows[b]);
    const BELOW = new Set(["IfcFooting", "IfcPile", "IfcSpace"]);
    const first = elements.filter(e => !BELOW.has(e.userData.ifcType) && !(e.userData.ifcType === "IfcSlab" && e.userData.predefined === "BASESLAB")
      && (!storeys.length || e.userData.storey === storeys[0]));
    groundY = first.length ? Math.min(...first.map(e => new THREE.Box3().setFromObject(e).min.y)) : new THREE.Box3().setFromObject(model).min.y;
    ground.position.y = groundY - 0.02;
    frameBox = buildingBox(elements);
    frameAll();
    apply();
    dirty = true;
    return { storeys, count: elements.length };
  }

  /** The building itself, for placing the camera: models often include the whole plot (paving,
   * ground slabs, boundary walls), many times larger than the building. Parts much bigger than the
   * building's core are left out of the frame (they are still shown). */
  function buildingBox(list) {
    let boxes = list.filter(e => e.userData.ifcType !== "IfcSpace").map(e => new THREE.Box3().setFromObject(e)).filter(b => !b.isEmpty());
    const all = new THREE.Box3(); boxes.forEach(b => all.union(b));
    if (boxes.length < 12) return all;
    // the plot: low parts at ground level (paving, kerbs, boundary walls, landscaping) are not the building
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
    keep.min.y = Math.min(keep.min.y, all.min.y);   // the frame still stands on the ground
    return keep;
  }

  function frameAll() {
    const box = frameBox.clone();
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const radius = size.length() / 2;
    // fit the whole building in whichever field of view is narrower (portrait phones: the horizontal one)
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const d = radius / Math.sin(Math.min(vfov, hfov) / 2) * 0.92;
    const dir = new THREE.Vector3(0.62, 0.48, 0.62).normalize();
    controls.target.copy(c);
    camera.position.copy(c).addScaledVector(dir, d);
    camera.near = Math.max(0.05, d / 200); camera.far = d * 40; camera.updateProjectionMatrix();
    const r = Math.max(size.x, size.z, size.y);
    sun.position.set(c.x + r * 1.2, c.y + r * 2, c.z + r * 0.6);
    sun.target.position.copy(c);
    const s = r * 1.2;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 0.1, far: r * 6 });
    sun.shadow.camera.updateProjectionMatrix();
    controls.update();
  }

  function visible(x) {
    if (mode === "exterior" || mode === "walk") return x.ifcType !== "IfcSpace";
    // interior: the roof comes off, storeys above the chosen one are hidden, rooms are tinted
    if (ROOFISH.has(x.ifcType)) return false;
    if (storey && x.storey) return storeys.indexOf(x.storey) <= storeys.indexOf(storey);
    return true;
  }

  function apply() {
    for (const e of elements) e.visible = visible(e.userData);
    drawLabels();
    dirty = true;
  }

  function drawLabels() {
    labels.replaceChildren();
    if (mode !== "interior") return;
    for (const e of elements) {
      if (e.userData.ifcType !== "IfcSpace" || !e.visible) continue;
      if (storey && e.userData.storey !== storey) continue;
      const tag = document.createElement("span");
      tag.textContent = e.userData.name || "Room";
      tag._anchor = new THREE.Box3().setFromObject(e).getCenter(new THREE.Vector3());
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

  renderer.domElement.addEventListener("pointerdown", e => {
    ptr.down = [e.clientX, e.clientY]; ptr.last = [e.clientX, e.clientY];
    if (mode === "walk") try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
  });
  renderer.domElement.addEventListener("pointermove", e => {
    if (mode !== "walk" || !ptr.last || !e.buttons) return;
    yaw -= (e.clientX - ptr.last[0]) * 0.004;
    pitch = Math.max(-1.2, Math.min(1.2, pitch - (e.clientY - ptr.last[1]) * 0.004));
    ptr.last = [e.clientX, e.clientY];
    aim();
  });
  renderer.domElement.addEventListener("pointerup", () => { ptr.last = null; });
  renderer.domElement.tabIndex = 0;
  renderer.domElement.addEventListener("keydown", e => {
    if (mode !== "walk") return;
    const k = e.key.toLowerCase();
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) { keys.add(k); e.preventDefault(); }
  });
  renderer.domElement.addEventListener("keyup", e => keys.delete(e.key.toLowerCase()));
  renderer.domElement.addEventListener("blur", () => keys.clear());

  function forward() { return new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)); }
  function aim() { camera.lookAt(camera.position.clone().add(forward())); dirty = true; }

  function rooms() {
    return elements.filter(e => e.userData.ifcType === "IfcSpace").map(e => {
      const b = new THREE.Box3().setFromObject(e);
      return { name: e.userData.name || "Room", storey: e.userData.storey || null, box: b };
    }).sort((a, b) => (storeys.indexOf(a.storey) - storeys.indexOf(b.storey)) || a.name.localeCompare(b.name));
  }

  function walkTo(which) {
    const all = rooms();
    const r = (typeof which === "number" ? all[which] : all.find(x => x.name === which)) || all[0];
    if (!r) return false;
    room = r.name;
    mode = "walk"; controls.enabled = false; scene.fog = null; hemi.intensity = 2.1;
    camera.fov = 70; camera.near = 0.05; camera.far = 600; camera.updateProjectionMatrix();
    const c = r.box.getCenter(new THREE.Vector3()), size = r.box.getSize(new THREE.Vector3());
    // stand near one end of the room's longer side and look along it, so most of the room is in view
    const alongX = size.x >= size.z;
    yaw = alongX ? -Math.PI / 2 : 0;          // facing +x, or facing -z
    const back = alongX ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, 0, 1);
    camera.position.set(c.x, r.box.min.y + EYE, c.z).addScaledVector(back, (alongX ? size.x : size.z) * 0.32);
    pitch = -0.06;
    apply(); aim();
    return true;
  }

  function goTo(p, roomName = null) {
    if (p.mode === "walk") {
      mode = "walk"; room = roomName; controls.enabled = false; scene.fog = null; hemi.intensity = 2.1;
      camera.fov = p.fov || 70; camera.near = 0.05; camera.far = 600; camera.updateProjectionMatrix();
      camera.position.fromArray(p.position);
      const d = new THREE.Vector3().fromArray(p.target).sub(camera.position).normalize();
      pitch = Math.asin(Math.max(-1, Math.min(1, d.y))); yaw = Math.atan2(-d.x, -d.z);
      apply(); aim();
    } else {
      if (mode === "walk") leaveWalk();
      camera.fov = p.fov || 45; camera.updateProjectionMatrix();
      camera.position.fromArray(p.position); controls.target.fromArray(p.target); controls.update(); dirty = true;
    }
  }

  function leaveWalk() {
    mode = "exterior"; room = null; keys.clear(); controls.enabled = true; scene.fog = new THREE.Fog("#c9d3dc", 80, 260); hemi.intensity = 1.25;
    camera.fov = 45; camera.updateProjectionMatrix(); frameAll(); apply();
  }

  function stepWalk(dt) {
    let f = hold.fwd, t = hold.turn, side = 0;
    if (keys.has("w") || keys.has("arrowup")) f += 1;
    if (keys.has("s") || keys.has("arrowdown")) f -= 1;
    if (keys.has("arrowleft")) t += 1;
    if (keys.has("arrowright")) t -= 1;
    if (keys.has("a")) side -= 1;
    if (keys.has("d")) side += 1;
    if (!f && !t && !side) return;
    yaw += t * TURN * dt;
    const flat = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    camera.position.addScaledVector(flat, f * SPEED * dt).addScaledVector(right, side * SPEED * dt);
    aim();
  }
  renderer.domElement.addEventListener("pointerup", e => {
    if (!ptr.down || Math.hypot(e.clientX - ptr.down[0], e.clientY - ptr.down[1]) > 6) return;
    const r = renderer.domElement.getBoundingClientRect();
    ptr.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const hit = ray.intersectObjects(elements.filter(o => o.visible && o.userData.ifcType !== "IfcSpace"), false)[0];
    select(hit ? hit.object : null);
  });

  function select(obj) {
    if (selected) { selected.material.emissive?.set("#000000"); }
    selected = obj;
    if (obj) { obj.material = obj.material.clone(); obj.material.emissive?.set("#5a0a0d"); }
    onSelect?.(obj ? obj.userData : null);
    dirty = true;
  }

  // Draw only when something changed (camera moved, mode, selection, resize): saves battery on phones.
  function tick() {
    frame = requestAnimationFrame(tick);
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (owner) return;   // the animation draws its own frames
    if (mode === "walk") stepWalk(dt); else controls.update();
    if (!dirty) return;
    dirty = false;
    if (labels.children.length) placeLabels();
    renderer.render(scene, camera);
  }
  resize();
  tick();

  return {
    load,
    setMode(m) { if (mode === "walk" && m !== "walk") leaveWalk(); mode = m; apply(); },
    rooms() { return rooms().map((r, i) => ({ index: i, name: r.name, storey: r.storey })); },
    walkTo,
    leaveWalk,
    goTo,
    get room() { return room; },
    get mode() { return mode; },
    hold(fwd, turn) { hold.fwd = fwd; hold.turn = turn; dirty = true; },
    pose() {
      const t = mode === "walk" ? camera.position.clone().add(forward()) : controls.target.clone();
      return { mode: mode === "walk" ? "walk" : "orbit", position: camera.position.toArray().map(v => +v.toFixed(3)), target: t.toArray().map(v => +v.toFixed(3)), fov: camera.fov };
    },
    setStorey(s) { storey = s || null; apply(); },
    reset() { frameAll(); dirty = true; },
    snapshot() { renderer.render(scene, camera); return renderer.domElement.toDataURL("image/png"); },
    dispose() { cancelAnimationFrame(frame); renderer.dispose(); host.replaceChildren(); },
    get storeys() { return storeys; },
    /** Hands the scene to the construction animation (on) or takes it back (off). */
    takeOver(on) {
      if (on) {
        if (mode === "walk") leaveWalk();
        owner = true; controls.enabled = false; labels.replaceChildren(); select(null);
        for (const e of elements) e.visible = e.userData.ifcType !== "IfcSpace";
      } else {
        owner = null; controls.enabled = true; mode = "exterior";
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        camera.fov = 45; resize(); frameAll(); apply();
      }
    },
    engine() { return { THREE, scene, camera, renderer, elements, storeys, sun, hemi, ground, groundY, frame: frameBox.clone(), host, render: () => renderer.render(scene, camera), resize }; },
  };
}
