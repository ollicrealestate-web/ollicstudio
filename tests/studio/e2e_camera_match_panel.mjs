// Match a picture's angle from the Camera panel, as a person would: choose a picture of the building (here, the
// model pictured from a known camera), see it over the view, ask Ollic AI for a rough start (a stand-in answer),
// nudge, fine-tune automatically, and save the result as a view. The accuracy itself is tested in e2e_camera_match.mjs.
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
const page = await browser.newPage({ viewport: { width: 1300, height: 1800 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);
const truth = await page.evaluate(async doc => {
  const M = await import("./assets/sketch/model.js"), I = await import("./assets/sketch/ifc.js"), THREE = await import("three"), a = window.__sketch;
  a.loadDoc(M.normalize(doc));
  const text = I.modelIfc(a, THREE, { name: "Match panel test" }).text;
  const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "./assets/styles.css"; document.head.append(css);
  await new Promise(r => { css.onload = r; setTimeout(r, 3000); });
  const R = await import("./assets/ifcread.js"), V = await import("./assets/viewer.js"), P = await import("./assets/camerapanel.js");
  const wrap = document.createElement("div"); wrap.id = "studioTest"; wrap.style.cssText = "position:fixed;inset:0;z-index:50;background:#fff;overflow:auto"; document.body.append(wrap);
  const host = document.createElement("div"); host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:600px"; wrap.append(host);
  const panel = document.createElement("div"); panel.style.cssText = "position:absolute;left:0;top:610px;width:1280px"; wrap.append(panel);
  const r = await R.readIfc(new TextEncoder().encode(text));
  const v = window.__studio = V.createViewer(host);
  await v.load(URL.createObjectURL(new Blob([r.glb], { type: "model/gltf-binary" })));
  window.__asked = 0;
  window.__panel = P.createCameraPanel({ root: panel, viewer: v, store: {
    load: async () => ({}), save: async b => { window.__saved = b; }, words: async () => null,
    match: async (blob, h) => { window.__asked = blob.size; return { settings: { preset: "corner-eye-right", lens: 28, azimuth: 40, height: 2.2, straight: true }, understood: ["corner view", "eye level", "about 28 mm"] }; } } });
  await window.__panel.load();
  // the picture: the model from a known camera (30 mm, 38 degrees, 2.5 m up), 600 x 400
  const t = { preset: "corner-eye-right", aspect: 1.5, lens: 30, azimuth: 38, height: 2.5, straight: true, custom: true };
  const d = v.setCamera(t).distance;
  const url = v.guides(600, 400, ["view"]).view;
  v.setCamera({ preset: "front-eye" });
  return { ...t, distance: d, url };
}, testBox());
const picPath = join(OUT, "camera-match-panel-picture.jpg");
writeFileSync(picPath, Buffer.from(truth.url.split(",")[1], "base64"));

// 1. choose the picture: it lies over the view, and the camera takes the picture's own shape
await page.setInputFiles("#cpMatchFile", picPath);
await page.waitForFunction(() => !document.querySelector("#cpNudges").hidden);
const s1 = await page.evaluate(() => ({ aspect: window.__studio.camera.settings.aspect, overlay: [...document.querySelectorAll(".cam-frame img")].some(i => i.src && getComputedStyle(i).display !== "none"), score: document.querySelector("#cpScore").textContent }));
check(Math.abs(s1.aspect - 1.5) < 1e-3 && s1.overlay && /Lines up: \d+/.test(s1.score), `the picture shows over the view in its own shape (${s1.aspect}); ${s1.score}`);
await page.fill("#cpMatchOpacity", "0.3"); await page.dispatchEvent("#cpMatchOpacity", "input");
check(Math.abs(await page.evaluate(() => +getComputedStyle([...document.querySelectorAll(".cam-frame img")].find(i => i.src)).opacity) - 0.3) < 0.01, "the see-through slider changes how much of the picture shows");

// 2. Ollic AI's rough start (stand-in answer), then a nudge
await page.click("#cpMatchAI");
await page.waitForFunction(() => /Ollic AI: corner view/.test(document.querySelector("#cpMsg").textContent));
let c = await page.evaluate(() => window.__studio.camera);
check(c.settings.lens === 28 && c.settings.azimuth === 40 && Math.abs(c.height - 2.2) < 0.01 && await page.evaluate(() => window.__asked) > 1000, `Ollic AI's rough start is applied: ${c.settings.lens} mm, ${c.settings.azimuth}°, ${c.height.toFixed(2)} m up`);
await page.click("[data-nudge=lens][data-dir='1']");
c = await page.evaluate(() => window.__studio.camera);
check(c.settings.lens === 30, `"Lens +" nudges the lens (${c.settings.lens} mm)`);
const before = +(await page.textContent("#cpScore")).match(/\d+/)[0];

// 3. fine-tune automatically: the score rises and the camera lands near the true one
await page.click("#cpMatchFine");
await page.waitForFunction(() => !document.querySelector("#cpMatchFine").disabled && /Matched|Close/.test(document.querySelector("#cpMsg").textContent), null, { timeout: 300000, polling: 1000 });
const after = +(await page.textContent("#cpScore")).match(/\d+/)[0];
c = await page.evaluate(() => window.__studio.camera);
console.log(`     score ${before} -> ${after}; found ${c.settings.lens.toFixed(1)} mm, ${c.settings.azimuth.toFixed(1)}°, ${c.height.toFixed(2)} m (true 30 mm, 38°, 2.5 m)`);
check(after > before && after >= 50, `fine-tuning lines the model up with the picture (${before} -> ${after} / 100)`);
check(Math.abs(c.settings.lens - 30) <= 2 && Math.abs(c.settings.azimuth - 38) <= 1 && Math.abs(c.height - 2.5) / truth.distance <= 0.02 && Math.abs(c.distance - truth.distance) / truth.distance <= 0.02,
  "and lands on the picture's camera (lens within 2 mm, angle within 1°, position within 2%)");
await page.evaluate(() => { document.getElementById("studioTest").scrollTop = 0; });
await page.screenshot({ path: join(OUT, "camera-match-panel.png"), clip: { x: 0, y: 0, width: 900, height: 600 } });

// 4. save as a view, then take the picture away
await page.fill("#cpViewName", "Matched to the Revit render");
await page.click("#cpSave");
await page.waitForFunction(() => (window.__saved?.views || []).length === 1, null, { timeout: 5000 });
const sv = await page.evaluate(() => window.__saved.views[0]);
check(sv.name === "Matched to the Revit render" && Math.abs(sv.settings.lens - c.settings.lens) < 1e-9 && Math.abs(+sv.settings.aspect - 1.5) < 1e-3, "the matched camera is saved as a view, in the picture's shape");
await page.click("#cpMatchRemove");
check(await page.evaluate(() => ![...document.querySelectorAll(".cam-frame img")].some(i => i.getAttribute("src") && getComputedStyle(i).display !== "none")) && await page.locator("#cpNudges").isHidden(), "removing the picture clears it from the view");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nMatch a picture from the panel: all passed");
