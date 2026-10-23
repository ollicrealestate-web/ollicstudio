"""IFC import (brief Module D, Phase 3): validation report, glTF (GLB) output, components.

Every element keeps its IFC GlobalId: it is the node name in the GLB and the key of
its component record, so later phases (sequence, animation, MEP view) all refer to the
same geometry. The GLB opens in the website's 3D viewer and imports into Blender.
"""

from __future__ import annotations

import gc
import io
import json
import logging
import math
import os
import struct
import re
import tempfile
from collections import Counter
from dataclasses import dataclass, field

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element
import ifcopenshell.util.unit
import numpy as np

log = logging.getLogger("ollic.ifc")
THREADS = max(1, min(4, os.cpu_count() or 1))     # processors used to build the 3D shapes

SUPPORTED_SCHEMAS = ("IFC2X3", "IFC4", "IFC4X3")
GUID_RE = re.compile(r"^[0-9A-Za-z_$]{22}$")
# Element families shown in the viewer and counted in the report
FAMILIES = {
    "structure": ("IfcWall", "IfcSlab", "IfcColumn", "IfcBeam", "IfcFooting", "IfcPile", "IfcStair", "IfcRamp", "IfcRoof", "IfcMember", "IfcPlate"),
    "openings": ("IfcDoor", "IfcWindow"),
    "finishes": ("IfcCovering", "IfcRailing", "IfcCurtainWall"),
    "furniture": ("IfcFurnishingElement", "IfcFurniture"),
    "mep": ("IfcDistributionElement",),  # pipes, ducts, cables, fittings, terminals, equipment
    "spaces": ("IfcSpace",),
}
DEFAULT_COLOURS = {
    "IfcWall": (0.93, 0.92, 0.89, 1), "IfcSlab": (0.62, 0.61, 0.59, 1), "IfcRoof": (0.36, 0.33, 0.32, 1),
    "IfcDoor": (0.45, 0.30, 0.18, 1), "IfcWindow": (0.55, 0.72, 0.85, 0.45), "IfcSpace": (0.85, 0.85, 0.95, 0.15),
    "IfcColumn": (0.7, 0.7, 0.7, 1), "IfcBeam": (0.7, 0.7, 0.7, 1), "IfcStair": (0.75, 0.74, 0.72, 1),
    "IfcFooting": (0.6, 0.6, 0.58, 1), "IfcPile": (0.6, 0.6, 0.58, 1), "IfcFurniture": (0.72, 0.62, 0.5, 1),
    "IfcFurnishingElement": (0.72, 0.62, 0.5, 1), "IfcRailing": (0.4, 0.4, 0.42, 1), "IfcCurtainWall": (0.55, 0.72, 0.85, 0.45),
}
MAX_ELEMENTS = 20000  # beyond this the free web service runs out of memory; larger models wait for the Phase 5 worker


class ImportFailed(Exception):
    """The file cannot be processed. `message` is safe to show to the customer."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


@dataclass
class ImportResult:
    report: dict
    glb: bytes
    components: list[dict]
    stats: dict = field(default_factory=dict)


def family_of(element) -> str:
    for fam, classes in FAMILIES.items():
        if any(element.is_a(c) for c in classes):
            return fam
    return "other"


def _check(checks: list, key: str, status: str, message: str, **extra):
    checks.append({"key": key, "status": status, "message": message, **extra})


def _jsonable(v):
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v if not (isinstance(v, float) and not math.isfinite(v)) else None
    return str(v)[:200]


def import_ifc(data: bytes | str, progress=lambda stage: None) -> ImportResult:
    """data: the IFC's bytes, or the path of a file holding them (less memory for large models)."""
    progress("Reading the IFC file")
    try:
        if isinstance(data, str):
            f = ifcopenshell.open(data)
        else:
            with tempfile.NamedTemporaryFile(suffix=".ifc") as tmp:
                tmp.write(data)
                tmp.flush()
                f = ifcopenshell.open(tmp.name)
    except Exception as exc:
        raise ImportFailed("The IFC file could not be read. It may be damaged or cut off. Export it from Revit again (File > Export > IFC).") from exc

    checks: list[dict] = []
    schema = f.schema_identifier if hasattr(f, "schema_identifier") else f.schema
    base = schema.upper().split("_")[0]
    if not any(base.startswith(s) for s in SUPPORTED_SCHEMAS):
        raise ImportFailed(f"This IFC uses the {schema} schema. Ollic reads IFC2X3, IFC4 and IFC4X3.")
    _check(checks, "schema", "pass", f"Schema {schema}")

    projects = f.by_type("IfcProject")
    if not projects:
        raise ImportFailed("The file has no IfcProject, so it is not a complete building model. Export the whole model from Revit.")
    _check(checks, "project", "pass", f"Project: {projects[0].Name or 'unnamed'}")

    scale = ifcopenshell.util.unit.calculate_unit_scale(f)  # file length unit -> metres
    unit_name = {1.0: "metres", 0.001: "millimetres", 0.01: "centimetres", 0.3048: "feet", 0.0254: "inches"}.get(round(scale, 6), f"{scale} m per unit")
    _check(checks, "units", "pass", f"Lengths in {unit_name}")

    storeys = sorted(f.by_type("IfcBuildingStorey"), key=lambda s: float(s.Elevation or 0))
    if storeys:
        _check(checks, "storeys", "pass", f"{len(storeys)} storey{'s' if len(storeys) != 1 else ''}: " + ", ".join(s.Name or "unnamed" for s in storeys[:8]))
    else:
        _check(checks, "storeys", "warn", "No storeys are defined, so the model cannot be split by floor.")

    products = [p for p in f.by_type("IfcProduct") if not p.is_a("IfcOpeningElement") and not p.is_a("IfcSpatialStructureElement") and not p.is_a("IfcAnnotation") and not p.is_a("IfcGrid")]
    spaces = f.by_type("IfcSpace")
    products += [s for s in spaces if s not in products]
    if len(products) > MAX_ELEMENTS:
        raise ImportFailed(f"This model has {len(products):,} elements. Ollic currently imports up to {MAX_ELEMENTS:,}; larger models need the processing worker that arrives with Phase 5.")

    ids = [p.GlobalId for p in products]
    dupes = [g for g, n in Counter(ids).items() if n > 1]
    bad = [g for g in ids if not GUID_RE.match(g or "")]
    if dupes or bad:
        _check(checks, "global_ids", "warn", f"{len(dupes)} duplicated and {len(bad)} malformed GlobalIds. Those elements may not animate reliably.", examples=(dupes + bad)[:5])
    else:
        _check(checks, "global_ids", "pass", f"All {len(ids):,} GlobalIds are present and unique")

    counts = Counter(p.is_a() for p in products)
    by_family = Counter(family_of(p) for p in products)
    if not (counts.get("IfcWall", 0) + counts.get("IfcWallStandardCase", 0)) and not counts.get("IfcSlab", 0):
        _check(checks, "elements", "fail", "No walls or slabs were found. Ollic needs at least the building's walls or floors.")
    else:
        _check(checks, "elements", "pass", f"{sum(counts.values()):,} elements", by_type=dict(counts.most_common()))
    mep = by_family.get("mep", 0)
    _check(checks, "mep", "pass" if mep else "info",
           f"{mep:,} modelled MEP elements (pipes, ducts, cables, fittings, equipment)" if mep else
           "No MEP elements are modelled in this file. The MEP view will say so rather than invent services.")

    # ---------------------------------------------------------------- geometry
    progress("Building the 3D geometry")
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    settings.set("weld-vertices", False)
    try:
        settings.set("apply-default-materials", True)
    except Exception:
        pass
    wanted = {p.id() for p in products}
    meshes: dict[str, _Mesh] = {}
    no_geometry: list[str] = []
    it = ifcopenshell.geom.iterator(settings, f, THREADS, include=products) if products else None
    if it is not None and it.initialize():
        while True:
            shape = it.get()
            if shape.id in wanted:
                try:
                    meshes[shape.guid] = _to_mesh(shape)
                except Exception:
                    log.exception("could not convert geometry of %s", shape.guid)
            if not it.next():
                break
    with_geometry = set(meshes)
    no_geometry = [p.GlobalId for p in products if p.GlobalId not in with_geometry and p.Representation is not None]
    if not meshes:
        raise ImportFailed("None of the elements have geometry Ollic can display. Check that the export includes 3D views (Revit: IFC export setup > Geometry).")
    if no_geometry:
        _check(checks, "geometry", "warn", f"{len(no_geometry):,} elements have shapes that could not be converted and are not shown.", examples=no_geometry[:5])
    else:
        _check(checks, "geometry", "pass", f"Geometry built for {len(meshes):,} elements")

    bounds = np.array([m.bounds for m in meshes.values()])
    lo, hi = bounds[:, 0].min(axis=0), bounds[:, 1].max(axis=0)
    size = hi - lo  # metres (IFC: z up)
    if max(size) > 500:
        _check(checks, "size", "warn", f"The model is {size[0]:.0f} x {size[1]:.0f} m across, which is large for a building. Check the export units.")
    elif max(size) < 2:
        _check(checks, "size", "warn", f"The model is only {size[0]:.2f} x {size[1]:.2f} m across. Check the export units.")
    else:
        _check(checks, "size", "pass", f"Building is {size[0]:.1f} m x {size[1]:.1f} m and {size[2]:.1f} m tall")
    try:
        mapped = bool(f.by_type("IfcMapConversion"))      # IFC4 and later only
    except RuntimeError:                                  # IFC2X3 has no such entity
        mapped = False
    if mapped or any(getattr(s, "RefLatitude", None) for s in f.by_type("IfcSite")):
        _check(checks, "location", "pass", "The model is georeferenced")
    else:
        _check(checks, "location", "info", "The model is not georeferenced. You can place it on the map later (Google Earth site view).")

    # ---------------------------------------------------------------- components and GLB
    progress("Writing the 3D model")
    components = []
    for p in products:
        storey = ifcopenshell.util.element.get_container(p) if not p.is_a("IfcSpace") else ifcopenshell.util.element.get_aggregate(p)
        psets = ifcopenshell.util.element.get_psets(p, psets_only=True)
        props = {f"{ps}.{k}": _jsonable(v) for ps, vals in psets.items() if ps in ("Pset_WallCommon", "Pset_DoorCommon", "Pset_WindowCommon", "Pset_SlabCommon", "Ollic_Layout", "Qto_SpaceBaseQuantities_Ollic")
                 for k, v in vals.items() if k != "id"}
        components.append({
            "global_id": p.GlobalId, "ifc_type": p.is_a(), "name": (p.Name or "")[:200] or None, "family": family_of(p),
            "storey": (storey.Name if storey is not None and storey.is_a("IfcBuildingStorey") else None),
            "has_geometry": p.GlobalId in with_geometry, "properties": props,
        })
    kinds = {}
    for p in products:  # e.g. BASESLAB, ROOF, STRIP_FOOTING: tells the construction animation what a slab is
        try:
            kinds[p.GlobalId] = ifcopenshell.util.element.get_predefined_type(p)
        except Exception:
            kinds[p.GlobalId] = None
    n_elements, n_geometry = len(products), len(meshes)
    comps = {c["global_id"]: {**c, "predefined": kinds.get(c["global_id"])} for c in components}
    storey_names = [s.Name for s in storeys]
    # the IFC itself is no longer needed: free it before the 3D file is written
    del f, it, products, spaces, storeys, settings
    gc.collect()
    glb = _glb(meshes, comps, lo, hi)
    meshes.clear()

    status = "fail" if any(c["status"] == "fail" for c in checks) else "warn" if any(c["status"] == "warn" for c in checks) else "pass"
    report = {
        "status": status, "schema": schema, "units": unit_name, "checks": checks,
        "counts": dict(counts.most_common()), "families": dict(by_family), "storeys": storey_names,
        "size_m": [round(float(x), 2) for x in size], "elements": n_elements, "with_geometry": n_geometry,
    }
    return ImportResult(report=report, glb=glb, components=components,
                        stats={"elements": n_elements, "with_geometry": n_geometry, "glb_bytes": len(glb), "mep": mep})


class _Mesh:
    """One element's triangles, kept small: float32 corners and uint32 corner numbers."""
    __slots__ = ("verts", "faces", "rgba", "ifc_type")

    def __init__(self, verts, faces, rgba, ifc_type):
        self.verts, self.faces, self.rgba, self.ifc_type = verts, faces, rgba, ifc_type

    @property
    def bounds(self):
        return np.array([self.verts.min(axis=0), self.verts.max(axis=0)])


def _to_mesh(shape) -> _Mesh:
    g = shape.geometry
    v = np.asarray(g.verts, dtype=np.float32).reshape(-1, 3)
    fc = np.asarray(g.faces, dtype=np.uint32).reshape(-1, 3)
    if not len(v) or not len(fc):
        raise ValueError("empty geometry")
    rgba = None
    mats = list(g.materials)
    if mats:
        m = mats[0]
        try:
            d = m.diffuse
            r, gg, b = (d.r(), d.g(), d.b()) if callable(getattr(d, "r", None)) else tuple(d)[:3]
            t = float(getattr(m, "transparency", 0.0) or 0.0)
            rgba = (r, gg, b, 1 - t if t == t else 1.0)
        except Exception:
            rgba = None
    return _Mesh(v, fc, rgba, shape.type)


def _glb(meshes: dict[str, _Mesh], comps: dict[str, dict], lo, hi) -> bytes:
    """One node per element, named by GlobalId, in glTF's y-up axes, centred on the site origin.
    Written directly (no scene library copy), so a large model needs little memory beyond its
    triangles. Normals are left out: every triangle has its own corners, so the viewer works out
    flat normals itself, and the file is a third smaller."""
    cx, cy, cz = float((lo[0] + hi[0]) / 2), float((lo[1] + hi[1]) / 2), float(lo[2])
    chunks, views, accessors, gl_meshes, nodes, materials, mat_index = [], [], [], [], [], [], {}
    offset = 0

    def add(arr: np.ndarray, target: int) -> int:
        nonlocal offset
        b = arr.tobytes()
        pad = (-len(b)) % 4
        chunks.append(b + b"\0" * pad)
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(b), "target": target})
        offset += len(b) + pad
        return len(views) - 1

    for gid, m in meshes.items():
        c = comps.get(gid, {})
        rgba = m.rgba or DEFAULT_COLOURS.get(c.get("ifc_type"), (0.8, 0.8, 0.8, 1))
        if c.get("ifc_type") == "IfcSpace":
            rgba = (rgba[0], rgba[1], rgba[2], min(rgba[3], 0.15))
        rgba = tuple(round(float(x), 4) for x in rgba)
        if rgba not in mat_index:
            mat_index[rgba] = len(materials)
            materials.append({"pbrMetallicRoughness": {"baseColorFactor": list(rgba), "metallicFactor": 0.0, "roughnessFactor": 0.85},
                              "alphaMode": "BLEND" if rgba[3] < 0.99 else "OPAQUE", "doubleSided": True})
        # IFC is z-up; glTF is y-up: (x, y, z) -> (x - cx, z - cz, -(y - cy))
        v = np.empty_like(m.verts)
        v[:, 0] = m.verts[:, 0] - cx
        v[:, 1] = m.verts[:, 2] - cz
        v[:, 2] = cy - m.verts[:, 1]
        pos = len(accessors)
        accessors.append({"bufferView": add(v, 34962), "componentType": 5126, "count": int(len(v)), "type": "VEC3",
                          "min": [float(x) for x in v.min(axis=0)], "max": [float(x) for x in v.max(axis=0)]})
        idx = m.faces.ravel().astype(np.uint16) if len(v) < 65536 else m.faces.ravel()
        accessors.append({"bufferView": add(idx, 34963), "componentType": 5123 if idx.dtype == np.uint16 else 5125, "count": int(idx.size), "type": "SCALAR"})
        gl_meshes.append({"name": gid, "primitives": [{"attributes": {"POSITION": pos}, "indices": pos + 1, "material": mat_index[rgba]}]})
        extras = {"globalId": gid, "ifcType": c.get("ifc_type"), "name": c.get("name"), "storey": c.get("storey"), "family": c.get("family"),
                  "predefined": c.get("predefined")}
        nodes.append({"name": gid, "mesh": len(gl_meshes) - 1, "extras": extras})
    doc = {"asset": {"version": "2.0", "generator": "Ollic Design Studio"}, "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}],
           "nodes": nodes, "meshes": gl_meshes, "materials": materials, "accessors": accessors, "bufferViews": views,
           "buffers": [{"byteLength": offset}]}
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    out = io.BytesIO()
    out.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + offset))
    out.write(struct.pack("<I4s", len(js), b"JSON")); out.write(js)
    out.write(struct.pack("<I4s", offset, b"BIN\0"))
    for b in chunks:
        out.write(b)
    chunks.clear()
    return out.getvalue()
