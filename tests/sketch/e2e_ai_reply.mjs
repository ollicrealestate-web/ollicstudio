// When Ollic AI answers the plan stage with a question instead of a plan, you can reply and it writes the plan.
// Also: a picture of the whole workspace with the panel open (it sits beside the views, not over them).
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
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);
await page.evaluate(async doc => {
  const M = await import("./assets/sketch/model.js"), A = await import("./assets/sketch/aiclient.js"), a = window.__sketch;
  a.loadDoc(M.normalize(doc));
  a.aiTransportOverride = A.standInTransport((stage, messages, n) => {
    if (stage === "interview") return [A.use("ask_questions", { questions: [] })];
    if (stage === "plan" && !/Brick, please/.test(JSON.stringify(messages))) return [{ type: "text", text: "Should the plinth be stone or brick?" }];
    if (stage === "plan") return [A.use("write_plan", { items: [{ n: 1, title: "Brick plinth", what: "450 mm brick plinth band", where: "S1" }] })];
    return [{ type: "text", text: "ok" }];
  });
}, testBox());
await page.locator("#ribbonTabs button", { hasText: "Architecture" }).first().click();
await page.locator(".sk-tool[data-id='aiComplete']").click();
await page.locator("#aiStart").click();
await page.locator("#aiAnswer").waitFor({ timeout: 30000 });
await page.locator("#aiAnswer").click();
await page.locator("#aiReplan").waitFor({ timeout: 30000 });
check(/Should the plinth be stone or brick\?/.test(await page.locator(".ai-chat").innerText()) && /has not written a plan yet/.test(await page.locator(".ai-flow").innerText()), "its question is shown with a place to answer");
await page.locator("#aiTell").fill("Brick, please");
await page.locator("#aiReplan").click();
await page.locator("#aiBuild").waitFor({ timeout: 30000 });
check((await page.locator(".ai-plan li").count()) === 1 && /Brick plinth/.test(await page.locator(".ai-plan").innerText()), "after the answer it writes the plan");
await page.screenshot({ path: `${OUT}/workspace-with-panel.png` });
const views = await page.evaluate(() => { const v = document.getElementById("views").getBoundingClientRect(), p = document.getElementById("aiPanel").getBoundingClientRect(); return { vr: v.right, pl: p.left }; });
check(views.vr <= views.pl + 1, `on a wide screen the views end where the panel starts (${Math.round(views.vr)} <= ${Math.round(views.pl)})`);
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nplan reply: all passed");
