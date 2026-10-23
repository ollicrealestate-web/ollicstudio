"""Settings of an animation video made in the browser from the architect's images (the golden
animation): its format, title card and look. The browser draws and encodes the video; these
settings travel with the upload and are kept with the finished video."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

FORMATS = ("16:9", "9:16", "1:1")
MAX_SECONDS = 300


class Script(BaseModel):
    """What the customer chose for the video. Unknown fields are ignored; numbers are brought into range."""
    version: Literal[1] = 1
    look: str = Field(default="", max_length=400, description="materials, landscaping and mood for the photoreal views")
    title: str = Field(default="", max_length=80)
    subtitle: str = Field(default="", max_length=120)
    format: Literal["16:9", "9:16", "1:1"] = "16:9"
    captions: bool = True
    renders: bool = False
    render_seconds: float = 4

    @field_validator("title", "subtitle", "look")
    @classmethod
    def one_line(cls, v):
        return " ".join(v.split())

    @field_validator("render_seconds")
    @classmethod
    def in_range(cls, v):
        return round(max(2.5, min(10.0, float(v))), 2)
