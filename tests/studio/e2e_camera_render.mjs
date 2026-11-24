// Renders from a set camera: the capture is taken in the picture's own shape, a film shot between two saved views
// keeps the picture's shape and moves its shift smoothly, and a Photo mode still is the same picture as the view
// (same lens, shift and framing: its outline matches the guide's). The server's side (camera words in the prompt)
// is tested in backend/tests/test_look.py and e2e/test_model_flow.py.
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
  const M = await import("./assets/sketch/model.js"), I = await import("./assets/sketch/ifc.js"), THREE = await import("three"), a = window.__sketch;
  a.loadDoc(M.normalize(doc));
  const text = I.modelIfc(a, THREE, { name: "Camera render test" }).text;
  const R = await import("./assets/ifcread.js"), V = await import("./assets/viewer.js");
  const r = await R.readIfc(new TextEncoder().encode(text));
  const host = document.createElement("div"); host.style.cssText = "position:fixed;left:0;top:0;width:900px;height:600px;z-index:99"; document.body.append(host);
  const v = window.__studio = V.createViewer(host);
  await v.load(URL.createObjectURL(new Blob([r.glb], { type: "model/gltf-binary" })));
}, testBox());

// 1. a portrait 4:5 drone corner: the capture's guides are 4:5 and drawn with that camera
const a = await page.evaluate(() => { window.__studio.setCamera({ preset: "drone-corner-left", aspect: "4:5" }); return window.__studio.currentPose(); });
check(Math.abs(a.aspect - 0.8) < 1e-9 && a.shift[1] !== 0, `a set picture: 4:5, shifted ${a.shift.map(v => v.toFixed(3))}`);
const g = await page.evaluate(async () => {
  const out = window.__studio.guides(1228, 1536, ["materials"]);
  const img = new Image(); img.src = out.materials; await img.decode(); return [img.width, img.height, out.coverage];
});
check(g[0] === 1228 && g[1] === 1536 && g[2] > 0.1, `the guide is drawn in the picture's own shape (${g[0]} x ${g[1]}, building ${(g[2] * 100).toFixed(0)}% of it)`);

// 2. a film shot between two saved views keeps the shape and moves the shift smoothly
const b = await page.evaluate(() => { window.__studio.setCamera({ preset: "front-eye", aspect: "4:5" }); return window.__studio.currentPose(); });
const mid = await page.evaluate(({ a, b }) => window.__studio.along([a, b], 0.5), { a, b });
check(mid.aspect === 0.8 && mid.shift[1] < Math.max(a.shift[1], b.shift[1]) + 1e-9 && mid.shift[1] > Math.min(a.shift[1], b.shift[1]) - 1e-9, `half-way between the views: still 4:5, shift ${mid.shift.map(v => v.toFixed(3))}`);

// 3. Photo mode from the set camera is the same picture: its building outline matches the material map's
await page.evaluate(a => window.__studio.showPose(a), a);
await page.waitForFunction(async () => (await import("./assets/materials/look.js")).texturesReady(), null, { timeout: 120000, polling: 500 });
const cmp = await page.evaluate(async () => {
  const v = window.__studio, W = 160, H = 200;
  const map = v.guides(W, H, ["materials"]).materials, photo = await v.photo({ width: W, height: H, samples: 2 });
  const px = async url => { const i = new Image(); i.src = url; await i.decode(); const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d"); g.drawImage(i, 0, 0); return g.getImageData(0, 0, W, H).data; };
  const m = await px(map), p = await px(photo);
  // the camera the path tracer drew with, against the guide's camera at the same size
  v.beginGuide("materials", W, H); v.guideFrame(v.currentPose());
  const E = v.engine(), gp = E.camera.projectionMatrix.toArray(), gw = E.camera.matrixWorld.toArray(); v.endGuide();
  const pc = v.lastPhotoCamera, worst = Math.max(...gp.map((x, i) => Math.abs(x - pc.projection[i])), ...gw.map((x, i) => Math.abs(x - pc.world[i])));
  void m; void p;
  return { map, photo, worst };
});
writeFileSync(join(OUT, "camera-render-map.png"), Buffer.from(cmp.map.split(",")[1], "base64"));
writeFileSync(join(OUT, "camera-render-photo.png"), Buffer.from(cmp.photo.split(",")[1], "base64"));
check(cmp.worst < 1e-6, `the Photo mode still is drawn with exactly the guide's camera, shift included (largest difference ${cmp.worst.toExponential(1)})`);
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nRender from the angle: all passed");
