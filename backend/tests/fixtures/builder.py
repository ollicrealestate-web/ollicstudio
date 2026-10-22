"""Parametric builder: a confirmed Layout becomes a simple, valid IFC4 file (brief Module B2).

Walls are extruded from their centre lines with their thickness; doors and windows cut
real openings (IfcOpeningElement, IfcRelVoidsElement, IfcRelFillsElement); each storey
gets a floor slab; the roof is flat, gable or hip; each room is an IfcSpace with its name.
GlobalIds are derived from the draft id and each element's id, so rebuilding the same
layout keeps the same ids, which the construction animation relies on (brief test 8).
"""

from __future__ import annotations

import math
import uuid

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.guid
import numpy as np
from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.ops import polygonize, unary_union

from .layout import Layout, Wall

GUID_NAMESPACE = uuid.UUID("6f1c3b2e-6a3d-4d5e-9a49-0c1e0d0a7a11")
COLOURS = {  # name: (rgb 0-1, transparency)
    "exterior wall": ((0.93, 0.92, 0.89), 0.0),
    "interior wall": ((0.97, 0.96, 0.94), 0.0),
    "slab": ((0.62, 0.61, 0.59), 0.0),
    "roof": ((0.36, 0.33, 0.32), 0.0),
    "door": ((0.45, 0.30, 0.18), 0.0),
    "window": ((0.55, 0.72, 0.85), 0.55),
    "space": ((0.85, 0.85, 0.95), 0.85),
}


def run(cmd: str, f, **kw):
    return ifcopenshell.api.run(cmd, f, **kw)


class Builder:
    def __init__(self, layout: Layout, seed: str):
        self.L = layout
        self.seed = seed
        self.f = ifcopenshell.file(schema="IFC4")
        self.styles: dict[str, object] = {}

    # ------------------------------------------------------------ helpers
    def guid(self, key: str) -> str:
        return ifcopenshell.guid.compress(uuid.uuid5(GUID_NAMESPACE, f"{self.seed}:{key}").hex)

    def entity(self, ifc_class: str, key: str, name: str | None = None, predefined_type: str | None = None):
        e = run("root.create_entity", self.f, ifc_class=ifc_class, name=name, predefined_type=predefined_type)
        e.GlobalId = self.guid(key)
        return e

    def place(self, product, origin, x_axis=(1.0, 0.0, 0.0)):
        x = np.array(x_axis, dtype=float)
        x /= np.linalg.norm(x)
        z = np.array([0.0, 0.0, 1.0])
        y = np.cross(z, x)
        m = np.eye(4)
        m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, y, z, origin
        run("geometry.edit_object_placement", self.f, product=product, matrix=m)

    def style(self, name: str):
        if name not in self.styles:
            (r, g, b), transparency = COLOURS[name]
            s = run("style.add_style", self.f, name=name.title())
            run("style.add_surface_style", self.f, style=s, ifc_class="IfcSurfaceStyleShading",
                attributes={"SurfaceColour": {"Name": None, "Red": r, "Green": g, "Blue": b}, "Transparency": transparency})
            self.styles[name] = s
        return self.styles[name]

    def show(self, product, rep, style: str):
        run("geometry.assign_representation", self.f, product=product, representation=rep)
        run("style.assign_representation_styles", self.f, shape_representation=rep, styles=[self.style(style)])

    def pset(self, product, name: str, props: dict):
        p = run("pset.add_pset", self.f, product=product, name=name)
        run("pset.edit_pset", self.f, pset=p, properties=props)

    def mesh_rep(self, verts: list[tuple[float, float, float]], faces: list[tuple[int, int, int]]):
        pts = self.f.createIfcCartesianPointList3D([tuple(map(float, v)) for v in verts])
        tfs = self.f.createIfcTriangulatedFaceSet(pts, None, True, [tuple(i + 1 for i in fc) for fc in faces], None)
        return self.f.createIfcShapeRepresentation(self.body, "Body", "Tessellation", [tfs])

    # ------------------------------------------------------------ build
    def build(self) -> ifcopenshell.file:
        f, L = self.f, self.L
        project = self.entity("IfcProject", "project", L.name)
        # metres throughout (the API's default is millimetres; raw coordinates below are in metres)
        run("unit.assign_unit", f, length={"is_metric": True, "raw": "METERS"}, area={"is_metric": True, "raw": "SQUARE_METERS"},
            volume={"is_metric": True, "raw": "CUBIC_METERS"})
        model = run("context.add_context", f, context_type="Model")
        self.body = run("context.add_context", f, context_type="Model", context_identifier="Body", target_view="MODEL_VIEW", parent=model)
        site = self.entity("IfcSite", "site", "Site")
        building = self.entity("IfcBuilding", "building", L.name)
        run("aggregate.assign_object", f, products=[site], relating_object=project)
        run("aggregate.assign_object", f, products=[building], relating_object=site)
        self.storeys = []
        for i, lv in enumerate(L.levels):
            st = self.entity("IfcBuildingStorey", f"storey:{i}", lv.name)
            st.Elevation = lv.elevation
            run("aggregate.assign_object", f, products=[st], relating_object=building)
            self.place(st, (0, 0, lv.elevation))
            self.storeys.append(st)

        walls = {}
        for w in L.walls:
            walls[w.id] = self.wall(w)
        for o in L.openings:
            self.opening(o, L.walls[[w.id for w in L.walls].index(o.wall)], walls[o.wall])
        for i, lv in enumerate(L.levels):
            self.slab(i)
        for r in L.rooms:
            self.room(r)
        self.roof()
        return f

    def outline(self, level: int, grow: float = 0.0) -> Polygon:
        """The storey's footprint: the area enclosed by its exterior walls (or all walls), to their outer faces."""
        ws = [w for w in self.L.walls if w.level == level]
        ext = [w for w in ws if w.exterior] or ws
        lines = [LineString([w.a, w.b]) for w in ext]
        polys = list(polygonize(unary_union(lines)))
        if polys:
            shape = unary_union(polys)
        else:  # walls do not close: fall back to their bounding box
            xs = [p[0] for w in ws for p in (w.a, w.b)]
            ys = [p[1] for w in ws for p in (w.a, w.b)]
            shape = Polygon([(min(xs), min(ys)), (max(xs), min(ys)), (max(xs), max(ys)), (min(xs), max(ys))])
        t = max(w.thickness for w in ext) / 2
        shape = shape.buffer(t + grow, join_style=2)
        if isinstance(shape, MultiPolygon):
            shape = max(shape.geoms, key=lambda g: g.area)
        return shape

    def wall(self, w: Wall):
        lv = self.L.levels[w.level]
        e = self.entity("IfcWall", f"wall:{w.id}", f"{'Exterior' if w.exterior else 'Interior'} wall {w.id}", "STANDARD" if w.exterior else "PARTITIONING")
        # extend each wall by half its thickness at both ends so corners close
        ax, ay = w.a
        bx, by = w.b
        dx, dy = (bx - ax) / w.length, (by - ay) / w.length
        ext = w.thickness / 2
        origin = (ax - dx * ext, ay - dy * ext, lv.elevation)
        rep = run("geometry.add_wall_representation", self.f, context=self.body, length=w.length + 2 * ext, height=lv.height,
                  thickness=w.thickness, offset=-w.thickness / 2)
        self.show(e, rep, "exterior wall" if w.exterior else "interior wall")
        self.place(e, origin, (dx, dy, 0))
        run("spatial.assign_container", self.f, products=[e], relating_structure=self.storeys[w.level])
        self.pset(e, "Pset_WallCommon", {"IsExternal": w.exterior, "LoadBearing": w.exterior})
        self.pset(e, "Ollic_Layout", {"LayoutId": w.id, "Source": w.source, "ThicknessM": round(w.thickness, 3)})
        return e

    def opening(self, o, w: Wall, wall_entity):
        lv = self.L.levels[w.level]
        ax, ay = w.a
        dx, dy = (w.b[0] - ax) / w.length, (w.b[1] - ay) / w.length
        start = o.offset - o.width / 2
        origin = (ax + dx * start, ay + dy * start, lv.elevation + o.sill)
        void = self.entity("IfcOpeningElement", f"opening:{o.id}", f"Opening {o.id}", "OPENING")
        depth = w.thickness + 0.2
        vrep = run("geometry.add_wall_representation", self.f, context=self.body, length=o.width, height=o.height, thickness=depth, offset=-depth / 2)
        run("geometry.assign_representation", self.f, product=void, representation=vrep)
        self.place(void, origin, (dx, dy, 0))
        run("feature.add_feature", self.f, feature=void, element=wall_entity)

        cls = "IfcDoor" if o.kind == "door" else "IfcWindow"
        panel = self.entity(cls, f"{o.kind}:{o.id}", f"{o.kind.title()} {o.id}", "DOOR" if o.kind == "door" else "WINDOW")
        panel.OverallWidth, panel.OverallHeight = o.width, o.height
        pt = 0.05 if o.kind == "door" else 0.03
        prep = run("geometry.add_wall_representation", self.f, context=self.body, length=o.width, height=o.height, thickness=pt, offset=-pt / 2)
        self.show(panel, prep, o.kind)
        self.place(panel, origin, (dx, dy, 0))
        run("feature.add_filling", self.f, opening=void, element=panel)
        run("spatial.assign_container", self.f, products=[panel], relating_structure=self.storeys[w.level])
        self.pset(panel, "Ollic_Layout", {"LayoutId": o.id, "Source": o.source, "SillHeightM": round(o.sill, 3)})

    def slab(self, level: int):
        lv = self.L.levels[level]
        poly = self.outline(level)
        t = self.L.slab_thickness
        e = self.entity("IfcSlab", f"slab:{level}", f"{lv.name} slab", "FLOOR" if level else "BASESLAB")
        rep = run("geometry.add_slab_representation", self.f, context=self.body, depth=t,
                  polyline=[(float(x), float(y)) for x, y in list(poly.exterior.coords)[:-1]])
        self.show(e, rep, "slab")
        self.place(e, (0, 0, lv.elevation - t))
        run("spatial.assign_container", self.f, products=[e], relating_structure=self.storeys[level])

    def room(self, r):
        lv = self.L.levels[r.level]
        e = self.entity("IfcSpace", f"space:{r.id}", r.name, "INTERNAL")
        e.LongName = r.name
        rep = run("geometry.add_slab_representation", self.f, context=self.body, depth=lv.height - 0.05,
                  polyline=[(float(x), float(y)) for x, y in r.polygon])
        self.show(e, rep, "space")
        self.place(e, (0, 0, lv.elevation))
        run("aggregate.assign_object", self.f, products=[e], relating_object=self.storeys[r.level])
        area = Polygon(r.polygon).area
        self.pset(e, "Qto_SpaceBaseQuantities_Ollic", {"NetFloorAreaM2": round(area, 2), "LabelledAreaM2": r.area_label or 0.0})
        self.pset(e, "Ollic_Layout", {"LayoutId": r.id, "Source": r.source})

    def roof(self):
        L = self.L
        top_i = len(L.levels) - 1
        top = L.levels[top_i]
        z0 = top.elevation + top.height
        poly = self.outline(top_i, grow=L.roof.overhang)
        e = self.entity("IfcRoof", "roof", "Roof", {"flat": "FLAT_ROOF", "gable": "GABLE_ROOF", "hip": "HIP_ROOF"}[L.roof.type])
        run("spatial.assign_container", self.f, products=[e], relating_structure=self.storeys[top_i])
        if L.roof.type == "flat" or L.roof.pitch < 3:
            rep = run("geometry.add_slab_representation", self.f, context=self.body, depth=0.25,
                      polyline=[(float(x), float(y)) for x, y in list(poly.exterior.coords)[:-1]])
            self.show(e, rep, "roof")
            self.place(e, (0, 0, z0))
            return
        minx, miny, maxx, maxy = poly.bounds  # pitched roofs cover the footprint's bounding rectangle (version 1)
        along_x = (maxx - minx) >= (maxy - miny)
        span = (maxy - miny) if along_x else (maxx - minx)
        rise = span / 2 * math.tan(math.radians(L.roof.pitch))
        if along_x:
            midy = (miny + maxy) / 2
            inset = span / 2 if L.roof.type == "hip" else 0
            ridge = [(minx + inset, midy, z0 + rise), (maxx - inset, midy, z0 + rise)]
            eaves = [(minx, miny, z0), (maxx, miny, z0), (maxx, maxy, z0), (minx, maxy, z0)]
        else:
            midx = (minx + maxx) / 2
            inset = span / 2 if L.roof.type == "hip" else 0
            ridge = [(midx, miny + inset, z0 + rise), (midx, maxy - inset, z0 + rise)]
            eaves = [(maxx, miny, z0), (maxx, maxy, z0), (minx, maxy, z0), (minx, miny, z0)]
        v = eaves + ridge  # 0..3 eaves (counter-clockwise from the start of the long side), 4..5 ridge
        faces = [
            (0, 1, 5), (0, 5, 4),   # long side 1
            (2, 3, 4), (2, 4, 5),   # long side 2
            (3, 0, 4), (1, 2, 5),   # ends: hipped slopes or gable triangles
            (0, 2, 1), (0, 3, 2),   # underside
        ]
        self.show(e, self.mesh_rep(v, faces), "roof")


def build_ifc(layout: Layout, seed: str) -> bytes:
    f = Builder(layout, seed).build()
    return f.to_string().encode()
