"""Realistic materials: which library material each part of a model shows (what the user changed), and the user's
favourite and recently used materials. Private to their owner (row-level security in migration 15)."""

from __future__ import annotations

import re
import uuid

import io
import json
import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from pydantic import BaseModel, Field, ValidationError, field_validator

from ..auth import CurrentUser, get_current_user
from .projects import _repo
from .models import _own_model

router = APIRouter()

_KEY = re.compile(r"^[0-9A-Za-z_$]{1,64}#\d{1,4}(/[+-])?$")        # GlobalId#part, or one face of it: /+ or /-
_ID = re.compile(r"^(mt-[a-z0-9-]{1,60}|my-[0-9a-f-]{36})$")        # a library material, or one of my materials
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


class Assignment(BaseModel):
    id: str
    tint: str | None = None
    scale: float = Field(1, ge=0.05, le=20)
    rotation: float = Field(0, ge=-360, le=360)
    rough: float | None = Field(None, ge=0, le=1)
    offset: tuple[float, float] = (0, 0)

    @field_validator("id")
    @classmethod
    def _id(cls, v):
        if not _ID.match(v):
            raise ValueError("unknown material")
        return v

    @field_validator("tint")
    @classmethod
    def _tint(cls, v):
        if v is not None and not _HEX.match(v):
            raise ValueError("colour must be like #a1b2c3")
        return v

    @field_validator("offset")
    @classmethod
    def _offset(cls, v):
        if any(abs(x) > 100 for x in v):
            raise ValueError("offset too large")
        return v


class MaterialsIn(BaseModel):
    assignments: dict[str, Assignment]

    @field_validator("assignments")
    @classmethod
    def _keys(cls, v):
        if len(v) > 20000:
            raise ValueError("too many parts")
        bad = [k for k in v if not _KEY.match(k)]
        if bad:
            raise ValueError(f"not a part of the model: {bad[0][:80]}")
        return v


@router.get("/models/{model_id}/materials")
def get_materials(model_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    _own_model(request, user, model_id)
    row = _repo(request).get_model_materials(user, str(model_id))
    return {"assignments": (row or {}).get("assignments") or {}, "updated_at": (row or {}).get("updated_at")}


@router.put("/models/{model_id}/materials")
def put_materials(model_id: uuid.UUID, body: MaterialsIn, request: Request, user: CurrentUser = Depends(get_current_user)):
    _own_model(request, user, model_id)
    data = {k: a.model_dump(exclude_defaults=True) | {"id": a.id} for k, a in body.assignments.items()}
    row = _repo(request).put_model_materials(user, str(model_id), data)
    return {"assignments": row.get("assignments") or {}, "updated_at": row.get("updated_at")}


class PrefsIn(BaseModel):
    favourites: list[str] = Field(default_factory=list, max_length=200)
    recent: list[str] = Field(default_factory=list, max_length=30)

    @field_validator("favourites", "recent")
    @classmethod
    def _ids(cls, v):
        if any(not _ID.match(x) for x in v):
            raise ValueError("unknown material")
        return list(dict.fromkeys(v))


@router.get("/material-prefs")
def get_prefs(request: Request, user: CurrentUser = Depends(get_current_user)):
    row = _repo(request).get_material_prefs(user) or {}
    return {"favourites": row.get("favourites") or [], "recent": row.get("recent") or []}


@router.put("/material-prefs")
def put_prefs(body: PrefsIn, request: Request, user: CurrentUser = Depends(get_current_user)):
    row = _repo(request).put_material_prefs(user, body.model_dump())
    if not row:
        raise HTTPException(503, "Could not save.")
    return {"favourites": row.get("favourites") or [], "recent": row.get("recent") or []}


# ---------------------------------------------------------------- My materials: made from the user's photos
BUCKET = "user-materials"
MAPS = ("color", "normal", "rough", "ao", "original")
CLASSES = ("paint", "plaster", "concrete", "stone", "brick", "tile", "wood", "metal", "glass", "roof", "grass", "paving", "asphalt", "furniture", "ceramic")
MAX_BYTES = 8 * 1024 * 1024
log = logging.getLogger("ollic.materials")


class MyMaterialIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    cls: str = "stone"
    size: float = Field(1, gt=0.01, le=50)          # metres one picture covers, across
    sizeV: float | None = Field(None, gt=0.01, le=50)   # and up (if not square)
    rough: float = Field(0.6, ge=0, le=1)
    metal: float = Field(0, ge=0, le=1)
    plain: str = "#cccccc"                          # its average colour, shown while the pictures load
    tiles: list[int] | None = None                  # whole tiles in one picture, across and up
    tile_mm: list[float] | None = None              # one tile, mm
    checks: dict = Field(default_factory=dict)      # how faithful the copy is (colour difference, join)

    @field_validator("cls")
    @classmethod
    def _cls(cls, v):
        if v not in CLASSES:
            raise ValueError("unknown kind of material")
        return v

    @field_validator("plain")
    @classmethod
    def _plain(cls, v):
        if not _HEX.match(v):
            raise ValueError("colour must be like #a1b2c3")
        return v


def _picture(f: UploadFile | None, what: str) -> tuple[bytes, str] | None:
    """An uploaded picture, checked: a real JPEG, PNG or WebP image, at most 8 MB."""
    if f is None:
        return None
    data = f.file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"The {what} picture is larger than 8 MB.")
    from PIL import Image
    try:
        im = Image.open(io.BytesIO(data)); im.verify()
        kind = (im.format or "").upper()
    except Exception:
        raise HTTPException(422, f"The {what} picture could not be read.")
    if kind not in ("JPEG", "PNG", "WEBP"):
        raise HTTPException(422, f"The {what} picture must be JPEG, PNG or WebP.")
    return data, {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}[kind]


def _public(request: Request, user: CurrentUser, row: dict) -> dict:
    """A material of mine as the browser uses it: like a library entry, with links to its pictures (an hour)."""
    paths = {k: v for k, v in (row.get("maps") or {}).items() if k in MAPS}
    links = request.app.state.storage.signed_urls(user, list(paths.values()), bucket=BUCKET, expires_in=3600) if paths else {}
    st = row.get("settings") or {}
    return {"id": f"my-{row['id']}", "name": row["name"], "category": "My materials", "cls": row["cls"], "size": st.get("size", 1), "sizeV": st.get("sizeV"),
            "rough": st.get("rough", 0.6), "metal": st.get("metal", 0), "plain": st.get("plain", "#cccccc"), "checks": st.get("checks", {}),
            "urls": {k: links.get(p) for k, p in paths.items() if links.get(p)}, "created_at": row.get("created_at")}


@router.get("/my-materials")
def list_my_materials(request: Request, user: CurrentUser = Depends(get_current_user)):
    return [_public(request, user, r) for r in _repo(request).list_user_materials(user)]


@router.post("/my-materials", status_code=status.HTTP_201_CREATED)
def create_my_material(request: Request, user: CurrentUser = Depends(get_current_user), meta: str = Form(...),
                       color: UploadFile = File(...), normal: UploadFile | None = File(None), rough: UploadFile | None = File(None),
                       ao: UploadFile | None = File(None), original: UploadFile | None = File(None)):
    try:
        m = MyMaterialIn.model_validate(json.loads(meta))
    except (ValueError, ValidationError) as exc:
        raise HTTPException(422, f"The material's details are not right: {str(exc)[:200]}")
    pics = {k: _picture(f, k) for k, f in (("color", color), ("normal", normal), ("rough", rough), ("ao", ao), ("original", original))}
    mid = str(uuid.uuid4())
    storage, paths = request.app.state.storage, {}
    for k, v in pics.items():
        if v is None:
            continue
        ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[v[1]]
        path = f"{user.id}/{mid}/{k}.{ext}"
        storage.upload(user, path, v[0], v[1], bucket=BUCKET)
        paths[k] = path
    settings = m.model_dump(exclude={"name", "cls"}, exclude_none=True)
    row = _repo(request).create_user_material(user, {"id": mid, "name": m.name, "cls": m.cls, "settings": settings, "maps": paths})
    return _public(request, user, row)


@router.delete("/my-materials/{material_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_my_material(material_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    repo = _repo(request)
    row = repo.get_user_material(user, str(material_id))
    if not row:
        raise HTTPException(404, "Material not found.")
    paths = list((row.get("maps") or {}).values())
    if paths:
        request.app.state.storage.remove(user, paths, bucket=BUCKET)
    repo.delete_user_material(user, str(material_id))


SUGGEST_SYSTEM = """You look at a photo of a building material (a tile, a stone sample, a wall, a catalogue picture) for an
architect in Nigeria and say what it is, so it can be used as a material in a 3D model. Answer with one JSON object:
{"name": short material name as a builder would say it (e.g. "Travertine, honed", "Porcelain tile, beige marble look"),
 "cls": one of paint, plaster, concrete, stone, brick, tile, wood, metal, glass, roof, grass, paving, asphalt, furniture,
 "rough": 0 (mirror-polished) to 1 (matt), "metal": 0 or 1, "size_mm": your best guess of how wide the photo shows in
 millimetres (one tile, one brick course, a sample board), "tile_mm": [width, height] of one tile or brick if it is tiled,
 else null, "notes": one short sentence on what you see}. Use plain words; never mention brands."""


@router.post("/my-materials/suggest")
def suggest_my_material(request: Request, user: CurrentUser = Depends(get_current_user), image: UploadFile = File(...)):
    """Ollic AI looks at the photo and suggests a name, kind, shine and likely size. Without the AI, a 503 (the
    browser then keeps its own guesses)."""
    writer = getattr(request.app.state, "prompt_writer", None)
    if writer is None or not hasattr(writer, "ask_json"):
        raise HTTPException(503, {"code": "not_configured", "reason": "Ollic AI suggestions are not set up. Fill in the details yourself."})
    pic = _picture(image, "photo")
    from ..prompt_writer import PromptWriterFailed, _image_block
    try:
        out = writer.ask_json(SUGGEST_SYSTEM, [_image_block(pic[0]), {"type": "text", "text": "What material is this?"}], max_tokens=800, timeout=90)
    except PromptWriterFailed as exc:
        log.warning("material suggestion failed: %s", exc)
        raise HTTPException(502, {"code": "ai_failed", "reason": "Ollic AI could not look at the photo just now. Fill in the details yourself."})
    a = out.get("answer") or {}
    try:
        _repo(request).create_usage_event(user, {"project_id": None, "provider": "anthropic", "model": out.get("model") or "claude", "operation": "vision_read",
                                                 "cost_usd": str(out["cost_usd"]) if out.get("cost_usd") is not None else None,
                                                 "price_source": "platform.claude.com price list", "raw_usage": out.get("usage")})
    except Exception:
        pass
    num = lambda v, lo, hi, d: max(lo, min(hi, float(v))) if isinstance(v, (int, float)) else d
    tile = a.get("tile_mm")
    return {"name": str(a.get("name") or "My material")[:80], "cls": a.get("cls") if a.get("cls") in CLASSES else "stone",
            "rough": num(a.get("rough"), 0, 1, 0.6), "metal": 1 if a.get("metal") in (1, True, "1") else 0,
            "size_mm": num(a.get("size_mm"), 20, 20000, None),
            "tile_mm": [num(tile[0], 10, 3000, None), num(tile[1], 10, 3000, None)] if isinstance(tile, list) and len(tile) == 2 else None,
            "notes": str(a.get("notes") or "")[:200]}
