"""Concept render endpoints (brief Module C, Phase 2), plus job status, outputs and usage."""

from __future__ import annotations

import re
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, field_validator

from ..auth import CurrentUser, get_current_user
from ..jobs import ACTIVE, FINISHED, is_stale, now_iso
from ..renders import REF_MIME, run_render_job
from .projects import NOT_FOUND, _owned_project, _repo, _storage

router = APIRouter()
MAX_ACTIVE_PER_PROJECT = 3
MIN_TOKEN_LIFE = 300  # seconds a token must still be valid for, since the job acts with it
KEY_RE = re.compile(r"^[A-Za-z0-9_.:-]{8,200}$")
JOB_FIELDS = ("id", "project_id", "type", "status", "stage", "error", "result", "created_at", "started_at", "finished_at")


def _clean(v: str) -> str:
    return " ".join(v.split())


class ConceptRenderIn(BaseModel):
    prompt: str = Field(min_length=3, max_length=2000)
    reference_file_id: uuid.UUID | None = None
    view: Literal["exterior", "interior", "aerial"] = "exterior"
    time_of_day: Literal["morning", "midday", "golden hour", "dusk", "night"] = "midday"
    materials: str = Field(default="", max_length=400)
    landscaping: str = Field(default="", max_length=400)
    aspect: Literal["landscape", "portrait", "square"] = "landscape"
    quality: Literal["medium", "high"] = "medium"   # Premium render only; Standard has one level
    tier: Literal["standard", "premium"] = "standard"

    @field_validator("prompt")
    @classmethod
    def prompt_text(cls, v: str) -> str:
        v = _clean(v)
        if len(v) < 3:
            raise ValueError("Describe what you want to see.")
        return v

    @field_validator("materials", "landscaping")
    @classmethod
    def tidy(cls, v: str) -> str:
        return _clean(v)


class EditIn(BaseModel):
    instruction: str = Field(min_length=3, max_length=1000)
    tier: Literal["standard", "premium"] | None = None  # default: the same tier as the render being revised

    @field_validator("instruction")
    @classmethod
    def text(cls, v: str) -> str:
        v = _clean(v)
        if len(v) < 3:
            raise ValueError("Say what to change.")
        return v


def public_job(job: dict) -> dict:
    return {k: job.get(k) for k in JOB_FIELDS}


TIER_NAME = {"standard": "Standard render", "premium": "Premium render"}


def user_plan(request: Request, user: CurrentUser) -> str:
    profile = _repo(request).get_profile(user)
    return (profile or {}).get("plan") or "free"


def _require_tier(request: Request, user: CurrentUser, tier: str) -> None:
    if request.app.state.image_clients.get(tier) is None:
        raise HTTPException(503, {"code": "not_configured", "reason": f"{TIER_NAME[tier]} is not switched on for this site yet."})
    if tier == "premium" and user_plan(request, user) != "premium":
        raise HTTPException(403, {"code": "premium_only", "reason": "Premium render is for paid plans. Standard renders are free."})


def _require_token_life(user: CurrentUser) -> None:
    if user.expires_at is not None and user.expires_at - time.time() < MIN_TOKEN_LIFE:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Your session is about to expire. Refresh and try again.", headers={"WWW-Authenticate": "Bearer"})


def _owned_job(request: Request, user: CurrentUser, job_id: uuid.UUID) -> dict:
    job = _repo(request).get_job(user, str(job_id))
    if not job or job.get("owner_id") != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found.")
    return _settle_stale(request, user, job)


def _settle_stale(request: Request, user: CurrentUser, job: dict) -> dict:
    """A job nobody has touched for a long time was cut off (for example by a restart): say so."""
    if is_stale(job):
        updated = _repo(request).update_job(user, job["id"], {
            "status": "failed", "stage": None, "finished_at": now_iso(),
            "error": "This render was interrupted before it finished, probably by a server restart. Start it again.",
        })
        return updated or job
    return job


def _utc_midnight() -> str:
    return datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()


def _start_job(request: Request, user: CurrentUser, project_id: str, job_type: str, job_input: dict, key: str | None, response: Response) -> dict:
    repo = _repo(request)
    if key is not None:
        if not KEY_RE.match(key):
            raise HTTPException(422, {"code": "bad_idempotency_key", "reason": "Idempotency-Key must be 8–200 letters, digits or - _ . :"})
        existing = repo.find_job_by_key(user, key)
        if existing:
            if existing.get("project_id") != project_id or existing.get("type") != job_type:
                raise HTTPException(409, {"code": "idempotency_conflict", "reason": "That Idempotency-Key was already used for a different request."})
            response.status_code = status.HTTP_200_OK
            return public_job(_settle_stale(request, user, existing))
    tier = job_input["tier"]
    limit = request.app.state.settings.daily_limit_for(tier)
    if limit > 0:
        used = repo.count_jobs_since(user, _utc_midnight(), ("queued", "running", "succeeded"), tier)
        if used >= limit:
            kind = "premium renders" if tier == "premium" else "free renders"
            raise HTTPException(429, {"code": "daily_limit", "reason": f"You have used today's {limit} {kind}. They reset at 01:00 Lagos time (midnight UTC)."})
    active = [j for j in repo.list_jobs(user, project_id) if j.get("status") in ACTIVE and not is_stale(j)]
    if len(active) >= MAX_ACTIVE_PER_PROJECT:
        raise HTTPException(429, {"code": "too_many_active", "reason": f"This project already has {len(active)} renders in progress. Wait for one to finish."})
    job = repo.create_job(user, {"project_id": project_id, "type": job_type, "status": "queued", "stage": "Waiting to start",
                                 "input": job_input, "idempotency_key": key})
    request.app.state.runner.submit(run_render_job, request.app.state, user, job["id"])
    return public_job(repo.get_job(user, job["id"]) or job)


@router.post("/projects/{project_id}/architectural-render", status_code=status.HTTP_202_ACCEPTED)
def start_concept_render(project_id: uuid.UUID, body: ConceptRenderIn, request: Request, response: Response,
                         user: CurrentUser = Depends(get_current_user), idempotency_key: str | None = Header(default=None)):
    _owned_project(request, user, project_id)
    _require_tier(request, user, body.tier)
    _require_token_life(user)
    if body.reference_file_id:
        src = _repo(request).get_source_file(user, str(body.reference_file_id))
        if not src or src.get("owner_id") != user.id or src.get("project_id") != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Reference image not found in this project.")
        if src.get("detected_type") not in REF_MIME:
            raise HTTPException(422, {"code": "unsupported_reference", "reason": "Concept renders can start from a PNG or JPEG image. For a PDF drawing, export the page as an image first."})
    job_input = body.model_dump(mode="json")
    return _start_job(request, user, str(project_id), "concept_render", job_input, idempotency_key, response)


@router.post("/renders/{render_id}/edit", status_code=status.HTTP_202_ACCEPTED)
def edit_render(render_id: uuid.UUID, body: EditIn, request: Request, response: Response,
                user: CurrentUser = Depends(get_current_user), idempotency_key: str | None = Header(default=None)):
    image = _repo(request).get_rendered_image(user, str(render_id))
    if not image or image.get("owner_id") != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Render not found.")
    _owned_project(request, user, uuid.UUID(image["project_id"]))
    tier = body.tier or (image.get("options") or {}).get("tier") or "standard"
    _require_tier(request, user, tier)
    _require_token_life(user)
    if image.get("kind") != "concept":
        raise HTTPException(422, {"code": "not_a_concept", "reason": "Only concept renders can be revised this way."})
    return _start_job(request, user, image["project_id"], "concept_edit", {"parent_image_id": str(render_id), "instruction": body.instruction, "tier": tier}, idempotency_key, response)


@router.get("/jobs/{job_id}")
def get_job(job_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    return public_job(_owned_job(request, user, job_id))


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    job = _owned_job(request, user, job_id)
    if job["status"] in FINISHED:
        raise HTTPException(409, {"code": "already_finished", "reason": f"This job has already {job['status']}."})
    note = "Cancelled." if job["status"] == "queued" else "Cancelled. The image model had already started, so that call may still be charged."
    updated = _repo(request).update_job(user, job["id"], {"status": "cancelled", "stage": note, "finished_at": now_iso()})
    return public_job(updated or job)


@router.get("/projects/{project_id}/outputs")
def list_outputs(project_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    _owned_project(request, user, project_id)
    repo, settings = _repo(request), request.app.state.settings
    images = [i for i in repo.list_rendered_images(user, str(project_id)) if i.get("owner_id") == user.id]
    links = _storage(request).signed_urls(user, [i["storage_path"] for i in images], bucket=settings.renders_bucket) if images else {}
    out = []
    for i in images:
        url = links.get(i["storage_path"])
        name = f"ollic-{i['kind']}-{i['id'][:8]}{'-AI-concept-not-to-scale' if i['kind'] == 'concept' else ''}.jpg"
        tier = (i.get("options") or {}).get("tier") or ("premium" if str(i.get("model", "")).startswith("gpt-") else "standard")
        out.append({k: i.get(k) for k in ("id", "kind", "label", "prompt", "parent_image_id", "source_file_id", "options", "width", "height", "created_at", "job_id")}
                   | {"tier": tier, "tier_name": TIER_NAME[tier], "url": url, "download_url": f"{url}&download={name}" if url else None})
    jobs = [_settle_stale(request, user, j) for j in repo.list_jobs(user, str(project_id)) if j.get("owner_id") == user.id]
    plan = user_plan(request, user)
    clients = request.app.state.image_clients
    tiers = {t: {"name": TIER_NAME[t], "available": clients.get(t) is not None, "allowed": t == "standard" or plan == "premium",
                 "daily_limit": settings.daily_limit_for(t) or None} for t in ("standard", "premium")}
    return {"renders_enabled": any(v["available"] for v in tiers.values()), "plan": plan, "tiers": tiers,
            "images": out, "jobs": [public_job(j) for j in jobs]}


@router.get("/usage")
def usage(request: Request, user: CurrentUser = Depends(get_current_user)):
    events = [e for e in _repo(request).list_usage_events(user) if e.get("owner_id") == user.id]
    known = [Decimal(str(e["cost_usd"])) for e in events if e.get("cost_usd") is not None]
    return {
        "events": [{k: e.get(k) for k in ("id", "project_id", "job_id", "provider", "model", "operation", "input_text_tokens", "input_image_tokens", "output_tokens", "cost_usd", "price_source", "created_at")} for e in events],
        "total_cost_usd": str(sum(known, Decimal("0"))),
        "calls": len(events),
        "calls_without_cost": len(events) - len(known),
        "note": "Costs are what the image model charged Ollic, worked out from the tokens it reported. Credits and prices for customers come in Phase 7.",
    }
