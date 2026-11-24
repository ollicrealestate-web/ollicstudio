// Materials read from IFC files into the Studio viewer: a Sketch export opens with exactly its library materials;
// Revit-style names are matched; a layered wall shows each layer on its own side; no material falls back to a guess.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { serve } from "../sketch/e2e_phase1.mjs";
import { testBox } from "../sketch/testbox.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };
const srv = await serve();
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);

// opens IFC text in the Studio's reader and viewer; returns each part: element type, name, material id, how, average normal
const open = ifc => page.evaluate(async text => {
  const R = await import("./assets/ifcread.js"), V = await import("./assets/viewer.js");
  const out = await R.readIfc(new TextEncoder().encode(text));
  let host = document.getElementById("studioHost");
  if (!host) { host = document.createElement("div"); host.id = "studioHost"; host.style.cssText = "position:fixed;left:0;top:0;width:800px;height:600px;z-index:99"; document.body.append(host); }
  host.replaceChildren(); window.__studio?.dispose?.();
  const v = window.__studio = V.createViewer(host);
  await v.load(URL.createObjectURL(new Blob([out.glb], { type: "model/gltf-binary" })));
  const parts = [];
  v.scene?.traverse?.(() => {});
  const T = await import("three");
  host.querySelector("canvas");
  // the viewer keeps its elements private; walk the scene from the renderer's canvas owner
  return { parts: v.debugParts(), report: out.report.status };
}, ifc);

// 1. an Ollic Sketch export
const sketchIfc = await page.evaluate(async doc => {
  const M = await import("./assets/sketch/model.js"), T = await import("./assets/sketch/aitools.js"), I = await import("./assets/sketch/ifc.js"), THREE = await import("three"), a = window.__sketch;
  a.loadDoc(M.normalize(doc));
  for (const [n, x] of [["add_cladding", { wall_ids: ["S1"], material: "mt-travertine" }], ["add_soffit", { host_id: "R1", material: "mt-timber-teak" }],
    ["add_railing", { edges: ["F2:exposed"], type: "glass", height: 1100, material: "mt-steel-brushed" }], ["set_material", { element_ids: ["E1"], material: "mt-brick-red" }]]) { const r = T.runTool(a.history, n, x); if (!r.ok) throw new Error(r.error); }
  return I.modelIfc(a, THREE, { name: "Materials test" }).text;
}, testBox());
let r = await open(sketchIfc);
const by = (pred) => r.parts.filter(pred);
const kinds = id => [...new Set(by(p => p.name === id || p.tag === id).map(p => `${p.mat}/${p.how}`))];
check(by(p => p.type === "IfcCovering" && p.pre === "CLADDING").every(p => p.mat === "mt-travertine" && p.how === "ifc") && by(p => p.type === "IfcCovering").length > 0, "Sketch cladding opens as Travertine stone, From your IFC");
check(by(p => p.type === "IfcCovering" && p.pre === "CEILING").some(p => p.mat === "mt-timber-teak" && p.how === "ifc"), "Sketch soffit opens as teak");
const rail = by(p => p.type === "IfcRailing");
check(rail.some(p => p.mat === "mt-glass-clear" && p.how === "ifc") && rail.some(p => p.mat === "mt-steel-brushed" && p.how === "ifc"), `Sketch railing: its glass is clear glass, its shoe brushed steel (${rail.map(p => p.mat + ":" + p.ifcName + ":" + p.seeThrough).join(", ")})`);
check(by(p => p.tag === "E1").some(p => p.mat === "mt-brick-red" && p.how === "ifc"), `Sketch brick wall opens as Face brick - red (${kinds("E1")})`);

// 2. a Revit-style file
r = await open(readFileSync(new URL("./fixtures/revit_style.ifc", import.meta.url), "utf8"));
const slab = by(p => p.type === "IfcSlab"), win = by(p => p.type === "IfcWindow"), wall = by(p => p.type === "IfcWall"), col = by(p => p.type === "IfcColumn");
check(slab.length && slab.every(p => p.mat === "mt-concrete" && p.how === "name"), `"Concrete - Cast In Situ" is matched to Fair-face concrete (${slab.map(p => p.mat + "/" + p.how)})`);
check(win.some(p => p.mat === "mt-glass-clear" && p.seeThrough) && win.some(p => p.mat === "mt-alu-silver" && !p.seeThrough), `window: "Glass" pane is clear glass, "Aluminium" frame is aluminium (${win.map(p => p.mat)})`);
const brickSide = wall.find(p => p.n[2] > 0.9), plasterSide = wall.find(p => p.n[2] < -0.9);
check(brickSide?.mat === "mt-brick-red" && plasterSide?.mat === "mt-render-sand", `layered wall: brick on its first-layer side, plaster on the other (${wall.map(p => `${p.mat}@${p.n.map(x => x.toFixed(1))}`).join(" ")})`);
check(col.length && col.every(p => p.how === "guess" && p.mat === "mt-concrete"), `a column with no material is Guessed (${col.map(p => p.mat + "/" + p.how)})`);
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nIFC materials: all passed");
