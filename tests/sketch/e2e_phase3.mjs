// Phase 3 browser test: Modify tools on walls and lines, in real Chromium. Run: node tests/sketch/e2e_phase3.mjs [outDir]
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
const hover = async (x, y) => { const p = await toScreen(x, y); await page.mouse.move(p.x, p.y, { steps: 3 }); await page.waitForTimeout(40); };
const keys = async s => { for (const ch of s) await page.keyboard.press(ch === "\n" ? "Enter" : ch); };
const focus = () => page.locator("#planCanvas").focus();
const view = (cx, cy, s = 0.035) => S(([cx, cy, s]) => { const p = window.__sketch.plan; p.s = s; p.cx = cx; p.cy = cy; p.invalidate(); }, [cx, cy, s]);
const esc2 = async () => { await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); };
const optNumber = async (label, v) => { const i = page.locator(`.sk-options label:has-text("${label}") input[type=number]`); await i.fill(String(v)); await i.dispatchEvent("change"); };
const optSelect = async (idx, v) => { await page.locator(".sk-options select").nth(idx).selectOption(v); };
const walls = async () => (await model()).walls;
const wallAt = (ws, f) => ws.find(f);

await view(5000, 4000); await focus();
// house: 10 x 8 m exterior walls
await keys("WA");
await page.locator(".sk-options .seg button[title='Rectangle']").click(); await focus();
await click(0, 0); await click(10000, 8000); await esc2();

// 1. Offset (numerical 4000, copy) the west wall inwards, then the south wall: two interior walls
await focus(); await keys("OF");
check(await S(() => window.__sketch.tool.name) === "offset", "OF starts Offset");
await optSelect(0, "numerical"); await optNumber("Offset", 4000);
await focus();
await hover(60, 3000); await click(300, 3000);     // hover the west wall, click on its inner side
await hover(3000, 60); await click(3000, 300);     // the south wall
await esc2();
let ws = await walls();
const vx = wallAt(ws, w => near(w.a.x, 4000) && near(w.b.x, 4000));
const hy = wallAt(ws, w => near(w.a.y, 4000) && near(w.b.y, 4000));
check(!!vx && near(Math.min(vx.a.y, vx.b.y), 0) && near(Math.max(vx.a.y, vx.b.y), 8000), "Offset 4000 from the west wall: a copy on x = 4000");
check(!!hy && near(Math.min(hy.a.x, hy.b.x), 0) && near(Math.max(hy.a.x, hy.b.x), 10000), "Offset 4000 from the south wall: a copy on y = 4000");
// make them interior partitions
await click(4000, 6000); await page.keyboard.down("Control"); await click(8800, 4000); await page.keyboard.up("Control");
await page.locator("#pType").selectOption("wt-int150");
ws = await walls();
check(ws.filter(w => w.typeId === "wt-int150").length === 2, "both offset walls changed to Interior 150");
await page.screenshot({ path: `${OUT}/phase3-offset.png` });

// 2. Trim/Extend to Corner: keep the east part of y = 4000 and the north part of x = 4000
await page.keyboard.press("Escape"); await focus(); await keys("TR");
await optSelect(0, "corner").catch(() => {});
await page.locator(".sk-options .seg button[title='Trim/Extend to Corner']").click(); await focus();
await click(7000, 4000); await click(4000, 6000); await esc2();
ws = await walls();
const h2 = ws.find(w => w.id === hy.id), v2 = ws.find(w => w.id === vx.id);
check(near(Math.min(h2.a.x, h2.b.x), 4000) && near(Math.max(h2.a.x, h2.b.x), 10000), `Trim to Corner keeps the east part: y = 4000 now runs 4000 to 10000 (${h2.a.x}..${h2.b.x})`);
check(near(Math.min(v2.a.y, v2.b.y), 4000) && near(Math.max(v2.a.y, v2.b.y), 8000), `and the north part: x = 4000 now runs 4000 to 8000 (${v2.a.y}..${v2.b.y})`);
await page.screenshot({ path: `${OUT}/phase3-trim.png` });

// 3. Lines for the rest: Chamfer 300/300, Fillet 500, Split with gap, Delete inner segment
await view(18000, 4000);
await focus(); await keys("LI");
await page.locator(".sk-options .seg button[title='Line']").click(); await focus();
await click(14000, 0); await click(14000, 3000); await esc2();    // L1 vertical
await keys("LI"); await click(14000, 0); await click(17000, 0); await esc2(); // L2 horizontal
await keys("CH"); await focus();
await click(14000, 2000); await click(16000, 0); await esc2();
let d = await model();
const lines = d.lines;
check(lines.some(l => near(l.a.x, 14000) && near(Math.min(l.a.y, l.b.y), 300)) && lines.some(l => near(Math.min(l.a.x, l.b.x), 14300) && near(l.a.y, 0)), "Chamfer 300/300 cuts both lines 300 from the corner");
check(lines.some(l => near(Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y), Math.hypot(300, 300), 0.01)), "and adds the 424.26 mm cut");
await keys("LI"); await click(19000, 0); await click(22000, 0); await esc2();
await keys("LI"); await click(19000, 0); await click(19000, 3000); await esc2();
await keys("FL"); await focus();
await click(21000, 0); await click(19000, 2000); await esc2();
d = await model();
const arc = d.lines.find(l => l.shape === "arc");
check(!!arc && near(arc.r, 500, 0.01) && near(arc.c.x, 19500, 0.01) && near(arc.c.y, 500, 0.01), "Fillet 500 adds a 500 mm arc centred 500 from both lines");
await keys("LI"); await click(14000, 6000); await click(20000, 6000); await esc2();
await keys("SL"); await optSelect(0, "gap"); await optNumber("Joint Gap", 20); await focus();
await click(17000, 6000); await esc2();
d = await model();
const st = d.lines.filter(l => l.shape === "line");
check(st.some(l => near(l.b.x, 16990, 0.01) && near(l.b.y, 6000)) && st.some(l => near(l.a.x, 17010, 0.01) && near(l.a.y, 6000)), "Split with Gap 20 leaves a 20 mm gap");
await keys("LI"); await click(14000, 7000); await click(20000, 7000); await esc2();
await keys("SL"); await optSelect(0, "split");
await page.locator(".sk-options label:has-text('Delete Inner Segment') input").check(); await focus();
await click(15000, 7000); await click(19000, 7000); await esc2();
d = await model();
const at7 = d.lines.filter(l => l.shape === "line" && near(l.a.y, 7000) && near(l.b.y, 7000)).map(l => [l.a.x, l.b.x].sort((a, b) => a - b));
check(at7.length === 2 && at7.some(r => near(r[0], 14000) && near(r[1], 15000)) && at7.some(r => near(r[0], 19000) && near(r[1], 20000)), `Delete Inner Segment removes 15000 to 19000 (${JSON.stringify(at7)})`);

// Tab picks a chain of joined lines too: offset a 3-line chain by 500 in one click
await keys("LI"); await page.locator(".sk-options label:has-text('Chain') input").check(); await focus();
await click(14000, 9000); await click(16000, 9000); await click(16000, 10500); await click(18000, 10500); await esc2();
await keys("OF"); await optSelect(0, "numerical"); await optNumber("Offset", 500); await focus();
await hover(15000, 9030);
for (let i = 0; i < 4; i++) { const h = await S(() => window.__sketch.hoverId); if (String(h).startsWith("chain:")) break; await page.keyboard.press("Tab"); }
await page.mouse.down(); await page.mouse.up(); await esc2();
d = await model();
// the cursor was just north of the chain, so the copy goes north: y 9500, x 15500, y 11000, corners joined
const c1 = d.lines.find(l => l.shape === "line" && near(l.a.y, 9500) && near(l.b.y, 9500));
const c2 = d.lines.find(l => l.shape === "line" && near(l.a.x, 15500) && near(l.b.x, 15500));
const c3 = d.lines.find(l => l.shape === "line" && near(l.a.y, 11000) && near(l.b.y, 11000));
check(!!(c1 && c2 && c3) && near(c1.b.x, 15500) && near(c2.b.y, 11000) && near(c3.a.x, 15500), "Tab + Offset copies a whole chain of lines, corners joined (y 9500, x 15500, y 11000)");

// 4. Move, Copy (multiple), Rotate, Mirror, Array, Scale on a test line
await keys("LI"); await click(22000, 6000); await click(23000, 6000); await esc2();
const id0 = (await model()).lines.at(-1).id;
const sel = async id => S(id => { const a = window.__sketch; a.selection.clear(); a.selection.add(id); a.selectionChanged(); }, id);
await sel(id0); await focus(); await keys("MV");
await click(22000, 6000); await hover(22000, 7000); await keys("1000\n");
d = await model();
check(near(d.lines.find(l => l.id === id0).a.y, 7000), "Move: typed 1000 north");
await sel(id0); await focus(); await keys("CO");
await page.locator(".sk-options label:has-text('Multiple') input").check(); await focus();
await click(22000, 7000); await click(22000, 8000); await click(22000, 9000); await esc2();
d = await model();
check(d.lines.filter(l => l.shape === "line" && near(l.a.x, 22000) && near(l.b.x, 23000) && [8000, 9000].some(y => near(l.a.y, y))).length === 2, "Copy with Multiple: two copies");
await sel(id0); await focus(); await keys("RO");
await page.keyboard.press("9"); await page.keyboard.press("0"); await page.keyboard.press("Enter");
d = await model();
const r = d.lines.find(l => l.id === id0);
check(near(r.a.x, r.b.x, 0.01) && near(Math.abs(r.b.y - r.a.y), 1000, 0.01), "Rotate: typed 90 turns the line upright");
await sel(id0); await focus(); await keys("DM"); await focus();
await click(21000, 0); await click(21000, 10000); await esc2();
d = await model();
check(d.lines.some(l => l.shape === "line" && near(l.a.x, 2 * 21000 - r.a.x, 0.01)), "Mirror - Draw Axis makes a mirrored copy");
await sel(id0); await focus(); await keys("AR");
await optNumber("Number", 4); await focus();
await click(22500, 6500); await hover(23500, 6500); await keys("400\n");
d = await model();
check(d.lines.filter(l => l.shape === "line" && near(Math.abs(l.b.y - l.a.y), 1000, 0.01) && [22900, 23300, 23700].some(x => near(l.a.x, x, 0.6))).length === 3, "Array: Number 4, 400 apart");
await sel(id0); await focus(); await keys("RE");
await optSelect(0, "numerical"); await optNumber("Scale", 2); await focus();
const before = (await model()).lines.find(l => l.id === id0);
await click(before.a.x, before.a.y);
d = await model();
const sc = d.lines.find(l => l.id === id0);
check(near(Math.hypot(sc.b.x - sc.a.x, sc.b.y - sc.a.y), 2000, 0.01), "Scale (numerical 2) doubles the line about the clicked origin");

// 5. Align a wall face to a line, lock it, and the wall follows the line
await view(5000, 4000);
await focus(); await keys("LI"); await click(-1500, -500); await click(-1500, 9000); await esc2();
const refId = (await model()).lines.at(-1).id;
await focus(); await keys("AL");
await click(-1500, 4000);           // reference line
await click(-127, 2000);            // the west wall's outer face
d = await model();
const west = d.walls.find(w => near(w.a.x, w.b.x) && w.typeId === "wt-ext225" && Math.min(w.a.x, w.b.x) < 0);
check(!!west && near(west.a.x, -1500 + 127.5, 0.6), `Align puts the west wall's outer face on the line (wall now at x = ${west?.a.x})`);
const lock = await S(() => { const h = window.__sketch.plan.hits.at(-1); const r = document.getElementById("planCanvas").getBoundingClientRect(); return h && { x: r.left + h.cx, y: r.top + h.cy }; });
check(!!lock, "a padlock appears after aligning");
if (lock) { await page.mouse.click(lock.x, lock.y); await page.waitForTimeout(100); }
check(((await model()).constraints || []).length === 1, "clicking the padlock locks the alignment");
await esc2();
await sel(refId); await focus(); await keys("MV"); await click(-1500, 4000); await hover(-2500, 4000); await keys("500\n");
d = await model();
const west2 = d.walls.find(w => w.id === west.id);
check(near(west2.a.x, -2000 + 127.5, 0.6), `moving the line moves the locked wall with it (x = ${west2.a.x})`);
const joined = d.walls.filter(w => w.typeId === "wt-ext225" && near(w.a.y, w.b.y) && (near(w.a.y, 0) || near(w.a.y, 8000)));
check(joined.length === 2 && joined.every(w => near(Math.min(w.a.x, w.b.x), west2.a.x, 0.6)), "the walls joined to it stretch too, so the corners stay closed");
await page.screenshot({ path: `${OUT}/phase3-align.png` });

// 6. Pin: a pinned wall cannot move or be deleted; Unpin frees it
await sel(west.id); await focus(); await keys("PN");
await page.keyboard.press("Delete");
check((await model()).walls.some(w => w.id === west.id), "a pinned wall is not deleted");
await sel(west.id); await focus(); await keys("MV"); await click(-2000, 4000); await hover(-3000, 4000); await keys("100\n");
check(near((await model()).walls.find(w => w.id === west.id).a.x, west2.a.x, 0.01), "a pinned wall does not move");
await esc2(); await sel(west.id); await focus(); await keys("UP");
check(!(await model()).walls.find(w => w.id === west.id).pinned, "Unpin frees it");

// 7. Undo walks everything back to an empty sheet; one redo brings the first four walls back
for (let i = 0; i < 120; i++) await page.keyboard.press("Control+z");
d = await model();
check(d.walls.length === 0 && d.lines.length === 0, `undo steps all the way back (walls ${d.walls.length}, lines ${d.lines.length})`);
await page.keyboard.press("Control+y");
check((await model()).walls.length === 4, "one redo brings back the first four walls");

check(!errors.length, `no page errors ${errors.length ? errors.join(" | ") : ""}`);
await browser.close(); srv.close();
console.log(fails.length ? `\nPHASE 3 BROWSER TEST FAILED (${fails.length})` : "\nPHASE 3 BROWSER TEST PASSED");
process.exit(fails.length ? 1 : 0);
