// How the preview looks: the same view of the test house in the viewer as it was (git GUIDE_BASE_REF, default
// d5c03e6) and as it is now, at sunny day, golden hour, overcast and dusk, plus frames per second at Fast, High
// and Best. Saves look-*.png to the output folder for a person to judge; fails only on errors, black or blank
// pictures, a sun that does not follow the clock, or a light change that leaves the picture unchanged.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
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
const old = mkdtempSync(join(tmpdir(), "look-"));
execSync(`git archive ${REF} web | tar -x -C ${old}`);
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const W = 1280, H = 800;

async function open(root, ifc) {
  const srv = await serve(root);
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
  await page.waitForFunction(() => window.__sketch?.ready);
  await page.evaluate(async text => {
    const R = await import("./assets/ifcread.js"), V = await import("./assets/viewer.js");
    const r = await R.readIfc(new TextEncoder().encode(text));
    const host = document.createElement("div"); host.style.cssText = `position:fixed;left:0;top:0;width:${innerWidth}px;height:${innerHeight}px;z-index:99`; document.body.append(host);
    const v = window.__studio = V.createViewer(host);
    await v.load(URL.createObjectURL(new Blob([r.glb], { type: "model/gltf-binary" })));
    const T = await import("three"), f = v.engine().frame, c = f.getCenter(new T.Vector3()), s = f.getSize(new T.Vector3()), d = Math.max(s.x, s.y, s.z);
    window.__pose = { position: [c.x + d * 0.95, c.y + d * 0.12, c.z + d * 1.25], target: [c.x, c.y - s.y * 0.1, c.z], fov: 45 };
    v.showPose(window.__pose);
  }, ifc);
  // textures (if this viewer has them)
  await page.waitForFunction(async () => { try { return (await import("./assets/materials/look.js")).texturesReady(); } catch { return true; } }, null, { timeout: 120000, polling: 500 });
  return { page, srv, errors };
}
const settle = page => page.evaluate(() => new Promise(r => { let n = 0; const f = () => (++n > 45 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
const shot = async (page, name) => { await settle(page); const b = await page.screenshot({ path: join(OUT, `look-${name}.png`) }); return b; };
const stats = buf => page0.evaluate(async b64 => {
  const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
  const c = document.createElement("canvas"); c.width = 160; c.height = 100; const x = c.getContext("2d"); x.drawImage(img, 0, 0, 160, 100);
  const d = x.getImageData(0, 0, 160, 100).data; let s = 0, s2 = 0; const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; s += l; s2 += l * l; }
  return { mean: s / n, sd: Math.sqrt(s2 / n - (s / n) ** 2), px: Array.from(d) };
}, buf.toString("base64"));
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.px.length; i += 4) s += Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1]) + Math.abs(a.px[i + 2] - b.px[i + 2]); return s / (a.px.length / 4) / 3; };

const p0 = await browser.newPage(); const s0 = await serve();
await p0.goto(`http://127.0.0.1:${s0.address().port}/sketch.html`);
await p0.waitForFunction(() => window.__sketch?.ready);
const ifc = await p0.evaluate(async doc => {
  const M = await import("./assets/sketch/model.js"), T = await import("./assets/sketch/aitools.js"), I = await import("./assets/sketch/ifc.js"), THREE = await import("three"), a = window.__sketch;
  a.loadDoc(M.normalize(doc));
  for (const [n, x] of [["add_cladding", { wall_ids: ["S1"], material: "mt-travertine" }], ["add_soffit", { host_id: "R1", material: "mt-timber-teak" }],
    ["add_railing", { edges: ["F2:exposed"], type: "glass", height: 1100, material: "mt-steel-brushed" }], ["set_material", { element_ids: ["E1"], material: "mt-brick-red" }]]) { const r = T.runTool(a.history, n, x); if (!r.ok) throw new Error(r.error); }
  return I.modelIfc(a, THREE, { name: "Look test" }).text;
}, testBox());
const page0 = p0;

// before: the viewer as it was
const before = await open(join(old, "web"), ifc);
const bBefore = await shot(before.page, "before-viewer");
await before.page.close(); before.srv.close();

// after: the four skies at High
const now = await open(new URL("../../web/", import.meta.url).pathname, ifc);
const P = now.page;
const pics = {};
for (const preset of ["sunny", "golden", "overcast", "dusk"]) {
  const l = await P.evaluate(p => window.__studio.setLight({ preset: p }), preset);
  console.log(`     ${preset}: sun ${l.sunElevation} deg up, ${l.sunAzimuth} deg from north at ${Math.floor(l.minutes / 60)}:${String(l.minutes % 60).padStart(2, "0")} in Lagos`);
  pics[preset] = await stats(await shot(P, `after-${preset}`));
}
const bs = await stats(bBefore);
for (const [k, v] of Object.entries(pics)) check(v.mean > 25 && v.sd > 6, `${k}: a real picture (brightness ${v.mean.toFixed(0)}, contrast ${v.sd.toFixed(0)})`);
check(diff(pics.sunny, bs) > 3, `the new sunny view differs from the old viewer (${diff(pics.sunny, bs).toFixed(1)} levels on average)`);
check(diff(pics.sunny, pics.golden) > 3 && diff(pics.sunny, pics.dusk) > 3 && diff(pics.sunny, pics.overcast) > 2, "each sky changes the picture");
check(pics.dusk.mean < pics.sunny.mean, "dusk is darker than a sunny day");
// the sun follows the clock: morning sun in the east, afternoon in the west, noon high
const sun = await P.evaluate(() => [7 * 60, 12 * 60 + 30, 17 * 60].map(m => { const l = window.__studio.setLight({ preset: "sunny", minutes: m }); return [l.sunElevation, l.sunAzimuth]; }));
check(sun[0][1] > 60 && sun[0][1] < 130 && sun[2][1] > 220 && sun[2][1] < 300 && sun[1][0] > 50 && sun[0][0] < 15, `the sun follows the clock in Lagos: 7:00 ${sun[0]}, 12:30 ${sun[1]}, 17:00 ${sun[2]} (elevation, azimuth)`);
await P.evaluate(() => window.__studio.setLight({ preset: "sunny", minutes: null }));
// Best: the still view refines
await P.evaluate(() => window.__studio.setQuality("best"));
await shot(P, "after-sunny-best");
// paving and ground from the library
await P.evaluate(() => window.__studio.setLight({ apron: "mt-gravel", ground: "mt-grass" }));
await shot(P, "after-site-gravel");
await P.evaluate(() => window.__studio.setLight({ apron: "mt-paving-interlock" }));

// speed: frames per second while the camera moves around the house (CPU-drawn WebGL here, so a real laptop is faster)
const fps = {};
for (const q of ["fast", "high"]) {
  await P.evaluate(q => window.__studio.setQuality(q), q);
  await settle(P);
  fps[q] = await P.evaluate(() => new Promise(res => {
    const v = window.__studio, p0 = window.__pose, t0 = performance.now(); let n = 0;
    const f = () => {
      const a = n * 0.02, c = p0.target, dx = p0.position[0] - c[0], dz = p0.position[2] - c[2];
      v.showPose({ ...p0, position: [c[0] + dx * Math.cos(a) - dz * Math.sin(a), p0.position[1], c[2] + dx * Math.sin(a) + dz * Math.cos(a)] });
      n++;
      if (performance.now() - t0 < 4000) requestAnimationFrame(f); else res(n / ((performance.now() - t0) / 1000));
    };
    requestAnimationFrame(f);
  }));
  console.log(`     ${q}: ${fps[q].toFixed(1)} frames a second (headless, drawn by the CPU)`);
}
writeFileSync(join(OUT, "look-fps.json"), JSON.stringify(fps));
check(fps.fast >= fps.high * 0.9, "Fast is at least as quick as High");
check(!before.errors.length && !now.errors.length, `no page errors ${[...before.errors, ...now.errors].join(" | ")}`);
await browser.close(); s0.close(); now.srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nLook: all passed (pictures in " + OUT + ")");
void existsSync; void readFileSync;
