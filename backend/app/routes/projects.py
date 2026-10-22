"""Projects and source-file uploads (brief Modules A and B, Phase 1)."""

from __future__ import annotations

import hashlib
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from pydantic import BaseModel, Field, field_validator

from ..auth import CurrentUser, get_current_user
from ..filetypes import UploadRejected, inspect_upload
from ..supabase import BackendUnavailable

router = APIRouter()
NOT_FOUND = "Project not found."


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Give the project a name.")
        return v


def _repo(request: Request):
    return request.app.state.repo


def _storage(request: Request):
    return request.app.state.storage


def _owned_project(request: Request, user: CurrentUser, project_id: uuid.UUID) -> dict:
    """Ownership is checked here in code on every request, as well as by row-level security."""
    project = _repo(request).get_project(user, str(project_id))
    if not project or project.get("owner_id") != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    return project


@router.get("/me")
def me(user: CurrentUser = Depends(get_current_user)):
    return {"id": user.id, "email": user.email}


@router.post("/projects", status_code=status.HTTP_201_CREATED)
def create_project(body: ProjectIn, request: Request, user: CurrentUser = Depends(get_current_user)):
    return _repo(request).create_project(user, body.name)


@router.get("/projects")
def list_projects(request: Request, user: CurrentUser = Depends(get_current_user)):
    return [p for p in _repo(request).list_projects(user) if p.get("owner_id") == user.id]


@router.get("/projects/{project_id}")
def get_project(project_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    project = _owned_project(request, user, project_id)
    files = [f for f in _repo(request).list_source_files(user, str(project_id)) if f.get("owner_id") == user.id]
    return {**project, "source_files": files}


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    _owned_project(request, user, project_id)
    files = _repo(request).list_source_files(user, str(project_id))
    paths = [f["storage_path"] for f in files if f.get("owner_id") == user.id]
    renders = [r for r in _repo(request).list_rendered_images(user, str(project_id)) if r.get("owner_id") == user.id]
    render_paths = [p for r in renders for p in (r.get("storage_path"), r.get("base_path")) if p]
    # Files first: if storage fails the project stays, so nothing is left orphaned and unreachable.
    _storage(request).remove(user, paths)
    _storage(request).remove(user, render_paths, bucket=request.app.state.settings.renders_bucket)
    if not _repo(request).delete_project(user, str(project_id)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)


@router.post("/projects/{project_id}/uploads", status_code=status.HTTP_201_CREATED)
def upload_source_file(project_id: uuid.UUID, request: Request, file: UploadFile = File(...), user: CurrentUser = Depends(get_current_user)):
    project = _owned_project(request, user, project_id)
    limit = request.app.state.settings.max_upload_bytes
    chunks, size = [], 0
    while chunk := file.file.read(1024 * 1024):  # sync handler: FastAPI runs it in a worker thread
        size += len(chunk)
        if size > limit:
            raise HTTPException(
                413,
                {"code": "too_large", "reason": f"The file is larger than the {limit // (1024 * 1024)} MB limit."},
            )
        chunks.append(chunk)
    data = b"".join(chunks)
    name = (file.filename or "upload").strip()[:255] or "upload"
    try:
        check = inspect_upload(data, name)
    except UploadRejected as exc:
        raise HTTPException(422, {"code": exc.code, "reason": exc.reason}) from exc

    file_id = str(uuid.uuid4())
    path = f"{user.id}/{project_id}/{file_id}.{check.ext}"  # the user's folder; storage policies check the first segment
    storage = _storage(request)
    storage.upload(user, path, data, check.mime)
    record = {
        "id": file_id,
        "project_id": str(project_id),
        "original_name": name,
        "storage_path": path,
        "detected_type": check.kind,
        "size_bytes": size,
        "checksum_sha256": hashlib.sha256(data).hexdigest(),
        "validation": {"status": "valid", "details": check.details},
        "processing_status": "uploaded",
    }
    try:
        saved = _repo(request).create_source_file(user, record)
    except BackendUnavailable:
        storage.remove(user, [path])  # never leave a stored file without its record
        raise
    if project.get("input_type") in (None, "unknown"):
        _repo(request).update_project(user, str(project_id), {"input_type": "ifc" if check.kind == "ifc" else "sketch"})
    return saved
