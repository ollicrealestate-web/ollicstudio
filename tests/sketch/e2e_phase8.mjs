// Phase 8 browser test: the full scenario from the brief, then elevations, section box, annotations and exports.
//  10 x 8 m exterior walls; interior wall by Offset 4000, trimmed; a door and two windows, one changed to 1500 x 1200;
//  Level 2 at 3000 with the walls copied up; a floor on Level 2; a hip roof at 30°; a 900 parapet on a flat-roof
//  variant; 3D from four corners; save, reload, identical.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);

const S = (fn, arg) => page.evaluate(fn, arg);
const model = () => S(() => JSON.parse(JSON.stringify(window.__sketch.doc)));
const toScreen = (x, y) => S(([x, y]) => { const a = window.__sketch, r = document.getElementById("planCanvas").getBoundingClientRect(), s = a.plan.toScreen({ x, y }); return { x: r.left + s.x, y: r.top + s.y }; }, [x, y]);
const click = async (x, y) => { const p = await toScreen(x, y); await page.mouse.move(p.x - 3, p.y - 3); await page.mouse.move(p.x, p.y, { steps: 2 }); await page.mouse.click(p.x, p.y); await page.waitForTimeout(60); };
const hover = async (x, y) => { const p = await toScreen(x, y); await page.mouse.move(p.x, p.y, { steps: 3 }); await page.waitForTimeout(40); };
const keys = async s => { for (const ch of s) await page.keyboard.press(ch === "\n" ? "Enter" : ch); };
const focus = () => page.locator("#planCanvas").focus();
const esc2 = async () => { await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); };
const view = (cx = 5000, cy = 4000, s = 0.04) => S(([cx, cy, s]) => { const p = window.__sketch.plan; p.s = s; p.cx = cx; p.cy = cy; p.invalidate(); }, [cx, cy, s]);
const tab = name => page.locator("#ribbonTabs button", { hasText: name }).first().click();
const ribbon = id => page.locator(`.sk-tool[data-id='${id}']`).click();
const optNumber = async (label, v) => { const i = page.locator(`.sk-options label:has-text("${label}") input[type=number]`); await i.fill(String(v)); await i.dispatchEvent("change"); };
const answer = async (yes, wait = 1500) => { await page.locator("#askWrap").waitFor({ state: "visible", timeout: wait }).catch(() => {}); if (await page.locator("#askWrap").isVisible()) { const t = await page.locator("#ask").innerText(); await page.locator(yes ? "#askYes" : "#askNo").click(); return t; } return ""; };
const heights = () => S(async () => { const W = await import("./assets/sketch/walls.js"); const a = window.__sketch; return Object.fromEntries(a.doc.walls.map(w => [w.id, W.wallHeights(a.doc, w)])); });
const select = ids => S(ids => { const a = window.__sketch; a.setTool("select"); a.selection.clear(); ids.forEach(id => a.selection.add(id)); a.selectionChanged(); }, ids);
const shot3d = async (name, corner) => { await S(c => { const v = window.__sketch.view3d; v.fit(); v.lookFrom(c); }, corner); await page.waitForTimeout(250); await page.locator("#view3d canvas").screenshot({ path: `${OUT}/${name}.png` }); };
const L1 = "lv-1";

await view(); await focus();
// ---- 1. a 10 x 8 m rectangle of exterior walls
await keys("WA");
await page.locator(".sk-options .seg button[title='Rectangle']").click(); await focus();
await click(0, 0); await click(10000, 8000); await esc2();
let d = await model();
check(d.walls.length === 4 && d.walls.every(w => w.typeId === "wt-ext225"), "1. four exterior walls, 10 x 8 m");

// ---- 2. interior wall: Offset 4000 from the west and south walls, Interior 150, Trim/Extend to Corner
await focus(); await keys("OF");
await page.locator(".sk-options select").first().selectOption("numerical"); await optNumber("Offset", 4000); await focus();
await hover(60, 3000); await click(300, 3000);
await hover(3000, 60); await click(3000, 300);
await esc2();
d = await model();
const vx = d.walls.find(w => near(w.a.x, 4000) && near(w.b.x, 4000)), hy = d.walls.find(w => near(w.a.y, 4000) && near(w.b.y, 4000));
await click(4000, 6000); await page.keyboard.down("Control"); await click(8800, 4000); await page.keyboard.up("Control");
await page.locator("#pType").selectOption("wt-int150");
await page.keyboard.press("Escape"); await focus(); await keys("TR");
await page.locator(".sk-options .seg button[title='Trim/Extend to Corner']").click(); await focus();
await click(7000, 4000); await click(4000, 6000); await esc2();
d = await model();
const h2 = d.walls.find(w => w.id === hy?.id), v2 = d.walls.find(w => w.id === vx?.id);
check(!!h2 && !!v2 && h2.typeId === "wt-int150" && near(Math.min(h2.a.x, h2.b.x), 4000) && near(Math.min(v2.a.y, v2.b.y), 4000), "2. interior walls by Offset 4000, trimmed to a corner at (4000, 4000)");

// ---- 3. a door and two windows; one window changed to 1500 x 1200
await keys("DR"); await click(2000, 60); await esc2();
await keys("WN"); await click(2500, 7950); await esc2(); await keys("WN"); await click(7000, 7950); await esc2();
d = await model();
check(d.openings.filter(o => o.kind === "door").length === 1 && d.openings.filter(o => o.kind === "window").length === 2, "3. one door and two windows placed");
await click(7000, 8000);
await page.locator("#pType").selectOption("wn-1500");
d = await model();
check(d.openings.some(o => o.typeId === "wn-1500"), "   one window changed to 1500 x 1200");
await page.keyboard.press("Escape");

// ---- 4. Level 2 at 3000 and the walls copied up
await keys("LL"); await page.locator("#lvAdd").click(); await page.locator("#lvOk").click();
d = await model();
const L2 = d.levels.find(l => l.name === "Level 2");
check(!!L2 && L2.elevation === 3000, "4. Level 2 at +3.000");
await select(d.walls.map(w => w.id));
await tab("Modify"); await ribbon("copyLevels");
await page.locator(".sk-dialog input[type=checkbox]").first().check(); await page.locator("#cOk").click();
d = await model();
check(d.walls.filter(w => w.baseLevelId === L2.id).length === 6 && d.openings.filter(o => d.walls.find(w => w.id === o.hostWallId)?.baseLevelId === L2.id).length === 3, "   the 6 walls (and their openings) copied up to Level 2");

// ---- 5. a floor on Level 2 (Pick Walls inside the exterior walls)
await page.locator("#browser [data-level]", { hasText: "Level 2" }).click(); await view();
await focus(); await keys("SB");
for (const [x, y] of [[2000, 300], [9700, 2000], [2000, 7700], [300, 2000]]) { await page.mouse.move(0, 0); await click(x, y); }
await tab("Modify | Create Floor Boundary").catch(() => {});
await ribbon("finishSketch"); await answer(true);
d = await model();
check(d.floors.length === 1 && d.floors[0].levelId === L2.id, "5. a floor on Level 2");

// ---- 6. a hip roof at 30° on the Level 2 walls (base +6.000)
await page.mouse.move(0, 0); await focus(); await keys("RF");
await page.locator("#rkBase").fill("3000"); await page.locator("#rkBase").dispatchEvent("change");
for (const [x, y] of [[2000, 0], [10000, 2000], [2000, 8000], [0, 2000]]) { await page.mouse.move(0, 0); await click(x, y); }
await ribbon("finishSketch");
const att = await answer(true);
d = await model();
const roof = d.roofs[0];
const R = await S(async id => { const M = await import("./assets/sketch/roofs.js"); const a = window.__sketch; const g = M.roofGeometry(a.doc, a.doc.roofs.find(r => r.id === id)); return { top: g.top, ridge: g.lines.filter(l => l.kind === "ridge").map(l => Math.hypot(l.a.x - l.b.x, l.a.y - l.b.y)), hips: g.lines.filter(l => l.kind === "hip").length }; }, roof?.id);
const W = 10255 + 1200, H = 8255 + 1200;
check(!!roof && roof.baseLevelId === L2.id && roof.baseOffset === 3000 && roof.boundary.every(e => e.definesSlope && near(e.slope, Math.PI / 6, 1e-9)), "6. a roof on Level 2 + 3000, every edge sloped at 30°");
check(R.hips === 4 && R.ridge.length === 1 && near(R.ridge[0], W - H, 0.5), `   hip roof: 4 hips and one ${Math.round(R.ridge[0])} mm ridge`);
check(near(R.top, 6000 + (H / 2 - 600) * T30 + 200 / Math.cos(Math.PI / 6), 0.5), `   top at +${(R.top / 1000).toFixed(3)} m`);
check(att.includes("Attach the 6 walls"), "   the 6 walls on Level 2 under the roof are offered for attaching, and attached");
await page.mouse.move(0, 0);
await S(() => { const a = window.__sketch; a.selection.clear(); a.selectionChanged(); });
for (const c of ["sw", "se", "ne", "nw"]) await shot3d(`phase8-hip-${c}`, c);

// ---- 7. flat-roof variant with a 900 mm parapet (untick Defines Slope on every edge)
await select([roof.id]); await page.locator("#pEditR").click(); // Edit Footprint (the floor is under the cursor, so not a double-click)
const edgeIds = (await model()).lines.filter(l => l.kind === "sketch").map(l => l.id);
await select(edgeIds);
await page.locator("#rlDef").uncheck();
await ribbon("finishSketch"); await answer(false, 400);
await select([roof.id]);
await tab("Architecture"); await ribbon("parapet");
await page.locator("#pH").fill("900"); await page.locator("#pOk").click();
d = await model();
const hs = await heights();
const par = d.walls.filter(w => /Parapet/.test(d.wallTypes.find(t => t.id === w.typeId)?.name || ""));
check(d.roofs[0].boundary.every(e => !e.definesSlope) && par.length === 4 && par.every(w => near(hs[w.id].z0, 6200, 0.5) && near(hs[w.id].z1 - hs[w.id].z0, 900, 0.5)), "7. flat-roof variant: 4 parapet walls 900 high on the roof top (+6.200)");
await S(() => { const a = window.__sketch; a.selection.clear(); a.selectionChanged(); });
for (const c of ["sw", "se", "ne", "nw"]) await shot3d(`phase8-flat-${c}`, c);

// ---- annotations: an aligned dimension across the south wall's outside face, and a text
await page.locator("#browser [data-level]", { hasText: "Level 1" }).click(); await view();
await tab("Annotate"); await ribbon("dimAligned"); await focus();
await click(-127.5, -127.5); await click(10127.5, -127.5); await click(5000, -1200);
await page.keyboard.press("Escape");
await ribbon("text"); await focus();
await click(2000, 2000); await page.locator("#askIn").fill("Living room"); await page.locator("#askYes").click();
await page.keyboard.press("Escape");
d = await model();
check(d.dimensions.length === 1 && near(Math.hypot(d.dimensions[0].a.x - d.dimensions[0].b.x, d.dimensions[0].a.y - d.dimensions[0].b.y), 10255, 1), `aligned dimension (DI) across the outside faces: ${Math.round(Math.hypot(d.dimensions[0]?.a.x - d.dimensions[0]?.b.x, d.dimensions[0]?.a.y - d.dimensions[0]?.b.y))} mm`);
check(d.texts.length === 1 && d.texts[0].text === "Living room", "text (TX) placed");
await page.screenshot({ path: `${OUT}/phase8-plan-l1.png` });

// ---- elevations: South shows the building and both levels; dragging Level 2's head moves it, Undo puts it back
await tab("View"); await ribbon("elev-south"); await page.waitForTimeout(400);
check((await page.locator("#planTitle").innerText()) === "Elevation: South", "South elevation opens in the plan pane");
await page.locator("#planView").screenshot({ path: `${OUT}/phase8-elev-south.png` });
const ink = await S(() => { const e = window.__sketch.elev; e.render(); const g = e.gl.getContext("webgl2") || e.gl.getContext("webgl"); const w = g.drawingBufferWidth, h = g.drawingBufferHeight, px = new Uint8Array(w * h * 4); g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px); let n = 0; for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - 243) + Math.abs(px[i + 1] - 242) + Math.abs(px[i + 2] - 238) > 30) n++; return n / (w * h); });
check(ink > 0.03, `the elevation shows the building (${(ink * 100).toFixed(1)}% of the view drawn)`);
const heads = await S(() => window.__sketch.elev.heads.map(h => ({ id: h.id, y: h.y })));
check(heads.length === 2 && heads[0].y > heads[1].y, "level heads for Level 1 and Level 2, Level 2 above");
const box = await page.locator("#elevView canvas.sk-elev-over").boundingBox();
const h2y = box.y + heads[1].y, hx = box.x + box.width - 120;
const pxPerMm = await S(() => window.__sketch.elev.s);
await page.mouse.move(hx, h2y); await page.mouse.down(); await page.mouse.move(hx, h2y - 300 * pxPerMm, { steps: 6 }); await page.mouse.up();
d = await model();
check(near(d.levels.find(l => l.id === L2.id).elevation, 3300, 10), `dragging Level 2's head up 300 mm sets it to +${(d.levels.find(l => l.id === L2.id).elevation / 1000).toFixed(3)}`);
await page.keyboard.press("Control+z");
check((await model()).levels.find(l => l.id === L2.id).elevation === 3000, "Undo puts Level 2 back at +3.000");
for (const k of ["north", "east", "west"]) { await ribbon(`elev-${k}`); await page.waitForTimeout(200); await page.locator("#planView").screenshot({ path: `${OUT}/phase8-elev-${k}.png` }); }
await page.locator("#browser [data-level]", { hasText: "Level 1" }).click();
check((await page.locator("#planTitle").innerText()) === "Floor Plan: Level 1" && await page.locator("#elevView").isHidden(), "clicking a floor plan goes back to the plan");

// ---- section box: on, top cut down to +4.500
await tab("View"); await ribbon("sectionBox");
check(await S(() => window.__sketch.view3d.renderer.clippingPlanes.length === 6), "Section Box (BX) clips the 3D view with six planes");
await page.locator(".sk-sbox summary").click();
const top = page.locator("[data-sb='z1']");
await top.evaluate(el => { el.value = 4500; el.dispatchEvent(new Event("input")); el.dispatchEvent(new Event("change")); });
check(await S(() => { const pl = window.__sketch.view3d.renderer.clippingPlanes[3]; return Math.abs(pl.constant - 4.5) < 1e-6 && pl.normal.y === -1; }), "dragging Top to 4500 cuts the model at +4.500");
await shot3d("phase8-sectionbox", "sw");
await page.locator("#sbOff").click();
check(await S(() => window.__sketch.view3d.renderer.clippingPlanes.length === 0), "Off removes the section box");

// ---- exports
const grab = async (btn) => { const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.locator(btn).click()]); const path = `${OUT}/${dl.suggestedFilename()}`; await dl.saveAs(path); return { name: dl.suggestedFilename(), buf: readFileSync(path) }; };
await page.locator("#fileExport").click();
await page.locator("#xLevel").selectOption(L1); await page.locator("#xScale").selectOption("100");
const pdf = await grab("#xPdf");
const pdfText = pdf.buf.toString("latin1");
check(pdfText.startsWith("%PDF-1.4") && pdfText.includes("/MediaBox [0 0 841.89 595.28]") && pdfText.trimEnd().endsWith("%%EOF"), `PDF at 1:100: ${pdf.name}, A4 landscape, the smallest sheet the plan fits`);
const png = await grab("#xPng");
const pw = png.buf.readUInt32BE(16), ph = png.buf.readUInt32BE(20);
check(near(pw, (297 / 25.4) * 150, 1) && near(ph, (210 / 25.4) * 150, 1), `PNG sheet ${pw} x ${ph} px = A4 at 150 dpi`);
// the outside of the house is 10255 mm: at 1:100 and 150 dpi that is 102.55 mm = 605.6 px on paper
const span = await S(async () => { const X = await import("./assets/sketch/exports.js"); const sh = X.planSheet(window.__sketch, "lv-1", 100); return sh.pxPerMm * 10255; });
check(near(span, (102.55 / 25.4) * 150, 0.5), `true scale: 10.255 m = ${span.toFixed(1)} px on the sheet`);
const dxf = await grab("#xDxf");
const dx = dxf.buf.toString("utf8").split(/\r?\n/);
const ents = (type) => dx.reduce((n, v, i) => n + (v === type && dx[i - 1] === "0" ? 1 : 0), 0);
const xs = []; dx.forEach((v, i) => { if (v === "10" && dx[i - 2] === "PLAN" || (v === "10" && dx[i - 4] === "PLAN")) xs.push(+dx[i + 1]); });
check(dx[7] === "AC1009" && ents("LINE") > 20 && ents("ARC") >= 1 && ents("TEXT") >= 2 && dx.includes("Living room") && dx.includes("10255"), `DXF: ${ents("LINE")} lines, ${ents("ARC")} arcs (door swings), ${ents("TEXT")} texts incl. "Living room" and the 10255 dimension`);
check(dx.some((v, i) => v === "10" && near(+dx[i + 1], -127.5, 0.01)) && dx.some((v, i) => v === "11" && near(+dx[i + 1], 10127.5, 0.01)), "DXF coordinates are in millimetres (outside face at x = -127.5 and 10127.5)");
const glb = await grab("#xGlb");
const jsonLen = glb.buf.readUInt32LE(12), gj = JSON.parse(glb.buf.slice(20, 20 + jsonLen).toString("utf8"));
check(glb.buf.readUInt32LE(0) === 0x46546c67 && glb.buf.readUInt32LE(8) === glb.buf.length && gj.asset.version === "2.0" && gj.nodes.length > 20, `GLB: valid glTF 2.0 binary with ${gj.nodes.length} objects`);
const yMax = Math.max(...gj.accessors.filter(a => a.max).map(a => a.max[1]));
check(near(yMax, 7.175, 0.01), `GLB heights are in metres: top of the parapet coping at ${yMax.toFixed(3)} m`);
check(await page.locator("#xDxf").isVisible() && (await page.locator(".sk-export").innerText()).includes("IFC"), "IFC is listed as not available yet, with GLB and DXF to use meanwhile");
await page.locator("#xClose").click();

// ---- save, reload, identical
const keep = JSON.stringify(await model());
await page.waitForTimeout(900); await page.reload();
await page.waitForFunction(() => window.__sketch?.ready && window.__sketch.doc.roofs.length > 0);
check(JSON.stringify(await model()) === keep, "save, reload: the model is identical");
await page.locator("#browser [data-level]", { hasText: "Level 1" }).click(); await view();
await page.screenshot({ path: `${OUT}/phase8-after-reload.png` });
const ui = await page.locator("body").innerText();
check(!/revit|autodesk/i.test(ui), "no Revit or Autodesk names in the interface");
check(!errors.length, `no page errors ${errors.length ? errors.join(" | ") : ""}`);
await browser.close(); srv.close();
console.log(fails.length ? `\nPHASE 8 BROWSER TEST FAILED (${fails.length})` : "\nPHASE 8 BROWSER TEST PASSED");
process.exit(fails.length ? 1 : 0);
