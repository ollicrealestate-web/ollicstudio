"""The project's finished videos (golden animations and cinematic clips): list and delete."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status

from ..auth import CurrentUser, get_current_user
from .projects import _owned_project, _repo, _storage

router = APIRouter()


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
                   | {"script": {"check": (v.get("script") or {}).get("check")} if kind == "film" else None}
                   | {"url": url, "download_url": f"{url}&download={name}" if url else None})
    return out
