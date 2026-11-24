// In-place components: extrusions and sweeps (solid or void), wall sweeps and reveals, reference planes.
// All geometry is computed from these records.
import * as G from "./geom.js";
import { newId } from "./model.js";
import { checkSketch, floorParts, curvePoints, curveEnds } from "./floors.js";
import { wallHeights, wallType, centrePolyline, extSign } from "./walls.js";
import * as S from "./solids.js";

/** Profile library (mm). x across the path or out from the wall face (positive = outwards), y up. */
export function defaultProfiles() {
  return [
    { id: "pf-coping", name: "Coping 300 x 75 with drip", centred: true, pts: [[-150, 0], [-125, 0], [-125, 10], [-115, 10], [-115, 0], [115, 0], [115, 10], [125, 10], [125, 0], [150, 0], [150, 60], [0, 75], [-150, 60]] },
    { id: "pf-cornice", name: "Cornice 150 x 200", pts: [[0, 0], [40, 0], [40, 60], [100, 60], [100, 120], [150, 120], [150, 200], [0, 200]] },
    { id: "pf-plinth", name: "Plinth band 30 x 450", pts: [[0, 0], [30, 0], [30, 450], [0, 450]] },
    { id: "pf-slabedge", name: "Slab edge band 25 x 200", pts: [[0, 0], [25, 0], [25, 200], [0, 200]] },
    { id: "pf-sillband", name: "Window sill/head band 50 x 100", pts: [[0, 0], [50, 0], [50, 100], [0, 100]] },
    { id: "pf-railtop", name: "Railing top 60 x 40", centred: true, pts: [[-30, 0], [30, 0], [30, 40], [-30, 40]] },
    { id: "pf-rect", name: "Rectangle (set size)", rect: true, pts: [[0, 0], [100, 0], [100, 100], [0, 100]] },
    { id: "pf-fascia", name: "Flat fascia 30 x 300", pts: [[0, 0], [30, 0], [30, 300], [0, 300]] },
    { id: "pf-fascia-curved", name: "Curved fascia 200 x 450", pts: curvedFascia(200, 450, 30) },
    { id: "pf-band", name: "Band 50 x 150", pts: [[0, 0], [50, 0], [50, 150], [0, 150]] },
    { id: "pf-window-surround", name: "Window surround 100 x 60", pts: [[0, 0], [60, 0], [60, 100], [0, 100]] },
    { id: "pf-light-line", name: "Light line 25 x 20", pts: [[0, 0], [25, 0], [25, 20], [0, 20]] },
  ].map(p => ({ ...p, pts: p.pts.map(([x, y]) => ({ x, y })) }));
}

/** A rounded nose fascia: a half ellipse out from the face, `t` thick. */
function curvedFascia(depth, height, t) {
  const n = 14, h = height / 2, out = [], inn = [];
  for (let k = 0; k <= n; k++) { const a = (Math.PI * k) / n; out.push([Math.round(depth * Math.sin(a) * 10) / 10, Math.round((h + h * Math.cos(a)) * 10) / 10]); }
  for (let k = n; k >= 0; k--) { const a = (Math.PI * k) / n; inn.push([Math.round((depth - t) * Math.sin(a) * 10) / 10, Math.round((h + (h - t) * Math.cos(a)) * 10) / 10]); }
  return [...out, ...inn];
}

export function profilePts(doc, c) {
  const p = (doc.profiles || []).find(x => x.id === c.profileId) || defaultProfiles().find(x => x.id === c.profileId) || defaultProfiles()[0];
  if (p.rect) { const w = c.rectW || 100, h = c.rectH || 100; return [G.P(0, 0), G.P(w, 0), G.P(w, h), G.P(0, h)]; }
  return p.pts.map(q => ({ x: q.x, y: q.y }));
}

const levelZ = (doc, id) => doc.levels.find(l => l.id === id)?.elevation ?? 0;

export function makeExtrusion(doc, init) {
  return { id: newId("cx"), kind: "extrusion", isVoid: !!init.isVoid, levelId: init.levelId, start: init.start ?? 0, end: init.end ?? 1000, boundary: init.boundary, material: init.material || "#c8c2b6", name: init.name || (init.isVoid ? "Void extrusion" : "Extrusion") };
}
export function makeSweep(doc, init) {
  return { id: newId("cs"), kind: "sweep", isVoid: !!init.isVoid, levelId: init.levelId, height: init.height ?? 0, path: init.path, profileId: init.profileId || "pf-cornice", rectW: init.rectW, rectH: init.rectH, flip: !!init.flip, material: init.material || "#d9d4ca", name: init.name || (init.isVoid ? "Void sweep" : "Sweep") };
}
export function makeWallSweep(doc, init) {
  return { id: newId("cw"), kind: "wallSweep", reveal: !!init.reveal, wallIds: [...init.wallIds], profileId: init.profileId || (init.reveal ? "pf-rect" : "pf-plinth"), rectW: init.rectW ?? 20, rectH: init.rectH ?? 50, side: init.side || "exterior", from: init.from || "base", distance: init.distance ?? 0, offset: init.offset ?? 0, material: init.material || "#cfc9bd" };
}

// --------------------------------------------------------------------------- extrusions
export function extrusionRange(doc, c) { const z = levelZ(doc, c.levelId); return { z0: z + Math.min(c.start, c.end), z1: z + Math.max(c.start, c.end) }; }

/** Prisms of an extrusion: its loops, holes cut out. */
export function extrusionPrisms(doc, c) {
  const r = checkSketch(c.boundary); if (!r.ok) return [];
  const { z0, z1 } = extrusionRange(doc, c);
  const out = [];
  for (const part of floorParts(r.loops)) {
    let pieces = [part.outer];
    for (const h of part.holes) pieces = S.subtractPolygon(pieces, h);
    for (const p of pieces) out.push({ poly: p, z0, z1 });
  }
  return out;
}

/** Void extrusions as cutters for walls and floors: upright prisms { polys (plan), z0, z1 }. */
export function voidCutters(doc) {
  const out = [];
  for (const c of doc.components) {
    if (c.kind !== "extrusion" || !c.isVoid) continue;
    if (c.plane) { out.push(...planeExtrusionBands(doc, c).map(v => ({ ...v, targets: c.targets }))); continue; }
    const r = checkSketch(c.boundary); if (!r.ok) continue;
    const { z0, z1 } = extrusionRange(doc, c);
    out.push({ id: c.id, polys: floorParts(r.loops).map(p => p.outer), z0, z1, targets: c.targets });
  }
  return out;
}

// --------------------------------------------------------------------------- extrusions drawn in an elevation
/** A point of a vertical work plane: s along it, n out from it (mm). */
export const planeAt = (pl, s, n) => ({ x: pl.o.x + pl.u.x * s + pl.n.x * n, y: pl.o.y + pl.u.y * s + pl.n.y * n });
/** Depth range of an extrusion drawn in an elevation: distances out from its face. */
export function planeDepth(c) { return { d0: Math.min(c.start ?? 0, c.end ?? 250), d1: Math.max(c.start ?? 0, c.end ?? 250) }; }

/**
 * An extrusion drawn in an elevation, as upright prisms (for cutting walls and floors): the profile is cut into
 * horizontal bands; each band's spans become plan rectangles across the depth. Exact for square-cornered shapes,
 * stepped every 20 mm or less on sloped and curved edges.
 */
export function planeExtrusionBands(doc, c) {
  const r = checkSketch(c.boundary); if (!r.ok) return [];
  const loops = r.loops, { d0, d1 } = planeDepth(c), pl = c.plane;
  if (d1 - d0 < 0.5) return [];
  const edges = loops.flatMap(l => l.map((p, i) => [p, l[(i + 1) % l.length]]));
  const zs = [...new Set(loops.flat().map(p => Math.round(p.y * 1000) / 1000))].sort((a, b) => a - b);
  const bands = [];
  for (let i = 0; i + 1 < zs.length; i++) {
    const za = zs[i], zb = zs[i + 1], sloped = edges.some(([p, q]) => Math.min(p.y, q.y) <= za + 1e-6 && Math.max(p.y, q.y) >= zb - 1e-6 && Math.abs(p.x - q.x) > 0.5);
    const n = sloped ? Math.min(200, Math.max(1, Math.ceil((zb - za) / 20))) : 1;
    for (let k = 0; k < n; k++) bands.push([za + ((zb - za) * k) / n, za + ((zb - za) * (k + 1)) / n]);
  }
  const out = [];
  for (const [z0, z1] of bands) {
    const zm = (z0 + z1) / 2, xs = [];
    for (const [p, q] of edges) if ((p.y > zm) !== (q.y > zm)) xs.push(p.x + ((zm - p.y) * (q.x - p.x)) / (q.y - p.y));
    xs.sort((a, b) => a - b);
    const polys = [];
    for (let k = 0; k + 1 < xs.length; k += 2) { const s0 = xs[k], s1 = xs[k + 1]; if (s1 - s0 > 0.5) polys.push([planeAt(pl, s0, d0), planeAt(pl, s1, d0), planeAt(pl, s1, d1), planeAt(pl, s0, d1)]); }
    if (polys.length) out.push({ id: c.id, polys, z0, z1 });
  }
  return out;
}

/** Plan footprint of anything drawn in an elevation (extrusion or sweep): the strip it covers. */
export function componentPlanStrip(doc, c) {
  if (c.kind === "sweep") return sweepPlanStrip(doc, c);
  const r = checkSketch(c.boundary); if (!r.ok) throw new Error(r.message);
  const ss = r.loops.flat().map(p => p.x), { d0, d1 } = planeDepth(c), s0 = Math.min(...ss), s1 = Math.max(...ss);
  return [planeAt(c.plane, s0, d0), planeAt(c.plane, s1, d0), planeAt(c.plane, s1, d1), planeAt(c.plane, s0, d1)];
}

// --------------------------------------------------------------------------- sweeps
/** Orders path curves into one chain (open or closed). Throws in plain words if it is not one chain. */
export function chainPath(curves) {
  if (!curves.length) throw new Error("Draw or pick the sweep's path first.");
  if (curves.length === 1 && curves[0].shape === "arc" && G.isCircle(curves[0])) { const p = curvePoints(curves[0]); p.pop(); return { pts: p, closed: true }; }
  const left = curves.map((c, i) => i), used = [left.shift()];
  let pts = [...curvePoints(curves[used[0]])];
  let grew = true;
  while (left.length && grew) {
    grew = false;
    for (let k = 0; k < left.length; k++) {
      const c = curves[left[k]], [a, b] = curveEnds(c), cp = curvePoints(c);
      if (G.dist(a, pts.at(-1)) <= 1) { pts.push(...cp.slice(1)); }
      else if (G.dist(b, pts.at(-1)) <= 1) { pts.push(...[...cp].reverse().slice(1)); }
      else if (G.dist(b, pts[0]) <= 1) { pts = [...cp.slice(0, -1), ...pts]; }
      else if (G.dist(a, pts[0]) <= 1) { pts = [...[...cp].reverse().slice(0, -1), ...pts]; }
      else continue;
      left.splice(k, 1); grew = true; break;
    }
  }
  if (left.length) throw new Error("The path must be one connected chain of lines and arcs.");
  const closed = pts.length > 3 && G.dist(pts[0], pts.at(-1)) <= 1;
  if (closed) pts.pop();
  return { pts, closed };
}

/** A point of a vertical work plane: s along the plane (mm), z height (mm). */
export const planePoint = (pl, s, z) => ({ x: pl.o.x + pl.u.x * s, y: pl.o.y + pl.u.y * s, z });

/** Rings of a sweep (for 3D) and its centred profile. A sweep drawn in an elevation has a vertical `plane`
 *  { o, u, n, side }: its path is in (s along u, z) and the profile stands out from the plane along n. */
export function sweepGeometry(doc, c) {
  if (c.plane) {
    const { pts, closed } = chainPath(c.path); // (x = s, y = z)
    let prof = profilePts(doc, c);
    // profile x = out from the face, y = across the path (to the left of travel: up for a path drawn left to right)
    let p2 = prof.map(q => ({ x: (c.flip ? -1 : 1) * q.y, y: q.x }));
    if (!c.flip) p2 = p2.reverse();
    const flat = S.sweepRings(pts, 0, p2, closed); // x = s', y = z', z = out
    const pl = c.plane;
    const rings = flat.map(r => r.map(q => ({ x: pl.o.x + pl.u.x * q.x + pl.n.x * q.z, y: pl.o.y + pl.u.y * q.x + pl.n.y * q.z, z: q.y })));
    return { rings, closed, prof: p2, pts: null, plane: true };
  }
  const { pts, closed } = chainPath(c.path);
  let prof = profilePts(doc, c);
  if (c.flip) prof = prof.map(p => ({ x: -p.x, y: p.y })).reverse();
  return { rings: S.sweepRings(pts, levelZ(doc, c.levelId) + (c.height || 0), prof, closed), closed, prof, pts };
}

// --------------------------------------------------------------------------- wall sweeps and reveals
/** Face line(s) of the walls of a wall sweep, chained where walls meet, at the sweep's height. */
export function wallSweepPaths(doc, ws) {
  const walls = ws.wallIds.map(id => doc.walls.find(w => w.id === id)).filter(w => w && w.shape === "line");
  if (!walls.length) return [];
  const segs = walls.map(w => {
    const t = wallType(doc, w), c = centrePolyline(w, t), u = G.norm(G.sub(c[1], c[0]));
    const out = G.mul(G.perp(u), extSign(w) * (ws.side === "interior" ? -1 : 1)); // outward from the chosen face
    const d = t.thickness / 2 + (ws.offset || 0);
    const { z0, z1 } = wallHeights(doc, w);
    return { w, a: G.add(c[0], G.mul(out, d)), b: G.add(c[1], G.mul(out, d)), out, z: ws.from === "top" ? z1 - (ws.distance || 0) : z0 + (ws.distance || 0), locA: w.a, locB: w.b };
  });
  // chain walls joined end to end into one path, so corners are mitred
  const paths = [], used = new Set();
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    let chain = [{ s: segs[i], rev: false }];
    const tailLoc = () => { const l = chain.at(-1); return l.rev ? l.s.locA : l.s.locB; };
    const headLoc = () => { const f = chain[0]; return f.rev ? f.s.locB : f.s.locA; };
    let grew = true;
    while (grew) {
      grew = false;
      for (let k = 0; k < segs.length; k++) {
        if (used.has(k)) continue;
        const s = segs[k];
        if (G.dist(s.locA, tailLoc()) <= 2) { chain.push({ s, rev: false }); used.add(k); grew = true; }
        else if (G.dist(s.locB, tailLoc()) <= 2) { chain.push({ s, rev: true }); used.add(k); grew = true; }
        else if (G.dist(s.locB, headLoc()) <= 2) { chain.unshift({ s, rev: false }); used.add(k); grew = true; }
        else if (G.dist(s.locA, headLoc()) <= 2) { chain.unshift({ s, rev: true }); used.add(k); grew = true; }
      }
    }
    const lines = chain.map(({ s, rev }) => (rev ? [s.b, s.a] : [s.a, s.b]));
    const closed = chain.length > 2 && G.dist(headLoc(), tailLoc()) <= 2;
    const pts = [];
    for (let k = 0; k < lines.length; k++) {
      if (k === 0) { if (closed) { const h = G.lineIntersect(lines.at(-1)[0], lines.at(-1)[1], lines[0][0], lines[0][1]); pts.push(h ? h.point : lines[0][0]); } else pts.push(lines[0][0]); }
      if (k < lines.length - 1) { const h = G.lineIntersect(lines[k][0], lines[k][1], lines[k + 1][0], lines[k + 1][1]); pts.push(h ? h.point : lines[k][1]); }
      else if (!closed) pts.push(lines[k][1]);
    }
    // which side is outward along this path: compare the first wall's outward normal with the path's left
    const first = chain[0], dir = G.norm(G.sub(lines[0][1], lines[0][0]));
    const outIsLeft = G.dot(G.perp(dir), first.s.out) > 0;
    paths.push({ pts, closed, z: first.s.z, outIsLeft });
  }
  return paths;
}

/** Sweep geometry for a (non-reveal) wall sweep: the profile stands out from the face. */
export function wallSweepGeometry(doc, ws) {
  const prof = profilePts(doc, ws);
  return wallSweepPaths(doc, ws).map(p => {
    const pr = p.outIsLeft ? prof : prof.map(q => ({ x: -q.x, y: q.y })).reverse();
    return { rings: S.sweepRings(p.pts, p.z, pr, p.closed), closed: p.closed, prof: pr, pts: p.pts };
  });
}

/** Reveals cut into a wall: [{ origin, n, max, z0, z1 }] for applyReveal. */
export function revealsFor(doc, w) {
  const out = [];
  for (const ws of doc.components) {
    if (ws.kind !== "wallSweep" || !ws.reveal || !ws.wallIds.includes(w.id) || w.shape !== "line") continue;
    const t = wallType(doc, w), c = centrePolyline(w, t), u = G.norm(G.sub(c[1], c[0]));
    const n = G.mul(G.perp(u), extSign(w) * (ws.side === "interior" ? -1 : 1));
    const prof = profilePts(doc, ws), depth = Math.max(...prof.map(p => p.x)) - Math.min(...prof.map(p => p.x)), hgt = Math.max(...prof.map(p => p.y)) - Math.min(...prof.map(p => p.y));
    const { z0, z1 } = wallHeights(doc, w);
    const zb = ws.from === "top" ? z1 - (ws.distance || 0) - hgt : z0 + (ws.distance || 0);
    out.push({ origin: c[0], n, max: t.thickness / 2 - depth, z0: zb, z1: zb + hgt });
  }
  return out;
}

export function makeRefPlane(a, b, name) { return { id: newId("rp"), a: { ...a }, b: { ...b }, name: name || "" }; }

/** Plan footprint of a sweep drawn in an elevation: the strip it covers on its face. */
export function sweepPlanStrip(doc, c) {
  const g = sweepGeometry(doc, c), pl = c.plane, pts = g.rings.flat();
  const ss = pts.map(q => G.dot(G.sub(q, pl.o), pl.u)), ns = pts.map(q => G.dot(G.sub(q, pl.o), pl.n));
  const s0 = Math.min(...ss), s1 = Math.max(...ss), n0 = Math.min(...ns), n1 = Math.max(...ns);
  const P = (s, n) => G.add(G.add(pl.o, G.mul(pl.u, s)), G.mul(pl.n, n));
  return [P(s0, n0), P(s1, n0), P(s1, n1), P(s0, n1)];
}
/** Height range of a sweep drawn in an elevation. */
export function sweepZRange(doc, c) { const zs = sweepGeometry(doc, c).rings.flat().map(q => q.z); return { z0: Math.min(...zs), z1: Math.max(...zs) }; }
