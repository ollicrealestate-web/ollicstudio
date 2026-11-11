"""BytePlus ModelArk (direct, ByteDance's own platform): Seedance 2.5 reference-to-video, shown as "Ollic Cinema".

The camera move recorded from the architect's model goes in as the reference video (the authority for camera,
framing and the building's layout); the approved renders of the first and last frame, and the look render if one
was chosen, go in as reference images; Claude's prompt says how to use them.

API (ModelArk docs, "Create a video generation task", read 2026-11-11):
  POST {base}/contents/generations/tasks   Authorization: Bearer <key>
    {"model": "dreamina-seedance-2-5-260628", "content": [
        {"type": "text", "text": ...},
        {"type": "video_url", "video_url": {"url": <public https>}, "role": "reference_video"},   # 2-30 s, 24-60 fps
        {"type": "image_url", "image_url": {"url": <https or data URI>}, "role": "reference_image"}, ...],   # 1-30 images
     "resolution": "720p", "ratio": "16:9", "duration": 4-30, "generate_audio": false, "watermark": false}
    -> {"id": "cgt-..."}
  GET {base}/contents/generations/tasks/{id}
    -> {"id", "model", "status": queued|running|succeeded|failed|cancelled|expired, "content": {"video_url"}, "error": {"code", "message"},
        "usage": {"completion_tokens", "total_tokens"}}
Reference images and videos cannot have real people's faces; frames from Ollic's own renders are allowed.
"""

from __future__ import annotations

import base64
import logging
from decimal import ROUND_HALF_UP, Decimal

import httpx

from .kling import ClipStatus, VideoProviderError

log = logging.getLogger("ollic.byteplus")

BASE = "https://ark.ap-southeast.bytepluses.com/api/v3"
SEEDANCE_MODEL = "dreamina-seedance-2-5-260628"
# Billed by tokens; with a video input $7.00 per million (third-party summary of the BytePlus price list, read 2026-11-11;
# confirm on the BytePlus console). Tokens ~ width x height x fps / 1024 per second, for the output and the reference video.
TOKEN_PRICE = Decimal("7.00") / Decimal(1_000_000)
PRICE_SOURCE = "BytePlus ModelArk Seedance 2.5 token price with video input, $7/M tokens (third-party summary, read 2026-11-11)"
NEUTRAL = {400: "The video service could not use these pictures. Try again or change the shot.",
           401: "The video service is not set up correctly. The owner has been told.",
           403: "The video service is not set up correctly. The owner has been told.",
           429: "The video service is busy. Try again in a minute."}


def estimate_cost(seconds: float, width: int = 1280, height: int = 720, fps: int = 24) -> Decimal:
    tokens = Decimal(width * height * fps) / 1024 * Decimal(str(seconds)) * 2     # the output, and the reference video as long
    return (tokens * TOKEN_PRICE).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def token_cost(tokens: int) -> Decimal:
    return (Decimal(tokens) * TOKEN_PRICE).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _data_uri(jpeg: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()


class SeedanceVideo:
    name = "byteplus"
    model = SEEDANCE_MODEL

    def __init__(self, api_key: str, model: str = SEEDANCE_MODEL, base: str = BASE, transport: httpx.BaseTransport | None = None):
        self.model = model
        self._http = httpx.Client(base_url=base, timeout=httpx.Timeout(60.0, connect=15.0), transport=transport,
                                  headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
        self.last_usage: dict = {}

    def _raise(self, res: httpx.Response):
        try:
            body = res.json()
        except ValueError:
            body = {}
        err = (body.get("error") or {}) if isinstance(body, dict) else {}
        code = res.status_code
        raise VideoProviderError(NEUTRAL.get(code, "The video could not be made this time. Try again later."), code=code,
                                 retry=code >= 500 or code == 429,
                                 owner_detail=f"BytePlus http {code} {err.get('code') or ''}: {str(err.get('message') or res.text)[:200]}")

    def film(self, *, guide_url: str, references: list[bytes], prompt: str, aspect: str = "16:9", seconds: int = 6) -> str:
        content = [{"type": "text", "text": prompt[:4000]},
                   {"type": "video_url", "video_url": {"url": guide_url}, "role": "reference_video"}]
        content += [{"type": "image_url", "image_url": {"url": _data_uri(img)}, "role": "reference_image"} for img in references[:6]]
        body = {"model": self.model, "content": content, "resolution": "720p", "ratio": aspect if aspect in ("16:9", "9:16", "1:1") else "adaptive",
                "duration": int(max(4, min(30, round(seconds)))), "generate_audio": False, "watermark": False}
        try:
            res = self._http.post("/contents/generations/tasks", json=body)
        except httpx.HTTPError as exc:
            raise VideoProviderError("Could not reach the video service. Try again in a moment.", retry=True) from exc
        if res.status_code >= 400:
            self._raise(res)
        return res.json()["id"]

    def status(self, task_id: str) -> ClipStatus:
        try:
            res = self._http.get(f"/contents/generations/tasks/{task_id}")
        except httpx.HTTPError as exc:
            raise VideoProviderError("Could not reach the video service. Try again in a moment.", retry=True) from exc
        if res.status_code >= 400:
            self._raise(res)
        d = res.json()
        s = d.get("status")
        self.last_usage = d.get("usage") or {}
        if s == "succeeded":
            return ClipStatus("succeeded", video_url=(d.get("content") or {}).get("video_url"))
        if s in ("failed", "cancelled", "expired"):
            err = d.get("error") or {}
            return ClipStatus("failed", message=f"{err.get('code') or s}: {err.get('message') or ''}"[:300])
        return ClipStatus("processing")

    def cancel(self, task_id: str) -> None:
        try:
            self._http.delete(f"/contents/generations/tasks/{task_id}")
        except httpx.HTTPError:
            pass

    def download(self, url: str, limit: int = 300 * 1024 * 1024) -> bytes:
        try:
            with httpx.stream("GET", url, timeout=120, follow_redirects=True) as r:
                r.raise_for_status()
                out = bytearray()
                for chunk in r.iter_bytes():
                    out += chunk
                    if len(out) > limit:
                        raise VideoProviderError("The finished clip was too large.")
                return bytes(out)
        except httpx.HTTPError as exc:
            raise VideoProviderError("The finished clip could not be fetched. Try again.", retry=True) from exc
