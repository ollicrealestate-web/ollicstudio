"""Background job: a Revit (.rvt) file becomes an IFC in the same project (see aps.py), which the
architect's browser then reads into 3D like any IFC. Runs as the signed-in user, so row-level
security applies; always ends succeeded, failed or cancelled."""

from __future__ import annotations

import hashlib
import logging
import re
import uuid

from .aps import PRICE_SOURCE, TRANSLATE_COST, ModelServiceError
from .auth import CurrentUser
from .filetypes import UploadRejected, inspect_upload
from .jobs import WORKER_NAME, now_iso
from .supabase import BackendUnavailable

log = logging.getLogger("ollic.revit")


def run_revit_job(state, user: CurrentUser, job_id: str, poll: float | None = None) -> None:
    repo, storage, settings = state.repo, state.storage, state.settings
    poll = getattr(state, "aps_poll_seconds", 8.0) if poll is None else poll

    def fail(message: str):
        try:
            repo.update_job(user, job_id, {"status": "failed", "error": message[:1000], "stage": None, "finished_at": now_iso()})
        except BackendUnavailable:
            log.exception("could not record failure of revit job %s", job_id)

    try:
        job = repo.get_job(user, job_id)
        if not job or job["status"] != "queued":
            return
        aps = getattr(state, "aps", None)
        if aps is None:
            return fail("Revit files are not set up yet. In Revit, use File > Export > IFC and upload the .ifc file.")
        pid, src_id = job["project_id"], job["input"]["source_file_id"]
        src = repo.get_source_file(user, src_id)
        if not src or src.get("project_id") != pid:
            return fail("The Revit file is no longer in this project.")
        repo.update_job(user, job_id, {"status": "running", "stage": "Sending your Revit file", "started_at": now_iso(),
                                       "attempts": int(job.get("attempts") or 0) + 1, "worker": WORKER_NAME,
                                       "result": {"source_file_id": src_id}})

        def progress(stage: str):
            if repo.get_job(user, job_id).get("status") == "cancelled":
                raise _Cancelled
            repo.update_job(user, job_id, {"stage": stage})

        data = storage.download(user, src["storage_path"])
        ifc = aps.to_ifc(src["original_name"], data, progress=progress, poll=poll)
        try:
            repo.create_usage_event(user, {"project_id": pid, "job_id": job_id, "provider": "autodesk", "model": "model-derivative-ifc",
                                           "operation": "model_translate", "cost_usd": str(TRANSLATE_COST), "price_source": PRICE_SOURCE})
        except BackendUnavailable:
            log.exception("could not record revit cost for job %s", job_id)
        name = re.sub(r"\.rvt$", "", src["original_name"], flags=re.IGNORECASE) + ".ifc"
        try:
            check = inspect_upload(ifc, name)
        except UploadRejected as exc:
            log.warning("OWNER: the IFC from APS was rejected: %s", exc.reason)
            return fail("The IFC made from your Revit file could not be read. Export IFC from Revit instead.")
        if check.kind != "ifc":
            return fail("The IFC made from your Revit file could not be read. Export IFC from Revit instead.")
        fid = str(uuid.uuid4())
        path = f"{user.id}/{pid}/{fid}.ifc"
        storage.upload(user, path, ifc, check.mime)
        try:
            repo.create_source_file(user, {"id": fid, "project_id": pid, "original_name": name, "storage_path": path, "detected_type": "ifc",
                                           "size_bytes": len(ifc), "checksum_sha256": hashlib.sha256(ifc).hexdigest(),
                                           "validation": {"status": "valid", "details": check.details | {"from_revit": src_id}}, "processing_status": "uploaded"})
        except BackendUnavailable:
            storage.remove(user, [path])
            raise
        repo.update_job(user, job_id, {"status": "succeeded", "stage": "Done", "finished_at": now_iso(),
                                       "result": {"source_file_id": src_id, "ifc_file_id": fid, "size_bytes": len(ifc), "schema": check.details.get("schema")}})
    except _Cancelled:
        return
    except ModelServiceError as exc:
        fail(exc.message)
    except BackendUnavailable:
        log.exception("storage or database failed in revit job %s", job_id)
        fail("The converted model could not be saved. Try again in a moment.")
    except Exception:
        log.exception("unexpected error in revit job %s", job_id)
        fail("Something went wrong while converting the Revit file. Try again, or export IFC from Revit.")


class _Cancelled(Exception):
    pass
