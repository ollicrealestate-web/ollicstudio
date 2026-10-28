"""Cinematic clip: one continuous AI video shot from a start frame (the glowing gold wireframe of
the building) to an end frame (its photoreal render), made by Kling and saved with the project.

Both frames are cropped the same way to the video's shape, so the building stays where it is.
For 3D images, the start frame is made here from the AI line drawing: gold lines with a soft glow
on a night sky. The prompt is written as one timed, unbroken camera take.
"""

from __future__ import annotations

import io
import logging
import subprocess
import tempfile
import time
import uuid
from decimal import Decimal
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from .auth import CurrentUser
from .jobs import WORKER_NAME, now_iso
from .fal import PRICE_SOURCE as FAL_SRC, video_cost
from .kling import PRICE_SOURCE, VideoProviderError, estimate_cost
from .supabase import BackendUnavailable
from .video import THREADS, VideoFailed, _run, ffmpeg_path, probe

log = logging.getLogger("ollic.cinematic")
SIZES = {"720p": {"16:9": (1280, 720), "9:16": (720, 1280), "1:1": (960, 960)},
         "1080p": {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1440, 1440)}}
POLL_SECONDS = 10
MAX_WAIT = 25 * 60


def cover(img: Image.Image, w: int, h: int) -> Image.Image:
    img = img.convert("RGB")
    s = max(w / img.width, h / img.height)
    r = img.resize((max(w, round(img.width * s)), max(h, round(img.height * s))), Image.Resampling.LANCZOS)
    x, y = (r.width - w) // 2, (r.height - h) // 2
    return r.crop((x, y, x + w, y + h))


def jpeg(img: Image.Image, q: int = 92) -> bytes:
    b = io.BytesIO(); img.save(b, "JPEG", quality=q); return b.getvalue()


def gold_frame(lines: Image.Image) -> Image.Image:
    """An AI line drawing (light lines on black) as glowing gold lines on a night sky."""
    lines = lines.convert("L")
    w, h = lines.size
    alpha = lines.point(lambda v: max(0, min(255, int((v - 60) * 255 / 170))))
    sky = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(sky)
    top, mid, low = (4, 9, 21), (15, 31, 66), (36, 54, 95)
    for y in range(h):
        k = y / max(1, h - 1)
        a, b, t = (top, mid, k / 0.6) if k < 0.6 else (mid, low, (k - 0.6) / 0.4)
        d.line([(0, y), (w, y)], fill=tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)))
    gold = Image.new("RGB", (w, h), (255, 178, 80))
    glow = alpha.filter(ImageFilter.GaussianBlur(max(2, w // 300)))
    out = Image.composite(gold, sky, glow.point(lambda v: int(v * 0.7)))
    return ImageChops.screen(out, Image.composite(Image.new("RGB", (w, h), (255, 214, 150)), Image.new("RGB", (w, h)), alpha))


def construction_prompt(seconds: int, extra: str = "") -> str:
    """One unbroken take, beat by beat, like the best construction reels."""
    a, b = max(1, round(seconds * 0.3)), max(2, round(seconds * 0.75))
    return (f"One continuous cinematic camera take of an architectural construction reveal, no cuts, no edits, no time jumps. "
            f"0-{a}s: the building exists only as glowing gold architectural wireframe lines against the night sky, exactly as in the first frame; "
            f"the camera pushes in slowly at a low angle. {a}-{b}s: a line of warm golden light travels upward over the building and the wireframe "
            f"materialises floor by floor into the real building: concrete slabs, columns, facade, glass and balconies form exactly inside the lines, "
            f"sparks of light where they meet. {b}-{seconds}s: the finished building at blue hour, warm interior lights glowing, landscaping lit, "
            f"exactly as in the last frame, the camera settling. Photorealistic architectural cinematography, steady camera, the building's shape, "
            f"floors and windows never change or morph, no people, no text, no logos."
            + (f" {extra.strip()}" if extra.strip() else ""))


def _remux(raw: Path, out: Path) -> Path:
    """Index at the front and an audio track (silent if the clip has none), so phones and WhatsApp play it."""
    ff = ffmpeg_path()
    info = probe(raw)
    has_audio = False
    try:
        res = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(raw)], capture_output=True, timeout=60)
        has_audio = bool(res.stdout.strip())
    except subprocess.TimeoutExpired:
        pass
    cmd = [ff, "-y", "-hide_banner", "-loglevel", "error", "-threads", THREADS, "-i", str(raw)]
    if not has_audio:
        cmd += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0", "-map", "1:a", "-t", f"{info.duration_s:.3f}", "-c:a", "aac", "-b:a", "96k"]
    else:
        cmd += ["-map", "0:v:0", "-map", "0:a:0", "-c:a", "copy"]
    if info.codec == "h264" and info.pix_fmt == "yuv420p":
        cmd += ["-c:v", "copy"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-threads", THREADS]
    cmd += ["-movflags", "+faststart", str(out)]
    _run(cmd, timeout=1800)
    return out


def _cost(status, inp) -> tuple[Decimal, str]:
    for b in status.billing or []:
        try:
            if b.get("charge_type") == "unit":
                return (Decimal(str(b.get("amount"))) * Decimal("0.14")).quantize(Decimal("0.001")), PRICE_SOURCE + "; units reported by Kling"
            if b.get("charge_type") == "cash" and b.get("currency") == "USD":
                return Decimal(str(b.get("amount"))), "amount reported by Kling"
        except Exception:
            pass
    return estimate_cost(inp["resolution"], inp["seconds"], inp.get("audio", False)), PRICE_SOURCE + "; estimated"


def run_clip_job(state, user: CurrentUser, job_id: str) -> None:
    repo, storage, settings = state.repo, state.storage, state.settings
    poll = getattr(state, "clip_poll_seconds", POLL_SECONDS)

    def fail(message: str):
        try:
            repo.update_job(user, job_id, {"status": "failed", "error": message[:1000], "stage": None, "finished_at": now_iso()})
        except BackendUnavailable:
            log.exception("could not record failure of clip job %s", job_id)

    try:
        job = repo.get_job(user, job_id)
        if not job or job["status"] != "queued":
            return
        inp = job["input"]
        engine = inp.get("engine") or "motion"
        clips = getattr(state, "video_clients", None) or {"motion": getattr(state, "kling", None)}
        kling = clips.get(engine)     # the video client for the chosen option (same create/status/download shape)
        if kling is None:
            return fail("This video option is not connected yet. Choose another.")
        provider = getattr(kling, "provider", "kling")
        repo.update_job(user, job_id, {"status": "running", "stage": "Preparing the frames", "started_at": now_iso(),
                                       "attempts": int(job.get("attempts") or 0) + 1, "worker": WORKER_NAME})
        w, h = SIZES[inp["resolution"]][inp["format"]]

        def picture(ref) -> Image.Image:
            if ref["kind"] == "file":
                f = repo.get_source_file(user, ref["id"])
                if not f or f.get("project_id") != job["project_id"]:
                    raise LookupError
                return Image.open(io.BytesIO(storage.download(user, f["storage_path"])))
            img = repo.get_rendered_image(user, ref["id"])
            if not img or img.get("project_id") != job["project_id"]:
                raise LookupError
            pic = Image.open(io.BytesIO(storage.download(user, img.get("base_path") or img["storage_path"], bucket=settings.renders_bucket)))
            return gold_frame(pic) if ref["kind"] == "lines" else pic

        try:
            first, last = picture(inp["start"]), picture(inp["end"])
        except LookupError:
            return fail("One of the pictures for the clip is no longer available.")
        first_jpg, last_jpg = jpeg(cover(first, w, h)), jpeg(cover(last, w, h))
        prompt = construction_prompt(inp["seconds"], inp.get("prompt_extra") or "")
        repo.update_job(user, job_id, {"stage": "Sending to the video service"})
        extra = {"aspect": inp["format"]} if provider == "fal" else {}
        task = kling.create(first_frame=first_jpg, last_frame=last_jpg, prompt=prompt, seconds=inp["seconds"], resolution=inp["resolution"],
                            audio=bool(inp.get("audio")), external_id=job_id, **extra)
        repo.update_job(user, job_id, {"stage": "Filming the clip (usually 2 to 6 minutes)", "result": {"provider_task": task}})
        started, st, misses = time.monotonic(), None, 0
        while True:
            if repo.get_job(user, job_id).get("status") == "cancelled":
                return
            try:
                st = kling.status(task); misses = 0
            except VideoProviderError as exc:
                misses += 1
                if not exc.retry or misses > 6:
                    raise
            if st and st.status in ("succeeded", "failed"):
                break
            waited = int(time.monotonic() - started)
            if waited > MAX_WAIT:
                return fail("The video service took too long. Nothing was saved; try again later.")
            repo.update_job(user, job_id, {"stage": f"Filming the clip ({waited // 60} min {waited % 60:02d} s so far)"})
            time.sleep(poll)
        if st.status == "failed":
            log.warning("OWNER: %s task %s failed: %s", provider, task, st.message)
            return fail("The video service could not make this clip. Try other views, or try again later.")
        if not st.video_url:
            return fail("The video service finished without a video. Try again.")
        repo.update_job(user, job_id, {"stage": "Saving the clip"})
        data = kling.download(st.video_url)
        cost, source = (video_cost(inp["resolution"], inp["seconds"]), FAL_SRC + "; estimated") if provider == "fal" else _cost(st, inp)
        try:
            repo.create_usage_event(user, {"project_id": job["project_id"], "job_id": job_id, "provider": provider, "model": getattr(kling, "model", None) or settings.kling_model,
                                           "operation": "video_generate", "cost_usd": str(cost), "price_source": source,
                                           "raw_usage": {"billing": st.billing, "seconds": inp["seconds"], "resolution": inp["resolution"], "task": task}})
        except BackendUnavailable:
            log.exception("could not record clip cost for job %s", job_id)
        with tempfile.TemporaryDirectory(prefix="ollic-clip-") as tmp:
            raw = Path(tmp) / "raw.mp4"; raw.write_bytes(data)
            final = _remux(raw, Path(tmp) / "clip.mp4")
            info = probe(final)
            out = final.read_bytes()
        vid = str(uuid.uuid4())
        path = f"{user.id}/{job['project_id']}/{vid}.mp4"
        storage.upload(user, path, out, "video/mp4", bucket=settings.videos_bucket)
        try:
            repo.create_video(user, {"id": vid, "project_id": job["project_id"], "job_id": job_id, "storage_path": path, "title": inp.get("title") or None,
                                     "format": inp["format"], "width": info.width, "height": info.height, "fps": round(info.fps) or 24,
                                     "duration_s": round(info.duration_s, 2), "items": [inp["start"], inp["end"]], "kind": "cinematic",
                                     "script": {"seconds": inp["seconds"], "resolution": inp["resolution"], "audio": bool(inp.get("audio"))},
                                     "label": "AI video — not to scale"})
        except BackendUnavailable:
            storage.remove(user, [path], bucket=settings.videos_bucket)
            raise
        repo.update_job(user, job_id, {"status": "succeeded", "stage": "Done", "finished_at": now_iso(),
                                       "result": {"video_id": vid, "provider_task": task, "cost_usd": str(cost)}})
    except VideoProviderError as exc:
        from .renders import _owner_note
        fail(exc.message + _owner_note(repo, user, exc))
    except VideoFailed as exc:
        log.error("clip job %s: %s", job_id, exc.__cause__)
        fail("The finished clip could not be prepared. Try again.")
    except BackendUnavailable:
        log.exception("storage or database failed in clip job %s", job_id)
        fail("The clip could not be saved. Try again in a moment.")
    except Exception:
        log.exception("unexpected error in clip job %s", job_id)
        fail("Something went wrong while making the clip. Try again.")
