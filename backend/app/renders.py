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
    "exterior": "Exterior view of the whole building from eye level on the street",
    "aerial": "Aerial three-quarter view of the building and its plot",
    "cutaway": "Three-quarter cutaway view with the front facade removed, showing the furnished apartments and floors inside",
    "interior": "Interior view of a furnished room at standing eye level",
}
STYLES = {
    "luxury contemporary": "luxury contemporary architecture: glass balconies, stone and timber cladding, premium finishes, feature lighting",
    "minimalist modern": "minimalist modern architecture: clean lines, white render, large windows, simple finishes",
    "classic luxury": "classic luxury architecture: elegant mouldings, columns, refined cornices, symmetrical facade",
    "tropical modern": "tropical modern architecture: deep overhangs, timber screens, planting on terraces, shaded balconies",
}
ROLE_TEXT = {
    "base": "is the design to render. Keep the building's form, proportions and roof, the positions of walls, doors and windows, and the camera viewpoint exactly as they are.",
    "model": "is a plain 3D view of the architect's model. Keep its exact shape, number of floors, proportions, openings and camera viewpoint; only add realistic materials, glazing, landscaping and light.",
    "plan": "is the architect's floor plan of a typical floor. Follow its footprint and arrangement: where the units, core, balconies, terraces and openings are. Do not draw the plan itself; show the building it describes.",
    "style": "is a reference for the look: facade, materials, glazing and details. Take its style, not its shape.",
}
ROLE_ORDER = {"base": 0, "model": 1, "plan": 2, "style": 3}
LIGHT = {
    "morning": "soft morning daylight",
    "midday": "bright midday sun with clear shadows",
    "golden hour": "warm golden-hour sunlight with long shadows",
    "dusk": "dusk, sky fading to blue, interior and exterior lights switched on",
    "night": "night, artificial lighting on inside and outside",
}
REF_MIME = {"png": "image/png", "jpeg": "image/jpeg"}


def build_prompt(opts: dict, *, with_reference: bool = False, roles: list[str] | None = None) -> str:
    """The brief for the image model. `roles` lists what each supplied image is, in order."""
    roles = roles if roles is not None else (["base"] if with_reference else [])
    parts = ["Photorealistic architectural visualisation, the quality of a professional architectural render."]
    keeps_camera = any(r in ("base", "model") for r in roles)
    if not keeps_camera:
        parts.append(VIEWS[opts.get("view", "exterior")] + ".")
    for i, role in enumerate(roles, 1):
        parts.append(f"Image {i} {ROLE_TEXT[role]}")
    if opts.get("storeys"):
        gf = opts.get("ground_floor") or ""
        above = f"{opts['storeys']} floors" + (f" above a ground-floor {gf}" if gf and gf != "flats" else "")
        parts.append(f"The building has {above}.")
    elif opts.get("ground_floor") and opts["ground_floor"] != "flats":
        parts.append(f"The ground floor is a {opts['ground_floor']}.")
    if opts.get("style"):
        parts.append(f"Style: {STYLES.get(opts['style'], opts['style'])}.")
    if opts.get("shot_name"):
        parts.append(f"This shot is: {opts['shot_name'].strip()}. Render it as a finished, furnished, lived-in space or view, true to the model.")
    parts.append(f"Architect's brief: {opts['prompt'].strip()}")
    if opts.get("materials"):
        parts.append(f"Materials and colours: {opts['materials'].strip()}.")
    if opts.get("landscaping"):
        parts.append(f"Landscaping and surroundings: {opts['landscaping'].strip()}.")
    parts.append(f"Lighting: {LIGHT[opts['time_of_day']]}.")
    parts.append("Realistic materials and proportions, natural colour, no people in the foreground. Do not add any text, labels, logos or watermarks.")
    return "\n".join(parts)


SAFE_TAIL = "Do not add any text, labels, logos or watermarks."


def _premium_prompt(state, user, job, tier, ask):
    """Premium renders get their prompt written by Claude from the images and brief. Any failure falls
    back to the standard prompt, so a render is never lost because prompting was unavailable."""
    writer = getattr(state, "prompt_writer", None)
    if tier != "premium" or writer is None:
        return None
    from .prompt_writer import PRICE_SOURCE as P_SRC, PromptWriterFailed
    try:
        state.repo.update_job(user, job["id"], {"stage": "Studying your images and writing the brief"})
        out = ask(writer)
    except PromptWriterFailed as exc:
        log.warning("premium prompting failed for job %s: %s", job["id"], exc)
        return None
    except Exception:
        log.exception("premium prompting crashed for job %s", job["id"])
        return None
    try:
        u = out.get("usage") or {}
        state.repo.create_usage_event(user, {
            "project_id": job["project_id"], "job_id": job["id"], "provider": "anthropic", "model": out["model"], "operation": "prompt_write",
            "input_text_tokens": int(u.get("input_tokens") or 0), "output_tokens": int(u.get("output_tokens") or 0),
            "cost_usd": str(out["cost_usd"]) if out.get("cost_usd") is not None else None,
            "price_source": P_SRC if out.get("cost_usd") is not None else f"no price on file for {out['model']}", "raw_usage": u,
        })
    except BackendUnavailable:
        log.exception("could not record prompting usage for job %s", job["id"])
    state.repo.update_job(user, job["id"], {"stage": "Sending to the image model"})
    return out


def _as_image(data: bytes, kind: str) -> tuple[bytes, str]:
    """Reference images go to the model as PNG or JPEG; a PDF drawing is sent as its first page."""
    if kind == "pdf":
        from .vision import image_png, load_image
        return image_png(load_image(data, "pdf"), max_side=2000), "image/png"
    return data, REF_MIME[kind]


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
    tier = inp.get("tier", "standard")
    writer_note = None
    client = state.image_clients.get(tier)
    if client is None:
        return fail("Premium render is not available right now." if tier == "premium" else "Standard renders are not available right now.")
    try:
        if job["type"] == "concept_render":
            size, quality = SIZES[inp["aspect"]], inp["quality"]
            refs = list(inp.get("references") or [])
            if inp.get("reference_file_id") and not refs:
                refs = [{"file_id": inp["reference_file_id"], "role": "base"}]
            refs.sort(key=lambda r: ROLE_ORDER[r["role"]])
            images, roles = [], []
            for r in refs:
                src = repo.get_source_file(user, r["file_id"])
                if not src or src.get("project_id") != job["project_id"] or src.get("detected_type") not in ("png", "jpeg", "pdf"):
                    return fail("One of the reference images is no longer available. Choose it again.")
                images.append(_as_image(storage.download(user, src["storage_path"]), src["detected_type"]))
                roles.append(r["role"])
            prompt = build_prompt(inp, roles=roles)
            writer_note = _premium_prompt(state, user, job, tier, lambda w: w.write(
                brief=inp["prompt"], images=images, roles=roles,
                choices={k: inp.get(k) for k in ("view", "style", "storeys", "ground_floor", "time_of_day", "materials", "landscaping", "aspect", "shot_name")}))
            if writer_note:
                prompt = writer_note["prompt"] + "\n" + SAFE_TAIL
            model = settings.model_for(tier, "create")
            if images:
                operation = "image_edit"
                result = client.edit(model=model, prompt=prompt, images=images, size=size, quality=quality, user_id=user.id)
            else:
                operation = "image_generate"
                result = client.generate(model=model, prompt=prompt, size=size, quality=quality, user_id=user.id)
            parent = None
            source_file_id = next((r["file_id"] for r in refs if r["role"] in ("base", "model", "plan")), refs[0]["file_id"] if refs else None)
        else:  # concept_edit
            parent = repo.get_rendered_image(user, inp["parent_image_id"])
            if not parent or parent.get("project_id") != job["project_id"]:
                return fail("The render you asked to change is no longer available.")
            base = storage.download(user, parent.get("base_path") or parent["storage_path"], bucket=settings.renders_bucket)
            size, quality = parent["options"].get("size", "auto"), parent["options"].get("quality", "medium")
            prompt = build_edit_prompt(inp["instruction"])
            writer_note = _premium_prompt(state, user, job, tier, lambda w: w.write_edit(instruction=inp["instruction"], current=base))
            if writer_note:
                prompt = writer_note["prompt"] + "\n" + SAFE_TAIL
            model, operation = settings.model_for(tier, "revise"), "image_edit"
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
        options = {"size": size, "quality": quality, "operation": operation, "tier": tier, "final_prompt": prompt[:8000],
                   "prompt_notes": (writer_note or {}).get("notes"), "premium_prompting": bool(writer_note)}
        if job["type"] == "concept_render":
            options.update({k: inp.get(k) for k in ("view", "time_of_day", "aspect", "materials", "landscaping", "style", "storeys", "ground_floor", "references", "shot_id", "shot_name")})
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
