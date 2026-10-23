"""Phase 3: architects' IFC models, imported for rendering and animation."""

from __future__ import annotations

import json
import tempfile
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Request, Response, UploadFile, status
from pydantic import BaseModel, Field, ValidationError, field_validator

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


# ---------------------------------------------------------------- models read on the architect's computer
MAX_GLB = 100 * 1024 * 1024        # the models bucket's limit
Scalar = str | int | float | bool | None


class ComponentIn(BaseModel):
    global_id: str = Field(max_length=64)
    ifc_type: str = Field(max_length=64, pattern=r"^Ifc[A-Za-z0-9]+$")
    name: str | None = Field(default=None, max_length=200)
    family: Literal["structure", "openings", "finishes", "furniture", "mep", "spaces", "other"]
    storey: str | None = Field(default=None, max_length=200)
    has_geometry: bool = False
    properties: dict[str, Scalar] = Field(default_factory=dict)

    @field_validator("properties")
    @classmethod
    def small(cls, v):
        return {str(k)[:120]: (x[:500] if isinstance(x, str) else x) for k, x in list(v.items())[:40]}


class CheckIn(BaseModel):
    key: str = Field(max_length=40)
    status: Literal["pass", "warn", "fail", "info"]
    message: str = Field(max_length=600)


class ReportIn(BaseModel):
    status: Literal["pass", "warn", "fail"]
    schema_: str = Field(alias="schema", max_length=40)
    units: str = Field(default="", max_length=60)
    checks: list[CheckIn] = Field(max_length=30)
    counts: dict[str, int] = Field(default_factory=dict)
    families: dict[str, int] = Field(default_factory=dict)
    storeys: list[str] = Field(default_factory=list, max_length=300)
    size_m: list[float] = Field(default_factory=list, max_length=3)
    elements: int = 0
    with_geometry: int = 0


class BrowserModelIn(BaseModel):
    source_file_id: uuid.UUID
    report: ReportIn
    components: list[ComponentIn] = Field(max_length=20000)


@router.post("/projects/{project_id}/models/from-browser", status_code=status.HTTP_201_CREATED)
async def save_browser_model(project_id: uuid.UUID, request: Request, file: UploadFile = File(...), meta: str = Form(...),
                             user: CurrentUser = Depends(get_current_user)):
    """Saves a model the architect's browser read from their IFC (web-ifc): the 3D file goes
    straight from disk into storage, and the model and its parts are recorded."""
    _owned_project(request, user, project_id)
    try:
        m = BrowserModelIn.model_validate(json.loads(meta))
    except (ValueError, ValidationError) as exc:
        raise HTTPException(422, {"code": "bad_model", "reason": "The model details were not valid. Reload the page and try again."}) from exc
    src = _own_file(request, user, project_id, m.source_file_id)
    if src.get("detected_type") != "ifc":
        raise HTTPException(422, {"code": "not_ifc", "reason": "Only IFC files can be read as a model."})
    repo, storage, settings = _repo(request), _storage(request), request.app.state.settings
    with tempfile.NamedTemporaryFile(suffix=".glb") as tmp:
        size, head = 0, b""
        while chunk := await file.read(1024 * 1024):
            if not head:
                head = chunk[:12]
            size += len(chunk)
            if size > MAX_GLB:
                raise HTTPException(413, {"code": "too_large", "reason": "The 3D model is larger than 100 MB. Export a lighter IFC (leave out the site, furniture and linked models)."})
            tmp.write(chunk)
        tmp.flush()
        if head[:4] != b"glTF" or int.from_bytes(head[4:8], "little") != 2:
            raise HTTPException(422, {"code": "bad_model", "reason": "The 3D model was not made correctly. Reload the page and try again."})
        model_id = str(uuid.uuid4())
        glb_path = f"{user.id}/{project_id}/{model_id}.glb"
        storage.upload_file(user, glb_path, tmp.name, "model/gltf-binary", bucket=settings.models_bucket)
    report = m.report.model_dump(by_alias=True) | {"read_on": "browser"}
    stats = {"elements": m.report.elements, "with_geometry": m.report.with_geometry, "glb_bytes": size, "mep": m.report.families.get("mep", 0), "read_on": "browser"}
    try:
        model = repo.create_model(user, {"id": model_id, "project_id": str(project_id), "source_file_id": str(m.source_file_id), "job_id": None,
                                         "schema_version": m.report.schema_, "glb_path": glb_path, "report": report, "stats": stats})
        repo.add_components(user, [{**c.model_dump(), "model_id": model_id, "project_id": str(project_id)} for c in m.components])
    except Exception:
        storage.remove(user, [glb_path], bucket=settings.models_bucket)
        if "model" in locals():
            repo.delete_model(user, model_id)
        raise
    link = storage.signed_urls(user, [glb_path], bucket=settings.models_bucket).get(glb_path)
    return {k: model.get(k) for k in ("id", "source_file_id", "schema_version", "report", "stats", "created_at")} | {"glb_url": link}
