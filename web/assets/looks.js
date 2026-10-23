// Realistic looks for the architect's model: each part's material class (glass, metal, brick,
// concrete...) comes from the IFC (see ifcread.js); here it becomes a physically based material,
// keeping the colour the architect chose, with fine surface detail drawn in the browser (no image
// files to download). Surfaces get box-projected texture coordinates in metres, so detail has
// real-world scale on every face.
import * as THREE from "three";

const SIZE = 512;
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

function canvas(draw) {
  const c = document.createElement("canvas"); c.width = c.height = SIZE;
  const g = c.getContext("2d"); draw(g); return c;
}
function speckle(g, n, lo, hi, rMax, alpha = 0.35) {
  for (let i = 0; i < n; i++) {
    const v = Math.floor(lo + (hi - lo) * rnd());
    g.fillStyle = `rgba(${v},${v},${v},${alpha * rnd()})`;
    const r = 0.5 + rnd() * rMax;
    g.fillRect(rnd() * SIZE, rnd() * SIZE, r, r);
  }
}
const DRAW = {
  concrete: g => { g.fillStyle = "#e9e9e9"; g.fillRect(0, 0, SIZE, SIZE); speckle(g, 26000, 150, 255, 2.2, 0.5); speckle(g, 400, 120, 200, 9, 0.12); },
  plaster: g => { g.fillStyle = "#f4f4f4"; g.fillRect(0, 0, SIZE, SIZE); speckle(g, 22000, 200, 255, 1.6, 0.4); },
  paint: g => { g.fillStyle = "#f6f6f6"; g.fillRect(0, 0, SIZE, SIZE); speckle(g, 9000, 215, 255, 1.2, 0.3); },
  stone: g => {
    g.fillStyle = "#ececec"; g.fillRect(0, 0, SIZE, SIZE); speckle(g, 600, 170, 245, 30, 0.18); speckle(g, 16000, 180, 255, 2, 0.35);
    g.strokeStyle = "rgba(160,160,160,0.25)"; g.lineWidth = 1.2;
    for (let i = 0; i < 6; i++) { g.beginPath(); let x = rnd() * SIZE, y = 0; g.moveTo(x, y); while (y < SIZE) { x += (rnd() - 0.5) * 40; y += 20 + rnd() * 30; g.lineTo(x, y); } g.stroke(); }
  },
  brick: g => {   // 4 courses of 215 x 65 mm bricks with 10 mm joints across 1.2 m
    g.fillStyle = "#c8c8c8"; g.fillRect(0, 0, SIZE, SIZE);
    const rows = 16, h = SIZE / rows, w = SIZE / 5.6;
    for (let r = 0; r < rows; r++) for (let c = -1; c < 7; c++) {
      const v = 205 + Math.floor(rnd() * 45); g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(c * w + (r % 2 ? w / 2 : 0) + 2, r * h + 2, w - 4, h - 4);
    }
    speckle(g, 12000, 150, 255, 1.5, 0.3);
  },
  tile: g => {
    g.fillStyle = "#cfcfcf"; g.fillRect(0, 0, SIZE, SIZE);
    const n = 2, s = SIZE / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const v = 238 + Math.floor(rnd() * 14); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(i * s + 2, j * s + 2, s - 4, s - 4); }
    speckle(g, 5000, 220, 255, 1.4, 0.25);
  },
  paving: g => {
    g.fillStyle = "#b9b9b9"; g.fillRect(0, 0, SIZE, SIZE);
    const n = 5, s = SIZE / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n * 2; j++) { const v = 190 + Math.floor(rnd() * 55); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(i * s + (j % 2 ? s / 2 : 0) + 2, j * s / 2 + 2, s - 4, s / 2 - 4); }
    speckle(g, 15000, 150, 255, 2, 0.35);
  },
  wood: g => {
    g.fillStyle = "#e2e2e2"; g.fillRect(0, 0, SIZE, SIZE);
    for (let y = 0; y < SIZE; y += 2) { const v = 205 + Math.floor(40 * (0.5 + 0.5 * Math.sin(y * 0.09 + Math.sin(y * 0.013) * 4)) + rnd() * 10); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, y, SIZE, 2); }
    speckle(g, 3000, 160, 230, 1.2, 0.2);
  },
  roof: g => { g.fillStyle = "#e4e4e4"; g.fillRect(0, 0, SIZE, SIZE); speckle(g, 20000, 160, 255, 2, 0.45); },
  grass: g => {
    g.fillStyle = "#8c9a6a"; g.fillRect(0, 0, SIZE, SIZE);
    for (let i = 0; i < 90; i++) { const t = rnd(); g.fillStyle = `rgba(${120 + t * 50},${128 + t * 40},${80 + t * 30},0.22)`; g.beginPath(); g.arc(rnd() * SIZE, rnd() * SIZE, 20 + rnd() * 70, 0, 7); g.fill(); }
    for (let i = 0; i < 45000; i++) { const t = rnd(); g.fillStyle = `rgba(${90 + t * 70},${105 + t * 70},${60 + t * 35},${0.35 * rnd()})`; g.fillRect(rnd() * SIZE, rnd() * SIZE, 1 + rnd() * 1.5, 2 + rnd() * 4); }
  },
  asphalt: g => { g.fillStyle = "#cfcfcf"; g.fillRect(0, 0, SIZE, SIZE); speckle(g, 30000, 90, 255, 1.8, 0.5); },
};
// metres one texture covers, and the material settings of each class
const LOOK = {
  glass: { metal: 0, rough: 0.03, env: 3.2 }, metal: { metal: 0.85, rough: 0.3, env: 1.2 }, ceramic: { metal: 0, rough: 0.15, env: 1.1 },
  concrete: { tex: "concrete", m: 2.4, rough: 0.88 }, plaster: { tex: "plaster", m: 1.6, rough: 0.92 }, paint: { tex: "paint", m: 1.6, rough: 0.8 },
  stone: { tex: "stone", m: 2.0, rough: 0.45, env: 0.8 }, brick: { tex: "brick", m: 1.2, rough: 0.9, bump: 0.6 }, tile: { tex: "tile", m: 1.2, rough: 0.28, bump: 0.3, env: 0.9 },
  paving: { tex: "paving", m: 1.0, rough: 0.9, bump: 0.5 }, wood: { tex: "wood", m: 1.0, rough: 0.55, env: 0.7 }, roof: { tex: "roof", m: 2.0, rough: 0.8 },
  grass: { tex: "grass", m: 4.0, rough: 1, tint: false }, asphalt: { tex: "asphalt", m: 2.0, rough: 0.95 }, furniture: { metal: 0, rough: 0.65 },
  space: { metal: 0, rough: 1 },
};
const texCache = new Map(), matCache = new Map();
function texture(name, { color = true } = {}) {
  const key = name + (color ? "" : "-lin");
  if (!texCache.has(key)) {
    seed = 7 + name.length * 131;
    const t = new THREE.CanvasTexture(canvas(DRAW[name]));
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texCache.set(key, t);
  }
  return texCache.get(key);
}

/** A realistic material for a part of class `cls` with the architect's colour (linear) and opacity. */
export function lookFor(cls, color, opacity = 1) {
  cls = LOOK[cls] ? cls : "paint";
  const key = `${cls}|${color.getHexString()}|${opacity.toFixed(2)}`;
  if (matCache.has(key)) return matCache.get(key);
  const L = LOOK[cls];
  let m;
  if (cls === "glass") {
    // reflective, slightly tinted glass: the sky and the building around show in it
    const c = color.clone().lerp(new THREE.Color("#1d2a33"), 0.72);
    m = new THREE.MeshPhysicalMaterial({ color: c, metalness: 0.15, roughness: L.rough, transparent: true, opacity: Math.min(0.78, Math.max(0.5, opacity + 0.35)),
      envMapIntensity: L.env, specularIntensity: 1, ior: 1.52, clearcoat: 1, clearcoatRoughness: 0.02, depthWrite: false, side: THREE.DoubleSide });
  } else if (cls === "space") {
    m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: Math.min(opacity, 0.15), depthWrite: false, side: THREE.DoubleSide });
  } else {
    m = new THREE.MeshStandardMaterial({ color: L.tint === false ? new THREE.Color("#ffffff") : color, metalness: L.metal || 0, roughness: L.rough,
      envMapIntensity: L.env ?? 0.6, side: THREE.DoubleSide, transparent: opacity < 0.99, opacity });
    if (L.tex) {
      m.map = texture(L.tex);
      m.bumpMap = texture(L.tex, { color: false }); m.bumpScale = L.bump ?? 0.25;
      m.userData.metres = L.m;
    }
  }
  m.userData.cls = cls;
  matCache.set(key, m);
  return m;
}

/** Material class for a part of an older 3D file (no class in its material name). */
export function guessClass(ifcType, opacity) {
  if (ifcType === "IfcSpace") return "space";
  if (opacity < 0.95) return "glass";
  return { IfcWindow: "metal", IfcDoor: "wood", IfcRailing: "metal", IfcMember: "metal", IfcRoof: "roof", IfcSlab: "concrete", IfcColumn: "concrete", IfcBeam: "concrete",
    IfcFooting: "concrete", IfcStair: "concrete", IfcStairFlight: "concrete", IfcWall: "plaster", IfcWallStandardCase: "plaster", IfcCovering: "plaster",
    IfcFurnishingElement: "furniture", IfcFurniture: "furniture", IfcCurtainWall: "glass", IfcPlate: "metal" }[ifcType] || "paint";
}

/** Texture coordinates in metres, projected from the axis each triangle faces most (no stretching). */
export function addUVs(geometry, metres) {
  const pos = geometry.attributes.position, n = pos.count, uv = new Float32Array(n * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nrm = new THREE.Vector3();
  const s = 1 / metres;
  const idx = geometry.index;
  const tri = idx ? idx.count / 3 : n / 3;
  for (let t = 0; t < tri; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    nrm.subVectors(c, b).cross(a.clone().sub(b));
    const ax = Math.abs(nrm.x), ay = Math.abs(nrm.y), az = Math.abs(nrm.z);
    for (const i of [i0, i1, i2]) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      let u, v;
      if (ay >= ax && ay >= az) { u = x; v = z; } else if (ax >= az) { u = z; v = y; } else { u = x; v = y; }
      uv[i * 2] = u * s; uv[i * 2 + 1] = v * s;
    }
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

export function grassTexture() { return texture("grass"); }
