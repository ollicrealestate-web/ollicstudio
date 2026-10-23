"""Animation videos made in the browser from the architect's images (the golden animation): the
upload of the finished video, then a job that makes it phone-friendly and saves it."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile, status
from pydantic import BaseModel, Field, ValidationError

from ..animation import MAX_SECONDS, Script
from ..animation_jobs import run_animation_job, upload_path
from ..auth import CurrentUser, get_current_user
from ..video import FORMATS as SIZES, VideoFailed, probe
from .projects import _owned_project, _repo
from .renders import _require_token_life, _start_job

router = APIRouter()
MAX_UPLOAD = 200 * 1024 * 1024


class Item(BaseModel):
    caption: str = Field(default="", max_length=120)
    render_id: uuid.UUID | None = None


class ExportMeta(BaseModel):
    script: Script
    items: list[Item] = Field(default_factory=list, max_length=60)


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
                     "received_at": datetime.now(timezone.utc).isoformat()}
        job = _start_job(request, user, str(project_id), "animation_export", job_input, None, response, run=run_animation_job, max_active=2)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    return job
