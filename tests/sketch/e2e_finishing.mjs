// Finishing tools by hand (browser): on the test box, add cladding, a balcony railing and a roof soffit from the
// Finishing ribbon; a fin across a window is refused in the dialog; Properties shows the IFC class and changes the
// material; Edit changes a size; Undo works; 3D shows them; the IFC has the right classes and Pset_OllicSource.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);
const S = (fn, arg) => page.evaluate(fn, arg);
const model = () => S(() => JSON.parse(JSON.stringify(window.__sketch.doc)));
const select = ids => S(ids => { const a = window.__sketch; a.setTool("select"); a.selection.clear(); ids.forEach(id => a.selection.add(id)); a.selectionChanged(); }, ids);
const ribbon = async id => { await page.locator("#ribbonTabs button", { hasText: "Finishing" }).first().click(); await page.locator(`.sk-tool[data-id='${id}']`).click(); };
const setField = async (k, v) => { const el = page.locator(`#fd_${k}`); if ((await el.evaluate(e => e.tagName)) === "SELECT") await el.selectOption(String(v)); else await el.fill(String(v)); };

await S(async doc => { const M = await import("./assets/sketch/model.js"); window.__sketch.loadDoc(M.normalize(doc)); window.__sketch.setLevel("lv-1"); }, testBox());
await page.waitForTimeout(200);

// ---- cladding on the Level 1 south wall, from the selection
await select(["S1"]); await ribbon("fin-add_cladding");
check((await page.locator("#fd_wall_ids").inputValue()) === "S1", "Cladding dialog starts with the selected wall");
await setField("material", "mt-travertine"); await setField("thickness", 30);
await page.locator("#fdOk").click(); await page.waitForTimeout(150);
let d = await model();
check(d.details.length === 1 && d.details[0].kind === "cladding" && d.details[0].source === "user", "cladding added by hand");

// ---- a fin across a window is refused, in plain words, in the dialog
await select(["S1"]); await ribbon("fin-add_fins");
await setField("depth", 300); await setField("spacing", 600); await setField("material", "mt-alu-black");
await page.locator("#fdOk").click(); await page.waitForTimeout(150);
const err = await page.locator("#fdErr").innerText();
check(/blocks (window|door)/.test(err), `fins across a window refused: "${err.slice(0, 80)}"`);
await page.locator("#fdCancel").click();
check((await model()).details.length === 1, "the refused fins left nothing behind");

// ---- glass railing on the balcony (selected floor -> its free edges)
await S(() => window.__sketch.setLevel("lv-2"));
await select(["F2"]); await ribbon("fin-add_railing");
check((await page.locator("#fd_edges").inputValue()) === "F2:exposed", "Railing dialog starts with the balcony's free edges");
await setField("type", "glass"); await setField("height", 1100);
await page.locator("#fdOk").click(); await page.waitForTimeout(150);
d = await model();
const rail = d.details.find(x => x.kind === "railing");
check(!!rail, "railing added");

// ---- soffit under the roof overhang
await select(["R1"]); await ribbon("fin-add_soffit");
check((await page.locator("#fd_host_id").inputValue()) === "R1", "Soffit dialog starts with the selected roof");
await setField("material", "mt-timber-teak"); await page.locator("#fd_lighting_line").check();
await page.locator("#fdOk").click(); await page.waitForTimeout(150);
d = await model();
check(d.details.some(x => x.kind === "soffit"), "soffit added");

// ---- Properties: IFC class, material, Edit
await select([rail.id]); await page.waitForTimeout(100);
const props = await S(() => [...document.querySelectorAll("#props input, #props span")].map(e => e.value ?? e.textContent).join(" | "));
check(/IfcRailing/.test(props) && /You/.test(props), "Properties show IfcRailing and who added it");
await page.locator("#dMat").selectOption("mt-alu-black"); await page.waitForTimeout(100);
check((await model()).details.find(x => x.id === rail.id).args.material === "mt-alu-black", "material changed from Properties");
await page.locator("#dEdit").click();
check((await page.locator("#fd_height").inputValue()) === "1100", "Edit opens with the railing's settings");
await setField("height", 1000); await page.locator("#fdOk").click(); await page.waitForTimeout(150);
check((await model()).details.find(x => x.id === rail.id).args.height === 1000, "Edit changed the height");
await S(() => window.__sketch.history.undo());
check((await model()).details.find(x => x.id === rail.id).args.height === 1100, "Undo put the height back");

// ---- 3D shows every detail; picture for checking by eye
await S(() => { const a = window.__sketch; a.selection.clear(); a.selectionChanged(); a.prefs.hidden3D = []; a.view3d.invalidate(); });
await page.waitForTimeout(400);
const ids3d = await S(() => { const s = new Set(); window.__sketch.view3d.root.traverse(o => { if (o.isMesh && o.userData.id) s.add(o.userData.id); }); return [...s]; });
d = await model();
check(d.details.every(x => ids3d.includes(x.id)), "every detail is drawn in 3D");
await S(() => { const v = window.__sketch.view3d; v.fit(); v.lookFrom?.("sw"); });
await page.waitForTimeout(400);
await page.locator("#view3d canvas").screenshot({ path: `${OUT}/finishing-3d.png` });

// ---- materials set on your own elements show in 3D (whole element, and one face of a wall)
await S(async () => { const T = await import("./assets/sketch/aitools.js"); const a = window.__sketch; T.runTool(a.history, "set_material", { element_ids: ["E2"], material: "mt-brick-red" }); T.runTool(a.history, "set_material", { element_ids: ["N1"], face: "exterior", material: "mt-timber-teak" }); a.view3d.invalidate(); });
await page.waitForTimeout(400);
const cols = await S(() => { const out = {}; window.__sketch.view3d.root.traverse(o => { if (o.isMesh && ["E2", "N1"].includes(o.userData.id)) (out[o.userData.id] ||= new Set()).add(o.material.color.getHexString()); }); return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]])); });
check(cols.E2?.includes("9b4a32"), `wall set to brick shows brick red in 3D (${cols.E2})`);
check(cols.N1?.includes("9a6a3f") && cols.N1.length > 1, `one face set to teak shows a teak skin on that wall (${cols.N1})`);

// ---- IFC: classes, materials, source
const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), (async () => { await page.locator("#fileExport").click(); await page.locator("#xIfc").click(); })()]);
const path = `${OUT}/finishing.ifc`; await dl.saveAs(path);
const ifc = readFileSync(path, "utf8");
check(/IFCCOVERING\([^;]*\.CLADDING\.\)/.test(ifc), "IFC: cladding is IfcCovering CLADDING");
check(/IFCCOVERING\([^;]*\.CEILING\.\)/.test(ifc), "IFC: soffit is IfcCovering CEILING");
check(/IFCRAILING\([^;]*\.GUARDRAIL\.\)/.test(ifc), "IFC: railing is IfcRailing");
check(/Pset_OllicSource/.test(ifc) && /IFCRELASSOCIATESMATERIAL/.test(ifc) && /Travertine stone/.test(ifc), "IFC: Pset_OllicSource and materials");

check(!errors.length, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nfinishing tools: all passed");
