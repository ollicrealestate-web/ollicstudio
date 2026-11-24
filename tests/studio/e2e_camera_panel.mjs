// The Camera panel, as a person would use it: a ready-made angle, a lens changed to 28 mm, framing guides, the
// angle typed in words (with and without Ollic AI), the front set by clicking a wall, a view saved, the page
// reloaded and the view back exactly; rename, duplicate, delete. The store keeps what the server keeps (one
// document per model); the server's side is tested in backend/tests/test_cameras.py.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
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
const page = await browser.newPage({ viewport: { width: 1300, height: 1700 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const url = `http://127.0.0.1:${srv.address().port}/sketch.html`;
await page.goto(url);
await page.waitForFunction(() => window.__sketch?.ready);
const ifc = await page.evaluate(async doc => {
  const M = await import("./assets/sketch/model.js"), I = await import("./assets/sketch/ifc.js"), THREE = await import("three"), a = window.__sketch;
  a.loadDoc(M.normalize(doc)); return I.modelIfc(a, THREE, { name: "Camera panel test" }).text;
}, testBox());

async function openStudio(ai = null) {
  await page.evaluate(async ({ text, ai }) => {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "./assets/styles.css"; document.head.append(css);
    await new Promise(r => { css.onload = r; setTimeout(r, 3000); });
    const R = await import("./assets/ifcread.js"), V = await import("./assets/viewer.js"), P = await import("./assets/camerapanel.js");
    const wrap = document.createElement("div"); wrap.id = "studioTest"; wrap.style.cssText = "position:fixed;inset:0;z-index:50;background:#fff;overflow:auto"; document.body.append(wrap);
    const host = document.createElement("div"); host.style.cssText = "position:absolute;left:0;top:0;width:900px;height:560px"; wrap.append(host);
    const panel = document.createElement("div"); panel.style.cssText = "position:absolute;left:0;top:570px;width:1280px"; wrap.append(panel);
    const r = await R.readIfc(new TextEncoder().encode(text));
    const v = window.__studio = V.createViewer(host);
    await v.load(URL.createObjectURL(new Blob([r.glb], { type: "model/gltf-binary" })));
    window.__saves = 0;
    window.__panel = P.createCameraPanel({ root: panel, viewer: v, store: {
      load: async () => JSON.parse(localStorage.getItem("cameras") || "{}"),
      save: async b => { window.__saves++; localStorage.setItem("cameras", JSON.stringify(b)); },
      words: async () => ai } });
    await window.__panel.load();
  }, { text: ifc, ai });
}
const cam = () => page.evaluate(() => window.__studio.camera);
await openStudio();

// 1. a ready-made angle, then the lens to 28 mm
await page.click("[data-preset=drone-corner-right]");
let c = await cam();
check(c.settings.preset === "drone-corner-right" && c.settings.lens === 24 && await page.locator("[data-preset=drone-corner-right]").getAttribute("aria-pressed") === "true", "the drone corner angle is set from its button");
await page.fill("#cpLens", "28"); await page.dispatchEvent("#cpLens", "change");
c = await cam();
check(c.settings.lens === 28 && Math.abs(c.angles.h - 65.5) < 0.1 && /65\.5° across/.test(await page.textContent("#cpAngle")), `the lens is 28 mm: ${await page.textContent("#cpAngle")}`);
await page.check("[data-guide=thirds]"); await page.check("[data-guide=horizon]");
check(await page.locator(".cam-frame svg line").count() >= 4, "framing guides show over the view (thirds; the horizon is above this picture, as it should be for a camera looking level from drone height)");
await page.evaluate(() => { document.getElementById("studioTest").scrollTop = 0; });
await page.screenshot({ path: join(OUT, "camera-panel-drone-28.png"), clip: { x: 0, y: 0, width: 900, height: 560 } });

// 2. words, without Ollic AI (the app's own table)
await page.fill("#cpWords", "elevated three-quarter corner view, low drone height, two-point perspective with vertical lines kept straight, 24 mm wide-angle lens, street intersection in foreground");
await page.click("#cpWordsGo");
await page.waitForFunction(() => /Read by/.test(document.querySelector("#cpWordsMsg").textContent));
c = await cam();
check(c.settings.preset.startsWith("drone-corner") && c.settings.lens === 24 && c.settings.straight && c.settings.foreground === "street" && c.height >= 1.2 * c.buildingHeight - 0.01 && c.height <= 1.5 * c.buildingHeight + 0.01,
  `words without Ollic AI: ${await page.textContent("#cpWordsMsg")}`);
check(/two-point perspective with vertical lines kept perfectly straight/.test(c.words) && /street/.test(c.words), "and the camera is described in words for the render");

// 3. "Make this side the front" by clicking the east wall
await page.click("#cpPickFront");
const east = await page.evaluate(async () => {
  const THREE = await import("three"), v = window.__studio, E = v.engine(), b = E.frame, c = b.getCenter(new THREE.Vector3());
  v.setCamera({ preset: "side" });   // looking at the east side
  E.camera.updateMatrixWorld();
  const p = new THREE.Vector3(b.max.x, E.groundY + 1.5, c.z).project(E.camera), r = E.renderer.domElement.getBoundingClientRect();
  return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
});
await page.mouse.click(east[0], east[1]);
await page.waitForFunction(() => window.__studio.front.from === "you");
const fr = await page.evaluate(() => window.__studio.front);
check(Math.abs(fr.dir[0] - 1) < 0.05 && /set by you/.test(await page.textContent("#cpFrontMsg")), `the east side is now the front (${fr.dir.map(v => v.toFixed(2))})`);
await page.waitForFunction(() => JSON.parse(localStorage.getItem("cameras") || "{}").front?.from === "you", null, { timeout: 5000 });

// 4. save the drone corner at 28 mm; reload; it comes back exactly
await page.click("[data-preset=drone-corner-right]");
await page.fill("#cpLens", "28"); await page.dispatchEvent("#cpLens", "change");
const saved = await page.evaluate(() => window.__studio.currentPose());
await page.fill("#cpViewName", "Corner drone NE");
await page.click("#cpSave");
await page.waitForFunction(() => (JSON.parse(localStorage.getItem("cameras") || "{}").views || []).length === 1, null, { timeout: 5000 });
check(await page.locator(".cp-view img").count() === 1, "the saved view has its small picture");
await page.goto(url); await page.waitForFunction(() => window.__sketch?.ready);
await openStudio();
check(await page.locator(".cp-view").count() === 1 && (await page.textContent(".cp-view")).includes("Corner drone NE"), "after reloading, the saved view is listed");
const frontBack = await page.evaluate(() => window.__studio.front);
check(frontBack.from === "you" && Math.abs(frontBack.dir[0] - 1) < 0.05, "and the front set by you is back");
await page.click(".cp-go");
const back = await page.evaluate(() => window.__studio.currentPose());
const same = ["position", "target", "shift"].every(k => back[k].every((v, i) => Math.abs(v - saved[k][i]) < 1e-6)) && Math.abs(back.fov - saved.fov) < 1e-9 && back.aspect === saved.aspect;
check(same && (await cam()).settings?.lens === 28, "clicking it brings back exactly that camera (28 mm)");
const g = await page.evaluate(() => { const p = window.__studio.currentPose(); window.__studio.beginGuide("lines", 1536, 1024); window.__studio.guideFrame(p); const E = window.__studio.engine(); const r = [E.camera.fov, E.camera.shift[1]]; window.__studio.endGuide(); return r; });
check(Math.abs(g[0] - saved.fov) < 1e-9 && Math.abs(g[1] - saved.shift[1]) < 1e-9, "a capture from it draws its guides with that camera");

// 5. rename, duplicate, delete
await page.click(".cp-view button:has-text('Rename')");
await page.fill(".cp-rename", "Drone corner, east"); await page.press(".cp-rename", "Enter");
await page.click(".cp-view button:has-text('Duplicate')");
check(await page.locator(".cp-view").count() === 2 && (await page.textContent("#cpList")).includes("Drone corner, east (copy)"), "renamed and duplicated");
await page.locator(".cp-view").nth(1).locator("button:has-text('Delete')").click();
await page.waitForFunction(() => (JSON.parse(localStorage.getItem("cameras") || "{}").views || []).length === 1 && JSON.parse(localStorage.getItem("cameras")).views[0].name === "Drone corner, east", null, { timeout: 5000 });
check(true, "deleted, and every change saved");

// 6. words with Ollic AI (a stand-in answer)
await page.goto(url); await page.waitForFunction(() => window.__sketch?.ready);
await openStudio({ settings: { preset: "front-eye", lens: 35, height: 1.6, azimuth: 0, pitch: 0, straight: true, aspect: "3:2", foreground: null }, understood: ["front elevation", "eye level", "35 mm"] });
await page.fill("#cpWords", "Front elevation at eye level, 35 mm"); await page.click("#cpWordsGo");
await page.waitForFunction(() => /Read by Ollic AI/.test(document.querySelector("#cpWordsMsg").textContent));
c = await cam();
check(c.settings.preset === "front-eye" && c.settings.lens === 35 && Math.abs(c.height - 1.6) < 0.01, `words with Ollic AI: ${await page.textContent("#cpWordsMsg")}`);
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nCamera panel: all passed");
