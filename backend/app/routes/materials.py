"""Realistic materials: which library material each part of a model shows (what the user changed), and the user's
favourite and recently used materials. Private to their owner (row-level security in migration 15)."""

from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

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
