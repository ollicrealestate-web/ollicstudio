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
from ..engines import IMAGE_ENGINES, VIDEO_ENGINES
from ..jobs import ACTIVE, FINISHED, is_stale, now_iso
from ..renders import run_render_job
from ..supabase import BackendUnavailable
from ..vision import VisionUnavailable, load_image, summary_text
from .projects import NOT_FOUND, _owned_project, _repo, _storage

router = APIRouter()
MAX_ACTIVE_PER_PROJECT = 3
MIN_TOKEN_LIFE = 300  # seconds a token must still be valid for, since the job acts with it
KEY_RE = re.compile(r"^[A-Za-z0-9_.:-]{8,200}$")
JOB_FIELDS = ("id", "project_id", "type", "status", "stage", "error", "result", "created_at", "started_at", "finished_at")


def _clean(v: str) -> str:
    return " ".join(v.split())


class Reference(BaseModel):
    file_id: uuid.UUID
    role: Literal["base", "model", "plan", "style"]


class AnimHero(BaseModel):
    """Marks a render as the photoreal version of one of the construction animation's hero views."""
    index: int = Field(ge=0, le=2)
    key: str = Field(pattern=r"^[A-Za-z0-9_-]{4,64}$")


class ConceptRenderIn(BaseModel):
    prompt: str = Field(min_length=3, max_length=2500)
    reference_file_id: uuid.UUID | None = None          # older clients: one base image
    references: list[Reference] = Field(default_factory=list, max_length=4)
    view: Literal["exterior", "aerial", "cutaway", "interior"] = "exterior"
    style: Literal["", "luxury contemporary", "minimalist modern", "classic luxury", "tropical modern"] = ""
    storeys: int | None = Field(default=None, ge=1, le=60)
    ground_floor: Literal["", "car park", "shops", "lobby", "flats"] = ""
    time_of_day: Literal["morning", "midday", "golden hour", "dusk", "night"] = "midday"
    materials: str = Field(default="", max_length=400)
    landscaping: str = Field(default="", max_length=400)
    aspect: Literal["landscape", "portrait", "square"] = "landscape"
    quality: Literal["medium", "high", "max"] = "high"   # Premium render only; Standard has one level
    tier: Literal["standard", "premium", "swift", "ultra", "studio", "vs"] = "standard"
    anim_hero: AnimHero | None = None
    anim_line: AnimHero | None = None     # the result is the line drawing of an animation view

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

    @field_validator("references")
    @classmethod
    def one_of_each(cls, refs):
        roles = [r.role for r in refs]
        for role in ("base", "model", "plan"):
            if roles.count(role) > 1:
                raise ValueError(f"Use one {role} image at most.")
        if roles.count("style") > 3:
            raise ValueError("Use up to three style references.")
        if "base" in roles and "model" in roles:
            raise ValueError("Choose either a design image or a 3D model view to keep, not both.")
        if len({r.file_id for r in refs}) != len(refs):
            raise ValueError("The same file is used twice.")
        return refs


class EditIn(BaseModel):
    instruction: str = Field(min_length=3, max_length=1000)
    tier: Literal["standard", "premium", "swift", "ultra", "studio", "vs"] | None = None  # default: the same option as the render being revised
    anim_line: "AnimHero | None" = None   # marks the result as the line drawing of an animation view

    @field_validator("instruction")
    @classmethod
    def text(cls, v: str) -> str:
        v = _clean(v)
        if len(v) < 3:
            raise ValueError("Say what to change.")
        return v


def public_job(job: dict) -> dict:
    return {k: job.get(k) for k in JOB_FIELDS}


TIER_NAME = {"standard": "Standard render", "premium": "Premium render", **{k: e["name"] for k, e in IMAGE_ENGINES.items()}}


def user_plan(request: Request, user: CurrentUser) -> str:
    profile = _repo(request).get_profile(user)
    return (profile or {}).get("plan") or "free"


UNLIMITED_ROLES = ("admin", "reviewer")
FREE_UNLIMITED_ROLES = UNLIMITED_ROLES + ("tester",)   # testers: free features without daily limits
EVER = "1970-01-01T00:00:00+00:00"
# one-time allowances of paid options (profiles.allowances), and the job tier each is counted by
ALLOWANCE_TIER = {"vs_image": "vs", "vs_video": "clip-vs"}


def allowance_left(request: Request, user: CurrentUser, key: str, profile: dict | None = None) -> int | None:
    """How many of a one-time paid allowance are left; None when the account has none.
    Only queued, running and finished jobs count, so a failed attempt is not used up."""
    profile = profile if profile is not None else (_repo(request).get_profile(user) or {})
    total = (profile.get("allowances") or {}).get(key)
    if not isinstance(total, int) or total <= 0:
        return None
    used = _repo(request).count_jobs_since(user, EVER, ("queued", "running", "succeeded"), ALLOWANCE_TIER[key])
    return max(0, total - used)


def daily_limit(request: Request, user: CurrentUser, tier: str) -> int:
    """Renders a day for this account and tier; 0 means no limit. Owner and test accounts
    (profiles.role 'admin' or 'reviewer') have none; customers have the configured allowance."""
    profile = _repo(request).get_profile(user) or {}
    if profile.get("role") in UNLIMITED_ROLES or (profile.get("role") == "tester" and tier == "standard"):
        return 0
    return request.app.state.settings.daily_limit_for(tier)


def _require_tier(request: Request, user: CurrentUser, tier: str) -> None:
    if request.app.state.image_clients.get(tier) is None:
        reason = f"{TIER_NAME[tier]} is not connected yet." if tier in IMAGE_ENGINES else f"{TIER_NAME[tier]} is not switched on for this site yet."
        raise HTTPException(503, {"code": "not_configured", "reason": reason})
    profile = _repo(request).get_profile(user) or {}
    if tier in IMAGE_ENGINES and user_plan(request, user) != "premium" and profile.get("role") not in UNLIMITED_ROLES:
        left = allowance_left(request, user, "vs_image", profile) if tier == "vs" else None
        if left == 0:
            raise HTTPException(403, {"code": "allowance_used", "reason": f"You have used your free {TIER_NAME[tier]} pictures. Standard renders stay free."})
        if left is None:
            raise HTTPException(403, {"code": "premium_only", "reason": f"{TIER_NAME[tier]} is for paid plans. Standard renders are free."})
    if tier == "premium" and user_plan(request, user) != "premium" and (_repo(request).get_profile(user) or {}).get("role") not in UNLIMITED_ROLES:
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
            "error": ("This model reading was interrupted before it finished, probably by a server restart. Choose the file again to retry." if job.get("type") == "ifc_import"
                      else "This was interrupted before it finished, probably by a server restart. Start it again."),
        })
        return updated or job
    return job


def _utc_midnight() -> str:
    return datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()


def _start_job(request: Request, user: CurrentUser, project_id: str, job_type: str, job_input: dict, key: str | None, response: Response, run=None,
               max_active: int = MAX_ACTIVE_PER_PROJECT) -> dict:
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
    tier = job_input.get("tier")
    limit = daily_limit(request, user, tier) if tier else 0
    if limit > 0:
        used = repo.count_jobs_since(user, _utc_midnight(), ("queued", "running", "succeeded"), tier)
        if used >= limit:
            kind = "free renders" if tier == "standard" else f"{TIER_NAME.get(tier, 'premium')} renders" if tier in IMAGE_ENGINES else "premium renders"
            raise HTTPException(429, {"code": "daily_limit", "reason": f"You have used today's {limit} {kind}. They reset at 01:00 Lagos time (midnight UTC)."})
    active = [j for j in repo.list_jobs(user, project_id) if j.get("status") in ACTIVE and not is_stale(j)]
    if len(active) >= max_active:
        raise HTTPException(429, {"code": "too_many_active", "reason": f"This project already has {len(active)} renders in progress. Wait for one to finish."})
    job = repo.create_job(user, {"project_id": project_id, "type": job_type, "status": "queued", "stage": "Waiting to start",
                                 "input": job_input, "idempotency_key": key})
    request.app.state.runner.submit(run or run_render_job, request.app.state, user, job["id"])
    return public_job(repo.get_job(user, job["id"]) or job)


@router.post("/projects/{project_id}/architectural-render", status_code=status.HTTP_202_ACCEPTED)
def start_concept_render(project_id: uuid.UUID, body: ConceptRenderIn, request: Request, response: Response,
                         user: CurrentUser = Depends(get_current_user), idempotency_key: str | None = Header(default=None)):
    _owned_project(request, user, project_id)
    _require_tier(request, user, body.tier)
    _require_token_life(user)
    refs = list(body.references)
    if body.reference_file_id and not refs:
        refs = [Reference(file_id=body.reference_file_id, role="base")]
    for r in refs:
        src = _repo(request).get_source_file(user, str(r.file_id))
        if not src or src.get("owner_id") != user.id or src.get("project_id") != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Reference image not found in this project.")
        if src.get("detected_type") not in ("png", "jpeg", "pdf") or (src["detected_type"] == "pdf" and r.role != "plan"):
            raise HTTPException(422, {"code": "unsupported_reference", "reason": "References must be PNG or JPEG images (a PDF can be used as the floor plan). For an IFC model, take a 3D view shot instead."})
    job_input = body.model_dump(mode="json")
    job_input["references"] = [{"file_id": str(r.file_id), "role": r.role} for r in refs]
    job_input.pop("reference_file_id", None)
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
    return _start_job(request, user, image["project_id"], "concept_edit", {"parent_image_id": str(render_id), "instruction": body.instruction, "tier": tier,
                                                                         **({"anim_line": body.anim_line.model_dump()} if body.anim_line else {})}, idempotency_key, response)


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
    paths = [i["storage_path"] for i in images] + [i["base_path"] for i in images if i.get("base_path")]
    links = _storage(request).signed_urls(user, paths, bucket=settings.renders_bucket) if images else {}
    out = []
    for i in images:
        url = links.get(i["storage_path"])
        name = f"ollic-{i['kind']}-{i['id'][:8]}{'-AI-concept-not-to-scale' if i['kind'] == 'concept' else ''}.jpg"
        tier = (i.get("options") or {}).get("tier") or ("premium" if str(i.get("model", "")).startswith("gpt-") else "standard")
        out.append({k: i.get(k) for k in ("id", "kind", "label", "prompt", "parent_image_id", "source_file_id", "options", "width", "height", "created_at", "job_id")}
                   | {"tier": tier, "tier_name": TIER_NAME[tier], "url": url, "download_url": f"{url}&download={name}" if url else None,
                      "base_url": links.get(i.get("base_path") or "")})   # unlabelled, for videos that draw the label themselves
    jobs = [_settle_stale(request, user, j) for j in repo.list_jobs(user, str(project_id)) if j.get("owner_id") == user.id]
    plan = user_plan(request, user)
    clients = request.app.state.image_clients
    profile = repo.get_profile(user) or {}
    unlimited = profile.get("role") in UNLIMITED_ROLES
    left = {k: allowance_left(request, user, k, profile) for k in ALLOWANCE_TIER} if not unlimited and plan != "premium" else {}
    tiers = {t: {"name": TIER_NAME[t], "available": clients.get(t) is not None, "allowed": t == "standard" or plan == "premium" or unlimited,
                 "daily_limit": daily_limit(request, user, t) or None} for t in ("standard", "premium")}
    # the added options, beside the two above; listed even when not connected
    for t, e in IMAGE_ENGINES.items():
        mine = left.get("vs_image") if t == "vs" else None
        tiers[t] = {"name": e["name"], "available": clients.get(t) is not None, "allowed": plan == "premium" or unlimited or bool(mine), "left": mine,
                    "daily_limit": daily_limit(request, user, t) or None, "blurb": e["blurb"], "price": e["price"], "soon": bool(e.get("soon"))}
    clip_left = left.get("vs_video")
    video_engines = {k: {"name": e["name"], "blurb": e["blurb"], "price": e["price"], "soon": bool(e.get("soon")),
                         "allowed": plan == "premium" or unlimited or (k == "vs" and bool(clip_left)), "left": clip_left if k == "vs" else None,
                         "available": (getattr(request.app.state, "video_clients", None) or {}).get(k) is not None} for k, e in VIDEO_ENGINES.items()}
    return {"renders_enabled": any(v["available"] for v in tiers.values()), "plan": plan, "tiers": tiers, "video_engines": video_engines,
            "images": out, "jobs": [public_job(j) for j in jobs]}


@router.get("/usage")
def usage(request: Request, user: CurrentUser = Depends(get_current_user)):
    events = [e for e in _repo(request).list_usage_events(user) if e.get("owner_id") == user.id]
    known = [Decimal(str(e["cost_usd"])) for e in events if e.get("cost_usd") is not None]
    return {
        "events": [{k: e.get(k) for k in ("id", "project_id", "job_id", "cost_usd", "created_at")} | {"service": _service(e)} for e in events],
        "total_cost_usd": str(sum(known, Decimal("0"))),
        "calls": len(events),
        "calls_without_cost": len(events) - len(known),
        "note": "What each render cost to make. Credits and prices for customers come in Phase 7.",
    }


@router.delete("/renders/{render_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_render(render_id: uuid.UUID, request: Request, user: CurrentUser = Depends(get_current_user)):
    """Deletes a render and its stored pictures. Revisions made from it stay."""
    repo = _repo(request)
    img = repo.get_rendered_image(user, str(render_id))
    if not img or img.get("owner_id") != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Render not found.")
    paths = [p for p in (img.get("storage_path"), img.get("base_path")) if p]
    _storage(request).remove(user, paths, bucket=request.app.state.settings.renders_bucket)
    repo.delete_rendered_image(user, img["id"])


def _service(e: dict) -> str:
    """Customers see what they used, never which AI provider did it."""
    if e.get("operation") == "vision_read":
        return "Plan reading"
    if e.get("operation") == "prompt_write":
        return "Premium prompting"
    if e.get("operation") == "animation_direct":
        return "Animation director"
    if e.get("operation") == "video_generate":
        return "Cinematic clip · " + ("Ollic VS" if e.get("provider") == "fal" else "Ollic Motion")
    if e.get("provider") == "fal":
        return "Ollic VS"
    if e.get("provider") == "google":
        return "Ollic Ultra" if "pro" in str(e.get("model")) else "Ollic Swift"
    return "Premium render" if e.get("provider") == "openai" else "Standard render"


# ---------------------------------------------------------------- "Read my plan"
class PlanReadIn(BaseModel):
    source_file_id: uuid.UUID


@router.post("/projects/{project_id}/plan/read")
def read_plan(project_id: uuid.UUID, body: PlanReadIn, request: Request, user: CurrentUser = Depends(get_current_user)):
    """Describes the architect's floor plan in plain words, as a starting point for the render brief."""
    _owned_project(request, user, project_id)
    src = _repo(request).get_source_file(user, str(body.source_file_id))
    if not src or src.get("owner_id") != user.id or src.get("project_id") != str(project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found in this project.")
    if src.get("detected_type") not in ("png", "jpeg", "pdf"):
        raise HTTPException(422, {"code": "not_a_plan", "reason": "Choose a floor plan image (PNG or JPEG) or a PDF drawing."})
    reader = getattr(request.app.state, "vision", None)
    if reader is None:
        raise HTTPException(503, {"code": "not_configured", "reason": "Plan reading is not switched on for this site yet."})
    try:
        img = load_image(_storage(request).download(user, src["storage_path"]), src["detected_type"])
        reading = reader.read_plan(img)
    except VisionUnavailable as exc:
        raise HTTPException(502, {"code": "vision_failed", "reason": "The plan could not be read this time. Try again, or write the brief yourself."}) from exc
    try:
        _repo(request).create_usage_event(user, {
            "project_id": str(project_id), "provider": "cloudflare", "model": reading.get("model") or "vision", "operation": "vision_read",
            "cost_usd": None, "price_source": "inside Cloudflare's free daily allowance; no per-token price on file", "raw_usage": reading.get("usage"),
        })
    except BackendUnavailable:
        pass
    reading.pop("usage", None)
    return {"reading": reading, "summary": summary_text(reading)}
