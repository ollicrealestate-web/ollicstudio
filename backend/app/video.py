"""Rendered walkthrough videos (brief Module O and test 11): the realistic stills of each
room and view, joined into an MP4 with slow camera moves, cross-fades, room titles, a title
card and an end card. Made with FFmpeg on Ollic's own server; no AI service is involved.

Each clip is encoded on its own with its fades, and the clips are then joined without
re-encoding, so memory stays low (about 200 MB) and the join takes a second even on a small
server. Output plays in Chrome, Safari, Android, iPhone and WhatsApp: H.264 High, yuv420p, 30 fps,
a silent AAC track, and the index at the front of the file (faststart).
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .imaging import CONCEPT_LABEL

FONT = Path(__file__).parent / "fonts" / "Outfit.ttf"
FORMATS = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)}
FPS = 30
FADE = 0.4          # seconds each clip fades in from and out to black (a 0.8 s dip between shots)
CARD_SECONDS = 3.0
# FFmpeg sizes its thread pool from the host's CPU count, not the slice a small server is given;
# each thread holds frames, so on a 512 MB instance on a big host it ran out of memory. One thread
# keeps a 1080p clip near 180 MB; set FFMPEG_THREADS higher on a larger server.
THREADS = str(max(1, int(os.environ.get("FFMPEG_THREADS", "1") or 1)))
RED = (212, 33, 39)
INK = (244, 244, 245)
BLACK = (7, 7, 7)


class VideoFailed(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


@dataclass
class VideoResult:
    data: bytes
    width: int
    height: int
    fps: int
    duration_s: float


def ffmpeg_path() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise VideoFailed("Video export is not available on this server yet.")
    return path


def _font(size: int, weight: str = "SemiBold") -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(FONT), size)
    try:
        f.set_variation_by_name(weight)
    except (OSError, ValueError, AttributeError):
        pass
    return f


def _cover(img: Image.Image, w: int, h: int) -> Image.Image:
    """Scales and centre-crops to fill w x h exactly."""
    img = img.convert("RGB")
    s = max(w / img.width, h / img.height)
    r = img.resize((max(w, round(img.width * s)), max(h, round(img.height * s))), Image.Resampling.LANCZOS)
    x, y = (r.width - w) // 2, (r.height - h) // 2
    return r.crop((x, y, x + w, y + h))


def _wrap(draw, text, font, width):
    words, lines, line = text.split(), [], ""
    for w in words:
        test = f"{line} {w}".strip()
        if draw.textlength(test, font=font) <= width or not line:
            line = test
        else:
            lines.append(line); line = w
    if line:
        lines.append(line)
    return lines


def caption(w: int, h: int, title: str, brand: str) -> Image.Image:
    """Transparent overlay: room or view title (bottom left), concept label (top left), brand (bottom right)."""
    u = min(w, h) / 1080
    o = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(o)
    # soft shade at the bottom so white text reads on any picture
    band = int(300 * u)
    for i in range(band):  # i = 0 at the bottom edge: darkest there, fading to nothing upwards
        a = int(160 * (1 - i / band) ** 1.8)
        d.line([(0, h - 1 - i), (w, h - 1 - i)], fill=(0, 0, 0, a))
    m = int(56 * u)
    if title:
        f = _font(int(54 * u), "SemiBold")
        lines = _wrap(d, title, f, w * 0.7)[:2]
        y = h - m - len(lines) * int(64 * u)
        d.rectangle([m, y + int(6 * u), m + int(7 * u), h - m - int(8 * u)], fill=RED + (255,))
        for i, line in enumerate(lines):
            d.text((m + int(26 * u), y + i * int(64 * u)), line, font=f, fill=INK + (255,))
    lf = _font(int(24 * u), "Medium")
    label = CONCEPT_LABEL
    tw = d.textlength(label, font=lf)
    pad = int(14 * u)
    d.rounded_rectangle([m, m, m + tw + 2 * pad + int(8 * u), m + int(46 * u)], radius=int(8 * u), fill=BLACK + (200,))
    d.rectangle([m, m, m + int(5 * u), m + int(46 * u)], fill=RED + (255,))
    d.text((m + pad + int(8 * u), m + int(9 * u)), label, font=lf, fill=INK + (255,))
    if brand:
        bf = _font(int(26 * u), "Medium")
        d.text((w - m - d.textlength(brand, font=bf), h - m - int(30 * u)), brand, font=bf, fill=INK + (220,))
    return o


def card(w: int, h: int, title: str, subtitle: str, *, end: bool = False) -> Image.Image:
    u = min(w, h) / 1080
    img = Image.new("RGB", (w, h), BLACK)
    d = ImageDraw.Draw(img)
    for x in range(0, w, int(90 * u)):          # faint blueprint grid, as on the website
        d.line([(x, 0), (x, h)], fill=(30, 12, 13))
    for y in range(0, h, int(90 * u)):
        d.line([(0, y), (w, y)], fill=(30, 12, 13))
    m = int(110 * u)
    tf, sf = _font(int(84 * u), "Bold"), _font(int(36 * u), "Regular")
    lines = _wrap(d, title, tf, w - 2 * m)[:3]
    block = len(lines) * int(96 * u) + int(80 * u)
    y = (h - block) // 2
    d.rectangle([m, y - int(40 * u), m + int(90 * u), y - int(32 * u)], fill=RED)
    for i, line in enumerate(lines):
        d.text((m, y + i * int(96 * u)), line, font=tf, fill=INK)
    y += len(lines) * int(96 * u) + int(18 * u)
    for line in _wrap(d, subtitle, sf, w - 2 * m)[:3]:
        d.text((m, y), line, font=sf, fill=(163, 163, 173))
        y += int(48 * u)
    if end:
        lf = _font(int(26 * u), "Medium")
        d.text((m, h - m), f"Images are {CONCEPT_LABEL.lower()}.", font=lf, fill=(163, 163, 173))
    return img


def _motion(i: int, frames: int) -> tuple[str, str, str]:
    """Alternating gentle push-in, pan and pull-out, so the video feels like a camera moving."""
    n = max(frames - 1, 1)
    kind = i % 3
    if kind == 0:
        return f"1+0.10*on/{n}", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
    if kind == 1:
        return "1.12", f"(iw-iw/zoom)*on/{n}", "ih/2-(ih/zoom/2)"
    return f"1.12-0.10*on/{n}", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"


def _run(cmd: list[str], timeout: int, beat=lambda: None, every: float = 20.0) -> None:
    """Runs FFmpeg, calling beat() every few seconds so a long encode on a slow server still shows
    progress (and is not taken for a stuck job). If beat() raises (e.g. the job was cancelled),
    FFmpeg is stopped."""
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    waited = 0.0
    try:
        while True:
            try:
                _, err = proc.communicate(timeout=every)
                break
            except subprocess.TimeoutExpired:
                waited += every
                if waited >= timeout:
                    raise VideoFailed("The video took too long to make. Try fewer shots or shorter ones.")
                beat()
    except BaseException:
        proc.kill(); proc.communicate()
        raise
    if proc.returncode != 0:
        tail = (err or b"").decode(errors="replace")[-600:]
        raise VideoFailed("The video could not be made.") from RuntimeError(tail)


def make_video(shots: list[tuple[bytes, str]], *, fmt: str = "16:9", seconds: float = 5.0, title: str = "", subtitle: str = "",
               brand: str = "", progress=lambda stage: None) -> VideoResult:
    """shots: (image bytes, caption) in order. Returns an MP4."""
    if not shots:
        raise VideoFailed("Choose at least one rendered image for the video.")
    ff = ffmpeg_path()
    w, h = FORMATS[fmt]
    seconds = max(2.5, min(12.0, float(seconds)))
    with tempfile.TemporaryDirectory(prefix="ollic-video-") as tmp:
        t = Path(tmp)
        segments, lengths = [], []
        parts = [("card", card(w, h, title or "Walkthrough", subtitle), CARD_SECONDS)]
        parts += [("shot", (img, cap), seconds) for img, cap in shots]
        parts += [("card", card(w, h, "Thank you", subtitle or title, end=True), CARD_SECONDS)]
        for i, (kind, content, dur) in enumerate(parts):
            progress(f"Making clip {i + 1} of {len(parts)}")
            frames = int(round(dur * FPS))
            bg = t / f"bg{i}.png"
            if kind == "card":
                content.resize((int(w * 1.5), int(h * 1.5)), Image.Resampling.LANCZOS).save(bg)
                overlay = None
            else:
                data, cap = content
                try:
                    src = Image.open(io.BytesIO(data)); src.load()
                except Exception as exc:
                    raise VideoFailed("One of the rendered images could not be read.") from exc
                _cover(src, int(w * 1.5), int(h * 1.5)).save(bg)  # larger than the frame, so slow moves stay sharp
                overlay = t / f"cap{i}.png"
                caption(w, h, cap, brand).save(overlay)
            z, x, y = _motion(i if kind == "shot" else 0, frames)
            if kind == "card":
                z = f"1+0.03*on/{max(frames - 1, 1)}"
            chain = f"[0:v]zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={w}x{h}:fps={FPS},setsar=1"
            cmd = [ff, "-y", "-hide_banner", "-loglevel", "error", "-filter_threads", THREADS, "-filter_complex_threads", THREADS, "-threads", THREADS, "-i", str(bg)]
            if overlay:
                cmd += ["-threads", THREADS, "-i", str(overlay)]
                chain += "[bg];[bg][1:v]overlay=0:0"
            fades = f"fade=t=in:st=0:d={FADE},fade=t=out:st={dur - FADE:.3f}:d={FADE}"
            chain += f",{fades},format=yuv420p[v]"
            seg = t / f"seg{i}.mp4"
            cmd += ["-filter_complex", chain, "-map", "[v]", "-frames:v", str(frames), "-r", str(FPS),
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-profile:v", "high", "-level", "4.1", "-g", str(FPS * 2),
                    "-threads", THREADS, "-pix_fmt", "yuv420p", "-video_track_timescale", "15360", str(seg)]
            _run(cmd, timeout=900, beat=lambda: progress(f"Making clip {i + 1} of {len(parts)}"))
            segments.append(seg)
            lengths.append(frames / FPS)

        progress("Joining the clips")
        out = t / "walkthrough.mp4"
        listing = t / "clips.txt"
        listing.write_text("".join(f"file '{p.name}'\n" for p in segments))
        total = sum(lengths)
        cmd = [ff, "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing),
               "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v", "-map", "1:a", "-t", f"{total:.3f}",
               "-c:v", "copy", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(out)]
        _run(cmd, timeout=600, beat=lambda: progress("Joining the clips"))
        return VideoResult(data=out.read_bytes(), width=w, height=h, fps=FPS, duration_s=round(total, 2))


# ---------------------------------------------------------------- videos made in the browser
@dataclass
class Probe:
    codec: str
    width: int
    height: int
    duration_s: float
    pix_fmt: str
    fps: float


def probe(path: str | Path) -> Probe:
    """Reads an uploaded video with ffprobe. Raises VideoFailed if it is not a single-video MP4/WebM we can use."""
    fp = shutil.which("ffprobe")
    if not fp:
        raise VideoFailed("Video export is not available on this server yet.")
    try:
        res = subprocess.run([fp, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], capture_output=True, timeout=60)
    except subprocess.TimeoutExpired as exc:
        raise VideoFailed("The video could not be read.") from exc
    if res.returncode != 0:
        raise VideoFailed("That file is not a video Ollic can read.")
    import json as _json
    info = _json.loads(res.stdout or b"{}")
    fmt = (info.get("format") or {}).get("format_name", "")
    if not any(x in fmt for x in ("mp4", "mov", "webm", "matroska")):
        raise VideoFailed("That file is not an MP4 or WebM video.")
    vids = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
    if len(vids) != 1:
        raise VideoFailed("The video must have exactly one picture track.")
    v = vids[0]
    if v.get("codec_name") not in ("h264", "vp9", "vp8", "av1"):
        raise VideoFailed("The video is in a format Ollic does not accept.")
    try:
        num, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "30/1").split("/")
        fps = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        fps = 0.0
    dur = float((info.get("format") or {}).get("duration") or v.get("duration") or 0)
    return Probe(codec=v["codec_name"], width=int(v.get("width") or 0), height=int(v.get("height") or 0), duration_s=dur,
                 pix_fmt=v.get("pix_fmt") or "", fps=fps)


def finish_upload(src: str | Path, info: Probe, progress=lambda stage: None) -> bytes:
    """Makes a browser-made video phone- and WhatsApp-friendly: H.264 yuv420p with a silent AAC track and the index first.
    H.264 from the browser is only re-packaged (seconds); other codecs are converted on one thread (minutes on a small server)."""
    ff = ffmpeg_path()
    with tempfile.TemporaryDirectory(prefix="ollic-finish-") as tmp:
        out = Path(tmp) / "final.mp4"
        cmd = [ff, "-y", "-hide_banner", "-loglevel", "error", "-threads", THREADS, "-i", str(src), "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
               "-map", "0:v:0", "-map", "1:a", "-t", f"{info.duration_s:.3f}"]
        if info.codec == "h264" and info.pix_fmt == "yuv420p":
            progress("Packaging the video")
            cmd += ["-c:v", "copy"]
            beat = lambda: progress("Packaging the video")  # noqa: E731
        else:
            progress("Converting the video for phones")
            cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
                    "-threads", THREADS, "-filter_threads", THREADS]
            beat = lambda: progress("Converting the video for phones")  # noqa: E731
        cmd += ["-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(out)]
        _run(cmd, timeout=3600, beat=beat)
        return out.read_bytes()
