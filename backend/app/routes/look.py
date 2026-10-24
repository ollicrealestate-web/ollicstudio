"""The project look: approved materials and the hero render (see look.py)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from ..auth import CurrentUser, get_current_user
from ..look import SUGGEST_SYSTEM, Look, apply_suggestions, merge_groups, suggest_request
from ..supabase import BackendUnavailable
from .projects import _owned_project, _repo

router = APIRouter()


class Group(BaseModel):
    key: str = Field(max_length=80)
    cls: str = Field(default="paint", max_length=20)
    hex: str = Field(default="#cccccc", pattern=r"^#[0-9a-fA-F]{6}$")
    map: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    types: list[str] = Field(default_factory=list, max_length=6)


class GroupsIn(BaseModel):
    groups: list[Group] = Field(max_length=60)


def current_look(project: dict) -> Look:
    try:
        return Look.model_validate(project.get("look") or {})
    except ValueError:
        return Look()


def _save(request: Request, user: CurrentUser, project_id: uuid.UUID, look: Look) -> dict:
    try:
        saved = _repo(request).update_project(user, str(project_id), {"look": look.model_dump(mode="json")})
    except BackendUnavailable as exc:
        raise HTTPException(503, {"code": "look_unavailable", "reason": "The project look could not be saved. Try again in a moment."}) from exc
    if not saved:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found.")
    return current_look(saved).model_dump(mode="json")


@router.get("/projects/{project_id}/look")
def get_look(project_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    return current_look(_owned_project(request, user, project_id)).model_dump(mode="json")


@router.put("/projects/{project_id}/look")
def put_look(project_id: uuid.UUID, body: Look, request: Request, user: CurrentUser = Depends(get_current_user)):
    _owned_project(request, user, project_id)
    repo = _repo(request)
    for m in body.materials:
        if m.sample_file_id:
            f = repo.get_source_file(user, str(m.sample_file_id))
            if not f or f.get("owner_id") != user.id or f.get("project_id") != str(project_id) or f.get("detected_type") not in ("png", "jpeg"):
                raise HTTPException(status.HTTP_404_NOT_FOUND, "A material sample is not in this project.")
    if body.hero_render_id:
        r = repo.get_rendered_image(user, str(body.hero_render_id))
        if not r or r.get("owner_id") != user.id or r.get("project_id") != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "That render is not in this project.")
    return _save(request, user, project_id, body)


@router.post("/projects/{project_id}/look/materials")
def add_model_materials(project_id: uuid.UUID, body: GroupsIn, request: Request, user: CurrentUser = Depends(get_current_user)):
    """The model's materials, from the 3D viewer: new ones are added with names from their class and
    colour; the architect's own names, finishes and colours are kept."""
    project = _owned_project(request, user, project_id)
    look = current_look(project)
    before = [m.model_dump(mode="json") for m in look.materials]
    look = merge_groups(look, [g.model_dump() for g in body.groups])
    if [m.model_dump(mode="json") for m in look.materials] == before:
        return look.model_dump(mode="json")
    return _save(request, user, project_id, look)


class SuggestIn(BaseModel):
    view_file_id: uuid.UUID
    material_file_id: uuid.UUID
    description: str = Field(default="", max_length=1500)


@router.post("/projects/{project_id}/look/suggest")
def suggest_look(project_id: uuid.UUID, body: SuggestIn, request: Request, user: CurrentUser = Depends(get_current_user)):
    """Claude studies the captured view and its material map and names each material (name, finish, colour),
    adds what a render needs that the model does not list, and suggests a setting. What the architect has
    confirmed or written stays as it is."""
    from ..prompt_writer import PromptWriterFailed, _image_block
    from .projects import _storage
    project = _owned_project(request, user, project_id)
    writer = getattr(request.app.state, "prompt_writer", None)
    if writer is None or not hasattr(writer, "ask_json"):
        raise HTTPException(503, {"code": "not_configured", "reason": "Reading materials needs Claude, which is not connected yet. Name them yourself for now."})
    repo, storage = _repo(request), _storage(request)
    files = []
    for fid in (body.view_file_id, body.material_file_id):
        f = repo.get_source_file(user, str(fid))
        if not f or f.get("owner_id") != user.id or f.get("project_id") != str(project_id) or f.get("detected_type") not in ("png", "jpeg"):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "The captured view is not in this project.")
        files.append(f)
    look = current_look(project)
    if not [m for m in look.materials if not m.extra]:
        raise HTTPException(422, {"code": "no_materials", "reason": "Capture a view of your model first, so its materials are listed."})
    from ..vision import image_png, load_image
    imgs = []
    for f in files:
        data = storage.download(user, f["storage_path"])
        imgs.append(image_png(load_image(data, f["detected_type"]), max_side=1400))
    content = [{"type": "text", "text": "Image 1 (model view):"}, _image_block(imgs[0]), {"type": "text", "text": "Image 2 (material map):"},
               _image_block(imgs[1]), {"type": "text", "text": suggest_request(look, body.description)}]
    try:
        out = writer.ask_json(SUGGEST_SYSTEM, content, max_tokens=2500)
    except (PromptWriterFailed, KeyError, TypeError) as exc:
        raise HTTPException(502, {"code": "read_failed", "reason": "Claude could not read the materials this time. Try again in a moment."}) from exc
    try:
        repo.create_usage_event(user, {"project_id": str(project_id), "provider": "anthropic", "model": out.get("model") or getattr(writer, "model", "claude"),
                                       "operation": "vision_read", "cost_usd": str(out["cost_usd"]) if out.get("cost_usd") is not None else None,
                                       "price_source": "platform.claude.com price list", "raw_usage": out.get("usage")})
    except BackendUnavailable:
        pass
    look = apply_suggestions(look, out.get("answer") or {})
    saved = _save(request, user, project_id, look)
    return saved | {"notes": str((out.get("answer") or {}).get("notes") or "")[:300]}
