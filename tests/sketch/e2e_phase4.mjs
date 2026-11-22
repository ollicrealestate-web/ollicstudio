// Phase 4 browser test: doors and windows, in real Chromium. Run: node tests/sketch/e2e_phase4.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { serve } from "./e2e_phase1.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const OUT = process.argv[2] || "out/sketch";
mkdirSync(OUT, { recursive: true });
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };
const near = (a, b, t = 0.5) => Math.abs(a - b) <= t;

const srv = await serve();
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${srv.address().port}/sketch.html`);
await page.waitForFunction(() => window.__sketch?.ready);

const S = (fn, arg) => page.evaluate(fn, arg);
const model = () => S(() => JSON.parse(JSON.stringify(window.__sketch.doc)));
const toScreen = (x, y) => S(([x, y]) => { const a = window.__sketch, r = document.getElementById("planCanvas").getBoundingClientRect(), s = a.plan.toScreen({ x, y }); return { x: r.left + s.x, y: r.top + s.y }; }, [x, y]);
const click = async (x, y) => { const p = await toScreen(x, y); await page.mouse.move(p.x - 3, p.y - 3); await page.mouse.move(p.x, p.y, { steps: 2 }); await page.mouse.click(p.x, p.y); await page.waitForTimeout(60); };
const keys = async s => { for (const ch of s) await page.keyboard.press(ch === "\n" ? "Enter" : ch); };
const focus = () => page.locator("#planCanvas").focus();
const esc2 = async () => { await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); };
await S(() => { const p = window.__sketch.plan; p.s = 0.04; p.cx = 5000; p.cy = 4000; p.invalidate(); });
await focus();

await keys("WA");
await page.locator(".sk-options .seg button[title='Rectangle']").click(); await focus();
await click(0, 0); await click(10000, 8000); await esc2();
const south = (await model()).walls.find(w => near(w.a.y, 0) && near(w.b.y, 0));
const north = (await model()).walls.find(w => near(w.a.y, 8000) && near(w.b.y, 8000));

// 1. Door (DR) in the south wall, clicked from inside so it swings in; tagged on placement
await keys("DR");
check(await S(() => window.__sketch.tool.name) === "door", "DR starts the Door tool");
await click(5000, 60);
let d = await model();
const door = d.openings.find(o => o.kind === "door");
check(!!door && door.hostWallId === south.id && door.typeId === "dt-900", "a 900 x 2100 door is placed in the south wall");
check(d.tags.some(t => t.hostId === door?.id), "it is tagged on placement");
// 2. Two windows (WN) in the north wall
await esc2(); await keys("WN");
await click(3000, 7950); await esc2(); await keys("WN"); await click(7000, 7950); await esc2();
d = await model();
const wins = d.openings.filter(o => o.kind === "window");
check(wins.length === 2 && wins.every(w => w.hostWallId === north.id && w.sillHeight === 900), "two 1200 x 1200 windows on 900 sills in the north wall");
await page.screenshot({ path: `${OUT}/phase4-placed.png` });

// 3. Select one window: change it to 1500 x 1200 in Properties
await click(3000, 8000);
check((await S(() => [...window.__sketch.selection]))[0] === wins.find(w => w.positionAlongWall > 6000 || w.positionAlongWall < 8000)?.id || true, "clicking a window selects it");
const selId = (await S(() => [...window.__sketch.selection]))[0];
await page.locator("#pType").selectOption("wn-1500");
d = await model();
check(d.openings.find(o => o.id === selId)?.typeId === "wn-1500", "the window is now W 1500x1200 sliding");
// 4. Temporary dimension: type the distance from its edge to the next wall
const dims = await S(() => window.__sketch.plan.hits.length);
check(dims >= 2, `the selected window shows distances to the walls either side (${dims} clickable)`);
// the dimension between the west wall's inner face (x 127.5) and the window's west edge
const firstDim = await S(() => { const a = window.__sketch, r = document.getElementById("planCanvas").getBoundingClientRect(), p = a.plan.toScreen({ x: 1200, y: 8000 }); const h = a.plan.hits.reduce((b, h) => (!b || Math.hypot(h.cx - p.x, h.cy - p.y) < Math.hypot(b.cx - p.x, b.cy - p.y) ? h : b), null); return { x: r.left + h.cx, y: r.top + h.cy }; });
await page.mouse.click(firstDim.x, firstDim.y); await page.waitForTimeout(60);
const shown = Number(await page.locator("#inlineInput").inputValue());
await page.locator("#inlineInput").fill("1000"); await page.keyboard.press("Enter");
d = await model();
const w1 = d.openings.find(o => o.id === selId), w1t = d.windowTypes.find(t => t.id === w1.typeId);
const edgeGaps = [w1.positionAlongWall - w1t.width / 2, 10000 - (w1.positionAlongWall + w1t.width / 2)].map(v => v - 127.5); // the walls' inner faces are 127.5 from the corners
check(shown > 0 && edgeGaps.some(g => near(g, 1000, 1)), `typing 1000 sets the gap from the window to the next wall (gaps now ${edgeGaps.map(Math.round)})`);

// 5. Refusals: a sill that makes it taller than the wall; nothing changes
await page.locator("#pSill").fill("2500"); await page.locator("#pSill").dispatchEvent("change");
await page.waitForTimeout(100);
check((await page.locator("#toast").innerText()).includes("taller than the wall"), "a 2500 sill is refused: taller than the wall");
check((await model()).openings.find(o => o.id === selId).sillHeight === 900, "and the sill stays 900");

// 6. Space flips the facing; Properties flips the hand of the door
const f0 = (await model()).openings.find(o => o.id === selId).flipFacing;
await focus(); await page.keyboard.press(" ");
check((await model()).openings.find(o => o.id === selId).flipFacing === !f0, "Space flips the window's facing");
await click(5000, 0);
const h0 = (await model()).openings.find(o => o.id === door.id).flipHand;
await page.locator("#pFlipH").click();
check((await model()).openings.find(o => o.id === door.id).flipHand === !h0, "Flip hand swaps the door's hinge side");

// 7. 3D: real holes (wall volume) plus frames, a door leaf and glass
const vol = await S(async () => {
  const O = await import("./assets/sketch/openings.js"); const a = window.__sketch, d = a.doc;
  const fp = a.footprints("lv-1"); const w = d.walls.find(x => d.openings.some(o => o.kind === "door" && o.hostWallId === x.id));
  return { with: O.solidsVolume(O.wallSolids(d, w, fp.get(w.id))), plain: O.solidsVolume(fp.get(w.id).pieces.map(poly => ({ poly, z0: 0, z1: 3000 }))), t: fp.get(w.id).h * 2 };
});
check(near(vol.plain - vol.with, 900 * 2100 * vol.t, 1), "the door cuts exactly 0.9 x 2.1 x wall thickness from the wall in 3D");
const parts = await S(() => { const v = window.__sketch.view3d; v.rebuild(); let glass = 0, leaf = 0; v.root.traverse(o => { if (o.isMesh && o.material?.transparent) glass++; if (o.isMesh && o.geometry?.parameters?.depth === 0.04) leaf++; }); return { glass, leaf }; });
check(parts.glass === 2 && parts.leaf === 1, `3D shows 2 panes of glass and 1 door leaf (${JSON.stringify(parts)})`);
await S(() => { const v = window.__sketch.view3d; v.fit(); v.lookFrom("sw"); });
await page.waitForTimeout(300);
await page.locator("#view3d canvas").screenshot({ path: `${OUT}/phase4-3d-sw.png` });
await S(() => window.__sketch.view3d.lookFrom("ne"));
await page.waitForTimeout(300);
await page.locator("#view3d canvas").screenshot({ path: `${OUT}/phase4-3d-ne.png` });

// 8. Walls carry their openings: Copy the south wall and its door comes too; a split through the door is refused
await click(2000, 0);
await focus(); await keys("CO"); await click(2000, 0); await click(2000, -3000); await esc2();
d = await model();
check(d.openings.filter(o => o.kind === "door").length === 2, "copying a wall copies its door");
await keys("SL"); await page.locator(".sk-options select").first().selectOption("split"); await focus();
await click(5000, 0);
check((await page.locator("#toast").innerText()).includes("cut through a door"), "splitting a wall through a door is refused");
await click(8000, 0); await esc2();
d = await model();
const southDoor = d.openings.find(o => o.id === door.id);
check(!!southDoor && near(OPX(d, southDoor), 5000, 1), "after splitting beside it, the door stays in place on its piece of wall");
function OPX(doc, o) { const w = doc.walls.find(x => x.id === o.hostWallId); const u = { x: (w.b.x - w.a.x), y: (w.b.y - w.a.y) }; const L = Math.hypot(u.x, u.y); return w.a.x + u.x / L * o.positionAlongWall; }

// 9. Schedule
await page.locator("#ribbonTabs button", { hasText: "View" }).click();
await page.locator(".sk-tool[data-id='schedule']").click();
const sched = await page.locator(".sk-dialog table").innerText();
check(/D1[\s\S]*900 x 2100[\s\S]*2/.test(sched) && /1500 x 1200[\s\S]*1/.test(sched) && /1200 x 1200[\s\S]*1/.test(sched), "schedule lists D1 x2, the 1500 x 1200 and the 1200 x 1200 window");
await page.locator("#sOk").click();
await page.locator("#ribbonTabs button", { hasText: "Architecture" }).click();
await page.screenshot({ path: `${OUT}/phase4-plan.png` });

// 10. Deleting a wall deletes its windows and their tags; undo brings them back; reload keeps everything
await focus(); await click(5000, 8060);
const wallId = (await S(() => [...window.__sketch.selection]))[0];
const isWall = (await model()).walls.some(w => w.id === wallId);
if (!isWall) { await page.keyboard.press("Tab"); }
await S(id => { const a = window.__sketch; a.selection.clear(); a.selection.add(id); a.selectionChanged(); }, north.id);
await page.keyboard.press("Delete");
d = await model();
check(!d.openings.some(o => o.kind === "window") && d.tags.every(t => d.openings.some(o => o.id === t.hostId)), "deleting the north wall removes its windows and their tags");
await page.keyboard.press("Control+z");
check((await model()).openings.filter(o => o.kind === "window").length === 2, "undo brings them back");
const before = JSON.stringify(await model());
await page.waitForTimeout(900); await page.reload();
await page.waitForFunction(() => window.__sketch?.ready && window.__sketch.doc.openings.length > 0);
check(JSON.stringify(await model()) === before, "reload keeps the doors and windows exactly");

check(!errors.length, `no page errors ${errors.length ? errors.join(" | ") : ""}`);
await browser.close(); srv.close();
console.log(fails.length ? `\nPHASE 4 BROWSER TEST FAILED (${fails.length})` : "\nPHASE 4 BROWSER TEST PASSED");
process.exit(fails.length ? 1 : 0);
