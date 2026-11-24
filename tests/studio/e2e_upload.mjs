// Make a material from a photo, as a person would: open the dialog, choose a test photo of 300 x 300 mm tiles taken
// at an angle in uneven light, drag the four corners onto the tiled area, say one tile is 300 x 300, ask Ollic AI,
// make it, check the result (colour, join, light), save it to My materials and put it on a wall. The store keeps
// the pictures the way the server does (backend/tests/test_materials.py tests the server's side).
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
const page = await browser.newPage({ viewport: { width: 1300, height: 1800 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);

// the test photo: 6 x 5 tiles of 300 mm at an angle, light falling off to the left (made in the page, saved as PNG)
const CORNERS = [[150, 120], [1050, 200], [1000, 820], [180, 760]];
const png = await page.evaluate(async C => {
  const W = 1200, H = 900, c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d"), im = g.createImageData(W, H);
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = C;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3, den = dx1 * dy2 - dx2 * dy1;
  const gg = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den, a = x1 - x0 + gg * x1, b = x3 - x0 + h * x3, cc = x0, d = y1 - y0 + gg * y1, e = y3 - y0 + h * y3, f = y0;
  const A = e - f * h, B = cc * h - b, CC = b * f - cc * e, D = f * gg - d, E = a - cc * gg, F = cc * d - a * f, G = d * h - e * gg, HH = b * gg - a * h, I = a * e - b * d;
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647), noise = Float32Array.from({ length: 160000 }, rnd);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const w = G * x + HH * y + I, u = (A * x + B * y + CC) / w, v = (D * x + E * y + F) / w, o = (y * W + x) * 4;
    let col = [60, 58, 55];
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
      const fu = (u * 6) % 1, fv = (v * 5) % 1, grout = fu < 0.0175 || fu > 0.9825 || fv < 0.0175 || fv > 0.9825;
      const n = noise[Math.min(399, Math.floor(u * 400)) * 400 + Math.min(399, Math.floor(v * 400))] * 14 - 7;
      col = grout ? [95, 90, 84] : [214 + n, 200 + n, 178 + n];
    }
    const light = 0.55 + 0.6 * (x / W);
    im.data[o] = col[0] * light; im.data[o + 1] = col[1] * light; im.data[o + 2] = col[2] * light; im.data[o + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c.toDataURL("image/png").split(",")[1];
}, CORNERS);
const photoPath = join(OUT, "upload-test-photo.png");
writeFileSync(photoPath, Buffer.from(png, "base64"));

const ifc = await page.evaluate(async doc => {
  const M = await import("./assets/sketch/model.js"), I = await import("./assets/sketch/ifc.js"), THREE = await import("three"), a = window.__sketch;
  a.loadDoc(M.normalize(doc)); return I.modelIfc(a, THREE, { name: "Upload test" }).text;
}, testBox());
await page.evaluate(async text => {
  const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "./assets/styles.css"; document.head.append(css);
  await new Promise(r => { css.onload = r; setTimeout(r, 3000); });
  const R = await import("./assets/ifcread.js"), V = await import("./assets/viewer.js"), P = await import("./assets/materials/panel.js");
  const wrap = document.createElement("div"); wrap.id = "studioTest"; wrap.style.cssText = "position:fixed;inset:0;z-index:50;background:#fff;overflow:auto"; document.body.append(wrap);
  const host = document.createElement("div"); host.style.cssText = "position:absolute;left:0;top:0;width:800px;height:560px"; wrap.append(host);
  const panel = document.createElement("div"); panel.style.cssText = "position:absolute;left:0;top:570px;width:1280px"; wrap.append(panel);
  const r = await R.readIfc(new TextEncoder().encode(text));
  let mp = null;
  const v = window.__studio = V.createViewer(host, { onSelect: (x, info) => mp?.selected(x, info) });
  await v.load(URL.createObjectURL(new Blob([r.glb], { type: "model/gltf-binary" })));
  const toUrl = b => new Promise(res => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsDataURL(b); });
  window.__saved = [];
  mp = window.__panel = P.createMaterialsPanel({ root: panel, viewer: v, store: {
    load: async () => ({}), save: async () => {}, prefs: async () => ({}), savePrefs: () => {}, mine: async () => [],
    suggest: async blob => { window.__suggestBytes = blob.size; return { name: "Beige porcelain tile", cls: "tile", rough: 0.35, metal: 0, size_mm: 600, tile_mm: [300, 300], notes: "Square beige tiles with grey grout." }; },
    saveMaterial: async form => {
      const meta = JSON.parse(form.get("meta")), urls = {};
      for (const k of ["color", "normal", "rough", "ao", "original"]) if (form.get(k)) urls[k] = await toUrl(form.get(k));
      const m = { id: "my-" + crypto.randomUUID(), category: "My materials", ...meta, urls };
      window.__saved.push({ meta, sizes: Object.fromEntries(Object.entries(urls).map(([k, u]) => [k, u.length])) });
      return m;
    } } });
  await mp.load();
}, ifc);

// 1. the dialog, the photo and its corners
await page.click("#mpPhoto");
await page.waitForSelector("dialog.photo-dlg[open]");
await page.setInputFiles("#pdFile", photoPath);
await page.waitForSelector(".pd-crop:not([hidden]) .pd-handle");
const k = await page.evaluate(() => { const c = document.querySelector("#pdPhoto"); return c.width / 1200; });
for (let i = 0; i < 4; i++) {
  const h = page.locator(`.pd-handle[data-i="${i}"]`), b = await h.boundingBox(), r = await page.locator("#pdPhoto").boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
  await page.mouse.move(r.x + CORNERS[i][0] * k, r.y + CORNERS[i][1] * k, { steps: 6 }); await page.mouse.up();
}
const placed = await page.evaluate(() => [...document.querySelectorAll(".pd-handle")].map(h => [parseFloat(h.style.left), parseFloat(h.style.top)]));
check(placed.every((p, i) => Math.abs(p[0] - CORNERS[i][0] * k) < 3 && Math.abs(p[1] - CORNERS[i][1] * k) < 3), "the four corners are dragged onto the tiled area");

// 2. Ollic AI suggests; tile size
await page.click("#pdAsk");
await page.waitForFunction(() => document.querySelector("#pdAskMsg").textContent.startsWith("Suggested"));
check(await page.inputValue("#pdName") === "Beige porcelain tile" && await page.inputValue("#pdCls") === "tile" && await page.isChecked("input[name=pdMode][value=tile]"), "Ollic AI's suggestion fills the name, kind and tile size");
await page.fill("#pdTileW", "300"); await page.fill("#pdTileH", "300");

// 3. make it and check
await page.click("#pdMake");
await page.waitForSelector("#pdResult:not([hidden])", { timeout: 60000 });
const checks = await page.locator("#pdChecks li").allTextContents();
console.log("     " + checks.join("\n     "));
check(/difference (\d+\.\d)/.test(checks[0]) && +checks[0].match(/difference (\d+\.\d)/)[1] < 5, "the colour is the same as the photo (ΔE under 5)");
check(checks[1].startsWith("✓"), "it repeats with no visible join");
check(/now [0-2]%/.test(checks[2]), "the uneven light is gone");
check(/6 x 5 tiles of 300 x 300 mm: one repeat is 1800 x 1500 mm/.test(checks[3]), "6 x 5 whole tiles found: one repeat is 1.8 x 1.5 m");
await page.waitForTimeout(1500);
await page.locator("dialog.photo-dlg").screenshot({ path: join(OUT, "upload-dialog.png") });

// 4. save to My materials, then put it on a wall
await page.click("#pdSave");
await page.waitForSelector("dialog.photo-dlg", { state: "detached" });
const saved = await page.evaluate(() => window.__saved);
check(saved.length === 1 && saved[0].meta.tiles.join() === "6,5" && saved[0].meta.size === 1.8 && Object.keys(saved[0].sizes).length === 5, `saved with its five pictures (${JSON.stringify(saved[0]?.sizes)})`);
check(await page.locator(".mp-swatch[data-id^='my-']").count() === 1, "it is in My materials");
await page.evaluate(() => { document.getElementById("studioTest").scrollTop = 0; window.__studio.view("front"); });
await page.waitForTimeout(800);
const key = await page.evaluate(() => { const p = window.__studio.debugParts().find(p => p.tag === "S1"); window.__studio.select(p.key); return p.key; });
await page.click("#mpApply");
const part = await page.evaluate(k => window.__studio.partInfo(k), key);
check(part.spec.id.startsWith("my-") && part.how === "user", "the material from the photo is on the wall");
await page.waitForFunction(async () => (await import("./assets/materials/look.js")).texturesReady(), null, { timeout: 30000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: join(OUT, "upload-on-wall.png"), clip: { x: 0, y: 0, width: 800, height: 560 } });
check(!errors.length, `no page errors ${errors.join(" | ")}`);
await browser.close(); srv.close();
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log("\nMaterial from a photo: all passed");
