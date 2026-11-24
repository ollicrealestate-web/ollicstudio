// Photo mode: a still picture of the current view made by path tracing (light bouncing as it really does: soft
// shadows, light reflected between walls, real reflections in glass and polished stone). It refines sample by sample
// and is saved as a PNG up to 4K. Uses the same materials, light, sky, ground and paving as the 3D view.
import * as THREE from "three";
import { WebGLPathTracer } from "../../vendor/three-gpu-pathtracer/index.module.js";
import { findMaterial, addMetricUVs } from "./look.js";

/** The colour picture of a coloured material as grain only (brightness / its average), for the path tracer. */
function grainOf(tex) {
  const img = tex.image, c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  const g = c.getContext("2d"); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height), a = d.data, lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  let m = 0; for (let i = 0; i < a.length; i += 4) m += 0.2126 * lin(a[i]) + 0.7152 * lin(a[i + 1]) + 0.0722 * lin(a[i + 2]); m /= a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const l = Math.min(1, (0.2126 * lin(a[i]) + 0.7152 * lin(a[i + 1]) + 0.0722 * lin(a[i + 2])) / m / 2.5) ;   // up to 2.5x the average
    const s = (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055) * 255;
    a[i] = a[i + 1] = a[i + 2] = s;
  }
  g.putImageData(d, 0, 0);
  return c;
}
/**
 * Tiles drawn as the 3D view draws them (each tile its own patch of the stone, a touch of shade, grout at its exact
 * width), baked into a picture of 4 x 4 tiles that repeats.
 */
function tilesOf(srcCanvasOrImage, m, size, T) {
  const n = 4, px = 256, W = n * px, H = Math.round(n * px * T.h / T.w), c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d"), pat = g.createPattern(srcCanvasOrImage, "repeat"), imgW = srcCanvasOrImage.width;
  const tileM = T.w / 1000, scale = (tileM / size) * imgW / px;   // source pixels per baked pixel
  let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const th = H / n;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x0 = (i + (T.offset ? (j * T.offset) % 1 : 0)) * px, r = rnd();
    for (const dx of [0, -W]) {   // running bond wraps round
      g.save(); g.beginPath(); g.rect(x0 + dx, j * th, px, th); g.clip();
      g.translate(x0 + dx, j * th); g.scale(1 / scale, 1 / scale); g.translate(-r * imgW, -rnd() * imgW);
      g.fillStyle = pat; g.fillRect(r * imgW - 1, 0, px * scale + 2, th * scale + imgW); g.restore();
      g.fillStyle = `rgba(${r < 0.5 ? "0,0,0" : "255,255,255"},${Math.abs(r - 0.5) * 0.1})`; g.fillRect(x0 + dx, j * th, px, th);
    }
  }
  const gw = Math.max(1, T.grout / T.w * px);
  g.fillStyle = T.groutColor || "#cccccc";
  for (let j = 0; j <= n; j++) g.fillRect(0, j * th - gw / 2, W, gw);
  for (let j = 0; j < n; j++) for (let i = 0; i <= n; i++) { const x = (i + (T.offset ? (j * T.offset) % 1 : 0)) * px; for (const dx of [0, -W, W]) g.fillRect(x + dx - gw / 2, j * th, gw, th); }
  return c;
}
/** A picture that can be drawn on a canvas (a data texture's pixels become a canvas). */
function drawable(img) {
  if (!img || img instanceof HTMLImageElement || img instanceof HTMLCanvasElement || (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap)) return img;
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  const d = new ImageData(img.width, img.height); d.data.set(img.data.length === d.data.length ? img.data : new Uint8ClampedArray(d.data.length).fill(255)); c.getContext("2d").putImageData(d, 0, 0);
  return c;
}
/** A copy of a 3D-view material the path tracer (and a GLB file) can read (no shader touches; glass that light passes through). */
export function forPathTracing(mat, cache) {
  if (cache.has(mat)) return cache.get(mat);
  let out = mat;
  const lib = mat.userData?.lib && findMaterial(mat.userData.lib), u = mat.userData?.uniforms;
  if (lib?.cls === "glass") {
    out = new THREE.MeshPhysicalMaterial({ color: mat.color, roughness: Math.min(0.08, mat.roughness), metalness: 0, transmission: lib.id === "mt-glass-frosted" ? 0.85 : 0.92,
      ior: 1.5, thickness: 0.006, transparent: false, opacity: 1, side: THREE.DoubleSide });
    if (lib.id === "mt-glass-frosted") out.roughness = 0.45;
    if (lib.id === "mt-water") { out.transmission = 0.8; out.color = new THREE.Color("#5aa7bf"); }
  } else if (u && mat.map?.image) {
    out = mat.clone(); out.onBeforeCompile = () => {}; out.customProgramCacheKey = () => "pt";
    let src = drawable(mat.map.image);
    if (u.uMean.value > 0) src = grainOf(mat.map);                  // coloured: the exact colour times the grain
    const T = lib?.tile;
    if (T) {
      const size = u.uSize.value, baked = new THREE.CanvasTexture(tilesOf(src, lib, size, T));
      baked.colorSpace = THREE.SRGBColorSpace; baked.wrapS = baked.wrapT = THREE.RepeatWrapping;
      const across = 4 * T.w / 1000, up = 4 * T.h / 1000;
      baked.repeat.set(1 / across, 1 / up); baked.rotation = mat.map.rotation; baked.offset.copy(mat.map.offset).multiply(new THREE.Vector2(size / across, size / up));
      out.map = baked;
    } else if (src !== mat.map.image) {
      const t = new THREE.CanvasTexture(src); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.copy(mat.map.repeat); t.offset.copy(mat.map.offset); t.rotation = mat.map.rotation; out.map = t;
    }
  } else if (mat.transparent && mat.opacity < 1) {
    out = mat.clone(); out.transparent = false; out.transmission = 1 - mat.opacity; out.opacity = 1;
  }
  cache.set(mat, out);
  return out;
}

/**
 * Renders the viewer's current view. engine: viewer.engine(). o: { width, height, samples, onProgress(fraction,
 * canvas), signal (AbortSignal) }. Returns a PNG data URL.
 */
export async function renderPhoto(engine, { width = 1920, height = 1080, samples = 128, onProgress = () => {}, signal } = {}) {
  const { scene, camera, renderer, elements, ground, site, sun } = engine;
  // the scene for the path tracer: the building (what is shown), the ground, the paving and the sun
  const pt = new THREE.Scene(), cache = new Map();
  const shown = elements.filter(e => e.visible && e.userData.ifcType !== "IfcSpace" && e.userData.cls !== "space");
  for (const e of shown) {
    const m = new THREE.Mesh(e.geometry, forPathTracing(e._look || e.material, cache));
    e.updateWorldMatrix(true, false); m.matrixAutoUpdate = false; m.matrix.copy(e.matrixWorld); m.matrixWorld.copy(e.matrixWorld);
    pt.add(m);
  }
  if (ground.visible) {
    const geo = new THREE.CircleGeometry(400, 64); addMetricUVs(geo);
    const g = new THREE.Mesh(geo, forPathTracing(ground.material, cache));
    g.rotation.x = -Math.PI / 2; g.position.copy(ground.position); g.updateMatrixWorld(); pt.add(g);
  }
  if (site.visible) for (const s of site.children) { const m = new THREE.Mesh(s.geometry, forPathTracing(s.material, cache)); m.matrix.copy(s.matrixWorld); m.matrixAutoUpdate = false; m.matrixWorld.copy(s.matrixWorld); pt.add(m); }
  const sunPT = new THREE.DirectionalLight(sun.color, sun.intensity); sunPT.position.copy(sun.position); sunPT.target.position.copy(sun.target.position);
  pt.add(sunPT, sunPT.target); sunPT.updateMatrixWorld(); sunPT.target.updateMatrixWorld();
  const sky = engine.env();
  pt.environment = sky; pt.background = sky; pt.environmentIntensity = scene.environmentIntensity ?? 1; pt.backgroundIntensity = 1;

  // draw at the photo's size, then put the view back as it was
  const before = { size: renderer.getSize(new THREE.Vector2()), pr: renderer.getPixelRatio(), aspect: camera.aspect };
  renderer.setPixelRatio(1); renderer.setSize(width, height, false);
  const cam = camera.clone(); cam.aspect = width / height; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  engine.lastCamera?.(cam);   // (for tests: the camera the path tracer draws with)
  const tracer = new WebGLPathTracer(renderer);
  tracer.renderScale = 1; tracer.dynamicLowRes = false; tracer.minSamples = 1; tracer.renderDelay = 0; tracer.fadeDuration = 0;
  tracer.tiles.set(width > 2000 ? 3 : 2, width > 2000 ? 3 : 2); tracer.bounces = 6; tracer.filterGlossyFactor = 0.5; tracer.multipleImportanceSampling = true;
  try {
    tracer.setScene(pt, cam);
    while (tracer.samples < samples) {
      if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
      tracer.renderSample();
      onProgress(Math.min(1, tracer.samples / samples), renderer.domElement);
      await new Promise(r => requestAnimationFrame(r));
    }
    return renderer.domElement.toDataURL("image/png");
  } finally {
    try { tracer.dispose(); } catch { /* nothing made yet */ }
    for (const m of new Set(cache.values())) if (![...cache.keys()].includes(m)) { m.map?.isCanvasTexture && m.map.dispose(); m.dispose(); }
    renderer.setPixelRatio(before.pr); renderer.setSize(before.size.x, before.size.y, false);
    camera.aspect = before.aspect; camera.updateProjectionMatrix();
    engine.resize?.();
  }
}
