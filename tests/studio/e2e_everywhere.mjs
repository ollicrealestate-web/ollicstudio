// The chosen materials everywhere: the material map and the names the AI renders are given, a GLB with textures
// (validated by tests/sketch/check_glb.mjs in CI), the data the server writes into the IFC (written and validated
// in backend/tests/test_materials.py), and Ollic Sketch's Realistic 3D style on the same library and textures.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "../sketch/e2e_phase1.mjs";
import { testBox } from "../sketch/testbox.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const OUT = process.argv[2] || "out/studio";
mkdirSync(OUT, { recursive: true });
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };
const srv = await serve();
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);
const FINISHES = [["add_cladding", { wall_ids: ["S1"], material: "mt-travertine" }], ["add_soffit", { host_id: "R1", material: "mt-timber-teak" }],
  ["add_railing", { edges: ["F2:exposed"], type: "glass", height: 1100, material: "mt-steel-brushed" }], ["set_material", { element_ids: ["E1"], material: "mt-brick-red" }]];
const ifc = await page.evaluate(async ({ doc, F }) => {
  const M = await import("./assets/sketch/model.js"), T = await import("./assets/sketch/aitools.js"), I = await import("./assets/sketch/ifc.js"), THREE = await import("three"), a = window.__sketch;
  a.loadDoc(M.normalize(doc));
  for (const [n, x] of F) { const r = T.runTool(a.history, n, x); if (!r.ok) throw new Error(r.error); }
  return I.modelIfc(a, THREE, { name: "Everywhere test" }).text;
}, { doc: testBox(), F: FINISHES });

// ---------------------------------------------------------------- 1. Ollic Sketch: Realistic style on the library
await page.evaluate(() => { const a = window.__sketch; a.prefs.visual = "realistic"; a.selection?.clear?.(); a.view3d.invalidate(); a.view3d.fit(); a.view3d.lookFrom?.("se"); });
await page.waitForFunction(async () => (await import("./assets/materials/look.js")).texturesReady(), null, { timeout: 120000, polling: 500 });
await page.waitForTimeout(1500);
const sk = await page.evaluate(() => { const ids = new Set(); window.__sketch.view3d.root.traverse(o => { if (o.isMesh && o.material?.userData?.lib) ids.add(o.material.userData.lib); }); return [...ids]; });
check(["mt-travertine", "mt-timber-teak", "mt-brick-red"].every(id => sk.includes(id)), `Sketch's Realistic style shows the library's textures (${sk.length} materials: ${sk.slice(0, 6).join(", ")})`);
await page.locator("#view3d canvas").screenshot({ path: join(OUT, "everywhere-sketch-realistic.png") });

// ---------------------------------------------------------------- 2. the Studio: names in the material map
await page.evaluate(async text => {
  const R = await import("./assets/ifcread.js"), V = await import("./assets/viewer.js");
  const r = await R.readIfc(new TextEncoder().encode(text));
  const host = document.createElement("div"); host.style.cssText = "position:fixed;left:0;top:0;width:800px;height:500px;z-index:99"; document.body.append(host);
  const v = window.__studio = V.createViewer(host);
  await v.load(URL.createObjectURL(new Blob([r.glb], { type: "model/gltf-binary" })));
}, ifc);
await page.waitForFunction(async () => (await import("./assets/materials/look.js")).texturesReady(), null, { timeout: 120000, polling: 500 });
const before = await page.evaluate(() => window.__studio.guides(320, 200, ["materials"]).legend);
check(before.some(g => g.name === "Travertine stone") && before.some(g => g.name === "Face brick - red"), `the material map names the IFC's materials (${before.map(g => g.name).filter(Boolean).join(", ")})`);
const slabKey = await page.evaluate(() => {
  const v = window.__studio, slab = v.debugParts().find(p => p.type === "IfcSlab");
  v.applyMaterial(slab.key, { id: "mt-tile-porcelain-grey-600" });
  return slab.key;
});
const after = await page.evaluate(() => window.__studio.guides(320, 200, ["materials"]).legend);
const tile = after.find(g => g.key.endsWith("|mt-tile-porcelain-grey-600"));
check(tile && tile.name === "Porcelain tile 600 x 600 - grey" && /chosen in the 3D preview; 600 x 600 mm tiles/.test(tile.finish), `a material set in the preview is its own material in the map, named for the AI (${tile?.name}: ${tile?.finish})`);
const kept = before.filter(g => after.some(h => h.key === g.key)).length;
check(kept >= before.length - 1, `the other materials keep their keys (${kept} of ${before.length})`);

// ---------------------------------------------------------------- 3. what is written into the IFC
const wb = await page.evaluate(() => window.__studio.writeBackData());
check(wb.parts.length === 1 && wb.parts[0].key === slabKey && wb.materials["mt-tile-porcelain-grey-600"]?.tile_mm?.join() === "600,600", "the IFC write-back gets the changed part and its material");

// ---------------------------------------------------------------- 4. GLB with textures
const glb = await page.evaluate(async () => { const b = await window.__studio.exportGlb(); return await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result.split(",")[1]); f.readAsDataURL(b); }); });
const buf = Buffer.from(glb, "base64");
writeFileSync(join(OUT, "studio-with-materials.glb"), buf);
const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8"));
check(buf.toString("ascii", 0, 4) === "glTF" && (json.images || []).length >= 4 && (json.textures || []).length >= 4, `a GLB with ${json.images?.length} pictures and ${json.materials?.length} materials (${(buf.length / 1048576).toFixed(1)} MB)`);
check((json.nodes || []).some(n => n.extras?.globalId && n.extras?.material === "Porcelain tile 600 x 600 - grey"), "each part keeps its GlobalId and material name");
check((json.extensionsUsed || []).includes("KHR_texture_transform"), "textures keep their real size (texture transform)");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nEverywhere: all passed");
