"""The video export job: rendered stills -> walkthrough MP4, saved privately."""

from __future__ import annotations

import logging
import uuid

from .auth import CurrentUser
from .jobs import WORKER_NAME, now_iso
from .supabase import BackendUnavailable
from .video import VideoFailed, make_video

log = logging.getLogger("ollic.video")
BRAND = "Ollic Design Studio"


def run_video_job(state, user: CurrentUser, job_id: str) -> None:
    repo, storage, settings = state.repo, state.storage, state.settings

    def fail(message: str):
        try:
            repo.update_job(user, job_id, {"status": "failed", "error": message[:1000], "stage": None, "finished_at": now_iso()})
        except BackendUnavailable:
            log.exception("could not record failure of video job %s", job_id)

    try:
        job = repo.get_job(user, job_id)
        if not job or job["status"] != "queued":
            return
        repo.update_job(user, job_id, {"status": "running", "stage": "Collecting the rendered images", "started_at": now_iso(),
                                       "attempts": int(job.get("attempts") or 0) + 1, "worker": WORKER_NAME})
        inp = job["input"]
        captions = inp.get("captions") or []
        shots, items = [], []
        for i, rid in enumerate(inp["render_ids"]):
            img = repo.get_rendered_image(user, rid)
            if not img or img.get("project_id") != job["project_id"]:
                return fail("One of the chosen renders is no longer available.")
            data = storage.download(user, img.get("base_path") or img["storage_path"], bucket=settings.renders_bucket)
            cap = (captions[i] if i < len(captions) and captions[i] else (img.get("options") or {}).get("shot_name")) or f"View {i + 1}"
            shots.append((data, cap[:80]))
            items.append({"render_id": rid, "caption": cap[:80]})

        def progress(stage):
            repo.update_job(user, job_id, {"stage": stage})
            if repo.get_job(user, job_id).get("status") == "cancelled":
                raise VideoFailed("Cancelled.")

        result = make_video(shots, fmt=inp.get("format", "16:9"), seconds=inp.get("seconds", 5), title=inp.get("title") or "Walkthrough",
                            subtitle=inp.get("subtitle") or "", brand=BRAND, progress=progress)
        repo.update_job(user, job_id, {"stage": "Saving the video"})
        vid = str(uuid.uuid4())
        path = f"{user.id}/{job['project_id']}/{vid}.mp4"
        storage.upload(user, path, result.data, "video/mp4", bucket=settings.videos_bucket)
        try:
            repo.create_video(user, {"id": vid, "project_id": job["project_id"], "job_id": job_id, "storage_path": path, "title": inp.get("title"),
                                     "format": inp.get("format", "16:9"), "width": result.width, "height": result.height, "fps": result.fps,
                                     "duration_s": result.duration_s, "items": items})
        except BackendUnavailable:
            storage.remove(user, [path], bucket=settings.videos_bucket)
            raise
        repo.update_job(user, job_id, {"status": "succeeded", "stage": "Done", "finished_at": now_iso(), "result": {"video_id": vid, "duration_s": result.duration_s}})
    except VideoFailed as exc:
        if exc.message == "Cancelled.":
            return
        log.error("video job %s failed: %s", job_id, exc.__cause__)
        fail(exc.message)
    except BackendUnavailable:
        log.exception("storage or database failed in video job %s", job_id)
        fail("The video could not be saved. Try again in a moment.")
    except Exception:
        log.exception("unexpected error in video job %s", job_id)
        fail("Something went wrong while making the video. Try again.")
