// Free navigation in the 3D preview, and the Camera settings beside it. Dragging turns the building to any angle:
// past the horizon to look up from below, and over the top; the turn is round what is under the pointer; zooming in
// keeps going (through the model) instead of slowing to a stop. With the Camera panel open, the preview and the
// settings are side by side, both in sight, and a change of lens shows in the preview at once.
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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);
await page.evaluate(async doc => {
  const M = await import("./assets/sketch/model.js"), I = await import("./assets/sketch/ifc.js"), THREE = await import("three"), a = window.__sketch;
  a.loadDoc(M.normalize(doc));
  const text = I.modelIfc(a, THREE, { name: "Navigation test" }).text;
  const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "./assets/styles.css"; document.head.append(css);
  await new Promise(r => { css.onload = r; setTimeout(r, 3000); });
  // the Studio's own layout: the preview and the Camera settings in a viewer stage
  const wrap = document.createElement("div"); wrap.style.cssText = "position:fixed;inset:0;z-index:50;background:#fff;overflow:auto;padding:16px";
  wrap.innerHTML = `<div class="viewer-stage" id="viewerStage"><div class="viewer" id="viewer"></div><div class="card cam-panel" id="camPanel" hidden></div></div>`;
  document.body.append(wrap);
  const R = await import("./assets/ifcread.js"), V = await import("./assets/viewer.js"), P = await import("./assets/camerapanel.js");
  const r = await R.readIfc(new TextEncoder().encode(text));
  const v = window.__studio = V.createViewer(document.getElementById("viewer"));
  await v.load(URL.createObjectURL(new Blob([r.glb], { type: "model/gltf-binary" })));
  window.__panel = P.createCameraPanel({ root: document.getElementById("camPanel"), viewer: v, store: { load: async () => ({}), save: async () => {}, words: async () => null } });
  await window.__panel.load();
}, testBox());
const box = await page.locator("#viewer canvas").boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const state = () => page.evaluate(async () => {
  const THREE = await import("three"), E = window.__studio.engine(), c = E.camera, t = new THREE.Vector3().fromArray(window.__studio.currentPose().target);
  const off = c.position.clone().sub(t), polar = Math.acos(Math.max(-1, Math.min(1, off.y / off.length()))) * 180 / Math.PI;
  return { polar, dist: off.length(), pos: c.position.toArray(), target: t.toArray(), centre: E.frame.getCenter(new THREE.Vector3()).toArray(), ground: E.groundY };
});
// waits until the camera has stopped moving (a view change glides for a moment)
const settle = async () => {
  let last = "", same = 0;
  for (let i = 0; i < 60 && same < 3; i++) {
    const p = await page.evaluate(() => window.__studio.engine().camera.position.toArray().map(v => v.toFixed(4)).join(","));
    same = p === last ? same + 1 : 0; last = p; await page.waitForTimeout(150);
  }
};
const drag = async (dx, dy) => { await page.mouse.move(cx, cy); await page.mouse.down(); for (let i = 1; i <= 12; i++) await page.mouse.move(cx + dx * i / 12, cy + dy * i / 12); await page.mouse.up(); await page.waitForTimeout(600); };

// 1. drag up a long way: the view goes past the horizon and looks up at the building from below
let s0 = await state();
await drag(0, -650);
let s = await state();
check(s.polar > 95 && s.pos[1] < s.target[1], `dragging turns the view below the horizon (from ${s0.polar.toFixed(0)}° to ${s.polar.toFixed(0)}° from straight up)`);
// and down a long way: over the top, looking straight down
await drag(0, 1300);
s = await state();
check(s.polar < 5, `and over the top to look straight down (${s.polar.toFixed(1)}°)`);
await page.evaluate(() => window.__studio.view("corner"));
await settle();

// 2. the turn is round what is under the pointer: pressing on the building puts the turning point on it
await settle();
s0 = await state();
await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.up();
s = await state();
check(s.dist < s0.dist * 0.95, `pressing on the building turns round it, not round a point behind it (${s0.dist.toFixed(1)} m -> ${s.dist.toFixed(1)} m to the turning point)`);

// 3. zooming in keeps going: 40 wheel steps take the camera through to the far side of where it started
s0 = await state();
await page.mouse.move(cx, cy);
for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(20); }
await page.waitForTimeout(600);
s = await state();
const travelled = Math.hypot(s.pos[0] - s0.pos[0], s.pos[1] - s0.pos[1], s.pos[2] - s0.pos[2]);
check(travelled > s0.dist * 1.05, `zooming in does not stop at the turning point: the camera moved ${travelled.toFixed(1)} m (the turning point was ${s0.dist.toFixed(1)} m away)`);
await page.evaluate(() => window.__studio.view("corner"));

// 4. the Camera settings beside the preview: both in sight, and a change shows at once
await page.evaluate(() => { document.getElementById("camPanel").hidden = false; document.getElementById("viewerStage").classList.add("cam-open"); window.__panel.refresh?.(); });
await page.waitForTimeout(500);
const vb = await page.locator("#viewer").boundingBox(), pb = await page.locator("#camPanel").boundingBox();
check(pb.x >= vb.x + vb.width - 1 && pb.y < vb.y + vb.height && vb.y + vb.height <= 900 && pb.y >= 0, `the settings sit beside the preview, both in sight (preview ${Math.round(vb.width)} px wide, settings ${Math.round(pb.width)} px at the right)`);
await page.click("[data-preset=drone-corner-right]");
const before = await page.evaluate(() => window.__studio.engine().camera.fov);
await page.fill("#cpLens", "50"); await page.dispatchEvent("#cpLens", "change");
const after = await page.evaluate(() => window.__studio.engine().camera.fov);
check(after < before * 0.7, `changing the lens to 50 mm narrows the preview at once (${before.toFixed(1)}° -> ${after.toFixed(1)}° up and down)`);
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, "camera-beside-preview.png") });
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nNavigation and the Camera settings beside the preview: all passed");
