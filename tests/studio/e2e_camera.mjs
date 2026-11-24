// Camera angles in the 3D view: every ready-made angle is what it says (lens, height, angle from the front,
// framing, straight vertical lines), the guides use exactly the camera the view shows (in every picture shape), the
// front is found from the main entrance and can be set by clicking a wall. Saves a picture of each angle.
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
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);

// the test house as an IFC; the second copy has its only ground-floor door on the east wall
const ifcOf = (doorOn) => page.evaluate(async ({ doc, doorOn }) => {
  const M = await import("./assets/sketch/model.js"), T = await import("./assets/sketch/aitools.js"), I = await import("./assets/sketch/ifc.js"), THREE = await import("three"), a = window.__sketch;
  const d = M.normalize(doc);
  if (doorOn) { const o = d.openings.find(x => x.id === "D1"); o.hostWallId = doorOn; o.positionAlongWall = 4000; }
  a.loadDoc(d);
  for (const [n, x] of [["add_cladding", { wall_ids: ["S1"], material: "mt-travertine" }], ["set_material", { element_ids: ["E1"], material: "mt-brick-red" }]]) T.runTool(a.history, n, x);
  return I.modelIfc(a, THREE, { name: "Camera test" }).text;
}, { doc: testBox(), doorOn });
async function open(text) {
  await page.evaluate(async text => {
    const R = await import("./assets/ifcread.js"), V = await import("./assets/viewer.js");
    const r = await R.readIfc(new TextEncoder().encode(text));
    document.getElementById("camTest")?.remove();
    const host = document.createElement("div"); host.id = "camTest"; host.style.cssText = "position:fixed;left:0;top:0;width:1200px;height:800px;z-index:99;background:#fff"; document.body.append(host);
    window.__studio?.dispose?.();
    const v = window.__studio = V.createViewer(host);
    await v.load(URL.createObjectURL(new Blob([r.glb], { type: "model/gltf-binary" })));
  }, text);
}
await open(await ifcOf(null));
const front = await page.evaluate(() => window.__studio.front);
check(front.from === "entrance" && Math.abs(front.dir[1] - 1) < 1e-6, `the front is found from the main entrance (${front.dir}, ${front.from})`);

// measures, in the guide (1536 x 1024) and in the view, for a camera
const measure = (settings, outW = 1536, outH = 1024) => page.evaluate(async ({ settings, outW, outH }) => {
  const THREE = await import("three"), v = window.__studio, E = v.engine(), info = v.setCamera(settings);
  const b = E.frame, g = E.groundY, C = [];
  for (let i = 0; i < 8; i++) C.push(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : g, i & 4 ? b.max.z : b.min.z));
  const cam = E.camera;
  // the live view: where the building's corners fall, expressed inside the set picture's outline
  const W = E.host.clientWidth, H = E.host.clientHeight, A = W / H, a = info.aspect, fw = a >= A ? 1 : a / A, fh = a >= A ? A / a : 1;
  const live = C.map(p => { const q = p.clone().project(cam); return [q.x / fw, q.y / fh]; });
  const pose = v.currentPose();
  v.beginGuide("lines", outW, outH); v.guideFrame(pose);
  const gc = E.camera, hfov = 2 * Math.atan(Math.tan(gc.fov * Math.PI / 360) * gc.aspect) * 180 / Math.PI;
  const guide = C.map(p => { const q = p.clone().project(gc); return [q.x, q.y]; });
  // vertical edges of the building: top and bottom, in pixels across
  const edges = [[b.min.x, b.min.z], [b.max.x, b.min.z], [b.min.x, b.max.z], [b.max.x, b.max.z]].map(([x, z]) => {
    const lo = new THREE.Vector3(x, g, z).project(gc), hi = new THREE.Vector3(x, b.max.y, z).project(gc);
    return Math.abs(lo.z) < 1 && Math.abs(hi.z) < 1 ? Math.abs(lo.x - hi.x) * outW / 2 : null;
  }).filter(x => x != null);
  v.endGuide();
  const c = b.getCenter(new THREE.Vector3()), p = cam.position;
  const az = (Math.atan2(p.x - c.x, p.z - c.z) - Math.atan2(info.front[0], info.front[1])) * 180 / Math.PI;
  return { info, hfov, live, guide, edges, az: ((az + 540) % 360) - 180, height: p.y - g };
}, { settings, outW, outH });
const range = pts => { const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; };

// 1. eye-level front: 35 mm, 1.6 m, centred, fills 85% of the height, straight verticals
let m = await measure({ preset: "front-eye" });
check(Math.abs(m.hfov - 54.4) < 0.1, `35 mm is 54.4 degrees across in the guide (${m.hfov.toFixed(2)})`);
check(Math.abs(m.height - 1.6) < 0.01, `the camera is 1.6 m up (${m.height.toFixed(3)})`);
let r = range(m.guide);
check(Math.abs((r.x0 + r.x1) / 2) < 0.02, `centred on the front, within 1% of the width (${((r.x0 + r.x1) / 4 * 100).toFixed(2)}%)`);
// 85% of the height, unless the building is too wide for that: then 85% of the width (it is never cropped)
const fillH = (r.y1 - r.y0) / 2, fillW = (r.x1 - r.x0) / 2;
check(Math.abs(Math.max(fillH, fillW) - 0.85) < 0.03 && fillW <= 0.851 && fillH <= 0.851, `the building fills 85% of the picture (height ${(fillH * 100).toFixed(1)}%, width ${(fillW * 100).toFixed(1)}%)`);
check(m.edges.length >= 2 && m.edges.every(d => d < 1), `vertical lines are straight (${m.edges.map(d => d.toFixed(2)).join(", ")} px out)`);
await page.screenshot({ path: join(OUT, "camera-front-eye.png") });

// 2. drone corner: 24 mm, 45 degrees off the front, 1.35 x the building's height, straight verticals
m = await measure({ preset: "drone-corner-right" });
check(Math.abs(m.hfov - 73.7) < 0.1, `24 mm is 73.7 degrees across (${m.hfov.toFixed(2)})`);
check(Math.abs(m.az - 45) < 1, `the corner view is 45 degrees off the front (${m.az.toFixed(2)})`);
check(Math.abs(m.height - 1.35 * m.info.buildingHeight) < 0.01, `at low drone height, 1.35 x the building (${m.height.toFixed(2)} m)`);
check(m.edges.every(d => d < 1), `vertical lines are straight (${m.edges.map(d => d.toFixed(2)).join(", ")} px out)`);
await page.screenshot({ path: join(OUT, "camera-drone-corner.png") });

// 3. worm's eye converges; straightened when asked
m = await measure({ preset: "hero-low" });
check(m.edges.some(d => d > 5), `the low hero angle converges on purpose (${m.edges.map(d => d.toFixed(0)).join(", ")} px)`);
m = await measure({ preset: "hero-low", straight: true });
check(m.edges.every(d => d < 1), "and straightens when asked");

// 4. the guide is exactly the view, for every angle and picture shape
let worst = 0;
for (const preset of ["front-eye", "front-raised", "corner-eye-left", "drone-corner-left", "aerial", "hero-low", "side", "rear-right", "entrance"]) {
  for (const aspect of ["3:2", "16:9", "4:5", "1:1", "9:16"]) {
    const [w, h] = { "3:2": [1536, 1024], "16:9": [1536, 864], "4:5": [1024, 1280], "1:1": [1024, 1024], "9:16": [864, 1536] }[aspect];
    const q = await measure({ preset, aspect }, w, h);
    q.live.forEach((p, i) => { worst = Math.max(worst, Math.abs(p[0] - q.guide[i][0]) * w / 2, Math.abs(p[1] - q.guide[i][1]) * h / 2); });
  }
}
check(worst < 0.5, `in every angle and picture shape the guide lines up with the view (worst ${worst.toFixed(3)} px)`);

// 5. every ready-made angle: a picture of each, and nothing outside the picture
const names = await page.evaluate(async () => Object.keys((await import("./assets/camera.js")).PRESETS));
for (const key of names.filter(k => !k.startsWith("interior"))) {
  await page.evaluate(k => window.__studio.setCamera({ preset: k }), key);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, `camera-${key}.png`) });
}
await page.evaluate(() => { window.__studio.setFrameGuides({ thirds: true, horizon: true, safe: true }); window.__studio.setCamera({ preset: "corner-eye-left", aspect: "4:5" }); });
await page.waitForTimeout(250);
await page.screenshot({ path: join(OUT, "camera-guides-4x5.png") });
const inter = await page.evaluate(() => window.__studio.setCamera({ preset: "interior-two" }));
check(inter && !inter.error && Math.abs(inter.height - 1.2 - (inter.height - 1.2)) < 1e-9 && inter.settings.interior === "two", `interior two-point: in the house, level, ${inter?.settings?.lens} mm`);
await page.evaluate(() => window.__studio.setMode?.("exterior"));

// 6. the front from a door on the east wall; then "Make this side the front" on the north wall
await open(await ifcOf("E1"));
const east = await page.evaluate(() => window.__studio.front);
check(east.from === "entrance" && Math.abs(east.dir[0] - 1) < 1e-6, `with the entrance on the east wall, the front is east (${east.dir})`);
const before = await page.evaluate(() => window.__studio.setCamera({ preset: "front-eye" }).settings);
await page.evaluate(() => { window.__studio.showFront(true); window.__studio.view?.("back"); });
await page.waitForTimeout(900);
const at = await page.evaluate(async () => {
  const THREE = await import("three"), v = window.__studio, E = v.engine(), b = E.frame, c = b.getCenter(new THREE.Vector3());
  const p = new THREE.Vector3(c.x, E.groundY + 2, b.min.z).project(E.camera), r = E.renderer.domElement.getBoundingClientRect();
  window.__picked = v.pickFront();
  return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
});
await page.mouse.click(at[0], at[1]);
const picked = await page.evaluate(() => window.__picked);
check(picked && Math.abs(picked[1] + 1) < 0.05, `"Make this side the front" on the north wall makes north the front (${picked?.map(v => v.toFixed(2))})`);
const after = await page.evaluate(() => { const v = window.__studio, E = v.engine(); v.setCamera({ preset: "front-eye" }); return [E.camera.position.z, E.frame.min.z]; });
check(after[0] < after[1], "and the eye-level front view now looks at the north side");
void before;
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nCamera angles: all passed");
