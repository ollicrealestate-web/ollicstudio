// Complete my design does not send the architect back to fix the model: a sketch whose outer walls stop short, run
// past a corner and miss a wall (and whose upper level has no floor) is made ready by itself when the button is
// pressed, the start form shows at once with what was fixed, and Undo takes the fixes back in one step.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "./e2e_phase1.mjs";
import { testBox } from "./testbox.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const OUT = process.argv[2] || "out/sketch";
mkdirSync(OUT, { recursive: true });
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };
const srv = await serve();
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);
await page.evaluate(async doc => {
  const M = await import("./assets/sketch/model.js"), A = await import("./assets/sketch/aiclient.js"), a = window.__sketch;
  const w = id => doc.walls.find(x => x.id === id);
  w("W1").b = { x: 0, y: 7600 }; w("N1").b = { x: 10600, y: 8000 };         // short of a corner; past a corner
  doc.walls = doc.walls.filter(x => !["E2", "E3"].includes(x.id));          // a wall missing on Level 2
  doc.floors = doc.floors.filter(f => f.levelId !== "lv-2");                 // and Level 2 without its floor
  a.loadDoc(M.normalize(doc));
  a.aiTransportOverride = A.standInTransport(() => []);
}, testBox());
const broken = await page.evaluate(async () => (await import("./assets/sketch/summary.js")).readiness(window.__sketch.doc));
check(broken.length >= 3, `the sketch is not ready as drawn (${broken.length} things missing)`);

await page.locator("#ribbonTabs button", { hasText: "Architecture" }).first().click();
await page.locator(".sk-tool[data-id='aiComplete']").click();
await page.locator("#aiStart").waitFor({ timeout: 10000 });
const text = await page.locator(".ai-flow").innerText();
check(/made the model ready/.test(text) && !/needs a little more/.test(text), "pressing Complete my design goes straight to the start form");
check(/joined/.test(text) && /added a 8\.00 m outer wall/.test(text) && /floor on Level 2/.test(text), `and says what it fixed: ${text.split("\n").filter(l => /joined|added|floor/i.test(l)).join(" / ")}`);
const now = await page.evaluate(async () => (await import("./assets/sketch/summary.js")).readiness(window.__sketch.doc));
check(!now.length, "the model is now ready (outer walls closed on every level, every level has its floor)");
await page.locator("#view3d").screenshot({ path: join(OUT, "sketch-made-ready.png") });
const undone = await page.evaluate(async () => { const a = window.__sketch; a.history.undo(); return (await import("./assets/sketch/summary.js")).readiness(a.doc).length; });
check(undone === broken.length, "one Undo takes all the fixes back");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nModel made ready: all passed");
