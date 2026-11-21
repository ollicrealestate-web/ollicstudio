// Opens the exported buyer tour in headless Chromium and uses it like a buyer would.
import { chromium } from "playwright";
const [file, outDir] = process.argv.slice(2);
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const fails = [];
for (const [name, vp] of [["desktop", { width: 1280, height: 720 }], ["phone", { width: 390, height: 844, isMobile: true, hasTouch: true }]]) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g/.test(m.text())) errors.push(m.text()); });
  await page.goto("file://" + (file.startsWith("/") ? file : process.cwd() + "/" + file));
  await page.waitForSelector("#load", { state: "detached", timeout: 90000 }).catch(() => fails.push(name + ": model did not load"));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/tour-${name}-dollhouse.png` });
  const st0 = await page.evaluate(() => window.__ollicTour && window.__ollicTour.state());
  console.log(name, "state", JSON.stringify(st0));
  if (!st0 || st0.meshes < 10) fails.push(name + ": too few meshes " + JSON.stringify(st0));
  if (!st0 || st0.hideable < 1) fails.push(name + ": roof/ceilings not found for dollhouse");
  await page.click("#tourBtn");
  // wait (up to 45 s) for the tour to leave the Entrance pause and walk on
  await page.waitForFunction(() => window.__ollicTour.state().tour.d > 0.5, null, { timeout: 45000, polling: 500 }).catch(() => {});
  await page.screenshot({ path: `${outDir}/tour-${name}-guided.png` });
  const card = await page.textContent("#card .n");
  const st1 = await page.evaluate(() => window.__ollicTour.state());
  console.log(name, "card", card, "tour", JSON.stringify(st1.tour));
  if (!st1.tour.active) fails.push(name + ": tour stopped early");
  if (!(st1.tour.d > 0.5)) fails.push(name + ": tour did not move");
  await page.evaluate(() => window.__ollicTour.setHour(20));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/tour-${name}-night.png` });
  await page.click("#walkBtn");
  if (name === "desktop") { await page.keyboard.down("w"); await page.waitForTimeout(1200); await page.keyboard.up("w"); }
  await page.screenshot({ path: `${outDir}/tour-${name}-walk.png` });
  if (errors.length) fails.push(name + ": page errors: " + errors.join(" | "));
  await page.close();
}
await browser.close();
console.log(fails.length ? "TOUR FAILED: " + fails.join("; ") : "TOUR PASSED");
process.exit(fails.length ? 1 : 0);
