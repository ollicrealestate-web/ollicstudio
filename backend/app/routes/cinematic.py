"""Cinematic clips: a paid feature (each clip costs real money at the video service)."""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, model_validator

from ..auth import CurrentUser, get_current_user
from ..cinematic import run_clip_job
from ..engines import VIDEO_ENGINES
from ..fal import video_cost
from ..kling import estimate_cost
from .projects import _owned_project, _repo
from .renders import UNLIMITED_ROLES, _require_token_life, allowance_left, _start_job, _utc_midnight, user_plan

router = APIRouter()


class FrameRef(BaseModel):
    kind: Literal["file", "render", "lines"]      # lines: an AI line drawing, turned into gold lines on a night sky
    id: uuid.UUID


class ClipIn(BaseModel):
    engine: Literal["motion", "cinema", "reel", "vs"] = "motion"
    start: FrameRef
    end: FrameRef
    seconds: int = Field(default=10, ge=3, le=15)
    resolution: Literal["720p", "1080p"] = "720p"
    audio: bool = False
    format: Literal["16:9", "9:16", "1:1"] = "16:9"
    title: str = Field(default="", max_length=80)
    prompt_extra: str = Field(default="", max_length=400)

    @model_validator(mode="after")
    def end_is_a_render(self):
        if self.end.kind == "lines":
            raise ValueError("The end frame must be the photoreal picture.")
        return self


@router.post("/projects/{project_id}/cinematic", status_code=status.HTTP_202_ACCEPTED)
def make_clip(project_id: uuid.UUID, body: ClipIn, request: Request, response: Response, user: CurrentUser = Depends(get_current_user)):
    _owned_project(request, user, project_id)
    _require_token_life(user)
    if (getattr(request.app.state, "video_clients", None) or {}).get(body.engine) is None:
        raise HTTPException(503, {"code": "not_configured", "reason": f"{VIDEO_ENGINES[body.engine]['name']} is not connected yet."})
    repo = _repo(request)
    profile = repo.get_profile(user) or {}
    role = profile.get("role")
    if user_plan(request, user) != "premium" and role not in UNLIMITED_ROLES:
        left = allowance_left(request, user, "vs_video", profile) if body.engine == "vs" else None
        if left == 0:
            raise HTTPException(403, {"code": "allowance_used", "reason": "You have used your free Ollic VS clip."})
        if left is None:
            raise HTTPException(403, {"code": "premium_only", "reason": "Cinematic clips are for paid plans."})
    for ref in (body.start, body.end):
        if ref.kind == "file":
            f = repo.get_source_file(user, str(ref.id))
            ok = f and f.get("owner_id") == user.id and f.get("project_id") == str(project_id) and f.get("detected_type") in ("png", "jpeg")
        else:
            img = repo.get_rendered_image(user, str(ref.id))
            ok = img and img.get("owner_id") == user.id and img.get("project_id") == str(project_id)
        if not ok:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Picture not found in this project.")
    limit = request.app.state.settings.daily_clips_per_user
    if role not in UNLIMITED_ROLES and limit:
        used = sum(repo.count_jobs_since(user, _utc_midnight(), ("queued", "running", "succeeded"), t) for t in ("clip", "clip-vs"))
        if used >= limit:
            raise HTTPException(429, {"code": "daily_limit", "reason": f"You have made today's {limit} cinematic clips. They reset at 01:00 Lagos time."})
    if body.engine == "vs" and body.seconds < 4:
        raise HTTPException(422, {"code": "too_short", "reason": "Ollic VS clips are 4 to 15 seconds."})
    est = video_cost(body.resolution, body.seconds) if body.engine == "vs" else estimate_cost(body.resolution, body.seconds, body.audio)
    job_input = body.model_dump(mode="json") | {"tier": "clip-vs" if body.engine == "vs" else "clip", "estimate_usd": str(est)}
    job = _start_job(request, user, str(project_id), "cinematic_clip", job_input, None, response, run=run_clip_job, max_active=3)
    return job | {"estimate_usd": job_input["estimate_usd"]}
