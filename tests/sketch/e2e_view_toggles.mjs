// Browser test: Live 3D on/off while drawing, and Full screen.
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
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);
const S = (fn, arg) => page.evaluate(fn, arg);
const toScreen = (x, y) => S(([x, y]) => { const a = window.__sketch, r = document.getElementById("planCanvas").getBoundingClientRect(), s = a.plan.toScreen({ x, y }); return { x: r.left + s.x, y: r.top + s.y }; }, [x, y]);
const click = async (x, y) => { const p = await toScreen(x, y); await page.mouse.move(p.x - 3, p.y - 3); await page.mouse.move(p.x, p.y, { steps: 2 }); await page.mouse.click(p.x, p.y); await page.waitForTimeout(60); };
const keys = async s => { for (const ch of s) await page.keyboard.press(ch); };
const focus = () => page.locator("#planCanvas").focus();
const view = () => S(() => { const p = window.__sketch.plan; p.s = 0.04; p.cx = 5000; p.cy = 4000; p.invalidate(); });
const meshes3d = () => S(() => { let n = 0; window.__sketch.view3d.root.traverse(o => { if (o.isMesh) n++; }); return n; });

const wBefore = (await page.locator("#planCanvas").boundingBox()).width;
check(await page.locator("#vLive").isChecked(), "Live 3D is on at first: plan and 3D side by side");
// ---- turn Live 3D off from the plan's view bar, then draw
await page.locator("#vLive").uncheck(); await page.waitForTimeout(200);
const wOff = (await page.locator("#planCanvas").boundingBox()).width;
check(await S(() => window.__sketch.view3d.paused && window.__sketch.prefs.layout === "plan-only") && await page.locator("#view3dWrap").isHidden(), "Live 3D off: the 3D view is hidden and paused");
check(wOff > wBefore * 1.6, `the plan takes the whole width (${Math.round(wBefore)} -> ${Math.round(wOff)} px)`);
await view(); await focus(); await keys("WA");
await page.locator(".sk-options .seg button[title='Rectangle']").click(); await focus();
await click(0, 0); await click(10000, 8000); await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
check((await S(() => window.__sketch.doc.walls.length)) === 4, "walls draw normally with Live 3D off");
check((await meshes3d()) === 0, "and the 3D view did no work while it was off");
// ---- on again with the shortcut LV
await focus(); await keys("LV"); await page.waitForTimeout(400);
check(await S(() => !window.__sketch.view3d.paused && window.__sketch.prefs.layout === "tile") && await page.locator("#vLive").isChecked(), "LV turns Live 3D back on (plan and 3D side by side)");
check((await meshes3d()) >= 4, "the 3D view catches up at once with the 4 walls");
await page.locator("#view3d canvas").screenshot({ path: `${OUT}/toggles-live3d-on.png` });
// ---- the setting is remembered after a reload
await page.locator("#vLive").uncheck(); await page.waitForTimeout(900); await page.reload(); await page.waitForFunction(() => window.__sketch?.ready);
check(await S(() => window.__sketch.view3d.paused) && !(await page.locator("#vLive").isChecked()), "Live 3D off is remembered after a reload");
await page.locator("#vLive").check();
// ---- full screen
await page.locator("#viewFull").click(); await page.waitForTimeout(300);
check(await S(() => !!document.fullscreenElement) && (await page.locator("#viewFull").getAttribute("aria-label")) === "Exit full screen", "Full screen fills the screen; the button now says Exit full screen");
await page.screenshot({ path: `${OUT}/toggles-fullscreen.png` });
await page.locator("#viewFull").click(); await page.waitForTimeout(300);
check(await S(() => !document.fullscreenElement) && (await page.locator("#viewFull").getAttribute("aria-label")) === "Full screen", "and leaves it again");
await page.locator("#ribbonTabs button", { hasText: "View" }).click();
check(await page.locator(".sk-tool[data-id='fullScreen']").isVisible() && await page.locator(".sk-tool[data-id='live3d']").isVisible(), "View tab has Live 3D and Full Screen buttons too");
// ---- the 3D view keeps showing the model when one element cannot be drawn, and Zoom to fit puts things right
await page.locator("#vLive").check();
await S(() => { const a = window.__sketch; a._keepFloors = a.buildFloors3D; a.buildFloors3D = () => { throw new Error("test fault"); }; a.redraw(true); });
await page.waitForTimeout(500);
check((await meshes3d()) >= 4, "a broken element does not blank the 3D view: the walls still show");
check((await page.locator("#toast").innerText()).includes("could not be shown in 3D"), "and it says part of the model could not be shown");
await S(() => { const a = window.__sketch; a.buildFloors3D = a._keepFloors; a.redraw(true); });
await S(() => { const a = window.__sketch; a.prefs.hidden3D = a.doc.levels.map(l => l.id); a.view3d.invalidate(); });
await page.waitForTimeout(300);
check((await meshes3d()) === 0, "with every level unticked under Levels, 3D shows nothing");
await page.locator("#v3Fit").click(); await page.waitForTimeout(300);
check((await meshes3d()) >= 4 && (await page.locator("#toast").innerText()).includes("all levels are shown again"), "Zoom to fit shows the levels again and says so");
await S(() => window.__sketch.toggleSectionBox(true));
await S(() => { const a = window.__sketch, b = { x0: 50000, x1: 60000, y0: 50000, y1: 60000, z0: 0, z1: 3000 }; a.prefs.sectionBox = a.prefs.sectionBoxMm = b; });
await page.locator("#v3Fit").click(); await page.waitForTimeout(300);
check(await S(() => window.__sketch.prefs.sectionBox.x0 < 1000) && (await page.locator("#toast").innerText()).includes("section box"), "a section box away from the model is fitted back to it by Zoom to fit");
await S(() => window.__sketch.toggleSectionBox(false));
check(!errors.filter(e => !/3D:/.test(e)).length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
console.log(fails.length ? `\nVIEW TOGGLES BROWSER TEST FAILED (${fails.length})` : "\nVIEW TOGGLES BROWSER TEST PASSED");
process.exit(fails.length ? 1 : 0);
