// A small picture of a material: a sphere and a square of wall (1.2 m) side by side, lit by a sunny sky, for the
// Materials panel and for checking a material made from a photo. One drawing surface is shared by all previews.
import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { materialLook, addMetricUVs, setupLooks } from "./look.js";

let R = null;
function setup() {
  if (R) return R;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
  renderer.setPixelRatio(1); renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.8;
  const scene = new THREE.Scene();
  const sky = new Sky(); sky.scale.setScalar(100);
  const u = sky.material.uniforms; u.turbidity.value = 2.2; u.rayleigh.value = 1.6; u.sunPosition.value.set(0.5, 0.7, 0.6);
  const sk = new THREE.Scene(); sk.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(sk, 0.02).texture; scene.environmentIntensity = 0.7;
  const sun = new THREE.DirectionalLight("#fff1dc", 2.6); sun.position.set(2, 3, 4); scene.add(sun);
  scene.add(new THREE.HemisphereLight("#dfe9ff", "#5a5140", 0.35));
  const sg = new THREE.SphereGeometry(0.55, 64, 32); addMetricUVs(sg);
  const wg = new THREE.PlaneGeometry(1.2, 1.2); addMetricUVs(wg);
  const sphere = new THREE.Mesh(sg), wall = new THREE.Mesh(wg);
  sphere.position.set(-0.75, 0, 0); wall.position.set(0.75, 0, 0);
  scene.add(sphere, wall);
  const cam = new THREE.OrthographicCamera(-1.5, 1.5, 0.75, -0.75, 0.1, 10); cam.position.set(0, 0, 3);
  R = { renderer, scene, sphere, wall, cam, pending: new Set() };
  setupLooks({ redraw: () => R.pending.forEach(f => f()) });
  return R;
}
/**
 * Draws spec ({ id, tint, scale, rotation, rough, offset }) into a canvas (any size, 2:1 looks best) and again when
 * its textures arrive. Returns a function that stops redrawing it.
 */
export function drawPreview(canvas, spec) {
  const r = setup();
  const draw = () => {
    const m = spec?.id && materialLook(spec.id, { tint: spec.tint, scale: spec.scale, rotation: spec.rotation, rough: spec.rough, offset: spec.offset });
    r.sphere.visible = r.wall.visible = !!m;
    if (m) { r.sphere.material = m; r.wall.material = m; }
    const w = canvas.width, h = canvas.height;
    r.renderer.setSize(w, h, false);
    r.renderer.setClearColor(0x000000, 0);
    r.renderer.render(r.scene, r.cam);
    const g = canvas.getContext("2d"); g.clearRect(0, 0, w, h); g.drawImage(r.renderer.domElement, 0, 0, w, h);
  };
  r.pending.forEach(f => { if (f.canvas === canvas) r.pending.delete(f); });
  draw.canvas = canvas;
  r.pending.add(draw);
  draw();
  return () => r.pending.delete(draw);
}
