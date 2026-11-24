// Ollic Sketch's 3D view gets the Studio's Camera panel: the same ready-made angles (straight vertical lines, the
// lens's true angle of view), the front found from the entrance door or the project's front side, the angle in
// words, saved views kept with the sketch (back after reloading), the model's lines for matching a picture, and the
// AI's pictures of the model leaving the set camera as it was.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "./e2e_phase1.mjs";
import { testBox } from "./testbox.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const OUT = process.argv[2] || "out/sketch";
mkdirSync(OUT, { recursive: true });
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };
const srv = await serve();
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const url = `http://127.0.0.1:${srv.address().port}/sketch.html`;
await page.goto(url);
await page.waitForFunction(() => window.__sketch?.ready);
await page.evaluate(async doc => { const M = await import("./assets/sketch/model.js"); window.__sketch.loadDoc(M.normalize(doc)); }, testBox());
await page.click("#tile").catch(() => {});

// 1. the Camera button opens the panel; the front is found from the entrance door (south: three.js +z)
await page.click("#v3Cam");
await page.waitForSelector("#camDrawer [data-preset=drone-corner-right]");
let f = await page.evaluate(() => window.__sketch.view3d.rig.front);
check(f.from === "entrance" && Math.abs(f.dir[1] - 1) < 1e-6, `the front is found from the entrance door (${f.dir}, ${f.from})`);

// 2. the drone corner: 24 mm, straight vertical lines (each corner of the building within 1 px at 1536 wide)
await page.click("#camDrawer [data-preset=drone-corner-right]");
const v = await page.evaluate(async () => {
  const THREE = await import("three"), V = window.__sketch.view3d, c = V.rig.camera, b = V.modelBox();
  V.rig.applyOutput(1.5); V.camera.updateMatrixWorld();
  let worst = 0;
  for (const x of [b.min.x, b.max.x]) for (const z of [b.min.z, b.max.z]) {
    const lo = new THREE.Vector3(x, b.min.y, z).project(V.camera), hi = new THREE.Vector3(x, b.max.y, z).project(V.camera);
    worst = Math.max(worst, Math.abs(lo.x - hi.x) * 1536 / 2);
  }
  V.rig.applyOutput();
  return { lens: c.settings.lens, h: c.angles.h, height: c.height, bh: c.buildingHeight, worst, az: c.settings.azimuth };
});
check(v.lens === 24 && Math.abs(v.h - 73.7) < 0.1, `the drone corner uses a 24 mm lens, ${v.h.toFixed(1)} degrees across`);
check(v.worst < 1, `vertical lines straight: the building's corners lean ${v.worst.toFixed(3)} px at 1536 wide`);
check(v.height > v.bh, `the camera is above the roof (${v.height.toFixed(1)} m; the building is ${v.bh} m)`);
await page.waitForTimeout(400);
await page.locator("#view3d").screenshot({ path: join(OUT, "sketch-camera-drone-corner.png") });

// 3. the project's front side wins over the door; east is then the front
await page.evaluate(() => { const a = window.__sketch; a.doc.settings.front = "east"; a.view3d.rig.detectFront(); });
f = await page.evaluate(() => window.__sketch.view3d.rig.front);
check(f.from === "project" && Math.abs(f.dir[0] - 1) < 1e-6, `the project's front side (east) is used (${f.dir})`);
await page.evaluate(() => { const a = window.__sketch; a.doc.settings.front = null; a.view3d.rig.detectFront(); });

// 4. the angle in words (no Ollic AI here: the app's own table)
await page.fill("#cpWords", "front elevation at eye level, 35 mm lens");
await page.click("#cpWordsGo");
await page.waitForFunction(() => /Read by/.test(document.querySelector("#cpWordsMsg").textContent));
const w = await page.evaluate(() => window.__sketch.view3d.rig.camera);
check(w.settings.preset === "front-eye" && w.settings.lens === 35 && Math.abs(w.height - 1.6) < 0.01, `words: ${await page.textContent("#cpWordsMsg")}`);
await page.locator("#view3d").screenshot({ path: join(OUT, "sketch-camera-front-eye.png") });

// 5. save the view; it is kept with the sketch and comes back after reloading
await page.click("#camDrawer [data-preset=corner-eye-left]");
const saved = await page.evaluate(() => window.__sketch.view3d.rig.currentPose());
await page.fill("#cpViewName", "Corner, south-west");
await page.click("#cpSave");
await page.waitForFunction(() => (window.__sketch.doc.cameras?.views || []).length === 1, null, { timeout: 5000 });
check(/^data:image\/jpeg/.test(await page.evaluate(() => window.__sketch.doc.cameras.views[0].thumb || "")), "the saved view has its small picture");
await page.waitForTimeout(1200);   // kept in this browser
await page.goto(url); await page.waitForFunction(() => window.__sketch?.ready);
await page.click("#v3Cam");
await page.waitForSelector("#camDrawer .cp-view");
await page.click("#camDrawer .cp-go");
const back = await page.evaluate(() => window.__sketch.view3d.rig.currentPose());
check(["position", "target", "shift"].every(k => back[k].every((x, i) => Math.abs(x - saved[k][i]) < 1e-6)) && Math.abs(back.fov - saved.fov) < 1e-9, "after reloading, the saved view brings back exactly that camera");

// 6. the model's lines for matching a picture; the AI's pictures leave the set camera as it was
const lines = await page.evaluate(() => { const p = window.__sketch.view3d.rig.linePixels(240, 160); let on = 0; for (let i = 0; i < p.data.length; i += 4) if (p.data[i] > 90) on++; return on; });
check(lines > 300, `the model's lines are drawn for matching (${lines} line pixels)`);
const kept = await page.evaluate(async () => {
  const C = await import("./assets/sketch/capture.js"), a = window.__sketch, before = a.view3d.rig.currentPose();
  await C.capture3D(a, ["ne"], { width: 320, height: 240 });
  const after = a.view3d.rig.currentPose();
  return before.position.every((x, i) => Math.abs(x - after.position[i]) < 1e-6) && Math.abs(before.shift[1] - after.shift[1]) < 1e-9;
});
check(kept, "pictures for Ollic AI leave the set camera as it was");
await page.click("#v3Fit");
check(await page.evaluate(() => window.__sketch.view3d.rig.camera.settings === null), "Zoom to fit goes back to the free camera");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nOllic Sketch camera angles: all passed");
