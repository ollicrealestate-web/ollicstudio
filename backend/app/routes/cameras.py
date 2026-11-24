"""Camera angles: the front of each model (when the architect set it) and its saved views; and Ollic AI turning a
description of a camera ("elevated three-quarter corner view, low drone height, 24 mm...") into numbers."""

from __future__ import annotations

import logging
import re
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field, field_validator

from ..auth import CurrentUser, get_current_user
from .models import _own_model
from .projects import _repo

router = APIRouter()
log = logging.getLogger("ollic.cameras")

PRESETS = ("front-eye", "front-raised", "corner-eye-left", "corner-eye-right", "drone-corner-left", "drone-corner-right", "aerial", "hero-low",
           "side", "side-left", "rear", "rear-left", "rear-right", "entrance", "plan", "interior-one", "interior-two", "custom")
SHAPES = ("3:2", "16:9", "4:5", "1:1", "9:16")
_THUMB = re.compile(r"^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$")


class CameraSettings(BaseModel):
    preset: str = "front-eye"
    lens: float = Field(35, ge=10, le=1000)
    height: float | None = Field(None, ge=-5, le=2000)
    distance: float | str = "fit"
    azimuth: float = Field(0, ge=-360, le=360)
    pitch: float = Field(0, ge=-89, le=90)
    straight: bool = True
    shiftX: float = Field(0, ge=-2, le=2)
    shiftY: float = Field(0, ge=-2, le=2)
    aspect: str = "3:2"
    fill: float = Field(0.85, gt=0.05, le=1.2)
    ground: float | None = Field(None, ge=0, le=0.6)
    foreground: str | None = None
    plan: bool = False
    interior: str | None = None
    target: str | None = None
    custom: bool = False

    @field_validator("preset")
    @classmethod
    def _p(cls, v):
        if v not in PRESETS:
            raise ValueError("unknown camera angle")
        return v

    @field_validator("aspect", mode="before")
    @classmethod
    def _a(cls, v):
        # a named shape, or a picture's own shape (a matched picture), as a number
        if isinstance(v, (int, float)) or (isinstance(v, str) and re.fullmatch(r"\d+(\.\d+)?", v)):
            f = float(v)
            if not 0.3 <= f <= 3.5:
                raise ValueError("picture shape out of range")
            return f"{f:.4f}"
        if v not in SHAPES:
            raise ValueError("unknown picture shape")
        return v

    @field_validator("distance")
    @classmethod
    def _d(cls, v):
        if v == "fit":
            return v
        v = float(v)
        if not 0.2 <= v <= 20000:
            raise ValueError("distance out of range")
        return v


class Pose(BaseModel):
    position: list[float] = Field(min_length=3, max_length=3)
    target: list[float] = Field(min_length=3, max_length=3)
    fov: float = Field(gt=0.01, lt=179)
    aspect: float | None = Field(None, gt=0.2, lt=5)
    shift: list[float] | None = Field(None, min_length=2, max_length=2)
    up: list[float] | None = Field(None, min_length=3, max_length=3)
    mode: str = "orbit"


class SavedView(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=80)
    settings: CameraSettings | None = None
    pose: Pose
    thumb: str | None = Field(None, max_length=60000)
    words: str | None = Field(None, max_length=600)

    @field_validator("thumb")
    @classmethod
    def _t(cls, v):
        if v and not _THUMB.match(v):
            raise ValueError("the small picture must be a JPEG, PNG or WebP data link")
        return v


class Front(BaseModel):
    dir: list[float] = Field(min_length=2, max_length=2)
    from_: str = Field("you", alias="from")


class CamerasIn(BaseModel):
    front: Front | None = None
    views: list[SavedView] = Field(default_factory=list, max_length=60)


@router.get("/models/{model_id}/cameras")
def get_cameras(model_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    _own_model(request, user, model_id)
    row = _repo(request).get_model_cameras(user, str(model_id)) or {}
    return {"front": row.get("front"), "views": row.get("views") or []}


@router.put("/models/{model_id}/cameras")
def put_cameras(model_id: uuid.UUID, body: CamerasIn, request: Request, user: CurrentUser = Depends(get_current_user)):
    _own_model(request, user, model_id)
    rec = {"front": body.front.model_dump(by_alias=True) if body.front else None, "views": [v.model_dump(exclude_none=True) for v in body.views]}
    row = _repo(request).put_model_cameras(user, str(model_id), rec)
    return {"front": row.get("front"), "views": row.get("views") or []}


WORDS_SYSTEM = """You turn an architect's description of a camera angle for a building render into camera numbers.
Answer with one JSON object: {"preset": one of front-eye, front-raised, corner-eye-left, corner-eye-right,
drone-corner-left, drone-corner-right, aerial, hero-low, side, side-left, rear, rear-left, rear-right, entrance, plan,
interior-one, interior-two; "lens": millimetres (full-frame); "height": camera height above the ground in metres;
"azimuth": degrees around the building from its front, positive to the right of a person facing the front (corners
are +-45, rear corners +-135); "pitch": degrees looking down (positive) or up (negative), 0 when vertical lines are
kept straight; "straight": true when vertical lines are kept straight (two-point perspective, shift lens);
"aspect": one of 3:2, 16:9, 4:5, 1:1, 9:16; "foreground": "street" when a street, road or junction is wanted in front,
else null; "understood": a short list of what you took from the words}. "Low drone height" is about 1.2 to 1.5 times
the building's height; "eye level" is 1.6 m. Choose the front-right corner unless the words say left."""


class WordsIn(BaseModel):
    text: str = Field(min_length=2, max_length=600)
    building_height: float = Field(12, gt=1, lt=1000)


@router.post("/camera/words")
def camera_words(body: WordsIn, request: Request, user: CurrentUser = Depends(get_current_user)):
    """Ollic AI reads the description; without it, a 503 (the browser then uses its own table of words)."""
    writer = getattr(request.app.state, "prompt_writer", None)
    if writer is None or not hasattr(writer, "ask_json"):
        raise HTTPException(503, {"code": "not_configured", "reason": "Ollic AI is not connected; the common words are read by the app itself."})
    from ..prompt_writer import PromptWriterFailed
    try:
        out = writer.ask_json(WORDS_SYSTEM, [{"type": "text", "text": f"The building is {body.building_height:.1f} m high. The camera: {body.text}"}], max_tokens=600, timeout=60)
    except PromptWriterFailed as exc:
        log.warning("camera words failed: %s", exc)
        raise HTTPException(502, {"code": "ai_failed", "reason": "Ollic AI could not read that just now; the app read the common words itself."})
    a = out.get("answer") or {}
    num = lambda v, lo, hi, d: max(lo, min(hi, float(v))) if isinstance(v, (int, float)) else d
    preset = a.get("preset") if a.get("preset") in PRESETS else "front-eye"
    straight = bool(a.get("straight", True))
    settings = {"preset": preset, "lens": num(a.get("lens"), 12, 600, 35), "height": num(a.get("height"), 0.1, 1000, 1.6), "azimuth": num(a.get("azimuth"), -180, 180, 0),
                "pitch": 0 if straight else num(a.get("pitch"), -80, 89, 0), "straight": straight, "aspect": a.get("aspect") if a.get("aspect") in SHAPES else "3:2",
                "foreground": "street" if a.get("foreground") == "street" else None}
    return {"settings": settings, "understood": [str(x)[:80] for x in (a.get("understood") or [])][:8]}


MATCH_SYSTEM = """You look at a picture of a building (an architect's render or a photo) and estimate the camera it was
taken with, so a 3D model can be viewed from the same place. Answer with one JSON object: {"preset": the nearest of
front-eye, front-raised, corner-eye-left, corner-eye-right, drone-corner-left, drone-corner-right, aerial, hero-low,
side, side-left, rear, rear-left, rear-right; "lens": millimetres (full-frame) judging by how much the perspective
converges and how wide the view is; "height": camera height above the ground in metres (eye level is 1.6); "azimuth":
degrees around the building from the side you believe is its front (the entrance side), positive when the camera is to
the right of a person facing that front; "straight": true if the vertical lines are parallel in the picture;
"pitch": degrees looking down (positive) or up (negative) when they are not; "understood": a short list of what you
see}. Be honest about uncertainty in "understood"."""


@router.post("/camera/match-picture")
def camera_match_picture(request: Request, user: CurrentUser = Depends(get_current_user), image: UploadFile = File(...), building_height: float = Form(12)):
    """Ollic AI's rough estimate of a picture's camera (the app then refines it from the edges)."""
    writer = getattr(request.app.state, "prompt_writer", None)
    if writer is None or not hasattr(writer, "ask_json"):
        raise HTTPException(503, {"code": "not_configured", "reason": "Ollic AI is not connected; line the model up by hand, then press Fine-tune."})
    from .materials import _picture
    pic = _picture(image, "picture")
    from ..prompt_writer import PromptWriterFailed, _image_block
    try:
        out = writer.ask_json(MATCH_SYSTEM, [_image_block(pic[0]), {"type": "text", "text": f"The building is about {building_height:.1f} m high."}], max_tokens=600, timeout=90)
    except PromptWriterFailed as exc:
        log.warning("camera match failed: %s", exc)
        raise HTTPException(502, {"code": "ai_failed", "reason": "Ollic AI could not read the picture just now; line the model up by hand, then press Fine-tune."})
    a = out.get("answer") or {}
    num = lambda v, lo, hi, d: max(lo, min(hi, float(v))) if isinstance(v, (int, float)) else d
    straight = bool(a.get("straight", True))
    return {"settings": {"preset": a.get("preset") if a.get("preset") in PRESETS else "corner-eye-right", "lens": num(a.get("lens"), 12, 300, 35),
                         "height": num(a.get("height"), 0.1, 1000, 1.6), "azimuth": num(a.get("azimuth"), -180, 180, 0), "straight": straight,
                         "pitch": 0 if straight else num(a.get("pitch"), -80, 89, 0)},
            "understood": [str(x)[:80] for x in (a.get("understood") or [])][:8]}
