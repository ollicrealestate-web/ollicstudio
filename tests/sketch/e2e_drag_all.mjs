// Browser test: dragging any element in plan moves it exactly as far as the mouse (no run-away),
// Zoom to fit finds components, and a far-away element can be selected and deleted.
import { createRequire } from "node:module";
import { serve } from "./e2e_phase1.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };
const near = (a, b, t = 1) => Math.abs(a - b) <= t;
const srv = await serve();
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on("pageerror", e => errors.push(e.message));
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);
const S = (fn, arg) => page.evaluate(fn, arg);
const toScreen = (x, y) => S(([x, y]) => { const a = window.__sketch, r = document.getElementById("planCanvas").getBoundingClientRect(), s = a.plan.toScreen({ x, y }); return { x: r.left + s.x, y: r.top + s.y }; }, [x, y]);
await S(async () => {
  const a = window.__sketch, C = await import("./assets/sketch/components.js"), A = await import("./assets/sketch/annotate.js");
  const rect = (x0, y0, x1, y1) => { const q = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]; return q.map((p, i) => ({ shape: "line", a: p, b: q[(i + 1) % 4] })); };
  a.commit("setup", doc => { doc.components.push(C.makeExtrusion(doc, { levelId: "lv-1", start: 0, end: 1000, boundary: rect(0, 0, 2000, 2000) })); doc.texts.push(A.makeText("lv-1", { x: 6000, y: 1000 }, "Hall")); });
  const p = a.plan; p.s = 0.05; p.cx = 3000; p.cy = 1000; p.invalidate();
});
const drag = async (from, to) => { const a = await toScreen(...from), b = await toScreen(...to); await page.mouse.move(a.x, a.y, { steps: 2 }); await page.waitForTimeout(60); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 25 }); await page.mouse.up(); await page.waitForTimeout(100); };
await page.keyboard.press("Escape");
await drag([1000, 1000], [3000, 1000]);
let d = await S(() => JSON.parse(JSON.stringify(window.__sketch.doc)));
const xs = d.components[0].boundary.map(e => e.a.x);
check(near(Math.min(...xs), 2000, 60) && near(Math.max(...xs), 4000, 60), `dragging an extrusion 2 m moves it 2 m, not further (now x ${Math.round(Math.min(...xs))} to ${Math.round(Math.max(...xs))})`);
await drag([6000, 1000], [6000, 3000]);
d = await S(() => JSON.parse(JSON.stringify(window.__sketch.doc)));
check(near(d.texts[0].p.y, 3000, 60), `dragging a text 2 m moves it 2 m (y ${Math.round(d.texts[0].p.y)})`);
// an extrusion far away: Zoom to fit finds it, it can be selected and deleted
await S(() => { const a = window.__sketch; a.commit("far", doc => { for (const e of doc.components[0].boundary) { e.a.x += 100000; e.b.x += 100000; } }); });
await page.locator("#vFit").click(); await page.waitForTimeout(200);
const seen = await S(() => { const a = window.__sketch, c = a.doc.components[0], q = a.plan.toScreen(c.boundary[0].a); return q.x >= 0 && q.x <= a.plan.w && q.y >= 0 && q.y <= a.plan.h; });
check(seen, "plan Zoom to fit includes an extrusion 100 m away");
const id = await S(() => window.__sketch.doc.components[0].id);
await S(id => window.__sketch.pick3D(id), id);
await page.locator("#planCanvas").focus(); await page.keyboard.press("Delete");
check(await S(() => window.__sketch.doc.components.length === 0), "selected (e.g. by clicking it in 3D), Delete removes it");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
console.log(fails.length ? `\nDRAG BROWSER TEST FAILED (${fails.length})` : "\nDRAG BROWSER TEST PASSED");
process.exit(fails.length ? 1 : 0);
