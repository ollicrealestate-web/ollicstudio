// Phase 2 browser test: levels and walls, in real Chromium. Run: node tests/sketch/e2e_phase2.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { serve } from "./e2e_phase1.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const OUT = process.argv[2] || "out/sketch";
mkdirSync(OUT, { recursive: true });
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };

const srv = await serve();
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
page.on("dialog", d => d.accept());
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);
await page.evaluate(() => localStorage.clear());

const S = (fn, arg) => page.evaluate(fn, arg);
const model = () => S(() => JSON.parse(JSON.stringify(window.__sketch.doc)));
const toScreen = (x, y) => page.evaluate(([x, y]) => { const a = window.__sketch, r = document.getElementById("planCanvas").getBoundingClientRect(), s = a.plan.toScreen({ x, y }); return { x: r.left + s.x, y: r.top + s.y }; }, [x, y]);
const click = async (x, y, opts) => { const p = await toScreen(x, y); await page.mouse.move(p.x - 3, p.y - 3); await page.mouse.move(p.x, p.y, { steps: 2 }); await page.mouse.click(p.x, p.y, opts); await page.waitForTimeout(60); };
const hover = async (x, y) => { const p = await toScreen(x, y); await page.mouse.move(p.x, p.y, { steps: 3 }); await page.waitForTimeout(40); };
const keys = async s => { for (const ch of s) await page.keyboard.press(ch === "\n" ? "Enter" : ch); };
const focus = () => page.locator("#planCanvas").focus();
const setView = () => S(() => { const p = window.__sketch.plan; p.s = 0.04; p.cx = 5500; p.cy = 4000; p.invalidate(); });
await setView(); await focus();

// 1. Levels: add Level 2 at +3.000 from the Levels dialog (LL)
await keys("LL");
await page.locator("#lvAdd").click();
let d = await model();
check(d.levels.length === 2 && d.levels.some(l => l.name === "Level 2" && l.elevation === 3000), "Levels dialog adds Level 2 at +3.000");
check(await page.locator("#browser").getByText("Level 2").count() === 1, "Level 2 gets its own floor plan in the Project Browser");
// floor-to-floor height of Level 1 to 3300 moves Level 2
await page.locator('tr:has(input[value="Level 1"]) input[data-f="height"]').fill("3300");
await page.locator('tr:has(input[value="Level 1"]) input[data-f="height"]').dispatchEvent("change");
check((await model()).levels.find(l => l.name === "Level 2").elevation === 3300, "changing Level 1's height moves Level 2 to +3.300");
await page.locator('tr:has(input[value="Level 1"]) input[data-f="height"]').fill("3000");
await page.locator('tr:has(input[value="Level 1"]) input[data-f="height"]').dispatchEvent("change");
// 40 m limit shown in the dialog
await page.locator('tr:has(input[value="Level 1"]) input[data-f="height"]').fill("41000");
await page.locator('tr:has(input[value="Level 1"]) input[data-f="height"]').dispatchEvent("change");
check((await page.locator(".sk-dialog .err").innerText()).includes("40 m"), "a height above 40 m is refused with a clear message");
check((await model()).levels.find(l => l.name === "Level 2").elevation === 3000, "and nothing changed");
await page.locator("#lvOk").click();

// 2. Exterior walls: Wall (WA), Rectangle, 10 x 8 m
await focus(); await keys("WA");
check(await S(() => window.__sketch.tool.name) === "wall", "WA starts the Wall tool");
await page.locator(".sk-options .seg button[title='Rectangle']").click();
await focus();
await click(0, 0); await click(10000, 8000);
d = await model();
check(d.walls.length === 4, `rectangle makes 4 walls (got ${d.walls.length})`);
check(d.walls.every(w => w.typeId === "wt-ext225"), "default type: Exterior - 225 mm block + render");
const outline = await S(() => window.__sketch.footprints("lv-1"));
const outerEdges = await S(async () => { const m = await import("./assets/sketch/walls.js"); return m.outlineEdges([...window.__sketch.footprints("lv-1").values()].flatMap(f => f.pieces)).length; });
check(outerEdges === 8, `clean corners: the plan outline is 4 outer + 4 inner lines, nothing inside the walls (got ${outerEdges})`);

// 3. Interior wall: 150 mm type, line from the bottom wall to the top wall (T joins)
await page.locator(".sk-options .seg button[title='Line']").click();
await page.locator("#pType").selectOption("wt-int150");
await focus();
await click(4000, 0); await click(4000, 8000);
await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
d = await model();
const inner = d.walls.find(w => w.typeId === "wt-int150");
check(!!inner, "interior 150 mm wall drawn");
const tees = await S(async () => { const m = await import("./assets/sketch/walls.js"); const a = window.__sketch; const fp = a.footprints("lv-1"); const id = a.doc.walls.find(w => w.typeId === "wt-int150").id; const ys = fp.get(id).pieces.flat().map(p => p.y); return [Math.min(...ys), Math.max(...ys)]; });
check(Math.abs(tees[0] - 127.5) < 0.01 && Math.abs(tees[1] - 7872.5) < 0.01, `interior wall stops at the exterior walls' inner faces (got ${tees.map(v => v.toFixed(1))})`);
await page.screenshot({ path: `${OUT}/phase2-walls.png` });

// 4. Select it: temporary dimensions to the walls either side; type 3500 to move it
await click(4000, 4000);
check((await S(() => [...window.__sketch.selection]))[0] === inner.id, "click selects the interior wall");
const dims = await S(() => window.__sketch.plan.hits.map(h => ({ cx: h.cx, cy: h.cy })));
check(dims.length >= 3, `selected wall shows its length and the distances to the walls each side (${dims.length} clickable)`);
await page.screenshot({ path: `${OUT}/phase2-tempdims.png` });
// find the dimension whose label reads 4000 (centre of the left wall to centre of this one)
const target = await S(() => { const a = window.__sketch; const r = document.getElementById("planCanvas").getBoundingClientRect(); const p = a.plan.toScreen({ x: 2000, y: 4000 }); const h = a.plan.hits.reduce((b, h) => (!b || Math.hypot(h.cx - p.x, h.cy - p.y) < Math.hypot(b.cx - p.x, b.cy - p.y) ? h : b), null); return { x: r.left + h.cx, y: r.top + h.cy }; });
await page.mouse.click(target.x, target.y);
await page.waitForTimeout(50);
check(await page.locator("#inlineInput").isVisible(), "clicking the dimension opens a box to type in");
check(await page.locator("#inlineInput").inputValue() === "4000", `it shows the current distance 4000 (got ${await page.locator("#inlineInput").inputValue()})`);
await page.locator("#inlineInput").fill("3500"); await page.keyboard.press("Enter");
d = await model();
const moved = d.walls.find(w => w.id === inner.id);
check(Math.abs(moved.a.x - 3500) < 0.01 && Math.abs(moved.b.x - 3500) < 0.01, `wall moved to 3500 from the left wall (got ${moved.a.x})`);
check(Math.abs(moved.a.y) < 0.01 && Math.abs(moved.b.y - 8000) < 0.01, "it still ends on the exterior walls");

// 5. Properties: change its type to the 100 mm partition
await page.locator("#pType").selectOption("wt-int100");
check((await model()).walls.find(w => w.id === inner.id).typeId === "wt-int100", "type changed in Properties");
// 6. Tab selects the chain of exterior walls; set Top Constraint to Level 2
await page.keyboard.press("Escape");
await hover(10000, 3000);
for (let i = 0; i < 3; i++) { const h = await S(() => window.__sketch.hoverId); if (String(h).startsWith("chain:")) break; await page.keyboard.press("Tab"); }
await page.mouse.down(); await page.mouse.up(); // click where the pointer is, without moving it
const selN = await S(() => window.__sketch.selection.size);
check(selN === 4, `Tab picks the chain of 4 joined exterior walls (got ${selN})`);
await page.locator("#pTop").selectOption({ label: "Up to level: Level 2" });
d = await model();
check(d.walls.filter(w => w.topLevelId === d.levels.find(l => l.name === "Level 2").id).length === 4, "all 4 now run up to Level 2");
// joined walls stretch when one is dragged: drag the right-hand wall 1 m further east
await page.keyboard.press("Escape");
await click(10000, 3000);
{ const p = await toScreen(10000, 3000), q = await toScreen(11000, 3000); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 8 }); await page.mouse.up(); }
d = await model();
const east = d.walls.filter(w => w.typeId === "wt-ext225" && Math.abs(w.a.x - w.b.x) < 1);
const longSides = d.walls.filter(w => w.typeId === "wt-ext225" && Math.abs(w.a.y - w.b.y) < 1).map(w => Math.abs(w.a.x - w.b.x));
check(east.some(w => Math.abs(w.a.x - 11000) < 0.5) && longSides.every(L => Math.abs(L - 11000) < 0.5), `dragging a wall stretches the walls joined to it (sides now ${longSides})`);
await page.keyboard.press("Control+z");
check((await model()).walls.filter(w => w.typeId === "wt-ext225" && Math.abs(w.a.y - w.b.y) < 1).every(w => Math.abs(Math.abs(w.a.x - w.b.x) - 10000) < 0.5), "one undo puts the walls back");

// 7. Copy the exterior walls to Level 2
await page.keyboard.press("Escape");
await hover(10000, 3000);
for (let i = 0; i < 3; i++) { const h = await S(() => window.__sketch.hoverId); if (String(h).startsWith("chain:")) break; await page.keyboard.press("Tab"); }
await page.mouse.down(); await page.mouse.up(); // click where the pointer is, without moving it
await page.locator("#ribbonTabs button", { hasText: "Modify" }).click();
await page.locator(".sk-tool[data-id='copyLevels']").click();
await page.locator(".sk-dialog input[type=checkbox]").first().check();
await page.locator("#cOk").click();
d = await model();
const l2 = d.levels.find(l => l.name === "Level 2").id;
const up = d.walls.filter(w => w.baseLevelId === l2);
check(up.length === 4, `4 walls copied to Level 2 (got ${up.length})`);
check(up.every(w => w.topLevelId === null && w.unconnectedHeight === 3000), "copied walls keep a 3000 mm height (no level above Level 2)");
await page.locator("#browser [data-level]", { hasText: "Level 2" }).click();
await page.locator("#vUnder").check();
await setView();
await page.screenshot({ path: `${OUT}/phase2-level2-underlay.png` });
await page.locator("#browser [data-level]", { hasText: "Level 1" }).click();
await setView();

// 8. Radius corner and an arc wall
await page.locator("#ribbonTabs button", { hasText: "Architecture" }).click();
await focus(); await keys("WA");
await page.locator(".sk-options .seg button[title='Line']").click();
await page.locator(".sk-options label:has-text('Radius') input[type=checkbox]").check();
await S(() => { const p = window.__sketch.plan; p.s = 0.04; p.cx = 16000; p.cy = 4000; p.invalidate(); });
await focus();
await click(14000, 0); await click(18000, 0); await click(18000, 4000);
await page.keyboard.press("Escape");
await page.locator(".sk-options label:has-text('Radius') input[type=checkbox]").uncheck();
await page.locator(".sk-options .seg button[title='Start-End-Radius Arc']").click();
await focus();
await click(14000, 6000); await click(18000, 6000); await click(16000, 8000);
await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
d = await model();
const arcs = d.walls.filter(w => w.shape === "arc");
check(arcs.some(a => Math.abs(a.r - 1000) < 0.5), `Radius option rounds the corner with a 1000 mm arc wall (radii ${arcs.map(a => a.r.toFixed(0))})`);
check(arcs.some(a => Math.abs(a.r - 2000) < 0.5), "Start-End-Radius Arc wall drawn (radius 2000)");

// 9. 3D: walls at the right heights, four corner views, visual styles, click to select
const meshes = await S(() => { const v = window.__sketch.view3d; v.rebuild(); const out = []; v.root.traverse(o => { if (o.isMesh && o.userData.id) { o.geometry.computeBoundingBox(); out.push({ id: o.userData.id, y0: o.geometry.boundingBox.min.y, y1: o.geometry.boundingBox.max.y }); } }); return out; });
const l1walls = meshes.filter(m => Math.abs(m.y0) < 1e-6);
check(l1walls.length >= 5 && meshes.some(m => Math.abs(m.y0 - 3) < 1e-6 && Math.abs(m.y1 - 6) < 1e-6), "3D: Level 1 walls from 0, Level 2 walls from 3.0 to 6.0 m");
await S(() => window.__sketch.view3d.fit());
for (const c of ["sw", "se", "ne", "nw"]) {
  await S(c => window.__sketch.view3d.lookFrom(c), c);
  await page.waitForTimeout(250);
  await page.locator("#view3d canvas").screenshot({ path: `${OUT}/phase2-3d-${c}.png` });
}
for (const style of ["wire", "hidden", "consistent", "realistic", "shaded"]) {
  await page.locator("#vStyle").selectOption(style);
  await page.waitForTimeout(200);
  if (style === "realistic" || style === "hidden") await page.locator("#view3d canvas").screenshot({ path: `${OUT}/phase2-3d-${style}.png` });
}
// aim at the middle of the south wall of Level 1 (y = 0, x = 5 m, 1.5 m up), seen from the south-west
await page.keyboard.press("Escape");
const pick = await S(() => { const a = window.__sketch, v = a.view3d; v.lookFrom("sw"); v.camera.updateMatrixWorld(); const p = v.camera.position.clone().set(5, 1.5, 0.2).project(v.camera); const r = v.renderer.domElement.getBoundingClientRect(); return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height }; });
await page.mouse.click(pick.x, pick.y);
check((await S(() => window.__sketch.selection.size)) === 1, "clicking a wall in 3D selects it (and shows it in Properties)");
check(await page.locator("#pType").count() === 1, "Properties shows the wall picked in 3D");

// 10. Every level has its own plan; 10 levels at most
await focus(); await keys("LL");
for (let i = 0; i < 8; i++) await page.locator("#lvAdd").click();
check((await model()).levels.length === 10, "10 levels can be added");
check(await page.locator("#lvAdd").isDisabled(), "Add level above is disabled at 10 levels");
await page.locator("#lvOk").click();

// 11. Reload restores everything
const before = JSON.stringify(await model());
await page.waitForTimeout(900);
await page.reload();
await page.waitForFunction(() => window.__sketch?.ready && window.__sketch.doc.walls.length > 0);
check(JSON.stringify(await model()) === before, "reload restores exactly the same model");

check(!errors.length, `no page errors ${errors.length ? errors.join(" | ") : ""}`);
await browser.close(); srv.close();
console.log(fails.length ? `\nPHASE 2 BROWSER TEST FAILED (${fails.length})` : "\nPHASE 2 BROWSER TEST PASSED");
process.exit(fails.length ? 1 : 0);
