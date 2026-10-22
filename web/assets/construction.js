// Construction animation, drawn from the architect's IFC model in the browser.
// Order: site, foundation, then floor by floor (structure, then walls), doors and windows, roof,
// a fly-around, furniture (roof lifted), then the camera stands in each room.
// Everything is a pure function of time (frameAt), so the preview and the exported video match
// frame for frame. The settings ("script") are checked on the server too (backend/app/animation.py);
// the phase names, defaults and ranges here must stay the same as there.

export const PHASES = ["site", "foundation", "structure", "walls", "openings", "roof", "orbit", "furnish", "interior"];
export const DEFAULT_SECONDS = { site: 3, foundation: 4, structure: 4, walls: 3, openings: 3, roof: 4, orbit: 8, furnish: 4, interior: 4 };
export const LIMITS = { site: [1, 12], foundation: [1, 15], structure: [1, 15], walls: [1, 15], openings: [1, 12], roof: [1, 15], orbit: [2, 30], furnish: [1, 15], interior: [2, 15] };
export const PHASE_LABEL = { site: "Site", foundation: "Foundation", structure: "Structure", walls: "Walls", openings: "Doors and windows", roof: "Roof",
  orbit: "Completed building", furnish: "Furniture", interior: "Inside" };

export function defaultScript() {
  return { version: 1, style: "luxury", heroes: 2, look: "", phases: Object.fromEntries(PHASES.map(p => [p, { on: true, seconds: DEFAULT_SECONDS[p] }])), rooms: [], time_of_day: "midday",
    direction: "anticlockwise", hide: [], renders: true, render_seconds: 4, captions: true, title: "", subtitle: "", format: "16:9" };
}

/** Same rules as the server: unknown phases dropped, missing ones filled, numbers brought into range. */
export function normalise(s) {
  const d = defaultScript(), out = { ...d, ...(s || {}) };
  out.phases = {};
  for (const p of PHASES) {
    const v = (s?.phases || {})[p] || {};
    const [lo, hi] = LIMITS[p];
    out.phases[p] = { on: v.on !== false, seconds: Math.round(Math.min(hi, Math.max(lo, Number(v.seconds ?? DEFAULT_SECONDS[p]) || DEFAULT_SECONDS[p])) * 100) / 100 };
  }
  out.render_seconds = Math.min(10, Math.max(2.5, Number(out.render_seconds) || 4));
  out.rooms = Array.isArray(out.rooms) ? out.rooms : [];
  out.hide = Array.isArray(out.hide) ? out.hide : [];
  out.style = out.style === "technical" ? "technical" : "luxury";
  out.heroes = Math.min(3, Math.max(1, Math.round(Number(out.heroes) || 2)));
  out.look = String(out.look || "").split(/\s+/).join(" ").trim().slice(0, 400);
  return out;
}

const FOUNDATION = new Set(["IfcFooting", "IfcPile", "IfcFoundation"]);
const STRUCTURE = new Set(["IfcColumn", "IfcBeam", "IfcMember", "IfcPlate", "IfcSlab", "IfcStair", "IfcStairFlight", "IfcRamp", "IfcRampFlight"]);
const OPENINGS = new Set(["IfcDoor", "IfcWindow"]);
const FURNITURE = new Set(["IfcFurniture", "IfcFurnishingElement", "IfcSystemFurnitureElement", "IfcSanitaryTerminal", "IfcLightFixture"]);
const RANK = { IfcColumn: 0, IfcMember: 1, IfcBeam: 1, IfcPlate: 2, IfcSlab: 2, IfcStair: 3, IfcStairFlight: 3, IfcRamp: 3, IfcRampFlight: 3 };
const HIDE_GROUPS = {
  furniture: t => FURNITURE.has(t), stairs: t => /^IfcStair|^IfcRamp/.test(t), beams: t => t === "IfcBeam", columns: t => t === "IfcColumn",
  footings: t => t === "IfcFooting" || t === "IfcPile", doors: t => t === "IfcDoor", windows: t => t === "IfcWindow", railings: t => t === "IfcRailing",
};
const LIGHT = {
  morning: { sky: "#cfdbe6", hemi: ["#eef3ff", "#6b6256", 1.2], sun: ["#ffe9cc", 2.0], az: 0.9, el: 0.35 },
  midday: { sky: "#c9d3dc", hemi: ["#eef3ff", "#6b6256", 1.25], sun: ["#fff4e0", 2.4], az: 0.6, el: 1.05 },
  "golden hour": { sky: "#e8c9a0", hemi: ["#ffe2bd", "#5a4a3c", 1.0], sun: ["#ffb265", 2.6], az: -0.9, el: 0.22 },
  dusk: { sky: "#5d6a8a", hemi: ["#9aa8d8", "#3a3340", 0.75], sun: ["#ff9a6b", 1.1], az: -1.2, el: 0.08 },
};

const clamp01 = x => Math.max(0, Math.min(1, x));
const easeOut = x => 1 - Math.pow(1 - clamp01(x), 3);
const easeInOut = x => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const lerp = (a, b, k) => a + (b - a) * k;

/**
 * ctx: viewer.engine(). script: animation settings. Returns the animation:
 * { duration, segments, frameAt(t), labelAt(t), rooms, context(), renderFrame(t, w, h), dispose() }
 */
export function createConstruction(ctx, script, extras = {}) {
  const { THREE, scene, camera, ground, sun, hemi } = ctx;
  script = normalise(script);
  const P = script.phases;
  const groundY = ctx.groundY;
  const storeys = ctx.storeys.slice();
  const hiddenBy = script.hide.map(h => HIDE_GROUPS[h]).filter(Boolean);
  const luxury = script.style === "luxury" && !!extras.lux;     // the night, gold-wireframe and photoreal-reveal look
  const heroImages = extras.heroImages || [];

  // ---------------------------------------------------------------- the elements and their groups
  const items = [];
  const storeyLow = {};
  for (const mesh of ctx.elements) {
    const u = mesh.userData, t = u.ifcType || "";
    if (t === "IfcSpace") continue;
    const box = new THREE.Box3().setFromObject(mesh);
    const it = { mesh, t, u, box, p0: mesh.position.clone(), s0: mesh.scale.clone(), base: box.min.y, top: box.max.y, centre: box.getCenter(new THREE.Vector3()), hidden: hiddenBy.some(f => f(t)) };
    it.group = groupOf(it);
    items.push(it);
    if (u.storey && it.group !== "foundation" && it.group !== "roof") storeyLow[u.storey] = Math.min(storeyLow[u.storey] ?? Infinity, it.base);
  }
  function groupOf(it) {
    const { t } = it, p = it.u.predefined || "";
    if (FOUNDATION.has(t) || (t === "IfcSlab" && p === "BASESLAB")) return "foundation";
    if (t === "IfcRoof" || (t === "IfcSlab" && p === "ROOF") || (t === "IfcCovering" && p === "ROOFING") || /roof/i.test(it.u.storey || "")) return "roof";
    if (OPENINGS.has(t)) return "openings";
    if (FURNITURE.has(t)) return "furnish";
    if (t === "IfcSite" || t === "IfcGeographicElement") return "site";
    if (STRUCTURE.has(t)) return "structure";
    return "walls";
  }
  // ground-level slabs without a type are part of the foundation
  for (const it of items) if (it.t === "IfcSlab" && it.group === "structure" && it.top <= groundY + 0.06) it.group = "foundation";
  // each element's floor: its storey, or the storey whose floor is just below it
  const floorNames = storeys.filter(s => storeyLow[s] !== undefined);
  for (const it of items) {
    let i = floorNames.indexOf(it.u.storey);
    if (i < 0) { i = 0; floorNames.forEach((s, k) => { if (storeyLow[s] <= it.base + 0.05) i = k; }); }
    it.floor = i;
  }

  // model size, for the camera
  const all = new THREE.Box3();
  items.forEach(it => all.union(it.box));
  if (all.isEmpty()) all.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 5, 5));
  const centre = all.getCenter(new THREE.Vector3()), size = all.getSize(new THREE.Vector3());
  const radius = Math.max(4, size.length() / 2);

  // rooms to visit
  const allRooms = ctx.elements.filter(m => m.userData.ifcType === "IfcSpace").map(m => {
    const b = new THREE.Box3().setFromObject(m);
    return { name: m.userData.name || "Room", storey: m.userData.storey || null, box: b };
  }).sort((a, b) => (storeys.indexOf(a.storey) - storeys.indexOf(b.storey)) || a.name.localeCompare(b.name));
  let visit = allRooms;
  if (script.rooms.length) {
    const want = script.rooms.map(r => r.toLowerCase());
    visit = want.map(w => allRooms.find(r => r.name.toLowerCase() === w)).filter(Boolean);
  }

  // ---------------------------------------------------------------- the timeline
  const segments = [];
  let clock = 0;
  const sweep = it => it.centre.x + it.centre.z;  // build from one corner across to the other
  function schedule(list, start, seconds, style, order) {
    list.sort(order || ((a, b) => sweep(a) - sweep(b)));
    const n = list.length;
    const dur = seconds > 0 ? Math.min(1.2, Math.max(0.35, seconds * 0.35)) : 0;
    list.forEach((it, i) => {
      it.start = start + (n > 1 ? (seconds - dur) * i / (n - 1) : 0);
      it.dur = dur; it.style = style(it);
    });
  }
  function segment(phase, seconds, label, extra = {}) {
    const on = P[phase].on;
    const s = { phase, label, start: clock, end: clock + (on ? seconds : 0), ...extra };
    segments.push(s);
    clock = s.end;
    return s;
  }
  const pick = (g, f) => items.filter(it => it.group === g && (!f || f(it)));

  segment("site", P.site.seconds, "Site");
  const fnd = segment("foundation", P.foundation.seconds, "Foundation");
  schedule(pick("foundation").concat(pick("site")), fnd.start, fnd.end - fnd.start, () => "rise");
  floorNames.forEach((name, k) => {
    const st = pick("structure", it => it.floor === k), wl = pick("walls", it => it.floor === k);
    if (st.length) {
      const s = segment("structure", P.structure.seconds, `${name} · structure`, { floor: k });
      schedule(st, s.start, s.end - s.start, it => (it.t === "IfcColumn" ? "grow" : /Stair|Ramp/.test(it.t) ? "grow" : "drop"),
        (a, b) => ((RANK[a.t] ?? 2) - (RANK[b.t] ?? 2)) || sweep(a) - sweep(b));
    }
    if (wl.length) {
      const s = segment("walls", P.walls.seconds, `${name} · walls`, { floor: k });
      schedule(wl, s.start, s.end - s.start, () => "grow");
    }
  });
  // anything on a floor the loop did not reach (no storeys in the file)
  const unplaced = items.filter(it => (it.group === "structure" || it.group === "walls") && it.start === undefined);
  if (unplaced.length) { const s = segment("walls", P.walls.seconds, "Walls"); schedule(unplaced, s.start, s.end - s.start, () => "grow"); }
  const op = pick("openings");
  if (op.length) { const s = segment("openings", P.openings.seconds, "Doors and windows"); schedule(op, s.start, s.end - s.start, () => "pop", (a, b) => (a.floor - b.floor) || sweep(a) - sweep(b)); }
  const rf = pick("roof");
  if (rf.length) { const s = segment("roof", P.roof.seconds, "Roof"); schedule(rf, s.start, s.end - s.start, () => "drop", (a, b) => (a.base - b.base) || sweep(a) - sweep(b)); }
  const buildEnd = clock;
  const reveals = [];
  if (luxury) for (let k = 0; k < script.heroes; k++) reveals.push(segment("orbit", P.orbit.seconds, "Completed building", { hero: k }));
  const orbit = luxury ? (reveals[0] || segment("orbit", 0, "")) : segment("orbit", P.orbit.seconds, "Completed building");
  const furn = pick("furnish").filter(it => !it.hidden);
  const furnFloors = [...new Set(furn.map(it => it.floor))].sort((a, b) => a - b);
  const furnSegs = [];
  if (luxury) {
    furn.forEach(it => { it.start = Math.max(0, buildEnd - 0.8); it.dur = 0.6; it.style = "drop"; });
  } else if (furn.length && P.furnish.on) {
    const each = P.furnish.seconds / Math.max(1, furnFloors.length);
    for (const k of furnFloors) {
      const s = segment("furnish", each, `Furniture · ${floorNames[k] || "ground floor"}`, { floor: k });
      schedule(furn.filter(it => it.floor === k), s.start, s.end - s.start, () => "drop");
      furnSegs.push(s);
    }
  } else {
    furn.forEach(it => { it.start = orbit.end; it.dur = 0; it.style = "drop"; });
  }
  const roomSegs = [];
  if (P.interior.on && !luxury) for (const r of visit) roomSegs.push(segment("interior", P.interior.seconds, r.name, { room: r }));
  const duration = Math.max(clock, 0.5);
  // elements of switched-off phases (zero-length windows) simply appear
  for (const it of items) if (it.start === undefined) { it.start = 0; it.dur = 0; it.style = "grow"; }

  // ---------------------------------------------------------------- look and light
  const L = LIGHT[script.time_of_day] || LIGHT.midday;
  const saved = { bg: scene.background, fog: scene.fog, hemi: [hemi.color.clone(), hemi.groundColor.clone(), hemi.intensity], sun: [sun.color.clone(), sun.intensity, sun.position.clone()],
    groundY: ground.position.y, groundMat: { transparent: ground.material.transparent, opacity: ground.material.opacity }, fov: camera.fov, near: camera.near, far: camera.far };
  scene.background = new THREE.Color(L.sky); scene.fog = new THREE.Fog(L.sky, radius * 6, radius * 18);
  hemi.color.set(L.hemi[0]); hemi.groundColor.set(L.hemi[1]); hemi.intensity = L.hemi[2];
  sun.color.set(L.sun[0]); sun.intensity = L.sun[1];
  const sr = radius * 2.2;
  sun.position.set(centre.x + Math.cos(L.az) * Math.cos(L.el) * sr, centre.y + Math.sin(L.el) * sr + 2, centre.z + Math.sin(L.az) * Math.cos(L.el) * sr);
  sun.target.position.copy(centre);
  ground.material.transparent = true;
  // setting-out lines on the plot during "site"
  const footprint = new THREE.Box3(); items.filter(it => it.group !== "site").forEach(it => footprint.union(it.box));
  const pad = 0.6, fy = groundY + 0.03;
  const corners = [[footprint.min.x - pad, footprint.min.z - pad], [footprint.max.x + pad, footprint.min.z - pad], [footprint.max.x + pad, footprint.max.z + pad], [footprint.min.x - pad, footprint.max.z + pad]];
  const linePts = corners.concat([corners[0]]).map(([x, z]) => new THREE.Vector3(x, fy, z));
  const setout = new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePts), new THREE.LineBasicMaterial({ color: "#d42127" }));
  setout.geometry.setDrawRange(0, 0);
  scene.add(setout);
  const pegs = new THREE.Group();
  for (const [x, z] of corners) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.6), new THREE.MeshStandardMaterial({ color: "#d42127" })); p.position.set(x, groundY + 0.3, z); pegs.add(p); }
  scene.add(pegs);
  // black fade in front of the camera, for cuts between rooms
  const fade = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial({ color: "#000", transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
  fade.position.z = -0.12; fade.renderOrder = 9999;
  camera.add(fade);
  if (!camera.parent) scene.add(camera);

  // ---------------------------------------------------------------- one frame
  const sign = script.direction === "clockwise" ? -1 : 1;
  const theta0 = Math.PI * 0.25;
  const buildSpin = Math.min(Math.PI * 1.2, 0.22 * Math.max(buildEnd, 1));   // slow: at most 0.22 rad a second
  const orbitSpin = Math.min(Math.PI * 2, 0.55 * Math.max(orbit.end - orbit.start, 1));
  const eye = 1.6;
  let litInside = false;

  function fitDistance() {
    const vfov = THREE.MathUtils.degToRad(45), hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    return radius / Math.sin(Math.min(vfov, hfov) / 2) * 0.95;
  }
  function orbitPose(theta, elev, dist, ty) {
    return { pos: new THREE.Vector3(centre.x + Math.cos(theta) * Math.cos(elev) * dist, ty + Math.sin(elev) * dist, centre.z + Math.sin(theta) * Math.cos(elev) * dist),
      target: new THREE.Vector3(centre.x, ty, centre.z), fov: 45 };
  }
  function exteriorPose(t) {
    const d = fitDistance();
    if (t <= buildEnd) {
      const k = buildEnd > 0 ? t / buildEnd : 1;
      const built = lerp(groundY + 1, centre.y, easeInOut(k));
      if (luxury) return orbitPose(theta0 + sign * buildSpin * k, lerp(0.55, 0.14, easeInOut(k)), d * lerp(1.2, 0.98, k), built);
      return orbitPose(theta0 + sign * buildSpin * k, lerp(0.85, 0.42, easeInOut(k)), d * lerp(1.12, 1.0, k), built);
    }
    const k = orbit.end > orbit.start ? clamp01((t - orbit.start) / (orbit.end - orbit.start)) : 1;
    return orbitPose(theta0 + sign * (buildSpin + orbitSpin * easeInOut(k)), 0.42 - 0.2 * Math.sin(Math.PI * k), d * lerp(1.0, 0.92, Math.sin(Math.PI * k)), centre.y);
  }
  function furnishPose(t, s) {
    const d = fitDistance();
    const k = clamp01((t - s.start) / Math.max(0.01, s.end - s.start));
    const floorY = floorNames[s.floor] !== undefined ? storeyLow[floorNames[s.floor]] : groundY;
    return orbitPose(theta0 + sign * (buildSpin + orbitSpin + 0.35 * k), 1.0, d * 0.8, floorY + 1);
  }
  function roomPose(t, s) {
    const b = s.room.box, c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
    const alongX = sz.x >= sz.z, long = alongX ? sz.x : sz.z;
    const k = clamp01((t - s.start) / Math.max(0.01, s.end - s.start));
    const back = alongX ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const pos = new THREE.Vector3(c.x, b.min.y + eye, c.z).addScaledVector(back, long * lerp(0.34, 0.24, easeInOut(k)));
    const yaw = (alongX ? -Math.PI / 2 : 0) + sign * lerp(-0.32, 0.32, easeInOut(k));
    const dir = new THREE.Vector3(-Math.sin(yaw), -0.06, -Math.cos(yaw));
    return { pos, target: pos.clone().add(dir), fov: 70 };
  }
  // hero views for the photoreal reveal: low, looking up at the building, from different corners
  const HERO_ANGLES = [0, 1.75, -1.6];
  function heroPose(k, aspect = camera.aspect) {
    const fov = 40, vf = THREE.MathUtils.degToRad(fov), hf = 2 * Math.atan(Math.tan(vf / 2) * aspect);
    const d = radius / Math.sin(Math.min(vf, hf) / 2) * 0.86;
    const theta = theta0 + sign * (buildSpin + HERO_ANGLES[k % 3]);
    const eyeY = groundY + Math.max(1.6, size.y * 0.06);
    const flat = Math.sqrt(Math.max(1, d * d - Math.pow(centre.y - eyeY, 2)));
    const pos = new THREE.Vector3(centre.x + Math.cos(theta) * flat, eyeY, centre.z + Math.sin(theta) * flat);
    return { pos, target: new THREE.Vector3(centre.x, lerp(centre.y, all.max.y, 0.15), centre.z), fov };
  }
  function blend(a, b, k) {
    k = easeInOut(k);
    return { pos: a.pos.clone().lerp(b.pos, k), target: a.target.clone().lerp(b.target, k), fov: lerp(a.fov, b.fov, k) };
  }

  function segmentAt(t) {
    let cur = null;
    for (const s of segments) if (s.end > s.start && t >= s.start) cur = s;
    return cur;
  }

  function placeElement(it, t) {
    const m = it.mesh;
    if (it.hidden) { m.visible = false; return; }
    if (t < it.start) { m.visible = false; return; }
    m.visible = true;
    const k = it.dur > 0 ? clamp01((t - it.start) / it.dur) : 1;
    if (k >= 1) { m.scale.copy(it.s0); m.position.copy(it.p0); return; }
    const e = easeOut(k);
    const h = Math.max(0.05, it.top - it.base);
    if (it.style === "grow") {             // rises from its base, like a wall being built up
      m.scale.set(1, Math.max(0.001, e), 1); m.position.set(0, it.base * (1 - e), 0);
    } else if (it.style === "rise") {      // comes up out of the ground
      m.scale.set(1, 1, 1); m.position.set(0, -(h + 0.3) * (1 - e), 0);
    } else if (it.style === "pop") {       // doors and windows: set into the opening
      const s = lerp(0.4, 1, e);
      m.scale.set(s, s, s); m.position.copy(it.centre).multiplyScalar(1 - s);
    } else {                               // drop: lowered into place
      const s = lerp(0.9, 1, e), off = (it.group === "roof" ? 3.5 : 1.6) * (1 - e);
      m.scale.set(s, s, s); m.position.copy(it.centre).multiplyScalar(1 - s); m.position.y += off;
    }
  }

  function frameAt(t) {
    t = Math.max(0, Math.min(duration, t));
    for (const it of items) placeElement(it, t);
    const seg = segmentAt(t);
    // furniture: lift the roof and the floors above, so the rooms can be seen from above
    if (seg && seg.phase === "furnish") {
      for (const it of items) if (it.mesh.visible && (it.group === "roof" || it.floor > seg.floor)) it.mesh.visible = false;
    }
    // site: setting-out lines draw themselves; the ground is see-through while the foundations go in
    const siteK = P.site.on && segments[0].end > 0 ? clamp01(t / segments[0].end) : 1;
    setout.geometry.setDrawRange(0, Math.max(0, Math.floor(siteK * 5) + 1));
    setout.visible = pegs.visible = t < fnd.end + 0.5;
    const fK = fnd.end > fnd.start ? clamp01((t - fnd.start) / (fnd.end - fnd.start)) : 1;
    ground.material.opacity = t < fnd.start ? 1 : t < fnd.end ? lerp(1, 0.55, Math.sin(Math.PI * fK)) : 1;
    ground.position.y = groundY - 0.02;

    // camera
    let pose, black = 0;
    if (seg && seg.phase === "interior") {
      pose = roomPose(t, seg);
      const into = t - seg.start, left = seg.end - t;
      black = Math.max(0, 1 - into / 0.35, 1 - left / 0.35);
    } else if (luxury && seg && seg.hero !== undefined) {
      pose = heroPose(seg.hero);
      black = Math.max(0, 1 - (t - seg.start) / 0.3);
    } else if (seg && seg.phase === "furnish") {
      const prev = exteriorPose(orbit.end);
      pose = seg === furnSegs[0] && t - seg.start < 1.2 ? blend(prev, furnishPose(t, seg), (t - seg.start) / 1.2) : furnishPose(t, seg);
    } else {
      pose = exteriorPose(t);
    }
    if (roomSegs.length && t >= roomSegs[0].start - 0.35 && t < roomSegs[0].start) black = Math.max(black, (t - (roomSegs[0].start - 0.35)) / 0.35);
    // inside a room, light comes from everywhere (as with ceiling lights), so ceilings are not black
    const inside = !!(seg && seg.phase === "interior");
    if (inside !== litInside) {
      litInside = inside;
      if (inside) { hemi.color.set("#fff6ea"); hemi.groundColor.set("#e9e1d4"); hemi.intensity = 2.3; }
      else { hemi.color.set(L.hemi[0]); hemi.groundColor.set(L.hemi[1]); hemi.intensity = L.hemi[2]; }
    }
    camera.position.copy(pose.pos);
    camera.fov = pose.fov; camera.near = pose.fov > 60 ? 0.05 : Math.max(0.05, radius / 400); camera.far = radius * 40;
    camera.updateProjectionMatrix();
    camera.lookAt(pose.target);
    fade.material.opacity = clamp01(black);
    fade.visible = !luxury && black > 0.001;
    if (luxury) {
      setout.visible = pegs.visible = false;
      const u = seg && seg.hero !== undefined ? clamp01((t - seg.start) / Math.max(0.01, seg.end - seg.start)) : null;
      const image = u !== null ? heroImages[seg.hero] || null : null;
      luxState = {
        setK: siteK, black,
        gridOpacity: t < segments[0].end ? 0.9 : lerp(0.9, 0.22, clamp01((t - segments[0].end) / Math.max(1, buildEnd - segments[0].end))),
        reveal: u === null ? null : { h: lerp(groundY - 0.3, all.max.y + 0.5, easeInOut(clamp01(u / 0.62))), image,
          groundK: clamp01(u / 0.15), skyK: image ? clamp01((u - 0.62) / 0.16) : 0, zoom: 1 + 0.06 * u },
      };
    }
  }

  let luxState = null, lux = null;
  if (luxury) lux = extras.lux.createLuxury(ctx, items.filter(it => !it.hidden), { centre, radius, groundY, footprint: all.clone().expandByScalar(0) });
  function draw() { if (lux && luxState) lux.render(luxState); else ctx.render(); }

  /** The finished building from hero view k, without lines, at w x h, for the AI to make photoreal. */
  function heroSnapshot(k, w, h) {
    const r = ctx.renderer;
    r.setPixelRatio(1); r.setSize(w, h, false);
    frameAt(duration);
    const frameAspect = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1 }[script.format] || 16 / 9, imgAspect = w / h;
    const pose = heroPose(k, frameAspect);
    // the video frame must be a centred crop of the AI image: same width of view, taller (or the reverse)
    let fov = pose.fov;
    if (imgAspect < frameAspect) fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * frameAspect / imgAspect));
    camera.aspect = imgAspect; camera.fov = fov; camera.updateProjectionMatrix();
    camera.position.copy(pose.pos); camera.lookAt(pose.target);
    if (lux) lux.renderSolid(); else ctx.render();
    return r.domElement;
  }
  /** The glowing gold wireframe from hero view k (the start frame of a cinematic clip), same camera as heroSnapshot. */
  function heroWireSnapshot(k, w, h) {
    if (!lux) return heroSnapshot(k, w, h);
    const r = ctx.renderer;
    r.setPixelRatio(1); r.setSize(w, h, false);
    frameAt(duration);
    const frameAspect = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1 }[script.format] || 16 / 9, imgAspect = w / h;
    const pose = heroPose(k, frameAspect);
    let fov = pose.fov;
    if (imgAspect < frameAspect) fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * frameAspect / imgAspect));
    camera.aspect = imgAspect; camera.fov = fov; camera.updateProjectionMatrix();
    camera.position.copy(pose.pos); camera.lookAt(pose.target);
    lux.render({ setK: 1, gridOpacity: 0.3, reveal: null, black: 0 });
    return r.domElement;
  }
  /** Identifies a hero view: the same model, view and format give the same key, so its AI render can be reused. */
  function heroKey(k) {
    const fa = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1 }[script.format] || 16 / 9;
    const p = heroPose(k, fa), raw = [script.format, k, ...p.pos.toArray(), ...p.target.toArray(), ctx.elements.length].map(v => typeof v === "number" ? v.toFixed(2) : v).join("|");
    let h = 2166136261; for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 16777619); }
    return `hv${(h >>> 0).toString(36)}${k}`;
  }

  function tagAt(t) {
    const sg = segmentAt(Math.min(t, duration - 1e-3));
    return luxury && sg && sg.hero !== undefined && heroImages[sg.hero] && t - sg.start > 0.15 * (sg.end - sg.start) ? "AI concept — not to scale" : "Indicative sequence — not to scale";
  }
  function labelAt(t) { const s = segmentAt(Math.min(t, duration - 1e-3)); return s ? s.label : ""; }

  /** Draws time t at w x h for export, and returns the canvas. */
  function renderFrame(t, w, h) {
    const r = ctx.renderer;
    if (r.domElement.width !== w || r.domElement.height !== h) { r.setPixelRatio(1); r.setSize(w, h, false); camera.aspect = w / h; }
    frameAt(t); draw();
    return r.domElement;
  }

  function context() {
    const has = new Set();
    for (const it of items) {
      if (it.group === "foundation") has.add("footings or ground slab");
      if (it.t === "IfcColumn") has.add("columns"); if (it.t === "IfcBeam") has.add("beams"); if (/Stair|Ramp/.test(it.t)) has.add("stairs");
      if (it.t === "IfcDoor") has.add("doors"); if (it.t === "IfcWindow") has.add("windows"); if (it.group === "roof") has.add("roof");
      if (it.group === "furnish") has.add("furniture"); if (it.t === "IfcRailing") has.add("railings");
    }
    return { rooms: allRooms.map(r => r.name), floors: Math.max(1, floorNames.length), has: [...has] };
  }

  function dispose() {
    if (lux) { lux.dispose(); lux = null; }
    for (const it of items) { it.mesh.scale.copy(it.s0); it.mesh.position.copy(it.p0); it.mesh.visible = true; }
    scene.remove(setout, pegs); setout.geometry.dispose(); camera.remove(fade);
    scene.background = saved.bg; scene.fog = saved.fog;
    hemi.color.copy(saved.hemi[0]); hemi.groundColor.copy(saved.hemi[1]); hemi.intensity = saved.hemi[2];
    sun.color.copy(saved.sun[0]); sun.intensity = saved.sun[1]; sun.position.copy(saved.sun[2]);
    ground.position.y = saved.groundY; ground.material.transparent = saved.groundMat.transparent; ground.material.opacity = saved.groundMat.opacity;
    camera.fov = saved.fov; camera.near = saved.near; camera.far = saved.far; camera.updateProjectionMatrix();
  }

  return { script, duration, segments: segments.filter(s => s.end > s.start), frameAt, labelAt, tagAt, renderFrame, draw, context, dispose, heroSnapshot, heroWireSnapshot, heroKey, luxury,
    rooms: allRooms.map(r => r.name), visiting: visit.map(r => r.name), counts: Object.fromEntries(["foundation", "structure", "walls", "openings", "roof", "furnish"].map(g => [g, items.filter(i => i.group === g).length])) };
}
