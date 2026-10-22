"""Walkthrough shots (saved views of the 3D model), rendering every shot, and rendered
walkthrough videos (brief Modules C, N and O)."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, field_validator

from ..auth import CurrentUser, get_current_user
from ..video_jobs import run_video_job
from .projects import _owned_project, _repo, _storage
from .renders import ConceptRenderIn, _require_tier, _require_token_life, _start_job, _utc_midnight, daily_limit

router = APIRouter()
MAX_BATCH = 12


class Pose(BaseModel):
    mode: Literal["orbit", "walk"] = "orbit"
    position: tuple[float, float, float]
    target: tuple[float, float, float]
    fov: float = Field(default=45, ge=20, le=100)


class ShotIn(BaseModel):
    source_file_id: uuid.UUID
    name: str = Field(min_length=1, max_length=80)
    room: str | None = Field(default=None, max_length=120)
    pose: Pose
    model_id: uuid.UUID | None = None

    @field_validator("name")
    @classmethod
    def tidy(cls, v):
        v = " ".join(v.split())
        if not v:
            raise ValueError("Give the shot a name.")
        return v


class ShotPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    position: int | None = Field(default=None, ge=0, le=10000)


class BatchIn(BaseModel):
    shot_ids: list[uuid.UUID] = Field(min_length=1, max_length=MAX_BATCH)
    brief: ConceptRenderIn
    look_file_ids: list[uuid.UUID] = Field(default_factory=list, max_length=3)


class VideoIn(BaseModel):
    render_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)
    captions: list[str] = Field(default_factory=list, max_length=20)
    format: Literal["16:9", "9:16", "1:1"] = "16:9"
    seconds: float = Field(default=5, ge=2.5, le=12)
    title: str = Field(default="", max_length=80)
    subtitle: str = Field(default="", max_length=120)


def _own_shot(request, user, shot_id) -> dict:
    s = _repo(request).get_shot(user, str(shot_id))
    if not s or s.get("owner_id") != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Shot not found.")
    return s


@router.post("/projects/{project_id}/shots", status_code=status.HTTP_201_CREATED)
def save_shot(project_id: uuid.UUID, body: ShotIn, request: Request, user: CurrentUser = Depends(get_current_user)):
    _owned_project(request, user, project_id)
    repo = _repo(request)
    f = repo.get_source_file(user, str(body.source_file_id))
    if not f or f.get("owner_id") != user.id or f.get("project_id") != str(project_id) or f.get("detected_type") not in ("png", "jpeg"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Shot picture not found in this project.")
    if body.model_id:
        m = repo.get_model(user, str(body.model_id))
        if not m or m.get("project_id") != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Model not found in this project.")
    shots = [s for s in repo.list_shots(user, str(project_id)) if s.get("owner_id") == user.id]
    if len(shots) >= 40:
        raise HTTPException(422, {"code": "too_many_shots", "reason": "A project can have up to 40 shots. Delete some first."})
    return repo.create_shot(user, {"project_id": str(project_id), "source_file_id": str(body.source_file_id), "name": body.name, "room": body.room,
                                   "pose": body.pose.model_dump(mode="json"), "model_id": str(body.model_id) if body.model_id else None,
                                   "position": max([s.get("position") or 0 for s in shots], default=-1) + 1})


@router.get("/projects/{project_id}/shots")
def list_shots(project_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    _owned_project(request, user, project_id)
    repo, settings = _repo(request), request.app.state.settings
    shots = [s for s in repo.list_shots(user, str(project_id)) if s.get("owner_id") == user.id]
    files = {f["id"]: f for f in repo.list_source_files(user, str(project_id))}
    paths = [files[s["source_file_id"]]["storage_path"] for s in shots if s.get("source_file_id") in files]
    links = _storage(request).signed_urls(user, paths, bucket=settings.storage_bucket) if paths else {}
    renders = [i for i in repo.list_rendered_images(user, str(project_id)) if i.get("owner_id") == user.id]
    latest = {}
    for i in renders:  # newest first
        sid = (i.get("options") or {}).get("shot_id")
        if sid and sid not in latest:
            latest[sid] = i["id"]
    out = []
    for s in shots:
        f = files.get(s.get("source_file_id"))
        out.append({k: s.get(k) for k in ("id", "name", "room", "position", "pose", "model_id", "source_file_id", "created_at")}
                   | {"picture_url": links.get(f["storage_path"]) if f else None, "latest_render_id": latest.get(s["id"])})
    return out


@router.patch("/shots/{shot_id}")
def edit_shot(shot_id: uuid.UUID, body: ShotPatch, request: Request, user: CurrentUser = Depends(get_current_user)):
    _own_shot(request, user, shot_id)
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if "name" in fields:
        fields["name"] = " ".join(fields["name"].split()) or "Shot"
    return _repo(request).update_shot(user, str(shot_id), fields) if fields else _own_shot(request, user, shot_id)


@router.delete("/shots/{shot_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_shot(shot_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    _own_shot(request, user, shot_id)
    _repo(request).delete_shot(user, str(shot_id))


@router.post("/projects/{project_id}/shots/render", status_code=status.HTTP_202_ACCEPTED)
def render_shots(project_id: uuid.UUID, body: BatchIn, request: Request, response: Response, user: CurrentUser = Depends(get_current_user)):
    """Renders every chosen shot with the same brief, style and look references, so the rooms match."""
    _owned_project(request, user, project_id)
    brief = body.brief
    _require_tier(request, user, brief.tier)
    _require_token_life(user)
    repo, settings = _repo(request), request.app.state.settings
    shots = [_own_shot(request, user, sid) for sid in dict.fromkeys(body.shot_ids)]
    if any(s.get("project_id") != str(project_id) or not s.get("source_file_id") for s in shots):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Shot not found in this project.")
    looks = []
    for fid in dict.fromkeys(body.look_file_ids):
        f = repo.get_source_file(user, str(fid))
        if not f or f.get("owner_id") != user.id or f.get("project_id") != str(project_id) or f.get("detected_type") not in ("png", "jpeg"):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Look reference not found in this project.")
        looks.append(str(fid))
    limit = daily_limit(request, user, brief.tier)
    if limit:
        used = repo.count_jobs_since(user, _utc_midnight(), ("queued", "running", "succeeded"), brief.tier)
        left = max(0, limit - used)
        if len(shots) > left:
            kind = "Premium" if brief.tier == "premium" else "Standard"
            raise HTTPException(429, {"code": "daily_limit", "reason": f"You have {left} {kind} render{'s' if left != 1 else ''} left today and this needs {len(shots)}. "
                                      "Choose fewer shots, or try again after 01:00 Lagos time."})
    jobs = []
    for s in shots:
        job_input = brief.model_dump(mode="json", exclude={"reference_file_id", "references"})
        job_input["references"] = [{"file_id": s["source_file_id"], "role": "model"}] + [{"file_id": f, "role": "style"} for f in looks if f != s["source_file_id"]]
        job_input["shot_id"] = s["id"]
        job_input["shot_name"] = s["name"]
        if (s.get("pose") or {}).get("mode") == "walk":
            job_input["view"] = "interior"   # a shot taken standing inside a room is an interior, whatever the form says
        jobs.append(_start_job(request, user, str(project_id), "concept_render", job_input, None, response, max_active=MAX_BATCH + 3))
    response.status_code = status.HTTP_202_ACCEPTED
    return {"jobs": jobs}


@router.post("/projects/{project_id}/videos", status_code=status.HTTP_202_ACCEPTED)
def make_video(project_id: uuid.UUID, body: VideoIn, request: Request, response: Response, user: CurrentUser = Depends(get_current_user)):
    project = _owned_project(request, user, project_id)
    _require_token_life(user)
    repo = _repo(request)
    for rid in body.render_ids:
        img = repo.get_rendered_image(user, str(rid))
        if not img or img.get("owner_id") != user.id or img.get("project_id") != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Render not found in this project.")
    job_input = body.model_dump(mode="json")
    job_input["title"] = body.title or project.get("name") or "Walkthrough"
    return _start_job(request, user, str(project_id), "video_export", job_input, None, response, run=run_video_job, max_active=2)


@router.delete("/videos/{video_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_video(video_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    repo = _repo(request)
    v = repo.get_video(user, str(video_id))
    if not v or v.get("owner_id") != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Video not found.")
    _storage(request).remove(user, [v["storage_path"]], bucket=request.app.state.settings.videos_bucket)
    repo.delete_video(user, v["id"])


@router.get("/projects/{project_id}/videos")
def list_videos(project_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    _owned_project(request, user, project_id)
    repo, settings = _repo(request), request.app.state.settings
    vids = [v for v in repo.list_videos(user, str(project_id)) if v.get("owner_id") == user.id]
    links = _storage(request).signed_urls(user, [v["storage_path"] for v in vids], bucket=settings.videos_bucket, expires_in=6 * 3600) if vids else {}
    out = []
    for v in vids:
        url = links.get(v["storage_path"])
        kind = v.get("kind") or "walkthrough"
        name = f"ollic-{kind}-{v['id'][:8]}-{v['format'].replace(':', 'x')}.mp4"
        out.append({k: v.get(k) for k in ("id", "title", "format", "width", "height", "fps", "duration_s", "label", "created_at", "items")} | {"kind": kind}
                   | {"url": url, "download_url": f"{url}&download={name}" if url else None})
    return out
