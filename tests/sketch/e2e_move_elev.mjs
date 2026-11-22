// Browser test: Move, Copy and Mirror work on every kind of element (doors, windows, extrusions, sweeps,
// floors, roofs, text, dimensions), and a sweep is sketched on a wall face in an elevation (Line, Pick Lines).
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
const view = (cx = 9000, cy = 3000, s = 0.025) => S(([cx, cy, s]) => { const p = window.__sketch.plan; p.s = s; p.cx = cx; p.cy = cy; p.invalidate(); }, [cx, cy, s]);
const select = ids => S(ids => { const a = window.__sketch; a.setTool("select"); a.selection.clear(); ids.forEach(id => a.selection.add(id)); a.selectionChanged(); }, [].concat(ids));
const ribbon = id => page.locator(`.sk-tool[data-id='${id}']`).click();
const tab = name => page.locator("#ribbonTabs button", { hasText: name }).first().click();
const moveSel = async (ids, from, to, cmd = "MV") => { await select(ids); await focus(); await keys(cmd); await click(...from); await click(...to); await page.waitForTimeout(80); };

await view(); await focus();
// a 10 x 8 m house with a door (south) and a window (north)
await keys("WA"); await page.locator(".sk-options .seg button[title='Rectangle']").click(); await focus();
await click(0, 0); await click(10000, 8000); await esc2();
await keys("DR"); await click(2000, 60); await esc2();
await keys("WN"); await click(5000, 7950); await esc2();
// and, made directly, one of each other kind: extrusion, sweep on the level, floor, roof, text and dimension
await S(async () => {
  const a = window.__sketch, C = await import("./assets/sketch/components.js"), R = await import("./assets/sketch/roofs.js"), A = await import("./assets/sketch/annotate.js");
  const rect = (x0, y0, x1, y1) => { const q = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]; return q.map((p, i) => ({ shape: "line", a: p, b: q[(i + 1) % 4] })); };
  a.commit("setup", doc => {
    doc.components.push(C.makeExtrusion(doc, { levelId: "lv-1", start: 0, end: 1000, boundary: rect(12000, 0, 13000, 1000) }));
    doc.components.push(C.makeSweep(doc, { levelId: "lv-1", height: 0, path: [{ shape: "line", a: { x: 12000, y: 3000 }, b: { x: 15000, y: 3000 } }], profileId: "pf-plinth" }));
    doc.floors.push({ id: "fl-test", levelId: "lv-1", typeId: doc.floorTypes[0].id, heightOffset: 0, boundary: rect(12000, 5000, 15000, 7000) });
    doc.roofs.push(R.makeRoof(doc, { baseLevelId: "lv-1", baseOffset: 3000, boundary: rect(16000, 0, 20000, 3000) }));
    doc.texts.push(A.makeText("lv-1", { x: 17000, y: 6000 }, "Store"));
    doc.dimensions.push(A.makeDimension("lv-1", { x: 16000, y: 5000 }, { x: 20000, y: 5000 }, 400));
  });
});
let d = await model();
const ext0 = d.components.find(c => c.kind === "extrusion"), sw0 = d.components.find(c => c.kind === "sweep"), rf0 = d.roofs[0], tx0 = d.texts[0], dm0 = d.dimensions[0], door0 = d.openings.find(o => o.kind === "door");

// ---- Move each kind by (0, -2000) (or along the wall for the door)
for (const [label, id] of [["extrusion", ext0.id], ["sweep", sw0.id], ["floor", "fl-test"], ["roof", rf0.id], ["text", tx0.id], ["dimension", dm0.id]]) {
  await moveSel(id, [9000, 10000], [9000, 8000]);
}
d = await model();
const ext1 = d.components.find(c => c.id === ext0.id), sw1 = d.components.find(c => c.id === sw0.id);
check(near(ext1.boundary[0].a.y, -2000), "Move (MV) an extrusion");
check(near(sw1.path[0].a.y, 1000), "Move a sweep");
check(near(d.floors[0].boundary[0].a.y, 3000), "Move a floor");
check(near(d.roofs[0].boundary[0].a.y, -2000), "Move a roof");
check(near(d.texts[0].p.y, 4000), "Move a text");
check(near(d.dimensions[0].a.y, 3000) && near(d.dimensions[0].b.y, 3000), "Move a dimension");
// door: along its wall, then onto the east wall
await moveSel(door0.id, [2000, 0], [5000, 0]);
d = await model();
let dr = d.openings.find(o => o.id === door0.id);
const doorX = await S(async id => { const OP = await import("./assets/sketch/openings.js"); const a = window.__sketch; return OP.openingFrame(a.doc, a.doc.openings.find(o => o.id === id)).mid.x; }, door0.id);
check(dr.hostWallId === door0.hostWallId && near(doorX, 5000, 1), `Move a door along its wall: now centred at x = ${Math.round(doorX)}`);
await moveSel(door0.id, [5000, 0], [10000, 3000]);
d = await model();
dr = d.openings.find(o => o.id === door0.id);
const east = d.walls.find(w => near(w.a.x, 10000) && near(w.b.x, 10000));
check(dr.hostWallId === east.id, "Move a door onto another wall: it is re-hosted in the east wall");
await moveSel(door0.id, [10000, 3000], [14000, 3000]);
check((await page.locator("#toast").innerText()).includes("must stay in a wall") && (await model()).openings.find(o => o.id === door0.id).hostWallId === east.id, "a door moved off every wall is refused in plain words and stays put");
// copy and mirror
await moveSel(ext0.id, [12000, -1000], [12000, -3000], "CO");
d = await model();
check(d.components.filter(c => c.kind === "extrusion").length === 2, "Copy (CO) an extrusion");
const wn = d.openings.find(o => o.kind === "window");
await select(wn.id); await focus(); await keys("CO"); await click(5000, 8000); await click(7500, 8000);
d = await model();
check(d.openings.filter(o => o.kind === "window").length === 2 && d.openings.filter(o => o.kind === "window").every(o => o.hostWallId === wn.hostWallId), "Copy a window along its wall");
await select(rf0.id); await focus(); await keys("DM"); await click(15500, -3000); await click(15500, 3000);
d = await model();
const rfm = d.roofs.find(r => r.id !== rf0.id), xs = (rfm?.boundary || []).map(e => e.a.x);
check(d.roofs.length === 2 && near(Math.min(...xs), 11000) && near(Math.max(...xs), 15000), "Mirror (DM, Copy ticked as in Revit) makes a mirrored roof across the drawn axis");
await page.keyboard.press("Escape");
await view(); await page.screenshot({ path: `${OUT}/move-all-plan.png` });

// ---- a sweep sketched on the south wall's face in the South elevation
await tab("View"); await ribbon("elev-south"); await page.waitForTimeout(400);
const E = async (u, z) => { const b = await page.locator("#elevView canvas.sk-elev-over").boundingBox(); const s = await S(([u, z]) => window.__sketch.elev.toScreen(u, z), [u, z]); return { x: b.x + s.x, y: b.y + s.y }; };
const eClick = async (u, z) => { const p = await E(u, z); await page.mouse.move(p.x - 3, p.y - 3); await page.mouse.move(p.x, p.y, { steps: 2 }); await page.mouse.click(p.x, p.y); await page.waitForTimeout(80); };
await S(() => { const e = window.__sketch.elev; e.s = 0.05; e.cu = 5000; e.cz = 2000; e.invalidate(); });
await page.waitForTimeout(200);
await tab("Architecture"); await ribbon("component");
check((await page.locator("#dialog").innerText()).includes("sketch on a wall face in this elevation"), "with an elevation open, Component > Sweep offers to sketch on a wall face");
await page.locator("[data-k='sweep']").click();
check(await S(() => window.__sketch.sketch?.elev === "south" && window.__sketch.tool.name === "elevSketch") && (await page.locator("#statusPrompt").innerText()).includes("Click a wall"), "the sweep sketch starts in the elevation and asks for a wall face");
await eClick(7000, 1000);
let sk = await S(() => window.__sketch.sketch.plane);
check(sk && near(sk.n.y, -1, 1e-9) && near(sk.o.y, -127.5, 0.01) && near(sk.u.x, 1, 1e-9), `work plane = the south wall's outside face (y = ${sk?.o.y})`);
await eClick(-127.5, 2400); await eClick(10127.5, 2400); await page.keyboard.press("Escape");
d = await model();
const path = d.lines.filter(l => l.kind === "sketch" && l.elev);
check(path.length === 1 && near(path[0].a.x, -127.5, 1) && near(path[0].b.x, 10127.5, 1) && near(path[0].a.y, 2400, 1), "Line: a path drawn across the wall at +2.400, snapped to the wall's corners");
// Pick Lines: the door's head is an edge in the elevation (the door is now in the east wall; use the window line instead: the wall's top edge)
await page.locator(".sk-options .seg button[title='Pick Lines']").click();
const topEdge = await E(5000, 3000); await page.mouse.move(topEdge.x, topEdge.y, { steps: 3 }); await page.waitForTimeout(80);
check(await S(() => !!window.__sketch.tool.hoverEdge), "Pick Lines highlights a model edge under the cursor (the top of the wall)");
await page.mouse.click(topEdge.x, topEdge.y); await page.waitForTimeout(80);
d = await model();
const picked = d.lines.filter(l => l.kind === "sketch" && l.elev).at(-1);
check(d.lines.filter(l => l.kind === "sketch" && l.elev).length === 2 && near(picked.a.y, 3000, 1) && near(picked.b.y, 3000, 1) && near(Math.abs(picked.b.x - picked.a.x), 10255, 2), `Pick Lines adds the wall's top edge as path (${Math.round(Math.abs(picked.b.x - picked.a.x))} mm at +3.000)`);
await page.locator("#planView").screenshot({ path: `${OUT}/elev-sweep-sketch.png` });
await page.keyboard.press("Control+z");
check((await model()).lines.filter(l => l.kind === "sketch" && l.elev).length === 1, "Undo removes the picked line");
await ribbon("finishSketch");
d = await model();
const es = d.components.find(c => c.kind === "sweep" && c.plane);
check(!!es && !d.lines.some(l => l.kind === "sketch"), "Finish makes a sweep on the wall face");
const box = await S(async id => { const C = await import("./assets/sketch/components.js"); const a = window.__sketch; const g = C.sweepGeometry(a.doc, a.doc.components.find(c => c.id === id)); const q = g.rings.flat(); const r = k => [Math.min(...q.map(p => p[k])), Math.max(...q.map(p => p[k]))]; return { x: r("x"), y: r("y"), z: r("z") }; }, es?.id);
check(near(box.x[0], -127.5, 1) && near(box.x[1], 10127.5, 1) && near(box.y[0], -127.5 - 150, 1) && near(box.y[1], -127.5, 1) && near(box.z[0], 2400, 1) && near(box.z[1], 2600, 1), `the cornice runs the wall's length, stands 150 out from the face and sits on the line (z ${box.z.map(Math.round).join("..")})`);
await page.locator("#planView").screenshot({ path: `${OUT}/elev-sweep-done.png` });
await S(() => { const v = window.__sketch.view3d; v.fit(); v.lookFrom("sw"); });
await page.waitForTimeout(300); await page.locator("#view3d canvas").screenshot({ path: `${OUT}/elev-sweep-3d.png` });
// in plan it shows as a strip and moves like anything else
await page.locator("#browser [data-level]", { hasText: "Level 1" }).click(); await view(5000, 0, 0.05);
await moveSel(es.id, [5000, -3000], [5000, -4000]);
d = await model();
check(near(d.components.find(c => c.id === es.id).plane.o.y, -1127.5, 0.5), "the elevation sweep shows in plan and Move moves its plane");
await page.keyboard.press("Control+z");
// editing reopens the elevation with the path
await S(id => { const a = window.__sketch; a.selection.clear(); a.selection.add(id); a.selectionChanged(); }, es.id);
await page.locator("#cEdit").click();
check(await S(() => window.__sketch.elevSide === "south" && window.__sketch.doc.lines.filter(l => l.kind === "sketch" && l.elev).length === 1), "Edit opens the South elevation with the path to change");
await ribbon("finishSketch");
const ui = await page.locator("body").innerText();
check(!/revit|autodesk/i.test(ui), "no Revit or Autodesk names in the interface");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
console.log(fails.length ? `\nMOVE AND ELEVATION SWEEP BROWSER TEST FAILED (${fails.length})` : "\nMOVE AND ELEVATION SWEEP BROWSER TEST PASSED");
process.exit(fails.length ? 1 : 0);
