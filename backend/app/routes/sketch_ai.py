"""Ollic AI for Sketch: sessions, one assistant step at a time (with its cost logged), and reference images."""

from __future__ import annotations

import base64
import binascii
import io
import json
import uuid
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

from ..auth import CurrentUser, get_current_user
from ..sketch_ai import STAGES, SketchAIFailed, estimate_usd, tools_for

router = APIRouter()
NOT_FOUND = "Session not found."
NOT_SET_UP = "Ollic AI is not set up on this server yet (the assistant key is missing)."
BUCKET = "sketch-ai"
MAX_REFS = 6
MAX_STEP_BYTES = 24 * 1024 * 1024


def _repo(request: Request):
    return request.app.state.repo


def _ai(request: Request):
    ai = request.app.state.sketch_ai
    if ai is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, NOT_SET_UP)
    return ai


def _owned(request: Request, user: CurrentUser, sid: uuid.UUID) -> dict:
    row = _repo(request).get_ai_session(user, str(sid))
    if not row or row.get("owner_id") != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    return row


def _model(request: Request) -> str:
    ai = request.app.state.sketch_ai
    return getattr(ai, "model", None) or request.app.state.settings.claude_model


@router.get("/sketch-ai/config")
def config(request: Request, user: CurrentUser = Depends(get_current_user)):
    return {"available": request.app.state.sketch_ai is not None, "max_references": MAX_REFS}


class SessionIn(BaseModel):
    sketch_id: uuid.UUID | None = None
    detail: Literal["light", "medium", "full"] | None = None
    scope: dict[str, Any] = Field(default_factory=dict)
    pictures: int = Field(default=7, ge=0, le=40)
    references: int = Field(default=0, ge=0, le=MAX_REFS)
    summary_kb: float = Field(default=8, ge=0, le=2000)
    items: int = Field(default=8, ge=1, le=40)


@router.post("/sketch-ai/sessions", status_code=status.HTTP_201_CREATED)
def create_session(body: SessionIn, request: Request, user: CurrentUser = Depends(get_current_user)):
    _ai(request)
    if body.sketch_id:
        s = _repo(request).get_sketch(user, str(body.sketch_id))
        if not s or s.get("owner_id") != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Sketch not found.")
    est = estimate_usd(_model(request), pictures=body.pictures, references=body.references, summary_kb=body.summary_kb, items=body.items)
    row = _repo(request).create_ai_session(user, {"sketch_id": str(body.sketch_id) if body.sketch_id else None, "detail": body.detail, "scope": body.scope,
                                                  "estimate_usd": est["high_usd"], "stage": "start", "status": "open"})
    return {**row, "estimate": est}


@router.get("/sketch-ai/estimate")
def estimate(request: Request, pictures: int = 7, references: int = 0, summary_kb: float = 8, items: int = 8, user: CurrentUser = Depends(get_current_user)):
    return estimate_usd(_model(request), pictures=min(max(pictures, 0), 40), references=min(max(references, 0), MAX_REFS), summary_kb=min(max(summary_kb, 0), 2000), items=min(max(items, 1), 40))


@router.get("/sketch-ai/sessions")
def list_sessions(request: Request, sketch_id: uuid.UUID | None = None, user: CurrentUser = Depends(get_current_user)):
    rows = [r for r in _repo(request).list_ai_sessions(user) if r.get("owner_id") == user.id]
    return [r for r in rows if not sketch_id or r.get("sketch_id") == str(sketch_id)]


@router.get("/sketch-ai/sessions/{sid}")
def get_session(sid: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    row = _owned(request, user, sid)
    paths = [r["path"] for r in row.get("refs") or [] if r.get("path")]
    urls = request.app.state.storage.signed_urls(user, paths, bucket=BUCKET) if paths else {}
    return {**row, "refs": [{**r, "url": urls.get(r.get("path"))} for r in row.get("refs") or []]}


class SessionUpdate(BaseModel):
    stage: str | None = Field(default=None, max_length=40)
    status: Literal["open", "built", "accepted", "discarded", "stopped"] | None = None
    detail: Literal["light", "medium", "full"] | None = None
    scope: dict[str, Any] | None = None
    chat: list[Any] | None = None
    plan: list[Any] | None = None
    refs: list[Any] | None = None
    log: list[Any] | None = None
    report: dict[str, Any] | None = None
    summary: dict[str, Any] | None = None


@router.patch("/sketch-ai/sessions/{sid}")
def update_session(sid: uuid.UUID, body: SessionUpdate, request: Request, user: CurrentUser = Depends(get_current_user)):
    row = _owned(request, user, sid)
    fields = body.model_dump(exclude_none=True)
    if "refs" in fields:  # the paths are the server's; only what was seen in them can be edited
        known = {r["n"]: r for r in row.get("refs") or []}
        fields["refs"] = [{**known[r["n"]], **{k: v for k, v in r.items() if k in ("sees", "takes")}} for r in fields["refs"] if isinstance(r, dict) and r.get("n") in known]
    if len(json.dumps(fields.get("chat", [])) + json.dumps(fields.get("log", []))) > 4 * 1024 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "This session's record is too large to save.")
    if not fields:
        return row
    return _repo(request).update_ai_session(user, str(sid), fields)


class StepIn(BaseModel):
    stage: str
    messages: list[dict[str, Any]] = Field(min_length=1)
    tools: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/sketch-ai/sessions/{sid}/step")
def step(sid: uuid.UUID, body: StepIn, request: Request, user: CurrentUser = Depends(get_current_user)):
    ai = _ai(request)
    row = _owned(request, user, sid)
    if body.stage not in STAGES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown stage: {body.stage}.")
    if row.get("status") in ("accepted", "discarded", "stopped"):
        raise HTTPException(status.HTTP_409_CONFLICT, "This session is finished. Start a new one with Complete my design.")
    if len(json.dumps(body.messages)) > MAX_STEP_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Too many pictures in one step. Remove some reference images.")
    try:
        out = ai.step(stage=body.stage, messages=body.messages, tools=tools_for(body.stage, body.tools))
    except SketchAIFailed as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Ollic AI could not answer just now ({exc}). Try again.") from exc
    u = out.get("usage") or {}
    tin = int(u.get("input_tokens") or 0) + int(u.get("cache_creation_input_tokens") or 0) + int(u.get("cache_read_input_tokens") or 0)
    tout = int(u.get("output_tokens") or 0)
    cost = out.get("cost_usd") or Decimal(0)
    _repo(request).create_ai_call(user, {"session_id": str(sid), "stage": body.stage, "model": out.get("model") or _model(request), "input_tokens": tin,
                                         "output_tokens": tout, "cache_read_tokens": int(u.get("cache_read_input_tokens") or 0), "cost_usd": str(cost)})
    total = Decimal(str(row.get("cost_usd") or 0)) + Decimal(cost)
    _repo(request).update_ai_session(user, str(sid), {"stage": body.stage, "input_tokens": int(row.get("input_tokens") or 0) + tin,
                                                      "output_tokens": int(row.get("output_tokens") or 0) + tout, "cost_usd": str(total)})
    return {"content": out["content"], "stop_reason": out.get("stop_reason"), "usage": {"input_tokens": tin, "output_tokens": tout},
            "cost_usd": float(cost), "session_cost_usd": float(total)}


class ReferenceIn(BaseModel):
    data_url: str = Field(max_length=20 * 1024 * 1024)
    name: str | None = Field(default=None, max_length=200)


@router.post("/sketch-ai/sessions/{sid}/references", status_code=status.HTTP_201_CREATED)
def add_reference(sid: uuid.UUID, body: ReferenceIn, request: Request, user: CurrentUser = Depends(get_current_user)):
    row = _owned(request, user, sid)
    refs = list(row.get("refs") or [])
    if len(refs) >= MAX_REFS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Up to {MAX_REFS} reference images per session.")
    try:
        raw = base64.b64decode(body.data_url.split(",", 1)[-1], validate=True)
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (binascii.Error, ValueError, UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "That file is not a picture (use JPEG, PNG or WebP).") from exc
    img = img.convert("RGB")
    img.thumbnail((1568, 1568), Image.Resampling.LANCZOS)  # the size the assistant reads best
    buf = io.BytesIO(); img.save(buf, "JPEG", quality=88)
    n = max([r.get("n", 0) for r in refs] + [0]) + 1
    path = f"{user.id}/{sid}/{n}-{uuid.uuid4().hex[:8]}.jpg"
    request.app.state.storage.upload(user, path, buf.getvalue(), "image/jpeg", bucket=BUCKET)
    ref = {"n": n, "path": path, "name": (body.name or f"Image {n}")[:200], "width": img.width, "height": img.height}
    _repo(request).update_ai_session(user, str(sid), {"refs": refs + [ref]})
    return {**ref, "data_url": "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()}
