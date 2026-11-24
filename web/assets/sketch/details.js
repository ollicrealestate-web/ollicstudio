// Finishing details: cladding, edge sweeps (fascias, slab bands), railings, fins and louvres, canopies, pergolas,
// soffits, parapets, planters, steps and screens. Each is stored as its settings (`args`); its shape is always
// computed from the settings and the elements it is attached to, so it follows the model.
//
// A detail's shape is a list of parts: upright prisms { poly, z0, z1, mat } or sweeps { sweep: { rings, closed, prof }, mat }.
import * as G from "./geom.js";
import * as S from "./solids.js";
import { wallType, centrePolyline, extSign, wallHeights, wallFootprints } from "./walls.js";
import { openingFrame, clipBand } from "./openings.js";
import { floorParts, floorLoops, floorLevels } from "./floors.js";
import { roofGeometry, roofFootprint, planeZ } from "./roofs.js";
import { profilePts, defaultProfiles } from "./components.js";
import { checkMaterial } from "./library.js";

// --------------------------------------------------------------------------- reading settings
const fail = msg => { throw new Error(msg); };
function num(a, key, def, { min = -Infinity, max = Infinity, label = key } = {}) {
  const v = a[key] ?? def;
  if (v == null) fail(`Give ${label}.`);
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`${label} must be a number of millimetres.`);
  if (n < min || n > max) fail(`${label} must be between ${min} and ${max} mm (got ${n}).`);
  return n;
}
const mat = (a, key, def) => { const m = a[key] ?? def; checkMaterial(m); return m; };
const levelZ = (doc, id) => { const l = doc.levels.find(x => x.id === id); if (!l) fail(`There is no level "${id}".`); return l.elevation; };
function needWall(doc, id) {
  const w = doc.walls.find(x => x.id === id);
  if (!w) fail(`There is no wall "${id}".`);
  if (w.shape !== "line") fail(`Wall ${id} is curved; this detail goes on straight walls only.`);
  return w;
}
function pts2(list, label, min = 2) {
  if (!Array.isArray(list) || list.length < min) fail(`Give ${label} as at least ${min} points [x, y] in mm.`);
  return list.map((p, i) => {
    const x = Array.isArray(p) ? p[0] : p?.x, y = Array.isArray(p) ? p[1] : p?.y;
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) fail(`Point ${i + 1} of ${label} is not [x, y].`);
    return G.P(Number(x), Number(y));
  });
}
const oneOf = (a, key, list, def) => { const v = a[key] ?? def; if (!list.includes(v)) fail(`${key} must be one of: ${list.join(", ")}.`); return v; };

// --------------------------------------------------------------------------- small shape helpers
/** Rectangle on a line a-b, from d0 to d1 along the normal n. */
const band = (a, b, n, d0, d1) => [G.add(a, G.mul(n, d0)), G.add(b, G.mul(n, d0)), G.add(b, G.mul(n, d1)), G.add(a, G.mul(n, d1))];
/** Rectangle in a frame: origin o, along u from s0 to s1, across n from t0 to t1. */
const rectIn = (o, u, n, s0, s1, t0, t1) => band(G.add(o, G.mul(u, s0)), G.add(o, G.mul(u, s1)), n, t0, t1);
const prism = (poly, z0, z1, m) => ({ poly, z0: Math.min(z0, z1), z1: Math.max(z0, z1), mat: m });
const ccwSign = poly => (G.polygonArea(poly) > 0 ? 1 : -1);
/** Points spread over [s0, s1] for items `w` wide: by count, or every `spacing` (centre to centre), centred. */
function spread(s0, s1, w, count, spacing) {
  const room = s1 - s0 - w;
  if (room < -0.5) return [];
  if (count != null) {
    const n = Math.max(1, Math.round(count));
    if (n === 1) return [(s0 + s1) / 2];
    return Array.from({ length: n }, (_, k) => s0 + w / 2 + (room * k) / (n - 1));
  }
  const n = Math.floor(room / spacing + 1e-6) + 1, start = s0 + w / 2 + (room - (n - 1) * spacing) / 2;
  return Array.from({ length: n }, (_, k) => start + k * spacing);
}
/** Points of a path moved sideways by d (positive = to the left of travel), mitred at corners. */
function shiftPath(pts, closed, d) {
  const r = S.sweepRings(pts, 0, [{ x: d, y: 0 }], closed).map(x => G.P(x[0].x, x[0].y));
  return closed ? r.slice(0, -1) : r;
}
const segsOf = (pts, closed) => pts.slice(0, closed ? pts.length : pts.length - 1).map((p, i) => [p, pts[(i + 1) % pts.length]]);

// --------------------------------------------------------------------------- wall faces
/** A straight wall's face: origin at the wall's start, along u, `out` pointing away from the face (mm). */
export function wallFace(doc, w, side = "exterior") {
  const t = wallType(doc, w), c = centrePolyline(w, t), u = G.norm(G.sub(c[1], c[0]));
  const out = G.mul(G.perp(u), extSign(w) * (side === "interior" ? -1 : 1));
  const { z0, z1 } = wallHeights(doc, w);
  return { w, o: G.add(c[0], G.mul(out, t.thickness / 2)), u, out, L: G.dist(c[0], c[1]), z0, z1, t: t.thickness };
}

/** Faces of walls chained where they meet end to end, mitred, `offset` out from the face. */
export function faceChains(doc, walls, side, offset = 0) {
  const segs = walls.map(w => { const f = wallFace(doc, w, side); return { f, w, a: G.add(f.o, G.mul(f.out, offset)), b: G.add(G.add(f.o, G.mul(f.u, f.L)), G.mul(f.out, offset)), locA: w.a, locB: w.b }; });
  const used = new Set(), chains = [];
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const chain = [{ s: segs[i], rev: false }];
    const tail = () => (chain.at(-1).rev ? chain.at(-1).s.locA : chain.at(-1).s.locB), head = () => (chain[0].rev ? chain[0].s.locB : chain[0].s.locA);
    for (let grew = true; grew;) {
      grew = false;
      for (let k = 0; k < segs.length; k++) {
        if (used.has(k)) continue;
        const s = segs[k];
        if (G.dist(s.locA, tail()) <= 2) chain.push({ s, rev: false });
        else if (G.dist(s.locB, tail()) <= 2) chain.push({ s, rev: true });
        else if (G.dist(s.locB, head()) <= 2) chain.unshift({ s, rev: false });
        else if (G.dist(s.locA, head()) <= 2) chain.unshift({ s, rev: true });
        else continue;
        used.add(k); grew = true;
      }
    }
    const closed = chain.length > 2 && G.dist(head(), tail()) <= 2;
    const lines = chain.map(({ s, rev }) => (rev ? [s.b, s.a] : [s.a, s.b]));
    chains.push({ items: chain.map(c => c.s), lines, closed, pts: mitre(lines, closed) });
  }
  return chains;
}
function mitre(lines, closed) {
  const n = lines.length, pts = [];
  const meet = (p, q) => { const h = G.lineIntersect(p[0], p[1], q[0], q[1]); return h && G.dist(h.point, p[1]) < 5000 ? h.point : p[1]; };
  pts.push(closed ? meet(lines[n - 1], lines[0]) : lines[0][0]);
  for (let k = 0; k < n - 1; k++) pts.push(meet(lines[k], lines[k + 1]));
  if (!closed) pts.push(lines[n - 1][1]);
  return pts;
}

/** Cuts a face quad round the doors and windows of wall w, between heights zA and zB. */
function aroundOpenings(doc, w, quad, zA, zB, m) {
  const frames = doc.openings.filter(o => o.hostWallId === w.id).map(o => openingFrame(doc, o)).filter(Boolean).sort((a, b) => a.s0 - b.s0);
  if (!frames.length) return [prism(quad, zA, zB, m)];
  const { c0, u } = frames[0].ax, out = [];
  let cursor = -Infinity;
  for (const f of frames) {
    const full = clipBand(quad, c0, u, cursor, f.s0); if (full) out.push(prism(full, zA, zB, m));
    const mid = clipBand(quad, c0, u, f.s0, f.s1);
    if (mid) {
      if (Math.min(zB, f.zSill) > zA + 0.5) out.push(prism(mid, zA, Math.min(zB, f.zSill), m));
      if (Math.max(zA, f.zHead) < zB - 0.5) out.push(prism(mid, Math.max(zA, f.zHead), zB, m));
    }
    cursor = f.s1;
  }
  const last = clipBand(quad, c0, u, cursor, Infinity); if (last) out.push(prism(last, zA, zB, m));
  return out;
}

/** Floor slabs as cutters (cladding stops at balcony slabs and floors it meets). */
const floorCutters = doc => doc.floors.map(f => { const { top, bottom } = floorLevels(doc, f); return { polys: floorParts(floorLoops(f)).map(p => p.outer), z0: bottom, z1: top }; }).filter(v => v.polys.length);

/** A layer `t` thick on wall faces: cladding, or a finish skin. Joints split it into panels of that height. */
export function claddingParts(doc, walls, { side = "exterior", t, startH = 0, endH = null, joints = 0, m }) {
  const out = [];
  for (const ch of faceChains(doc, walls, side, 0)) {
    const outer = mitre(ch.lines.map(([a, b], k) => [G.add(a, G.mul(ch.items[k].f.out, t)), G.add(b, G.mul(ch.items[k].f.out, t))]), ch.closed);
    ch.items.forEach((it, k) => {
      const k1 = (k + 1) % ch.pts.length, quad = [ch.pts[k], ch.pts[k1], outer[k1], outer[k]];
      const zA = Math.max(it.f.z0, it.f.z0 + startH), zB = Math.min(it.f.z1, endH == null ? it.f.z1 : it.f.z0 + endH);
      if (zB - zA < 1) return;
      const rows = [];
      if (joints > 0) { const gap = 6; for (let z = zA; z < zB - 1; z += joints) rows.push([z, Math.min(zB, z + joints - (z + joints < zB - 1 ? gap : 0))]); }
      else rows.push([zA, zB]);
      for (const [z0, z1] of rows) out.push(...aroundOpenings(doc, it.w, quad, z0, z1, m));
    });
  }
  return S.applyVoids(out, floorCutters(doc)).map(p => ({ ...p, mat: p.mat ?? m }));
}

// --------------------------------------------------------------------------- floor and roof edges
/**
 * The outer edges of a floor or roof, numbered from 1: [{ ref: "<id>:e<k>", a, b, out, zA, zB, len, exposed, host }].
 * `out` points away from the slab. `exposed` is false where a wall stands on or under the edge.
 */
export function hostEdges(doc, hostId) {
  const f = doc.floors.find(x => x.id === hostId);
  if (f) {
    const { top, bottom } = floorLevels(doc, f), loops = floorParts(floorLoops(f)).map(p => p.outer);
    const lv = doc.levels.find(l => l.id === f.levelId), below = [...doc.levels].filter(l => l.elevation < (lv?.elevation ?? 0)).sort((a, b) => b.elevation - a.elevation)[0];
    const fps = [...wallFootprints(doc, f.levelId).values(), ...(below ? wallFootprints(doc, below.id).values() : [])].flatMap(x => x.pieces);
    const nearWall = p => fps.some(poly => G.pointInPolygon(p, poly) || poly.some((q, i) => G.projectOnSegment(p, q, poly[(i + 1) % poly.length]).dist <= 5));
    return edgesOf(loops, hostId, () => top, () => bottom, nearWall, "floor");
  }
  const r = doc.roofs.find(x => x.id === hostId);
  if (r) {
    const g = roofGeometry(doc, r);
    const faceAt = p => g.faces.find(fc => G.pointInPolygon(p, fc.pts) || fc.pts.some((q, i) => G.projectOnSegment(p, q, fc.pts[(i + 1) % fc.pts.length]).dist < 1));
    const under = p => { const fc = faceAt(p); return fc ? planeZ(fc.plane, p) : g.bottom; };
    const topAt = p => { const fc = faceAt(p); return fc ? planeZ(fc.plane, p) + fc.thick : g.top; };
    return edgesOf([g.outline], hostId, topAt, under, () => false, "roof");
  }
  fail(`"${hostId}" is not a floor or a roof.`);
}
function edgesOf(loops, hostId, topAt, underAt, nearWall, kind) {
  const out = [];
  let k = 0;
  for (const loop of loops) {
    const sgn = ccwSign(loop);
    loop.forEach((a, i) => {
      const b = loop[(i + 1) % loop.length], u = G.norm(G.sub(b, a));
      if (G.dist(a, b) < 1) return;
      k++;
      const m = G.mid(a, b);
      out.push({ ref: `${hostId}:e${k}`, host: hostId, kind, a, b, out: G.mul(G.perp(u), -sgn), zA: topAt(a), zB: topAt(b), underA: underAt(a), underB: underAt(b), len: G.dist(a, b), exposed: !nearWall(m) });
    });
  }
  return out;
}
/** Reads edge references: "<id>:e<k>", "<id>:all" or "<id>:exposed" (edges with no wall on or under them). */
export function parseEdges(doc, refs) {
  if (!Array.isArray(refs) || !refs.length) fail("Give the edges, e.g. [\"<floor id>:e1\"], or \"<floor id>:exposed\" for all edges with no wall.");
  const out = [];
  for (const ref of refs) {
    const m = /^(.+):(e(\d+)|all|exposed)$/.exec(String(ref));
    if (!m) fail(`"${ref}" is not an edge. Write it as <floor or roof id>:e<number>, :all or :exposed.`);
    const edges = hostEdges(doc, m[1]);
    if (m[2] === "all") out.push(...edges);
    else if (m[2] === "exposed") { const ex = edges.filter(e => e.exposed); if (!ex.length) fail(`${m[1]} has no edges free of walls.`); out.push(...ex); }
    else { const e = edges[Number(m[3]) - 1]; if (!e) fail(`${m[1]} has ${edges.length} edges; there is no e${m[3]}.`); out.push(e); }
  }
  return out.filter((e, i) => out.findIndex(x => x.ref === e.ref) === i);
}
/** Joins edges end to end into paths: [{ pts, closed, z, outLeft, edges }]. Level edges only. */
export function chainEdges(edges) {
  for (const e of edges) if (Math.abs(e.zA - e.zB) > 5) fail(`Edge ${e.ref} slopes (it is a gable or rake edge); this detail follows level edges only.`);
  const left = edges.map(e => ({ ...e })), chains = [];
  while (left.length) {
    const chain = [left.shift()];
    for (let grew = true; grew;) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const e = left[i], first = chain[0], last = chain.at(-1);
        if (G.dist(e.a, last.b) <= 2) chain.push(e);
        else if (G.dist(e.b, last.b) <= 2) chain.push({ ...e, a: e.b, b: e.a });
        else if (G.dist(e.b, first.a) <= 2) chain.unshift(e);
        else if (G.dist(e.a, first.a) <= 2) chain.unshift({ ...e, a: e.b, b: e.a });
        else continue;
        left.splice(i, 1); grew = true; break;
      }
    }
    if (chain.some(e => Math.abs(e.zA - chain[0].zA) > 5)) fail("The edges given are at different heights; give each height's edges in a separate call.");
    const closed = chain.length > 2 && G.dist(chain[0].a, chain.at(-1).b) <= 2;
    const pts = closed ? chain.map(e => e.a) : [...chain.map(e => e.a), chain.at(-1).b];
    const d0 = G.norm(G.sub(chain[0].b, chain[0].a));
    chains.push({ pts, closed, z: chain[0].zA, outLeft: G.dot(G.perp(d0), chain[0].out) > 0, edges: chain });
  }
  return chains;
}

// --------------------------------------------------------------------------- the kinds
function profileFor(doc, id) {
  const p = (doc.profiles || []).find(x => x.id === id) || defaultProfiles().find(x => x.id === id);
  if (!p) fail(`"${id}" is not in the profile library. Call list_profiles to see it.`);
  return p;
}

/** Railing parts along one straight line a-b at height z. */
function railingSegment(a, b, z, type, H, m, pm) {
  const L = G.dist(a, b); if (L < 50) return [];
  const u = G.norm(G.sub(b, a)), n = G.perp(u), out = [];
  if (type === "glass") {
    out.push(prism(band(a, b, n, -40, 40), z, z + 120, m));
    out.push(prism(band(a, b, n, -7.5, 7.5), z + 20, z + H, pm));
  } else if (type === "solid") {
    out.push(prism(band(a, b, n, -75, 75), z, z + H, m));
  } else {
    out.push(prism(band(a, b, n, -25, 25), z + H - 50, z + H, m)); // top rail
    out.push(prism(band(a, b, n, -20, 20), z + 100, z + 140, m)); // bottom rail
    const posts = Math.max(1, Math.ceil(L / 1500));
    for (let k = 0; k <= posts; k++) { const s = Math.min(L - 25, Math.max(25, (L * k) / posts)); out.push(prism(rectIn(a, u, n, s - 25, s + 25, -25, 25), z, z + H - 50, m)); }
    for (let k = 0; k < posts; k++) {
      const s0 = Math.max(25, (L * k) / posts) + 25, s1 = Math.min(L - 25, (L * (k + 1)) / posts) - 25;
      for (const s of spread(s0, s1, 20, null, 120)) out.push(prism(rectIn(a, u, n, s - 10, s + 10, -10, 10), z + 140, z + H - 50, m));
    }
  }
  return out;
}

export const KINDS = {
  cladding: {
    label: "Cladding", ifc: ["IFCCOVERING", ".CLADDING."],
    build(doc, a) {
      const walls = (a.wall_ids || fail("Give wall_ids: the walls to clad.")).map(id => needWall(doc, id));
      if (!walls.length) fail("Give at least one wall.");
      const from = a.from_level, to = a.to_level, eF = from != null ? levelZ(doc, from) : -Infinity, eT = to != null ? levelZ(doc, to) : Infinity;
      const list = walls.filter(w => { const e = levelZ(doc, w.baseLevelId); return e >= eF - 1 && e <= eT + 1; });
      if (!list.length) fail("None of those walls is between from_level and to_level.");
      const t = num(a, "thickness", 30, { min: 2, max: 300, label: "Cladding thickness" });
      const parts = claddingParts(doc, list, { side: oneOf(a, "side", ["exterior", "interior"], "exterior"), t, startH: num(a, "start_height", 0, { min: 0, max: 40000 }), endH: a.end_height == null ? null : num(a, "end_height", null, { min: 1, max: 40000 }), joints: num(a, "panel_joints", 0, { min: 0, max: 6000 }), m: mat(a, "material", "mt-travertine") });
      if (!parts.length) fail("There is no wall face left to clad there (check the heights).");
      return { parts, levelId: list[0].baseLevelId, hosts: list.map(w => w.id) };
    },
  },
  edgeSweep: {
    label: "Edge sweep", ifc: ["IFCCOVERING", ".USERDEFINED.", "FASCIA"],
    build(doc, a) {
      const prof = profileFor(doc, a.profile || "pf-fascia"), m = mat(a, "material", "mt-paint-white"), dz = num(a, "offset", 0, { min: -3000, max: 3000, label: "offset" });
      let p = profilePts(doc, { profileId: prof.id, rectW: a.rect_width, rectH: a.rect_height });
      const top = Math.max(...p.map(q => q.y)); p = p.map(q => ({ x: q.x, y: q.y - top })); // hangs from the top of the edge
      const edges = parseEdges(doc, a.edges), parts = [];
      for (const ch of chainEdges(edges)) {
        const pr = ch.outLeft ? p : p.map(q => ({ x: -q.x, y: q.y })).reverse();
        parts.push({ sweep: { rings: S.sweepRings(ch.pts, ch.z + dz, pr, ch.closed), closed: ch.closed, prof: pr }, mat: m });
      }
      return { parts, levelId: levelOfHost(doc, edges[0].host), hosts: [...new Set(edges.map(e => e.host))], name: prof.name };
    },
  },
  railing: {
    label: "Railing", ifc: ["IFCRAILING", ".GUARDRAIL."],
    build(doc, a) {
      const type = oneOf(a, "type", ["glass", "baluster", "solid"], "glass"), H = num(a, "height", 1100, { min: 300, max: 2500, label: "Railing height" });
      const m = mat(a, "material", type === "solid" ? "mt-paint-white" : "mt-steel-brushed"), pm = mat(a, "panel_material", "mt-glass-clear");
      const parts = []; let levelId, hosts = [];
      if (a.edges) {
        const edges = parseEdges(doc, a.edges), inset = num(a, "inset", 75, { min: 0, max: 1000, label: "inset" });
        for (const ch of chainEdges(edges)) {
          const path = shiftPath(ch.pts, ch.closed, (ch.outLeft ? -1 : 1) * inset);
          for (const [p, q] of segsOf(path, ch.closed)) parts.push(...railingSegment(p, q, ch.z, type, H, m, pm));
        }
        levelId = levelOfHost(doc, edges[0].host); hosts = [...new Set(edges.map(e => e.host))];
      } else {
        const pts = pts2(a.points, "points"); levelId = a.level_id || fail("Give level_id with points.");
        const z = levelZ(doc, levelId) + num(a, "base_height", 0, { min: -1000, max: 40000 });
        for (const [p, q] of segsOf(pts, false)) parts.push(...railingSegment(p, q, z, type, H, m, pm));
      }
      if (!parts.length) fail("The railing path is too short.");
      return { parts, levelId, hosts };
    },
  },
  fins: {
    label: "Fins", ifc: null,
    build(doc, a) {
      const walls = (a.wall_ids || fail("Give wall_ids: the wall faces for the fins.")).map(id => needWall(doc, id));
      const vertical = oneOf(a, "orientation", ["vertical", "horizontal"], "vertical") === "vertical";
      const depth = num(a, "depth", 300, { min: 10, max: 3000, label: "Fin depth" }), w = num(a, "width", 50, { min: 5, max: 1000, label: "Fin width" });
      const count = a.count != null ? num(a, "count", null, { min: 1, max: 400, label: "count" }) : null, spacing = count == null ? num(a, "spacing", 300, { min: 20, max: 20000, label: "spacing" }) : null;
      const m = mat(a, "material", "mt-alu-black"), side = oneOf(a, "side", ["exterior", "interior"], "exterior"), off = num(a, "offset", 0, { min: 0, max: 1000, label: "offset" });
      const parts = [];
      for (const wl of walls) {
        const f = wallFace(doc, wl, side), s0 = Math.max(-f.t, num(a, "from", 0, { min: -2000, max: 100000 })), s1 = Math.min(f.L + f.t, a.to == null ? f.L : num(a, "to", null, { min: -2000, max: 100000 }));
        if (s1 - s0 < w) fail(`Wall ${wl.id}: the stretch from ${s0} to ${s1} mm is narrower than one fin.`);
        const zA = f.z0 + num(a, "start_height", 0, { min: -2000, max: 40000 }), zB = a.height == null ? f.z1 : zA + num(a, "height", null, { min: 10, max: 40000, label: "Fin height" });
        if (vertical) for (const s of spread(s0, s1, w, count, spacing)) parts.push(prism(rectIn(f.o, f.u, f.out, s - w / 2, s + w / 2, off, off + depth), zA, zB, m));
        else for (const z of spread(zA, zB, w, count, spacing)) parts.push(prism(rectIn(f.o, f.u, f.out, s0, s1, off, off + depth), z - w / 2, z + w / 2, m));
      }
      if (!parts.length) fail("No fins fit there.");
      return { parts, levelId: walls[0].baseLevelId, hosts: walls.map(w => w.id) };
    },
  },
  canopy: {
    label: "Canopy", ifc: ["IFCSLAB", ".USERDEFINED.", "CANOPY"],
    build(doc, a) {
      let wl, pos, defW, defH;
      if (a.opening_id) {
        const o = doc.openings.find(x => x.id === a.opening_id) || fail(`There is no door or window "${a.opening_id}".`);
        const fr = openingFrame(doc, o) || fail("That opening is not in a straight wall."); wl = fr.w; pos = o.positionAlongWall; defW = fr.s1 - fr.s0 + 600; defH = fr.zHead - wallHeights(doc, wl).z0 + 200;
      } else {
        wl = needWall(doc, a.wall_id || fail("Give opening_id, or wall_id and position.")); pos = num(a, "position", null, { min: -100000, max: 100000, label: "position along the wall" }); defW = 2000; defH = 2400;
      }
      const f = wallFace(doc, wl, "exterior"), W = num(a, "width", defW, { min: 300, max: 30000, label: "Canopy width" }), D = num(a, "depth", 1200, { min: 100, max: 10000, label: "Canopy depth" });
      const T = num(a, "thickness", 150, { min: 20, max: 1000, label: "Canopy thickness" }), zb = f.z0 + num(a, "height", defH, { min: 100, max: 40000, label: "Canopy height" }), m = mat(a, "material", "mt-paint-white");
      const parts = [prism(rectIn(f.o, f.u, f.out, pos - W / 2, pos + W / 2, 0, D), zb, zb + T, m)];
      if (oneOf(a, "supports", ["none", "posts"], "none") === "posts") for (const s of [pos - W / 2 + 50, pos + W / 2 - 150]) parts.push(prism(rectIn(f.o, f.u, f.out, s, s + 100, D - 150, D - 50), f.z0, zb, mat(a, "post_material", m)));
      return { parts, levelId: wl.baseLevelId, hosts: [wl.id, a.opening_id].filter(Boolean) };
    },
  },
  pergola: {
    label: "Pergola", ifc: ["IFCMEMBER", ".MEMBER."],
    build(doc, a) {
      const area = pts2(a.area, "area", 3), levelId = a.level_id || fail("Give level_id."), base = levelZ(doc, levelId) + num(a, "base_height", 0, { min: -1000, max: 40000 });
      const H = num(a, "height", 2700, { min: 1500, max: 10000, label: "Pergola height" }), bw = num(a, "beam_width", 100, { min: 30, max: 500 }), bd = num(a, "beam_depth", 250, { min: 50, max: 1000 });
      const sw = num(a, "slat_width", 50, { min: 10, max: 400 }), sd = num(a, "slat_depth", 150, { min: 10, max: 600 }), sp = num(a, "spacing", 300, { min: 40, max: 3000, label: "slat spacing" }), ps = num(a, "post_size", 150, { min: 50, max: 600 });
      const m = mat(a, "material", "mt-timber-teak"), u = G.norm(G.sub(area[1], area[0])), v = G.perp(u), o = area[0];
      const su = area.map(p => G.dot(G.sub(p, o), u)), sv = area.map(p => G.dot(G.sub(p, o), v)), u0 = Math.min(...su), u1 = Math.max(...su), v0 = Math.min(...sv), v1 = Math.max(...sv);
      if (u1 - u0 < 600 || v1 - v0 < 600) fail("The pergola area must be at least 600 x 600 mm.");
      const top = base + H, parts = [];
      for (const vv of [v0, v1 - bw]) parts.push(prism(rectIn(o, u, v, u0, u1, vv, vv + bw), top - bd, top, m));
      for (const s of spread(u0, u1, sw, null, sp)) parts.push(prism(rectIn(o, u, v, s - sw / 2, s + sw / 2, v0, v1), top, top + sd, m));
      if (a.posts !== false) for (const [uu, vv] of [[u0, v0], [u1 - ps, v0], [u0, v1 - ps], [u1 - ps, v1 - ps]]) parts.push(prism(rectIn(o, u, v, uu, uu + ps, vv, vv + ps), base, top - bd, m));
      return { parts, levelId, hosts: [] };
    },
  },
  soffit: {
    label: "Soffit", ifc: ["IFCCOVERING", ".CEILING."],
    build(doc, a) {
      const id = a.host_id || fail("Give host_id: the roof or the slab to finish underneath."), m = mat(a, "material", "mt-timber-teak");
      const T = num(a, "thickness", 20, { min: 5, max: 300, label: "Soffit thickness" }), light = !!a.lighting_line, parts = [], skipped = [];
      const r = doc.roofs.find(x => x.id === id);
      if (r) {
        if (r.method === "extrusion") fail("Soffits go under roofs by footprint in this version.");
        const { poly, overhangs } = roofFootprint(r), n = poly.length, sg = ccwSign(poly);
        const inner = poly.map((p, i) => { const j = (i - 1 + n) % n; const sh = (k) => { const u = G.norm(G.sub(poly[(k + 1) % n], poly[k])), d = G.mul(G.perp(u), sg * (overhangs[k] || 0)); return [G.add(poly[k], d), G.add(poly[(k + 1) % n], d)]; }; const A = sh(j), B = sh(i); const h = G.lineIntersect(A[0], A[1], B[0], B[1]); return h ? h.point : B[0]; });
        const edges = hostEdges(doc, id);
        poly.forEach((p, i) => {
          const q = poly[(i + 1) % n]; if (!((overhangs[i] || 0) > 0.5)) return;
          const e = edges.find(x => G.dist(x.a, p) < 1 && G.dist(x.b, q) < 1); if (!e) return;
          if (Math.abs(e.underA - e.underB) > 5) { skipped.push(e.ref); return; }
          const z1 = Math.min(e.underA, e.underB), quad = [p, q, inner[(i + 1) % n], inner[i]];
          parts.push(prism(quad, z1 - T, z1, m));
          if (light) { const u = G.norm(G.sub(q, p)), nn = G.mul(G.perp(u), sg); parts.push(prism(band(G.add(p, G.mul(u, 100)), G.sub(q, G.mul(u, 100)), nn, 100, 125), z1 - T - 15, z1 - T, "mt-light-line")); }
        });
        if (!parts.length) fail(skipped.length ? "The roof's overhangs are all on sloping (gable) edges; soffits follow level eaves only." : "This roof has no overhang to put a soffit under.");
        return { parts, levelId: r.baseLevelId, hosts: [id], note: skipped.length ? `Skipped sloping edges ${skipped.join(", ")}.` : "" };
      }
      const f = doc.floors.find(x => x.id === id) || fail(`"${id}" is not a roof or a floor.`);
      const { bottom } = floorLevels(doc, f), lv = doc.levels.find(l => l.id === f.levelId);
      const below = doc.floors.filter(g => g.id !== f.id && floorLevels(doc, g).top < bottom - 1 && doc.levels.find(l => l.id === g.levelId)?.elevation < lv.elevation);
      if (!below.length) fail("There is no floor below this slab to measure its projection from; give a roof, or a balcony slab over a lower floor.");
      const topBelow = Math.max(...below.map(g => floorLevels(doc, g).top)), under = below.filter(g => Math.abs(floorLevels(doc, g).top - topBelow) < 1);
      let pieces = floorParts(floorLoops(f)).map(p => p.outer);
      for (const g of under) for (const p of floorParts(floorLoops(g))) pieces = S.subtractPolygon(pieces, p.outer);
      pieces = pieces.filter(p => Math.abs(G.polygonArea(p)) > 10000);
      if (!pieces.length) fail("This slab does not project beyond the floor below, so there is no underside to finish.");
      for (const p of pieces) parts.push(prism(p, bottom - T, bottom, m));
      return { parts, levelId: f.levelId, hosts: [id] };
    },
  },
  parapet: {
    label: "Parapet", ifc: ["IFCWALL", ".PARAPET."],
    build(doc, a) {
      const edges = parseEdges(doc, a.edges), H = num(a, "height", 900, { min: 100, max: 3000, label: "Parapet height" }), T = num(a, "thickness", 225, { min: 50, max: 600, label: "Parapet thickness" });
      const m = mat(a, "material", "mt-paint-white"), cm = mat(a, "coping_material", "mt-concrete"), cp = a.coping_profile ?? "pf-coping", parts = [];
      for (const ch of chainEdges(edges)) {
        const s = ch.outLeft ? -1 : 1, inner = shiftPath(ch.pts, ch.closed, s * T);
        segsOf(ch.pts, ch.closed).forEach(([p, q], k) => parts.push(prism([p, q, inner[(k + 1) % inner.length], inner[k]], ch.z, ch.z + H, m)));
        if (cp && cp !== "none") {
          const prof = profileFor(doc, cp), pp = profilePts(doc, { profileId: prof.id });
          const path = prof.centred ? shiftPath(ch.pts, ch.closed, (s * T) / 2) : ch.pts, pr = prof.centred || ch.outLeft ? pp : pp.map(q => ({ x: -q.x, y: q.y })).reverse();
          parts.push({ sweep: { rings: S.sweepRings(path, ch.z + H, pr, ch.closed), closed: ch.closed, prof: pr }, mat: cm });
        }
      }
      return { parts, levelId: levelOfHost(doc, edges[0].host), hosts: [...new Set(edges.map(e => e.host))] };
    },
  },
  planter: {
    label: "Planter", ifc: ["IFCBUILDINGELEMENTPROXY", ".NOTDEFINED."],
    build(doc, a) {
      const area = pts2(a.area, "area", 3), levelId = a.level_id || fail("Give level_id."), base = levelZ(doc, levelId) + num(a, "base_height", 0, { min: -1000, max: 40000 });
      const H = num(a, "height", 600, { min: 100, max: 3000, label: "Planter height" }), t = num(a, "wall_thickness", 100, { min: 30, max: 500 }), m = mat(a, "material", "mt-concrete");
      const inner = shiftPath(area, true, ccwSign(area) * t);
      if (Math.abs(G.polygonArea(inner)) < 10000 || ccwSign(inner) !== ccwSign(area)) fail("The planter is too small for its wall thickness.");
      const parts = S.subtractPolygon([area], inner).map(p => prism(p, base, base + H, m));
      if (a.soil !== false) parts.push(prism(inner, base, base + H - 100, "mt-soil"));
      return { parts, levelId, hosts: [] };
    },
  },
  steps: {
    label: "Steps", ifc: ["IFCSTAIR", ".STRAIGHT_RUN_STAIR."],
    build(doc, a) {
      const [at] = pts2([a.at], "at", 1), [dir] = pts2([a.direction], "direction", 1), levelId = a.level_id || fail("Give level_id."), base = levelZ(doc, levelId) + num(a, "base_height", 0, { min: -3000, max: 40000 });
      if (G.len(dir) < 1e-6) fail("direction must not be zero.");
      const u = G.norm(dir), n = G.perp(u), W = num(a, "width", 1500, { min: 300, max: 20000, label: "Step width" }), count = Math.round(num(a, "count", 3, { min: 1, max: 30, label: "count" }));
      const R = num(a, "riser", 150, { min: 20, max: 400, label: "Riser" }), T = num(a, "tread", 300, { min: 100, max: 2000, label: "Tread" }), m = mat(a, "material", "mt-travertine");
      const parts = []; for (let k = 1; k <= count; k++) parts.push(prism(rectIn(at, u, n, (k - 1) * T, k * T, -W / 2, W / 2), base, base + k * R, m));
      return { parts, levelId, hosts: [] };
    },
  },
  screen: {
    label: "Screen", ifc: ["IFCBUILDINGELEMENTPROXY", ".NOTDEFINED."],
    build(doc, a) {
      const [p, q] = pts2(a.line, "line"), levelId = a.level_id || fail("Give level_id."), base = levelZ(doc, levelId) + num(a, "base_height", 0, { min: -1000, max: 40000 });
      const H = num(a, "height", 2400, { min: 200, max: 12000, label: "Screen height" }), pat = oneOf(a, "pattern", ["vertical_slats", "horizontal_slats", "breeze_block"], "vertical_slats");
      const w = num(a, "slat_width", 50, { min: 10, max: 600 }), d = num(a, "slat_depth", 100, { min: 10, max: 600 }), gap = num(a, "gap", 50, { min: 5, max: 2000 }), m = mat(a, "material", pat === "breeze_block" ? "mt-paint-white" : "mt-timber-teak");
      const L = G.dist(p, q); if (L < 200) fail("The screen line must be at least 200 mm long.");
      const u = G.norm(G.sub(q, p)), n = G.perp(u), parts = [];
      if (pat === "vertical_slats") for (const s of spread(0, L, w, null, w + gap)) parts.push(prism(rectIn(p, u, n, s - w / 2, s + w / 2, -d / 2, d / 2), base, base + H, m));
      else if (pat === "horizontal_slats") for (const z of spread(0, H, w, null, w + gap)) parts.push(prism(rectIn(p, u, n, 0, L, -d / 2, d / 2), base + z - w / 2, base + z + w / 2, m));
      else {
        const cell = 200, bar = 40, D = 140;
        for (const s of spread(0, L, bar, null, cell)) parts.push(prism(rectIn(p, u, n, s - bar / 2, s + bar / 2, -D / 2, D / 2), base, base + H, m));
        for (const z of spread(0, H, bar, null, cell)) parts.push(prism(rectIn(p, u, n, 0, L, -D / 2, D / 2), base + z - bar / 2, base + z + bar / 2, m));
      }
      return { parts, levelId, hosts: [] };
    },
  },
};

function levelOfHost(doc, id) { return doc.floors.find(f => f.id === id)?.levelId || doc.roofs.find(r => r.id === id)?.baseLevelId || doc.levels[0].id; }

/** The IFC class of a detail: [entity, predefined type, object type]. */
export function detailIfc(d) {
  if (d.kind === "fins") return d.args?.ifc === "member" ? ["IFCMEMBER", ".MEMBER."] : ["IFCSHADINGDEVICE", ".USERDEFINED.", "LOUVRE"];
  return KINDS[d.kind]?.ifc || ["IFCBUILDINGELEMENTPROXY", ".NOTDEFINED."];
}

/** Builds a detail from its settings (throws in plain words). Returns { parts, levelId, hosts, name?, note? }. */
export function buildDetail(doc, kind, args) {
  const K = KINDS[kind]; if (!K) fail(`"${kind}" is not a kind of detail.`);
  return K.build(doc, args || {});
}
/** The parts of a stored detail ([] when its hosts are gone). */
export function detailParts(doc, d) { try { return buildDetail(doc, d.kind, d.args).parts; } catch { return []; } }

/**
 * When walls, floors, roofs or doors are deleted: details lose those hosts (a cladding over three walls keeps the
 * other two), and a detail with nothing left to stand on goes too. Returns the kept details.
 */
export function dropWithHosts(details, gone) {
  const out = [];
  for (const d of details) {
    const a = d.args || {};
    if (!(d.hosts || []).some(h => gone.has(h)) && !gone.has(a.opening_id) && !gone.has(a.wall_id) && !gone.has(a.host_id)) { out.push(d); continue; }
    if (gone.has(a.opening_id) || gone.has(a.wall_id) || gone.has(a.host_id)) continue;
    const next = { ...a };
    if (Array.isArray(a.wall_ids)) next.wall_ids = a.wall_ids.filter(id => !gone.has(id));
    if (Array.isArray(a.edges)) next.edges = a.edges.filter(r => !gone.has(String(r).replace(/:(e\d+|all|exposed)$/, "")));
    if ((next.wall_ids && !next.wall_ids.length) || (next.edges && !next.edges.length)) continue;
    out.push({ ...d, args: next, hosts: (d.hosts || []).filter(h => !gone.has(h)) });
  }
  return out;
}
