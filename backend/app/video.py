"""FFmpeg on Ollic's own server: checks the animation videos made in the browser and makes them
play everywhere (Chrome, Safari, Android, iPhone and WhatsApp): H.264 High, yuv420p, an AAC track,
and the index at the front of the file (faststart). No AI service is involved.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

FORMATS = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)}
# FFmpeg sizes its thread pool from the host's CPU count, not the slice a small server is given;
# each thread holds frames, so on a 512 MB instance on a big host it ran out of memory. One thread
# keeps a 1080p clip near 180 MB; set FFMPEG_THREADS higher on a larger server.
THREADS = str(max(1, int(os.environ.get("FFMPEG_THREADS", "1") or 1)))


class VideoFailed(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def ffmpeg_path() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise VideoFailed("Video export is not available on this server yet.")
    return path


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
