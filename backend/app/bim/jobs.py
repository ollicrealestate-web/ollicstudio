"""Background jobs for Phases 3 and 3b: IFC import, and building an IFC from a confirmed layout.

Like the render jobs, they run as the signed-in user, so row-level security applies to
every read and write, and they always end in a real state: succeeded, failed or cancelled.
"""

from __future__ import annotations

import hashlib
import logging
import uuid

from ..auth import CurrentUser
from ..jobs import WORKER_NAME, now_iso
from ..supabase import BackendUnavailable
from .layout import Layout

# IfcOpenShell, trimesh and OpenCV are loaded only when a job needs them, so the web
# service starts quickly and stays small on the free instance.

log = logging.getLogger("ollic.bim.jobs")


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
        data = storage.download(user, src["storage_path"])
        result = import_ifc(data, progress=lambda stage: repo.update_job(user, job_id, {"stage": stage}))
        if _cancelled(repo, user, job_id):
            return
        repo.update_job(user, job_id, {"stage": "Saving the 3D model"})
        model_id = str(uuid.uuid4())
        glb_path = f"{user.id}/{job['project_id']}/{model_id}.glb"
        storage.upload(user, glb_path, result.glb, "model/gltf-binary", bucket=settings.models_bucket)
        try:
            repo.create_model(user, {
                "id": model_id, "project_id": job["project_id"], "source_file_id": src["id"], "job_id": job_id,
                "layout_draft_id": inp.get("layout_draft_id"), "schema_version": result.report["schema"],
                "glb_path": glb_path, "report": result.report, "stats": result.stats,
            })
            repo.add_components(user, [{**c, "model_id": model_id, "project_id": job["project_id"]} for c in result.components])
        except BackendUnavailable:
            storage.remove(user, [glb_path], bucket=settings.models_bucket)
            raise
        if inp.get("layout_draft_id"):
            repo.update_draft(user, inp["layout_draft_id"], {"status": "built"})
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


def run_model_build(state, user: CurrentUser, job_id: str) -> None:
    """Confirmed layout -> IFC (saved as a generated source file) -> the same import as an upload."""
    from .builder import build_ifc
    repo, storage = state.repo, state.storage
    try:
        job = _start(repo, user, job_id)
        if job is None:
            return
        draft = repo.get_draft(user, job["input"]["layout_draft_id"])
        if not draft or draft.get("project_id") != job["project_id"] or not draft.get("layout"):
            return _fail(repo, user, job_id, "The confirmed layout is no longer available.")
        repo.update_job(user, job_id, {"stage": "Building walls, floors, openings and roof"})
        layout = Layout.model_validate(draft["layout"])
        data = build_ifc(layout, seed=draft["id"])
        file_id = str(uuid.uuid4())
        path = f"{user.id}/{job['project_id']}/{file_id}.ifc"
        storage.upload(user, path, data, "application/x-step")
        try:
            src = repo.create_source_file(user, {
                "id": file_id, "project_id": job["project_id"], "original_name": f"{layout.name[:80]} (from plan).ifc",
                "storage_path": path, "detected_type": "ifc", "size_bytes": len(data),
                "checksum_sha256": hashlib.sha256(data).hexdigest(), "origin": "generated",
                "validation": {"status": "valid", "details": {"schema": "IFC4", "generated_from": draft["id"]}},
                "processing_status": "uploaded",
            })
        except BackendUnavailable:
            storage.remove(user, [path])
            raise
        # hand over to the import in the same job, so the customer sees one task from plan to 3D
        repo.update_job(user, job_id, {"status": "queued", "stage": "Importing the new model"})
        job_input = {"source_file_id": src["id"], "layout_draft_id": draft["id"]}
        _import_inline(state, user, job_id, job["project_id"], job_input)
    except BackendUnavailable:
        log.exception("storage or database failed in model build %s", job_id)
        _fail(repo, user, job_id, "The model could not be saved. Try again in a moment.")
    except Exception:
        log.exception("unexpected error in model build %s", job_id)
        _fail(repo, user, job_id, "Something went wrong while building the model from the plan. Try again.")


def _import_inline(state, user, job_id, project_id, job_input):
    """Runs the import steps for a build job (its input is the draft, so pass the new file explicitly)."""
    repo = state.repo
    orig_get = repo.get_job

    class _View:  # present the build job to run_ifc_import with the import's input
        def __getattr__(self, name):
            return getattr(repo, name)

        def get_job(self, u, jid):
            j = orig_get(u, jid)
            return {**j, "input": job_input} if j and jid == job_id else j

    class _State:
        pass
    s = _State()
    s.repo, s.storage, s.settings = _View(), state.storage, state.settings
    run_ifc_import(s, user, job_id)


def run_plan_trace(state, user: CurrentUser, job_id: str) -> None:
    """Floor plan image -> layout proposal (walls, openings, rooms, scale), saved as a draft for review."""
    from .plan_trace import TraceFailed, load_plan_image, trace
    from .vision import VisionUnavailable
    import io

    repo, storage, settings = state.repo, state.storage, state.settings
    try:
        job = _start(repo, user, job_id)
        if job is None:
            return
        src = repo.get_source_file(user, job["input"]["source_file_id"])
        if not src or src.get("project_id") != job["project_id"] or src.get("detected_type") not in ("png", "jpeg", "pdf"):
            return _fail(repo, user, job_id, "The floor plan is no longer available. Upload it again.")
        repo.update_job(user, job_id, {"stage": "Opening the drawing"})
        img = load_plan_image(storage.download(user, src["storage_path"]), src["detected_type"])

        labels, vision_note = [], None
        reader = getattr(state, "vision", None)
        if reader is not None:
            repo.update_job(user, job_id, {"stage": "Reading room names and areas"})
            try:
                read = reader.read_labels(img)
                labels = read["rooms"]
                vision_note = {"status": "ok", "model": read.get("model"), "rooms_read": len(labels),
                               "overall_width_m": read.get("overall_width_m"), "overall_depth_m": read.get("overall_depth_m")}
                _record_vision_usage(repo, user, job, read)
            except VisionUnavailable as exc:
                log.warning("vision read failed in job %s: %s", job_id, exc)
                vision_note = {"status": "failed", "reason": str(exc)[:300]}
        else:
            vision_note = {"status": "off", "reason": "No vision model is configured, so room names and areas were not read."}

        repo.update_job(user, job_id, {"stage": "Finding walls, doors, windows and rooms"})
        proposal = trace(img, labels)
        proposal["vision"] = vision_note
        if vision_note["status"] != "ok":
            proposal["flags"].insert(0, {"kind": "check", "target": "vision", "message": "Room names and areas could not be read automatically this time. Name the rooms and set the scale yourself."})

        draft_id = str(uuid.uuid4())
        image_path = f"{user.id}/{job['project_id']}/{draft_id}-plan.png"
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        storage.upload(user, image_path, buf.getvalue(), "image/png", bucket=settings.models_bucket)
        proposal["image"]["path"] = image_path
        repo.create_draft(user, {"id": draft_id, "project_id": job["project_id"], "source_file_id": src["id"], "status": "proposed",
                                 "proposal": proposal, "trace": {"job_id": job_id, "vision": vision_note}})
        repo.update_job(user, job_id, {"status": "succeeded", "stage": "Done", "finished_at": now_iso(),
                                       "result": {"layout_draft_id": draft_id, "walls": len(proposal["walls"]), "rooms": len(proposal["rooms"]),
                                                  "openings": len(proposal["openings"])}})
    except TraceFailed as exc:
        _fail(repo, user, job_id, exc.message)
    except BackendUnavailable:
        log.exception("storage or database failed in plan trace %s", job_id)
        _fail(repo, user, job_id, "The plan could not be read or saved. Try again in a moment.")
    except Exception:
        log.exception("unexpected error in plan trace %s", job_id)
        _fail(repo, user, job_id, "Something went wrong while reading the plan. Try again, or upload a clearer image.")


def _record_vision_usage(repo, user, job, read):
    usage = read.get("usage")
    try:
        repo.create_usage_event(user, {
            "project_id": job["project_id"], "job_id": job["id"], "provider": "cloudflare", "model": read.get("model") or "vision",
            "operation": "vision_read", "cost_usd": None,
            "price_source": "inside Cloudflare's free daily allowance; no per-token price on file",
            "raw_usage": usage,
        })
    except BackendUnavailable:
        log.exception("could not record vision usage for job %s", job["id"])
