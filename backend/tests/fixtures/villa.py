"""A two-storey villa with everything a construction animation shows: strip footings, a
base slab, columns, beams, floor slabs, walls, doors, windows, a stair, a gable roof, rooms
and furniture. Used by tests and as a demo model. Built like a Revit export: elements are
contained in their storeys and carry their IFC predefined types."""

from __future__ import annotations

from .builder import Builder, COLOURS
from .layout import Layout, Level, Opening, Roof, Room, Wall

COLOURS.update({
    "concrete": ((0.66, 0.66, 0.64), 0.0),
    "steel": ((0.42, 0.44, 0.47), 0.0),
    "timber": ((0.62, 0.45, 0.30), 0.0),
    "fabric": ((0.80, 0.76, 0.68), 0.0),
    "stone": ((0.88, 0.87, 0.84), 0.0),
})

W, D = 12.0, 9.0
GROUND, FIRST = 0.0, 3.3
H = 3.0


def villa_layout() -> Layout:
    t, ti = 0.23, 0.15
    walls, openings, rooms = [], [], []
    for lv in (0, 1):
        p = "g" if lv == 0 else "f"
        walls += [
            Wall(id=f"{p}n", level=lv, a=(0, D), b=(W, D), thickness=t, exterior=True),
            Wall(id=f"{p}e", level=lv, a=(W, D), b=(W, 0), thickness=t, exterior=True),
            Wall(id=f"{p}s", level=lv, a=(W, 0), b=(0, 0), thickness=t, exterior=True),
            Wall(id=f"{p}w", level=lv, a=(0, 0), b=(0, D), thickness=t, exterior=True),
            Wall(id=f"{p}i1", level=lv, a=(7, 0), b=(7, D), thickness=ti),
        ]
        openings += [
            Opening(id=f"{p}-w1", wall=f"{p}s", kind="window", offset=W - 3.5, width=2.4, height=1.6, sill=0.8),
            Opening(id=f"{p}-w2", wall=f"{p}s", kind="window", offset=W - 9.5, width=1.8, height=1.4, sill=0.9),
            Opening(id=f"{p}-w3", wall=f"{p}n", kind="window", offset=3.0, width=1.5, height=1.2, sill=1.0),
            Opening(id=f"{p}-w4", wall=f"{p}e", kind="window", offset=4.5, width=1.5, height=1.4, sill=0.9),
            Opening(id=f"{p}-d1", wall=f"{p}i1", kind="door", offset=3.0, width=0.9, height=2.1),
        ]
    openings.append(Opening(id="front", wall="gs", kind="door", offset=W - 6.2, width=1.2, height=2.3))
    rooms = [
        Room(id="living", level=0, name="Living room", polygon=[(0, 0), (7, 0), (7, D), (0, D)]),
        Room(id="kitchen", level=0, name="Kitchen", polygon=[(7, 0), (W, 0), (W, D), (7, D)]),
        Room(id="master", level=1, name="Master bedroom", polygon=[(0, 0), (7, 0), (7, D), (0, D)]),
        Room(id="bed2", level=1, name="Bedroom 2", polygon=[(7, 0), (W, 0), (W, D), (7, D)]),
    ]
    return Layout(name="Two-storey villa", levels=[Level(name="Ground floor", elevation=GROUND, height=H), Level(name="First floor", elevation=FIRST, height=H)],
                  walls=walls, openings=openings, rooms=rooms, roof=Roof(type="gable", pitch=28, overhang=0.6))


def box(x0, y0, z0, x1, y1, z1):
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    return v, f


class VillaBuilder(Builder):
    def part(self, cls, key, name, predefined, boxes, style, level):
        e = self.entity(cls, key, name, predefined)
        verts, faces = [], []
        for b in boxes:
            v, f = box(*b)
            faces += [tuple(i + len(verts) for i in fc) for fc in f]
            verts += v
        self.show(e, self.mesh_rep(verts, faces), style)
        self.place(e, (0, 0, 0))
        from .builder import run
        run("spatial.assign_container", self.f, products=[e], relating_structure=self.storeys[level])
        return e

    def build(self):
        f = super().build()
        # foundations: strip footings under the outer walls, below the base slab
        z0, z1 = -0.75, -0.15
        strips = [(-0.4, -0.4, z0, W + 0.4, 0.4, z1), (-0.4, D - 0.4, z0, W + 0.4, D + 0.4, z1),
                  (-0.4, -0.4, z0, 0.4, D + 0.4, z1), (W - 0.4, -0.4, z0, W + 0.4, D + 0.4, z1)]
        for i, b in enumerate(strips):
            self.part("IfcFooting", f"footing:{i}", f"Strip footing {i + 1}", "STRIP_FOOTING", [b], "concrete", 0)
        cols = [(0, 0), (W, 0), (W, D), (0, D), (7, 0), (7, D)]
        for lv, base in ((0, GROUND), (1, FIRST)):
            for i, (x, y) in enumerate(cols):
                self.part("IfcColumn", f"column:{lv}:{i}", f"Column C{i + 1}", "COLUMN", [(x - 0.15, y - 0.15, base, x + 0.15, y + 0.15, base + H)], "concrete", lv)
            top = base + H
            for i, (a, b) in enumerate(zip(cols[:4], cols[1:4] + cols[:1])):
                (xa, ya), (xb, yb) = a, b
                bx = (min(xa, xb) - 0.12, min(ya, yb) - 0.12, top - 0.45, max(xa, xb) + 0.12, max(ya, yb) + 0.12, top)
                self.part("IfcBeam", f"beam:{lv}:{i}", f"Beam B{i + 1}", "BEAM", [bx], "concrete", lv)
        steps = [(9.5, 6.0 + 0.0, 0.0, 11.5, 6.0 + 0.28 * (k + 1), 0.18 * (k + 1)) for k in range(11)]
        self.part("IfcStair", "stair", "Main stair", "STRAIGHT_RUN_STAIR", steps, "stone", 0)
        furniture = [
            ("Sofa", 0, [(1.0, 1.0, 0, 3.4, 1.9, 0.45), (1.0, 1.0, 0, 3.4, 1.2, 0.85)], "fabric"),
            ("Coffee table", 0, [(1.6, 2.6, 0, 2.9, 3.4, 0.42)], "timber"),
            ("Dining table", 0, [(3.5, 5.5, 0, 5.5, 6.6, 0.75)], "timber"),
            ("Kitchen counter", 0, [(7.3, 0.4, 0, 9.5, 1.0, 0.9)], "stone"),
            ("Kitchen island", 0, [(8.0, 3.0, 0, 9.8, 4.0, 0.9)], "stone"),
            ("King bed", 1, [(1.5, 3.0, FIRST, 3.5, 5.2, FIRST + 0.55), (1.5, 5.1, FIRST, 3.5, 5.3, FIRST + 1.1)], "fabric"),
            ("Wardrobe", 1, [(4.5, 8.2, FIRST, 6.6, 8.8, FIRST + 2.2)], "timber"),
            ("Single bed", 1, [(8.0, 1.0, FIRST, 9.0, 3.0, FIRST + 0.5)], "fabric"),
            ("Desk", 1, [(10.0, 4.0, FIRST, 11.6, 4.7, FIRST + 0.75)], "timber"),
        ]
        for i, (name, lv, boxes, style) in enumerate(furniture):
            self.part("IfcFurniture", f"furniture:{i}", name, "NOTDEFINED", boxes, style, lv)
        return f


def build_villa_ifc(seed: str = "villa") -> bytes:
    return VillaBuilder(villa_layout(), seed).build().to_string().encode()
