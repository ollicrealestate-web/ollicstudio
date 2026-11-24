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
import { TAARenderPass } from "three/addons/postprocessing/TAARenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { addUVs, grassTexture, guessClass, lookFor } from "./looks.js";
import { matchMaterial } from "./materials/match.js";
import { materialById } from "./materials/library.js";
import { materialLook, addMetricUVs, setupLooks, loadSources, findMaterial, averageColour } from "./materials/look.js";
import { PLACES, PRESETS, sunAngles, momentAt, afternoonAt, sunVector, sunLight } from "./materials/light.js";
import { solve, forOutput, anglesOf, presetSettings, SHAPES, PRESETS as CAMERAS, describe as describeCamera } from "./camera.js";

/**
 * A camera whose picture can slide (an architect's shift lens): the camera stays level, so vertical lines stay
 * straight, and the picture moves up, down or sideways. shift: [across, up] as fractions of the picture.
 * Everything that draws (the view, every guide, Photo mode, the films, picking) reads the same projection.
 */
class ShiftCamera extends THREE.PerspectiveCamera {
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
}

const PLAN_CUT = 1.3;                 // the section cut: 1.3 m above a floor, as on a floor plan
const SOLID_FOR_WALKING = new Set(["IfcWall", "IfcWallStandardCase", "IfcColumn", "IfcCurtainWall", "IfcRailing", "IfcWindow", "IfcPlate", "IfcMember", "IfcBuildingElementProxy", "IfcStair", "IfcStairFlight", "IfcFurnishingElement", "IfcFurniture"]);
const lowPower = matchMedia("(pointer: coarse)").matches || (navigator.hardwareConcurrency || 8) <= 4;

export function createViewer(host, { onSelect } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // how fine the materials are: phones start at Fast (colour only), laptops at High (relief, roughness, shade)
  let quality = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || "") ? "fast" : "high";
  setupLooks({ maxAnisotropy: renderer.capabilities.getMaxAnisotropy() });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.72;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#c9d3dc");
  const camera = new ShiftCamera(45, 1, 0.1, 1000);
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
  // the classic light: kept exactly for the guides the AI renders are checked against (clay) and the construction film
  const SUN_AZ = 0.65, SUN_EL = 0.72;
  const classicDir = new THREE.Vector3(Math.cos(SUN_EL) * Math.cos(SUN_AZ), Math.sin(SUN_EL), Math.cos(SUN_EL) * Math.sin(SUN_AZ));
  const sunDir = classicDir.clone();
  sky.material.uniforms.sunPosition.value.copy(sunDir);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const skyScene = new THREE.Scene(); const skyCopy = new Sky(); skyCopy.scale.setScalar(4500); skyCopy.material = sky.material; skyScene.add(skyCopy);
  const classicEnv = pmrem.fromScene(skyScene, 0.02).texture;
  let env = classicEnv;
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
  addMetricUVs(ground.geometry);
  // the site around the building (paving, from the library), shown in the realistic view only
  const site = new THREE.Group(); scene.add(site);

  // ambient occlusion, drawn when the view has been still for a moment
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  const plainPass = new RenderPass(scene, camera), taa = new TAARenderPass(scene, camera);
  taa.sampleLevel = 0; taa.accumulate = true; taa.enabled = false;   // Best: the still view refines, 32 jittered samples
  composer.addPass(plainPass); composer.addPass(taa);
  const ao = new GTAOPass(scene, camera, 1, 1);
  ao.output = GTAOPass.OUTPUT.Default; ao.blendIntensity = 0.9;
  composer.addPass(ao);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.4, 0.92); bloom.enabled = false;   // lights at dusk
  composer.addPass(bloom);
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
  const offTextures = setupLooks({ redraw });   // a texture that arrives redraws the view

  // ---------------------------------------------------------------- light: sky, sun, place, date and time
  const today = new Date(Date.now() + 3600000).toISOString().slice(0, 10);   // the date in Lagos
  const light = { preset: "sunny", place: "lagos", day: today, minutes: null, exposure: 0, ground: "mt-grass", apron: "mt-paving-interlock", apronWidth: 2.5 };
  let classicOn = false, envTimer = 0, probe = null;
  const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
  const cubeCam = new THREE.CubeCamera(0.3, 3000, cubeRT);
  const lightDir = new THREE.Vector3();
  /** The light now: the sky, and where the sun is for the place, date and time (a sky's own time if none is set). */
  function lightNow() {
    const P = PRESETS[light.preset] || PRESETS.sunny, place = PLACES[light.place] || PLACES.lagos;
    const minutes = light.minutes ?? (P.elevation != null ? afternoonAt(place, light.day, P.elevation) : P.time);
    return { P, place, minutes, ...sunAngles(place.lat, place.lon, momentAt(place, light.day, minutes)) };
  }
  function applyHemi() {
    if (classicOn) { hemi.intensity = mode === "walk" ? 0.75 : 0.3; return; }
    const P = PRESETS[light.preset] || PRESETS.sunny;
    hemi.intensity = P.hemi.intensity * (mode === "walk" ? 2.2 : 1);
  }
  function applyLight({ envNow = false } = {}) {
    if (classicOn) return;
    const { P, el, az } = lightNow();
    const u = sky.material.uniforms;
    u.turbidity.value = P.sky.turbidity; u.rayleigh.value = P.sky.rayleigh; u.mieCoefficient.value = P.sky.mie; u.mieDirectionalG.value = P.sky.g;
    u.sunPosition.value.set(...sunVector(el, az));
    // the sun's light comes from at least 3 degrees up (below that it no longer lights the walls)
    sunDir.set(...sunVector(Math.max(el, 3 * Math.PI / 180), az)).normalize();
    const sl = sunLight(P, el);
    sun.color.set(P.sun.color).lerp(new THREE.Color("#ff9450"), sl.warm * 0.45);
    sun.intensity = sl.intensity; sun.castShadow = sl.intensity > 0.05;
    hemi.color.set(P.hemi.sky); hemi.groundColor.set(P.hemi.ground); applyHemi();
    scene.environmentIntensity = P.env;
    renderer.toneMappingExposure = P.exposure * 2 ** light.exposure;
    sun.shadow.radius = P.shadow;
    if (P.flatSky) { sky.visible = false; scene.background = new THREE.Color(P.flatSky); } else { sky.visible = true; scene.background = new THREE.Color("#c9d3dc"); }
    bloom.enabled = !!P.lightsOn && quality !== "fast";
    for (const e of elements) if (e.material?.userData?.lib && e.material.emissiveIntensity) e.material.emissiveIntensity = P.lightsOn ? 3 : 1.2;
    if (sunAt) placeSun(sunAt.c, sunAt.r);
    clearTimeout(envTimer);
    if (envNow) refreshEnv(); else envTimer = setTimeout(refreshEnv, 150);
    redraw();
  }
  /**
   * Reflections: the site as seen from beside the building (sky, ground, paving; the building itself left out),
   * captured once for the light and used by glass, metal and polished surfaces.
   */
  function refreshEnv() {
    if (classicOn) return;
    const c = frameBox.isEmpty() ? new THREE.Vector3() : frameBox.getCenter(new THREE.Vector3());
    const wasModel = model?.visible, wasEnv = scene.environment, clip = renderer.clippingPlanes;
    if (model) model.visible = false;
    if (edgesGroup) edgesGroup.visible = false;
    scene.environment = null; renderer.clippingPlanes = [];
    cubeCam.position.set(c.x, groundY + 1.6, c.z);
    cubeCam.update(renderer, scene);
    if (model) model.visible = wasModel;
    renderer.clippingPlanes = clip;
    const next = pmrem.fromCubemap(cubeRT.texture);
    if (probe) probe.dispose();
    probe = next; env = next.texture;
    scene.environment = classicOn ? wasEnv : env;
    redraw();
  }
  /** The classic light on (guides, construction film) or back to the chosen light. */
  function classicLight(on) {
    if (on === classicOn) return;
    classicOn = on;
    if (on) {
      sunDir.copy(classicDir);
      const u = sky.material.uniforms;
      u.turbidity.value = 2.2; u.rayleigh.value = 3.2; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.82; u.sunPosition.value.copy(classicDir);
      sun.color.set("#ffeacc"); sun.intensity = 3.4; sun.castShadow = true; sun.shadow.radius = 3;
      hemi.color.set("#dfe9ff"); hemi.groundColor.set("#4a4436"); applyHemi();
      scene.environmentIntensity = 0.55; renderer.toneMappingExposure = 0.72;
      env = classicEnv; scene.environment = classicEnv; sky.visible = true; scene.background = new THREE.Color("#c9d3dc");
      setShadowSize(lowPower ? 2048 : 4096);
      site.visible = false; ground.material = groundLook;
      for (const e of elements) e.castShadow = e.userData.shadowClassic;
      if (sunAt) placeSun(sunAt.c, sunAt.r);
    } else {
      setShadowSize(shadowSizeFor(quality));
      site.visible = true; ground.material = realGround();
      for (const e of elements) e.castShadow = e.userData.shadowReal;
      applyLight({ envNow: true });
    }
  }
  function setShadowSize(n) {
    if (sun.shadow.mapSize.x === n) return;
    sun.shadow.mapSize.set(n, n); sun.shadow.map?.dispose(); sun.shadow.map = null;
  }
  const shadowSizeFor = q => (q === "fast" ? 1024 : q === "best" ? 4096 : lowPower ? 2048 : 4096);
  let groundMat = null;
  function realGround() {
    groundMat = materialLook(light.ground, { quality }) || groundLook;
    return groundMat;
  }
  /** The paving around the building: a band of the chosen material, under the building's footprint and around it. */
  function buildSite() {
    site.children.forEach(c => c.geometry.dispose()); site.clear();
    if (frameBox.isEmpty() || !light.apron || !(light.apronWidth > 0)) return;
    const w = light.apronWidth, b = frameBox;
    const g = new THREE.PlaneGeometry(b.max.x - b.min.x + 2 * w, b.max.z - b.min.z + 2 * w);
    g.rotateX(-Math.PI / 2); g.translate((b.min.x + b.max.x) / 2, groundY - 0.008, (b.min.z + b.max.z) / 2);
    addMetricUVs(g);
    const m = new THREE.Mesh(g, materialLook(light.apron, { quality }));
    m.receiveShadow = true; m.userData.site = true;
    site.add(m); site.visible = !classicOn;
  }
  controls.addEventListener("change", redraw);
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();

  function resize() {
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    composer.setSize(w, h); ao.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
    applyOutput(w / h);
    drawFrame();
    redraw();
  }
  new ResizeObserver(resize).observe(host);

  async function load(url) {
    await loadSources();
    const gltf = await new GLTFLoader().loadAsync(url);
    if (model) scene.remove(model);
    if (edgesGroup) { scene.remove(edgesGroup); edgesGroup.children.forEach(l => l.geometry.dispose()); edgesGroup = null; }
    model = gltf.scene;
    elements = []; undoStack = []; redoStack = [];
    model.traverse(o => {
      if (!o.isMesh) return;
      const single = !!o.userData?.globalId;   // an element with one part is itself the mesh
      const x = { ...(o.parent?.userData || {}), ...(o.userData || {}) };
      o.userData = x;
      // older 3D files from Ollic leave normals out (each triangle has its own corners), so they are made here
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      const src = o.material, named = /^ollic:(\w+)/.exec(src?.name || "");
      const opacity = src?.opacity ?? 1, srcColor = src?.color || new THREE.Color("#cccccc");
      // which library material this part is: from the IFC's material names, else its class and colour
      const srgb = srcColor.clone().convertLinearToSRGB();
      const mat = matchMaterial({ name: src?.userData?.ifcName, names: x.materials || [], ollic: x.ollicMaterial, cls: named ? named[1] : guessClass(x.ifcType, opacity),
        rgba: [srgb.r, srgb.g, srgb.b, opacity], parts: o.parent?.children?.filter(c => c.isMesh).length || 1 });
      // the class stays the reader's own: the guides for AI renders (material map) are drawn from it and must not change
      const cls = named ? named[1] : guessClass(x.ifcType, opacity);
      o.userData.mat = mat;
      // the realistic look: the library material at its real size (texture coordinates in metres on every face)
      const lib = cls === "space" ? null : materialById(mat.id);
      o.userData.lookOpts = { tint: mat.tint, opacity: opacity < 0.99 ? opacity : null };
      o.userData.part = single ? 0 : (o.parent?.children || [o]).filter(c => c.isMesh).indexOf(o);
      o.userData.parts = single ? 1 : (o.parent?.children || [o]).filter(c => c.isMesh).length;
      let look = lib && materialLook(mat.id, { ...o.userData.lookOpts, quality });
      if (look) addMetricUVs(o.geometry);
      else { look = lookFor(cls, srcColor, opacity); if (look.userData.metres && !o.geometry.attributes.uv) addUVs(o.geometry, look.userData.metres); }
      o.material = look;
      o.userData.cls = cls;
      o.userData.srcHex = "#" + (src?.color || new THREE.Color("#cccccc")).getHexString();   // the colour the architect gave it
      const seen = lib?.cls || cls;
      o.userData.shadowClassic = cls !== "glass" && cls !== "space";
      o.userData.shadowReal = seen !== "glass" && cls !== "space";
      o.castShadow = classicOn ? o.userData.shadowClassic : o.userData.shadowReal;
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
    pic = null; camSet = null; camera.shift = [0, 0];
    frameAll();
    detectFront(); placeArrow(); drawFrame();
    buildSite();
    if (!classicOn) { ground.material = realGround(); applyLight({ envNow: true }); }
    apply();
    redraw();
    return { storeys, count: elements.length };
  }

  /** The building itself, for placing the camera: models often include the whole plot (paving,
   * ground slabs, boundary walls), many times larger than the building. Parts much bigger than the
   * building's core are left out of the pic (they are still shown). */
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
  let sunAt = null;
  function placeSun(c, r) {
    sunAt = { c: c.clone(), r };
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
    if (frontPick && hit) { const f = frontPick; frontPick = null; f(hit); return; }
    select(hit ? hit.object : null, hit);
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
    if (!interiorSetting) { pic = null; camSet = null; camera.shift = [0, 0]; drawFrame(); }
    mode = "walk"; controls.enabled = false; fly = null; applyHemi();
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
    // only the parts at this floor's height and (in a room, or near a spot) within reach of the rays
    const reach = inBox ? inBox.clone().expandByVector(new THREE.Vector3(15, 0, 15)) : near0 ? new THREE.Box3().setFromCenterAndSize(near0, new THREE.Vector3(40, 1e4, 40)) : null;
    const band = [], floors = [], wb = new THREE.Box3();
    for (const o of elements) {
      if (!o.visible || o.userData.ifcType === "IfcSpace") continue;
      wb.setFromObject(o);
      if (reach && (wb.max.x < reach.min.x || wb.min.x > reach.max.x || wb.max.z < reach.min.z || wb.min.z > reach.max.z)) continue;
      if (wb.max.y > y + 0.2 && wb.min.y < y + 2.6) band.push(o);
      if (wb.max.y > y - 0.6 && wb.min.y < y + 0.9) floors.push(o);
    }
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
    mode = "exterior"; room = null; keys.clear(); controls.enabled = true; applyHemi();
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

  /** A copy of a look with the selection's red glow (keeping its tiles and texture touches). */
  function glowing(m) {
    const c = m.clone();
    if (m.onBeforeCompile) { c.onBeforeCompile = m.onBeforeCompile; c.customProgramCacheKey = m.customProgramCacheKey; }
    c.userData = m.userData; c.emissive?.set("#5a0a0d"); if (c.emissiveIntensity === 0) c.emissiveIntensity = 1;
    return c;
  }
  function select(obj, hit = null) {
    if (selected?._look) { selected.material = selected._look; selected._look = null; }
    selected = obj;
    if (obj) { obj._look = obj.material; obj.material = glowing(obj.material); }
    onSelect?.(obj ? obj.userData : null, obj ? { key: partKey(obj), normal: hit?.face ? hit.face.normal.clone().transformDirection(obj.matrixWorld).toArray() : null } : null);
    redraw();
  }
  /** Puts a look on a part (keeping the selection glow if it is selected). */
  function setLook(o, m) {
    if (o._look) { o._look = m; o.material = glowing(m); } else o.material = m;
  }

  // ---------------------------------------------------------------- camera angles (see camera.js)
  // frame: the set picture (its shape, its angle of view up and down, its shift), or null for the free 3D view.
  // camSet: the settings it came from (a ready-made angle, or the architect's own numbers).
  let pic = null, camSet = null, front = [0, 1], frontFrom = "guessed", entrance = null, frontPick = null, interiorSetting = false, onFront = null;
  let frameGuides = { thirds: false, centre: false, horizon: false, safe: false };
  /** The camera drawn into a picture of the given shape (the canvas, or a guide): the set picture fits inside it. */
  function applyOutput(outAspect) {
    camera.aspect = outAspect;
    // a set picture may be level (eye level: the camera looks straight across) or look up (a low hero angle)
    controls.maxPolarAngle = pic ? Math.PI * 0.8 : Math.PI * 0.495;
    if (pic) {
      const h = 2 * Math.atan(Math.tan(pic.v * Math.PI / 360) * pic.aspect) * 180 / Math.PI;
      const o = forOutput({ aspect: pic.aspect, v: pic.v, h, shift: pic.shift }, outAspect);
      camera.fov = o.v; camera.shift = [...o.shift];
    } else camera.shift = [0, 0];
    camera.updateProjectionMatrix();
  }
  const buildingHeight = () => (frameBox.isEmpty() ? 10 : Math.max(3, frameBox.max.y - groundY));
  const shapeOf = s => SHAPES[s?.aspect] || (typeof s?.aspect === "number" ? s.aspect : 1.5);
  /** Sets the camera from settings (a ready-made angle and any changes): the view moves there at once. */
  function setCamera(settings) {
    if (frameBox.isEmpty()) return null;
    const base = settings.preset && !settings.custom ? presetSettings(settings.preset, buildingHeight()) : {};
    const st = { aspect: "3:2", ...base, ...settings };
    if (st.interior) return interiorCamera(st);
    if (mode === "walk") leaveWalk();
    fly = null;
    const c = solve(st, { box: { min: frameBox.min.toArray(), max: frameBox.max.toArray() }, ground: groundY, front, aspect: shapeOf(st), entrance });
    camSet = st;
    pic = { aspect: shapeOf(st), v: c.v, shift: c.shift };
    camera.up.set(0, 1, 0);
    if (c.plan) camera.up.set(...(c.up || [0, 0, -1]));
    camera.position.fromArray(c.position); controls.target.fromArray(c.target);
    camera.near = Math.max(0.05, Math.min(0.5, c.distance / 300)); camera.far = Math.max(5000, c.distance * 40);
    applyOutput(host.clientWidth / Math.max(1, host.clientHeight));
    camera.lookAt(controls.target); controls.update();
    drawFrame(); redraw();
    return cameraInfo(c);
  }
  function cameraInfo(c = null) {
    const a = pic ? anglesOf(camSet?.lens || 35, pic.aspect) : null;
    return { settings: camSet ? { ...camSet } : null, aspect: pic?.aspect || null, angles: a, shift: pic ? [...pic.shift] : [0, 0], front: [...front], frontFrom,
      buildingHeight: +buildingHeight().toFixed(2), height: +(camera.position.y - groundY).toFixed(3), distance: c ? +c.distance.toFixed(2) : null,
      words: camSet ? describeCamera(camSet, buildingHeight()) : null };
  }
  /** Inside: one-point (square to the walls) or two-point (45 degrees), level, at the set height, with the set lens. */
  function interiorCamera(st) {
    interiorSetting = true;
    try { if (mode !== "walk") { const r = enterWalk(); if (r && r.error) return { error: r.error }; } }
    finally { interiorSetting = false; }
    const f = Math.atan2(-front[0], -front[1]);           // the yaw that looks toward the back (across the house)
    const snap = Math.round((yaw - f) / (Math.PI / 2)) * (Math.PI / 2) + f;
    yaw = snap + (st.interior === "two" ? Math.PI / 4 : 0); pitch = 0;
    camera.position.y = feet + (st.height ?? 1.2);
    camSet = st;
    const a = anglesOf(st.lens || 18, shapeOf(st));
    pic = { aspect: shapeOf(st), v: a.v, shift: [0, 0] };
    applyOutput(host.clientWidth / Math.max(1, host.clientHeight)); aim(); drawFrame();
    return cameraInfo();
  }
  /** Back to the free 3D view (no set picture). */
  function freeCamera() { pic = null; camSet = null; camera.up.set(0, 1, 0); camera.fov = 45; applyOutput(camera.aspect); drawFrame(); redraw(); }

  // where the front is: the main entrance on the ground floor, else the model's own front (+z); the architect can say
  function detectFront() {
    entrance = null; front = [0, 1]; frontFrom = "guessed";
    if (frameBox.isEmpty()) return;
    const b = frameBox, boxOf = e => new THREE.Box3().setFromObject(e);
    const doors = elements.filter(e => /IfcDoor/.test(e.userData.ifcType || "") && e.userData.ifcType !== "IfcSpace").map(e => ({ e, b: boxOf(e) })).filter(d => !d.b.isEmpty());
    if (!doors.length) return;
    const low = Math.min(...doors.map(d => d.b.min.y));
    const ground = doors.filter(d => d.b.min.y < low + 1.5);
    let best = null;
    for (const d of ground) {
      const c = d.b.getCenter(new THREE.Vector3());
      const sides = [[b.min.x - c.x, [-1, 0]], [c.x - b.max.x, [1, 0]], [b.min.z - c.z, [0, -1]], [c.z - b.max.z, [0, 1]]].map(([gap, dir]) => ({ gap: Math.abs(gap), dir }));
      const side = sides.sort((x, y) => x.gap - y.gap)[0];
      const named = /main|entrance|entry|front/i.test(`${d.e.userData.name || ""} ${d.e.userData.predefined || ""}`) ? -0.6 : 0;
      const wide = -(d.b.max.x - d.b.min.x + d.b.max.z - d.b.min.z) * 0.05;   // a wider door is more likely the entrance
      const score = side.gap + named + wide;
      if (!best || score < best.score) best = { score, dir: side.dir, c, d };
    }
    if (best && best.d.b.min.y < frameBox.min.y + Math.max(1.5, (frameBox.max.y - frameBox.min.y) * 0.3)) {
      front = best.dir; frontFrom = "entrance"; entrance = [best.c.x, best.d.b.min.y + 1.1, best.c.z];
    }
  }
  function setFront(dir, from = "you") {
    const l = Math.hypot(dir[0], dir[1]) || 1;
    front = [dir[0] / l, dir[1] / l]; frontFrom = from;
    placeArrow();
    if (camSet && !camSet.interior) setCamera(camSet);
    onFront?.({ front: [...front], from });
  }
  // an arrow on the ground in front of the building, pointing out of its front
  const frontArrow = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-0.5, 0), new THREE.Vector2(0.5, 0), new THREE.Vector2(0.5, 1.2), new THREE.Vector2(1.1, 1.2), new THREE.Vector2(0, 2.4), new THREE.Vector2(-1.1, 1.2), new THREE.Vector2(-0.5, 1.2)])),
    new THREE.MeshBasicMaterial({ color: "#b3261e", side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.9 }));
  frontArrow.visible = false; frontArrow.renderOrder = 10; scene.add(frontArrow);
  function placeArrow() {
    if (frameBox.isEmpty()) return;
    const b = frameBox, c = b.getCenter(new THREE.Vector3()), half = Math.abs(front[0]) > 0.5 ? (b.max.x - b.min.x) / 2 : (b.max.z - b.min.z) / 2;
    const k = Math.max(1, buildingHeight() / 8);
    frontArrow.scale.setScalar(k);
    frontArrow.position.set(c.x + front[0] * (half + 1.5 * k), groundY + 0.05, c.z + front[1] * (half + 1.5 * k));
    frontArrow.rotation.set(-Math.PI / 2, 0, Math.atan2(-front[0], front[1]));
    redraw();
  }

  // the set picture's outline over the view, and the framing guides (thirds, centre, horizon, safe margin)
  const frameEl = document.createElement("div");
  frameEl.className = "cam-pic"; frameEl.setAttribute("aria-hidden", "true");
  frameEl.style.cssText = "position:absolute;pointer-events:none;box-shadow:0 0 0 9999px rgba(10,12,16,.45);outline:1px solid rgba(255,255,255,.7);display:none;z-index:2";
  host.style.overflow = "hidden"; if (getComputedStyle(host).position === "static") host.style.position = "relative";
  host.append(frameEl);
  function drawFrame() {
    if (!pic || mode === "walk" && !camSet) { frameEl.style.display = "none"; return; }
    const W = host.clientWidth, H = host.clientHeight, A = W / Math.max(1, H), a = pic.aspect;
    const w = a >= A ? W : H * a, h = a >= A ? W / a : H;
    Object.assign(frameEl.style, { display: "block", left: `${(W - w) / 2}px`, top: `${(H - h) / 2}px`, width: `${w}px`, height: `${h}px` });
    const L = [];
    const line = (x1, y1, x2, y2, dash = "") => L.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(255,255,255,.75)" stroke-width="1" ${dash ? `stroke-dasharray="${dash}"` : ""}/>`);
    if (frameGuides.thirds) { line(w / 3, 0, w / 3, h); line(2 * w / 3, 0, 2 * w / 3, h); line(0, h / 3, w, h / 3); line(0, 2 * h / 3, w, 2 * h / 3); }
    if (frameGuides.centre) { line(w / 2, 0, w / 2, h, "6 4"); line(0, h / 2, w, h / 2, "6 4"); }
    if (frameGuides.safe) L.push(`<rect x="${w * 0.05}" y="${h * 0.05}" width="${w * 0.9}" height="${h * 0.9}" fill="none" stroke="rgba(255,255,255,.6)" stroke-dasharray="3 3"/>`);
    if (frameGuides.horizon) {   // where a level line at the camera's height meets the picture
      const dir = new THREE.Vector3(); camera.getWorldDirection(dir); dir.y = 0;
      if (dir.lengthSq() > 1e-6) {
        const p = camera.position.clone().addScaledVector(dir.normalize(), 1e4).project(camera);
        const yIn = (1 - p.y) / 2 * H - (H - h) / 2;
        if (yIn > -2 && yIn < h + 2) L.push(`<line x1="0" y1="${yIn}" x2="${w}" y2="${yIn}" stroke="#ffd166" stroke-width="1.5"/>`);
      }
    }
    frameEl.innerHTML = L.length ? `<svg width="${w}" height="${h}" style="position:absolute;inset:0">${L.join("")}</svg>` : "";
  }
  controls.addEventListener("change", () => { if (frameGuides.horizon) drawFrame(); });
  controls.addEventListener("start", () => { if (camSet && !camSet.custom) camSet = { ...camSet, custom: true, preset: camSet.preset }; });

  // ---------------------------------------------------------------- materials the user sets (click to apply)
  // Each part is known by its element's GlobalId and its index among the element's parts ("2O2F...#1"), and one
  // face of it by the side it faces ("#1/+" or "#1/-"). Only what the user changed is kept; the IFC's own stays.
  let undoStack = [], redoStack = [], onAssign = null;
  const partKey = o => `${o.userData.globalId || o.userData.name || "part"}#${o.userData.part ?? 0}${o.userData.face ? "/" + o.userData.face : ""}`;
  const specOf = o => o.userData.assigned || { id: o.userData.mat?.id || null, tint: o.userData.lookOpts?.tint || null };
  function dressPart(o) {
    const a = o.userData.assigned, base = o.userData.mat;
    let m = null;
    if (a) m = materialLook(a.id, { tint: a.tint, scale: a.scale, rotation: a.rotation, rough: a.rough, offset: a.offset, opacity: o.userData.lookOpts?.opacity, quality });
    else if (base?.id && o.userData.cls !== "space") m = materialLook(base.id, { ...o.userData.lookOpts, quality });
    if (!m) return;
    if (!o.geometry.attributes.uv || o.geometry.userData.metric !== true) { addMetricUVs(o.geometry); o.geometry.userData.metric = true; }
    setLook(o, m);
    const seen = findMaterial(a?.id || base?.id)?.cls || o.userData.cls;
    o.userData.shadowReal = seen !== "glass" && o.userData.cls !== "space";
    if (!classicOn) o.castShadow = o.userData.shadowReal;
  }
  /** Splits a part into its two faces (wall outside and inside) and the rest (ends, top), once. Returns the faces. */
  function splitFaces(o) {
    if (o.userData.faceSplit) return o.userData.faceSplit;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry, pos = g.attributes.position, n = pos.count / 3;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    const normals = [], areas = [];
    let ref = null, best = 0;
    for (let t = 0; t < n; t++) {
      a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
      const nn = e1.subVectors(b, a).cross(e2.subVectors(c, a)), area = nn.length() / 2;
      const u = area > 0 ? nn.clone().normalize() : new THREE.Vector3();
      normals.push(u); areas.push(area);
      if (Math.abs(u.y) < 0.3 && area > best) { best = area; ref = u.clone(); }
    }
    if (!ref) return (o.userData.faceSplit = { "+": o, "-": o });
    const sides = { "+": [], "-": [], rest: [] };
    for (let t = 0; t < n; t++) {
      const d = normals[t].dot(ref), k = d > 0.7 ? "+" : d < -0.7 ? "-" : "rest";
      for (let v = 0; v < 3; v++) sides[k].push(pos.getX(t * 3 + v), pos.getY(t * 3 + v), pos.getZ(t * 3 + v));
    }
    if (!sides["+"].length || !sides["-"].length) return (o.userData.faceSplit = { "+": o, "-": o });
    // "+" is the side facing away from the building's middle: the outside
    o.updateMatrixWorld();
    const mid = frameBox.getCenter(new THREE.Vector3()), centroid = arr => { const v = new THREE.Vector3(); for (let i = 0; i < arr.length; i += 3) v.add(new THREE.Vector3(arr[i], arr[i + 1], arr[i + 2])); return v.multiplyScalar(3 / arr.length).applyMatrix4(o.matrixWorld); };
    const worldRef = ref.clone().transformDirection(o.matrixWorld);
    if (centroid(sides["+"]).sub(mid).dot(worldRef) < 0) [sides["+"], sides["-"]] = [sides["-"], sides["+"]];
    const make = (arr, face) => {
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3)); geo.computeVertexNormals(); geo.computeBoundingBox(); geo.computeBoundingSphere();
      addMetricUVs(geo); geo.userData.metric = true;
      const m = new THREE.Mesh(geo, o._look || o.material);
      m.userData = { ...o.userData, face, faceName: face === "+" ? "outside" : "inside", faceSplit: null, assigned: o.userData.assigned };
      m.position.copy(o.position); m.quaternion.copy(o.quaternion); m.scale.copy(o.scale);
      m.castShadow = o.castShadow; m.receiveShadow = o.receiveShadow;
      o.parent.add(m); elements.push(m);
      return m;
    };
    const plus = make(sides["+"], "+"), minus = make(sides["-"], "-");
    const rest = new THREE.BufferGeometry(); rest.setAttribute("position", new THREE.Float32BufferAttribute(sides.rest, 3)); rest.computeVertexNormals(); rest.computeBoundingBox(); rest.computeBoundingSphere();
    addMetricUVs(rest); rest.userData.metric = true;
    o.geometry = rest;
    o.userData.faceSplit = { "+": plus, "-": minus };
    if (edgesGroup) { scene.remove(edgesGroup); edgesGroup.children.forEach(l => l.geometry.dispose()); edgesGroup = null; }
    schedule = null;
    return o.userData.faceSplit;
  }
  /** The parts a change applies to: this part, everything showing the same material, every element of this type
   * (on this floor or in the building), or one face of this part ("outside" or "inside"). */
  function targetsOf(o, scope) {
    const live = elements.filter(e => e.userData.cls !== "space" && e.userData.ifcType !== "IfcSpace");
    if (scope === "same") { const s = specOf(o); return live.filter(e => { const t = specOf(e); return t.id === s.id && (t.tint || null) === (s.tint || null); }); }
    if (scope === "type-floor") return live.filter(e => e.userData.ifcType === o.userData.ifcType && e.userData.storey === o.userData.storey);
    if (scope === "type") return live.filter(e => e.userData.ifcType === o.userData.ifcType);
    if (scope === "outside" || scope === "inside") { const f = splitFaces(o); return [f[scope === "outside" ? "+" : "-"]]; }
    return [o];
  }
  const snapshotOf = list => Object.fromEntries(list.map(e => [partKey(e), e.userData.assigned ? { ...e.userData.assigned } : null]));
  function applyMap(map) {
    for (const [k, v] of Object.entries(map)) {
      const e = findPart(k);
      if (!e) continue;
      e.userData.assigned = v ? { ...v } : null;
      dressPart(e);
    }
    redraw();
  }
  function findPart(key) {
    let e = elements.find(x => partKey(x) === key);
    if (e || !/\/[+-]$/.test(key)) return e;
    const whole = elements.find(x => partKey(x) === key.slice(0, -2) && !x.userData.face);   // a face: split its part first
    if (!whole) return null;
    splitFaces(whole);
    return elements.find(x => partKey(x) === key) || null;
  }
  function assignments() {
    const out = {};
    for (const e of elements) if (e.userData.assigned) out[partKey(e)] = { ...e.userData.assigned };
    return out;
  }
  function changed() { onAssign?.(assignments()); }
  function assign(list, spec) {
    const before = snapshotOf(list);
    const after = Object.fromEntries(list.map(e => [partKey(e), spec ? { ...spec } : null]));
    applyMap(after);
    undoStack.push({ before, after }); if (undoStack.length > 200) undoStack.shift(); redoStack = [];
    changed();
    return list.length;
  }


  function draw(final) {
    if (final && quality !== "fast" && !owner && (!lowPower || quality === "best")) {
      plainPass.enabled = quality !== "best"; taa.enabled = quality === "best";
      composer.render();
      // Best: the still view keeps refining (anti-aliasing builds up over 32 jittered frames)
      if (quality === "best" && taa.accumulateIndex >= 0 && taa.accumulateIndex < 32) return;
    } else renderer.render(scene, camera);
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
      dirty = false; stillTimer = now; taa.accumulateIndex = -1;
      if (labels.children.length) placeLabels();
      draw(false);
    } else if (!finalDone && now - stillTimer > 220) {
      draw(true);
    }
  }
  resize();
  tick();

  // ---------------------------------------------------------------- guide frames for the AI
  // The AI renders on top of exact pictures of the model: a clay view (shape and light), a line
  // drawing (every edge) and a depth map (how far each part is). Same camera, same size, so the
  // AI keeps the geometry and the result can be checked against the lines.
  let edgesGroup = null, guide = null;
  const clayMat = new THREE.MeshStandardMaterial({ color: "#d9d7d2", roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  const clayGlass = new THREE.MeshStandardMaterial({ color: "#9fb4c4", roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false });
  const clayGround = new THREE.MeshStandardMaterial({ color: "#c8cac4", roughness: 1 });
  const inkMat = new THREE.MeshBasicMaterial({ color: "#000000", side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const lineMat = new THREE.LineBasicMaterial({ color: "#ffffff" });
  const goldMat = new THREE.LineBasicMaterial({ color: "#ffd47e" });
  // ---------------------------------------------------------------- the build (4D): when each part of the model is built, 0 to 1
  // Foundations first; then floor by floor the pic (columns, beams, slabs, stairs) with the walls one floor behind;
  // then the roof, the windows and doors, and last the fittings. Within a stage, from the bottom up.
  let schedule = null;
  const PHASE = [[/^Ifc(Footing|Pile|Foundation)/, 0], [/^Ifc(Column|Beam|Slab|Stair|StairFlight|Ramp|RampFlight|Member|Structural)/, 1],
    [/^Ifc(Roof)$/, 3], [/^Ifc(Window|Door)$/, 4], [/^Ifc(Furnishing|Furniture|FlowTerminal|DistributionElement|Covering|Transport)/, 5]];
  function buildSchedule() {
    if (schedule) return schedule;
    const items = [];
    const storeyOf = (e, b) => {
      const i = storeys.indexOf(e.userData.storey);
      if (i >= 0) return i;
      let k = 0; storeys.forEach((s, j) => { if (b.min.y >= (storeyLow[s] ?? Infinity) - 0.3) k = j; }); return k;
    };
    for (const e of elements) {
      if (e.userData.ifcType === "IfcSpace") continue;
      const b = e.geometry.boundingBox ? e.geometry.boundingBox.clone().applyMatrix4(e.matrixWorld) : new THREE.Box3().setFromObject(e);
      let phase = 2;
      for (const [re, ph] of PHASE) if (re.test(e.userData.ifcType || "")) { phase = ph; break; }
      if (b.max.y <= groundY + 0.15 && phase !== 5) phase = 0;
      items.push({ e, phase, s: storeyOf(e, b), y: b.min.y, x: b.min.x });
    }
    const S = Math.max(1, storeys.length), groups = new Map(), add = (key, it) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(it); };
    for (const it of items) {
      if (it.phase === 0) add(0, it);
      else if (it.phase === 1) add(1 + it.s * 2, it);              // the pic of floor s
      else if (it.phase === 2) add(1 + Math.min(it.s + 1, S) * 2 + 1, it);   // its walls, once the floor above is framed
      else add(1000 + it.phase, it);                                 // roof, openings, fittings
    }
    const keys = [...groups.keys()].sort((a, b) => a - b), weight = keys.map(k => Math.sqrt(groups.get(k).length));
    const total = weight.reduce((a, b) => a + b, 0) || 1;
    schedule = new Map(); let at = 0;
    keys.forEach((k, i) => {
      const list = groups.get(k).sort((a, b) => a.y - b.y || a.x - b.x), span = weight[i] / total;
      list.forEach((it, j) => schedule.set(it.e, at + span * 0.9 * (j / Math.max(1, list.length))));
      at += span;
    });
    return schedule;
  }
  /** Shows the model as built at time t (0: bare site, 1: finished). Only parts shown when the guide began. */
  function applyBuild(t) {
    const sch = buildSchedule();
    for (const [e, v] of guide.vis) if (e.userData.ifcType !== "IfcSpace") e.visible = v && t >= (sch.get(e) ?? 0);
    if (edgesGroup && (guide.kind === "lines" || guide.kind === "gold")) edgesGroup.children.forEach(l => { l.visible = l.userData.of.visible; });
  }
  const depthMat = new THREE.ShaderMaterial({
    uniforms: { near: { value: 1 }, far: { value: 100 } }, side: THREE.DoubleSide, clipping: true,
    vertexShader: "varying float vz;\n#include <clipping_planes_pars_vertex>\nvoid main(){ vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); vz = -mvPosition.z; gl_Position = projectionMatrix * mvPosition;\n#include <clipping_planes_vertex>\n}",
    fragmentShader: "uniform float near; uniform float far; varying float vz;\n#include <clipping_planes_pars_fragment>\nvoid main(){\n#include <clipping_planes_fragment>\n float d = clamp((vz - near) / (far - near), 0.0, 1.0); gl_FragColor = vec4(vec3(1.0 - d), 1.0); }",
  });
  // The material map: each material of the model (its class and the colour the architect gave it)
  // drawn in one flat, distinct colour, so the AI and the check know exactly where each material is.
  const MAP_COLOURS = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe",
    "#008080", "#e6beff", "#9a6324", "#fffac8", "#800000", "#aaffc3", "#808000", "#ffd8b1", "#000075", "#556b2f", "#ff7f7f", "#7fbfff", "#bf7fff", "#7fff7f"];
  const mapMats = new Map();
  // near-identical colours (Revit models carry many) count as one material: each channel to steps of 24
  const q = hex => "#" + [1, 3, 5].map(i => Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) / 24) * 24).toString(16).padStart(2, "0")).join("");
  function materialKey(e) {
    // a material the user set is its own material in the map (its class, colour and library id); everything else is
    // keyed exactly as it always was (the reader's class and the model's colour), so those maps do not change
    const a = e.userData.assigned, lib = a && findMaterial(a.id);
    if (lib) return `${lib.cls}|${q(a.tint || averageColour(a.id))}|${a.id}`.slice(0, 80);
    return `${e.userData.cls || "paint"}|${q(e.userData.srcHex || "#cccccc")}`;
  }
  const MAX_MATERIALS = 24;
  /** The model's materials, largest first: key, class, the model's colour and its map colour. */
  function materialGroups() {
    const area = new Map(), types = new Map(), libs = new Map();
    for (const e of elements) {
      if (e.userData.ifcType === "IfcSpace" || e.userData.cls === "space") continue;
      const k = materialKey(e), b = e.geometry.boundingBox, sz = b ? b.getSize(new THREE.Vector3()) : new THREE.Vector3(), A = sz.x * sz.y + sz.y * sz.z + sz.x * sz.z;
      area.set(k, (area.get(k) || 0) + A);
      const id = e.userData.assigned?.id || e.userData.mat?.id;   // which library material shows there, by area
      if (id) { const l = libs.get(k) || new Map(); l.set(id, (l.get(id) || 0) + A); libs.set(k, l); }
      const t = types.get(k) || new Map(); t.set(e.userData.ifcType || "Element", (t.get(e.userData.ifcType || "Element") || 0) + 1); types.set(k, t);
    }
    const usedOn = k => [...(types.get(k) || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
    // the main materials by size get their own map colour (chosen in key order, so it is the same in every view);
    // small ones are drawn grey and left out of the look
    const main = [...area.keys()].sort((a, b) => area.get(b) - area.get(a)).slice(0, MAX_MATERIALS).sort();
    // the library material each shows (when one covers most of it), so the AI is told "Travertine stone", not "stone"
    const named = k => {
      const l = [...(libs.get(k) || new Map()).entries()].sort((a, b) => b[1] - a[1])[0];
      if (!l || l[1] < 0.6 * area.get(k)) return {};
      const m = findMaterial(l[0]), user = k.split("|")[2] === l[0];
      if (!m) return {};
      const size = m.tile ? `${m.tile.w} x ${m.tile.h} mm ${m.cls === "tile" ? "tiles" : "units"}` : "";
      return { lib: l[0], name: m.name, finish: [user ? "chosen in the 3D preview" : "", size].filter(Boolean).join("; ") };
    };
    const groups = main.map((k, i) => ({ key: k, cls: k.split("|")[0], hex: k.split("|")[1], map: MAP_COLOURS[i], area: area.get(k), types: usedOn(k), ...named(k) }));
    return groups.sort((a, b) => b.area - a.area);
  }
  function mapMatFor(colour) {
    if (!mapMats.has(colour)) mapMats.set(colour, new THREE.MeshBasicMaterial({ color: colour, side: THREE.DoubleSide }));
    return mapMats.get(colour);
  }
  function edges() {
    if (edgesGroup) return edgesGroup;
    edgesGroup = new THREE.Group(); edgesGroup.visible = false;
    model?.updateMatrixWorld(true);
    for (const e of elements) {
      if (e.userData.ifcType === "IfcSpace") continue;
      const l = new THREE.LineSegments(new THREE.EdgesGeometry(e.geometry, 28), lineMat);
      l.matrixAutoUpdate = false; l.matrix.copy(e.matrixWorld); l.userData.of = e;
      edgesGroup.add(l);
    }
    scene.add(edgesGroup);
    return edgesGroup;
  }
  /** Starts guide output of one kind ("view", "clay", "lines", "materials" or "depth") at w x h pixels. */
  function beginGuide(kind, w, h) {
    if (guide) endGuide();
    if (kind !== "view") classicLight(true);   // the guides keep the light they always had
    if (mode === "walk") { keys.clear(); }
    select(null);
    guide = { kind, owner, cam: { p: camera.position.clone(), q: camera.quaternion.clone(), fov: camera.fov, t: controls.target.clone() }, size: renderer.getSize(new THREE.Vector2()), pr: renderer.getPixelRatio(), aspect: camera.aspect, near: camera.near, far: camera.far,
      bg: scene.background, env: scene.environment, tone: renderer.toneMapping, sky: sky.visible, ground: ground.visible, groundMat: ground.material, mats: new Map() };
    owner = true; controls.enabled = false;
    renderer.setPixelRatio(1); renderer.setSize(w, h, false); applyOutput(w / h);
    guide.arrow = frontArrow.visible; frontArrow.visible = false;
    const shown = elements.filter(e => e.visible && e.userData.ifcType !== "IfcSpace");
    elements.forEach(e => guide.mats.set(e, e.material));
    guide.vis = new Map(elements.map(e => [e, e.visible])); guide.clip = renderer.clippingPlanes;
    if (kind === "clay") {
      shown.forEach(e => { e.material = e.userData.cls === "glass" ? clayGlass : clayMat; });
      sky.visible = false; scene.background = new THREE.Color("#eceef0"); ground.material = clayGround;
    } else if (kind === "lines") {
      shown.forEach(e => { e.material = inkMat; });
      if (edgesGroup) edgesGroup.children.forEach(l => { l.material = lineMat; });
      sky.visible = false; scene.background = new THREE.Color("#000000"); ground.visible = false; scene.environment = null; renderer.toneMapping = THREE.NoToneMapping;
      edges().children.forEach(l => { l.visible = l.userData.of.visible; }); edgesGroup.visible = true;
    } else if (kind === "gold") {    // glowing gold lines on black: the construction animation
      shown.forEach(e => { e.material = inkMat; });
      sky.visible = false; scene.background = new THREE.Color("#050507"); ground.visible = false; scene.environment = null; renderer.toneMapping = THREE.NoToneMapping;
      edges().children.forEach(l => { l.material = goldMat; l.visible = l.userData.of.visible; }); edgesGroup.visible = true;
    } else if (kind === "materials") {
      const colour = new Map(materialGroups().map(g => [g.key, g.map]));
      shown.forEach(e => { e.material = mapMatFor(colour.get(materialKey(e)) || "#808080"); });
      sky.visible = false; scene.background = new THREE.Color("#000000"); ground.visible = false; scene.environment = null; renderer.toneMapping = THREE.NoToneMapping;
    } else if (kind === "depth") {
      scene.overrideMaterial = depthMat; sky.visible = false; scene.background = new THREE.Color("#000000"); renderer.toneMapping = THREE.NoToneMapping;
    }
  }
  /** Draws one guide pic (optionally from a pose) and returns the canvas holding it. */
  function guideFrame(pose) {
    if (pose) {
      // a pose with a set picture (lens, shape, shift) is drawn exactly as it shows in the view; others as before
      if (guide && guide.frame === undefined) guide.frame = pic;
      pic = pose.aspect ? { aspect: pose.aspect, v: pose.fov, shift: pose.shift || [0, 0] } : null;
      camera.up.set(0, 1, 0); if (pose.up) camera.up.fromArray(pose.up);
      camera.position.fromArray(pose.position);
      if (pic) applyOutput(camera.aspect); else { camera.shift = [0, 0]; camera.fov = pose.fov || camera.fov; }
      camera.lookAt(new THREE.Vector3().fromArray(pose.target));
    }
    if (pose?.near) camera.near = pose.near;
    if (pose?.inside && guide && !guide.whole) {   // inside the house: every floor, wall and ceiling, no section cut
      guide.whole = { clip: renderer.clippingPlanes, vis: new Map(elements.map(e => [e, e.visible])) };
      renderer.clippingPlanes = [];
      elements.forEach(e => { if (e.userData.ifcType !== "IfcSpace") e.visible = true; });
      if (guide.kind === "clay") elements.forEach(e => { if (e.visible && e.userData.ifcType !== "IfcSpace") e.material = e.userData.cls === "glass" ? clayGlass : clayMat; });
      if (guide.kind === "lines") elements.forEach(e => { if (e.visible && e.userData.ifcType !== "IfcSpace") e.material = inkMat; });
      if (guide.kind === "materials") {
        const colour = new Map(materialGroups().map(g => [g.key, g.map]));
        elements.forEach(e => { if (e.visible && e.userData.ifcType !== "IfcSpace") e.material = mapMatFor(colour.get(materialKey(e)) || "#808080"); });
      }
    }
    if (guide && pose?.build !== undefined) applyBuild(pose.build);
    if (guide && pose?.rise !== undefined) {   // the gold lines trace up from the foundations: everything above the line is not drawn yet
      const top = frameBox.max.y + 0.5, y = groundY - 1 + (top - groundY + 1) * pose.rise;
      renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), y)];
    }
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    if (guide?.kind === "depth" && pose?.inside) { depthMat.uniforms.near.value = 0.1; depthMat.uniforms.far.value = 18; }
    else if (guide?.kind === "depth") {   // the depth range fits the building as seen from this camera
      const b = frameBox, c = new THREE.Vector3(), d = [];
      for (let i = 0; i < 8; i++) { c.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z); d.push(c.applyMatrix4(camera.matrixWorldInverse).z * -1); }
      depthMat.uniforms.near.value = Math.max(0.1, Math.min(...d)); depthMat.uniforms.far.value = Math.max(depthMat.uniforms.near.value + 1, Math.max(...d) * 1.05);
    }
    renderer.render(scene, camera);
    return renderer.domElement;
  }
  function endGuide() {
    if (!guide) return;
    if (guide.whole) { renderer.clippingPlanes = guide.whole.clip; guide.whole.vis.forEach((v, e) => { e.visible = v; }); }
    renderer.clippingPlanes = guide.clip; guide.vis.forEach((v, e) => { e.visible = v; });
    guide.mats.forEach((m, e) => { e.material = m; });
    scene.overrideMaterial = null; scene.background = guide.bg; scene.environment = guide.env; renderer.toneMapping = guide.tone;
    sky.visible = guide.sky; ground.visible = guide.ground; ground.material = guide.groundMat; if (edgesGroup) edgesGroup.visible = false;
    renderer.setPixelRatio(guide.pr); camera.near = guide.near; camera.far = guide.far;
    camera.position.copy(guide.cam.p); camera.quaternion.copy(guide.cam.q); camera.fov = guide.cam.fov; controls.target.copy(guide.cam.t);
    frontArrow.visible = guide.arrow; if (guide.frame !== undefined) pic = guide.frame;
    owner = guide.owner; controls.enabled = !owner && mode !== "walk";
    guide = null;
    if (classicOn && !owner) classicLight(false);
    resize();
  }
  /** Stills of the current view, every kind, as data URLs. */
  function guides(w, h, kinds = ["view", "clay", "lines", "depth"], at = null) {
    const out = {}, pose = at || currentPose();
    for (const k of kinds) {
      beginGuide(k, w, h);
      const cv = guideFrame(pose);
      out[k] = cv.toDataURL(k === "view" || k === "clay" ? "image/jpeg" : "image/png", 0.92);
      if (k === "materials") {   // how much of the picture is the building (the map's background is black)
        const s = document.createElement("canvas"); s.width = 96; s.height = Math.max(1, Math.round(96 * h / w));
        const g = s.getContext("2d", { willReadFrequently: true }); g.drawImage(cv, 0, 0, s.width, s.height);
        const d = g.getImageData(0, 0, s.width, s.height).data; let on = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) on++;
        out.coverage = on / (s.width * s.height);
      }
    }
    if (kinds.includes("materials")) out.legend = materialGroups().map(({ key, cls, hex, map, types, name, finish, lib }) => ({ key, cls, hex, map, types, name, finish, lib }));
    endGuide();
    return out;
  }
  function currentPose() {
    const t = mode === "walk" ? camera.position.clone().add(forward()) : controls.target.clone();
    const p = { mode: mode === "walk" ? "walk" : "orbit", position: camera.position.toArray(), target: t.toArray(), fov: camera.fov };
    // a set picture: its own angle of view, shape and shift (so a capture or a film shows exactly that picture)
    if (pic) Object.assign(p, { fov: pic.v, aspect: pic.aspect, shift: [...pic.shift], ...(camera.up.y !== 1 ? { up: camera.up.toArray() } : {}), ...(camSet ? { camera: { ...camSet } } : {}) });
    return p;
  }
  /** A pose part-way along a smooth path through several poses (t from 0 to 1). */
  function along(poses, t) {
    if (poses.length === 1) return poses[0];
    const P = new THREE.CatmullRomCurve3(poses.map(p => new THREE.Vector3().fromArray(p.position)), false, "centripetal");
    const T = new THREE.CatmullRomCurve3(poses.map(p => new THREE.Vector3().fromArray(p.target)), false, "centripetal");
    const k = poses[0].linear ? t : t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // ease in and out (a long move in parts: steady)
    const i = Math.min(poses.length - 2, Math.floor(k * (poses.length - 1))), f = k * (poses.length - 1) - i;
    const inside = (f < 0.5 ? poses[i] : poses[i + 1]).inside;
    return { position: P.getPoint(k).toArray(), target: T.getPoint(k).toArray(), fov: poses[i].fov + (poses[i + 1].fov - poses[i].fov) * f,
             ...(inside ? { inside: true } : {}), ...(poses[0].near ? { near: poses[0].near } : {}),
             ...(poses[0].build !== undefined ? { build: poses[0].build + (poses[poses.length - 1].build - poses[0].build) * t } : {}),
             ...(poses[0].rise !== undefined ? { rise: poses[0].rise + (poses[poses.length - 1].rise - poses[0].rise) * t } : {}) };
  }
  /** The front door: the door on the ground floor nearest the outside, and the way into the house through it. */
  function entryPath() {
    const c = frameBox.getCenter(new THREE.Vector3());
    const low = storeys.length ? storeys[0] : null;
    const doors = elements.filter(e => e.userData.ifcType === "IfcDoor" && (!low || e.userData.storey === low || storeys.indexOf(e.userData.storey) <= 1));
    if (!doors.length) return null;
    const edge = b => Math.min(b.min.x - frameBox.min.x, frameBox.max.x - b.max.x, b.min.z - frameBox.min.z, frameBox.max.z - b.max.z);
    const boxes = doors.map(e => new THREE.Box3().setFromObject(e)).filter(b => b.min.y < groundY + 2.5);
    if (!boxes.length) return null;
    const door = boxes.reduce((a, b) => (edge(b) < edge(a) ? b : a));
    const p = door.getCenter(new THREE.Vector3()), feet = door.min.y;
    // which way is outside: the door's thin side faces in and out; outside is away from the building's middle
    const sz = door.getSize(new THREE.Vector3());
    const out = sz.x < sz.z ? new THREE.Vector3(Math.sign(p.x - c.x) || 1, 0, 0) : new THREE.Vector3(0, 0, Math.sign(p.z - c.z) || 1);
    const eye = feet + EYE, at = (k, look) => ({ position: [p.x + out.x * k, eye, p.z + out.z * k], target: [p.x + out.x * look, eye - 0.1, p.z + out.z * look], fov: 60, inside: k < 0.5, near: 0.05 });
    return [at(14, -10), at(6, -10), at(1.2, -10), at(-3.5, -12)];
  }
  /** A slow walk through a room at eye height, facing its most open view. */
  function roomPath(which) {
    const all = rooms();
    let r = typeof which === "number" ? all[which] : which ? all.find(x => x.name.toLowerCase() === String(which).toLowerCase()) || all.find(x => x.name.toLowerCase().includes(String(which).toLowerCase())) : null;
    if (!r) {
      const area = x => (x.box.max.x - x.box.min.x) * (x.box.max.z - x.box.min.z) * (/living|lounge|sitting|family|salon|parlou?r/i.test(x.name) ? 3 : 1);
      r = all.length ? all.reduce((a, b) => (area(b) > area(a) ? b : a)) : null;
    }
    let x, z, feet, yw;
    const spot = r ? openSpot(r.box.min.y, null, r.box) : openSpot(storeys.length ? storeyLow[planStorey()] : groundY);
    if (spot) { x = spot.x; z = spot.z; feet = spot.feet; yw = spot.yaw; }
    else if (r) { const c = r.box.getCenter(new THREE.Vector3()); x = c.x; z = c.z; feet = r.box.min.y; yw = 0; }
    else return null;
    const dir = new THREE.Vector3(-Math.sin(yw), 0, -Math.cos(yw)), side = new THREE.Vector3(dir.z, 0, -dir.x), eye = feet + EYE;
    const pose = (k, pan) => {
      const pos = new THREE.Vector3(x, eye, z).addScaledVector(dir, k);
      const look = pos.clone().addScaledVector(dir, 5).addScaledVector(side, pan); look.y = eye - 0.15;
      return { position: pos.toArray(), target: look.toArray(), fov: 68, inside: true, near: 0.05, room: r ? r.name : "Inside" };
    };
    return [pose(-0.6, -1.2), pose(0.6, 0), pose(1.6, 1.2)];
  }
  /** Ready-made camera moves around the model: what an architectural film usually shows. */
  function shotPath(kind, opts = {}) {
    const b = frameBox, size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const r = Math.hypot(size.x, size.z) / 2, d = fitDistance(size.length() / 2) * 0.95, fov = 45;
    const at = (ang, dist, h, look = c) => ({ position: [c.x + Math.cos(ang) * dist, h, c.z + Math.sin(ang) * dist], target: look.toArray(), fov });
    const eye = groundY + 1.7, mid = c.clone(); mid.y = groundY + Math.min(size.y * 0.45, 12);
    if (kind === "orbit") return [0, 1, 2, 3].map(i => at(0.55 + i * 0.32, d, c.y + size.y * 0.35));
    if (kind === "aerial") return [0, 1, 2].map(i => at(0.3 + i * 0.45, d * 1.05, b.max.y + size.y * 0.9 + r * 0.4));
    if (kind === "approach") return [at(Math.PI / 2, d * 1.7, eye, mid), at(Math.PI / 2, d * 0.75, eye, mid)];
    if (kind === "rise") return [at(0.75, d * 0.9, eye, mid), at(0.75, d * 0.95, b.max.y + size.y * 0.5, c)];
    // a low drone pass along the front, as if flying beside the street
    if (kind === "sidepass") {
      const z = c.z + d * 0.85, h = groundY + Math.max(4, size.y * 0.3), w = Math.max(size.x * 0.75, 12);
      return [{ position: [c.x - w, h, z], target: [c.x - w * 0.35, mid.y, c.z], fov }, { position: [c.x + w, h, z], target: [c.x + w * 0.35, mid.y, c.z], fov }];
    }
    // straight down from high above, turning slowly: the roof, the plot and the site
    if (kind === "topdown") {
      const h = b.max.y + Math.max(size.x, size.z) * 1.25 + 10;
      return [0, 1, 2].map(i => ({ position: [c.x + Math.cos(i * 0.35) * 0.6, h, c.z + Math.sin(i * 0.35) * 0.6], target: [c.x, groundY, c.z], fov: 50 }));
    }
    // part of a steady circle around the building (angles in degrees), with the build or the gold tracing moving on
    if (kind === "arc") {
      const a0 = (opts.from ?? 0) * Math.PI / 180, a1 = (opts.to ?? 90) * Math.PI / 180, n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 6)) + 1);
      const h = c.y + size.y * (opts.high ? 0.75 : 0.35), dist = d * (opts.far || 1);
      return Array.from({ length: n }, (_, i) => {
        const f = i / (n - 1), p = at(a0 + (a1 - a0) * f, dist, h);
        if (opts.build) p.build = opts.build[0] + (opts.build[1] - opts.build[0]) * f;
        if (opts.rise) p.rise = opts.rise[0] + (opts.rise[1] - opts.rise[0]) * f;
        p.linear = true;
        return p;
      });
    }
    // to the front door and in: from the street to the door, through it, a few steps into the house
    if (kind === "entry") return entryPath() || [at(Math.PI / 2, d * 1.4, eye, mid), at(Math.PI / 2, d * 0.45, eye, mid)];
    // a slow glide through one room (opts.room: its name or index; none: the main room)
    if (kind === "interior") return roomPath(opts.room);
    // "push": a slow move in from the current view
    const p = currentPose(), from = new THREE.Vector3().fromArray(p.position), to = new THREE.Vector3().fromArray(p.target);
    return [p, { ...p, position: from.clone().lerp(to, mode === "walk" ? 0.6 : 0.18).toArray() }];
  }
  /** Shows a pose in the live view (for previewing a path). */
  function showPose(p) {
    if (mode === "walk") leaveWalk();
    camera.up.set(0, 1, 0); if (p.up) camera.up.fromArray(p.up);
    camera.position.fromArray(p.position); controls.target.fromArray(p.target);
    pic = p.aspect ? { aspect: p.aspect, v: p.fov, shift: p.shift || [0, 0] } : null;
    camSet = p.camera ? { ...p.camera } : null;
    if (!pic) camera.fov = p.fov || 45;
    if (p.near) camera.near = Math.min(camera.near, p.near);
    applyOutput(camera.aspect); controls.update(); drawFrame(); redraw();
  }

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
    dispose() { offTextures(); cancelAnimationFrame(frame); composer.dispose(); pmrem.dispose(); renderer.dispose(); host.replaceChildren(); },
    get storeys() { return storeys; },
    /** Hands the scene to the construction animation (on) or takes it back (off). */
    takeOver(on) {
      if (on) {
        if (mode === "walk") leaveWalk();
        classicLight(true);
        owner = true; controls.enabled = false; labels.replaceChildren(); select(null); fly = null;
        renderer.clippingPlanes = []; sky.visible = false; scene.environment = null; hemi.intensity = 1.25;
        for (const e of elements) e.visible = e.userData.ifcType !== "IfcSpace";
      } else {
        owner = null; controls.enabled = true; mode = "exterior";
        sky.visible = true; scene.environment = env; hemi.intensity = 0.3; ground.material = groundLook; ground.material.opacity = 1;
        classicLight(false);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        camera.fov = 45; resize(); frameAll(); apply();
      }
    },
    /** The light: { preset: sunny|overcast|golden|dusk, place, day "YYYY-MM-DD", minutes (local clock, null = the sky's
     * own time), exposure (stops), ground, apron, apronWidth }. Returns the light now, with the sun's position. */
    setLight(opts = {}) {
      const siteChanged = ["ground", "apron", "apronWidth"].some(k => k in opts && opts[k] !== light[k]);
      if ("preset" in opts && !("minutes" in opts)) light.minutes = null;
      Object.assign(light, opts);
      if (siteChanged) { buildSite(); if (!classicOn) ground.material = realGround(); }
      applyLight({ envNow: siteChanged });
      return this.light;
    },
    get light() {
      const n = lightNow();
      return { ...light, minutes: n.minutes, sunElevation: +(n.el * 180 / Math.PI).toFixed(1), sunAzimuth: +(n.az * 180 / Math.PI).toFixed(1), quality };
    },
    /** Fast (phones, while moving: colours only, no extra passes), High (default), Best (the still view refines). */
    setQuality(q) {
      if (!["fast", "high", "best"].includes(q) || q === quality) return;
      quality = q;
      renderer.setPixelRatio(q === "fast" ? 1 : Math.min(window.devicePixelRatio || 1, q === "best" ? 2 : 1.75));
      if (!classicOn) setShadowSize(shadowSizeFor(q));
      for (const e of elements) if (e.material?.userData?.lib && !e._look) e.material = materialLook(e.material.userData.lib, { ...e.userData.lookOpts, quality }) || e.material;
      buildSite(); if (!classicOn) ground.material = realGround();
      bloom.enabled = !!PRESETS[light.preset]?.lightsOn && q !== "fast";
      resize(); redraw();
    },
    /** Click to apply. scope: "part", "same", "type-floor", "type", "outside", "inside". spec: { id, tint, scale,
     * rotation, rough, offset } or null (back to the IFC's own). Returns how many parts changed. */
    applyMaterial(key, spec, scope = "part") {
      const o = typeof key === "string" ? findPart(key) : selected;
      if (!o) return 0;
      const n = assign(targetsOf(o, scope), spec);
      if (selected) onSelect?.(selected.userData, { key: partKey(selected), normal: null });
      return n;
    },
    /** What a part shows now: { key, spec, how ("user" or the IFC's), name, ifcType, storey, face }. */
    partInfo(key) {
      const o = key ? findPart(key) : selected;
      if (!o) return null;
      return { key: partKey(o), spec: specOf(o), how: o.userData.assigned ? "user" : o.userData.mat?.how, ifcName: o.userData.mat?.ifcName, name: o.userData.name, ifcType: o.userData.ifcType,
        storey: o.userData.storey, face: o.userData.faceName || null, base: o.userData.mat?.id || null, count: { same: targetsOf(o, "same").length, typeFloor: targetsOf(o, "type-floor").length, type: targetsOf(o, "type").length } };
    },
    /** The part under a point of the page (for dropping a material from the library onto the model). */
    partAt(clientX, clientY) { const h = hitAt({ clientX, clientY }); return h ? partKey(h.object) : null; },
    undo() { const s = undoStack.pop(); if (!s) return false; applyMap(s.before); redoStack.push(s); changed(); if (selected) onSelect?.(selected.userData, { key: partKey(selected) }); return true; },
    redo() { const s = redoStack.pop(); if (!s) return false; applyMap(s.after); undoStack.push(s); changed(); if (selected) onSelect?.(selected.userData, { key: partKey(selected) }); return true; },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    /** Back to the IFC's own materials: one part, or everything (one step to undo). */
    resetMaterials(key = null) {
      const list = key ? [findPart(key)].filter(Boolean) : elements.filter(e => e.userData.assigned);
      return list.length ? assign(list, null) : 0;
    },
    /** The saved assignments, applied as they come (no undo step). */
    setAssignments(map) { applyMap(Object.fromEntries(Object.entries(assignments()).map(([k]) => [k, null]))); applyMap(map || {}); undoStack = []; redoStack = []; },
    assignments,
    onAssign(fn) { onAssign = fn; },
    select(key) { const o = key ? findPart(key) : null; select(o); return !!o; },
    /** What the server needs to write the chosen materials into the IFC: each changed part and the materials. */
    writeBackData() {
      const parts = [], materials = {};
      for (const e of elements) {
        const a = e.userData.assigned;
        if (!a) continue;
        const m = findMaterial(a.id);
        if (!m) continue;
        parts.push({ key: partKey(e), id: a.id, tint: a.tint || null, scale: a.scale || 1, rotation: a.rotation || 0, parts_in_element: e.userData.parts || 1,
          orig_name: e.userData.mat?.ifcName || null, orig_hex: e.userData.srcHex || null });
        materials[a.id] = { name: m.name, cls: m.cls === "furniture" ? "stone" : m.cls, hex: averageColour(a.id), size_m: m.size || 1, tile_mm: m.tile ? [m.tile.w, m.tile.h] : null,
          transparency: m.cls === "glass" ? +(1 - (m.opacity ?? 0.35)).toFixed(2) : 0 };
      }
      return { parts, materials };
    },
    /** The model as a GLB file with its materials and textures (what is shown: hidden storeys and the section cut out). */
    async exportGlb() {
      const [{ GLTFExporter }, { forPathTracing }] = await Promise.all([import("three/addons/exporters/GLTFExporter.js"), import("./materials/photomode.js")]);
      const root = new THREE.Group(), cache = new Map();
      root.name = "Ollic model";
      for (const e of elements) {
        if (!e.visible || e.userData.ifcType === "IfcSpace" || e.userData.cls === "space") continue;
        let shown = true; for (let p = e.parent; p; p = p.parent) if (!p.visible) shown = false;
        if (!shown) continue;
        e.updateWorldMatrix(true, false);
        const g = e.geometry.clone().applyMatrix4(e.matrixWorld);
        for (const k of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(k)) g.deleteAttribute(k);
        const m = new THREE.Mesh(g, forPathTracing(e._look || e.material, cache));
        const lib = findMaterial(e.userData.assigned?.id || e.userData.mat?.id);
        m.name = [e.userData.ifcType, e.userData.name].filter(Boolean).join(" ") || "Element";
        m.userData = { globalId: e.userData.globalId || null, ifcType: e.userData.ifcType || null, storey: e.userData.storey || null, part: e.userData.part ?? 0,
          face: e.userData.faceName || null, material: lib?.name || null, materialId: lib?.id || null, materialFrom: e.userData.assigned ? "Set by you" : ({ ifc: "From your IFC", name: "Matched from its name", guess: "Guessed" }[e.userData.mat?.how] || null) };
        if (m.material.name?.startsWith("ollic:")) { m.material = m.material.clone(); m.material.name = lib?.name || m.material.name; }
        root.add(m);
      }
      // photos as JPEG (a tenth of the size of PNG)
      root.traverse(o => { for (const k of ["map", "normalMap", "roughnessMap", "aoMap"]) if (o.material?.[k]) o.material[k].userData.mimeType = "image/jpeg"; });
      const glb = await new GLTFExporter().parseAsync(root, { binary: true, maxTextureSize: 2048, onlyVisible: true });
      root.traverse(o => o.geometry?.dispose());
      return new Blob([glb], { type: "model/gltf-binary" });
    },
    /** Photo mode: the current view path-traced (see materials/photomode.js); the view waits while it renders. */
    async photo(opts = {}) {
      if (owner) throw new Error("The view is busy.");
      if (mode === "walk") keys.clear();
      select(null);
      const { renderPhoto } = await import("./materials/photomode.js");
      owner = "photo"; controls.enabled = false;
      try { return await renderPhoto(this.engine(), opts); }
      finally { owner = null; controls.enabled = mode !== "walk"; resize(); redraw(); }
    },
    /** Camera angles: a ready-made angle ({ preset }) or the architect's own numbers ({ lens, height, distance,
     * azimuth, pitch, straight, shiftX, shiftY, aspect, fill }); returns the camera now. */
    setCamera,
    get camera() { return cameraInfo(); },
    freeCamera,
    /** The front of the building: [x, z] out of its front, and where that came from (entrance, guessed, you). */
    setFront: (dir, from = "you") => setFront(dir, from),
    get front() { return { dir: [...front], from: frontFrom, entrance: entrance ? [...entrance] : null }; },
    onFront(fn) { onFront = fn; },
    /** "Make this side the front": the next click on a wall sets the front (the side the wall faces, outward). */
    pickFront() {
      return new Promise(res => {
        frontPick = hit => {
          const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 0, 1);
          n.y = 0; if (n.lengthSq() < 1e-6) { res(null); return; }
          n.normalize();
          const c = frameBox.getCenter(new THREE.Vector3());
          if (n.dot(hit.point.clone().sub(c).setY(0)) < 0) n.negate();   // outward
          setFront([n.x, n.z]); res([...front]);
        };
      });
    },
    showFront(on) { frontArrow.visible = !!on; placeArrow(); redraw(); },
    setFrameGuides(g) { frameGuides = { ...frameGuides, ...g }; drawFrame(); },
    guides, beginGuide, guideFrame, endGuide, along, shotPath, showPose, currentPose, materialGroups,
    /** Every part with its library material (for tests and the Materials panel): type, name, material, how, mean normal. */
    debugParts() {
      return elements.map(e => {
        const n = e.geometry.attributes.normal, s = [0, 0, 0];
        for (let i = 0; i < n.count; i++) { s[0] += n.getX(i); s[1] += n.getY(i); s[2] += n.getZ(i); }
        const L = Math.hypot(...s) || 1;
        return { type: e.userData.ifcType, name: e.userData.name, pre: e.userData.predefined, tag: e.userData.tag, mat: e.userData.mat?.id, how: e.userData.mat?.how, ifcName: e.userData.mat?.ifcName, seeThrough: (e.userData.mat && e.material.transparent) || false, n: s.map(x => x / L), userMat: e.userData.assigned?.id || null, face: e.userData.faceName || null, key: partKey(e) };
      });
    },
    get facts() {
      const b = frameBox, size = b.getSize(new THREE.Vector3());
      return { storeys: storeys.slice(), rooms: rooms().map(r => r.name), width_m: +size.x.toFixed(1), depth_m: +size.z.toFixed(1), height_m: +size.y.toFixed(1) };
    },
    engine() { return { THREE, scene, camera, renderer, elements, storeys, sun, hemi, ground, groundY, frame: frameBox.clone(), host, render: () => renderer.render(scene, camera), resize, sky, site, light: lightNow(), env: () => cubeRT.texture, classic: () => classicOn, quality }; },
  };
}
