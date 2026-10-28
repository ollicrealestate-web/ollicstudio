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
from ..film import ENGINE_MODEL, SHOT_KINDS, run_exact_film_job, run_film_job
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
    kind: Literal["push", "orbit", "approach", "aerial", "rise", "sidepass", "topdown", "entry", "interior", "custom"] = "custom"
    engine: Literal["exact", "path", "path_plus"] = "exact"
    tier: Literal["standard", "premium", "swift", "ultra", "vs"] = "standard"   # the picture option for the first (and last) frame
    format: Literal["16:9", "9:16", "1:1"] = "16:9"
    description: str = Field(default="", max_length=1500)
    frame_prompt: str = Field(default="", max_length=6000)
    motion_prompt: str = Field(default="", max_length=2000)
    life: bool = False
    clay_file_id: uuid.UUID | None = None       # Ollic Path / Path Plus: the clay still of the first frame
    lines_file_id: uuid.UUID | None = None
    # Ollic Path Exact: the model's view, lines, depth and material map at the start and at the end of the move
    start_view_id: uuid.UUID | None = None
    start_lines_id: uuid.UUID | None = None
    start_depth_id: uuid.UUID | None = None
    start_materials_id: uuid.UUID | None = None
    end_view_id: uuid.UUID | None = None
    end_lines_id: uuid.UUID | None = None
    end_depth_id: uuid.UUID | None = None
    end_materials_id: uuid.UUID | None = None
    model_id: uuid.UUID | None = None


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
    exact = m.engine == "exact"
    if getattr(request.app.state, "film_exact" if exact else "runway", None) is None:
        raise HTTPException(503, {"code": "not_configured", "reason": f"{FILM_ENGINES[m.engine]['name']} is not connected yet."})
    needed = ([m.start_view_id, m.start_lines_id, m.start_depth_id, m.end_view_id, m.end_lines_id, m.end_depth_id] if exact
              else [m.clay_file_id, m.lines_file_id])
    if any(x is None for x in needed):
        raise HTTPException(422, {"code": "bad_settings", "reason": "The shot's views of the model are missing. Reload the page and record it again."})
    repo = _repo(request)
    why = _may_film(request, user, repo)
    if why:
        raise HTTPException(403, {"code": "premium_only", "reason": why})
    _require_tier(request, user, m.tier)
    for fid in [x for x in needed + [m.start_materials_id, m.end_materials_id] if x]:
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
        top, bottom = (10, 4) if exact else (min(10, MAX_SECONDS[ENGINE_MODEL[m.engine]]), 2)
        if not bottom - 0.3 <= info.duration_s <= top + 0.5:
            raise HTTPException(422, {"code": "bad_video", "reason": f"A shot is {bottom} to {top} seconds long."})
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
    if exact:
        from ..fal import depth_video_cost
        est = depth_video_cost(seconds)
    else:
        est = runway_cost(ENGINE_MODEL[m.engine], seconds)
    # "tier" counts the job among the day's videos; the first frame uses the picture option "frame_tier"
    job_input = m.model_dump(mode="json", exclude={"tier"}) | {"guide_path": guide_path, "seconds": seconds, "width": w, "height": h, "aspect": ASPECT[m.format],
                                                               "tier": "film", "frame_tier": m.tier, "estimate_usd": str(est)}
    try:
        job = _start_job(request, user, str(project_id), "film_shot", job_input, None, response, run=run_exact_film_job if exact else run_film_job, max_active=4)
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
    full: bool = False          # the full property film: outside, through the door, the rooms, and out again


PLAN_SYSTEM = (
    "You plan architectural films for architects, shot by shot. The building comes from the architect's model; each shot is a "
    "camera move that Ollic records exactly from the model and an AI then films photoreal, so the geometry stays true. Use only these "
    "camera moves: approach (walk up to the building from the street at eye level), orbit (slow arc around the building at mid height), "
    "aerial (high arc showing the whole site), topdown (straight down from high above, turning slowly), sidepass (low drone pass along the "
    "front, beside the street), rise (from eye level up the facade to the roof), push (slow move in on the current view), entry (to the "
    "front door and through it into the house), interior (a slow walk through one room; give the room's name exactly as listed). "
    "Each shot is 4 to 10 seconds. Order the shots like a film: arrival, the building, the detail, inside, the reveal. Interior shots "
    "only for rooms in the list; if the model has no rooms, no interior shots. For each shot write a look prompt for the first frame "
    "(materials, light, setting from the architect's description; for interiors, furnish and light the room to suit its name; tell the "
    "image model to keep the geometry exactly) and a motion prompt for the video (keep the camera move and the building exactly; add "
    "the life asked for: cars moving and people walking outside, people living inside). Never invent floors, rooms or features. "
    'Answer with JSON only: {"shots": [{"name": "...", "kind": "approach|orbit|aerial|topdown|sidepass|rise|push|entry|interior", '
    '"room": "room name for interior shots, else empty", "seconds": 4-10, "frame_prompt": "...", "motion_prompt": "...", "life": true|false}], '
    '"notes": "one sentence for the architect"}'
)
FULL_FILM = ("Plan the FULL PROPERTY FILM, about {secs} seconds in 7 to 10 shots: an aerial or top-down opening, a 360-degree orbit, a low "
             "side pass with cars moving on the street, the approach, the entry through the front door, then the main rooms inside "
             "(living, kitchen, a bedroom, others that are listed), and a closing aerial.")


def default_plan(body: PlanIn) -> dict:
    tall = body.height_m > 15
    if body.full:
        shots = [{"name": "Opening from above", "kind": "aerial", "seconds": 8, "life": True},
                 {"name": "Around the building", "kind": "orbit", "seconds": 8, "life": True},
                 {"name": "Along the street", "kind": "sidepass", "seconds": 6, "life": True},
                 {"name": "Arrival", "kind": "approach", "seconds": 6, "life": True},
                 {"name": "Through the front door", "kind": "entry", "seconds": 6, "life": False}]
        for room in _main_rooms(body.rooms):
            shots.append({"name": room, "kind": "interior", "room": room, "seconds": 6, "life": False})
        shots.append({"name": "The roof and the site", "kind": "topdown", "seconds": 6, "life": False})
        return {"shots": shots, "notes": "The full film: the site, the building, the street, through the door, the rooms and out. Edit any shot before filming.", "by": "ollic"}
    shots = [{"name": "Arrival", "kind": "approach", "seconds": 8, "life": True},
             {"name": "Around the building", "kind": "orbit", "seconds": 8, "life": False},
             {"name": "Up the facade" if tall else "From above", "kind": "rise" if tall else "aerial", "seconds": 6, "life": False}]
    return {"shots": shots, "notes": "A three-shot film: arrival, the building, the reveal. Edit any shot before filming.", "by": "ollic"}


def _main_rooms(rooms: list[str]) -> list[str]:
    """Up to four rooms for the film, the living spaces first."""
    order = ("living", "lounge", "sitting", "family", "kitchen", "dining", "master", "bed", "suite", "lobby", "reception", "study", "office")
    seen, out = set(), []
    for word in order:
        for r in rooms:
            if word in r.lower() and r.lower() not in seen and len(out) < 4:
                seen.add(r.lower()); out.append(r)
    return out


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
    if body.full:
        text += "\n" + FULL_FILM.format(secs=body.seconds)
    from ..look import with_scene
    text = with_scene(text, _owned_project(request, user, project_id))
    try:
        out = writer.ask_json(PLAN_SYSTEM, [{"type": "text", "text": text}], max_tokens=6000)
    except PromptWriterFailed:
        return default_plan(body)
    shots = []
    known = {r.lower(): r for r in body.rooms}
    for s in (out["answer"].get("shots") or [])[:12 if body.full else 8]:
        kind = s.get("kind") if s.get("kind") in SHOT_KINDS else "push"
        room = known.get(str(s.get("room") or "").strip().lower(), "")
        if kind == "interior" and not room:
            continue          # only rooms that are in the model
        shots.append({"name": str(s.get("name") or "Shot")[:80], "kind": kind, "room": room, "seconds": int(max(4, min(10, int(s.get("seconds") or 6)))),
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
    st = request.app.state
    on = lambda k: getattr(st, "film_exact" if k == "exact" else "runway", None) is not None  # noqa: E731
    return {k: {**{x: v[x] for x in ("name", "blurb", "price")}, "available": on(k)} for k, v in FILM_ENGINES.items()} | {
        "_pictures": {k: v["name"] for k, v in IMAGE_ENGINES.items()}}


# ---------------------------------------------------------------- the full film: the shots joined into one video
class JoinIn(BaseModel):
    video_ids: list[uuid.UUID] = Field(min_length=2, max_length=20)
    title: str = Field(default="", max_length=80)
    subtitle: str = Field(default="", max_length=120)


@router.post("/projects/{project_id}/films/join", status_code=status.HTTP_202_ACCEPTED)
def join_film(project_id: uuid.UUID, body: JoinIn, request: Request, response: Response, user: CurrentUser = Depends(get_current_user)):
    """Joins finished walkthrough shots, in the order given, into one film with title cards (on Ollic's server; no AI cost)."""
    from ..film_join import run_join_job
    project = _owned_project(request, user, project_id)
    repo = _repo(request)
    fmt = None
    for vid in body.video_ids:
        v = repo.get_video(user, str(vid))
        if not v or v.get("owner_id") != user.id or v.get("project_id") != str(project_id) or v.get("kind") != "film":
            raise HTTPException(status.HTTP_404_NOT_FOUND, "A shot is not in this project.")
        fmt = fmt or v.get("format")
    title = body.title.strip() or project.get("name") or "Full film"
    return _start_job(request, user, str(project_id), "video_export", {"join": True, "video_ids": [str(v) for v in body.video_ids], "title": title,
                                                                       "subtitle": body.subtitle.strip(), "format": fmt or "16:9"},
                      None, response, run=run_join_job)
