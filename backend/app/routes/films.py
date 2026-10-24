"""AI walkthroughs from the architect's model: Claude plans the shots, the browser records an exact
guide of each camera move, and a job turns it into a photoreal shot (see film.py)."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, ValidationError

from ..animation_jobs import upload_path
from ..auth import CurrentUser, get_current_user
from ..engines import FILM_ENGINES, IMAGE_ENGINES
from ..film import ENGINE_MODEL, SHOT_KINDS, run_film_job
from ..runway import MAX_SECONDS, cost as runway_cost
from ..video import VideoFailed, probe
from .projects import _owned_project, _repo, _storage
from .renders import UNLIMITED_ROLES, _require_tier, _require_token_life, _start_job, _utc_midnight, allowance_left, daily_limit, user_plan

log = logging.getLogger("ollic.films")
router = APIRouter()
MAX_GUIDE = 30 * 1024 * 1024      # the video service reads guides of up to 32 MB from a link
SIZES = {"16:9": (1280, 720), "9:16": (720, 1280), "1:1": (960, 960)}
ASPECT = {"16:9": "landscape", "9:16": "portrait", "1:1": "square"}


def _to_h264(src) -> bytes:
    """A guide recorded as VP9 becomes H.264 (clay pictures compress fast; a 10 s shot takes seconds)."""
    import subprocess
    import tempfile
    from pathlib import Path

    from ..video import ffmpeg_path
    with tempfile.TemporaryDirectory(prefix="ollic-guide-") as tmp:
        out = Path(tmp) / "guide.mp4"
        cmd = [ffmpeg_path(), "-y", "-v", "error", "-i", str(src), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)]
        try:
            subprocess.run(cmd, check=True, timeout=180, capture_output=True)
        except (subprocess.SubprocessError, OSError) as exc:
            log.warning("guide conversion failed: %s", exc)
            raise HTTPException(422, {"code": "bad_video", "reason": "The guide video could not be read. Try recording it again in Chrome or Edge."}) from exc
        return out.read_bytes()


class ShotMeta(BaseModel):
    name: str = Field(default="Shot", max_length=80)
    kind: Literal["push", "orbit", "approach", "aerial", "rise", "custom"] = "custom"
    engine: Literal["path", "path_plus"] = "path"
    tier: Literal["standard", "premium", "swift", "ultra", "vs"] = "standard"   # the picture option for the first frame
    format: Literal["16:9", "9:16", "1:1"] = "16:9"
    description: str = Field(default="", max_length=1500)
    frame_prompt: str = Field(default="", max_length=6000)
    motion_prompt: str = Field(default="", max_length=2000)
    life: bool = False
    clay_file_id: uuid.UUID
    lines_file_id: uuid.UUID


def _may_film(request: Request, user: CurrentUser, repo) -> str | None:
    """None when allowed; otherwise the reason."""
    profile = repo.get_profile(user) or {}
    if user_plan(request, user) == "premium" or profile.get("role") in UNLIMITED_ROLES:
        return None
    left = allowance_left(request, user, "film", profile)
    if left == 0:
        return "You have used your free AI walkthrough shots."
    return None if left else "AI walkthroughs are for paid plans."


@router.post("/projects/{project_id}/films", status_code=status.HTTP_202_ACCEPTED)
async def make_shot(project_id: uuid.UUID, request: Request, response: Response, file: UploadFile = File(...), meta: str = Form(...),
                    user: CurrentUser = Depends(get_current_user)):
    _owned_project(request, user, project_id)
    _require_token_life(user)
    try:
        m = ShotMeta.model_validate(json.loads(meta))
    except (ValueError, ValidationError) as exc:
        raise HTTPException(422, {"code": "bad_settings", "reason": "The shot settings were not valid. Reload the page and try again."}) from exc
    if getattr(request.app.state, "runway", None) is None:
        raise HTTPException(503, {"code": "not_configured", "reason": f"{FILM_ENGINES[m.engine]['name']} is not connected yet."})
    repo = _repo(request)
    why = _may_film(request, user, repo)
    if why:
        raise HTTPException(403, {"code": "premium_only", "reason": why})
    _require_tier(request, user, m.tier)
    for fid in (m.clay_file_id, m.lines_file_id):
        f = repo.get_source_file(user, str(fid))
        if not f or f.get("owner_id") != user.id or f.get("project_id") != str(project_id) or f.get("detected_type") not in ("png", "jpeg"):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "A guide picture of the shot is not in this project.")
    profile = repo.get_profile(user) or {}
    limit = request.app.state.settings.daily_clips_per_user
    if profile.get("role") not in UNLIMITED_ROLES and limit:
        used = sum(repo.count_jobs_since(user, _utc_midnight(), ("queued", "running", "succeeded"), t) for t in ("clip", "clip-vs", "film"))
        if used >= limit:
            raise HTTPException(429, {"code": "daily_limit", "reason": f"You have made today's {limit} videos. They reset at 01:00 Lagos time."})
    frame_limit = daily_limit(request, user, m.tier)
    if frame_limit and repo.count_jobs_since(user, _utc_midnight(), ("queued", "running", "succeeded"), m.tier) >= frame_limit:
        raise HTTPException(429, {"code": "daily_limit", "reason": "Today's renders of this picture option are used, and each shot needs one for its first frame."})

    tmp = upload_path(f"{uuid.uuid4()}.guide")
    size = 0
    try:
        with open(tmp, "wb") as fh:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_GUIDE:
                    raise HTTPException(413, {"code": "too_large", "reason": "The guide video is larger than 30 MB. Make the shot shorter."})
                fh.write(chunk)
        try:
            info = probe(tmp)
        except VideoFailed as exc:
            raise HTTPException(422, {"code": "bad_video", "reason": exc.message}) from exc
        w, h = SIZES[m.format]
        if (info.width, info.height) != (w, h):
            raise HTTPException(422, {"code": "bad_video", "reason": f"The guide is {info.width}×{info.height}; {m.format} shots are {w}×{h}."})
        top = min(10, MAX_SECONDS[ENGINE_MODEL[m.engine]])
        if not 2 <= info.duration_s <= top + 0.5:
            raise HTTPException(422, {"code": "bad_video", "reason": f"A shot is 2 to {top} seconds long."})
        if info.fps > 30.5:
            raise HTTPException(422, {"code": "bad_video", "reason": "The guide must be 30 frames a second or fewer."})
        data = tmp.read_bytes()
        if info.codec not in ("h264", "av1"):
            # Browsers without H.264 recording send VP9; the video service only takes H.264, H.265 or AV1 in MP4.
            data = await run_in_threadpool(_to_h264, tmp)
        gid = str(uuid.uuid4())
        guide_path = f"{user.id}/{project_id}/guides/{gid}.mp4"
        settings = request.app.state.settings
        _storage(request).upload(user, guide_path, data, "video/mp4", bucket=settings.videos_bucket)
    finally:
        tmp.unlink(missing_ok=True)
    seconds = round(info.duration_s, 2)
    est = runway_cost(ENGINE_MODEL[m.engine], seconds)
    # "tier" counts the job among the day's videos; the first frame uses the picture option "frame_tier"
    job_input = m.model_dump(mode="json", exclude={"tier"}) | {"guide_path": guide_path, "seconds": seconds, "width": w, "height": h, "aspect": ASPECT[m.format],
                                                               "tier": "film", "frame_tier": m.tier, "estimate_usd": str(est)}
    try:
        job = _start_job(request, user, str(project_id), "film_shot", job_input, None, response, run=run_film_job, max_active=4)
    except HTTPException:
        _storage(request).remove(user, [guide_path], bucket=settings.videos_bucket)
        raise
    return job | {"estimate_usd": str(est)}


# ---------------------------------------------------------------- Claude plans the shots
class PlanIn(BaseModel):
    description: str = Field(default="", max_length=1500)
    storeys: list[str] = Field(default_factory=list, max_length=200)
    rooms: list[str] = Field(default_factory=list, max_length=300)
    width_m: float = Field(default=0, ge=0, le=5000)
    depth_m: float = Field(default=0, ge=0, le=5000)
    height_m: float = Field(default=0, ge=0, le=1000)
    seconds: int = Field(default=24, ge=5, le=120)


PLAN_SYSTEM = (
    "You plan short architectural films for architects, shot by shot. The building comes from the architect's model; each shot is a "
    "camera move that Ollic records exactly from the model and an AI then films photoreal, so the geometry stays true. Use only these "
    "camera moves: approach (walk up to the building from the street at eye level), orbit (slow arc around the building at mid height), "
    "aerial (high arc showing the whole site), rise (from eye level up the facade to the roof), push (slow move in on the current view, "
    "good for a detail or an interior). Each shot is 4 to 10 seconds. Order the shots like a short film: arrival, the building, the "
    "detail, the reveal. For each shot write a look prompt for the first frame (materials, light, setting from the architect's description; "
    "tell the image model to keep the geometry exactly) and a motion prompt for the video (keep the camera move and the building exactly; "
    "add the life and light asked for). Never invent floors or features. "
    'Answer with JSON only: {"shots": [{"name": "...", "kind": "approach|orbit|aerial|rise|push", "seconds": 4-10, "frame_prompt": "...", '
    '"motion_prompt": "...", "life": true|false}], "notes": "one sentence for the architect"}'
)


def default_plan(body: PlanIn) -> dict:
    tall = body.height_m > 15
    shots = [{"name": "Arrival", "kind": "approach", "seconds": 8, "life": True},
             {"name": "Around the building", "kind": "orbit", "seconds": 8, "life": False},
             {"name": "Up the facade" if tall else "From above", "kind": "rise" if tall else "aerial", "seconds": 6, "life": False}]
    return {"shots": shots, "notes": "A three-shot film: arrival, the building, the reveal. Edit any shot before filming.", "by": "ollic"}


@router.post("/projects/{project_id}/film-plan")
def plan_film(project_id: uuid.UUID, body: PlanIn, request: Request, user: CurrentUser = Depends(get_current_user)):
    _owned_project(request, user, project_id)
    writer = getattr(request.app.state, "prompt_writer", None)
    if writer is None or not hasattr(writer, "ask_json"):
        return default_plan(body)
    from ..prompt_writer import PromptWriterFailed
    facts = (f"Model facts: {len(body.storeys)} storeys ({', '.join(body.storeys[:20])}); about {body.width_m:.0f} m wide, {body.depth_m:.0f} m deep, "
             f"{body.height_m:.0f} m tall; rooms: {', '.join(body.rooms[:40]) or 'none in the file'}.")
    text = f"{facts}\nArchitect's description: {body.description.strip() or '(none: choose a tasteful, realistic look)'}\nTotal length: about {body.seconds} seconds."
    try:
        out = writer.ask_json(PLAN_SYSTEM, [{"type": "text", "text": text}], max_tokens=2500)
    except PromptWriterFailed:
        return default_plan(body)
    shots = []
    for s in (out["answer"].get("shots") or [])[:8]:
        kind = s.get("kind") if s.get("kind") in SHOT_KINDS else "push"
        shots.append({"name": str(s.get("name") or "Shot")[:80], "kind": kind, "seconds": int(max(4, min(10, int(s.get("seconds") or 6)))),
                      "frame_prompt": str(s.get("frame_prompt") or "")[:6000], "motion_prompt": str(s.get("motion_prompt") or "")[:2000], "life": bool(s.get("life"))})
    if not shots:
        return default_plan(body)
    try:
        repo = _repo(request)
        repo.create_usage_event(user, {"project_id": str(project_id), "provider": "anthropic", "model": out.get("model"), "operation": "film_plan",
                                       "cost_usd": str(out["cost_usd"]) if out.get("cost_usd") is not None else None, "price_source": "platform.claude.com price list",
                                       "raw_usage": out.get("usage")})
    except Exception:
        pass
    return {"shots": shots, "notes": str(out["answer"].get("notes") or "")[:300], "by": "claude"}


@router.get("/film/engines")
def film_engines(request: Request):
    on = getattr(request.app.state, "runway", None) is not None
    return {k: {**{x: v[x] for x in ("name", "blurb", "price")}, "available": on} for k, v in FILM_ENGINES.items()} | {
        "_pictures": {k: v["name"] for k, v in IMAGE_ENGINES.items()}}
