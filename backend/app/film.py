"""AI walkthrough shots from the architect's model.

For each shot the browser records an exact guide video of the model along the camera path (a clay
render: true shapes, true camera) and a still of its first frame (clay, and the line drawing).
This job then:
  1. renders the first frame photoreal from the clay still with the chosen picture option, checked
     against the line drawing (renders.geometry_check; drifted renders are made once more);
  2. asks the video service (Runway: Aleph 2 or Kling O3) to turn the guide video into a photoreal
     video that keeps the camera move and the building, with the first frame as the look;
  3. compares frames of the result with the same frames of the guide (geometry.match), and asks
     Claude to compare the middle frame when Claude is connected;
  4. saves the video, its check and its cost.
Claude writes the prompts when connected (it sees the clay frame); otherwise fixed prompts are used.
"""

from __future__ import annotations

import io
import logging
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from PIL import Image

from .auth import CurrentUser
from .cinematic import _remux, cover, jpeg
from .geometry import band, claude_check, match
from .jobs import WORKER_NAME, now_iso
from .kling import VideoProviderError
from .runway import PRICE_SOURCE, cost as runway_cost
from .supabase import BackendUnavailable
from .video import VideoFailed, ffmpeg_path, probe

log = logging.getLogger("ollic.film")
POLL_SECONDS = 10
MAX_WAIT = 30 * 60
ENGINE_MODEL = {"path": "aleph2", "path_plus": "klingO3_pro"}
SHOT_KINDS = ("push", "orbit", "approach", "aerial", "rise", "custom")


def frame_prompt(description: str) -> str:
    return ("Photorealistic architectural visualisation, the quality of professional architectural photography. Image 1 is an exact view of "
            "the architect's model: keep its geometry exactly, the same number of floors, every window and door opening in the same place, the "
            "same roof line, balconies, columns and proportions, and the same camera. Only add realistic materials, glass with reflections, "
            "natural light, sky, landscaping and context. " + (f"The architect's description: {description.strip()} " if description.strip() else "")
            + "No text, labels, logos or watermarks.")


def motion_prompt(description: str, life: bool) -> str:
    return ("Photorealistic architectural walkthrough video. Keep the camera movement and every part of the building exactly as in the input "
            "video: walls, floors, windows, doors, roof and proportions never change, bend or morph. Make it look like the first frame: real "
            "materials, glass reflections, natural daylight, landscaping"
            + (", a few people walking naturally and cars passing on the street" if life else "")
            + ". Smooth, steady camera, sharp detail, no text, no logos."
            + (f" {description.strip()}" if description.strip() else ""))


def _frames(video: Path, times: list[float], size: tuple[int, int], tmp: Path, tag: str) -> list[Image.Image]:
    ff, out = ffmpeg_path(), []
    for i, t in enumerate(times):
        p = tmp / f"{tag}-{i}.png"
        subprocess.run([ff, "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", str(video), "-frames:v", "1",
                        "-vf", f"scale={size[0]}:{size[1]}", str(p)], capture_output=True, timeout=120)
        if p.exists():
            out.append(Image.open(p).convert("RGB"))
    return out


def video_check(guide: Path, result: Path, writer) -> dict:
    """Compares three frames of the result with the same frames of the guide."""
    gi, ri = probe(guide), probe(result)
    dur = min(gi.duration_s, ri.duration_s)
    times = [dur * k for k in (0.15, 0.5, 0.85)]
    with tempfile.TemporaryDirectory(prefix="ollic-check-") as t:
        tmp = Path(t)
        g = _frames(guide, times, (640, round(640 * gi.height / gi.width)), tmp, "g")
        r = _frames(result, times, (640, round(640 * gi.height / gi.width)), tmp, "r")
    pairs = list(zip(g, r))
    if not pairs:
        return {}
    scores = [match(a, b, guide_is_lines=False) for a, b in pairs]
    score = round(sum(scores) / len(scores), 3)
    check = {"score": score, "band": band(score), "frames": scores}
    seen = claude_check(writer, jpeg(pairs[len(pairs) // 2][0]), jpeg(pairs[len(pairs) // 2][1])) if writer is not None else None
    if seen:
        check["claude"] = {"ok": seen["ok"], "issues": seen["issues"]}
        if not seen["ok"] and check["band"] == "good":
            check["band"] = "fair"
        check["_claude_cost"] = seen.get("cost_usd")
    return check


def run_film_job(state, user: CurrentUser, job_id: str) -> None:
    from .renders import run_render_job
    repo, storage, settings = state.repo, state.storage, state.settings
    poll = getattr(state, "clip_poll_seconds", POLL_SECONDS)
    guide_path = None

    def fail(message: str):
        try:
            repo.update_job(user, job_id, {"status": "failed", "error": message[:1000], "stage": None, "finished_at": now_iso()})
        except BackendUnavailable:
            log.exception("could not record failure of film job %s", job_id)

    try:
        job = repo.get_job(user, job_id)
        if not job or job["status"] != "queued":
            return
        inp, pid = job["input"], job["project_id"]
        guide_path = inp["guide_path"]
        runway = getattr(state, "runway", None)
        if runway is None:
            return fail("AI walkthroughs are not connected yet.")
        repo.update_job(user, job_id, {"status": "running", "stage": "Rendering the first frame from your model", "started_at": now_iso(),
                                       "attempts": int(job.get("attempts") or 0) + 1, "worker": WORKER_NAME})
        writer = getattr(state, "prompt_writer", None)

        # 1. the first frame, photoreal, from the exact clay view (counted as one render of the chosen option)
        clay = repo.get_source_file(user, inp["clay_file_id"])
        if not clay or clay.get("project_id") != pid:
            return fail("The first frame of the shot is no longer available. Record the shot again.")
        fprompt = inp.get("frame_prompt") or ""
        if not fprompt and writer is not None:
            from .render_prompt import PromptUnavailable, write_with_claude
            try:
                fprompt = write_with_claude(writer, [(storage.download(user, clay["storage_path"]), "image/jpeg")], ["model"], inp.get("description") or "", "")["prompt"]
            except PromptUnavailable:
                fprompt = ""
        fprompt = fprompt or frame_prompt(inp.get("description") or "")
        rjob = repo.create_job(user, {"project_id": pid, "type": "concept_render", "status": "queued", "stage": "Waiting to start", "idempotency_key": None,
                                      "input": {"prompt": fprompt[:6000], "prompt_ready": True, "references": [{"file_id": inp["clay_file_id"], "role": "model"}],
                                                "guide_file_id": inp.get("lines_file_id"), "tier": inp.get("frame_tier") or "standard", "aspect": inp["aspect"],
                                                "quality": "high", "view": "exterior", "time_of_day": "midday", "film_shot": inp.get("name") or "Shot"}})
        run_render_job(state, user, rjob["id"])
        r = repo.get_job(user, rjob["id"]) or {}
        if r.get("status") != "succeeded":
            return fail("The first frame could not be rendered: " + (r.get("error") or "try again."))
        render = repo.get_rendered_image(user, r["result"]["render_id"])
        first = Image.open(io.BytesIO(storage.download(user, render.get("base_path") or render["storage_path"], bucket=settings.renders_bucket)))

        # 2. the video service turns the exact guide into the photoreal shot
        if repo.get_job(user, job_id).get("status") == "cancelled":
            return
        model = ENGINE_MODEL[inp["engine"]]
        url = storage.signed_urls(user, [guide_path], bucket=settings.videos_bucket, expires_in=3 * 3600).get(guide_path)
        if not url:
            return fail("The guide video could not be read. Record the shot again.")
        mprompt = inp.get("motion_prompt") or motion_prompt(inp.get("description") or "", bool(inp.get("life")))
        repo.update_job(user, job_id, {"stage": "Sending the camera move to the video service", "result": {"first_frame": render["id"]}})
        task = runway.video_to_video(model=model, video_url=url, prompt=mprompt, first_frame=jpeg(cover(first, inp["width"], inp["height"])))
        repo.update_job(user, job_id, {"stage": "Filming the shot (usually 2 to 6 minutes)", "result": {"first_frame": render["id"], "provider_task": task}})
        started, st, misses = time.monotonic(), None, 0
        while True:
            if repo.get_job(user, job_id).get("status") == "cancelled":
                runway.cancel(task)
                return
            try:
                st = runway.status(task); misses = 0
            except VideoProviderError as exc:
                misses += 1
                if not exc.retry or misses > 6:
                    raise
            if st and st.status in ("succeeded", "failed"):
                break
            waited = int(time.monotonic() - started)
            if waited > MAX_WAIT:
                runway.cancel(task)
                return fail("The video service took too long. Nothing was charged for the video; try again later.")
            repo.update_job(user, job_id, {"stage": f"Filming the shot ({waited // 60} min {waited % 60:02d} s so far)"})
            time.sleep(poll)
        if st.status == "failed":
            log.warning("OWNER: runway task %s failed: %s", task, st.message)
            return fail("The video service could not film this camera move. Try a shorter or slower move.")
        repo.update_job(user, job_id, {"stage": "Checking the shot against your model"})
        data = runway.download(st.video_url)
        cost = runway_cost(model, inp["seconds"])
        try:
            repo.create_usage_event(user, {"project_id": pid, "job_id": job_id, "provider": "runway", "model": model, "operation": "video_to_video",
                                           "cost_usd": str(cost), "price_source": PRICE_SOURCE + "; estimated from the length", "raw_usage": {"seconds": inp["seconds"], "task": task}})
        except BackendUnavailable:
            log.exception("could not record film cost for job %s", job_id)

        # 3. check, then save
        with tempfile.TemporaryDirectory(prefix="ollic-film-") as tmp:
            tmp = Path(tmp)
            raw, g = tmp / "raw.mp4", tmp / "guide.mp4"
            raw.write_bytes(data); g.write_bytes(storage.download(user, guide_path, bucket=settings.videos_bucket))
            final = _remux(raw, tmp / "shot.mp4")
            check = video_check(g, final, writer)
            info = probe(final)
            out = final.read_bytes()
        if check.get("_claude_cost") is not None or check.get("claude"):
            try:
                repo.create_usage_event(user, {"project_id": pid, "job_id": job_id, "provider": "anthropic", "model": getattr(writer, "model", "claude"),
                                               "operation": "geometry_check", "cost_usd": check.get("_claude_cost"), "price_source": "platform.claude.com price list"})
            except BackendUnavailable:
                pass
        check.pop("_claude_cost", None)
        vid = str(uuid.uuid4())
        path = f"{user.id}/{pid}/{vid}.mp4"
        storage.upload(user, path, out, "video/mp4", bucket=settings.videos_bucket)
        try:
            repo.create_video(user, {"id": vid, "project_id": pid, "job_id": job_id, "storage_path": path, "title": inp.get("name") or None,
                                     "format": inp["format"], "width": info.width, "height": info.height, "fps": round(info.fps) or 24,
                                     "duration_s": round(info.duration_s, 2), "items": [{"render_id": render["id"], "caption": inp.get("name") or ""}], "kind": "film",
                                     "script": {"engine": inp["engine"], "shot": inp.get("kind"), "seconds": inp["seconds"], "check": check, "life": bool(inp.get("life"))},
                                     "label": "AI video — not to scale"})
        except BackendUnavailable:
            storage.remove(user, [path], bucket=settings.videos_bucket)
            raise
        repo.update_job(user, job_id, {"status": "succeeded", "stage": "Done", "finished_at": now_iso(),
                                       "result": {"video_id": vid, "first_frame": render["id"], "provider_task": task, "cost_usd": str(cost), "check": check}})
    except VideoProviderError as exc:
        fail(exc.message)
    except VideoFailed as exc:
        log.error("film job %s: %s", job_id, exc.__cause__)
        fail("The finished shot could not be prepared. Try again.")
    except BackendUnavailable:
        log.exception("storage or database failed in film job %s", job_id)
        fail("The shot could not be saved. Try again in a moment.")
    except Exception:
        log.exception("unexpected error in film job %s", job_id)
        fail("Something went wrong while making the shot. Try again.")
    finally:
        if guide_path:     # the guide is only needed while the shot is made
            try:
                storage.remove(user, [guide_path], bucket=settings.videos_bucket)
            except Exception:
                log.warning("could not remove guide video %s", guide_path)
