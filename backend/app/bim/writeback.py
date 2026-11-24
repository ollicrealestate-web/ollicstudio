"""The architect's IFC with the materials chosen in the 3D preview written back into it.

Only materials and styles change, never geometry: each changed element gets an IfcMaterial named after the library
material (when it had a single material or none; a layered wall keeps its layers), its surface style colour on the
shapes it applies to (a whole element, or only the parts that showed a given style or colour, e.g. the glass of a
window), and a Pset_OllicMaterial with the texture's name, size, rotation and tint. One face of a wall (outside or
inside) cannot be told apart in the IFC's shapes, so it is recorded in the property set. GlobalIds are kept.
"""

from __future__ import annotations

import logging
import re
import tempfile

log = logging.getLogger("ollic.writeback")


def _hex_rgb(h: str) -> tuple[float, float, float]:
    h = (h or "#cccccc").lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def _rgb_hex(c) -> str | None:
    try:
        return "#" + "".join(f"{round(max(0, min(1, v)) * 255):02x}" for v in (c.Red, c.Green, c.Blue))
    except Exception:
        return None


def _close(a: str | None, b: str | None, tol: int = 40) -> bool:
    if not a or not b:
        return False
    ra, rb = _hex_rgb(a), _hex_rgb(b)
    return max(abs(x - y) for x, y in zip(ra, rb)) * 255 <= tol


class _Writer:
    def __init__(self, f):
        self.f, self.schema = f, f.schema
        self.materials: dict[str, object] = {}
        self.styles: dict[tuple, object] = {}
        self.owner = next(iter(f.by_type("IfcOwnerHistory")), None)

    def material(self, name: str):
        if name not in self.materials:
            self.materials[name] = self.f.createIfcMaterial(Name=name)
        return self.materials[name]

    def style(self, name: str, hexcol: str, transparency: float):
        key = (name, hexcol, round(transparency, 2))
        if key not in self.styles:
            r, g, b = _hex_rgb(hexcol)
            colour = self.f.createIfcColourRgb(None, r, g, b)
            rendering = self.f.createIfcSurfaceStyleRendering(SurfaceColour=colour, Transparency=transparency, ReflectanceMethod="NOTDEFINED")
            self.styles[key] = self.f.createIfcSurfaceStyle(Name=name, Side="BOTH", Styles=[rendering])
        return self.styles[key]

    def style_items(self, item, style):
        """The item shows this style: its own styled item updated, or a new one."""
        styles = [self.f.createIfcPresentationStyleAssignment([style])] if self.schema == "IFC2X3" else [style]
        own = [s for s in self.f.get_inverse(item) if s.is_a("IfcStyledItem")]
        if own:
            for s in own:
                s.Styles = styles
        else:
            self.f.createIfcStyledItem(item, styles, None)

    def item_style(self, item) -> tuple[str | None, str | None]:
        """The name and colour an item shows now (its own styled item, else its material's)."""
        for s in self.f.get_inverse(item):
            if not s.is_a("IfcStyledItem"):
                continue
            for st in s.Styles or []:
                for surf in ([st] if st.is_a("IfcSurfaceStyle") else list(getattr(st, "Styles", None) or [])):
                    if not surf.is_a("IfcSurfaceStyle"):
                        continue
                    col = next((_rgb_hex(x.SurfaceColour) for x in surf.Styles or [] if hasattr(x, "SurfaceColour")), None)
                    return surf.Name, col
        return None, None

    def body_items(self, product):
        rep = getattr(product, "Representation", None)
        out = []
        for r in (rep.Representations if rep else []) or []:
            if (r.RepresentationIdentifier or "Body") not in ("Body", "Facetation", "Mesh") and r.RepresentationType not in ("SweptSolid", "Brep", "Tessellation", "MappedRepresentation", "Clipping", "CSG", "SurfaceModel", "AdvancedBrep"):
                continue
            out += list(r.Items or [])
        return out

    def associate(self, product, mat):
        """Its material becomes this one, unless it is layered (the layers stay; the colours and the property set say the rest)."""
        rels = [r for r in getattr(product, "HasAssociations", None) or [] if r.is_a("IfcRelAssociatesMaterial")]
        if any(r.RelatingMaterial.is_a() in ("IfcMaterialLayerSetUsage", "IfcMaterialLayerSet", "IfcMaterialProfileSetUsage", "IfcMaterialProfileSet", "IfcMaterialConstituentSet") for r in rels):
            return False
        for r in rels:
            others = [o for o in r.RelatedObjects if o != product]
            if others:
                r.RelatedObjects = others
            else:
                self.f.remove(r)
        self.f.createIfcRelAssociatesMaterial(self._guid(), self.owner, "Ollic material", None, [product], mat)
        return True

    def pset(self, product, props: dict):
        values = []
        for k, v in props.items():
            if v is None or v == "":
                continue
            if isinstance(v, bool):
                val = self.f.createIfcBoolean(v)
            elif isinstance(v, (int, float)):
                val = self.f.createIfcReal(float(v))
            else:
                val = self.f.createIfcLabel(str(v)[:255])
            values.append(self.f.createIfcPropertySingleValue(k, None, val, None))
        if not values:
            return
        ps = self.f.createIfcPropertySet(self._guid(), self.owner, "Pset_OllicMaterial", "The material chosen in Ollic's 3D preview", values)
        self.f.createIfcRelDefinesByProperties(self._guid(), self.owner, None, None, [product], ps)

    def _guid(self):
        import ifcopenshell.guid
        return ifcopenshell.guid.new()


def write_materials(ifc_bytes: bytes, parts: list[dict], materials: dict[str, dict]) -> tuple[bytes, dict]:
    """parts: [{ "global_id", "part", "face" ("outside"/"inside"/None), "id" (material), "tint", "scale", "rotation",
    "parts_in_element", "orig_name", "orig_hex" }]. materials: { id: { "name", "cls", "hex", "size_m", "tile_mm",
    "transparency" } }. Returns the new IFC and a summary."""
    import ifcopenshell

    with tempfile.NamedTemporaryFile(suffix=".ifc") as tmp:
        tmp.write(ifc_bytes); tmp.flush()
        f = ifcopenshell.open(tmp.name)
    w = _Writer(f)
    by_element: dict[str, list[dict]] = {}
    for p in parts:
        by_element.setdefault(p["global_id"], []).append(p)
    done, skipped = 0, []
    for gid, ps in by_element.items():
        try:
            product = f.by_guid(gid)
        except RuntimeError:
            skipped.append(gid); continue
        props: dict = {}
        whole = [p for p in ps if not p.get("face")]
        mats = {p["id"] for p in whole}
        items = w.body_items(product)
        for p in whole:
            m = materials.get(p["id"]) or {}
            name = m.get("name") or p["id"]
            style = w.style(name, p.get("tint") or m.get("hex") or "#cccccc", float(m.get("transparency") or 0))
            n_parts = int(p.get("parts_in_element") or 1)
            if n_parts <= 1 or len(whole) == n_parts and len(mats) == 1:
                targets = items                      # the whole element
            else:                                    # only the shapes that showed this part's style or colour
                seen = [(it, w.item_style(it)) for it in items]
                # by the style's own name when the part had one (a window's "Glass"), else by its colour
                targets = [it for it, nc in seen if p.get("orig_name") and nc[0] == p["orig_name"]] or \
                          [it for it, nc in seen if _close(nc[1], p.get("orig_hex"), 12)]
            for it in targets:
                w.style_items(it, style)
            label = f"Part{int(p.get('part') or 0) + 1}" if n_parts > 1 else ""
            props.update({f"{label}Material": name, f"{label}LibraryId": p["id"], f"{label}TextureSize_mm": round(float(m.get("size_m") or 1) * float(p.get("scale") or 1) * 1000, 1),
                          f"{label}Rotation_deg": float(p.get("rotation") or 0), f"{label}Tint": p.get("tint") or ""})
            if m.get("tile_mm"):
                props[f"{label}TileSize_mm"] = " x ".join(f"{float(v) * float(p.get('scale') or 1):g}" for v in m["tile_mm"][:2])
        if len(mats) == 1 and whole and (len(whole) >= int(whole[0].get("parts_in_element") or 1)):
            m = materials.get(next(iter(mats))) or {}
            props["MaterialAssociated"] = w.associate(product, w.material(m.get("name") or next(iter(mats))))
        for p in ps:
            if p.get("face"):
                m = materials.get(p["id"]) or {}
                face = "Outside" if p["face"] == "outside" else "Inside"
                props[f"{face}FaceMaterial"] = m.get("name") or p["id"]
                props[f"{face}FaceLibraryId"] = p["id"]
                if p.get("tint"):
                    props[f"{face}FaceTint"] = p["tint"]
        w.pset(product, props)
        done += 1
    with tempfile.NamedTemporaryFile(suffix=".ifc") as out:
        f.write(out.name)
        data = open(out.name, "rb").read()
    return data, {"elements": done, "not_found": skipped}


def validate(ifc_bytes: bytes) -> list[str]:
    """IfcOpenShell's schema validation: the problems it finds (empty when the file is valid)."""
    import ifcopenshell
    import ifcopenshell.validate

    with tempfile.NamedTemporaryFile(suffix=".ifc") as tmp:
        tmp.write(ifc_bytes); tmp.flush()
        f = ifcopenshell.open(tmp.name)
        logger = ifcopenshell.validate.json_logger()
        ifcopenshell.validate.validate(f, logger)
    return [str(s.get("message") or s)[:300] for s in logger.statements if (s.get("level") or "error").lower() in ("error", "critical")]


_SAFE = re.compile(r"[^\w .-]+")


def download_name(name: str) -> str:
    return (_SAFE.sub("", name or "model").strip() or "model")[:80] + " with materials.ifc"
