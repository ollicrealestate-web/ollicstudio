// Phase 6 browser test: extrusions, sweeps, voids, wall sweeps and reveals, parapet, reference planes.
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
const ribbon = id => page.locator(`.sk-tool[data-id='${id}']`).first().click();
const tab = name => page.locator("#ribbonTabs button", { hasText: name }).click();
const select = ids => S(ids => { const a = window.__sketch; a.selection.clear(); ids.forEach(id => a.selection.add(id)); a.selectionChanged(); }, ids);
const prop = async (sel, v) => { await page.locator(sel).fill(String(v)); await page.locator(sel).dispatchEvent("change"); };
await S(() => { const p = window.__sketch.plan; p.s = 0.03; p.cx = 8000; p.cy = 3500; p.invalidate(); });
await focus();

await keys("WA"); await page.locator(".sk-options .seg button[title='Rectangle']").click(); await focus();
await click(0, 0); await click(10000, 8000); await esc2();
const ext = (await model()).walls.map(w => w.id);
const south = (await model()).walls.find(w => near(w.a.y, 0) && near(w.b.y, 0)).id;

// 1. Extrusion: a 2 x 1 m block from 0 to 900
await tab("Architecture"); await ribbon("component"); await page.locator(".sk-dialog [data-k='extrusion']").click();
check((await page.locator("#ribbonTabs").innerText()).includes("Create Extrusion"), "Component > Extrusion opens Modify | Create Extrusion");
await prop("#ckEnd", 900);
await page.locator(".sk-options .seg button[title='Rectangle']").click(); await focus();
await click(12000, 0); await click(14000, 1000); await esc2();
await ribbon("finishSketch");
let d = await model();
const ex = d.components.find(c => c.kind === "extrusion" && !c.isVoid);
check(!!ex && ex.end === 900, "Finish makes an extrusion from 0 to 900");
const exBox = await S(id => { const v = window.__sketch.view3d; v.rebuild(); let b = null; v.root.traverse(o => { if (o.isMesh && o.userData.id === id) { o.geometry.computeBoundingBox(); b = o.geometry.boundingBox; } }); return b && { y0: b.min.y, y1: b.max.y, dx: b.max.x - b.min.x }; }, ex?.id);
check(!!exBox && near(exBox.y1 - exBox.y0, 0.9, 1e-6) && near(exBox.dx, 2, 1e-6), "3D: the block is 2 m long and 0.9 m high");

// 2. Void extrusion through the south wall: 1000 wide, from 1000 to 2000 high
await ribbon("component"); await page.locator(".sk-dialog [data-k='vextrusion']").click();
await prop("#ckStart", 1000); await prop("#ckEnd", 2000);
await page.locator(".sk-options .seg button[title='Rectangle']").click(); await focus();
await click(4000, -500); await click(5000, 500); await esc2();
await ribbon("finishSketch");
const cut = await S(async id => {
  const O = await import("./assets/sketch/openings.js"), Sx = await import("./assets/sketch/solids.js");
  const a = window.__sketch, w = a.doc.walls.find(x => x.id === id), f = a.footprints("lv-1").get(id);
  return { plain: Sx.prismVolume(O.wallSolids(a.doc, w, f)), cut: Sx.prismVolume(a.cutWallSolids(w, O.wallSolids(a.doc, w, f))) };
}, south);
check(near(cut.plain - cut.cut, 1000 * 255 * 1000, 1), `the void cuts exactly 1000 x 1000 through the 255 mm wall (${Math.round((cut.plain - cut.cut) / 1e6)} x 10^6 mm³)`);

// 3. Sweep: a cornice along a path line, 2000 above the level
await ribbon("component"); await page.locator(".sk-dialog [data-k='sweep']").click();
check((await page.locator("#ribbonTabs").innerText()).includes("Sweep > Path"), "Component > Sweep opens Modify | Sweep > Path");
await page.locator("#ckProf").selectOption("pf-cornice"); await prop("#ckHt", 2000);
await page.locator(".sk-options .seg button[title='Line']").click(); await focus();
await click(12000, 3000); await click(16000, 3000); await esc2();
await ribbon("finishSketch");
d = await model();
check(d.components.some(c => c.kind === "sweep" && c.profileId === "pf-cornice" && c.height === 2000), "Finish makes a cornice sweep 2000 above the level");

// 4. Wall Sweep: a plinth band round the four outside walls (one mitred loop)
await select(ext); await tab("Architecture"); await ribbon("wallSweep");
await page.locator("#wProf").selectOption("pf-plinth"); await page.locator("#wOk").click();
d = await model();
const band = d.components.find(c => c.kind === "wallSweep" && !c.reveal);
check(!!band && band.wallIds.length === 4, "Wall Sweep adds a plinth band on all four walls");
const loop = await S(async id => { const C = await import("./assets/sketch/components.js"); const a = window.__sketch; return C.wallSweepPaths(a.doc, a.doc.components.find(c => c.id === id)).map(p => ({ closed: p.closed, n: p.pts.length })); }, band?.id);
check(loop.length === 1 && loop[0].closed && loop[0].n === 4, "it runs as one closed loop, mitred at the corners");

// 5. Wall Reveal on the south wall: 20 deep x 50 high at 1200
await select([south]); await ribbon("wallReveal");
await page.locator("#wW").fill("20"); await page.locator("#wH").fill("50"); await page.locator("#wDist").fill("1200"); await page.locator("#wOk").click();
const rv = await S(async id => {
  const O = await import("./assets/sketch/openings.js"), Sx = await import("./assets/sketch/solids.js");
  const a = window.__sketch, w = a.doc.walls.find(x => x.id === id), f = a.footprints("lv-1").get(id);
  return Sx.prismVolume(a.cutWallSolids(w, O.wallSolids(a.doc, w, f)));
}, south);
// the groove runs the length of the outside face (10 255) and is 40 shorter at its 20 mm depth because of the mitred corners;
// where the void has already cut the wall away (1000 long) there is nothing left to groove
check(near(cut.cut - rv, 20 * 50 * (10255 - 20) - 20 * 50 * 1000, 2), `the reveal cuts a 20 x 50 groove along the outside face (${Math.round(cut.cut - rv)} mm³)`);
const outside = await S(async id => { const C = await import("./assets/sketch/components.js"); const a = window.__sketch; const w = a.doc.walls.find(x => x.id === id); const r = C.revealsFor(a.doc, w)[0]; return r.n.y; }, south);
check(outside < 0, "the reveal is on the outside face of the south wall (facing south)");

// 6. Parapet with coping on the four walls
await select(ext); await ribbon("parapet");
await page.locator("#pOk").click();
d = await model();
const par = d.walls.filter(w => /Parapet/.test(d.wallTypes.find(t => t.id === w.typeId)?.name || ""));
const parH = await S(async () => { const W = await import("./assets/sketch/walls.js"); const a = window.__sketch; return a.doc.walls.filter(w => /Parapet/.test(a.doc.wallTypes.find(t => t.id === w.typeId).name)).map(w => W.wallHeights(a.doc, w)); });
check(par.length === 4 && parH.every(h => near(h.z0, 3000) && near(h.z1, 3900)), "Parapet adds 4 walls from +3.000 to +3.900 on top of the walls");
const faces = await S(async () => { const a = window.__sketch; const fp = a.footprints("lv-1"); const xs = [], ys = []; for (const w of a.doc.walls) { if (!/Parapet/.test(a.doc.wallTypes.find(t => t.id === w.typeId).name)) continue; for (const pc of fp.get(w.id).pieces) for (const p of pc) { xs.push(p.x); ys.push(p.y); } } return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]; });
check(near(faces[0], -127.5) && near(faces[1], 10127.5) && near(faces[2], -127.5) && near(faces[3], 8127.5), `the parapet walls are flush with the walls' outside faces (${faces.map(Math.round)})`);
check(d.components.some(c => c.kind === "sweep" && c.profileId === "pf-coping"), "with a coping sweep on top");

// 7. Reference plane (RP), seen on every level
await focus(); await keys("RP"); await click(-1500, -1000); await click(-1500, 9000); await esc2();
d = await model();
check(d.referencePlanes.length === 1, "RP draws a reference plane");

// 8. Double-click the extrusion to edit its profile; Cancel keeps it
await page.keyboard.press("Escape");
const pt = await toScreen(13000, 500); await page.mouse.move(pt.x, pt.y); await page.waitForTimeout(80); await page.mouse.dblclick(pt.x, pt.y);
check(await S(() => window.__sketch.sketch?.kind === "extrusion"), "double-clicking the extrusion opens its profile for editing");
await ribbon("cancelSketch");
check((await model()).components.some(c => c.id === ex.id), "Cancel keeps it as it was");

// 9. Pictures
await page.screenshot({ path: `${OUT}/phase6-plan.png` });
for (const c of ["sw", "ne"]) { await S(c => { const v = window.__sketch.view3d; v.fit(); v.lookFrom(c); }, c); await page.waitForTimeout(300); await page.locator("#view3d canvas").screenshot({ path: `${OUT}/phase6-3d-${c}.png` }); }

const keep = JSON.stringify(await model());
await page.waitForTimeout(900); await page.reload();
await page.waitForFunction(() => window.__sketch?.ready && window.__sketch.doc.components.length > 0);
check(JSON.stringify(await model()) === keep, "reload keeps every component exactly");

check(!errors.length, `no page errors ${errors.length ? errors.join(" | ") : ""}`);
await browser.close(); srv.close();
console.log(fails.length ? `\nPHASE 6 BROWSER TEST FAILED (${fails.length})` : "\nPHASE 6 BROWSER TEST PASSED");
process.exit(fails.length ? 1 : 0);
