// The guides the AI renders are checked against (clay, lines, depth, material map) must stay exactly as they were
// before the realistic-materials work. Renders them from the same IFC files with the viewer as it was (git ref
// GUIDE_BASE_REF, default d5c03e6) and as it is now, and compares the pictures pixel by pixel.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../sketch/e2e_phase1.mjs";
import { testBox } from "../sketch/testbox.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const OUT = process.argv[2] || "out/studio";
mkdirSync(OUT, { recursive: true });
const REF = process.env.GUIDE_BASE_REF || "d5c03e6";
const old = mkdtempSync(join(tmpdir(), "guides-"));
execSync(`git archive ${REF} web | tar -x -C ${old}`);
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });

// the test model from Ollic Sketch, with finishes, exported once and opened by both viewers
async function sketchIfc(page, doc) {
  return page.evaluate(async doc => {
    const M = await import("./assets/sketch/model.js"), T = await import("./assets/sketch/aitools.js"), I = await import("./assets/sketch/ifc.js"), THREE = await import("three"), a = window.__sketch;
    a.loadDoc(M.normalize(doc));
    for (const [n, x] of [["add_cladding", { wall_ids: ["S1"], material: "mt-travertine" }], ["add_soffit", { host_id: "R1", material: "mt-timber-teak" }],
      ["add_railing", { edges: ["F2:exposed"], type: "glass", height: 1100, material: "mt-steel-brushed" }], ["set_material", { element_ids: ["E1"], material: "mt-brick-red" }]]) { const r = T.runTool(a.history, n, x); if (!r.ok) throw new Error(r.error); }
    return I.modelIfc(a, THREE, { name: "Guides test" }).text;
  }, doc);
}
const KINDS = ["clay", "lines", "materials", "depth"];
async function guides(root, ifcs) {
  const srv = await serve(root);
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
  await page.waitForFunction(() => window.__sketch?.ready);
  const out = {};
  for (const [name, text] of Object.entries(ifcs)) {
    out[name] = await page.evaluate(async ({ text, KINDS }) => {
      const R = await import("./assets/ifcread.js"), V = await import("./assets/viewer.js");
      const r = await R.readIfc(new TextEncoder().encode(text));
      let host = document.getElementById("studioHost");
      if (!host) { host = document.createElement("div"); host.id = "studioHost"; host.style.cssText = "position:fixed;left:0;top:0;width:640px;height:400px;z-index:99"; document.body.append(host); }
      window.__studio?.dispose?.(); host.replaceChildren();
      const v = window.__studio = V.createViewer(host);
      await v.load(URL.createObjectURL(new Blob([r.glb], { type: "model/gltf-binary" })));
      const f = v.engine().frame, c = f.getCenter(new (await import("three")).Vector3()), s = f.getSize(new (await import("three")).Vector3()), d = Math.max(s.x, s.y, s.z);
      const poses = [{ position: [c.x + d * 1.1, c.y + d * 0.6, c.z + d * 1.3], target: [c.x, c.y, c.z], fov: 45 }, { position: [c.x - d * 1.2, c.y + d * 0.3, c.z - d * 0.9], target: [c.x, c.y, c.z], fov: 45 }];
      const res = {};
      for (const k of KINDS) {
        v.beginGuide(k, 640, 400);
        poses.forEach((p, i) => {
          const cv = v.guideFrame(p), g = document.createElement("canvas"); g.width = 640; g.height = 400;
          const x = g.getContext("2d"); x.drawImage(cv, 0, 0, 640, 400);
          res[`${k}${i}`] = { px: Array.from(x.getImageData(0, 0, 640, 400).data), png: g.toDataURL("image/png") };
        });
        v.endGuide();
      }
      return res;
    }, { text, KINDS });
  }
  await page.close(); srv.close();
  return { out, errors };
}

const p0 = await browser.newPage();
const s0 = await serve();
await p0.goto(`http://127.0.0.1:${s0.address().port}/sketch.html`);
await p0.waitForFunction(() => window.__sketch?.ready);
const ifcs = { sketch: await sketchIfc(p0, testBox()), revit: readFileSync(new URL("./fixtures/revit_style.ifc", import.meta.url), "utf8") };
writeFileSync(join(OUT, "guides-test-model.ifc"), ifcs.sketch);
await p0.close(); s0.close();

const before = await guides(join(old, "web"), ifcs), after = await guides(new URL("../../web/", import.meta.url).pathname, ifcs);
for (const m of Object.keys(ifcs)) for (const key of Object.keys(before.out[m])) {
  const a = before.out[m][key], b = after.out[m][key];
  let diff = 0, most = 0;
  for (let i = 0; i < a.px.length; i += 4) {
    const d = Math.max(Math.abs(a.px[i] - b.px[i]), Math.abs(a.px[i + 1] - b.px[i + 1]), Math.abs(a.px[i + 2] - b.px[i + 2]));
    if (d > 1) { diff++; most = Math.max(most, d); }
  }
  writeFileSync(join(OUT, `guide-${m}-${key}-before.png`), Buffer.from(a.png.split(",")[1], "base64"));
  writeFileSync(join(OUT, `guide-${m}-${key}-after.png`), Buffer.from(b.png.split(",")[1], "base64"));
  // a wall now drawn as its two faces and its edges can shift a pixel or two where the pieces meet (rasterisation);
  // anything more than that (a colour, a shape, a light) fails
  check(diff <= 25 && most <= 16, `${m} model, ${key} guide: identical to before (${diff} of 256000 pixels differ${diff ? `, by at most ${most} of 255` : ""})`);
}
check(!before.errors.length && !after.errors.length, `no page errors ${[...before.errors, ...after.errors].join(" | ")}`);
await browser.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nGuides unchanged: all passed");
