// Camera angles: lens, straight vertical lines, height, angle from the front, framing and words, on plain numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { anglesOf, longAngle, solve, project, presetSettings, fromWords, describe, forOutput, PRESETS } from "../../web/assets/camera.js";

const BOX = { min: [-8, 0, -6], max: [8, 16, 6] };   // a 4-floor block: 16 m wide, 12 m deep, 16 m high
const ENV = { box: BOX, ground: 0, front: [0, 1], aspect: 1.5 };
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const corners = () => { const o = []; for (let i = 0; i < 8; i++) o.push([i & 1 ? 8 : -8, i & 2 ? 16 : 0, i & 4 ? 6 : -6]); return o; };

test("lens: 24 mm is 73.7 degrees across, 35 mm is 54.4", () => {
  close(longAngle(24), 73.7, 0.1, "24 mm"); close(longAngle(35), 54.4, 0.1, "35 mm");
  close(anglesOf(24, 1.5).h, 73.7, 0.1, "24 mm landscape across");
  close(anglesOf(24, 0.8).v, 73.7, 0.1, "24 mm portrait up");
});
test("eye-level front: 1.6 m up, square to the front, centred, straight verticals, fills 85% of the height", () => {
  const s = presetSettings("front-eye", 16), c = solve(s, ENV);
  close(c.position[1], 1.6, 0.01, "height"); close(c.position[0], 0, 1e-9, "centred across"); assert.ok(c.position[2] > 6, "in front");
  assert.equal(c.pitch, 0);
  const q = project(corners(), c), ys = q.map(p => p[1]);
  close((Math.max(...ys) - Math.min(...ys)) / 2, 0.85, 0.03, "share of the height");
  const xs = q.map(p => p[0]); close((Math.max(...xs) + Math.min(...xs)) / 2, 0, 0.02, "centred in the picture");
  // a vertical edge: top and bottom at the same place across (to well under a pixel at 1536 wide)
  for (const [x, z] of [[-8, 6], [8, 6]]) { const [a, b] = project([[x, 0, z], [x, 16, z]], c); assert.ok(Math.abs(a[0] - b[0]) * 768 < 1, "vertical edge stays vertical"); }
});
test("drone corner: 45 degrees off the front, about 1.35 x the building's height, 24 mm, straight verticals", () => {
  const s = presetSettings("drone-corner-right", 16), c = solve(s, ENV);
  close(c.position[1], 1.35 * 16, 0.01, "height");
  const az = Math.atan2(c.position[0], c.position[2]) * 180 / Math.PI; close(az, 45, 1, "angle from the front");
  assert.equal(c.lens, 24);
  for (const [x, z] of [[8, 6], [-8, 6], [8, -6]]) { const [a, b] = project([[x, 0, z], [x, 16, z]], c); assert.ok(Math.abs(a[0] - b[0]) * 768 < 1, "vertical edge stays vertical"); }
  const q = project(corners(), c); assert.ok(q.every(p => Math.abs(p[0]) <= 1.001 && Math.abs(p[1]) <= 1.001), "the whole building is in the picture");
});
test("the worm's eye view converges on purpose, and straightens when asked", () => {
  const conv = solve(presetSettings("hero-low", 16), ENV), [a, b] = project([[8, 0, 6], [8, 16, 6]], conv);
  assert.ok(Math.abs(a[0] - b[0]) * 768 > 5, "converging");
  const st = solve({ ...presetSettings("hero-low", 16), straight: true }, ENV), [c, d] = project([[8, 0, 6], [8, 16, 6]], st);
  assert.ok(Math.abs(c[0] - d[0]) * 768 < 1, "straightened");
});
test("presets follow the front", () => {
  const c = solve(presetSettings("front-eye", 16), { ...ENV, front: [1, 0] });
  assert.ok(c.position[0] > 8 && Math.abs(c.position[2]) < 1e-6, "the camera moves to the new front");
});
test("the same camera in a picture of another shape shows the same thing", () => {
  const c = solve(presetSettings("drone-corner-left", 16), ENV);
  for (const out of [16 / 9, 1, 0.8]) {
    const o = forOutput(c, out), cam2 = { ...c, v: o.v, h: 2 * Math.atan(Math.tan(o.v * Math.PI / 360) * out) * 180 / Math.PI, shift: o.shift };
    const q1 = project(corners(), c), q2 = project(corners(), cam2);
    // the set picture sits inside the other one: scale and positions agree
    const k = out > 1.5 ? [1.5 / out, 1] : [1, out / 1.5];
    q1.forEach((p, i) => { close(q2[i][0], p[0] * k[0], 1e-6, "across"); close(q2[i][1], p[1] * k[1], 1e-6, "up"); });
  }
});
test("words: the drone corner sentence and the front elevation", () => {
  const r = fromWords("elevated three-quarter corner view, low drone height, two-point perspective with vertical lines kept straight, 24 mm wide-angle lens, street intersection in foreground", 16);
  assert.ok(r.settings.preset.startsWith("drone-corner")); assert.equal(Math.abs(r.settings.azimuth), 45);
  assert.ok(r.settings.height >= 1.2 * 16 && r.settings.height <= 1.5 * 16); assert.equal(r.settings.lens, 24);
  assert.equal(r.settings.straight, true); assert.equal(r.settings.foreground, "street");
  const f = fromWords("Front elevation at eye level, 35 mm", 16);
  assert.equal(f.settings.preset, "front-eye"); assert.equal(f.settings.lens, 35); assert.equal(f.settings.height, 1.6);
  assert.match(describe(r.settings), /24 mm wide-angle lens.*two-point perspective with vertical lines kept perfectly straight.*street/);
  assert.ok(Object.keys(PRESETS).length >= 15);
});
