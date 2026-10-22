"""The layout of a building as confirmed by the customer (brief Module B2).

Coordinates are metres on the floor plan: x to the right, y up the page. Every value
can carry where it came from ("drawing", "ai", "user", "default"), so the review
screen can show it and the IFC keeps a record. Version 1 supports one or two storeys
and a flat, gable or hip roof, as the brief allows.
"""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

Source = Literal["drawing", "ai", "user", "default"]
Point = tuple[float, float]


class Level(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    elevation: float = Field(ge=-5, le=60)
    height: float = Field(ge=2.2, le=8)


class Wall(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    level: int = Field(ge=0, le=1)
    a: Point
    b: Point
    thickness: float = Field(ge=0.05, le=0.6)
    exterior: bool = False
    source: Source = "drawing"

    @property
    def length(self) -> float:
        return math.dist(self.a, self.b)

    @model_validator(mode="after")
    def long_enough(self):
        if self.length < 0.1:
            raise ValueError(f"wall {self.id} is shorter than 10 cm")
        return self


class Opening(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    wall: str
    kind: Literal["door", "window"]
    offset: float = Field(ge=0, description="distance along the wall from its start point to the opening's centre, m")
    width: float = Field(ge=0.3, le=6)
    height: float = Field(ge=0.3, le=4)
    sill: float = Field(default=0.0, ge=0, le=3)
    source: Source = "drawing"


class Room(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    level: int = Field(ge=0, le=1)
    name: str = Field(min_length=1, max_length=60)
    polygon: list[Point] = Field(min_length=3, max_length=64)
    area_label: float | None = Field(default=None, ge=0, description="area written on the drawing, m²")
    source: Source = "drawing"


class Roof(BaseModel):
    type: Literal["flat", "gable", "hip"] = "gable"
    pitch: float = Field(default=25, ge=0, le=60)
    overhang: float = Field(default=0.5, ge=0, le=2)
    source: Source = "default"


class Layout(BaseModel):
    name: str = Field(default="House", max_length=120)
    levels: list[Level] = Field(min_length=1, max_length=2)
    walls: list[Wall] = Field(min_length=3, max_length=600)
    openings: list[Opening] = Field(default_factory=list, max_length=600)
    rooms: list[Room] = Field(default_factory=list, max_length=200)
    roof: Roof = Field(default_factory=Roof)
    slab_thickness: float = Field(default=0.15, ge=0.05, le=0.5)

    @field_validator("levels")
    @classmethod
    def stacked(cls, levels):
        for lower, upper in zip(levels, levels[1:]):
            if upper.elevation < lower.elevation + lower.height - 0.01:
                raise ValueError("an upper storey starts below the top of the storey under it")
        return levels

    @model_validator(mode="after")
    def references(self):
        walls = {w.id: w for w in self.walls}
        if len(walls) != len(self.walls):
            raise ValueError("two walls share an id")
        for w in self.walls:
            if w.level >= len(self.levels):
                raise ValueError(f"wall {w.id} is on a storey that does not exist")
        for r in self.rooms:
            if r.level >= len(self.levels):
                raise ValueError(f"room {r.id} is on a storey that does not exist")
        for o in self.openings:
            w = walls.get(o.wall)
            if w is None:
                raise ValueError(f"opening {o.id} is in a wall that does not exist")
            if o.offset - o.width / 2 < -0.01 or o.offset + o.width / 2 > w.length + 0.01:
                raise ValueError(f"opening {o.id} does not fit in wall {w.id}")
            if o.sill + o.height > self.levels[w.level].height + 0.01:
                raise ValueError(f"opening {o.id} is taller than its storey")
        return self


def sample_house() -> Layout:
    """A 12 m x 9 m bungalow: living, kitchen, two bedrooms, bath. Used in tests and as a demo."""
    t, ti = 0.23, 0.15
    W, D = 12.0, 9.0
    walls = [
        Wall(id="n", level=0, a=(0, D), b=(W, D), thickness=t, exterior=True),
        Wall(id="e", level=0, a=(W, D), b=(W, 0), thickness=t, exterior=True),
        Wall(id="s", level=0, a=(W, 0), b=(0, 0), thickness=t, exterior=True),
        Wall(id="w", level=0, a=(0, 0), b=(0, D), thickness=t, exterior=True),
        Wall(id="i1", level=0, a=(7, 0), b=(7, D), thickness=ti),        # living | bedrooms
        Wall(id="i2", level=0, a=(7, 4.5), b=(W, 4.5), thickness=ti),    # bedroom 1 | bedroom 2
        Wall(id="i3", level=0, a=(0, 5.5), b=(7, 5.5), thickness=ti),    # living | kitchen
        Wall(id="i4", level=0, a=(4.5, 5.5), b=(4.5, D), thickness=ti),  # kitchen | bath
    ]
    # offsets run from each wall's start point: s runs east to west, e north to south
    openings = [
        Opening(id="d-front", wall="s", kind="door", offset=W - 2.5, width=1.0, height=2.1),
        Opening(id="w-liv", wall="s", kind="window", offset=W - 5.2, width=2.4, height=1.4, sill=0.9),
        Opening(id="w-bed1-s", wall="s", kind="window", offset=W - 9.5, width=1.5, height=1.2, sill=1.0),
        Opening(id="w-bed1", wall="e", kind="window", offset=D - 2.25, width=1.5, height=1.2, sill=1.0),
        Opening(id="w-bed2", wall="e", kind="window", offset=D - 6.75, width=1.5, height=1.2, sill=1.0),
        Opening(id="w-kit", wall="n", kind="window", offset=2.2, width=1.2, height=1.0, sill=1.1),
        Opening(id="w-bath", wall="n", kind="window", offset=5.75, width=0.6, height=0.6, sill=1.6),
        Opening(id="d-bed1", wall="i1", kind="door", offset=3.5, width=0.9, height=2.1),
        Opening(id="d-bed2", wall="i1", kind="door", offset=5.2, width=0.9, height=2.1),
        Opening(id="d-kit", wall="i3", kind="door", offset=2.0, width=0.9, height=2.1),
        Opening(id="d-bath", wall="i3", kind="door", offset=5.75, width=0.8, height=2.1),
    ]
    rooms = [
        Room(id="living", level=0, name="Living", polygon=[(0, 0), (7, 0), (7, 5.5), (0, 5.5)], area_label=38.5),
        Room(id="kitchen", level=0, name="Kitchen", polygon=[(0, 5.5), (4.5, 5.5), (4.5, D), (0, D)], area_label=15.8),
        Room(id="bath", level=0, name="Bath", polygon=[(4.5, 5.5), (7, 5.5), (7, D), (4.5, D)], area_label=8.8),
        Room(id="bed1", level=0, name="Bedroom 1", polygon=[(7, 0), (W, 0), (W, 4.5), (7, 4.5)], area_label=22.5),
        Room(id="bed2", level=0, name="Bedroom 2", polygon=[(7, 4.5), (W, 4.5), (W, D), (7, D)], area_label=22.5),
    ]
    return Layout(name="Sample bungalow", levels=[Level(name="Ground floor", elevation=0, height=3.0)],
                  walls=walls, openings=openings, rooms=rooms, roof=Roof(type="hip", pitch=25, overhang=0.6))
