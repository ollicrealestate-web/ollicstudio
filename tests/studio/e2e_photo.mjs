// Photo mode: the current view of the test house path-traced, refining sample by sample, saved as PNG; a 4K still
// is the right size; the view comes back as it was afterwards. (The headless browser draws on the CPU, so this test
// uses few samples; on a real graphics card a still refines in seconds.)
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "../sketch/e2e_phase1.mjs";
import { testBox } from "../sketch/testbox.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const OUT = process.argv[2] || "out/studio";
mkdirSync(OUT, { recursive: true });
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };
const srv = await serve();
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const pageLog = [];
page.on("console", m => { pageLog.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
page.on("console", m => { if (m.type() === "error" && !/wasm|404/.test(m.text())) errors.push(m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);
await page.evaluate(async doc => {
  const M = await import("./assets/sketch/model.js"), T = await import("./assets/sketch/aitools.js"), I = await import("./assets/sketch/ifc.js"), THREE = await import("three"), a = window.__sketch;
  a.loadDoc(M.normalize(doc));
  for (const [n, x] of [["add_cladding", { wall_ids: ["S1"], material: "mt-travertine" }], ["add_railing", { edges: ["F2:exposed"], type: "glass", height: 1100, material: "mt-steel-brushed" }],
    ["set_material", { element_ids: ["E1"], material: "mt-brick-red" }]]) { const r = T.runTool(a.history, n, x); if (!r.ok) throw new Error(r.error); }
  const text = I.modelIfc(a, THREE, { name: "Photo test" }).text;
  const R = await import("./assets/ifcread.js"), V = await import("./assets/viewer.js");
  const r = await R.readIfc(new TextEncoder().encode(text));
  const host = document.createElement("div"); host.style.cssText = "position:fixed;left:0;top:0;width:800px;height:500px;z-index:99"; document.body.append(host);
  const v = window.__studio = V.createViewer(host);
  await v.load(URL.createObjectURL(new Blob([r.glb], { type: "model/gltf-binary" })));
  // a 600 x 600 tiled terrace floor too, so the baked tiles are checked
  const slab = v.debugParts().find(p => p.type === "IfcSlab");
  if (slab) v.applyMaterial(slab.key, { id: "mt-tile-porcelain-grey-600" });
  const T3 = await import("three"), f = v.engine().frame, c = f.getCenter(new T3.Vector3()), s = f.getSize(new T3.Vector3()), d = Math.max(s.x, s.y, s.z);
  v.showPose({ position: [c.x + d * 0.95, c.y + d * 0.15, c.z + d * 1.25], target: [c.x, c.y - s.y * 0.1, c.z], fov: 45 });
}, testBox());
await page.waitForFunction(async () => (await import("./assets/materials/look.js")).texturesReady(), null, { timeout: 120000, polling: 500 });
await page.waitForTimeout(1500);
const viewBefore = await page.evaluate(() => window.__studio.engine().renderer.domElement.toDataURL("image/png").length);

// a small still with a few samples: it refines (progress goes up), and is a real picture
const t0 = Date.now();
// (on the CI servers, which draw slowly on a shared CPU, a smaller still with fewer samples)
const SMALL = process.env.CI ? { width: 320, height: 200, samples: 6 } : { width: 640, height: 400, samples: 24 };
const res = await page.evaluate(async S => {
  const steps = [];
  // a still that never finishes fails here after 5 minutes, saying how far it got (instead of holding up the run)
  const url = await Promise.race([
    window.__studio.photo({ ...S, onProgress: f => { steps.push(+f.toFixed(3)); console.log(`photo progress ${f.toFixed(3)}`); } }),
    new Promise(r => setTimeout(() => r(null), 300000))]);
  if (!url) return { timedOut: true, steps };
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data; let s = 0, s2 = 0; const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; s += l; s2 += l * l; }
  return { url, w: img.width, h: img.height, steps, mean: s / n, sd: Math.sqrt(s2 / n - (s / n) ** 2) };
}, SMALL);
if (res.timedOut) {
  console.log(`FAIL the still did not finish in 5 minutes (progress: ${res.steps.join(", ") || "none"}); page messages: ${pageLog.slice(-15).join(" | ")}`);
  await browser.close(); srv.close(); process.exit(1);
}
writeFileSync(join(OUT, "photo-mode.png"), Buffer.from(res.url.split(",")[1], "base64"));
console.log(`     ${res.steps.length} samples in ${((Date.now() - t0) / 1000).toFixed(0)} s (CPU-drawn)`);
check(res.w === SMALL.width && res.h === SMALL.height, "the still is the size asked for");
check(res.steps.length >= 2 && res.steps.at(-1) === 1 && res.steps.every((v, i) => !i || v >= res.steps[i - 1]), "it refines sample by sample to the end");
check(res.mean > 30 && res.mean < 245 && res.sd > 10, `a real picture (brightness ${res.mean.toFixed(0)}, contrast ${res.sd.toFixed(0)})`);

// 4K: one sample, to check the size only (minutes on a CPU: run with PHOTO_4K=1, or off the CI servers)
if (!process.env.CI || process.env.PHOTO_4K) {
  const big = await page.evaluate(async () => {
    const url = await window.__studio.photo({ width: 3840, height: 2160, samples: 1 });
    const img = new Image(); img.src = url; await img.decode(); return [img.width, img.height];
  });
  check(big[0] === 3840 && big[1] === 2160, `a 4K still is 3840 x 2160 (${big.join(" x ")})`);
}
// the view is back, and still answers
const after = await page.evaluate(() => { const E = window.__studio.engine(); return [E.renderer.domElement.width, E.renderer.domElement.height]; });
check(after[0] === 800 && after[1] === 500, `the 3D view is back at its own size (${after.join(" x ")})`);
check(viewBefore > 1000, "the view was drawn before");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nPhoto mode: all passed");
