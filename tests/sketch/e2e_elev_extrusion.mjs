// Browser test: extrusions (solid and void) sketched on a wall face in an elevation, and Pick Lines on model
// edges clicked in the 3D view, for sweeps and extrusions, on the level and in an elevation.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { serve } from "./e2e_phase1.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const OUT = process.argv[2] || "out/sketch";
mkdirSync(OUT, { recursive: true });
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };
const near = (a, b, t = 1) => Math.abs(a - b) <= t;
const srv = await serve();
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);
const S = (fn, arg) => page.evaluate(fn, arg);
const model = () => S(() => JSON.parse(JSON.stringify(window.__sketch.doc)));
const toScreen = (x, y) => S(([x, y]) => { const a = window.__sketch, r = document.getElementById("planCanvas").getBoundingClientRect(), s = a.plan.toScreen({ x, y }); return { x: r.left + s.x, y: r.top + s.y }; }, [x, y]);
const click = async (x, y) => { const p = await toScreen(x, y); await page.mouse.move(p.x - 3, p.y - 3); await page.mouse.move(p.x, p.y, { steps: 2 }); await page.mouse.click(p.x, p.y); await page.waitForTimeout(60); };
const keys = async s => { for (const ch of s) await page.keyboard.press(ch); };
const focus = () => page.locator("#planCanvas").focus();
const ribbon = id => page.locator(`.sk-tool[data-id='${id}']`).click();
const tab = name => page.locator("#ribbonTabs button", { hasText: name }).first().click();
const E = async (u, z) => { const b = await page.locator("#elevView canvas.sk-elev-over").boundingBox(); const s = await S(([u, z]) => window.__sketch.elev.toScreen(u, z), [u, z]); return { x: b.x + s.x, y: b.y + s.y }; };
const eClick = async (u, z) => { const p = await E(u, z); await page.mouse.move(p.x - 3, p.y - 3); await page.mouse.move(p.x, p.y, { steps: 2 }); await page.mouse.click(p.x, p.y); await page.waitForTimeout(80); };
/** Screen point of a model point (mm) in the 3D view. */
const P3 = async (x, y, z) => { const b = await page.locator("#view3d canvas").boundingBox(); const q = await S(async ([x, y, z]) => { const THREE = await import("three"); const v = window.__sketch.view3d; v.controls.update(); v.camera.updateMatrixWorld(); const p = new THREE.Vector3(x / 1000, z / 1000, -y / 1000).project(v.camera); return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 }; }, [x, y, z]); return { x: b.x + q.x * b.width, y: b.y + q.y * b.height }; };
const click3 = async (x, y, z) => { const p = await P3(x, y, z); await page.mouse.move(p.x - 2, p.y - 2); await page.mouse.move(p.x, p.y, { steps: 2 }); await page.waitForTimeout(80); await page.mouse.click(p.x, p.y); await page.waitForTimeout(100); };
const wallVol = id => S(async id => { const OP = await import("./assets/sketch/openings.js"); const a = window.__sketch, w = a.doc.walls.find(x => x.id === id); const f = a.footprints(w.baseLevelId).get(id); return OP.solidsVolume(a.cutWallSolids(w, OP.wallSolids(a.doc, w, f))); }, id);

await S(() => { const p = window.__sketch.plan; p.s = 0.04; p.cx = 5000; p.cy = 4000; p.invalidate(); });
await focus(); await keys("WA"); await page.locator(".sk-options .seg button[title='Rectangle']").click(); await focus();
await click(0, 0); await click(10000, 8000); await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
let d = await model();
const south = d.walls.find(w => near(w.a.y, 0) && near(w.b.y, 0));
const vol0 = await wallVol(south.id);

// ---- 1. a solid extrusion sketched on the south face
await tab("View"); await ribbon("elev-south"); await page.waitForTimeout(300);
await S(() => { const e = window.__sketch.elev; e.s = 0.05; e.cu = 5000; e.cz = 1800; e.invalidate(); });
await tab("Architecture"); await ribbon("component");
check((await page.locator("#dialog").innerText()).includes("sketched on a wall face in this elevation, pushed out"), "with an elevation open, Component > Extrusion offers to sketch on a wall face");
await page.locator("[data-k='extrusion']").click();
check(await S(() => window.__sketch.sketch?.kind === "extrusion" && window.__sketch.sketch.elev === "south"), "the extrusion sketch starts in the elevation");
await eClick(5000, 600); // the wall
await page.locator(".sk-options .seg button[title='Rectangle']").click();
await eClick(2000, 1000); await eClick(4000, 2500);
await page.locator("#ckEnd").fill("300"); await page.locator("#ckEnd").dispatchEvent("change");
await ribbon("finishSketch");
d = await model();
const ex = d.components.find(c => c.kind === "extrusion" && c.plane && !c.isVoid);
check(!!ex && ex.boundary.length === 4 && ex.start === 0 && ex.end === 300, "Finish makes an extrusion on the wall face, 0 to 300 out");
const bb = await S(async id => { const THREE = await import("three"); const v = window.__sketch.view3d; v.rebuild(); const b = new THREE.Box3(); v.root.traverse(o => { if (o.isMesh && o.userData.id === id) b.expandByObject(o); }); return [b.min.x, b.max.x, b.min.y, b.max.y, -b.max.z, -b.min.z].map(v => Math.round(v * 1000)); }, ex?.id);
check(near(bb[0], 2000) && near(bb[1], 4000) && near(bb[2], 1000) && near(bb[3], 2500) && near(bb[4], -427.5, 1) && near(bb[5], -127.5, 1), `in 3D it stands on the face: x ${bb[0]}..${bb[1]}, z ${bb[2]}..${bb[3]}, y ${bb[4]}..${bb[5]}`);

// ---- 2. a void extrusion cuts an opening through the wall
await ribbon("component"); await page.locator("[data-k='vextrusion']").click();
await eClick(8500, 600);
await page.locator(".sk-options .seg button[title='Rectangle']").click();
await eClick(6000, 900); await eClick(7000, 2100);
check(await S(() => window.__sketch.sketch.end === -300), "a void starts at 0 and goes 300 into the wall");
await ribbon("finishSketch");
const vol1 = await wallVol(south.id);
check(near(vol0 - vol1, 1000 * 1200 * 255, 5e5), `the void cuts a 1000 x 1200 opening through the 255 wall (${((vol0 - vol1) / 1e9).toFixed(3)} m³ removed)`);
await page.waitForTimeout(500); await page.locator("#planView").screenshot({ path: `${OUT}/elev-extrusion.png` });
await S(() => { const a = window.__sketch; a.selection.clear(); a.selectionChanged(); const v = a.view3d; v.fit(); v.lookFrom("sw"); });
await page.waitForTimeout(300); await page.locator("#view3d canvas").screenshot({ path: `${OUT}/elev-extrusion-3d.png` });

// ---- 3. Pick Lines in 3D for a sweep on the level: the wall's top outer edge
await page.locator("#browser [data-level]").first().click();
await ribbon("component"); await page.locator("[data-k='sweep']").click();
check(await S(() => window.__sketch.sketch?.kind === "sweep" && !window.__sketch.sketch.elev), "away from an elevation, Sweep is sketched on the level");
await page.locator(".sk-options .seg button[title='Pick Lines']").click();
await S(() => { const v = window.__sketch.view3d; v.fit(); v.lookFrom("sw"); }); await page.waitForTimeout(300);
const hp = await P3(5000, -127.5, 3000); await page.mouse.move(hp.x, hp.y, { steps: 3 }); await page.waitForTimeout(150);
check(await S(() => !!window.__sketch.view3d.edgeHi), "in Pick Lines, the 3D view highlights the edge under the mouse");
await click3(5000, -127.5, 3000);
d = await model();
const pl = d.lines.filter(l => l.kind === "sketch");
check(pl.length === 1 && near(pl[0].a.y, -127.5, 1) && near(Math.abs(pl[0].b.x - pl[0].a.x), 10255, 2) && await S(() => window.__sketch.sketch.height === 3000), `clicking the wall's top edge in 3D adds it as path, at 3000 above the level (${pl.length} line)`);
await ribbon("finishSketch");
d = await model();
check(d.components.some(c => c.kind === "sweep" && !c.plane && c.height === 3000), "Finish makes the sweep along the wall top");

// ---- 4. Pick Lines in 3D in an elevation sketch: a vertical wall corner on the south face
await tab("View"); await ribbon("elev-south"); await page.waitForTimeout(300);
await tab("Architecture"); await ribbon("component"); await page.locator("[data-k='sweep']").click();
await eClick(5000, 600);
await page.locator(".sk-options .seg button[title='Pick Lines']").click();
await S(() => { const v = window.__sketch.view3d; v.fit(); v.lookFrom("sw"); }); await page.waitForTimeout(300);
await click3(-127.5, -127.5, 1500);
d = await model();
const vl = d.lines.filter(l => l.kind === "sketch" && l.elev);
check(vl.length === 1 && near(vl[0].a.x, -127.5, 1) && near(vl[0].b.x, -127.5, 1) && near(Math.abs(vl[0].b.y - vl[0].a.y), 3000, 2), "in an elevation sketch, a corner edge clicked in 3D is laid onto the wall face (upright, 3000 long)");
await ribbon("cancelSketch");

// ---- 5. the elevation extrusion moves like anything else (drag in plan)
await page.locator("#browser [data-level]").first().click();
await S(() => { const p = window.__sketch.plan; p.s = 0.1; p.cx = 3000; p.cy = -500; p.invalidate(); });
const o0 = (await model()).components.find(c => c.id === ex.id).plane.o;
const a = await toScreen(3000, -400), b = await toScreen(3000, -1400);
await page.mouse.move(a.x, a.y, { steps: 2 }); await page.waitForTimeout(60); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 20 }); await page.mouse.up(); await page.waitForTimeout(100);
const o1 = (await model()).components.find(c => c.id === ex.id).plane.o;
check(near(o1.y - o0.y, -1000, 30) && near(o1.x, o0.x, 30), `dragging it in plan moves it 1 m (${Math.round(o1.y - o0.y)} mm), not further`);
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
console.log(fails.length ? `\nELEVATION EXTRUSION BROWSER TEST FAILED (${fails.length})` : "\nELEVATION EXTRUSION BROWSER TEST PASSED");
process.exit(fails.length ? 1 : 0);
