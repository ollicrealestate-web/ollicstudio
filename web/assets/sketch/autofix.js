// Before Ollic AI completes a design, the model is made ready by itself (one undoable step), so the architect is not
// sent back to fix things by hand: outer walls are joined into closed loops (ends trimmed or extended to meet, and a
// wall added across any gap left), and a level with walls but no floor gets one. Returns what was done, in plain words.
import * as G from "./geom.js";
import { wallType, centrePolyline, makeWall } from "./walls.js";
import { makeFloor } from "./floors.js";
import { keepOpeningsInPlace } from "./openings.js";
import { readiness } from "./summary.js";

const REACH = 3000;   // mm: how far an end is trimmed or extended to meet another wall
const JOINED = 2;     // mm: as the wall geometry joins them

const isLine = w => (w.shape || "line") === "line";
const ext = (doc, w) => wallType(doc, w).function === "exterior";
const m = v => `${(v / 1000).toFixed(2)} m`;

/** The ends of the level's outer walls that meet no other wall: [{ w, key }]. */
function freeEnds(doc, walls) {
  const out = [];
  for (const w of walls) {
    if (!isLine(w) || !ext(doc, w)) continue;
    for (const key of ["a", "b"]) {
      const p = w[key];
      if (!walls.some(v => v !== w && (isLine(v) ? G.projectOnSegment(p, v.a, v.b).dist <= JOINED : Math.abs(G.dist(p, v.c) - v.r) <= JOINED))) out.push({ w, key });
    }
  }
  return out;
}

/** Where wall w's end should go to meet another wall (trim or extend along its own line), or null. */
function meetingPoint(doc, w, key, walls) {
  const p = w[key], other = key === "a" ? w.b : w.a;
  let best = null;
  for (const pass of ["exterior", "any"]) {
    for (const v of walls) {
      if (v === w || !isLine(v) || (pass === "exterior" && !ext(doc, v))) continue;
      const h = G.lineIntersect(w.a, w.b, v.a, v.b);
      if (!h) continue;
      const du = G.norm(G.sub(w.b, w.a)), dv = G.norm(G.sub(v.b, v.a));
      if (Math.abs(G.cross(du, dv)) < Math.sin(15 * Math.PI / 180)) continue;   // nearly parallel: no corner
      const lv = G.dist(v.a, v.b), slack = REACH / lv;
      if (h.u < -slack || h.u > 1 + slack) continue;                            // too far past the other wall
      const X = h.point, d = G.dist(p, X);
      if (d > REACH || G.dist(other, X) < 300) continue;                         // too far, or the wall would vanish
      // the end must stay on its own side: trimming or extending, never flipping the wall
      if (G.dot(G.sub(X, other), G.sub(p, other)) <= 0) continue;
      if (!best || d < best.d) best = { X, v, u: h.u, d };
    }
    if (best) break;
  }
  return best;
}

/** Outer-wall loop of a level as floor boundary curves (wall centrelines), or the walls' bounding rectangle. */
function outline(doc, walls) {
  const ws = walls.filter(w => isLine(w) && ext(doc, w));
  if (!ws.length) return null;
  const key = p => `${Math.round(p.x / 5)},${Math.round(p.y / 5)}`;
  const at = new Map();
  for (const w of ws) for (const p of [w.a, w.b]) { const k = key(p); at.set(k, [...(at.get(k) || []), w]); }
  // walk from wall to wall through shared ends; the largest loop found is the outline
  let bestLoop = null;
  const used = new Set();
  for (const start of ws) {
    if (used.has(start)) continue;
    const pts = [start.a]; let cur = start, end = start.b; const seen = new Set([start]);
    for (let i = 0; i < ws.length; i++) {
      pts.push(end);
      if (G.dist(end, pts[0]) < 5) break;
      const next = (at.get(key(end)) || []).find(v => !seen.has(v));
      if (!next) break;
      seen.add(next); cur = next; end = G.dist(next.a, end) < 5 ? next.b : next.a;
    }
    seen.forEach(w => used.add(w));
    if (pts.length >= 4 && G.dist(pts.at(-1), pts[0]) < 5) {
      pts.pop();
      if (!bestLoop || Math.abs(G.polygonArea(pts)) > Math.abs(G.polygonArea(bestLoop))) bestLoop = pts;
    }
    void cur;
  }
  let loop = bestLoop;
  if (!loop) {
    const xs = ws.flatMap(w => [w.a.x, w.b.x]), ys = ws.flatMap(w => [w.a.y, w.b.y]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    if (x1 - x0 < 500 || y1 - y0 < 500) return null;
    loop = [G.P(x0, y0), G.P(x0, y1), G.P(x1, y1), G.P(x1, y0)];
  }
  return loop.map((p, i) => ({ shape: "line", a: { x: p.x, y: p.y }, b: { x: loop[(i + 1) % loop.length].x, y: loop[(i + 1) % loop.length].y } }));
}

/**
 * Makes the model ready for Ollic AI. history: the sketch's History (the fixes are one undoable step).
 * Returns { done: [plain words], issues: [what is still missing (nothing drawn yet)] }.
 */
export function prepareModel(history) {
  const doc = history.doc;
  if (!readiness(doc).length) return { done: [], issues: [] };
  const done = [];
  try {
    history.transact("Ollic AI: model made ready", d => {
      const before = new Map(d.walls.map(w => [w.id, JSON.parse(JSON.stringify(w))]));
      const levels = [...d.levels].sort((a, b) => a.elevation - b.elevation);
      for (const l of levels) {
        const walls = d.walls.filter(w => w.baseLevelId === l.id);
        if (!walls.some(w => ext(d, w))) continue;
        if (!freeEnds(d, walls).length) continue;
        let joined = 0, added = 0;
        // 1. outer walls drawn on a face (not the centre) are put on their centre line, in the same place
        for (const w of walls) {
          if (!isLine(w) || !ext(d, w) || (w.locationLine || "wall-centre") === "wall-centre") continue;
          const c = centrePolyline(w, wallType(d, w));
          w.a = { ...c[0] }; w.b = { ...c.at(-1) }; w.locationLine = "wall-centre";
        }
        // 2. ends trimmed or extended to meet the wall they almost meet
        for (let round = 0; round < 3; round++) {
          let changed = false;
          for (const { w, key } of freeEnds(d, walls)) {
            const hit = meetingPoint(d, w, key, walls);
            if (!hit) continue;
            w[key] = { x: hit.X.x, y: hit.X.y }; joined++; changed = true;
            // the other wall overshoots or falls short too: its nearer end goes to the same corner
            if (hit.u < 0 || hit.u > 1) { const k = hit.u < 0 ? "a" : "b"; hit.v[k] = { x: hit.X.x, y: hit.X.y }; }
          }
          if (!changed) break;
        }
        // 3. a gap still open: a wall across it, the same as the wall beside it
        for (let guard = 0; guard < 20; guard++) {
          const ends = freeEnds(d, walls);
          if (ends.length < 2) break;
          let pair = null;
          for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
            if (ends[i].w === ends[j].w) continue;
            const g = G.dist(ends[i].w[ends[i].key], ends[j].w[ends[j].key]);
            if (!pair || g < pair.g) pair = { i: ends[i], j: ends[j], g };
          }
          if (!pair || pair.g < 10) break;
          const s = pair.i.w, nw = makeWall(d, { typeId: s.typeId, a: s[pair.i.key], b: pair.j.w[pair.j.key], baseLevelId: s.baseLevelId, baseOffset: s.baseOffset,
            topLevelId: s.topLevelId, unconnectedHeight: s.unconnectedHeight, topOffset: s.topOffset });
          d.walls.push(nw); walls.push(nw); added++;
          done.push(`On ${l.name}, added a ${m(pair.g)} outer wall to close a gap.`);
        }
        if (joined) done.push(`On ${l.name}, joined ${joined} outer wall end${joined === 1 ? "" : "s"} at the corners.`);
        void added;
      }
      keepOpeningsInPlace(d, before);
      // 4. floors: every level with walls above the lowest, and the lowest when there is no floor or roof at all
      const withWalls = levels.filter(l => d.walls.some(w => w.baseLevelId === l.id));
      const need = withWalls.slice(1).filter(l => !d.floors.some(f => f.levelId === l.id));
      if (!d.floors.length && !d.roofs.length && withWalls[0]) need.unshift(withWalls[0]);
      for (const l of need) {
        const b = outline(d, d.walls.filter(w => w.baseLevelId === l.id));
        if (!b) continue;
        const ground = l === withWalls[0] && d.floorTypes.some(t => t.id === "ft-gfb150");
        d.floors.push(makeFloor(d, { levelId: l.id, typeId: ground ? "ft-gfb150" : "ft-rc150", boundary: b }));
        done.push(`Added a floor on ${l.name}, inside the outer walls.`);
      }
      if (!done.length) throw new Error("nothing");   // nothing changed: no empty undo step
    });
  } catch { /* nothing could be fixed by itself */ }
  return { done, issues: readiness(doc) };
}
