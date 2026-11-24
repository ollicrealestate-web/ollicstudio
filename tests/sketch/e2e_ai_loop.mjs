// The assistant loop in the browser, with the stand-in (no cost): commands in the answer are run and checked,
// a refused command goes back as an error and is fixed, results and pictures go back, cost adds up.
import { createRequire } from "node:module";
import { serve } from "./e2e_phase1.mjs";
import { testBox } from "./testbox.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };
const srv = await serve();
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);

const r = await page.evaluate(async doc => {
  const M = await import("./assets/sketch/model.js"), A = await import("./assets/sketch/aiclient.js"), a = window.__sketch;
  a.loadDoc(M.normalize(doc));
  const script = (stage, messages, n) => {
    if (stage === "build") return [
      [{ type: "text", text: "Starting with the cladding." }, A.use("add_cladding", { wall_ids: ["S1"], material: "travertine", plan_item: 1 })],
      [A.use("add_cladding", { wall_ids: ["S1"], material: "mt-travertine", plan_item: 1 }), A.use("get_element", { id: "S1" })],
      [A.use("item_done", { plan_item: 1, ok: true, ids: [] })],
      [{ type: "text", text: "Item 1 is built." }],
    ][n];
    if (stage === "check") return n === 0 ? [A.use("capture_views", { views: ["sw"], style: "clay", plans: false })] : [A.use("check_result", { ok: true, problems: [] })];
    return [{ type: "text", text: "?" }];
  };
  const t = A.standInTransport(script), session = await t.createSession({});
  const events = [], metas = [];
  const out = await A.runStage(a, { transport: t, session, stage: "build", messages: [{ role: "user", content: "Build item 1." }], onEvent: e => events.push(e), onMeta: (name, input) => { metas.push(name); return { result: "Thanks." }; } });
  const chk = await A.runStage(a, { transport: t, session, stage: "check", messages: [{ role: "user", content: "Check." }], onMeta: name => ({ result: "ok", pause: name === "check_result" }) });
  const refused = A.lastResults(t.calls[1].messages)[0], second = A.lastResults(t.calls[2].messages);
  const pics = A.lastResults(t.calls[5].messages)[0];
  const d = a.doc.details[0];
  return { steps: t.calls.length, stages: t.calls.map(c => c.stage), buildTools: t.calls[0].tools, refused, second: second.map(x => ({ err: !!x.is_error, c: String(x.content).slice(0, 80) })),
    detail: d && { kind: d.kind, source: d.source, session: d.session, option: d.option, planItem: d.planItem }, events: events.filter(e => e.type === "tool").map(e => [e.name, e.ok]), texts: events.filter(e => e.type === "text").map(e => e.text),
    metas, cost: out.cost, paused: chk.paused?.name, picBlocks: pics.content.map(b => b.type), sessionId: session.id };
}, testBox());

check(r.stages.join(",") === "build,build,build,build,check,check", `six steps: four to build, two to check (${r.stages})`);
check(r.buildTools.includes("add_cladding") && r.buildTools.includes("capture_views"), "the commands are offered to the assistant");
check(r.refused.is_error && /mt-travertine/.test(r.refused.content), "a refused command goes back as an error naming the right material");
check(r.second.length === 2 && !r.second[0].err && /dt-/.test(r.second[0].c) && !r.second[1].err, "the fixed command and the read go back with results");
check(r.detail?.kind === "cladding" && r.detail.source === "ai" && r.detail.session === r.sessionId && r.detail.option === "ai-proposal" && r.detail.planItem === 1, "the cladding is in the AI proposal, tagged with session and plan item 1");
check(JSON.stringify(r.events) === JSON.stringify([["add_cladding", false], ["add_cladding", true], ["get_element", true]]), "progress reports each command");
check(r.texts.includes("Item 1 is built.") && r.metas.includes("item_done"), "the assistant's words and item_done arrive");
check(Math.abs(r.cost - 0.2) < 1e-9, "cost adds up step by step");
check(r.paused === "check_result", "a stage can pause (to wait for the person)");
check(r.picBlocks.filter(t => t === "image").length === 1, "capture_views sends the picture back");
check(!errors.length, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nassistant loop: all passed");
