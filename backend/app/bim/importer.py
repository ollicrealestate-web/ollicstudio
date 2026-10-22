"""IFC import (brief Module D, Phase 3): validation report, glTF (GLB) output, components.

Every element keeps its IFC GlobalId: it is the node name in the GLB and the key of
its component record, so later phases (sequence, animation, MEP view) all refer to the
same geometry. The GLB opens in the website's 3D viewer and imports into Blender.
"""

from __future__ import annotations

import io
import logging
import math
import re
import tempfile
from collections import Counter
from dataclasses import dataclass, field

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element
import ifcopenshell.util.unit
import numpy as np
import trimesh

log = logging.getLogger("ollic.ifc")

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


def import_ifc(data: bytes, progress=lambda stage: None) -> ImportResult:
    progress("Reading the IFC file")
    with tempfile.NamedTemporaryFile(suffix=".ifc") as tmp:
        tmp.write(data)
        tmp.flush()
        try:
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
    meshes: dict[str, trimesh.Trimesh] = {}
    no_geometry: list[str] = []
    it = ifcopenshell.geom.iterator(settings, f, include=products) if products else None
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
    if f.by_type("IfcMapConversion") or any(getattr(s, "RefLatitude", None) for s in f.by_type("IfcSite")):
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
    glb = _glb(meshes, {c["global_id"]: c for c in components}, lo, hi)

    status = "fail" if any(c["status"] == "fail" for c in checks) else "warn" if any(c["status"] == "warn" for c in checks) else "pass"
    report = {
        "status": status, "schema": schema, "units": unit_name, "checks": checks,
        "counts": dict(counts.most_common()), "families": dict(by_family), "storeys": [s.Name for s in storeys],
        "size_m": [round(float(x), 2) for x in size], "elements": len(products), "with_geometry": len(meshes),
    }
    return ImportResult(report=report, glb=glb, components=components,
                        stats={"elements": len(products), "with_geometry": len(meshes), "glb_bytes": len(glb), "mep": mep})


def _to_mesh(shape) -> trimesh.Trimesh:
    g = shape.geometry
    v = np.asarray(g.verts, dtype=np.float64).reshape(-1, 3)
    fc = np.asarray(g.faces, dtype=np.int64).reshape(-1, 3)
    mesh = trimesh.Trimesh(vertices=v, faces=fc, process=False)
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
    mesh.metadata["rgba"] = rgba
    mesh.metadata["ifc_type"] = shape.type
    return mesh


def _glb(meshes: dict[str, trimesh.Trimesh], comps: dict[str, dict], lo, hi) -> bytes:
    """One node per element, named by GlobalId, in glTF's y-up axes, centred on the site origin."""
    centre = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])
    to_y_up = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=float)
    shift = np.eye(4)
    shift[:3, 3] = -centre
    scene = trimesh.Scene()
    for gid, m in meshes.items():
        m = m.copy()
        m.apply_transform(to_y_up @ shift)
        c = comps.get(gid, {})
        rgba = m.metadata.get("rgba") or DEFAULT_COLOURS.get(c.get("ifc_type"), (0.8, 0.8, 0.8, 1))
        if c.get("ifc_type") == "IfcSpace":
            rgba = (rgba[0], rgba[1], rgba[2], min(rgba[3], 0.15))
        material = trimesh.visual.material.PBRMaterial(
            baseColorFactor=[float(x) for x in rgba], metallicFactor=0.0, roughnessFactor=0.85,
            alphaMode="BLEND" if rgba[3] < 0.99 else "OPAQUE", doubleSided=True)
        m.visual = trimesh.visual.TextureVisuals(material=material)
        extras = {"globalId": gid, "ifcType": c.get("ifc_type"), "name": c.get("name"), "storey": c.get("storey"), "family": c.get("family")}
        scene.add_geometry(m, node_name=gid, geom_name=gid, metadata=extras)
    buf = io.BytesIO()
    buf.write(scene.export(file_type="glb", include_normals=True))
    return buf.getvalue()
