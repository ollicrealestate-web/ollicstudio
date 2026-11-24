// Live check of "Complete my design" with the real assistant (costs money; run by hand, not on every push):
//   ANTHROPIC_API_KEY=... [CLAUDE_MODEL=claude-opus-5-5] [REF_IMAGE=photo.jpg] node tests/sketch/live_check.mjs [outDir]
// The test box plus one reference image (by default a picture made in Sketch of a modern duplex with travertine
// cladding, timber slats, a glass balcony and a big flat roof overhang; REF_IMAGE uses a real photo instead).
// It answers the questions with the first choice, builds, and saves before/after pictures to look at.
// The assistant gets exactly what the server sends: the same instructions and tools (backend/app/sketch_ai_prompts.json).
// LIVE_MOCK=1 replaces the assistant with fixed answers, to check this script itself without cost.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { serve } from "./e2e_phase1.mjs";
import { testBox } from "./testbox.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const OUT = process.argv[2] || "out/sketch-live";
mkdirSync(OUT, { recursive: true });
const KEY = process.env.ANTHROPIC_API_KEY, MOCK = process.env.LIVE_MOCK === "1", MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
if (!KEY && !MOCK) { console.log("Set ANTHROPIC_API_KEY to run the live check (or LIVE_MOCK=1 to check the script)."); process.exit(2); }
const P = JSON.parse(readFileSync(new URL("../../backend/app/sketch_ai_prompts.json", import.meta.url), "utf8"));
const PRICES = { "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-fable-5-1": [10, 50] };

// the server's tools_for and system_for, from the same file
function toolsFor(stage, offered) {
  const allowed = { all: P.model_tools, read: P.read_tools, none: [] }[P.stage_model_tools[stage]];
  const out = P.stage_meta[stage].map(n => ({ name: n, ...P.meta_tools[n] }));
  for (const t of offered) if (allowed.includes(t.name)) out.push({ name: t.name, description: String(t.description || "").slice(0, 1500), input_schema: t.input_schema });
  if (out.length) out[out.length - 1] = { ...out.at(-1), cache_control: { type: "ephemeral" } };
  return out;
}
let total = 0, calls = 0;
async function step(body) {
  const { stage, messages, tools } = JSON.parse(body);
  calls++;
  if (MOCK) return mockAnswer(stage, messages);
  const req = { model: MODEL, max_tokens: 8000, system: [{ type: "text", text: P.rules, cache_control: { type: "ephemeral" } }, { type: "text", text: P.stages[stage] }], messages, tools: toolsFor(stage, tools) };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(req) });
    const j = await res.json();
    if (res.status === 529 || res.status === 429) { if (attempt < 4) { await new Promise(r => setTimeout(r, 15000 * (attempt + 1))); continue; } }
    if (!res.ok) throw new Error(`assistant error ${res.status}: ${j.error?.message || ""}`);
    const u = j.usage || {}, [pin, pout] = PRICES[MODEL] || PRICES["claude-opus-5-5"];
    const tin = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), cost = (tin * pin + (u.output_tokens || 0) * pout) / 1e6;
    total += cost;
    console.log(`  ${stage}: ${tin} in, ${u.output_tokens} out, $${cost.toFixed(3)}; ${j.content.filter(b => b.type === "tool_use").map(b => b.name).join(", ") || "text"}`);
    return JSON.stringify({ content: j.content, stop_reason: j.stop_reason, cost_usd: cost, session_cost_usd: total });
  }
}
let mockN = {};
function mockAnswer(stage, messages) {
  const n = mockN[stage] = (mockN[stage] || 0) + 1, u = (name, input) => ({ type: "tool_use", id: `m${calls}_${name}`, name, input });
  const said = JSON.stringify(messages);
  const plan = [{ n: 1, title: "Travertine cladding", what: "travertine cladding", where: "S1 S2" }, { n: 2, title: "Glass balcony railing", what: "glass", where: "F2" }, { n: 3, title: "Timber slat screen", what: "timber slats", where: "east" }, { n: 4, title: "Soffit and fascia for the big overhang", what: "soffit, fascia", where: "R1" }];
  const C = {
    interview: [[u("describe_references", { images: [{ n: 1, sees: "duplex", takes: "travertine" }] }), u("ask_questions", { questions: [{ id: "a", text: "Railings?", choices: ["Glass", "Metal"] }] })]],
    plan: [[u("write_plan", { items: plan })]],
    build: [[u("add_cladding", { wall_ids: ["S1", "S2"], material: "mt-travertine", plan_item: 1 }), u("add_railing", { edges: ["F2:exposed"], type: "glass", height: 1100, material: "mt-steel-brushed", plan_item: 2 }), u("add_soffit", { host_id: "R1", material: "mt-timber-teak", plan_item: 4 }), u("add_edge_sweep", { edges: ["R1:all"], profile: "pf-fascia", material: "mt-paint-white", plan_item: 4 })], [{ type: "text", text: "done" }]],
    check: [[u("check_result", { ok: true, problems: [] })], [{ type: "text", text: "ok" }]],
    report: [[u("final_report", { built: ["all"], not_built: [], please_check: [] })]],
  }[stage] || [[{ type: "text", text: "?" }]];
  void said;
  return JSON.stringify({ content: C[Math.min(n - 1, C.length - 1)], stop_reason: "tool_use", cost_usd: 0, session_cost_usd: 0 });
}

const srv = await serve();
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.exposeFunction("__liveStep", step);
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);
const S = (fn, arg) => page.evaluate(fn, arg);

// the reference image: a real photo, or a picture made in Sketch
let ref;
if (process.env.REF_IMAGE && existsSync(process.env.REF_IMAGE)) ref = "data:image/jpeg;base64," + readFileSync(process.env.REF_IMAGE).toString("base64");
else ref = await S(async doc => {
  const M = await import("./assets/sketch/model.js"), T = await import("./assets/sketch/aitools.js"), C = await import("./assets/sketch/capture.js"), a = window.__sketch;
  a.loadDoc(M.normalize(doc));
  for (const [n, x] of [["add_cladding", { wall_ids: ["S1", "S2", "E1", "E2", "W1", "W2"], thickness: 30, material: "mt-travertine", panel_joints: 600 }], ["add_railing", { edges: ["F2:exposed"], type: "glass", height: 1100, material: "mt-steel-brushed" }],
    ["add_soffit", { host_id: "R1", material: "mt-timber-teak", lighting_line: true }], ["add_edge_sweep", { edges: ["R1:all"], profile: "pf-fascia", material: "mt-paint-white" }], ["set_material", { element_ids: ["R1"], material: "mt-paint-white" }],
    ["add_screen", { level_id: "lv-1", line: [[10157.5, 500], [10157.5, 2500]], height: 2700, pattern: "vertical_slats", slat_width: 50, slat_depth: 80, gap: 40, material: "mt-timber-teak", reason: "x" }]]) { const r = T.runTool(a.history, n, x); if (!r.ok) console.warn(n, r.error); }
  a.prefs.visual = "realistic";
  const [shot] = await C.capture3D(a, ["sw"], { style: "material", width: 1200, height: 900 });
  a.prefs.visual = "shaded";
  return shot.dataUrl;
}, testBox());
writeFileSync(`${OUT}/reference.jpg`, Buffer.from(ref.split(",")[1], "base64"));

// the plain test box, and the live transport
await S(async doc => {
  const M = await import("./assets/sketch/model.js"), a = window.__sketch;
  a.loadDoc(M.normalize(doc));
  let total = 0;
  a.aiTransportOverride = {
    config: async () => ({ available: true }), estimate: async () => ({ low_usd: 0, high_usd: 0 }),
    createSession: async b => ({ id: "live-check", status: "open", estimate: { low_usd: 0, high_usd: 0 }, ...b }),
    step: async (id, b) => { const r = JSON.parse(await window.__liveStep(JSON.stringify(b))); total = r.session_cost_usd; return r; },
    update: async () => ({}), addReference: async (id, b) => ({ n: 1, path: "live/1.jpg" }),
  };
}, testBox());
const wallsBefore = await S(() => JSON.stringify(window.__sketch.doc.walls));
await S(() => { const v = window.__sketch.view3d; v.fit(); v.lookFrom("sw"); });
await page.waitForTimeout(300);
await page.locator("#view3d canvas").screenshot({ path: `${OUT}/before-3d.png` });

await page.locator("#ribbonTabs button", { hasText: "Architecture" }).first().click();
await page.locator(".sk-tool[data-id='aiComplete']").click();
await page.locator("#aiStart").waitFor();
await page.locator("input[name=aiDetail][value=full]").check();
await page.locator("#aiFiles").setInputFiles({ name: "duplex.jpg", mimeType: "image/jpeg", buffer: Buffer.from(ref.split(",")[1], "base64") });
await page.locator(".ai-refs img").first().waitFor();
await page.locator("#aiDesc").fill("Finish it like the picture: a modern duplex with travertine cladding, timber slats, a glass balcony and a big flat roof overhang.");
console.log("Start");
await page.locator("#aiStart").click();
await page.locator("#aiAnswer").waitFor({ timeout: 600000 });
const seen = await page.locator(".ai-flow").innerText();
for (const q of await page.locator(".ai-q").all()) await q.locator(".chip").first().click();
await page.locator("#aiPanel").screenshot({ path: `${OUT}/questions.png` });
await page.locator("#aiAnswer").click();
await page.locator("#aiBuild").waitFor({ timeout: 600000 });
const planText = await page.locator(".ai-plan").innerText();
writeFileSync(`${OUT}/plan.txt`, planText);
await page.locator("#aiPanel").screenshot({ path: `${OUT}/plan.png` });
console.log("Build");
await page.locator("#aiBuild").click();
await page.locator(".ai-report").waitFor({ timeout: 1800000 });
const report = await page.locator(".ai-flow").innerText();
writeFileSync(`${OUT}/report.txt`, report);
await page.locator("#aiPanel").screenshot({ path: `${OUT}/report.png` });
await S(() => { const v = window.__sketch.view3d; v.invalidate(); v.fit(); v.lookFrom("sw"); });
await page.waitForTimeout(500);
await page.locator("#view3d canvas").screenshot({ path: `${OUT}/after-3d.png` });
await S(() => window.__sketch.view3d.lookFrom("se")); await page.waitForTimeout(300);
await page.locator("#view3d canvas").screenshot({ path: `${OUT}/after-3d-se.png` });

const kinds = await S(() => [...new Set(window.__sketch.doc.details.map(d => d.kind))]);
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); console.log(ok ? "ok  " : "FAIL", msg); };
check(/travertine/i.test(planText) && /(timber|slat|wood)/i.test(planText) && /glass/i.test(planText) && /(overhang|soffit|fascia)/i.test(planText), "the plan mentions travertine, timber slats, glass balcony and the overhang");
for (const k of ["cladding", "railing", "soffit", "edgeSweep"]) check(kinds.includes(k), `built ${k}`);
check(await S(() => JSON.stringify(window.__sketch.doc.walls)) === wallsBefore, "your walls are unchanged");
check(!errors.length, `no page errors ${errors.join(" | ")}`);
console.log(`\n${calls} assistant calls, about $${total.toFixed(2)}. Pictures and texts in ${OUT}: look at before-3d.png and after-3d.png.\nWhat it saw first: ${seen.slice(0, 600)}`);
await browser.close(); srv.close();
process.exit(fails.length ? 1 : 0);
