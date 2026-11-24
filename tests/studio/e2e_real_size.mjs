// Materials at their real size: a 600 x 600 mm tile on a 3 m wall shows exactly 5 tiles across and 5 up, measured
// in a rendered picture (the grout drawn in a test colour and counted along a line). Also: every library material
// draws without errors, textures arrive, and surfaces never show black while a texture is loading.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "../sketch/e2e_phase1.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const OUT = process.argv[2] || "out/studio";
mkdirSync(OUT, { recursive: true });
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };
const srv = await serve();
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error" && !/wasm|404/.test(m.text())) errors.push(m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);

// draws a 3 x 3 m wall (x 0..3, y 0..3) face on, 600 x 600 pixels, with the given material; returns the pixels
const wall = (id, opts = {}) => page.evaluate(async ({ id, opts }) => {
  const THREE = await import("three"), L = await import("./assets/materials/look.js");
  await L.loadSources();
  const r = window.__rs ||= new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
  const N = opts.N || 600; r.setSize(N, N, false); r.setPixelRatio(1); r.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(); scene.add(new THREE.AmbientLight("#ffffff", 3));
  const g = new THREE.BoxGeometry(3, 3, 0.2); g.translate(1.5, 1.5, -0.1); L.addMetricUVs(g);
  const mat = L.materialLook(id, opts);
  const mesh = new THREE.Mesh(g, mat); scene.add(mesh);
  const cam = new THREE.OrthographicCamera(0, 3, 3, 0, 0.1, 10); cam.position.set(0, 0, 5);
  const start = Date.now();
  let blackWhileLoading = false;
  r.render(scene, cam);
  { const px = new Uint8Array(4); const gl = r.getContext(); gl.readPixels(N / 2, N / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); if (px[0] + px[1] + px[2] < 30 && !opts.dark) blackWhileLoading = true; }
  while (!L.texturesReady() && Date.now() - start < 60000) await new Promise(res => setTimeout(res, 100));
  await new Promise(res => setTimeout(res, 50));
  if (opts.red && mat.userData.uniforms) mat.userData.uniforms.uGroutColor.value.set("#ff0000");
  r.render(scene, cam);
  const c = document.createElement("canvas"); c.width = c.height = N; const x = c.getContext("2d"); x.drawImage(r.domElement, 0, 0);
  const data = x.getImageData(0, 0, N, N).data;
  if (opts.summary) { const avg = [0, 1, 2].map(k => { let s = 0; for (let i = k; i < data.length; i += 400) s += data[i]; return s / (data.length / 400); }); return { avg, blackWhileLoading }; }
  return { N, px: Array.from(data), png: c.toDataURL("image/png"), blackWhileLoading, hasMap: !!mat.map };
}, { id, opts });

// 1. real size: count the tiles between grout lines along a horizontal and a vertical line
const t = await wall("mt-tile-porcelain-white-600", { red: true, N: 1800 });   // 0.6 pixels per mm: the 3 mm grout is 2 pixels wide
writeFileSync(join(OUT, "real-size-600-tile.png"), Buffer.from(t.png.split(",")[1], "base64"));
const N = t.N, red = (x, y) => { const i = (y * N + x) * 4; return t.px[i] > 150 && t.px[i] > t.px[i + 1] * 1.6 && t.px[i] > t.px[i + 2] * 1.6; };
const runs = cells => { let n = 0, inTile = false; for (const c of cells) { if (!c && !inTile) n++; inTile = !c; } return n; };
const across = runs([...Array(N).keys()].map(x => red(x, 1000))), up = runs([...Array(N).keys()].map(y => red(1000, y)));
check(across === 5 && up === 5, `600 x 600 tile on a 3 m wall: ${across} tiles across, ${up} up (expected 5 and 5)`);
check(t.hasMap, "the tile's stone texture loaded");

// 2. every library material draws, without black while loading
const { ids } = await page.evaluate(async () => ({ ids: (await import("./assets/materials/library.js")).MATERIALS.map(m => m.id) }));
check(ids.length >= 80, `the library has ${ids.length} materials (at least 80)`);
const black = [], missing = [];
for (const id of ids) {
  const w = await wall(id, { summary: true, dark: /charcoal|black|rubber|asphalt|walnut|mahogany|slate|stone-dark|marble-black|alu-black|granite-black|steel-painted|tile-porcelain-black/.test(id) });
  if (w.blackWhileLoading) black.push(id);
  if (w.avg.every(v => v < 8)) missing.push(id);
}
check(!black.length, `no surface is black while its texture loads ${black.join(", ")}`);
check(!missing.length, `every material draws something ${missing.join(", ")}`);
const sources = await page.evaluate(async () => (await fetch("./assets/materials/tex/sources.json")).json());
const libSets = await page.evaluate(async () => [...new Set((await import("./assets/materials/library.js")).MATERIALS.map(m => m.set).filter(Boolean))]);
const noSource = libSets.filter(s => !sources[s] || !/^CC0/.test(sources[s].licence || ""));
check(!noSource.length, `every texture set has its source and a CC0 licence recorded ${noSource.join(", ")}`);
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nReal size and library: all passed");
