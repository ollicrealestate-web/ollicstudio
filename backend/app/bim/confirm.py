"""Turns the customer's reviewed plan (image pixels plus a confirmed scale) into a Layout in
metres, ready for the builder. Nothing is built until the scale is confirmed (brief: "asks
the customer to confirm or correct one known dimension before building the model")."""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, Field

from .layout import Layout, Level, Opening, Roof, Room, Wall

Src = Literal["drawing", "ai", "user", "default"]
PX = tuple[float, float]


class WallIn(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    a: PX
    b: PX
    thickness_m: float = Field(ge=0.05, le=0.6)
    exterior: bool = False
    source: Src = "drawing"


class OpeningIn(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    wall: str
    kind: Literal["door", "window"]
    offset_px: float = Field(ge=0)
    width_m: float = Field(ge=0.3, le=6)
    height_m: float = Field(ge=0.3, le=4)
    sill_m: float = Field(default=0, ge=0, le=3)
    source: Src = "drawing"


class RoomIn(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=60)
    polygon_px: list[PX] = Field(min_length=3, max_length=64)
    area_label: float | None = None
    source: Src = "drawing"


class RoofIn(BaseModel):
    type: Literal["flat", "gable", "hip"] = "gable"
    pitch: float = Field(default=25, ge=0, le=60)
    overhang: float = Field(default=0.5, ge=0, le=2)
    source: Src = "default"


class ConfirmIn(BaseModel):
    draft_id: str
    name: str = Field(default="House", min_length=1, max_length=120)
    scale_m_per_px: float = Field(gt=0, lt=10)
    scale_source: Literal["ai", "user"]
    image_height_px: float = Field(gt=0)
    walls: list[WallIn] = Field(min_length=3, max_length=600)
    openings: list[OpeningIn] = Field(default_factory=list, max_length=600)
    rooms: list[RoomIn] = Field(default_factory=list, max_length=200)
    storeys: Literal[1, 2] = 1
    storey_height_m: float = Field(default=3.0, ge=2.2, le=8)
    roof: RoofIn = Field(default_factory=RoofIn)


def to_layout(c: ConfirmIn) -> tuple[Layout, list[str]]:
    """Returns the layout and plain notes about anything adjusted on the way."""
    s, H = c.scale_m_per_px, c.image_height_px
    # image y runs down, plan y runs up; the building's south-west corner becomes (0, 0)
    x0 = min(min(w.a[0], w.b[0]) for w in c.walls)
    y0 = max(max(w.a[1], w.b[1]) for w in c.walls)
    m = lambda p: (round((p[0] - x0) * s, 3), round((y0 - p[1]) * s, 3))
    notes: list[str] = []
    walls = [Wall(id=w.id, level=0, a=m(w.a), b=m(w.b), thickness=w.thickness_m, exterior=w.exterior, source=w.source)
             for w in c.walls if math.dist(w.a, w.b) * s >= 0.1]
    if len(walls) < len(c.walls):
        notes.append(f"{len(c.walls) - len(walls)} very short wall pieces were left out.")
    by_id = {w.id: w for w in walls}
    levels = [Level(name="Ground floor", elevation=0, height=c.storey_height_m)]
    openings = []
    for o in c.openings:
        w = by_id.get(o.wall)
        if w is None:
            continue
        width = min(o.width_m, w.length - 0.05)
        centre = min(max(o.offset_px * s, width / 2), w.length - width / 2)
        height = min(o.height_m, c.storey_height_m - o.sill_m - 0.05)
        if width < 0.3 or height < 0.3:
            notes.append(f"Opening {o.id} did not fit its wall and was left out.")
            continue
        openings.append(Opening(id=o.id, wall=o.wall, kind=o.kind, offset=round(centre, 3), width=round(width, 3),
                                height=round(height, 3), sill=o.sill_m, source=o.source))
    rooms = [Room(id=r.id, level=0, name=r.name, polygon=[m(p) for p in r.polygon_px], area_label=r.area_label, source=r.source) for r in c.rooms]

    if c.storeys == 2:
        # Version 1: the upper floor repeats the ground floor's outline. Exterior walls go up a storey,
        # with windows where the ground floor has windows or doors; inside is one open floor until a
        # first-floor plan is uploaded.
        levels.append(Level(name="First floor", elevation=c.storey_height_m, height=c.storey_height_m))
        for w in [w for w in walls if w.exterior]:
            walls.append(w.model_copy(update={"id": f"{w.id}-1", "level": 1, "source": "default"}))
            for o in [o for o in openings if o.wall == w.id]:
                ww = min(o.width, 1.5)
                openings.append(Opening(id=f"{o.id}-1", wall=f"{w.id}-1", kind="window", offset=o.offset, width=ww, height=1.2, sill=0.9, source="default"))
        ext = [w for w in walls if w.level == 0 and w.exterior]
        xs = [p[0] for w in ext for p in (w.a, w.b)]
        ys = [p[1] for w in ext for p in (w.a, w.b)]
        if xs:
            rooms.append(Room(id="upper", level=1, name="First floor", polygon=[(min(xs), min(ys)), (max(xs), min(ys)), (max(xs), max(ys)), (min(xs), max(ys))], source="default"))
        notes.append("The first floor repeats the ground floor's outline and is one open space. Upload the first-floor plan to change it.")

    layout = Layout(name=c.name, levels=levels, walls=walls, openings=openings, rooms=rooms,
                    roof=Roof(type=c.roof.type, pitch=c.roof.pitch, overhang=c.roof.overhang, source=c.roof.source))
    return layout, notes
