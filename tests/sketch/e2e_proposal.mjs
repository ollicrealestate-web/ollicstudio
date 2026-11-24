// The AI proposal in the browser: items listed in the Ollic AI panel; Before hides them, After shows them; Compare
// shows both with a slider; reject one, accept one, accept all; undo; discard; your walls never move.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);
const S = (fn, arg) => page.evaluate(fn, arg);
const model = () => S(() => JSON.parse(JSON.stringify(window.__sketch.doc)));
const meshIds = () => S(() => { const v = window.__sketch.view3d; if (v.dirty) { v.dirty = false; v.rebuild(); } const s = new Set(); v.root.traverse(o => { if (o.isMesh && o.userData.id) s.add(o.userData.id); }); return [...s]; });
const wallsOf = d => JSON.stringify(d.walls.map(w => [w.id, w.a, w.b, w.baseLevelId, w.topLevelId, w.material ?? null]));

await S(async doc => { const M = await import("./assets/sketch/model.js"); window.__sketch.loadDoc(M.normalize(doc)); }, testBox());
const original = wallsOf(await model());
check(await page.locator("#aiPanel").isHidden(), "no proposal: the panel stays closed");

// Ollic AI's build lands in the proposal (here run directly, as the assistant will)
await S(async () => {
  const T = await import("./assets/sketch/aitools.js"), a = window.__sketch, ctx = { source: "ai", session: "s1", option: "ai-proposal" };
  a.commit("Plan", doc => { doc.settings = { ...doc.settings, ai: { session: "s1", plan: [{ n: 1, text: "Travertine cladding, south" }, { n: 2, text: "Glass railing, balcony" }, { n: 3, text: "Curved roof fascia" }, { n: 4, text: "Brick on the east walls" }] } }; });
  for (const [name, args] of [["add_cladding", { wall_ids: ["S1", "S2"], material: "mt-travertine", plan_item: 1 }], ["add_railing", { edges: ["F2:exposed"], type: "glass", height: 1100, material: "mt-steel-brushed", plan_item: 2 }],
    ["add_edge_sweep", { edges: ["R1:all"], profile: "pf-fascia-curved", material: "mt-paint-white", plan_item: 3 }], ["set_material", { element_ids: ["E1", "E2"], material: "mt-brick-red", plan_item: 4 }]]) {
    const r = T.runTool(a.history, name, args, ctx); if (!r.ok) throw new Error(r.error);
  }
});
await page.waitForTimeout(200);
check(await page.locator("#aiPanel").isVisible(), "the Ollic AI panel opens with the proposal");
check((await page.locator(".ai-items li").count()) === 4, "four proposed items listed");
check(wallsOf(await model()) === original, "your walls (and their materials) are untouched by the proposal");

// Before / After
let d = await model();
const added = d.details.map(x => x.id);
check(added.every(id => d.details.find(x => x.id === id).option === "ai-proposal"), "added parts are in the AI proposal");
await page.locator("#aiBefore").click(); await page.waitForTimeout(150);
let ids = await meshIds();
check(added.every(id => !ids.includes(id)), "Before: the proposal is hidden in 3D");
await page.locator("#aiAfter").click(); await page.waitForTimeout(150);
ids = await meshIds();
check(added.every(id => ids.includes(id)), "After: the proposal shows in 3D");

// Compare
await S(() => { const v = window.__sketch.view3d; v.fit(); v.lookFrom?.("sw"); });
await page.locator("#aiCompare").click();
await page.locator(".cmp").waitFor({ timeout: 10000 });
check((await page.locator(".cmp img").count()) === 2, "Compare shows before and after");
await page.locator("#cmpSlider").fill("70"); await page.waitForTimeout(50);
check(/70%/.test(await page.locator("#cmpBefore").getAttribute("style")), "the slider moves the split");
await page.locator(".cmp").screenshot({ path: `${OUT}/proposal-compare.png` });
await page.locator("#cmpClose").click();

// reject item 2, accept item 1
await page.locator(".ai-items li").nth(1).locator("button[data-act=reject]").click(); await page.waitForTimeout(100);
d = await model();
check(!d.details.some(x => x.kind === "railing"), "Reject removed the railing");
await page.locator(".ai-items li").first().locator("button[data-act=accept]").click(); await page.waitForTimeout(100);
d = await model();
check(d.details.find(x => x.kind === "cladding")?.option === undefined, "Accept made the cladding part of the model");
check((await page.locator(".ai-items li").count()) === 2, "two items left");

// accept all, undo, discard
await page.locator("#aiAcceptAll").click(); await page.waitForTimeout(100);
d = await model();
check(!d.details.some(x => x.option) && d.walls.find(w => w.id === "E1").material === "mt-brick-red", "Accept all: everything accepted, brick now on the east walls");
await S(() => window.__sketch.history.undo()); await page.waitForTimeout(100);
check((await page.locator(".ai-items li").count()) === 2, "Undo brings the two items back");
await page.locator("#aiDiscard").click(); await page.locator("#askYes").click(); await page.waitForTimeout(100);
d = await model();
check(d.details.length === 1 && d.details[0].kind === "cladding" && !d.walls.some(w => w.proposed), "Discard removed the rest; the accepted cladding stays");
check(wallsOf(d) === original, "your walls are exactly where you drew them");

check(!errors.length, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nAI proposal: all passed");
