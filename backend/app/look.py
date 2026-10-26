"""The project look: the materials the architect approved for this building and, once chosen, an
approved "hero" render. Every render, view, shot and stage of the project is told to use them, so
the front, the side and the aerial view show the same building in the same materials.

Materials come from the model: each material is the model's material class (glass, metal, paint,
brick...) with the colour the architect gave it there. The 3D viewer draws a material map from the
same camera as each captured view, one flat colour per material (`map`); the AI is told what each
map colour stands for, and the result is checked region by region against the approved colour.
"""

from __future__ import annotations

import colorsys
import re
import uuid
from typing import Literal

import numpy as np
from PIL import Image
from pydantic import BaseModel, Field, field_validator

HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
CLASSES = {"glass": "glass", "metal": "metal", "brick": "brick", "concrete": "concrete", "plaster": "render", "paint": "painted finish",
           "stone": "stone", "tile": "tiles", "paving": "paving", "wood": "timber", "roof": "roofing"}
NO_COLOUR_CHECK = {"glass"}      # glass shows reflections and the sky, not its own colour


def colour_name(hex_: str) -> str:
    r, g, b = (int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    if s < 0.15 or l > 0.94 or l < 0.06:
        return "white" if l > 0.85 else "light grey" if l > 0.62 else "mid grey" if l > 0.38 else "dark grey" if l > 0.12 else "black"
    hue = h * 360
    if 15 <= hue < 50 and s > 0.75 and 0.35 < l < 0.75:
        return "orange"
    if 15 <= hue < 50:
        return "brown" if l < 0.35 else "tan" if l < 0.7 else "beige"
    names = [(15, "red"), (65, "yellow"), (160, "green"), (200, "teal"), (255, "blue"), (290, "purple"), (330, "pink"), (361, "red")]
    return next(n for top, n in names if hue < top)


class Material(BaseModel):
    key: str = Field(max_length=80)               # "<class>|<model colour>", from the model
    cls: str = Field(default="paint", max_length=20)
    model_hex: str = "#cccccc"                    # the colour in the model
    map: str = "#808080"                          # its colour in the material map
    name: str = Field(default="", max_length=80)
    finish: str = Field(default="", max_length=300)   # e.g. "smooth white render, matt"
    hex: str = "#cccccc"                          # the approved colour
    sample_file_id: uuid.UUID | None = None       # a photo of the approved material
    types: list[str] = Field(default_factory=list, max_length=6)   # what it is used on in the model (IfcWall, IfcWindow...)
    source: Literal["model", "ai", "architect"] = "model"           # who wrote the name and finish
    confirmed: bool = False                       # the architect has checked it
    extra: bool = False                           # added by Claude or the architect; not a material in the model's map
    note: str = Field(default="", max_length=200)   # where it goes, for extras ("planters on the roof terrace")

    @field_validator("types")
    @classmethod
    def short_types(cls, v: list[str]) -> list[str]:
        return [str(t)[:40] for t in v][:6]

    @field_validator("model_hex", "map", "hex")
    @classmethod
    def is_hex(cls, v: str) -> str:
        if not HEX.match(v or ""):
            raise ValueError("Colours are written like #d9c39a.")
        return v.lower()

    @field_validator("name", "finish", "note")
    @classmethod
    def tidy(cls, v: str) -> str:
        return " ".join((v or "").split())


class Look(BaseModel):
    materials: list[Material] = Field(default_factory=list, max_length=40)
    hero_render_id: uuid.UUID | None = None
    setting: str = Field(default="", max_length=500)   # surroundings, light and mood for every view
    scene_id: str | None = Field(default=None, max_length=40)     # a preset scene (see scenes.py), or None
    scene_name: str = Field(default="", max_length=80)            # a scene copied from the architect's picture: its name
    scene_text: str = Field(default="", max_length=1500)          # ... and its recipe, written by Claude, editable
    scene_ref_file_id: uuid.UUID | None = None                     # ... and the picture, sent along as the scene reference
    reading: str | None = None      # set while Claude reads the materials (when it started, ISO time)
    read_notes: str = Field(default="", max_length=400)   # what Claude said, or why it could not read them

    @field_validator("setting", "scene_name", "scene_text")
    @classmethod
    def tidy(cls, v: str) -> str:
        return " ".join((v or "").split())

    @field_validator("scene_id")
    @classmethod
    def known_scene(cls, v: str | None) -> str | None:
        from .scenes import SCENES
        if v and v not in SCENES:
            raise ValueError("Unknown scene.")
        return v or None


def default_name(cls: str, hex_: str) -> str:
    return f"{colour_name(hex_).capitalize()} {CLASSES.get(cls, cls)}"


def merge_groups(look: Look, groups: list[dict]) -> Look:
    """Adds the model's materials the look does not have yet (named after their class and colour);
    keeps everything the architect already set. The map colours always follow the model."""
    have = {m.key: m for m in look.materials}
    for g in groups[:40]:
        m = have.get(g["key"])
        if m:
            m.map = g["map"]
            m.types = g.get("types") or m.types
            continue
        cls, hx = g.get("cls") or "paint", g.get("hex") or "#cccccc"
        look.materials.append(Material(key=g["key"], cls=cls, model_hex=hx, map=g["map"], name=default_name(cls, hx), hex=hx, types=g.get("types") or []))
    look.materials = look.materials[:40]
    return look


def look_block(look: Look, map_image: int | None, hero_image: int | None, model_image: int | None = 1) -> str:
    """What the image model is told about the approved look."""
    parts = []
    mats = [m for m in look.materials if m.name and not m.extra]
    extras = [m for m in look.materials if m.name and m.extra]
    if mats:
        if map_image:
            parts.append(f"Image {map_image} is the MATERIAL MAP of the same view: each flat colour marks where one material is on the building. "
                         "Use exactly these approved materials, in exactly those places, the same in every view of this project:")
            parts += [f"- {colour_name(m.map)} ({m.map}) in the map = {m.name}" + (f": {m.finish}" if m.finish else "") + f"; colour {m.hex}" for m in mats]
        else:
            parts.append("Use exactly these approved materials of this project, the same in every view:")
            parts += [f"- {m.name}" + (f": {m.finish}" if m.finish else "") + f"; colour {m.hex} (where the model is {colour_name(m.model_hex)})" for m in mats]
    if extras:
        parts.append("Also in this project:")
        parts += [f"- {m.name}" + (f": {m.finish}" if m.finish else "") + (f"; colour {m.hex}" if m.hex else "") + (f" ({m.note})" if m.note else "") for m in extras]
    if hero_image:
        parts.append(f"Image {hero_image} is the APPROVED LOOK of this building: match its materials, colours, glazing, light and mood exactly; "
                     f"take the building's shape and the camera only from Image {model_image or 1}.")
    from .scenes import SCENES, scene_text
    scene = scene_text(look.scene_id, look.scene_text)
    if scene:
        name = look.scene_name or (SCENES[look.scene_id][0] if look.scene_id in SCENES else "")
        parts.append(f"SCENE for every view of this project{f' ({name})' if name else ''}: {scene} The scene never changes the building, its shape or its approved materials"
                     + (f"; the camera, viewpoint and framing come only from Image {model_image}, so ignore any camera or lens in the scene." if model_image else "."))
    if look.setting:
        parts.append(f"Setting for every view: {look.setting}.")
    return "\n".join(parts)


def _lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB (0..255, shape (...,3)) to CIE Lab (D65)."""
    c = rgb.astype(np.float64) / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def _rgb(hex_: str) -> np.ndarray:
    return np.array([int(hex_[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float64)


COLOUR_TOLERANCE = 16.0   # Lab distance with lightness counted at a third (light and shade change lightness most)


def material_check(material_map: Image.Image, result: Image.Image, materials: list[Material]) -> dict | None:
    """Each material's region in the result against its approved colour; None when nothing to check."""
    W, H = result.size
    mp = np.asarray(material_map.convert("RGB").resize((W, H), Image.Resampling.NEAREST)).astype(np.int16)
    res = np.asarray(result.convert("RGB"))
    out, area_ok, area_all = [], 0, 0
    for m in materials:
        if m.cls in NO_COLOUR_CHECK or m.extra:
            continue
        mask = (np.abs(mp - _rgb(m.map).astype(np.int16)).sum(axis=-1) <= 24)
        # stay inside the region: drop the edge pixels, where the AI may draw frames, joints and shadows
        mask[1:-1, 1:-1] &= mask[:-2, 1:-1] & mask[2:, 1:-1] & mask[1:-1, :-2] & mask[1:-1, 2:]
        n = int(mask.sum())
        if n < 0.004 * W * H:
            continue
        seen = np.median(res[mask], axis=0)
        a, b = _lab(seen), _lab(_rgb(m.hex))
        d = float(np.sqrt(((a[0] - b[0]) / 3) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2))
        ok = d <= COLOUR_TOLERANCE
        out.append({"key": m.key, "name": m.name, "ok": ok, "difference": round(d, 1), "seen": "#%02x%02x%02x" % tuple(int(x) for x in seen),
                    "share": round(n / (W * H), 3)})
        area_all += n
        area_ok += n if ok else 0
    if not out:
        return None
    score = round(area_ok / area_all, 3)
    return {"score": score, "materials": sorted(out, key=lambda x: -x["share"])}


# ---------------------------------------------------------------- Claude reads the materials
SUGGEST_SYSTEM = (
    "You are a senior architect and visualisation artist. You study a view of an architect's BIM model and name the real "
    "materials of the building, so every AI render of this project uses the same materials.\n"
    "Image 1 is the model view (its colours are only the model's display colours). Image 2 is the MATERIAL MAP of the same view: "
    "each flat colour marks one material of the model. You also get the list of those materials: map colour, material class from the "
    "file, the model's colour, and what the material is used on (IFC types).\n"
    "For EACH listed material write: a short name an architect would use (e.g. \"White render\", \"Tan aluminium cladding\", "
    "\"Bronze-tinted glazing\", \"Exposed concrete columns\"), the finish (texture, sheen, size or pattern, e.g. \"smooth acrylic render, matt\"), "
    "and a realistic colour as #rrggbb. Base it on what the material is used on, where it sits in the view, and its model colour; "
    "keep the model's colour family unless it is clearly a placeholder. Then list up to 6 EXTRA things a render needs that are not in "
    "the list (e.g. planters, roof terrace decking, railings, paving, landscaping), each with where they go. Finally suggest one setting "
    "line (surroundings, light, mood) if the architect's words give one; otherwise leave it empty. Use the architect's description "
    "first when it names materials.\n"
    'Answer with JSON only: {"materials": [{"key": "...", "name": "...", "finish": "...", "hex": "#rrggbb"}], '
    '"extra": [{"name": "...", "finish": "...", "hex": "#rrggbb", "where": "..."}], "setting": "...", "notes": "one sentence for the architect"}'
)


def suggest_request(look: Look, description: str) -> str:
    rows = [f"- key {m.key}: map {colour_name(m.map)} {m.map}; class {m.cls}; model colour {m.model_hex} ({colour_name(m.model_hex)}); "
            f"used on {', '.join(t.replace('Ifc', '') for t in m.types) or 'unknown'}" for m in look.materials if not m.extra]
    return ("Materials of the model:\n" + "\n".join(rows) + "\n\nThe architect's description: " + (description.strip() or "(none)"))


def apply_suggestions(look: Look, answer: dict) -> Look:
    """Fills in Claude's names, finishes and colours on materials the architect has not confirmed or edited;
    adds Claude's extras (replacing earlier unconfirmed AI extras)."""
    by_key = {m.key: m for m in look.materials}
    for s in (answer.get("materials") or [])[:40]:
        m = by_key.get(str(s.get("key", "")))
        if not m or m.confirmed or m.source == "architect":
            continue
        m.name = " ".join(str(s.get("name") or m.name).split())[:80]
        m.finish = " ".join(str(s.get("finish") or "").split())[:300]
        if HEX.match(str(s.get("hex") or "")):
            m.hex = str(s["hex"]).lower()
        m.source = "ai"
    look.materials = [m for m in look.materials if not (m.extra and m.source == "ai" and not m.confirmed)]
    for i, e in enumerate((answer.get("extra") or [])[:6]):
        name = " ".join(str(e.get("name") or "").split())[:80]
        if not name or len(look.materials) >= 40 or name.lower() in {m.name.lower() for m in look.materials}:
            continue
        hx = str(e.get("hex") or "#cccccc").lower()
        look.materials.append(Material(key=f"extra|ai{i}|{name.lower()[:40]}", cls="extra", name=name, finish=" ".join(str(e.get("finish") or "").split())[:300],
                                       hex=hx if HEX.match(hx) else "#cccccc", map="#000000", model_hex="#000000", source="ai", extra=True,
                                       note=" ".join(str(e.get("where") or "").split())[:200]))
    if not look.setting and answer.get("setting"):
        look.setting = " ".join(str(answer["setting"]).split())[:500]
    return look
