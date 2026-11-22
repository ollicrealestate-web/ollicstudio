"""Sketch: the plan and 3D modeller. One JSON document per sketch, owned by the signed-in user."""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator

from ..auth import CurrentUser, get_current_user

router = APIRouter()
NOT_FOUND = "Sketch not found."
MAX_DOC_BYTES = 8 * 1024 * 1024
SCHEMA_VERSION = 1


def _check_doc(doc: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(doc.get("levels"), list) or not doc["levels"]:
        raise ValueError("This is not an Ollic sketch: it has no levels.")
    if len(doc["levels"]) > 10:
        raise ValueError("A sketch can have at most 10 levels.")
    if int(doc.get("schemaVersion") or 0) > SCHEMA_VERSION:
        raise ValueError("This sketch was made by a newer version of Ollic. Reload the page.")
    if len(json.dumps(doc, separators=(",", ":"))) > MAX_DOC_BYTES:
        raise ValueError("This sketch is larger than 8 MB.")
    return doc


def _tidy_name(v: str) -> str:
    v = " ".join(v.split())
    if not v:
        raise ValueError("Give the sketch a name.")
    return v


class SketchIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    doc: dict[str, Any]

    @field_validator("name")
    @classmethod
    def tidy_name(cls, v: str) -> str:
        return _tidy_name(v)

    @field_validator("doc")
    @classmethod
    def check_doc(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _check_doc(v)


class SketchUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    doc: dict[str, Any] | None = None

    @field_validator("name")
    @classmethod
    def tidy_name(cls, v: str | None) -> str | None:
        return None if v is None else _tidy_name(v)

    @field_validator("doc")
    @classmethod
    def check_doc(cls, v: dict[str, Any] | None) -> dict[str, Any] | None:
        return None if v is None else _check_doc(v)


def _repo(request: Request):
    return request.app.state.repo


def _owned(request: Request, user: CurrentUser, sketch_id: uuid.UUID) -> dict:
    """Ownership is checked here in code on every request, as well as by row-level security."""
    row = _repo(request).get_sketch(user, str(sketch_id))
    if not row or row.get("owner_id") != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    return row


@router.get("/sketches")
def list_sketches(request: Request, user: CurrentUser = Depends(get_current_user)):
    return [r for r in _repo(request).list_sketches(user) if r.get("owner_id") == user.id]


@router.post("/sketches", status_code=status.HTTP_201_CREATED)
def create_sketch(body: SketchIn, request: Request, user: CurrentUser = Depends(get_current_user)):
    doc = {**body.doc, "name": body.name}
    return _repo(request).create_sketch(user, {"name": body.name, "doc": doc, "schema_version": int(doc.get("schemaVersion") or SCHEMA_VERSION)})


@router.get("/sketches/{sketch_id}")
def get_sketch(sketch_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    return _owned(request, user, sketch_id)


@router.put("/sketches/{sketch_id}")
def update_sketch(sketch_id: uuid.UUID, body: SketchUpdate, request: Request, user: CurrentUser = Depends(get_current_user)):
    _owned(request, user, sketch_id)
    fields: dict[str, Any] = {}
    if body.name is not None:
        fields["name"] = body.name
    if body.doc is not None:
        fields["doc"] = {**body.doc, "name": body.name or body.doc.get("name") or "Untitled sketch"}
        fields["schema_version"] = int(body.doc.get("schemaVersion") or SCHEMA_VERSION)
    if not fields:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Nothing to save.")
    row = _repo(request).update_sketch(user, str(sketch_id), fields)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    return row


@router.delete("/sketches/{sketch_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sketch(sketch_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    _owned(request, user, sketch_id)
    if not _repo(request).delete_sketch(user, str(sketch_id)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)
