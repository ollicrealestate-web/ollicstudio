// Phase 1 browser test: drives the real Sketch page in Chromium like an architect would.
// Run: node tests/sketch/e2e_phase1.mjs [outDir]   (serves web/ itself)
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { extname, join, normalize as normPath } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
const OUT = process.argv[2] || "out/sketch";
mkdirSync(OUT, { recursive: true });

const TYPES = { ".wasm": "application/wasm", ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff": "font/woff", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
export function serve(root = WEB) {
  const srv = createServer(async (req, res) => {
    const path = normPath(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
    try { const body = await readFile(join(root, path || "index.html")); res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" }); res.end(body); }
    catch { res.writeHead(404); res.end("not found"); }
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r(srv)));
}

if (process.argv[1] && !process.argv[1].endsWith("e2e_phase1.mjs")) { /* imported for serve() only */ } else await run();

async function run() {
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };

const srv = await serve();
const url = `http://127.0.0.1:${srv.address().port}/sketch.html`;
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(url);
await page.waitForFunction(() => window.__sketch?.ready && window.__sketch.plan.w > 10);

const model = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__sketch.doc)));
const toScreen = (x, y) => page.evaluate(([x, y]) => { const a = window.__sketch, r = document.getElementById("planCanvas").getBoundingClientRect(), s = a.plan.toScreen({ x, y }); return { x: r.left + s.x, y: r.top + s.y }; }, [x, y]);
const click = async (x, y, opts) => { const p = await toScreen(x, y); await page.mouse.move(p.x - 3, p.y - 3); await page.mouse.move(p.x, p.y, { steps: 2 }); await page.mouse.click(p.x, p.y, opts); await page.waitForTimeout(60); };
const hover = async (x, y) => { const p = await toScreen(x, y); await page.mouse.move(p.x, p.y, { steps: 3 }); };
const keys = async s => { for (const ch of s) await page.keyboard.press(ch === "\n" ? "Enter" : ch); };

// fixed view: 1 px = 33 mm, the whole test drawing on screen
await page.evaluate(() => { const p = window.__sketch.plan; p.s = 0.03; p.cx = 8000; p.cy = 3500; p.invalidate(); });
await page.locator("#planCanvas").focus();

// 1. Model line by shortcut, typed lengths, chain, Esc ends chain, Esc again leaves the tool
await keys("LI");
check(await page.evaluate(() => window.__sketch.tool.name) === "modelLine", "LI starts Model Line");
await click(0, 0);
await hover(3000, 40);            // east, within 3 degrees: held horizontal
await keys("6000\n");
await hover(6000, 3000);          // north
await keys("4000\n");
await page.keyboard.press("Escape");
let d = await model();
check(d.lines.length === 2, `two chained lines drawn (got ${d.lines.length})`);
const [l1, l2] = d.lines;
check(l1 && Math.abs(l1.b.x - 6000) < 0.01 && Math.abs(l1.b.y) < 0.01, `typed 6000 east ends at (6000,0) (got ${l1 && JSON.stringify(l1.b)})`);
check(l2 && Math.abs(l2.a.x - 6000) < 0.01 && Math.abs(l2.b.y - 4000) < 0.01 && Math.abs(l2.b.x - 6000) < 0.01, `chain continues and typed 4000 north ends at (6000,4000) (got ${l2 && JSON.stringify(l2.b)})`);
check(await page.evaluate(() => window.__sketch.tool.name) === "modelLine", "first Esc ends the chain but keeps the tool");
await page.keyboard.press("Escape");
check(await page.evaluate(() => window.__sketch.tool.name) === "select", "second Esc leaves the tool");

// 2. Snaps: start a new line on the endpoint and finish on the midpoint of the first line
await keys("LI");
await click(6000 + 120, 4000 - 100);  // ~7 px from the endpoint
await click(3000 + 60, 60);           // near the midpoint of line 1
await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
d = await model();
const l3 = d.lines[2];
check(l3 && Math.hypot(l3.a.x - 6000, l3.a.y - 4000) < 0.01, `endpoint snap (got ${l3 && JSON.stringify(l3.a)})`);
check(l3 && Math.hypot(l3.b.x - 3000, l3.b.y) < 0.01, `midpoint snap (got ${l3 && JSON.stringify(l3.b)})`);

// 3. Rectangle and circle with typed radius, as detail lines
await keys("DL");
await page.locator(".sk-options .seg button[title='Rectangle']").click();
await page.locator("#planCanvas").focus();
await click(8000, 0); await click(12000, 3000);
await page.locator(".sk-options .seg button[title='Circle']").click();
await page.locator("#planCanvas").focus();
await click(14000, 6000); await hover(15000, 6000); await keys("1500\n");
await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
d = await model();
const det = d.lines.filter(l => l.kind === "detail");
check(det.length === 5, `rectangle (4) + circle (1) detail lines (got ${det.length})`);
const circ = det.find(l => l.shape === "arc");
check(circ && Math.abs(circ.r - 1500) < 0.01 && Math.abs(Math.abs(circ.sweep) - 2 * Math.PI) < 1e-9, `typed circle radius 1500 (got ${circ && circ.r})`);
check(det.filter(l => l.shape === "line").every(l => l.viewId === "plan:lv-1"), "detail lines belong to the Level 1 plan view");
await page.screenshot({ path: `${OUT}/phase1-drawn.png` });

// 4. Selection: click, window (left to right), crossing (right to left), Ctrl adds, Delete, undo, redo
await click(1500, 0);
check((await page.evaluate(() => [...window.__sketch.selection])).length === 1, "click selects one line");
await page.screenshot({ path: `${OUT}/phase1-selected.png` });
const drag = async (a, b) => { const p = await toScreen(...a), q = await toScreen(...b); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 6 }); await page.mouse.up(); };
await drag([7500, 3500], [12500, -500]);       // window around the rectangle only
check((await page.evaluate(() => window.__sketch.selection.size)) === 4, "window selects the 4 rectangle lines fully inside");
await drag([9000, -500], [7000, 3500]);        // crossing touching the rectangle's left side and its top/bottom
const crossN = await page.evaluate(() => window.__sketch.selection.size);
check(crossN === 3, `crossing selects the 3 lines it touches (got ${crossN})`);
await page.keyboard.press("Delete");
d = await model();
check(d.lines.length === 5, `Delete removes them (got ${d.lines.length})`);
await page.keyboard.press("Control+z");
check((await model()).lines.length === 8, "Ctrl+Z brings them back");
await page.keyboard.press("Control+y");
check((await model()).lines.length === 5, "Ctrl+Y deletes them again");
await page.keyboard.press("Control+z");

// 5. Temporary dimension: select line 1 and type a new length in its blue dimension
await page.keyboard.press("Escape");
await click(1500, 0);
const box = await page.evaluate(() => { const h = window.__sketch.plan.hits[0]; const r = document.getElementById("planCanvas").getBoundingClientRect(); return h && { x: r.left + h.cx, y: r.top + h.cy }; });
check(!!box, "selected line shows a clickable temporary dimension");
if (box) {
  await page.mouse.click(box.x, box.y);
  await page.locator("#inlineInput").fill("7200");
  await page.keyboard.press("Enter");
  d = await model();
  const first = d.lines.find(l => l.id === l1.id);
  check(Math.abs(Math.hypot(first.b.x - first.a.x, first.b.y - first.a.y) - 7200) < 0.01, "typing 7200 in the dimension sets the length");
}

// 6. Grip drag with snap: drag line 1's end back onto line 2's start
await page.keyboard.press("Escape"); await click(1500, 0);
{ const p = await toScreen(7200, 0), q = await toScreen(6000 + 60, 60); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 8 }); await page.mouse.up(); }
d = await model();
check(Math.hypot(d.lines.find(l => l.id === l1.id).b.x - 6000, d.lines.find(l => l.id === l1.id).b.y) < 0.01, "dragging a grip snaps to the other line's endpoint");

// 7. Right-click menu, snap override, other draw modes
{ const p = await toScreen(16500, -4000); await page.mouse.click(p.x, p.y, { button: "right" }); }
check(await page.locator("#ctxMenu").isVisible(), "right-click opens the menu");
check((await page.locator("#ctxMenu").innerText()).includes("Zoom to Fit"), "menu offers Zoom to Fit");
await page.keyboard.press("Escape");
await keys("LI");
await page.locator(".sk-options .seg button[title='Polygon']").click();
await page.locator("#planCanvas").focus();
await click(3000, 8000); await hover(4000, 8000); await keys("1000\n");
await page.locator(".sk-options .seg button[title='Start-End-Radius Arc']").click();
await page.locator("#planCanvas").focus();
await click(6000, 8000); await click(9000, 8000); await click(7500, 9500);
await page.locator(".sk-options .seg button[title='Centre-Ends Arc']").click();
await page.locator("#planCanvas").focus();
await click(12000, 8000); await click(13000, 8000); await hover(12700, 8700); await hover(12000, 9000); await click(12000, 9000);
await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
d = await model();
const hexes = d.lines.filter(l => l.shape === "line" && Math.abs(Math.hypot(l.a.x - 3000, l.a.y - 8000) - 1000) < 0.01);
check(hexes.length === 6, `hexagon of 6 lines with corners 1000 from the centre (got ${hexes.length})`);
const arcs = d.lines.filter(l => l.shape === "arc" && Math.abs(Math.abs(l.sweep) - 2 * Math.PI) > 1e-6);
const ser = arcs.find(a => Math.abs(a.r - 1500) < 1);
check(!!ser, `start-end-radius arc through (7500,9500) has radius 1500 (got ${arcs.map(a => a.r.toFixed(1))})`);
const ce = arcs.find(a => Math.abs(a.r - 1000) < 1 && Math.abs(a.sweep - Math.PI / 2) < 0.02);
check(!!ce, `centre-ends arc sweeps a quarter turn anticlockwise (got ${arcs.map(a => a.sweep.toFixed(3))})`);
await page.screenshot({ path: `${OUT}/phase1-modes.png` });

// 8. The 3D view shows the model lines (not the detail lines)
const n3d = await page.evaluate(() => { const v = window.__sketch.view3d; v.rebuild(); let n = 0; v.root.traverse(o => { if (o.isLineSegments) n += o.geometry.attributes.position.count / 2; }); return n; });
check(n3d > 6, `3D view draws the model lines (${n3d} segments)`);

// 9. Autosave: reload restores the same model
const before = JSON.stringify((await model()).lines);
await page.waitForTimeout(900);
await page.reload();
await page.waitForFunction(() => window.__sketch?.ready && window.__sketch.doc.lines.length > 0);
check(JSON.stringify((await model()).lines) === before, "reload restores exactly the same sketch from this browser");
await page.screenshot({ path: `${OUT}/phase1-reloaded.png` });

// 10. Tablet size: workspace still fits without horizontal scrolling
await page.setViewportSize({ width: 820, height: 1180 });
await page.waitForTimeout(300);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
check(overflow <= 0, `no horizontal scrolling on a tablet (overflow ${overflow}px)`);
await page.screenshot({ path: `${OUT}/phase1-tablet.png` });

check(!errors.length, `no page errors ${errors.length ? errors.join(" | ") : ""}`);
await browser.close(); srv.close();
console.log(fails.length ? `\nPHASE 1 BROWSER TEST FAILED (${fails.length})` : "\nPHASE 1 BROWSER TEST PASSED");
process.exit(fails.length ? 1 : 0);
}
