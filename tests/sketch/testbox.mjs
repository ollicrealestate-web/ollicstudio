// The test model for finishing details: a 10 x 8 m two-storey box (255 mm exterior walls), a 4 x 1.5 m balcony on
// Level 2 facing south, doors and windows, and a flat roof with a 600 mm overhang.
import * as G from "../../web/assets/sketch/geom.js";
import { newProject } from "../../web/assets/sketch/model.js";
import { makeWall } from "../../web/assets/sketch/walls.js";
import { makeFloor } from "../../web/assets/sketch/floors.js";
import { makeOpening } from "../../web/assets/sketch/openings.js";
import { makeRoof } from "../../web/assets/sketch/roofs.js";

const loop = pts => pts.map((p, i) => ({ shape: "line", a: G.P(...p), b: G.P(...pts[(i + 1) % pts.length]) }));
export function testBox() {
  const doc = newProject("Test box");
  doc.levels.push({ id: "lv-2", name: "Level 2", elevation: 3000 });
  // clockwise, so the exterior side is outside: west, north, east, south
  const ring = [[0, 0], [0, 8000], [10000, 8000], [10000, 0]], names = ["W", "N", "E", "S"];
  for (const [lv, top] of [["lv-1", "lv-2"], ["lv-2", null]]) ring.forEach((p, i) => {
    const w = makeWall(doc, { a: G.P(...p), b: G.P(...ring[(i + 1) % 4]), baseLevelId: lv, topLevelId: top, unconnectedHeight: 3000, typeId: "wt-ext225" });
    w.id = `${names[i]}${lv === "lv-1" ? 1 : 2}`; doc.walls.push(w);
  });
  const e = 127.5;
  const f1 = makeFloor(doc, { levelId: "lv-1", typeId: "ft-gfb150", boundary: loop([[-e, -e], [-e, 8000 + e], [10000 + e, 8000 + e], [10000 + e, -e]]) }); f1.id = "F1";
  const f2 = makeFloor(doc, { levelId: "lv-2", typeId: "ft-rc150", boundary: loop([[-e, -e], [3000, -e], [3000, -1500 - e], [7000, -1500 - e], [7000, -e], [10000 + e, -e], [10000 + e, 8000 + e], [-e, 8000 + e]]) }); f2.id = "F2";
  doc.floors.push(f1, f2);
  // south walls run from x = 10000 to 0: positions are measured from x = 10000
  const add = (kind, typeId, wall, pos, id) => { const o = makeOpening(doc, kind, typeId, wall, pos); o.id = id; doc.openings.push(o); };
  add("door", "dt-900", "S1", 5000, "D1"); add("window", "wn-1200", "S1", 2000, "WS1a"); add("window", "wn-1200", "S1", 8000, "WS1b");
  add("door", "dt-slide2400", "S2", 5000, "D2"); add("window", "wn-1200", "S2", 1500, "WS2a"); add("window", "wn-1200", "S2", 8500, "WS2b");
  add("window", "wn-1500", "N1", 5000, "WN1"); add("window", "wn-1500", "N2", 5000, "WN2");
  const o = 600 + e;
  const r = makeRoof(doc, { baseLevelId: "lv-2", baseOffset: 3000, boundary: loop([[-o, -o], [-o, 8000 + o], [10000 + o, 8000 + o], [10000 + o, -o]]).map(c => ({ ...c, definesSlope: false, overhang: 600 })) });
  r.id = "R1"; doc.roofs.push(r);
  return doc;
}
