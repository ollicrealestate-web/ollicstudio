"""Phase 3: architects' IFC models, imported for rendering and animation."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from pydantic import BaseModel

from ..auth import CurrentUser, get_current_user
from ..bim.jobs import run_ifc_import
from .projects import _owned_project, _repo, _storage
from ..jobs import ACTIVE, is_stale
from .renders import _require_token_life, _start_job, public_job

router = APIRouter()


class SourceIn(BaseModel):
    source_file_id: uuid.UUID


def _own_file(request: Request, user: CurrentUser, project_id: uuid.UUID, file_id: uuid.UUID) -> dict:
    src = _repo(request).get_source_file(user, str(file_id))
    if not src or src.get("owner_id") != user.id or src.get("project_id") != str(project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found in this project.")
    return src


def _own_model(request: Request, user: CurrentUser, model_id: uuid.UUID) -> dict:
    m = _repo(request).get_model(user, str(model_id))
    if not m or m.get("owner_id") != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Model not found.")
    return m


# ---------------------------------------------------------------- Phase 3: IFC import
@router.post("/projects/{project_id}/import-ifc", status_code=status.HTTP_202_ACCEPTED)
def import_ifc(project_id: uuid.UUID, body: SourceIn, request: Request, response: Response,
               user: CurrentUser = Depends(get_current_user), idempotency_key: str | None = Header(default=None)):
    _owned_project(request, user, project_id)
    src = _own_file(request, user, project_id, body.source_file_id)
    if src.get("detected_type") != "ifc":
        raise HTTPException(422, {"code": "not_ifc", "reason": "Only IFC files can be imported as a model. Revit: File > Export > IFC."})
    _require_token_life(user)
    limit = request.app.state.settings.ifc_max_mb
    size_mb = (src.get("size_bytes") or 0) / 1e6
    if limit and size_mb > limit:
        raise HTTPException(413, {"code": "model_too_large", "reason": (
            f"This model is {size_mb:.0f} MB. Ollic can read IFC files up to {limit} MB at the moment, and larger ones are coming soon. "
            "To make it smaller, export only the building from Revit: leave out the site, furniture, linked models and detail you don't need to see.")})
    # the same file already being read: return that job instead of reading it twice
    for j in _repo(request).list_jobs(user, str(project_id)):
        if j.get("type") == "ifc_import" and j.get("status") in ACTIVE and not is_stale(j) and (j.get("input") or {}).get("source_file_id") == str(body.source_file_id):
            response.status_code = status.HTTP_200_OK
            return public_job(j)
    return _start_job(request, user, str(project_id), "ifc_import", {"source_file_id": str(body.source_file_id)}, idempotency_key, response, run=run_ifc_import)


@router.get("/projects/{project_id}/models")
def list_models(project_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    _owned_project(request, user, project_id)
    models = [m for m in _repo(request).list_models(user, str(project_id)) if m.get("owner_id") == user.id]
    bucket = request.app.state.settings.models_bucket
    links = _storage(request).signed_urls(user, [m["glb_path"] for m in models], bucket=bucket) if models else {}
    return [{k: m.get(k) for k in ("id", "source_file_id", "schema_version", "report", "stats", "created_at")}
            | {"glb_url": links.get(m["glb_path"])} for m in models]


@router.get("/models/{model_id}/components")
def list_components(model_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    _own_model(request, user, model_id)
    rows = [c for c in _repo(request).list_components(user, str(model_id)) if c.get("owner_id") == user.id]
    return [{k: c.get(k) for k in ("global_id", "ifc_type", "name", "family", "storey", "has_geometry", "properties")} for c in rows]
