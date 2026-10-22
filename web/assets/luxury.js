// "Luxury" look for the construction animation: a night scene with glowing gold setting-out
// lines and a gold wireframe of the building, then a line of light that sweeps up each hero
// view, turning the wireframe into the photoreal AI render of that same view.
//
// Layers (camera.layers): 0 = the building's solid surfaces, 1 = the sweep line (glow pass),
// 2 = gold lines, ghost fill, sky, stars, setting-out grid, 3 = the ground.
// Each frame: the scene is drawn with bloom into one target, a white mask of "the building
// below the sweep line, plus the ground" into another, the sweep line with bloom into a third;
// a final full-screen pass mixes the wireframe and the AI image through the mask and adds the glow.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const GOLD = new THREE.Color(1.0, 0.68, 0.3).multiplyScalar(1.8);
const RING = new THREE.Color(1.0, 0.8, 0.45).multiplyScalar(2.4);
const L_SOLID = 0, L_RING = 1, L_LINES = 2, L_GROUND = 3, L_SKY = 4;

function skyTexture() {
  const c = document.createElement("canvas"); c.width = 4; c.height = 256;
  const g = c.getContext("2d"), gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, "#040915"); gr.addColorStop(0.5, "#0f1f42"); gr.addColorStop(0.78, "#2c4170"); gr.addColorStop(1, "#4b5b82");
  g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function rand(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/**
 * ctx: viewer.engine(); items: the construction animation's elements ({mesh, t, group, ...});
 * frame: { centre, radius, groundY, footprint (Box3) }.
 */
export function createLuxury(ctx, items, { centre, radius, groundY, footprint }) {
  const { renderer, scene, camera, ground } = ctx;
  const saved = { bg: scene.background, fog: scene.fog, clip: renderer.localClippingEnabled, groundMat: ground.material, groundLayers: ground.layers.mask,
    exposure: renderer.toneMappingExposure, layers: camera.layers.mask, hidden: [] };
  renderer.localClippingEnabled = true;
  scene.background = new THREE.Color("#02040a"); scene.fog = null;
  // the viewer's own lights are kept for the solid fallback, but dimmed to night
  scene.traverse(o => { if (o.isLight) { saved.hidden.push([o, o.intensity]); o.intensity *= 0.35; } });
  const added = [];
  const add = (o, layer) => { o.layers.set(layer); scene.add(o); added.push(o); return o; };

  const sky = add(new THREE.Mesh(new THREE.SphereGeometry(radius * 30, 32, 16), new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, depthWrite: false, fog: false })), L_SKY);
  sky.position.copy(centre);
  const rnd = rand(7), sp = [];
  for (let i = 0; i < 1200; i++) { const a = rnd() * Math.PI * 2, e = rnd() * 1.25 + 0.12, R = radius * 28; sp.push(centre.x + Math.cos(a) * Math.cos(e) * R, centre.y + Math.sin(e) * R, centre.z + Math.sin(a) * Math.cos(e) * R); }
  add(new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(sp, 3)), new THREE.PointsMaterial({ color: "#d4dcff", size: 1.3, sizeAttenuation: false, fog: false })), L_SKY);
  const moon = add(new THREE.DirectionalLight("#9fb3e6", 0.9), L_SOLID); moon.position.set(centre.x - radius * 3, centre.y + radius * 4, centre.z + radius * 2);
  moon.layers.enableAll();
  const amb = add(new THREE.HemisphereLight("#6d82b8", "#1a1410", 0.8), L_SOLID); amb.layers.enableAll();

  ground.material = new THREE.MeshStandardMaterial({ color: "#101013", roughness: 0.9, metalness: 0.1, transparent: true, opacity: 1 });
  ground.layers.set(L_GROUND);

  // gold setting-out grid around the footprint, drawn outwards from the centre line
  const pad = Math.max(4, radius * 0.5), step = Math.max(1, Math.min(3, radius / 8)), gy = groundY + 0.02, gl = [];
  for (let x = footprint.min.x - pad; x <= footprint.max.x + pad + 1e-6; x += step) gl.push(x, gy, footprint.min.z - pad, x, gy, footprint.max.z + pad);
  for (let z = footprint.min.z - pad; z <= footprint.max.z + pad + 1e-6; z += step) gl.push(footprint.min.x - pad, gy, z, footprint.max.x + pad, gy, z);
  const gridMat = new THREE.LineBasicMaterial({ color: new THREE.Color(1, 0.7, 0.35).multiplyScalar(1.3), transparent: true, opacity: 0.5, toneMapped: false });
  const grid = add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(gl, 3)), gridMat), L_LINES);
  const fp = [[footprint.min.x, footprint.min.z], [footprint.max.x, footprint.min.z], [footprint.max.x, footprint.max.z], [footprint.min.x, footprint.max.z], [footprint.min.x, footprint.min.z]];
  const outline = add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(fp.map(([x, z]) => new THREE.Vector3(x, gy + 0.01, z))), new THREE.LineBasicMaterial({ color: RING, toneMapped: false })), L_LINES);

  // the sweep line: the footprint's outline at the reveal height
  const ringPts = fp.map(([x, z]) => new THREE.Vector3(x + Math.sign(x - centre.x) * 0.06, 0, z + Math.sign(z - centre.z) * 0.06));
  const ring = add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), new THREE.LineBasicMaterial({ color: RING, toneMapped: false })), L_RING);

  // each element: gold edges and a faint ghost fill (children, so they follow its animation),
  // and its solid surface clipped to below the sweep line
  const solidClip = new THREE.Plane(new THREE.Vector3(0, -1, 0), -1e6);
  const lineMat = new THREE.LineBasicMaterial({ color: GOLD, transparent: true, opacity: 0.95, toneMapped: false });
  const ghostMat = new THREE.MeshBasicMaterial({ color: "#7d93c8", transparent: true, opacity: 0.05, depthWrite: false });
  const parts = [];
  for (const it of items) {
    const m = it.mesh;
    const orig = m.material, mat = orig.clone();
    mat.clippingPlanes = [solidClip];
    if (it.t === "IfcWindow" || it.t === "IfcCurtainWall") { mat.color.set("#273250"); mat.emissive = new THREE.Color("#ffb35c"); mat.emissiveIntensity = 1.1; mat.transparent = false; mat.opacity = 1; }
    m.material = mat; m.layers.set(L_SOLID);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), lineMat); edges.layers.set(L_LINES);
    const ghost = new THREE.Mesh(m.geometry, ghostMat); ghost.layers.set(L_LINES);
    m.add(edges, ghost);
    parts.push({ m, orig, mat, edges, ghost });
  }

  // render targets and passes
  const size = new THREE.Vector2();
  const rtOpts = { type: THREE.HalfFloatType };
  const wire = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, rtOpts));
  wire.renderToScreen = false;
  wire.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.35, 1.0);
  wire.addPass(bloom); wire.addPass(new OutputPass());
  const glow = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, rtOpts));
  glow.renderToScreen = false;
  const glowRender = new RenderPass(scene, camera, null, new THREE.Color(0, 0, 0), 1);
  glow.addPass(glowRender); glow.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.75, 0.3, 0.25)); glow.addPass(new OutputPass());
  const maskRT = new THREE.WebGLRenderTarget(1, 1);
  const white = new THREE.MeshBasicMaterial({ color: "#fff", clippingPlanes: [solidClip] });
  const groundMask = new THREE.MeshBasicMaterial({ color: "#000" });

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { tWire: { value: null }, tMask: { value: null }, tGlow: { value: null }, tAI: { value: null }, hasAI: { value: 0 },
      aiAspect: { value: 1.5 }, frameAspect: { value: 1.78 }, zoom: { value: 1 }, skyK: { value: 0 }, black: { value: 0 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `
      uniform sampler2D tWire, tMask, tGlow, tAI; uniform float hasAI, aiAspect, frameAspect, zoom, skyK, black; varying vec2 vUv;
      void main(){
        vec2 uv = 0.5 + (vUv - 0.5) / zoom;
        vec3 w = texture2D(tWire, uv).rgb;
        vec3 col = w;
        if (hasAI > 0.5) {
          vec2 ai = aiAspect < frameAspect ? vec2(uv.x, 0.5 + (uv.y - 0.5) * aiAspect / frameAspect) : vec2(0.5 + (uv.x - 0.5) * frameAspect / aiAspect, uv.y);
          vec3 a = texture2D(tAI, ai).rgb;
          float m = clamp(max(texture2D(tMask, uv).r, skyK), 0.0, 1.0);
          col = mix(w, a, m);
        }
        col += texture2D(tGlow, uv).rgb;
        gl_FragColor = vec4(col * (1.0 - black), 1.0);
      }`,
    depthTest: false, depthWrite: false, toneMapped: false }));
  const quadScene = new THREE.Scene(); quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const textures = new Map();

  function ensureSize() {
    renderer.getDrawingBufferSize(size);
    if (wire.renderTarget1.width === size.x && wire.renderTarget1.height === size.y) return;
    wire.setPixelRatio(1); glow.setPixelRatio(1);
    wire.setSize(size.x, size.y); glow.setSize(size.x, size.y); maskRT.setSize(size.x, size.y);
  }
  function texture(img) {
    if (!img) return null;
    if (!textures.has(img)) { const t = new THREE.Texture(img); t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; textures.set(img, t); }
    return textures.get(img);
  }

  /**
   * state: { setK (0-1 grid drawn), gridOpacity, reveal: null | { h, image, groundK, skyK, zoom }, black }
   */
  function render(state) {
    ensureSize();
    const r = state.reveal;
    // the grid draws itself, then fades as the building rises
    grid.geometry.setDrawRange(0, Math.floor((gl.length / 3) * Math.max(0, Math.min(1, state.setK))));
    gridMat.opacity = state.gridOpacity; outline.visible = state.setK > 0.98 && state.gridOpacity > 0.05;
    const img = r && r.image ? texture(r.image) : null;
    // with an AI image the wireframe stays everywhere and the image comes in through the mask;
    // without one, the model's own surfaces fill in below the line
    solidClip.constant = r && !img ? r.h : -1e6;
    ring.visible = !!r && r.h > groundY + 0.02 && r.h < footprint.max.y + 0.3;
    if (r) ring.position.y = r.h;

    camera.layers.set(L_SOLID); camera.layers.enable(L_LINES); camera.layers.enable(L_GROUND); camera.layers.enable(L_SKY);
    wire.render();
    camera.layers.set(L_RING);
    const bg0 = scene.background; scene.background = null;
    glow.render();
    scene.background = bg0;
    if (img) {
      solidClip.constant = r.h;
      renderer.setRenderTarget(maskRT); renderer.setClearColor("#000", 1); renderer.clear();
      const ov = scene.overrideMaterial, bg = scene.background; scene.background = null;
      camera.layers.set(L_SOLID); scene.overrideMaterial = white; renderer.render(scene, camera);
      groundMask.color.setScalar(r.groundK); camera.layers.set(L_GROUND); scene.overrideMaterial = groundMask;
      const ac = renderer.autoClear; renderer.autoClear = false; renderer.render(scene, camera); renderer.autoClear = ac;
      scene.overrideMaterial = ov; scene.background = bg;
      solidClip.constant = -1e6;
    }
    camera.layers.set(L_SOLID); camera.layers.enable(L_LINES); camera.layers.enable(L_GROUND); camera.layers.enable(L_SKY);
    const u = quad.material.uniforms;
    u.tWire.value = wire.readBuffer.texture; u.tGlow.value = glow.readBuffer.texture; u.tMask.value = maskRT.texture;
    u.hasAI.value = img ? 1 : 0; u.tAI.value = img;
    if (img) u.aiAspect.value = r.image.naturalWidth / r.image.naturalHeight;
    u.frameAspect.value = size.x / size.y; u.zoom.value = r ? r.zoom : 1; u.skyK.value = r ? r.skyK : 0; u.black.value = state.black || 0;
    renderer.setRenderTarget(null);
    renderer.render(quadScene, quadCam);
  }

  /** The finished building, solid, at night, no lines: what the AI is given to make photoreal. */
  function renderSolid() {
    solidClip.constant = 1e6;
    camera.layers.set(L_SOLID); camera.layers.enable(L_GROUND); camera.layers.enable(L_SKY);
    renderer.setRenderTarget(null); renderer.render(scene, camera);
    camera.layers.set(L_SOLID); camera.layers.enable(L_LINES); camera.layers.enable(L_GROUND); camera.layers.enable(L_SKY);
    solidClip.constant = -1e6;
  }

  function dispose() {
    for (const p of parts) { p.m.remove(p.edges, p.ghost); p.edges.geometry.dispose(); p.m.material = p.orig; p.mat.dispose(); p.m.layers.set(0); }
    for (const o of added) { scene.remove(o); o.geometry?.dispose?.(); }
    for (const [o, v] of saved.hidden) o.intensity = v;
    ground.material.dispose(); ground.material = saved.groundMat; ground.layers.mask = saved.groundLayers;
    camera.layers.mask = saved.layers;
    scene.background = saved.bg; scene.fog = saved.fog; renderer.localClippingEnabled = saved.clip;
    wire.dispose(); glow.dispose(); maskRT.dispose(); textures.forEach(t => t.dispose());
    quad.geometry.dispose(); quad.material.dispose(); white.dispose(); groundMask.dispose(); lineMat.dispose(); ghostMat.dispose(); gridMat.dispose();
  }

  return { render, renderSolid, dispose };
}
