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

    @field_validator("model_hex", "map", "hex")
    @classmethod
    def is_hex(cls, v: str) -> str:
        if not HEX.match(v or ""):
            raise ValueError("Colours are written like #d9c39a.")
        return v.lower()

    @field_validator("name", "finish")
    @classmethod
    def tidy(cls, v: str) -> str:
        return " ".join((v or "").split())


class Look(BaseModel):
    materials: list[Material] = Field(default_factory=list, max_length=40)
    hero_render_id: uuid.UUID | None = None
    setting: str = Field(default="", max_length=500)   # surroundings, light and mood for every view

    @field_validator("setting")
    @classmethod
    def tidy(cls, v: str) -> str:
        return " ".join((v or "").split())


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
            continue
        cls, hx = g.get("cls") or "paint", g.get("hex") or "#cccccc"
        look.materials.append(Material(key=g["key"], cls=cls, model_hex=hx, map=g["map"], name=default_name(cls, hx), hex=hx))
    look.materials = look.materials[:40]
    return look


def look_block(look: Look, map_image: int | None, hero_image: int | None, model_image: int | None = 1) -> str:
    """What the image model is told about the approved look."""
    parts = []
    mats = [m for m in look.materials if m.name]
    if mats:
        if map_image:
            parts.append(f"Image {map_image} is the MATERIAL MAP of the same view: each flat colour marks where one material is on the building. "
                         "Use exactly these approved materials, in exactly those places, the same in every view of this project:")
            parts += [f"- {colour_name(m.map)} ({m.map}) in the map = {m.name}" + (f": {m.finish}" if m.finish else "") + f"; colour {m.hex}" for m in mats]
        else:
            parts.append("Use exactly these approved materials of this project, the same in every view:")
            parts += [f"- {m.name}" + (f": {m.finish}" if m.finish else "") + f"; colour {m.hex} (where the model is {colour_name(m.model_hex)})" for m in mats]
    if hero_image:
        parts.append(f"Image {hero_image} is the APPROVED LOOK of this building: match its materials, colours, glazing, light and mood exactly; "
                     f"take the building's shape and the camera only from Image {model_image or 1}.")
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
        if m.cls in NO_COLOUR_CHECK:
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
