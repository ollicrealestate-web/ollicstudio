"""Background job for Phase 3: importing an architect's IFC model for rendering and animation.

Like the render jobs, they run as the signed-in user, so row-level security applies to
every read and write, and they always end in a real state: succeeded, failed or cancelled.
"""

from __future__ import annotations

import json
import logging
import tempfile
import threading
import time
import uuid

from ..auth import CurrentUser
from ..jobs import WORKER_NAME, now_iso
from ..supabase import BackendUnavailable
# IfcOpenShell and trimesh are loaded only when a job needs them, so the web
# service starts quickly and stays small on the free instance.

log = logging.getLogger("ollic.bim.jobs")
# Reading a large IFC takes much of the server's memory, so models are read one at a time;
# the others wait their turn (and say so), instead of running together and exhausting memory.
ONE_AT_A_TIME = threading.Semaphore(1)
WAIT_POLL = 20
BEAT_EVERY = 45


class _Heartbeat:
    """Updates the job every BEAT_EVERY seconds while a long step runs, so the customer sees time
    passing and the job is not taken for a stuck one (jobs untouched for 10 minutes are)."""

    def __init__(self, repo, user, job_id):
        self.repo, self.user, self.job_id, self.stage, self.t0 = repo, user, job_id, "Reading the IFC file", time.monotonic()
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def set(self, stage):
        self.stage = stage
        try:
            self.repo.update_job(self.user, self.job_id, {"stage": stage})
        except BackendUnavailable:
            pass

    def _run(self):
        while not self._stop.wait(BEAT_EVERY):
            m = int((time.monotonic() - self.t0) // 60)
            try:
                self.repo.update_job(self.user, self.job_id, {"stage": f"{self.stage} ({m} min so far; large models take several minutes)"})
            except BackendUnavailable:
                pass

    def __enter__(self):
        self._t.start(); return self

    def __exit__(self, *exc):
        self._stop.set()


def _start(repo, user, job_id):
    job = repo.get_job(user, job_id)
    if not job or job["status"] != "queued":
        return None
    repo.update_job(user, job_id, {"status": "running", "stage": "Starting", "started_at": now_iso(),
                                   "attempts": int(job.get("attempts") or 0) + 1, "worker": WORKER_NAME})
    return job


def _fail(repo, user, job_id, message):
    try:
        repo.update_job(user, job_id, {"status": "failed", "error": message[:1000], "stage": None, "finished_at": now_iso()})
    except BackendUnavailable:
        log.exception("could not record failure of job %s", job_id)


def _cancelled(repo, user, job_id) -> bool:
    j = repo.get_job(user, job_id)
    return bool(j and j["status"] == "cancelled")


def run_ifc_import(state, user: CurrentUser, job_id: str) -> None:
    from .importer import ImportFailed, import_ifc
    repo, storage, settings = state.repo, state.storage, state.settings
    try:
        job = _start(repo, user, job_id)
        if job is None:
            return
        inp = job["input"]
        src = repo.get_source_file(user, inp["source_file_id"])
        if not src or src.get("project_id") != job["project_id"] or src.get("detected_type") != "ifc":
            return _fail(repo, user, job_id, "The IFC file is no longer available. Upload it again.")
        while not ONE_AT_A_TIME.acquire(timeout=WAIT_POLL):
            if _cancelled(repo, user, job_id):
                return
            repo.update_job(user, job_id, {"stage": "Waiting for another model to finish reading"})
        try:
            with tempfile.NamedTemporaryFile(suffix=".ifc") as tmp:
                tmp.write(storage.download(user, src["storage_path"]))     # on disk, not held in memory while reading
                tmp.flush()
                with _Heartbeat(repo, user, job_id) as beat:
                    result = import_ifc(tmp.name, progress=beat.set)
        finally:
            ONE_AT_A_TIME.release()
        if _cancelled(repo, user, job_id):
            return
        repo.update_job(user, job_id, {"stage": "Saving the 3D model"})
        model_id = str(uuid.uuid4())
        glb_path = f"{user.id}/{job['project_id']}/{model_id}.glb"
        storage.upload(user, glb_path, result.glb, "model/gltf-binary", bucket=settings.models_bucket)
        try:
            repo.create_model(user, {
                "id": model_id, "project_id": job["project_id"], "source_file_id": src["id"], "job_id": job_id,
                "schema_version": result.report["schema"],
                "glb_path": glb_path, "report": result.report, "stats": result.stats,
            })
            repo.add_components(user, [{**c, "model_id": model_id, "project_id": job["project_id"]} for c in result.components])
        except BackendUnavailable:
            storage.remove(user, [glb_path], bucket=settings.models_bucket)
            raise
        repo.update_job(user, job_id, {"status": "succeeded", "stage": "Done", "finished_at": now_iso(),
                                       "result": {"model_id": model_id, "report_status": result.report["status"]}})
    except ImportFailed as exc:
        _fail(repo, user, job_id, exc.message)
    except BackendUnavailable:
        log.exception("storage or database failed in IFC import %s", job_id)
        _fail(repo, user, job_id, "The model could not be saved. Try again in a moment.")
    except Exception:
        log.exception("unexpected error in IFC import %s", job_id)
        _fail(repo, user, job_id, "Something went wrong while processing the IFC file. Try again, or export it from Revit again.")
