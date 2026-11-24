// Realistic looks from the Ollic material library: photographed texture sets (colour, relief, roughness, ambient
// occlusion) at their real size, tiles drawn at their exact size with grout, each tile a different patch of the
// stone, and gentle variation so large surfaces show no repeat. Surfaces need texture coordinates in metres
// (see addMetricUVs). Until a texture has loaded the surface shows its plain colour, so the model appears at once.
import * as THREE from "three";
import { materialById } from "./library.js";

const BASE = new URL("./tex/", import.meta.url).href;
const MAPS = ["color", "normal", "rough", "ao"];
let sources = null, sourcesWait = null, onLoaded = () => {}, anisotropy = 8;
const loader = new THREE.TextureLoader();
const baseTex = new Map();   // "set/map" -> { tex, loaded, clones: Set }
const looks = new Map();     // key -> material
const MEAN_ROUGH = new Map(), MEAN_LUM = new Map();
// a plain colour close to each set's photo, shown until it has loaded
const PLAIN = { stone: "#cfc4b0", brick: "#a0563f", wood: "#9b7350", concrete: "#a4a29d", plaster: "#dcd8cf", paint: "#e8e5de", tile: "#e6e2da", roof: "#8a5a48",
  metal: "#9aa0a6", grass: "#5f7a3a", paving: "#a59b8c", asphalt: "#55555a", furniture: "#b9b2a8", glass: "#bcd9e6" };

/** Called once by the viewer: what to do when a texture arrives (redraw), and how sharp textures may be. */
export function setupLooks({ redraw, maxAnisotropy } = {}) { if (redraw) onLoaded = redraw; if (maxAnisotropy) anisotropy = Math.min(16, maxAnisotropy); }
/** Which maps each texture set has (tex/sources.json, written when the textures were fetched). */
export function loadSources() {
  if (!sourcesWait) sourcesWait = fetch(BASE + "sources.json").then(r => (r.ok ? r.json() : {})).catch(() => ({})).then(s => (sources = s));
  return sourcesWait;
}
export const setSources = s => { sources = s; };

function base(set, map) {
  const key = `${set}/${map}`;
  if (!baseTex.has(key)) {
    const rec = { tex: null, loaded: false, clones: new Set() };
    rec.tex = loader.load(`${BASE}${set}/${map}.jpg`, t => {
      rec.loaded = true;
      if (map === "rough") MEAN_ROUGH.set(set, meanOf(t.image));
      if (map === "color") MEAN_LUM.set(set, meanOf(t.image, true));
      for (const c of rec.clones) c.userData.onReady?.();
      rec.clones.clear();
      onLoaded();
    }, undefined, () => { rec.failed = true; });
    rec.tex.colorSpace = map === "color" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    baseTex.set(key, rec);
  }
  return baseTex.get(key);
}
/** The average of a picture: its first channel (roughness), or its light in linear terms (colour). */
function meanOf(img, lum = false) {
  try {
    const c = document.createElement("canvas"); c.width = c.height = 32; const g = c.getContext("2d"); g.drawImage(img, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data, lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += lum ? 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]) : d[i] / 255;
    return Math.max(0.01, s / (d.length / 4));
  } catch { return lum ? 0.3 : 0.6; }
}
/**
 * A copy of a set's map with its own size, rotation and offset (the picture itself is shared), put on the material
 * only once the picture has arrived: until then the surface shows its plain colour (never black).
 */
function attachMap(mat, slot, set, map, { repeat, rotation, offset }, onReady) {
  const rec = base(set, map), t = rec.tex.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = anisotropy;
  t.repeat.set(repeat, repeat); t.rotation = rotation; t.offset.set(offset[0] * repeat, offset[1] * repeat);
  const put = () => { mat[slot] = t; t.needsUpdate = true; mat.needsUpdate = true; onReady?.(); };
  t.userData.onReady = put;
  if (rec.loaded) put(); else rec.clones.add(t);
  return t;
}
const has = (set, map) => !sources || !sources[set] || (sources[set].maps || MAPS).includes(map);
let white = null;
const whiteTex = () => { if (!white) { white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.wrapS = white.wrapT = THREE.RepeatWrapping; white.needsUpdate = true; } return white; };

/**
 * The material for a library id. o: { tint (hex: replaces the colour), scale (x the real size), rotation (degrees),
 * rough (0-1), offset ([u, v] metres), opacity (glass from the IFC), quality ("fast" | "high" | "best") }.
 */
export function materialLook(id, o = {}) {
  const m = materialById(id);
  if (!m) return null;
  const quality = o.quality || "high";
  const key = JSON.stringify([id, o.tint || null, o.scale || 1, o.rotation || 0, o.rough ?? null, o.offset || null, o.opacity ?? null, quality]);
  if (looks.has(key)) return looks.get(key);
  const colour = new THREE.Color(o.tint || m.color);
  const size = (m.size || 1) * (o.scale || 1), repeat = 1 / size, rotation = ((o.rotation || 0) * Math.PI) / 180, offset = o.offset || [0, 0];
  let mat;
  if (m.cls === "glass") {
    const op = m.opacity ?? 0.35;
    mat = new THREE.MeshPhysicalMaterial({ color: colour, metalness: m.metal ?? 0.05, roughness: o.rough ?? m.rough, transparent: true, opacity: Math.min(0.85, Math.max(op, o.opacity != null ? Math.min(0.85, o.opacity + 0.3) : op)),
      ior: 1.52, specularIntensity: 1, envMapIntensity: 2.6, clearcoat: 1, clearcoatRoughness: 0.03, depthWrite: false, side: THREE.DoubleSide });
  } else {
    // a coloured material (a paint colour, red stone-coated tiles, bronze aluminium) takes its exact colour from the
    // library or the IFC and only the relief and grain from the photo; a photographed one (travertine) is the photo
    const detail = !!m.set && (!!o.tint || m.color.toLowerCase() !== "#ffffff");
    mat = new THREE.MeshPhysicalMaterial({ color: m.set && !detail ? new THREE.Color(PLAIN[m.cls] || "#cccccc") : colour, metalness: m.metal ?? 0, roughness: o.rough ?? m.rough,
      envMapIntensity: m.cls === "metal" ? 1.1 : 0.7, side: THREE.DoubleSide, emissive: m.emissive ? new THREE.Color(m.emissive) : new THREE.Color(0), emissiveIntensity: m.emissive ? 1.2 : 0 });
    if (m.cls === "tile" || m.cls === "stone") { mat.clearcoat = m.rough < 0.3 ? 0.6 : 0; mat.clearcoatRoughness = 0.08; }
    const tr = { repeat, rotation, offset };
    const breakup = !!m.set && !m.tile && quality !== "fast" && (m.size || 1) >= 1;
    if (m.tile || detail || breakup) addShaderTouches(mat, m, size, { breakup });
    if (m.set) {
      const ready = () => {
        mat.color.copy(colour);
        if (detail) mat.userData.uniforms.uMean.value = MEAN_LUM.get(m.set) || 0.3;
        const mr = MEAN_ROUGH.get(m.set); if (mr && o.rough == null && mat.roughnessMap) mat.roughness = Math.min(1, m.rough / Math.max(0.15, mr));
      };
      if (has(m.set, "color")) attachMap(mat, "map", m.set, "color", tr, ready);
      if (quality !== "fast" && has(m.set, "normal")) { attachMap(mat, "normalMap", m.set, "normal", tr); mat.normalScale.set(0.9, 0.9); }
      if (quality !== "fast" && has(m.set, "rough")) attachMap(mat, "roughnessMap", m.set, "rough", tr, ready);
      if (quality !== "fast" && has(m.set, "ao")) { attachMap(mat, "aoMap", m.set, "ao", tr); mat.aoMapIntensity = 0.8; }
    } else if (m.tile) {
      mat.map = whiteTex().clone(); mat.map.repeat.set(repeat, repeat); mat.map.rotation = rotation; mat.map.needsUpdate = true;   // gives the tiles their grid in metres
    }
  }
  Object.assign(mat.userData, { lib: id, cls: m.cls, metres: 1 });
  mat.name = `ollic:${m.cls}`;
  looks.set(key, mat);
  return mat;
}

/** Tiles at their exact size (grout, each tile its own patch and shade) and, on large surfaces, no visible repeat. */
function addShaderTouches(mat, m, size, { breakup }) {
  const T = m.tile;
  const uni = { uMean: { value: 0 }, uSize: { value: size }, uTile: { value: new THREE.Vector2(T?.w || 1, T?.h || 1) }, uGrout: { value: T?.grout || 0 }, uOffset: { value: T?.offset || 0 },
    uGroutColor: { value: new THREE.Color(T?.groutColor || "#cccccc") } };
  mat.userData.uniforms = uni;
  mat.customProgramCacheKey = () => `ollic-${T ? "tile" : ""}-${breakup ? "breakup" : ""}`;
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, uni);
    sh.defines = { ...(sh.defines || {}), ...(T ? { OLLIC_TILES: "" } : {}), ...(breakup ? { OLLIC_BREAKUP: "" } : {}) };
    sh.fragmentShader = sh.fragmentShader.replace("void main() {", `uniform float uMean; uniform float uSize; uniform vec2 uTile; uniform float uGrout; uniform float uOffset; uniform vec3 uGroutColor;
float ollicHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float ollicNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(ollicHash(i), ollicHash(i + vec2(1, 0)), f.x), mix(ollicHash(i + vec2(0, 1)), ollicHash(i + vec2(1, 1)), f.x), f.y); }
void main() {
  float ollicGrout = 0.0; vec2 ollicShift = vec2(0.0); float ollicShade = 1.0;`)
      .replace("#include <map_fragment>", `
#ifdef USE_MAP
  vec2 muv = vMapUv;
  #ifdef OLLIC_TILES
    vec2 mm = vMapUv * uSize * 1000.0;
    float row = floor(mm.y / uTile.y);
    mm.x += row * uOffset * uTile.x;
    vec2 cell = floor(mm / uTile);
    vec2 inTile = mm - cell * uTile;
    float g = uGrout * 0.5;
    ollicGrout = 1.0 - step(g, inTile.x) * step(inTile.x, uTile.x - g) * step(g, inTile.y) * step(inTile.y, uTile.y - g);
    float r = ollicHash(cell);
    ollicShift = vec2(r, ollicHash(cell + 7.1));
    ollicShade = 0.95 + 0.1 * r;
    muv += ollicShift;
  #endif
  vec4 texel = texture2D(map, muv);
  #ifdef OLLIC_BREAKUP
    float n = ollicNoise(vMapUv * 0.37);
    vec2 uv2 = mat2(0.8660, -0.5, 0.5, 0.8660) * vMapUv * 0.87 + vec2(0.37, 0.71);
    texel = mix(texel, texture2D(map, uv2), smoothstep(0.3, 0.7, n));
    ollicShade = 0.96 + 0.08 * ollicNoise(vMapUv * 0.11 + 3.0);
  #endif
  if (uMean > 0.0) texel.rgb = vec3(min(2.5, dot(texel.rgb, vec3(0.2126, 0.7152, 0.0722)) / uMean));   // grain only, the colour is exact
  diffuseColor *= texel;
  diffuseColor.rgb *= ollicShade;
  diffuseColor.rgb = mix(diffuseColor.rgb, uGroutColor, ollicGrout);
#endif`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.95, ollicGrout);");
  };
}

/** Texture coordinates in metres, from the axis each triangle faces most, so nothing stretches on any face. */
export function addMetricUVs(geometry) {
  const pos = geometry.attributes.position, n = pos.count, uv = new Float32Array(n * 2), idx = geometry.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nrm = new THREE.Vector3(), e = new THREE.Vector3();
  const tri = idx ? idx.count / 3 : n / 3;
  for (let t = 0; t < tri; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    nrm.subVectors(c, b).cross(e.subVectors(a, b));
    const ax = Math.abs(nrm.x), ay = Math.abs(nrm.y), az = Math.abs(nrm.z);
    for (const i of [i0, i1, i2]) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      // walls: along the wall and up (so courses and grain run level); floors and roofs: plan
      let u, v;
      if (ay >= ax && ay >= az) { u = x; v = -z; } else if (ax >= az) { u = -z * Math.sign(nrm.x || 1); v = y; } else { u = x * Math.sign(nrm.z || 1); v = y; }
      uv[i * 2] = u; uv[i * 2 + 1] = v;
    }
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}
/** Whether every texture asked for so far has arrived (for tests and Photo mode). */
export const texturesReady = () => [...baseTex.values()].every(r => r.loaded || r.failed);
