// "Complete my design" end to end with the stand-in assistant (no cost), driven through the panel as a person would:
// press Complete my design, choose Full, upload a reference image, describe the style, Start; answer the questions and
// correct what it saw in the image; change one plan item in words; Build. The stand-in makes a 6-item plan, builds it
// (one command refused by the checks and retried), gets item 5 wrong on purpose and fixes it in check round 2, and
// reports. Then reject one item, accept the rest, export IFC: the right classes, and your walls unchanged.
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);
const S = (fn, arg) => page.evaluate(fn, arg);
const model = () => S(() => JSON.parse(JSON.stringify(window.__sketch.doc)));
const wallsOf = d => JSON.stringify(d.walls.map(w => [w.id, w.a, w.b, w.typeId, w.baseLevelId, w.topLevelId, w.unconnectedHeight, w.flipped]));

// the test box, and the stand-in assistant
await S(async doc => {
  const M = await import("./assets/sketch/model.js"), A = await import("./assets/sketch/aiclient.js"), a = window.__sketch;
  a.loadDoc(M.normalize(doc));
  const text = t => ({ type: "text", text: t }), U = A.use;
  // what the assistant was sent: its words (pictures counted, not copied)
  const said = msgs => JSON.stringify(msgs, (k, v) => (k === "data" && typeof v === "string" && v.length > 200 ? "<picture>" : v));
  window.__seen = {};
  a.aiTransportOverride = A.standInTransport((stage, messages, n) => {
    window.__seen[`${stage}${n}`] = said(messages);
    if (stage === "interview") return [text("I see a 10 x 8 m two-storey house with a south balcony and a flat roof."),
      U("describe_references", { images: [{ n: 1, sees: "A modern duplex with stone walls", takes: "Stone cladding on the front" }] }),
      U("ask_questions", { questions: [{ id: "rail", text: "Balcony railings?", choices: ["Frameless glass", "Metal balusters"] }, { id: "roof", text: "Roof edge?", choices: ["Curved fascia", "Flat with parapet"] }, { id: "colour", text: "Any colours to avoid?", choices: ["None", "Avoid dark colours"] }] })];
    if (stage === "plan") return [text("Here is the plan."), U("write_plan", { summary: "Six items.", items: [
      { n: 1, title: "Travertine cladding, south walls", what: "30 mm travertine cladding", where: "S1, S2", sizes: "30 mm", material: "mt-travertine", image: 1 },
      { n: 2, title: "Glass railing, balcony", what: "Frameless glass railing", where: "F2 free edges", sizes: "1100 mm", material: "mt-glass-clear" },
      { n: 3, title: "Curved roof fascia", what: "Curved fascia all round", where: "R1 all edges", sizes: "450 mm deep", material: "mt-paint-white" },
      { n: 4, title: "Teak soffit under the roof", what: "Wood-look soffit with light line", where: "R1", material: "mt-timber-teak" },
      { n: 5, title: "Canopy over the front door", what: "Concrete canopy", where: "D1", sizes: "1200 deep", material: "mt-concrete" },
      { n: 6, title: "Black fins, east wall", what: "Vertical aluminium fins", where: "E1", sizes: "300 deep, 300 apart", material: "mt-alu-black" }] })];
    if (stage === "build") {
      const fin150 = /make the fins 150 mm apart/.test(said(messages));
      return [
        [U("add_cladding", { wall_ids: ["S1", "S2"], thickness: 30, material: "mt-travertine", plan_item: 1 }), U("item_done", { plan_item: 1, ok: true })],
        [U("add_railing", { edges: ["F2:exposed"], type: "glass", height: 1100, material: "mt-steel-brushed", plan_item: 2 }), U("item_done", { plan_item: 2, ok: true })],
        [U("add_edge_sweep", { edges: ["R1:all"], profile: "pf-fascia-curved", material: "mt-paint-white", plan_item: 3 }), U("item_done", { plan_item: 3, ok: true })],
        [U("add_soffit", { host_id: "R1", material: "mt-timber-teak", lighting_line: true, plan_item: 4 }), U("item_done", { plan_item: 4, ok: true })],
        [U("add_canopy", { opening_id: "D1", depth: 600, material: "mt-concrete", plan_item: 5 }), U("item_done", { plan_item: 5, ok: true })],
        [U("add_fins", { wall_ids: ["N1"], spacing: 300, depth: 300, material: "mt-alu-black", plan_item: 6 })], // across the north window: refused
        [U("add_fins", { wall_ids: ["E1"], spacing: fin150 ? 150 : 300, depth: 300, width: 50, material: "mt-alu-black", plan_item: 6 }), U("item_done", { plan_item: 6, ok: true, note: fin150 ? "150 mm apart as asked" : "" })],
        [text("All six items are built.")],
      ][n];
    }
    if (stage === "check") {
      const canopy = a.doc.details.find(d => d.kind === "canopy");
      return [
        [U("check_result", { ok: false, problems: [{ plan_item: 5, problem: "The canopy is only 600 mm deep: too shallow to shelter the door." }] }), U("edit_element", { id: canopy.id, changes: { depth: 1200 } }), U("item_done", { plan_item: 5, ok: true, note: "made 1200 deep" })],
        [text("Fixed the canopy.")],
        [U("check_result", { ok: true, problems: [] })],
        [text("Everything matches the plan.")],
      ][n];
    }
    if (stage === "report") return [U("final_report", { built: ["1. Travertine cladding", "2. Glass railing", "3. Curved fascia", "4. Teak soffit with light line", "5. Canopy, 1200 deep", "6. Fins 150 mm apart"], not_built: ["The stone texture is a flat colour"], please_check: ["The fins on the east wall against your windows plan"] })];
    return [text("?")];
  });
}, testBox());
const original = wallsOf(await model());

// 1. start
await page.locator("#ribbonTabs button", { hasText: "Architecture" }).first().click();
await page.locator(".sk-tool[data-id='aiComplete']").click();
await page.locator("#aiStart").waitFor({ timeout: 10000 });
check(await page.locator("#aiPanel").isVisible(), "Complete my design opens the Ollic AI panel with the start form");
await page.locator("input[name=aiDetail][value=full]").check();
const pic = await page.screenshot({ type: "jpeg", quality: 70, clip: { x: 0, y: 0, width: 600, height: 400 } });
await page.locator("#aiFiles").setInputFiles({ name: "duplex.jpg", mimeType: "image/jpeg", buffer: pic });
await page.locator(".ai-refs img").first().waitFor({ timeout: 5000 });
check((await page.locator(".ai-refs img").count()) === 1, "a reference image is added");
await page.locator("#aiDesc").fill("Modern Nigerian duplex: travertine, glass balcony, curved roof edge");
await page.waitForFunction(() => /Estimated cost: \$0\.40/.test(document.querySelector("#aiEst")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
check(/Estimated cost: \$0\.40–\$1\.20/.test(await page.locator("#aiEst").innerText()), "the estimated cost is shown before starting");
await page.locator("#aiStart").click();

// 2. what it sees, questions
await page.locator("#aiAnswer").waitFor({ timeout: 60000 });
check((await page.locator(".ai-q").count()) === 3, "three questions with tap-to-choose answers");
check((await page.locator("textarea[data-ref='1'][data-k=sees]").inputValue()) === "A modern duplex with stone walls", "what it saw in image 1 is shown");
await page.locator("textarea[data-ref='1'][data-k=sees]").fill("A modern duplex with travertine walls and a glass balcony");
await page.locator(".ai-q[data-q=rail] .chip", { hasText: "Frameless glass" }).click();
await page.locator(".ai-q[data-q=roof] .chip", { hasText: "Curved fascia" }).click();
await page.locator("[data-own=colour]").fill("No pink");
const first = await S(() => window.__seen.interview0);
check(/Model summary/.test(first) && (first.match(/<picture>/g) || []).length === 8, "the assistant got the summary, 7 pictures of the model and the reference image");
await page.locator("#aiAnswer").click();

// 3. the plan
await page.locator("#aiBuild").waitFor({ timeout: 60000 });
const planAsked = await S(() => window.__seen.plan0);
check(/Frameless glass/.test(planAsked) && /No pink/.test(planAsked) && /travertine walls and a glass balcony/.test(planAsked), "answers, own words and the corrected image note go to the assistant");
check((await page.locator(".ai-plan li").count()) === 6, "a 6-item plan to tick");
await page.locator("[data-change='5']").fill("make the fins 150 mm apart");
await page.locator("#aiPanel").screenshot({ path: `${OUT}/complete-plan.png` });
await page.locator("#aiBuild").click();

// 4-6. build, check, report
await page.locator(".ai-report").waitFor({ timeout: 120000 }).catch(async e => { console.log(await page.locator("#aiPanel").innerText()); throw e; });
let d = await model();
const kinds = d.details.map(x => x.kind).sort();
check(JSON.stringify(kinds) === JSON.stringify(["canopy", "cladding", "edgeSweep", "fins", "railing", "soffit"]), `six items built into the proposal (${kinds})`);
check(d.details.every(x => x.option === "ai-proposal" && x.source === "ai" && x.planItem >= 1), "all in the AI proposal, tagged ai with their plan item");
const fins = d.details.find(x => x.kind === "fins");
check(fins.args.spacing === 150 && fins.hosts[0] === "E1", "the plan change in words was built (fins 150 mm apart, on the east wall)");
check(d.details.find(x => x.kind === "canopy").args.depth === 1200, "check round 1 found the shallow canopy; it was fixed");
check(/round 2: no problems/i.test(await page.locator(".ai-flow").innerText()), "check round 2 found no problems");
const flowText = await page.locator(".ai-flow").innerText();
check(/1 refused by the checks and retried/.test(flowText), "the refused fin command (across a window) is reported");
check(/stone texture is a flat colour/.test(flowText) && /Please check/.test(flowText), "the honest report lists what was simplified and what to check");
check(wallsOf(d) === original, "your walls are unchanged after building");
const labels = await S(() => window.__sketch.history.undoStack.map(s => s.label));
check(["1", "2", "3", "4", "5", "6"].every(n => labels.filter(l => l.startsWith(`Item ${n}`)).length === 1), `one undo step per item (${labels.join(" / ")})`);
await page.locator("#aiPanel").screenshot({ path: `${OUT}/complete-review.png` });

// export is held back while the proposal is open
await page.locator("#fileExport").click();
check(await page.locator("#xIfc").isDisabled() && /accept or discard it/.test(await page.locator("#xIfcGate").innerText()), "IFC export waits until the proposal is accepted or discarded");
check(await S(async () => { const I = await import("./assets/sketch/ifc.js"), T = await import("three"); try { I.modelIfc(window.__sketch, T); return false; } catch (e) { return /AI proposal/.test(e.message); } }), "the IFC writer itself refuses while the proposal is open");
await page.locator("#xClose").click();

// review: reject the fascia, accept the rest
await page.locator(".ai-items li", { hasText: "Curved roof fascia" }).locator("button[data-act=reject]").click(); await page.waitForTimeout(150);
await page.locator("#aiAcceptAll").click(); await page.waitForTimeout(150);
d = await model();
check(d.details.length === 5 && !d.details.some(x => x.kind === "edgeSweep") && !d.details.some(x => x.option), "rejected item gone, the rest accepted into the model");
check(wallsOf(d) === original, "your walls are exactly as drawn (coordinates compared)");
await S(() => { const v = window.__sketch.view3d; v.invalidate(); v.fit(); v.lookFrom("sw"); });
await page.waitForTimeout(400);
await page.locator("#view3d canvas").screenshot({ path: `${OUT}/complete-3d.png` });

// export IFC
const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), (async () => { await page.locator("#fileExport").click(); await page.locator("#xIfc").click(); })()]);
const path = `${OUT}/finishing-complete.ifc`; await dl.saveAs(path);
await page.locator("#xClose").click();
const ifc = readFileSync(path, "utf8");
for (const [re, what] of [[/IFCCOVERING\([^;]*\.CLADDING\.\)/, "cladding"], [/IFCRAILING\(/, "railing"], [/IFCCOVERING\([^;]*\.CEILING\.\)/, "soffit"], [/IFCSLAB\([^;]*'CANOPY'[^;]*\.USERDEFINED\.\)/, "canopy"], [/IFCSHADINGDEVICE\(/, "fins"]]) check(re.test(ifc), `IFC has the ${what} with its class`);
check(!/FASCIA/.test(ifc), "IFC has no rejected fascia");
check((ifc.match(/IFCPROPERTYSINGLEVALUE\('Source',\$,IFCLABEL\('ai'\)/g) || []).length === 5, "IFC: each added element says source = ai");
check((ifc.match(/IFCWALL\(/g) || []).length === 8, "IFC still has your 8 walls");

// the session record can be reopened: what was said, planned, built and reported
await page.locator("#aiRestart").click(); await page.locator("#aiPast").click();
await page.locator("[data-past]").first().click();
const past = await page.locator(".ai-flow").innerText();
check(/accepted/.test(past) && /Travertine cladding, south walls/.test(past) && /stone texture is a flat colour/.test(past) && /commands recorded, 1 refused/.test(past), "a past session reopens with its chat, plan, report and commands");
await page.locator("#aiPastBack").click();

// deleting a wall trims the cladding on it; undo brings it back
await S(() => { const a = window.__sketch; a.setTool("select"); a.selection = new Set(["S1"]); a.selectionChanged(); });
await page.locator("#ribbonTabs button", { hasText: "Modify" }).first().click(); await page.locator(".sk-tool[data-id='delete']").click();
d = await model();
check(JSON.stringify(d.details.find(x => x.kind === "cladding").args.wall_ids) === '["S2"]' && !d.details.some(x => x.kind === "canopy"), "deleting wall S1 leaves the cladding on S2 only and removes the canopy over its door");
await S(() => window.__sketch.history.undo());
d = await model();
check(d.details.length === 5 && wallsOf(d) === original, "undo puts the wall and its details back");

check(!errors.length, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\ncomplete my design (stand-in): all passed");
