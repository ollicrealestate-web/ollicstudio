"""Runway API (direct): video-to-video. Turns Ollic's exact guide video of the architect's model
(a clay render along the camera path) into a photoreal video that keeps the camera move and the
building's shapes. Shown to customers as "Ollic Path" (Aleph 2) and "Ollic Path Plus" (Kling O3).

Checked against Runway's developer docs and official SDK types (October 2026):
  POST https://api.dev.runwayml.com/v1/video_to_video, headers Authorization: Bearer <key> and
  X-Runway-Version: 2024-11-06.
  aleph2: videoUri (HTTPS URL up to 32 MB, 2-30 s, <= 30 fps, output keeps the input size up to
  1080p), promptText, keyframes [{uri, seconds}] (up to 5 timed guidance images), seed.
  klingO3_pro / klingO3_standard: promptVideo (<= 10 s, sides 720-3840 px), promptText,
  references [{uri, position: "first" | "last"}] (up to 4).
  GET /v1/tasks/{id}: status PENDING, THROTTLED, RUNNING, SUCCEEDED (output: [url]), FAILED
  (failure, failureCode) or CANCELLED. DELETE /v1/tasks/{id} cancels.
  Price: $0.01 a credit; aleph2 28 credits a second of output (56 minimum); klingO3_pro 17,
  klingO3_standard 13 credits a second of input video.
"""

from __future__ import annotations

import base64
import logging
from decimal import Decimal

import httpx

from .kling import ClipStatus, VideoProviderError

log = logging.getLogger("ollic.runway")
BASE_URL = "https://api.dev.runwayml.com/v1"
VERSION = "2024-11-06"
PRICE_SOURCE = "docs.dev.runwayml.com/guides/pricing, $0.01 a credit (checked 24 Oct 2026)"
CREDITS = {"aleph2": (28, 56), "klingO3_pro": (17, 0), "klingO3_standard": (13, 0)}   # per second, minimum
MAX_SECONDS = {"aleph2": 30, "klingO3_pro": 10, "klingO3_standard": 10}


def cost(model: str, seconds: float) -> Decimal:
    per, minimum = CREDITS[model]
    return (Decimal(max(minimum, round(per * seconds))) * Decimal("0.01")).quantize(Decimal("0.01"))


def image_uri(data: bytes, mime: str = "image/jpeg") -> str:
    return f"data:{mime};base64," + base64.b64encode(data).decode()


class RunwayVideo:
    provider = "runway"

    def __init__(self, api_key: str, base_url: str = BASE_URL, client: httpx.Client | None = None):
        self._http = client or httpx.Client(base_url=base_url, timeout=httpx.Timeout(120, connect=15))
        self._headers = {"Authorization": f"Bearer {api_key}", "X-Runway-Version": VERSION, "Content-Type": "application/json"}

    def _json(self, res: httpx.Response) -> dict:
        try:
            body = res.json()
        except ValueError:
            body = {}
        if res.status_code < 400:
            return body
        detail = str(body.get("error") or body.get("message") or res.text)[:300]
        log.warning("OWNER: Runway error %s: %s", res.status_code, detail)
        if res.status_code in (401, 403):
            raise VideoProviderError("The video service is not set up correctly. The owner has been told.", code=res.status_code)
        if res.status_code == 429:
            raise VideoProviderError("The video service is busy. Try again in a few minutes.", code=429, retry=True)
        if res.status_code >= 500:
            raise VideoProviderError("The video service is having a problem. Try again later.", code=res.status_code, retry=True)
        if "credit" in detail.lower():
            raise VideoProviderError("The video service has no credit left. The owner has been told.", code=res.status_code)
        raise VideoProviderError("The video service could not take this camera move. Try a shorter or simpler move.", code=res.status_code)

    def video_to_video(self, *, model: str, video_url: str, prompt: str, first_frame: bytes | None = None, seed: int | None = None) -> str:
        if model == "aleph2":
            body = {"model": model, "videoUri": video_url, "promptText": prompt[:1000]}
            if first_frame:
                body["keyframes"] = [{"uri": image_uri(first_frame), "seconds": 0}]
        elif model in ("klingO3_pro", "klingO3_standard"):
            body = {"model": model, "promptVideo": video_url, "promptText": prompt[:2500]}
            if first_frame:
                body["references"] = [{"uri": image_uri(first_frame), "position": "first"}]
        else:
            raise ValueError(f"unknown video-to-video model {model}")
        if seed is not None:
            body["seed"] = int(seed)
        try:
            res = self._http.post("/video_to_video", json=body, headers=self._headers)
        except httpx.HTTPError as exc:
            raise VideoProviderError("Could not reach the video service. Try again.", retry=True) from exc
        out = self._json(res)
        if not out.get("id"):
            raise VideoProviderError("The video service did not accept the request. Try again.")
        return str(out["id"])

    def status(self, task_id: str) -> ClipStatus:
        try:
            res = self._http.get(f"/tasks/{task_id}", headers=self._headers)
        except httpx.HTTPError as exc:
            raise VideoProviderError("Could not reach the video service.", retry=True) from exc
        t = self._json(res)
        s = t.get("status")
        if s == "SUCCEEDED":
            out = t.get("output") or []
            return ClipStatus("succeeded", video_url=out[0] if out else None)
        if s in ("FAILED", "CANCELLED"):
            return ClipStatus("failed", message=f"{t.get('failureCode') or s}: {t.get('failure') or ''}"[:300])
        return ClipStatus("processing")

    def cancel(self, task_id: str) -> None:
        try:
            self._http.delete(f"/tasks/{task_id}", headers=self._headers)
        except httpx.HTTPError:
            pass

    def download(self, url: str, limit: int = 300 * 1024 * 1024) -> bytes:
        try:
            with httpx.stream("GET", url, timeout=httpx.Timeout(300, connect=20), follow_redirects=True) as r:
                if r.status_code >= 400:
                    raise VideoProviderError("The finished video could not be fetched. Try again.", retry=True)
                buf = bytearray()
                for chunk in r.iter_bytes():
                    buf += chunk
                    if len(buf) > limit:
                        raise VideoProviderError("The finished video is too large.")
                return bytes(buf)
        except httpx.HTTPError as exc:
            raise VideoProviderError("The finished video could not be fetched. Try again.", retry=True) from exc
