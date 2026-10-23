"""The animation export job: the video the browser made -> a phone-friendly MP4, saved privately.

The browser draws the golden animation from the architect's images and encodes it (H.264 where the browser can,
otherwise VP9). The upload is checked in the request; this job re-packages or converts it with
FFmpeg and saves it like any other video. The upload waits in a private temporary folder on
this server; if the server restarts first, the job is reported as interrupted and the customer
exports again.
"""

from __future__ import annotations

import logging
import os
import tempfile
import uuid
from pathlib import Path

from .auth import CurrentUser
from .jobs import WORKER_NAME, now_iso
from .supabase import BackendUnavailable
from .video import VideoFailed, finish_upload, probe

log = logging.getLogger("ollic.animation")
UPLOAD_DIR = Path(os.environ.get("OLLIC_UPLOAD_DIR") or Path(tempfile.gettempdir()) / "ollic-uploads")


def upload_path(name: str) -> Path:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    return UPLOAD_DIR / name


def run_animation_job(state, user: CurrentUser, job_id: str) -> None:
    repo, storage, settings = state.repo, state.storage, state.settings

    def fail(message: str):
        try:
            repo.update_job(user, job_id, {"status": "failed", "error": message[:1000], "stage": None, "finished_at": now_iso()})
        except BackendUnavailable:
            log.exception("could not record failure of animation job %s", job_id)

    src = None
    try:
        job = repo.get_job(user, job_id)
        if not job or job["status"] != "queued":
            return
        inp = job["input"]
        src = upload_path(inp["upload"])
        repo.update_job(user, job_id, {"status": "running", "stage": "Checking the video", "started_at": now_iso(),
                                       "attempts": int(job.get("attempts") or 0) + 1, "worker": WORKER_NAME})
        if not src.exists():
            return fail("The uploaded video was lost when the server restarted. Export it again.")
        info = probe(src)

        def progress(stage):
            repo.update_job(user, job_id, {"stage": stage})
            if repo.get_job(user, job_id).get("status") == "cancelled":
                raise VideoFailed("Cancelled.")

        data = finish_upload(src, info, progress)
        repo.update_job(user, job_id, {"stage": "Saving the video"})
        vid = str(uuid.uuid4())
        path = f"{user.id}/{job['project_id']}/{vid}.mp4"
        storage.upload(user, path, data, "video/mp4", bucket=settings.videos_bucket)
        try:
            repo.create_video(user, {"id": vid, "project_id": job["project_id"], "job_id": job_id, "storage_path": path, "title": inp.get("title") or None,
                                     "format": inp["format"], "width": info.width, "height": info.height, "fps": round(info.fps) or 30,
                                     "duration_s": round(info.duration_s, 2), "items": inp.get("items") or [], "kind": "construction",
                                     "script": inp.get("script"), "label": "Indicative sequence — not to scale"})
        except BackendUnavailable:
            storage.remove(user, [path], bucket=settings.videos_bucket)
            raise
        repo.update_job(user, job_id, {"status": "succeeded", "stage": "Done", "finished_at": now_iso(), "result": {"video_id": vid, "duration_s": round(info.duration_s, 2)}})
    except VideoFailed as exc:
        if exc.message == "Cancelled.":
            return
        log.error("animation job %s failed: %s", job_id, exc.__cause__)
        fail(exc.message)
    except BackendUnavailable:
        log.exception("storage or database failed in animation job %s", job_id)
        fail("The video could not be saved. Try again in a moment.")
    except Exception:
        log.exception("unexpected error in animation job %s", job_id)
        fail("Something went wrong while saving the video. Export it again.")
    finally:
        if src is not None:
            try:
                src.unlink(missing_ok=True)
            except OSError:
                pass
