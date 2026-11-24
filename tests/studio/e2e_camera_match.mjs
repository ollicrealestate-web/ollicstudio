// Matching a picture's camera: the test house is pictured from a known camera (30 mm, 38 degrees off the front,
// 2.5 m up), then the match starts from another camera (26 mm, 45 degrees, 1.6 m, 10% farther) and refines it from
// the edges alone. It must land within 2 mm of lens, 1 degree of angle and 2% of the distance.
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
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);
await page.evaluate(async doc => {
  const M = await import("./assets/sketch/model.js"), T = await import("./assets/sketch/aitools.js"), I = await import("./assets/sketch/ifc.js"), THREE = await import("three"), a = window.__sketch;
  a.loadDoc(M.normalize(doc));
  for (const [n, x] of [["add_cladding", { wall_ids: ["S1"], material: "mt-travertine" }], ["set_material", { element_ids: ["E1"], material: "mt-brick-red" }]]) T.runTool(a.history, n, x);
  const text = I.modelIfc(a, THREE, { name: "Match test" }).text;
  const R = await import("./assets/ifcread.js"), V = await import("./assets/viewer.js");
  const r = await R.readIfc(new TextEncoder().encode(text));
  const host = document.createElement("div"); host.style.cssText = "position:fixed;left:0;top:0;width:900px;height:600px;z-index:99"; document.body.append(host);
  const v = window.__studio = V.createViewer(host);
  await v.load(URL.createObjectURL(new Blob([r.glb], { type: "model/gltf-binary" })));
}, testBox());
await page.waitForFunction(async () => (await import("./assets/materials/look.js")).texturesReady(), null, { timeout: 120000, polling: 500 });

const res = await page.evaluate(async () => {
  const v = window.__studio, C = await import("./assets/cameramatch.js"), W = 360, H = 240;
  // the "picture": the realistic view from a known camera
  const truthBase = { preset: "corner-eye-right", aspect: 1.5, lens: 30, azimuth: 38, height: 2.5, straight: true, custom: true };
  const fitted = v.setCamera(truthBase), truth = { ...truthBase, distance: fitted.distance };
  v.setCamera(truth);
  const url = v.guides(W * 2, H * 2, ["view"]).view;
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d"); g.drawImage(img, 0, 0, W, H);
  const pic = C.prepare({ data: g.getImageData(0, 0, W, H).data, width: W, height: H });
  const score = s => { v.setCamera(s); return C.matchScore(pic, C.linesOf(v.linePixels(W, H))); };
  const atTruth = score(truth);
  const start = { ...truth, lens: 26, azimuth: 45, height: 1.6, distance: truth.distance * 1.1 };
  const atStart = score(start);
  const t0 = performance.now();
  const out = await C.matchView(v, img, start);
  v.setCamera(out.settings);
  return { truth, found: out.settings, atTruth, atStart, score: out.score, ms: performance.now() - t0, url };
});
writeFileSync(join(OUT, "camera-match-picture.jpg"), Buffer.from(res.url.split(",")[1], "base64"));
await page.screenshot({ path: join(OUT, "camera-match-result.png") });
const f = res.found, t = res.truth;
console.log(`     score: ${res.atStart.toFixed(1)} at the start, ${res.score.toFixed(1)} after (${res.atTruth.toFixed(1)} at the true camera), ${(res.ms / 1000).toFixed(0)} s`);
console.log(`     found: ${f.lens.toFixed(1)} mm, ${f.azimuth.toFixed(1)} deg, ${f.height.toFixed(2)} m up, ${f.distance.toFixed(2)} m (true: ${t.lens} mm, ${t.azimuth} deg, ${t.height} m, ${t.distance.toFixed(2)} m)`);
check(res.score > res.atStart + 10, "matching raises the score");
check(Math.abs(f.lens - t.lens) <= 2, `lens within 2 mm (${f.lens.toFixed(1)})`);
check(Math.abs(f.azimuth - t.azimuth) <= 1, `angle within 1 degree (${f.azimuth.toFixed(2)})`);
check(Math.abs(f.distance - t.distance) / t.distance <= 0.02 && Math.abs(f.height - t.height) / t.distance <= 0.02, `position within 2% of the distance (distance ${f.distance.toFixed(2)}, height ${f.height.toFixed(2)})`);
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nMatch a picture: all passed");
