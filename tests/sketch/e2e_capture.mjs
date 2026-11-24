// Pictures for Ollic AI: clay views from four corners and the front, a material view, and a plan of each level with
// ids written on it; the 3D view on screen is left as it was.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
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

await S(async doc => {
  const M = await import("./assets/sketch/model.js"), T = await import("./assets/sketch/aitools.js"), a = window.__sketch;
  a.loadDoc(M.normalize(doc));
  T.runTool(a.history, "add_railing", { edges: ["F2:exposed"], type: "glass", height: 1100, material: "mt-steel-brushed" });
  T.runTool(a.history, "add_cladding", { wall_ids: ["S1"], material: "mt-travertine" });
}, testBox());
const camBefore = await S(() => window.__sketch.view3d.camera.position.toArray());
const shots = await S(async () => { const C = await import("./assets/sketch/capture.js"); const a = window.__sketch; return [...await C.captureViews(a, { style: "clay" }), ...await C.capture3D(a, ["sw"], { style: "material" })]; });
const camAfter = await S(() => window.__sketch.view3d.camera.position.toArray());
check(shots.length === 8, `8 pictures: 4 corners, front, 2 plans, 1 material view (${shots.map(s => s.name).join(", ")})`);
// brightness and variety of each picture (a blank picture would be one colour)
const stats = await S(async list => Promise.all(list.map(s => new Promise(res => { const im = new Image(); im.onload = () => { const c = document.createElement("canvas"); c.width = 128; c.height = 96; const x = c.getContext("2d"); x.drawImage(im, 0, 0, 128, 96); const d = x.getImageData(0, 0, 128, 96).data; let sum = 0, sq = 0; for (let i = 0; i < d.length; i += 4) { const g = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += g; sq += g * g; } const n = d.length / 4, m = sum / n; res({ mean: m, sd: Math.sqrt(sq / n - m * m) }); }; im.src = s.dataUrl; }))), shots);
shots.forEach((s, i) => { writeFileSync(`${OUT}/ai-view-${s.name.replace(/[^a-z0-9]+/gi, "-")}${s.style === "material" ? "-material" : ""}.jpg`, Buffer.from(s.dataUrl.split(",")[1], "base64")); });
check(shots.every((s, i) => s.width === 1024 && s.height === 768 && stats[i].sd > 8), "every picture is 1024 x 768 and not blank");
check(shots.filter(s => s.style === "clay").every((s, i) => stats[i].mean > 170), "clay pictures are light (white model on white)");
check(stats.at(-1).mean < 120, "the material view keeps the dark background and colours");
const plan2 = shots.find(s => s.kind === "plan" && s.levelId === "lv-2");
check(["S2", "D2", "WS2a", "F2", "e3", "R1:e1"].every(t => plan2.labels.includes(t)), "Level 2 plan names walls, openings, the floor, its edges and the roof edges");
check(JSON.stringify(camBefore) === JSON.stringify(camAfter), "the 3D view on screen is put back as it was");
const summary = await S(async () => { const M = await import("./assets/sketch/summary.js"); return M.modelSummary(window.__sketch.doc); });
check(summary.added.length === 2 && summary.walls.length === 8, "the summary lists the walls and what was added");
check(!errors.length, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\ncapture: all passed");
