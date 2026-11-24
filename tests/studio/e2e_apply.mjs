// Click to apply, as a person would: click a wall, apply travertine to this part, then to everything with the same
// material, undo, reload the page (the changes come back from the store), one face of a wall, drag a material onto
// the model, copy with the eyedropper, and reset to the IFC's materials. The store here keeps the changes the way the
// server does (one document per model); the server's own API is tested in backend/tests/test_materials.py.
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
const page = await browser.newPage({ viewport: { width: 1300, height: 1800 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const url = `http://127.0.0.1:${srv.address().port}/sketch.html`;
await page.goto(url);
await page.waitForFunction(() => window.__sketch?.ready);
const ifc = await page.evaluate(async doc => {
  const M = await import("./assets/sketch/model.js"), I = await import("./assets/sketch/ifc.js"), THREE = await import("three"), a = window.__sketch;
  a.loadDoc(M.normalize(doc));
  return I.modelIfc(a, THREE, { name: "Apply test" }).text;
}, testBox());

// the Studio's viewer and Materials panel on a page, the store kept in localStorage (as the server keeps it)
async function openStudio() {
  await page.evaluate(async text => {
    const R = await import("./assets/ifcread.js"), V = await import("./assets/viewer.js"), P = await import("./assets/materials/panel.js");
    document.getElementById("studioTest")?.remove();
    const wrap = document.createElement("div"); wrap.id = "studioTest"; wrap.style.cssText = "position:fixed;inset:0;z-index:9999;background:#fff;overflow:auto"; document.body.append(wrap);
    const host = document.createElement("div"); host.style.cssText = "position:absolute;left:0;top:0;width:800px;height:560px"; wrap.append(host);
    const panel = document.createElement("div"); panel.id = "matPanel"; panel.style.cssText = "position:absolute;left:0;top:570px;width:1280px"; wrap.append(panel);
    const r = await R.readIfc(new TextEncoder().encode(text));
    let mp = null;
    const v = window.__studio = V.createViewer(host, { onSelect: (x, info) => mp?.selected(x, info) });
    await v.load(URL.createObjectURL(new Blob([r.glb], { type: "model/gltf-binary" })));
    window.__saves = 0;
    mp = window.__panel = P.createMaterialsPanel({ root: panel, viewer: v, store: {
      load: async () => JSON.parse(localStorage.getItem("model-materials") || "{}"),
      save: async a => { window.__saves++; localStorage.setItem("model-materials", JSON.stringify(a)); },
      prefs: async () => JSON.parse(localStorage.getItem("prefs") || "{}"),
      savePrefs: p => localStorage.setItem("prefs", JSON.stringify(p)) } });
    await mp.load();
  }, ifc);
}
// a point on screen where the element itself is what a click hits (not a door or window in it)
const screenOf = tag => page.evaluate(async tag => {
  document.getElementById("studioTest").scrollTop = 0; window.scrollTo(0, 0);
  const T = await import("three"), v = window.__studio, E = v.engine(), o = E.elements.find(e => e.userData.tag === tag && !e.userData.face);
  const box = new T.Box3().setFromObject(o), r = E.renderer.domElement.getBoundingClientRect(), keys = new Set(v.debugParts().filter(p => p.tag === tag).map(p => p.key));
  for (const fy of [0.3, 0.7, 0.5, 0.15, 0.85]) for (const fx of [0.15, 0.85, 0.3, 0.7, 0.5]) {
    const p = new T.Vector3(box.min.x + (box.max.x - box.min.x) * fx, box.min.y + (box.max.y - box.min.y) * fy, box.min.z + (box.max.z - box.min.z) * fx).project(E.camera);
    const x = r.left + (p.x + 1) / 2 * r.width, y = r.top + (1 - p.y) / 2 * r.height;
    if (keys.has(v.partAt(x, y))) return [x, y];
  }
  throw new Error("no clear view of " + tag);
}, tag);
const partsOf = () => page.evaluate(() => window.__studio.debugParts().map(p => ({ ...p })));
const infoOf = () => page.evaluate(() => window.__studio.partInfo());
const savedNow = () => page.evaluate(() => JSON.parse(localStorage.getItem("model-materials") || "{}"));
const waitSaved = n => page.waitForFunction(n => window.__saves >= n, n, { timeout: 5000 });

await openStudio();
// look at the south walls (S1 ground, S2 upper) square on
await page.evaluate(async () => { const v = window.__studio; v.view("front"); });
await page.waitForTimeout(800);
let [x, y] = await screenOf("S1");
await page.mouse.click(x, y);
await page.waitForFunction(() => window.__panel.state.part);
let info = await infoOf();
check(info && info.ifcType.startsWith("IfcWall"), `clicking the wall selects it (${info?.ifcType} ${info?.name})`);
check(await page.locator("#mpPart").textContent().then(t => /From your IFC|Matched|Guessed/.test(t)), "the panel shows the wall's material and where it came from");
const before = info.spec.id;

// 1. travertine on this part only
await page.click("[data-id=mt-travertine]");
await page.check("input[name=mpScope][value=part]");
await page.click("#mpApply");
info = await infoOf();
let parts = await partsOf();
const sameBefore = parts.filter(p => p.mat === before && p.type?.startsWith("IfcWall")).length;
check(info.spec.id === "mt-travertine" && info.how === "user", "travertine is on this wall, marked Set by you");
check(parts.filter(p => p.userMat === "mt-travertine").length === 1, "only this part changed");
await waitSaved(1);
check(Object.values(await savedNow()).filter(a => a.id === "mt-travertine").length === 1, "the change is saved for the model");

// 2. everything with the wall's original material: pick another wall of that material and apply to "same"
await page.evaluate(() => window.__studio.select(null));
[x, y] = await screenOf("S2");
await page.mouse.click(x, y);
await page.waitForFunction(() => window.__panel.state.part?.ifcType?.startsWith("IfcWall"));
const sameCount = (await infoOf()).count.same;
await page.click("[data-id=mt-travertine]");
await page.check("input[name=mpScope][value=same]");
await page.click("#mpApply");
parts = await partsOf();
check(parts.filter(p => p.userMat === "mt-travertine").length === sameCount + 1 && sameCount > 1, `"Everything with this material" changed all ${sameCount} parts with it`);

// 3. undo: back to only the first wall
await page.click("#mpUndo");
parts = await partsOf();
check(parts.filter(p => p.userMat === "mt-travertine").length === 1, "Undo takes back the last change");
await page.click("#mpRedo");
check((await partsOf()).filter(p => p.userMat === "mt-travertine").length === sameCount + 1, "Redo puts it back");
await page.click("#mpUndo");
await page.waitForTimeout(900);
const kept = await savedNow();

// 4. one face: the outside of the east wall in red brick
await page.evaluate(() => window.__studio.select(null));
await page.evaluate(() => window.__studio.view("right"));
await page.waitForTimeout(600);
[x, y] = await screenOf("E1");
await page.mouse.click(x, y);
await page.waitForFunction(() => window.__panel.state.part?.ifcType?.startsWith("IfcWall"));
await page.click("[data-id=mt-brick-red]");
await page.check("input[name=mpScope][value=outside]");
await page.click("#mpApply");
parts = await partsOf();
const face = parts.find(p => p.face === "outside" && p.userMat === "mt-brick-red");
check(face && face.n[0] > 0.9 && !parts.some(p => p.face === "inside" && p.userMat === "mt-brick-red"), `only the outside face of the east wall is brick (facing ${face?.n.map(v => v.toFixed(1))})`);

// 5. drag a material from the library onto the model
await page.evaluate(() => window.__studio.view("front"));
await page.waitForTimeout(600);
[x, y] = await screenOf("S2");
await page.evaluate(({ x, y }) => {
  const dt = new DataTransfer(), src = document.querySelector("[data-id=mt-timber-teak]"), canvas = window.__studio.engine().renderer.domElement;
  src.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
  canvas.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  canvas.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}, { x, y });
parts = await partsOf();
check(parts.some(p => p.tag === "S2" && p.userMat === "mt-timber-teak"), "dragging teak onto the upper wall puts it there");

// 6. eyedropper: copy the teak from S2 onto S1
await page.click("#mpEyedrop");
await page.mouse.click(x, y);
await page.waitForFunction(() => window.__panel.state.eyedrop === "to");
[x, y] = await screenOf("S1");
await page.mouse.click(x, y);
await page.waitForFunction(() => window.__panel.state.eyedrop === null);
parts = await partsOf();
check(parts.some(p => p.tag === "S1" && p.userMat === "mt-timber-teak"), "the eyedropper copies teak from one wall to another");
await page.waitForTimeout(900);
const savedBeforeReload = await savedNow();
await page.screenshot({ path: join(OUT, "apply-before-reload.png"), clip: { x: 0, y: 0, width: 800, height: 560 } });

// 7. reload: everything comes back (faces too)
await page.goto(url); await page.waitForFunction(() => window.__sketch?.ready);
await openStudio();
parts = await partsOf();
check(parts.some(p => p.tag === "S1" && p.userMat === "mt-timber-teak") && parts.some(p => p.tag === "S2" && p.userMat === "mt-timber-teak") && parts.some(p => p.face === "outside" && p.userMat === "mt-brick-red"),
  `after reloading the page every change is back (${Object.keys(savedBeforeReload).length} saved)`);
await page.screenshot({ path: join(OUT, "apply-after-reload.png"), clip: { x: 0, y: 0, width: 800, height: 560 } });
check(Object.keys(kept).length >= 1, "saved while working");

// 8. reset to the IFC's materials
await page.click("#mpResetAll");
parts = await partsOf();
check(!parts.some(p => p.userMat), "Reset everything returns every part to the IFC's materials");
await page.waitForTimeout(900);
check(Object.keys(await savedNow()).length === 0, "and the reset is saved");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nClick to apply: all passed");
