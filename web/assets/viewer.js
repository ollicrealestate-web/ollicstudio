// 3D viewer for imported and generated building models (Phase 3).
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

  scene.add(new THREE.HemisphereLight("#eef3ff", "#6b6256", 1.25));
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

  let model = null, elements = [], storeys = [], mode = "exterior", storey = null, selected = null, frame = 0;
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();

  function resize() {
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
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
    frameAll();
    apply();
    return { storeys, count: elements.length };
  }

  function frameAll() {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const r = Math.max(size.x, size.z, size.y * 1.4) * 0.78;
    controls.target.copy(c);
    camera.position.set(c.x + r * 1.15, c.y + r * 0.75, c.z + r * 1.35);
    camera.near = r / 200; camera.far = r * 40; camera.updateProjectionMatrix();
    sun.position.set(c.x + r * 1.2, c.y + r * 2, c.z + r * 0.6);
    sun.target.position.copy(c);
    const s = r * 1.2;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 0.1, far: r * 6 });
    sun.shadow.camera.updateProjectionMatrix();
    controls.update();
  }

  function visible(x) {
    if (mode === "exterior") return x.ifcType !== "IfcSpace";
    // interior: the roof comes off, storeys above the chosen one are hidden, rooms are tinted
    if (ROOFISH.has(x.ifcType)) return false;
    if (storey && x.storey) return storeys.indexOf(x.storey) <= storeys.indexOf(storey);
    return true;
  }

  function apply() {
    for (const e of elements) e.visible = visible(e.userData);
    drawLabels();
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

  renderer.domElement.addEventListener("pointerdown", e => { ptr.down = [e.clientX, e.clientY]; });
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
  }

  function tick() {
    frame = requestAnimationFrame(tick);
    controls.update();
    if (labels.children.length) placeLabels();
    renderer.render(scene, camera);
  }
  resize();
  tick();

  return {
    load,
    setMode(m) { mode = m; apply(); },
    setStorey(s) { storey = s || null; apply(); },
    reset() { frameAll(); },
    snapshot() { renderer.render(scene, camera); return renderer.domElement.toDataURL("image/png"); },
    dispose() { cancelAnimationFrame(frame); renderer.dispose(); host.replaceChildren(); },
    get storeys() { return storeys; },
  };
}
