"""The full film: the walkthrough's finished shots joined into one video on Ollic's own server (FFmpeg,
no AI service), with soft cross-fades, a title card at the start and an end card. Each shot was already
filmed from the model and checked against it; joining changes nothing in them.
"""

from __future__ import annotations

import logging
import tempfile
import uuid
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .auth import CurrentUser
from .imaging import FONT
from .jobs import WORKER_NAME, now_iso
from .supabase import BackendUnavailable
from .video import THREADS, VideoFailed, _run, ffmpeg_path, probe

log = logging.getLogger("ollic.filmjoin")
FADE = 0.6          # seconds of cross-fade between shots
CARD = 3.0          # seconds of each title card
FPS = 24


def title_card(w: int, h: int, title: str, subtitle: str) -> Image.Image:
    """Ollic's card: black, the title in white, a thin red rule, the subtitle in grey."""
    img = Image.new("RGB", (w, h), (8, 8, 10))
    d = ImageDraw.Draw(img)
    big, small = ImageFont.truetype(str(FONT), max(24, h // 13)), ImageFont.truetype(str(FONT), max(16, h // 30))
    title = (title or "").strip()[:80]
    subtitle = (subtitle or "").strip()[:120]
    tw = d.textlength(title, font=big)
    while tw > w * 0.86 and big.size > 20:
        big = ImageFont.truetype(str(FONT), big.size - 2); tw = d.textlength(title, font=big)
    y = h // 2 - big.size
    d.text(((w - tw) / 2, y), title, font=big, fill=(245, 245, 245))
    rule = max(40, w // 14)
    ry = y + big.size + h // 40
    d.rectangle([(w - rule) // 2, ry, (w + rule) // 2, ry + max(2, h // 300)], fill=(200, 30, 40))
    if subtitle:
        sw = d.textlength(subtitle, font=small)
        d.text(((w - sw) / 2, ry + h // 30), subtitle, font=small, fill=(170, 170, 176))
    return img


def join(clips: list[Path], out: Path, w: int, h: int, title: str, subtitle: str, end_title: str, beat=lambda: None) -> None:
    """Title card, the clips in order, end card; cross-faded, H.264 with a silent AAC track, index first."""
    tmp = out.parent
    start, end = tmp / "start.png", tmp / "end.png"
    title_card(w, h, title, subtitle).save(start)
    title_card(w, h, end_title, subtitle).save(end)
    durs = [CARD] + [max(1.0, probe(c).duration_s) for c in clips] + [CARD]
    cmd = [ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", "-threads", THREADS,
           "-loop", "1", "-t", f"{CARD}", "-i", str(start)]
    for c in clips:
        cmd += ["-i", str(c)]
    cmd += ["-loop", "1", "-t", f"{CARD}", "-i", str(end), "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
    n = len(clips) + 2
    parts = [f"[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={FPS},format=yuv420p,"
             f"trim=duration={durs[i]:.3f},setpts=PTS-STARTPTS[v{i}]" for i in range(n)]
    last, acc = "v0", durs[0]
    for i in range(1, n):
        lbl = f"x{i}"
        parts.append(f"[{last}][v{i}]xfade=transition=fade:duration={FADE}:offset={acc - FADE:.3f}[{lbl}]")
        last, acc = lbl, acc + durs[i] - FADE
    cmd += ["-filter_complex", ";".join(parts), "-map", f"[{last}]", "-map", f"{n}:a", "-t", f"{acc:.3f}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high", "-pix_fmt", "yuv420p",
            "-filter_threads", THREADS, "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(out)]
    _run(cmd, timeout=3600, beat=beat)


def run_join_job(state, user: CurrentUser, job_id: str) -> None:
    repo, storage, settings = state.repo, state.storage, state.settings

    def fail(message: str):
        try:
            repo.update_job(user, job_id, {"status": "failed", "error": message[:1000], "stage": None, "finished_at": now_iso()})
        except BackendUnavailable:
            log.exception("could not record failure of join job %s", job_id)

    try:
        job = repo.get_job(user, job_id)
        if not job or job["status"] != "queued":
            return
        inp, pid = job["input"], job["project_id"]
        repo.update_job(user, job_id, {"status": "running", "stage": "Fetching the shots", "started_at": now_iso(),
                                       "attempts": int(job.get("attempts") or 0) + 1, "worker": WORKER_NAME})
        vids = []
        for vid in inp["video_ids"]:
            v = repo.get_video(user, vid)
            if not v or v.get("project_id") != pid:
                return fail("A shot of the film is no longer available. Choose the shots again.")
            vids.append(v)

        def beat():
            repo.update_job(user, job_id, {"stage": "Joining the shots into one film"})
            if (repo.get_job(user, job_id) or {}).get("status") == "cancelled":
                raise VideoFailed("Cancelled.")

        with tempfile.TemporaryDirectory(prefix="ollic-join-") as tmp:
            tmp = Path(tmp)
            clips = []
            for i, v in enumerate(vids):
                p = tmp / f"shot{i}.mp4"
                p.write_bytes(storage.download(user, v["storage_path"], bucket=settings.videos_bucket))
                clips.append(p)
            first = probe(clips[0])
            w, h = first.width - first.width % 2, first.height - first.height % 2
            out = tmp / "film.mp4"
            repo.update_job(user, job_id, {"stage": "Joining the shots into one film"})
            join(clips, out, w, h, inp.get("title") or "", inp.get("subtitle") or "", inp.get("end_title") or inp.get("title") or "", beat)
            info = probe(out)
            data = out.read_bytes()
        repo.update_job(user, job_id, {"stage": "Saving the film"})
        new = str(uuid.uuid4())
        path = f"{user.id}/{pid}/{new}.mp4"
        storage.upload(user, path, data, "video/mp4", bucket=settings.videos_bucket)
        try:
            repo.create_video(user, {"id": new, "project_id": pid, "job_id": job_id, "storage_path": path, "title": inp.get("title") or "Full film",
                                     "format": inp.get("format") or "16:9", "width": info.width, "height": info.height, "fps": FPS,
                                     "duration_s": round(info.duration_s, 2), "items": [{"video_id": v["id"], "caption": v.get("title") or ""} for v in vids],
                                     "kind": "film", "script": {"joined": True, "shots": len(vids)}, "label": "AI video — not to scale"})
        except BackendUnavailable:
            storage.remove(user, [path], bucket=settings.videos_bucket)
            raise
        repo.update_job(user, job_id, {"status": "succeeded", "stage": "Done", "finished_at": now_iso(), "result": {"video_id": new}})
    except VideoFailed as exc:
        if str(exc) == "Cancelled.":
            return
        log.error("join job %s: %s", job_id, exc.__cause__)
        fail("The film could not be joined. Try again.")
    except BackendUnavailable:
        log.exception("storage or database failed in join job %s", job_id)
        fail("The film could not be saved. Try again in a moment.")
    except Exception:
        log.exception("unexpected error in join job %s", job_id)
        fail("Something went wrong while joining the film. Try again.")
