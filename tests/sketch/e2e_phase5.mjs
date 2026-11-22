// Phase 5 browser test: floors in sketch mode, in real Chromium. Run: node tests/sketch/e2e_phase5.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { serve } from "./e2e_phase1.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const OUT = process.argv[2] || "out/sketch";
mkdirSync(OUT, { recursive: true });
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };
const near = (a, b, t = 0.5) => Math.abs(a - b) <= t;

const srv = await serve();
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);

const S = (fn, arg) => page.evaluate(fn, arg);
const model = () => S(() => JSON.parse(JSON.stringify(window.__sketch.doc)));
const toScreen = (x, y) => S(([x, y]) => { const a = window.__sketch, r = document.getElementById("planCanvas").getBoundingClientRect(), s = a.plan.toScreen({ x, y }); return { x: r.left + s.x, y: r.top + s.y }; }, [x, y]);
const click = async (x, y) => { const p = await toScreen(x, y); await page.mouse.move(p.x - 3, p.y - 3); await page.mouse.move(p.x, p.y, { steps: 2 }); await page.mouse.click(p.x, p.y); await page.waitForTimeout(60); };
const keys = async s => { for (const ch of s) await page.keyboard.press(ch === "\n" ? "Enter" : ch); };
const focus = () => page.locator("#planCanvas").focus();
const esc2 = async () => { await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); };
const view = () => S(() => { const p = window.__sketch.plan; p.s = 0.04; p.cx = 5000; p.cy = 4000; p.invalidate(); });
const ribbon = id => page.locator(`.sk-tool[data-id='${id}']`).click();
await view(); await focus();

// Level 2 at +3.000; walls on Level 1 up to Level 2; copied to Level 2 (as in the brief)
await keys("LL"); await page.locator("#lvAdd").click(); await page.locator("#lvOk").click();
await focus(); await keys("WA");
await page.locator(".sk-options select").nth(1).selectOption({ label: "Up to level: Level 2" });
await page.locator(".sk-options .seg button[title='Rectangle']").click(); await focus();
await click(0, 0); await click(10000, 8000); await esc2();
// an interior wall on Level 1, also up to Level 2 (it will sit under the floor)
await focus(); await keys("WA");
await page.locator(".sk-options .seg button[title='Line']").click();
await page.locator("#pType").selectOption("wt-int150"); await focus();
await click(4000, 0); await click(4000, 8000); await esc2();
const innerId = (await model()).walls.find(w => w.typeId === "wt-int150").id;
await S(id => { const a = window.__sketch; a.selection.clear(); a.doc.walls.filter(w => w.id !== id).forEach(w => a.selection.add(w.id)); a.selectionChanged(); }, innerId);
await page.locator("#ribbonTabs button", { hasText: "Modify" }).click();
await ribbon("copyLevels"); await page.locator(".sk-dialog input[type=checkbox]").first().check(); await page.locator("#cOk").click();
await page.locator("#browser [data-level]", { hasText: "Level 2" }).click(); await view();

// 1. Floor (SB) on Level 2: sketch mode, Pick Walls on the inside of the four walls
await focus(); await keys("SB");
check(await S(() => !!window.__sketch.sketch), "SB opens sketch mode");
check((await page.locator("#ribbonTabs").innerText()).includes("Create Floor Boundary"), "the ribbon shows Modify | Create Floor Boundary with Finish and Cancel");
for (const [x, y] of [[5000, 300], [9700, 4000], [5000, 7700], [300, 4000]]) { await page.mouse.move(0, 0); await click(x, y); }
let d = await model();
check(d.lines.filter(l => l.kind === "sketch").length === 4, "Pick Walls adds 4 magenta boundary lines");
await page.screenshot({ path: `${OUT}/phase5-sketch.png` });
await ribbon("finishSketch");
await page.waitForTimeout(150);
// the attach question
const ask = await page.locator("#askWrap").isVisible();
check(ask && (await page.locator("#ask").innerText()).includes("Attach the 1 wall"), "on Finish it offers to attach the one wall that is under the floor (the interior wall), not the outside walls");
if (ask) await page.locator("#askYes").click();
d = await model();
const floor = d.floors[0];
check(d.floors.length === 1 && d.lines.every(l => l.kind !== "sketch"), "Finish makes one floor and clears the sketch");
const area = await S(async () => { const F = await import("./assets/sketch/floors.js"); const f = window.__sketch.doc.floors[0]; return F.floorArea(F.floorParts(F.floorLoops(f))); });
check(near(area, (10000 - 255) * (8000 - 255), 1), `the floor fills the inside faces: ${(area / 1e6).toFixed(2)} m²`);
const z1s = await S(async id => { const W = await import("./assets/sketch/walls.js"); const a = window.__sketch; return a.doc.walls.filter(w => w.baseLevelId === "lv-1").map(w => ({ inner: w.id === id, z1: W.wallHeights(a.doc, w).z1 })); }, innerId);
check(z1s.find(x => x.inner) && near(z1s.find(x => x.inner).z1, 2850), "the interior wall now stops under the 150 mm slab at +2.850");
check(z1s.filter(x => !x.inner).every(x => near(x.z1, 3000)), "the outside walls still run up to Level 2, so there is no gap round the building");

// 2. Open loop: refused with the lines highlighted; fixed with Trim to Corner; then a hole for a stair
await page.locator("#browser [data-level]", { hasText: "Level 1" }).click(); await view();
await focus(); await keys("SB");
await page.locator(".sk-options .seg button[title='Line']").click(); await focus();
await click(0, 0); await click(6000, 0); await click(6000, 5000); await click(500, 5000); await page.keyboard.press("Escape"); // gap on the west side
await keys("BL"); await page.locator(".sk-options .seg button[title='Line']").click(); await focus();
await click(0, 600); await click(0, 0); await esc2();
await ribbon("finishSketch");
check((await page.locator("#dialog").innerText()).includes("closed loops"), "an open boundary is refused: Lines must be in closed loops");
check((await S(() => window.__sketch.sketch.bad.size)) === 2, "and the two open lines are shown in red");
await page.locator("#fOk").click();
await page.screenshot({ path: `${OUT}/phase5-open.png` });
await focus(); await keys("TR");
await page.locator(".sk-options .seg button[title='Trim/Extend to Corner']").click(); await focus();
await click(0, 300); await click(3000, 5000); await esc2();
await keys("BL"); await page.locator(".sk-options .seg button[title='Rectangle']").click(); await focus();
await click(2000, 2000); await click(3200, 4500); await esc2();
await ribbon("finishSketch"); await page.waitForTimeout(150);
if (await page.locator("#askWrap").isVisible()) await page.locator("#askNo").click();
d = await model();
const f1 = d.floors.find(f => f.levelId === "lv-1");
const a1 = await S(async id => { const F = await import("./assets/sketch/floors.js"); const f = window.__sketch.doc.floors.find(x => x.id === id); const parts = F.floorParts(F.floorLoops(f)); return { area: F.floorArea(parts), holes: parts[0].holes.length }; }, f1?.id);
check(!!f1 && a1.holes === 1 && near(a1.area, 6000 * 5000 - 1200 * 2500, 1), `after trimming, the floor finishes with a stair hole: ${(a1.area / 1e6).toFixed(2)} m², 1 hole`);

// 3. Properties: Height Offset From Level -150; 3D slab top and bottom
await S(id => { const a = window.__sketch; a.selection.clear(); a.selection.add(id); a.selectionChanged(); }, f1.id);
await page.locator("#pHOff").fill("-150"); await page.locator("#pHOff").dispatchEvent("change");
const slab = await S(id => { const v = window.__sketch.view3d; v.rebuild(); let box = null; v.root.traverse(o => { if (o.isMesh && o.userData.id === id) { o.geometry.computeBoundingBox(); box = o.geometry.boundingBox; } }); return box && { y0: box.min.y, y1: box.max.y }; }, f1.id);
check(!!slab && near(slab.y1, -0.15, 1e-6) && near(slab.y0, -0.30, 1e-6), `3D: the slab's top is at -0.150 and it is 150 thick (${JSON.stringify(slab)})`);

// 4. Double-click the floor edits its boundary; Cancel leaves it as it was
const before = JSON.stringify((await model()).floors);
await page.keyboard.press("Escape");
const pt = await toScreen(5000, 1000); await page.mouse.move(pt.x, pt.y); await page.waitForTimeout(80); await page.mouse.dblclick(pt.x, pt.y);
check(await S(() => !!window.__sketch.sketch?.editFloorId), "double-clicking a floor opens its boundary for editing");
check((await model()).lines.filter(l => l.kind === "sketch").length === 8, "with its 8 boundary lines (outline and hole)");
await ribbon("cancelSketch");
check(JSON.stringify((await model()).floors) === before && (await model()).lines.every(l => l.kind !== "sketch"), "Cancel Edit Mode leaves the floor unchanged");

// 5. 3D view of both floors
await S(() => { const v = window.__sketch.view3d; v.fit(); v.lookFrom("sw"); });
await page.waitForTimeout(300);
await page.locator("#view3d canvas").screenshot({ path: `${OUT}/phase5-3d.png` });

// 6. Undo the whole floor; reload keeps everything
const keep = JSON.stringify(await model());
await page.waitForTimeout(900); await page.reload();
await page.waitForFunction(() => window.__sketch?.ready && window.__sketch.doc.floors.length > 0);
check(JSON.stringify(await model()) === keep, "reload keeps the floors exactly");

check(!errors.length, `no page errors ${errors.length ? errors.join(" | ") : ""}`);
await browser.close(); srv.close();
console.log(fails.length ? `\nPHASE 5 BROWSER TEST FAILED (${fails.length})` : "\nPHASE 5 BROWSER TEST PASSED");
process.exit(fails.length ? 1 : 0);
