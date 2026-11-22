// Phase 7 browser test: roofs by footprint (hip, gable, L-shaped, flat with a fall + parapet) and by extrusion.
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
const T30 = Math.tan(Math.PI / 6);

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
const view = (cx = 5000, cy = 4000, s = 0.04) => S(([cx, cy, s]) => { const p = window.__sketch.plan; p.s = s; p.cx = cx; p.cy = cy; p.invalidate(); }, [cx, cy, s]);
const ribbon = id => page.locator(`.sk-tool[data-id='${id}']`).click();
const geo = id => S(async id => { const R = await import("./assets/sketch/roofs.js"); const a = window.__sketch, r = a.doc.roofs.find(x => x.id === id); const g = R.roofGeometry(a.doc, r); return { top: g.top, lines: g.lines.map(l => ({ kind: l.kind, len: Math.hypot(l.a.x - l.b.x, l.a.y - l.b.y), z: Math.max(l.a.z, l.b.z) })), outline: g.outline, soffit: g.soffit, faces: g.faces.length }; }, id);
const heights = () => S(async () => { const W = await import("./assets/sketch/walls.js"); const a = window.__sketch; return Object.fromEntries(a.doc.walls.map(w => [w.id, W.wallHeights(a.doc, w)])); });
const meshTop = id => S(id => { const v = window.__sketch.view3d; v.rebuild(); let y = -Infinity; v.root.traverse(o => { if (o.isMesh && o.userData.id === id) { o.geometry.computeBoundingBox(); y = Math.max(y, o.geometry.boundingBox.max.y); } }); return y; }, id);
const select = id => S(id => { const a = window.__sketch; a.setTool("select"); a.selection.clear(); a.selection.add(id); a.selectionChanged(); }, id);
const answer = async yes => { await page.waitForTimeout(150); if (await page.locator("#askWrap").isVisible()) { const t = await page.locator("#ask").innerText(); await page.locator(yes ? "#askYes" : "#askNo").click(); return t; } return ""; };
const shot3d = async (name, corner = "sw") => { await S(c => { const v = window.__sketch.view3d; v.fit(); v.lookFrom(c); }, corner); await page.waitForTimeout(250); await page.locator("#view3d canvas").screenshot({ path: `${OUT}/${name}.png` }); };

await view(); await focus();
// Level 2 at +3.000, and a 10 x 8 m house of exterior walls on Level 1 up to Level 2
await keys("LL"); await page.locator("#lvAdd").click(); await page.locator("#lvOk").click();
await focus(); await keys("WA");
await page.locator(".sk-options select").nth(1).selectOption({ label: "Up to level: Level 2" });
await page.locator(".sk-options .seg button[title='Rectangle']").click(); await focus();
await click(0, 0); await click(10000, 8000); await esc2();
let d = await model();
check(d.walls.length === 4, "4 exterior walls drawn");

// 1. Roof by Footprint (RF): Pick Walls, Overhang 600, slope 30°, on Level 2
await focus(); await keys("RF");
check(await S(() => window.__sketch.sketch?.kind === "roof"), "RF opens the roof footprint sketch");
check((await page.locator("#ribbonTabs").innerText()).includes("Create Roof Footprint"), "the ribbon shows Modify | Create Roof Footprint");
check(await S(() => window.__sketch.sketch.baseLevelId === window.__sketch.doc.levels.find(l => l.name === "Level 2").id), "the roof's base is Level 2, the level above, as Revit offers");
const opts = await page.locator("#optionsBar").innerText();
check(opts.includes("Pick Walls") && opts.includes("Defines Slope") && opts.includes("Overhang") && opts.includes("Extend to wall core"), "Options Bar: Pick Walls, Defines Slope, Slope, Overhang, Extend to wall core");
for (const [x, y] of [[5000, 0], [10000, 4000], [5000, 8000], [0, 4000]]) { await page.mouse.move(0, 0); await click(x, y); }
d = await model();
const sketchL = d.lines.filter(l => l.kind === "sketch");
check(sketchL.length === 4 && sketchL.every(l => l.definesSlope && l.overhang === 600), "Pick Walls adds 4 boundary lines that define slope, each with a 600 overhang");
await page.screenshot({ path: `${OUT}/phase7-sketch.png` });
await ribbon("finishSketch");
const askT = await answer(true);
check(askT.includes("Attach the 4 walls"), `on Finish it offers to attach the 4 walls below ("${askT.slice(0, 60)}")`);
d = await model();
const hip = d.roofs[0];
check(d.roofs.length === 1 && d.lines.every(l => l.kind !== "sketch"), "Finish makes one roof and clears the sketch");
let g = await geo(hip.id);
const W = 10000 + 255 + 1200, H = 8000 + 255 + 1200; // outside faces plus the overhang
const xs = g.outline.map(p => p.x), ys = g.outline.map(p => p.y);
check(near(Math.max(...xs) - Math.min(...xs), W, 0.5) && near(Math.max(...ys) - Math.min(...ys), H, 0.5), `footprint is the outside faces plus 600: ${Math.round(Math.max(...xs) - Math.min(...xs))} x ${Math.round(Math.max(...ys) - Math.min(...ys))}`);
const ridge = g.lines.filter(l => l.kind === "ridge");
check(ridge.length === 1 && near(ridge[0].len, W - H, 0.5), `hip roof: one ridge, ${Math.round(ridge[0]?.len)} mm long (= ${W} - ${H})`);
check(g.lines.filter(l => l.kind === "hip").length === 4, "and four hips");
const ridgeUnder = 3000 + (H / 2 - 600) * T30;
check(near(g.top, ridgeUnder + 200 / Math.cos(Math.PI / 6), 0.5), `the slope starts at the wall face: roof top ${(g.top / 1000).toFixed(3)} m`);
check(near((await model()).roofs[0].topZ, g.top, 0.01), "the roof's top is stored for the 40 m check");
let hs = await heights();
check(d.walls.every(w => w.attachTopTo === hip.id) && Object.values(hs).every(h => h.z1 >= 3000 && h.z1 < ridgeUnder), "the walls are attached; under the hip they stay under the roof");
await page.screenshot({ path: `${OUT}/phase7-hip-plan.png` });
await shot3d("phase7-hip-3d");
const roofTop3d = await meshTop(hip.id);
check(near(roofTop3d, g.top / 1000, 1e-3), `3D roof top at ${roofTop3d.toFixed(3)} m`);

// 2. Gable: double-click the roof, untick Defines Slope on the two short edges, Finish
await page.keyboard.press("Escape");
let pt = await toScreen(5000, 4000); await page.mouse.move(pt.x, pt.y); await page.waitForTimeout(80); await page.mouse.dblclick(pt.x, pt.y);
check(await S(() => !!window.__sketch.sketch?.editRoofId), "double-clicking the roof opens its footprint");
const shortIds = (await model()).lines.filter(l => l.kind === "sketch" && Math.abs(l.a.x - l.b.x) < 1).map(l => l.id);
await S(ids => { const a = window.__sketch; a.setTool("select"); a.selection.clear(); ids.forEach(id => a.selection.add(id)); a.selectionChanged(); }, shortIds);
check(await page.locator("#rlDef").isVisible(), "selected boundary lines show Defines Roof Slope in Properties");
await page.locator("#rlDef").uncheck();
await ribbon("finishSketch"); await answer(false);
g = await geo(hip.id);
const gr = g.lines.filter(l => l.kind === "ridge");
check(gr.length === 1 && near(gr[0].len, W, 0.5), `gable roof: the ridge runs the full ${Math.round(gr[0]?.len)} mm`);
hs = await heights();
d = await model();
const gableWalls = d.walls.filter(w => Math.abs(w.a.x - w.b.x) < 1);
check(gableWalls.length === 2 && gableWalls.every(w => near(hs[w.id].z1, ridgeUnder, 2)), `the gable walls rise to the ridge underside (${gableWalls.map(w => (hs[w.id].z1 / 1000).toFixed(3)).join(", ")} m)`);
const gTop = await meshTop(gableWalls[0].id);
check(near(gTop, ridgeUnder / 1000, 0.01), `3D: the gable wall's peak is at ${gTop.toFixed(3)} m, filling the gable`);
for (const c of ["sw", "se", "ne", "nw"]) await shot3d(`phase7-gable-${c}`, c);

// 3. Rafter cut Two Cut - Plumb with a 100 mm fascia
await select(hip.id);
await page.locator("#pCut").selectOption("two-cut-plumb");
g = await geo(hip.id);
check(Number.isFinite(g.soffit), "Rafter Cut: Two Cut - Plumb makes a level soffit behind a 100 mm fascia");

// 4. L-shaped hip roof drawn with lines on Level 2: one valley
await page.locator("#browser [data-level]", { hasText: "Level 2" }).click(); await view(25000, 4000);
await focus(); await keys("RF");
await page.locator(".sk-options .seg button[title='Line']").click(); await focus();
for (const [x, y] of [[20000, 0], [30000, 0], [30000, 4000], [26000, 4000], [26000, 8000], [20000, 8000], [20000, 0]]) await click(x, y);
await esc2();
await ribbon("finishSketch"); await answer(false);
d = await model();
const Lr = d.roofs.at(-1);
g = await geo(Lr.id);
check(d.roofs.length === 2 && g.lines.filter(l => l.kind === "valley").length === 1, "an L-shaped hip roof has exactly one valley");
check(near(g.top, 3000 + 3000 * T30 + 200 / Math.cos(Math.PI / 6), 0.5), "its top is set by the 6 m wide wing");

// 5. Flat roof with a fall (slope arrow) and a 900 mm parapet on its edge
await view(45000, 4000); await focus(); await keys("RF");
await page.locator(".sk-options .seg button[title='Rectangle']").click();
await page.locator(".sk-options label", { hasText: "Defines Slope" }).locator("input").uncheck(); await focus();
await click(40000, 0); await click(50000, 8000); await esc2();
await ribbon("slopeArrow"); await focus();
await click(40500, 4000); await click(49500, 4000);
check(await page.locator("#raTail").isVisible(), "the new slope arrow shows Height Offset at Tail / Head");
await page.locator("#raTail").fill("100"); await page.locator("#raTail").dispatchEvent("change");
await page.locator("#raHead").fill("0"); await page.locator("#raHead").dispatchEvent("change");
await ribbon("finishSketch"); await answer(false);
d = await model();
const flat = d.roofs.at(-1);
const fall = await S(async id => { const R = await import("./assets/sketch/roofs.js"); const a = window.__sketch, r = a.doc.roofs.find(x => x.id === id); return [R.undersideAt(a.doc, r, { x: 40500, y: 1000 }), R.undersideAt(a.doc, r, { x: 49500, y: 1000 })]; }, flat.id);
check(flat.slopeArrows.length === 1 && near(fall[0], 3100, 0.5) && near(fall[1], 3000, 0.5), `flat roof falls 100 mm along the arrow (${fall.map(Math.round).join(" → ")})`);
await select(flat.id);
await page.locator("#ribbonTabs button", { hasText: "Architecture" }).click();
await ribbon("parapet");
check((await page.locator("#dialog").innerText()).includes("edge of the selected roof"), "Parapet with a roof selected offers a parapet round its edge");
await page.locator("#pH").fill("900"); await page.locator("#pOk").click();
d = await model();
const fg = await geo(flat.id);
const par = d.walls.filter(w => /Parapet/.test(d.wallTypes.find(t => t.id === w.typeId)?.name || ""));
hs = await heights();
check(par.length === 4 && par.every(w => near(hs[w.id].z0, fg.top, 0.5) && near(hs[w.id].z1 - hs[w.id].z0, 900, 0.5)), `4 parapet walls stand on the roof top (+${(fg.top / 1000).toFixed(3)}) and are 900 high`);
const parOut = par.every(w => [w.a, w.b].every(p => fg.outline.some(q => Math.hypot(p.x - q.x, p.y - q.y) < 1)));
check(parOut, "their location lines follow the roof edge (flush with it)");
check(d.components.some(c => c.name === "Coping" && c.kind === "sweep"), "with a coping on top");
await view(45000, 4000);
await page.screenshot({ path: `${OUT}/phase7-flat-plan.png` });

// 6. Roof by Extrusion: profile line, depth, gable profile 2 m rise
await view(65000, 4000); await focus();
await ribbon("roofExtrusion"); await focus();
await click(60000, 0); await click(70000, 0); await click(70000, 8000);
check(await page.locator("#xShape").isVisible(), "after the profile line and depth, the profile dialog opens");
await page.locator("#xShape").selectOption("gable"); await page.locator("#xRise").fill("2000"); await page.locator("#xBase").fill("0");
await page.locator("#xOk").click(); await answer(false);
d = await model();
const ex = d.roofs.at(-1);
g = await geo(ex.id);
check(ex.method === "extrusion" && near(g.top, 3000 + 2000, 0.5) && g.lines.length === 1, `roof by extrusion: gable profile, top +${(g.top / 1000).toFixed(3)}, one ridge line`);
await page.screenshot({ path: `${OUT}/phase7-level2-plan.png` });
await S(() => window.__sketch.setLevel(window.__sketch.doc.levels[0].id));
await shot3d("phase7-all-3d", "sw");

// 7. Over 40 m is refused; undo and reload
await select(ex.id);
await page.locator("#pBase").fill("39000"); await page.locator("#pBase").dispatchEvent("change");
check((await model()).roofs.find(r => r.id === ex.id).baseOffset === 0 && (await page.locator("#toast").innerText()).includes("40 m"), "a roof that would pass 40 m is refused in plain words");
const n = (await model()).roofs.length;
await page.keyboard.press("Control+z");
check((await model()).roofs.length === n - 1, "Undo removes the last roof");
await page.keyboard.press("Control+y");
const keep = JSON.stringify(await model());
await page.waitForTimeout(900); await page.reload();
await page.waitForFunction(() => window.__sketch?.ready && window.__sketch.doc.roofs.length > 0);
check(JSON.stringify(await model()) === keep, "reload keeps the roofs exactly");
const ui = await page.locator("body").innerText();
check(!/revit|autodesk/i.test(ui), "no Revit or Autodesk names in the interface");
check(!errors.length, `no page errors ${errors.length ? errors.join(" | ") : ""}`);
await browser.close(); srv.close();
console.log(fails.length ? `\nPHASE 7 BROWSER TEST FAILED (${fails.length})` : "\nPHASE 7 BROWSER TEST PASSED");
process.exit(fails.length ? 1 : 0);
