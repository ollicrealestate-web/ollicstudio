"""Construction animation: default settings, plain-language direction, and export (upload of
the browser-made video, then a job that makes it phone-friendly and saves it)."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile, status
from pydantic import BaseModel, Field, ValidationError, field_validator

from ..animation import (DEFAULT_SECONDS, FORMATS, HIDEABLE, LIMITS, MAX_SECONDS, PHASE_NAMES, PHASES, TIMES, DirectorFailed, Script,
                         apply_reply, restrict_rooms)
from ..animation_jobs import run_animation_job, upload_path
from ..auth import CurrentUser, get_current_user
from ..supabase import BackendUnavailable
from ..video import FORMATS as SIZES, VideoFailed, probe
from .projects import _owned_project, _repo
from .renders import UNLIMITED_ROLES, _require_token_life, _start_job, _utc_midnight, user_plan

router = APIRouter()
MAX_UPLOAD = 200 * 1024 * 1024
DAILY_DIRECTIONS = 40


class Context(BaseModel):
    rooms: list[str] = Field(default_factory=list, max_length=300)
    floors: int = Field(default=1, ge=1, le=200)
    has: list[str] = Field(default_factory=list, max_length=30)

    @field_validator("rooms", "has")
    @classmethod
    def short(cls, v):
        return [" ".join(str(x).split())[:120] for x in v if str(x).strip()]


class DirectIn(BaseModel):
    instruction: str = Field(min_length=3, max_length=600)
    script: Script = Field(default_factory=Script)
    context: Context = Field(default_factory=Context)


class Item(BaseModel):
    caption: str = Field(default="", max_length=120)
    render_id: uuid.UUID | None = None


class ExportMeta(BaseModel):
    script: Script
    model_id: uuid.UUID | None = None
    items: list[Item] = Field(default_factory=list, max_length=60)


@router.get("/animation/defaults")
def defaults():
    """The settings an animation starts from, and their ranges, for the settings panel."""
    return {"script": Script().model_dump(), "phases": [{"id": k, "name": PHASE_NAMES[k], "default": DEFAULT_SECONDS[k], "min": LIMITS[k][0], "max": LIMITS[k][1]} for k in PHASES],
            "times": list(TIMES), "hideable": list(HIDEABLE), "formats": list(FORMATS), "max_seconds": MAX_SECONDS}


@router.post("/projects/{project_id}/animation/direct")
def direct(project_id: uuid.UUID, body: DirectIn, request: Request, user: CurrentUser = Depends(get_current_user)):
    """Plain words in, new animation settings out. Nothing is rendered or charged here."""
    _owned_project(request, user, project_id)
    directors = getattr(request.app.state, "directors", {}) or {}
    premium = user_plan(request, user) == "premium"
    director = (directors.get("premium") if premium else None) or directors.get("standard")
    if director is None:
        raise HTTPException(503, {"code": "not_configured", "reason": "Plain-language editing is not switched on for this site yet. Use the settings below."})
    repo = _repo(request)
    midnight = _utc_midnight()
    used = sum(1 for e in repo.list_usage_events(user, limit=200) if e.get("operation") == "animation_direct" and str(e.get("created_at") or "") >= midnight)
    if used >= DAILY_DIRECTIONS and (repo.get_profile(user) or {}).get("role") not in UNLIMITED_ROLES:
        raise HTTPException(429, {"code": "daily_limit", "reason": f"You have used today's {DAILY_DIRECTIONS} plain-language edits. Use the settings below, or try again after 01:00 Lagos time."})
    try:
        out = director.direct(body.instruction.strip(), body.script, body.context.model_dump())
    except DirectorFailed as exc:
        raise HTTPException(502, {"code": "director_failed", "reason": "That request could not be understood this time. Try saying it another way, or use the settings below."}) from exc
    script = restrict_rooms(apply_reply(body.script, out["settings"]), body.context.rooms)
    try:
        repo.create_usage_event(user, {"project_id": str(project_id), "provider": director.provider, "model": out.get("model") or "director",
                                       "operation": "animation_direct", "cost_usd": str(out["cost_usd"]) if out.get("cost_usd") is not None else None,
                                       "price_source": "platform.claude.com price list" if director.provider == "anthropic" else "inside Cloudflare's free daily allowance; no per-token price on file",
                                       "raw_usage": out.get("usage")})
    except BackendUnavailable:
        pass
    return {"script": script.model_dump(), "notes": out.get("notes") or "Done.", "left_today": max(0, DAILY_DIRECTIONS - used - 1)}


@router.post("/projects/{project_id}/animations", status_code=status.HTTP_202_ACCEPTED)
async def export_animation(project_id: uuid.UUID, request: Request, response: Response, file: UploadFile = File(...), meta: str = Form(...),
                           user: CurrentUser = Depends(get_current_user)):
    """Receives the video the browser made, checks it, and starts the job that saves it."""
    _owned_project(request, user, project_id)
    _require_token_life(user)
    try:
        m = ExportMeta.model_validate(json.loads(meta))
    except (ValueError, ValidationError) as exc:
        raise HTTPException(422, {"code": "bad_settings", "reason": "The animation settings were not valid. Reload the page and try again."}) from exc
    repo = _repo(request)
    if m.model_id:
        model = repo.get_model(user, str(m.model_id))
        if not model or model.get("project_id") != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Model not found in this project.")
    for it in m.items:
        if it.render_id:
            img = repo.get_rendered_image(user, str(it.render_id))
            if not img or img.get("owner_id") != user.id or img.get("project_id") != str(project_id):
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Render not found in this project.")
    name = f"{uuid.uuid4()}.video"
    dest = upload_path(name)
    size = 0
    try:
        with open(dest, "wb") as fh:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, {"code": "too_large", "reason": "The video is larger than 200 MB. Make it shorter and export again."})
                fh.write(chunk)
        try:
            info = probe(dest)
        except VideoFailed as exc:
            raise HTTPException(422, {"code": "bad_video", "reason": exc.message}) from exc
        w, h = SIZES[m.script.format]
        if (info.width, info.height) != (w, h):
            raise HTTPException(422, {"code": "bad_video", "reason": f"The video is {info.width}×{info.height}; {m.script.format} videos are {w}×{h}."})
        if not 2 <= info.duration_s <= MAX_SECONDS + 30:
            raise HTTPException(422, {"code": "bad_video", "reason": f"The video must be between 2 seconds and {MAX_SECONDS // 60} minutes long."})
        job_input = {"upload": name, "format": m.script.format, "title": m.script.title or None, "script": m.script.model_dump(mode="json"),
                     "items": [i.model_dump(mode="json") for i in m.items], "codec": info.codec, "bytes": size,
                     "model_id": str(m.model_id) if m.model_id else None, "received_at": datetime.now(timezone.utc).isoformat()}
        job = _start_job(request, user, str(project_id), "animation_export", job_input, None, response, run=run_animation_job, max_active=2)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    return job
