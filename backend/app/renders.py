"""Concept renders: prompt building and the job that calls the image model (brief Module C).

Everything here runs as the signed-in user, with their token, so row-level security
still applies to every database and storage call the job makes.
"""

from __future__ import annotations

import logging
import uuid

from .auth import CurrentUser
from .imaging import CONCEPT_LABEL, BadImage, open_image, stamp_label, to_jpeg
from .jobs import WORKER_NAME, now_iso
from .openai_images import SIZES, ProviderError
from .cloudflare_images import FREE_NEURONS_PER_DAY, USD_PER_1000_NEURONS, cost_usd_estimate
from .pricing import PRICE_SOURCE, cost_usd, token_counts
from .supabase import BackendUnavailable

log = logging.getLogger("ollic.renders")

VIEWS = {
    "exterior": "Exterior view of the building from eye level on the street or garden",
    "interior": "Interior view of a furnished room at standing eye level",
    "aerial": "Aerial three-quarter view of the building and its plot",
}
LIGHT = {
    "morning": "soft morning daylight",
    "midday": "bright midday sun with clear shadows",
    "golden hour": "warm golden-hour sunlight with long shadows",
    "dusk": "dusk, sky fading to blue, interior and exterior lights switched on",
    "night": "night, artificial lighting on inside and outside",
}
REF_MIME = {"png": "image/png", "jpeg": "image/jpeg"}


def build_prompt(opts: dict, *, with_reference: bool) -> str:
    parts = []
    if with_reference:
        parts.append(
            "Use the supplied image as the base design. Keep the building's overall form, proportions and roof shape, "
            "the positions and sizes of walls, doors and windows, and the camera viewpoint exactly as they are. "
            "Turn it into a photorealistic architectural concept render."
        )
    else:
        parts.append("Photorealistic architectural concept render.")
        parts.append(VIEWS[opts["view"]] + ".")
    parts.append(f"Client brief: {opts['prompt'].strip()}")
    if opts.get("materials"):
        parts.append(f"Materials and colours: {opts['materials'].strip()}.")
    if opts.get("landscaping"):
        parts.append(f"Landscaping and surroundings: {opts['landscaping'].strip()}.")
    parts.append(f"Lighting: {LIGHT[opts['time_of_day']]}.")
    parts.append("Realistic materials and proportions, natural colour, no people in the foreground. Do not add any text, labels, logos or watermarks.")
    return "\n".join(parts)


def build_edit_prompt(instruction: str) -> str:
    return (
        "Edit this architectural concept render. Change only what the instruction below asks for. Keep everything else the same: "
        "the building's form and proportions, the positions of walls, doors and windows, the camera viewpoint, and the lighting unless the instruction mentions it. "
        "Do not add any text, labels, logos or watermarks.\n"
        f"Instruction: {instruction.strip()}"
    )


def run_render_job(state, user: CurrentUser, job_id: str) -> None:
    """Runs one concept_render or concept_edit job to a real end state: succeeded, failed or cancelled."""
    repo, storage, settings = state.repo, state.storage, state.settings
    try:
        job = repo.get_job(user, job_id)
        if not job or job["status"] != "queued":
            return
        repo.update_job(user, job_id, {"status": "running", "stage": "Sending to the image model", "started_at": now_iso(),
                                       "attempts": int(job.get("attempts") or 0) + 1, "worker": WORKER_NAME})
    except BackendUnavailable:
        log.exception("could not start job %s", job_id)
        return

    def fail(message: str) -> None:
        try:
            repo.update_job(user, job_id, {"status": "failed", "error": message[:1000], "stage": None, "finished_at": now_iso()})
        except BackendUnavailable:
            log.exception("could not record failure of job %s", job_id)

    inp = job["input"]
    client = state.image_client
    try:
        if job["type"] == "concept_render":
            size, quality = SIZES[inp["aspect"]], inp["quality"]
            ref = None
            if inp.get("reference_file_id"):
                src = repo.get_source_file(user, inp["reference_file_id"])
                if not src or src.get("project_id") != job["project_id"] or src.get("detected_type") not in REF_MIME:
                    return fail("The reference image is no longer available. Choose another one.")
                ref = (storage.download(user, src["storage_path"]), REF_MIME[src["detected_type"]])
            prompt = build_prompt(inp, with_reference=ref is not None)
            model = settings.generate_model
            if ref:
                operation = "image_edit"
                result = client.edit(model=model, prompt=prompt, images=[ref], size=size, quality=quality, user_id=user.id)
            else:
                operation = "image_generate"
                result = client.generate(model=model, prompt=prompt, size=size, quality=quality, user_id=user.id)
            parent, source_file_id = None, inp.get("reference_file_id")
        else:  # concept_edit
            parent = repo.get_rendered_image(user, inp["parent_image_id"])
            if not parent or parent.get("project_id") != job["project_id"]:
                return fail("The render you asked to change is no longer available.")
            base = storage.download(user, parent.get("base_path") or parent["storage_path"], bucket=settings.renders_bucket)
            size, quality = parent["options"].get("size", "auto"), parent["options"].get("quality", "medium")
            prompt = build_edit_prompt(inp["instruction"])
            model, operation = settings.edit_model, "image_edit"
            result = client.edit(model=model, prompt=prompt, images=[(base, "image/jpeg")], size=size, quality=quality, user_id=user.id)
            source_file_id = parent.get("source_file_id")
    except ProviderError as exc:
        return fail(exc.message)
    except BackendUnavailable:
        log.exception("storage or database failed before the model call in job %s", job_id)
        return fail("Could not read the image to work from. Try again in a moment.")
    except Exception:
        log.exception("unexpected error before the model call in job %s", job_id)
        return fail("Something went wrong before the image model was called. Try again.")

    # The call has been made and paid for: record its cost before anything else can fail.
    usage_recorded = record_usage(repo, user, job, model, operation, result)

    try:
        current = repo.get_job(user, job_id)
        if current and current["status"] == "cancelled":
            repo.update_job(user, job_id, {"stage": "Cancelled after the image model had finished; that call was still charged", "finished_at": now_iso()})
            return
        repo.update_job(user, job_id, {"stage": "Saving the image"})
        img = open_image(result.data)
        base_jpg, shown_jpg = to_jpeg(img), to_jpeg(stamp_label(img))
        render_id = str(uuid.uuid4())
        folder = f"{user.id}/{job['project_id']}"
        shown_path, base_path = f"{folder}/{render_id}.jpg", f"{folder}/{render_id}-base.jpg"
        storage.upload(user, base_path, base_jpg, "image/jpeg", bucket=settings.renders_bucket)
        storage.upload(user, shown_path, shown_jpg, "image/jpeg", bucket=settings.renders_bucket)
        options = {"size": size, "quality": quality, "operation": operation}
        if job["type"] == "concept_render":
            options.update({k: inp.get(k) for k in ("view", "time_of_day", "aspect", "materials", "landscaping")})
        try:
            repo.create_rendered_image(user, {
                "id": render_id, "project_id": job["project_id"], "job_id": job_id, "kind": "concept", "label": CONCEPT_LABEL,
                "storage_path": shown_path, "base_path": base_path, "parent_image_id": parent["id"] if parent else None,
                "source_file_id": source_file_id, "prompt": (inp.get("prompt") or inp.get("instruction") or "")[:4000],
                "options": options, "model": model, "width": img.width, "height": img.height,
            })
        except BackendUnavailable:
            storage.remove(user, [shown_path, base_path], bucket=settings.renders_bucket)  # no stored file without its record
            raise
        repo.update_job(user, job_id, {"status": "succeeded", "stage": "Done", "finished_at": now_iso(),
                                       "result": {"render_id": render_id, "usage_recorded": usage_recorded}})
    except BadImage:
        fail("The image model returned an image that could not be read. Try again.")
    except BackendUnavailable:
        log.exception("could not save render for job %s", job_id)
        fail("The image was made but could not be saved. Try again in a moment.")
    except Exception:
        log.exception("unexpected error saving job %s", job_id)
        fail("Something went wrong while saving the render. Try again.")


def record_usage(repo, user: CurrentUser, job: dict, model: str, operation: str, result) -> bool:
    if model.startswith("@cf/"):
        provider, text_in, image_in, out = "cloudflare", 0, 0, 0
        cost = cost_usd_estimate(result.usage)
        source = (f"Cloudflare Workers AI list price ${USD_PER_1000_NEURONS}/1,000 neurons, estimated from image tiles; "
                  f"the first {FREE_NEURONS_PER_DAY:,} neurons a day are free, checked 2026-10-22")
    else:
        provider = "openai"
        text_in, image_in, out = token_counts(result.usage)
        cost = cost_usd(model, result.usage)
        source = PRICE_SOURCE
    try:
        repo.create_usage_event(user, {
            "project_id": job["project_id"], "job_id": job["id"], "provider": provider, "model": model, "operation": operation,
            "input_text_tokens": text_in, "input_image_tokens": image_in, "output_tokens": out,
            "cost_usd": str(cost) if cost is not None else None,
            "price_source": source if cost is not None else ("provider reported no usage" if not result.usage else f"no price on file for {model}"),
            "raw_usage": result.usage, "provider_request_id": result.request_id,
        })
        return True
    except BackendUnavailable:
        log.exception("could not record usage for job %s (model %s, usage %s)", job["id"], model, result.usage)
        return False
