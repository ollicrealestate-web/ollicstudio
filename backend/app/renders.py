"""Concept renders: prompt building and the job that calls the image model (brief Module C).

Everything here runs as the signed-in user, with their token, so row-level security
still applies to every database and storage call the job makes.
"""

from __future__ import annotations

import io
import logging
import uuid

from PIL import Image

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
            if inp.get("prompt_ready"):      # the prompt the AI wrote from the pictures and the architect checked: used as written
                prompt = inp["prompt"].strip() + "\n" + SAFE_TAIL
            writer_note = None if inp.get("prompt_ready") else _premium_prompt(state, user, job, tier, lambda w: w.write(
                brief=inp["prompt"], images=images, roles=roles,
                choices={k: inp.get(k) for k in ("view", "style", "storeys", "ground_floor", "time_of_day", "materials", "landscaping", "aspect", "shot_name")}))
            if writer_note:
                prompt = writer_note["prompt"] + "\n" + SAFE_TAIL
            # the project's approved look (materials by the model's material map, the hero render) for model views
            send, look_ctx = images, None
            if "model" in roles:
                images, roles, block, look_ctx = apply_look(state, user, job, inp, images, roles, exact=(tier == "exact"))
                if block:
                    prompt = (prompt[: -len(SAFE_TAIL)].rstrip() if prompt.endswith(SAFE_TAIL) else prompt) + "\n" + block + "\n" + SAFE_TAIL
                send = images
                if tier == "exact":   # Ollic Exact draws on the model's depth map from the same camera
                    d = repo.get_source_file(user, inp.get("depth_file_id") or "")
                    if not d or d.get("project_id") != job["project_id"]:
                        return fail("The depth view of your model is missing. Capture the view again.")
                    send = [(storage.download(user, d["storage_path"]), "image/png")]
            model = settings.model_for(tier, "create")
            if images:
                operation = "image_edit"
                result = client.edit(model=model, prompt=prompt, images=send, size=size, quality=quality, user_id=user.id)
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
        return fail(exc.message + _owner_note(repo, user, exc))
    except BackendUnavailable:
        log.exception("storage or database failed before the model call in job %s", job_id)
        return fail("Could not read the image to work from. Try again in a moment.")
    except Exception:
        log.exception("unexpected error before the model call in job %s", job_id)
        return fail("Something went wrong before the image model was called. Try again.")

    # The call has been made and paid for: record its cost before anything else can fail.
    usage_recorded = record_usage(repo, user, job, model, operation, result)

    # Made from the architect's model: check the geometry against the exact model view; when the AI only
    # reframed the building, put it back in the model's camera; below the target, make it once more with
    # the geometry rule first and keep the better one.
    check = None
    if job["type"] == "concept_render" and inp.get("guide_file_id"):
        check, result = geometry_check(state, user, job, inp, result, images, roles, look_ctx)
        if check and needs_another(check):
            try:
                rule = fix_rule(check)
                finisher = state.image_clients.get("vs") if tier == "exact" else None
                if finisher is not None:
                    # Exact keeps the model's shape and camera; the finishing pass corrects only what was found, on that picture
                    repo.update_job(user, job_id, {"stage": f"Correcting what did not match your model ({rule[0]})"})
                    fprompt = finish_prompt(check, look_ctx)
                    fimages = [(result.data, "image/jpeg"), images[roles.index("model")]] + ([(look_ctx["map"], "image/png")] if look_ctx and look_ctx.get("map") else [])
                    fmodel = settings.model_for("vs", "revise")
                    again = finisher.edit(model=fmodel, prompt=fprompt, images=fimages, size=size, quality=quality, user_id=user.id)
                    record_usage(repo, user, job, fmodel, "image_edit", again)
                    check2, again = geometry_check(state, user, job, inp, again, images, roles, look_ctx)
                    if check2 and rank(check2) >= rank(check):
                        result, check = again, check2 | {"finished": True}
                else:
                    repo.update_job(user, job_id, {"stage": f"The first try did not match your model closely enough ({rule[0]}); rendering again"})
                    again = client.edit(model=model, prompt=rule[1] + prompt, images=send, size=size, quality=quality, user_id=user.id)
                    record_usage(repo, user, job, model, operation, again)
                    check2, again = geometry_check(state, user, job, inp, again, images, roles, look_ctx)
                    if check2 and rank(check2) > rank(check):
                        result, check, prompt = again, check2, rule[1] + prompt
                check["retried"] = True
            except (ProviderError, BackendUnavailable):
                check["retried"] = False

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
        if check:
            options["check"] = check
        if job["type"] == "concept_render":
            options.update({k: inp.get(k) for k in ("view", "time_of_day", "aspect", "materials", "landscaping", "style", "storeys", "ground_floor", "references", "shot_id", "shot_name", "anim_hero", "anim_line", "prompt_ready", "guide_file_id", "film_shot")})
        elif inp.get("anim_line"):
            options["anim_line"] = inp["anim_line"]
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


from .geometry import GOOD as GOOD_MATCH  # noqa: E402

MATERIALS_FIRST = ("Most important: use exactly the approved materials and colours listed below, in exactly the places the material map "
                   "shows, and keep the building's geometry and camera exactly as in Image 1.\n")


def _owner_note(repo, user: CurrentUser, exc) -> str:
    """For the owner's own accounts only: what the provider actually said, to fix the setup quickly."""
    detail = getattr(exc, "owner_detail", None)
    if not detail:
        return ""
    try:
        role = (repo.get_profile(user) or {}).get("role")
    except BackendUnavailable:
        return ""
    return f" [owner only: {detail}]" if role == "admin" else ""


def finish_prompt(check: dict, look_ctx: dict | None) -> str:
    """The finishing pass: keep the photo, fix only what the check found."""
    from .look import look_block
    issues = [i for i in (check.get("claude") or {}).get("issues") or [] if i][:8]
    off = [m for m in ((check.get("materials") or {}).get("materials") or []) if not m.get("ok")]
    lines = ["Image 1 is a photorealistic architectural render. Keep Image 1 as it is: the same photograph, camera, framing, light, sky, "
             "setting and the same building shape. Image 2 is the exact view of the architect's model from the same camera.",
             "Correct only these differences from the architect's model, and change nothing else:"]
    lines += [f"- {i}" for i in issues]
    lines += [f"- {m['name']}: make it the approved material and colour (it looks {m['seen']} now)" for m in off]
    if not issues and not off:
        lines.append("- make every floor, opening, balcony and roof element match Image 2 exactly")
    if look_ctx and look_ctx.get("map"):
        lines.append(look_block(look_ctx["look"], 3, None))
    lines.append(SAFE_TAIL)
    return "\n".join(lines)


def needs_another(check: dict) -> bool:
    """Below the target on shape or materials, or Claude saw a floor, opening or element out of place."""
    return overall(check) < GOOD_MATCH or (check.get("claude") or {}).get("ok") is False


def rank(check: dict) -> tuple:
    """Which of two tries to keep: Claude's verdict first, then the scores."""
    return ((check.get("claude") or {}).get("ok") is not False, overall(check))


def fix_rule(check: dict) -> tuple[str, str]:
    """(what went wrong, in a few words; the rule put first in the prompt for the second try)."""
    issues = [i for i in (check.get("claude") or {}).get("issues") or [] if i][:6]
    if issues:
        return ("Claude found differences", "Most important: the previous attempt differed from the architect's model. Fix exactly these, and keep "
                "everything else as in Image 1:\n" + "\n".join(f"- {i}" for i in issues) + "\n" + GEOMETRY_FIRST)
    if check["score"] >= GOOD_MATCH:
        return ("materials", MATERIALS_FIRST)
    return ("geometry", GEOMETRY_FIRST)


def overall(check: dict) -> float:
    """The lower of the shape score and, when the project has approved materials, the materials score."""
    m = (check.get("materials") or {}).get("score")
    return min(check["score"], m) if m is not None else check["score"]


def apply_look(state, user: CurrentUser, job: dict, inp: dict, images: list, roles: list, exact: bool = False):
    """Adds the project's material map and hero render to the pictures sent, and says what they are.
    Returns (images, roles, text for the prompt, context for the check)."""
    from .look import look_block
    from .routes.look import current_look
    repo, storage, settings = state.repo, state.storage, state.settings
    try:
        project = repo.get_project(user, job["project_id"]) or {}
    except BackendUnavailable:
        return images, roles, "", None
    look = current_look(project)
    mats = [m for m in look.materials if m.name]
    ctx = {"look": look, "map": None}
    if inp.get("material_file_id") and mats:
        f = repo.get_source_file(user, inp["material_file_id"])
        if f and f.get("project_id") == job["project_id"]:
            ctx["map"] = storage.download(user, f["storage_path"])
    hero = None
    if look.hero_render_id and not exact:
        r = repo.get_rendered_image(user, str(look.hero_render_id))
        if r and r.get("project_id") == job["project_id"]:
            try:
                hero = storage.download(user, r.get("base_path") or r["storage_path"], bucket=settings.renders_bucket)
            except BackendUnavailable:
                hero = None
    if exact:      # the depth model sees only the prompt: the materials go in as words
        return images, roles, look_block(look, None, None), ctx
    at = roles.index("model") + 1
    add = ([(ctx["map"], "image/png", "materials")] if ctx["map"] else []) + ([(hero, "image/jpeg", "hero")] if hero else [])
    images = images[:at] + [(d, m) for d, m, _ in add] + images[at:]
    roles = roles[:at] + [r for _, _, r in add] + roles[at:]
    while len(images) > 4 and "style" in roles:          # image models take up to four pictures: references go first
        i = len(roles) - 1 - roles[::-1].index("style"); images.pop(i); roles.pop(i)
    map_i = roles.index("materials") + 1 if "materials" in roles else None
    hero_i = roles.index("hero") + 1 if "hero" in roles else None
    return images, roles, look_block(look, map_i, hero_i, roles.index("model") + 1), ctx


GEOMETRY_FIRST = ("Most important: Image 1 is an exact view of the architect's model. Keep its geometry exactly: the same number of floors, "
                  "every window and door opening in the same place, the same roof line, balconies, columns, setbacks and camera. "
                  "Keep the same framing: the building at exactly the same size and position in the picture as in Image 1. "
                  "Do not add, remove or move any part of the building.\n")


def geometry_check(state, user: CurrentUser, job: dict, inp: dict, result, images, roles, look_ctx=None):
    """(check, result): how well the result kept the model's geometry (see geometry.py), with the
    result put back in the model's camera when the AI only reframed it; Claude's view too when connected."""
    from dataclasses import replace

    from .geometry import assess, claude_check, jpeg as gjpeg
    repo = state.repo
    if "model" not in roles:
        return None, result
    try:
        view = Image.open(io.BytesIO(images[roles.index("model")][0]))
        out = Image.open(io.BytesIO(result.data)).convert("RGB")
        check, fixed = assess(view, out)
        if fixed is not None:
            out = fixed
            result = replace(result, data=gjpeg(fixed, 93), output_format="jpeg")
        if look_ctx and look_ctx.get("map"):
            from .look import material_check
            mc = material_check(Image.open(io.BytesIO(look_ctx["map"])), out, [m for m in look_ctx["look"].materials if m.name])
            if mc:
                check["materials"] = mc
        writer = getattr(state, "prompt_writer", None)
        if writer is not None:
            facts = ""
            if inp.get("model_id"):
                from .render_prompt import facts_text
                try:
                    m = repo.get_model(user, inp["model_id"])
                    facts = facts_text(m) if m and m.get("project_id") == job["project_id"] else ""
                except BackendUnavailable:
                    facts = ""
            mmap, mtext = None, ""
            if look_ctx and look_ctx.get("map"):
                from .look import look_block
                mmap, mtext = look_ctx["map"], look_block(look_ctx["look"], 3, None)
            seen = claude_check(writer, images[roles.index("model")][0], gjpeg(out), facts, mmap, mtext)
            if seen and seen.get("error"):
                check["claude_error"] = seen["error"]
                seen = None
            if seen:
                check["claude"] = {"ok": seen["ok"], "issues": seen["issues"]}
                if not seen["ok"] and check["band"] == "good":
                    check["band"] = "fair"
                try:
                    repo.create_usage_event(user, {"project_id": job["project_id"], "job_id": job["id"], "provider": "anthropic", "model": getattr(writer, "model", "claude"),
                                                   "operation": "geometry_check", "cost_usd": seen.get("cost_usd"), "price_source": "platform.claude.com price list",
                                                   "raw_usage": seen.get("usage")})
                except BackendUnavailable:
                    pass
        return check, result
    except Exception:
        log.exception("geometry check failed for job %s", job["id"])
        return None, result


def record_usage(repo, user: CurrentUser, job: dict, model: str, operation: str, result) -> bool:
    if model.startswith("fal-ai/"):
        from .fal import IMAGE_PRICE, PRICE_SOURCE as F_SRC
        provider, text_in, image_in, out = "fal", 0, 0, 0
        cost, source = IMAGE_PRICE, F_SRC
    elif model.startswith("gemini"):
        from .gemini_images import PRICE_SOURCE as G_SRC, cost_usd as g_cost
        provider, text_in, image_in, out = "google", 0, 0, 0
        cost, source = g_cost(model, "2K"), G_SRC
    elif model.startswith("@cf/"):
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
