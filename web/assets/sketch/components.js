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
  ].map(p => ({ ...p, pts: p.pts.map(([x, y]) => ({ x, y })) }));
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

/** Void extrusions as cutters for walls and floors. */
export function voidCutters(doc) {
  return doc.components.filter(c => c.kind === "extrusion" && c.isVoid).map(c => {
    const r = checkSketch(c.boundary); if (!r.ok) return null;
    const { z0, z1 } = extrusionRange(doc, c);
    return { id: c.id, polys: floorParts(r.loops).map(p => p.outer), z0, z1 };
  }).filter(Boolean);
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

/** Rings of a sweep (for 3D) and its centred profile. */
export function sweepGeometry(doc, c) {
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
