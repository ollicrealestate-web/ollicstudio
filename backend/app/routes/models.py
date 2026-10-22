"""Phase 3 (IFC import) and Phase 3b (model from a floor plan) endpoints."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from pydantic import BaseModel, ValidationError

from ..auth import CurrentUser, get_current_user
from ..bim.confirm import ConfirmIn, to_layout
from ..bim.jobs import run_ifc_import, run_model_build, run_plan_trace
from .projects import _owned_project, _repo, _storage
from .renders import _require_token_life, _start_job

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


def _own_draft(request: Request, user: CurrentUser, draft_id: str) -> dict:
    try:
        uuid.UUID(draft_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Layout not found.") from None
    d = _repo(request).get_draft(user, draft_id)
    if not d or d.get("owner_id") != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Layout not found.")
    return d


# ---------------------------------------------------------------- Phase 3: IFC import
@router.post("/projects/{project_id}/import-ifc", status_code=status.HTTP_202_ACCEPTED)
def import_ifc(project_id: uuid.UUID, body: SourceIn, request: Request, response: Response,
               user: CurrentUser = Depends(get_current_user), idempotency_key: str | None = Header(default=None)):
    _owned_project(request, user, project_id)
    src = _own_file(request, user, project_id, body.source_file_id)
    if src.get("detected_type") != "ifc":
        raise HTTPException(422, {"code": "not_ifc", "reason": "Only IFC files can be imported as a model. Revit: File > Export > IFC."})
    _require_token_life(user)
    return _start_job(request, user, str(project_id), "ifc_import", {"source_file_id": str(body.source_file_id)}, idempotency_key, response, run=run_ifc_import)


@router.get("/projects/{project_id}/models")
def list_models(project_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    _owned_project(request, user, project_id)
    models = [m for m in _repo(request).list_models(user, str(project_id)) if m.get("owner_id") == user.id]
    bucket = request.app.state.settings.models_bucket
    links = _storage(request).signed_urls(user, [m["glb_path"] for m in models], bucket=bucket) if models else {}
    return [{k: m.get(k) for k in ("id", "source_file_id", "layout_draft_id", "schema_version", "report", "stats", "created_at")}
            | {"glb_url": links.get(m["glb_path"])} for m in models]


@router.get("/models/{model_id}/components")
def list_components(model_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    _own_model(request, user, model_id)
    rows = [c for c in _repo(request).list_components(user, str(model_id)) if c.get("owner_id") == user.id]
    return [{k: c.get(k) for k in ("global_id", "ifc_type", "name", "family", "storey", "has_geometry", "properties")} for c in rows]


# ---------------------------------------------------------------- Phase 3b: floor plan -> model
@router.post("/projects/{project_id}/plan/trace", status_code=status.HTTP_202_ACCEPTED)
def trace_plan(project_id: uuid.UUID, body: SourceIn, request: Request, response: Response,
               user: CurrentUser = Depends(get_current_user), idempotency_key: str | None = Header(default=None)):
    _owned_project(request, user, project_id)
    src = _own_file(request, user, project_id, body.source_file_id)
    if src.get("detected_type") not in ("png", "jpeg", "pdf"):
        raise HTTPException(422, {"code": "not_a_plan", "reason": "Choose a floor plan image (PNG or JPEG) or a PDF drawing."})
    _require_token_life(user)
    return _start_job(request, user, str(project_id), "plan_trace", {"source_file_id": str(body.source_file_id)}, idempotency_key, response, run=run_plan_trace)


@router.get("/projects/{project_id}/layout")
def get_layout(project_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user), draft_id: str | None = None):
    _owned_project(request, user, project_id)
    if draft_id:
        d = _own_draft(request, user, draft_id)
        if d.get("project_id") != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Layout not found.")
        drafts = [d]
    else:
        drafts = [d for d in _repo(request).list_drafts(user, str(project_id)) if d.get("owner_id") == user.id]
    if not drafts:
        return {"draft": None, "drafts": []}
    d = drafts[0]
    path = (d["proposal"].get("image") or {}).get("path")
    link = _storage(request).signed_urls(user, [path], bucket=request.app.state.settings.models_bucket).get(path) if path else None
    summary = [{k: x.get(k) for k in ("id", "status", "source_file_id", "created_at")} for x in drafts]
    return {"draft": {k: d.get(k) for k in ("id", "status", "source_file_id", "proposal", "layout", "created_at", "updated_at")} | {"image_url": link},
            "drafts": summary}


@router.put("/projects/{project_id}/layout", status_code=status.HTTP_202_ACCEPTED)
def confirm_layout(project_id: uuid.UUID, body: ConfirmIn, request: Request, response: Response,
                   user: CurrentUser = Depends(get_current_user), idempotency_key: str | None = Header(default=None)):
    _owned_project(request, user, project_id)
    d = _own_draft(request, user, body.draft_id)
    if d.get("project_id") != str(project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Layout not found.")
    _require_token_life(user)
    try:
        layout, notes = to_layout(body)
    except (ValidationError, ValueError) as exc:
        raise HTTPException(422, {"code": "layout_invalid", "reason": _plain(exc)}) from None
    _repo(request).update_draft(user, d["id"], {"status": "confirmed", "layout": layout.model_dump(mode="json")})
    job = _start_job(request, user, str(project_id), "model_build", {"layout_draft_id": d["id"]}, idempotency_key, response, run=run_model_build)
    return {**job, "notes": notes}


def _plain(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        first = exc.errors()[0]
        msg = str(first.get("msg", "")).removeprefix("Value error, ")
        where = ".".join(str(x) for x in first.get("loc", ()) if not isinstance(x, int))
        return f"{msg} ({where})" if where else msg
    return str(exc)
