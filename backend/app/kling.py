"""Kling video, called directly (no reseller). Checked against Kling's API docs (new standard,
snapshot of kling.ai/document-api fetched 2026-09-20; endpoint and fields confirmed on 2026-10-22):

- Domain for servers outside China: https://api-singapore.klingai.com
- Auth: one API key, `Authorization: Bearer <API key>` (the legacy access/secret-key JWT is not used)
- Create: POST /image-to-video/kling-3.0 with `contents` (prompt, first_frame, optional last_frame;
  each frame as a URL or raw Base64 without a data: prefix; JPEG/PNG, >= 300 px a side, aspect
  1:2.5 to 2.5:1, <= 50 MB) and `settings` (resolution 720p/1080p/4k, duration 3-15 s, audio
  native/off, multi_shot). The video's shape follows the first frame.
- Status: GET /tasks?task_ids=<id> -> data[0].status submitted/processing/succeeded/failed,
  data[0].outputs[] {type: video, url, duration}, data[0].billing[]. Results are deleted after
  30 days, so they are saved straight away.
- Errors: code 1102 = resource pack used up or expired; 1301 = content policy; 1302/1303 = rate limits.

Customers never see the provider's name; messages here are neutral.
"""

from __future__ import annotations

import base64
import logging
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal

import httpx

log = logging.getLogger("ollic.kling")

# US$ per second, from Kling's price list (units x $0.14), 2026-09-20: (silent, with sound) per resolution
PRICES = {"720p": ("0.084", "0.126"), "1080p": ("0.112", "0.168"), "4k": ("0.42", "0.42")}
PRICE_SOURCE = "Kling API price list (kling.ai/document-api pricing, units at $0.14), checked 2026-10-22"


class VideoProviderError(Exception):
    """`message` is safe to show the customer."""

    def __init__(self, message: str, *, code: int | None = None, retry: bool = False):
        super().__init__(message)
        self.message, self.code, self.retry = message, code, retry


@dataclass
class ClipStatus:
    status: str                    # submitted, processing, succeeded, failed
    video_url: str | None = None
    duration: float | None = None
    message: str | None = None
    billing: list = field(default_factory=list)


def estimate_cost(resolution: str, seconds: int, audio: bool) -> Decimal:
    per = Decimal(PRICES.get(resolution, PRICES["720p"])[1 if audio else 0])
    return (per * seconds).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)


NEUTRAL = {
    1000: "The video service is not set up correctly. The owner has been told.",
    1001: "The video service is not set up correctly. The owner has been told.",
    1002: "The video service is not set up correctly. The owner has been told.",
    1100: "The video service account needs attention. The owner has been told.",
    1101: "The video service has run out of credit. The owner has been told.",
    1102: "The video service has run out of credit. The owner has been told.",
    1103: "The video service is not set up correctly. The owner has been told.",
    1301: "The video service refused these pictures (its content rules). Try other views.",
    1302: "The video service is busy. Try again in a minute.",
    1303: "The video service is busy. Try again in a minute.",
}


class KlingVideo:
    provider = "kling"

    def __init__(self, api_key: str, base_url: str = "https://api-singapore.klingai.com", model: str = "kling-3.0", client: httpx.Client | None = None):
        self.model = model
        self._http = client or httpx.Client(base_url=base_url, timeout=httpx.Timeout(120, connect=15))
        self._headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    def _check(self, res: httpx.Response) -> dict:
        try:
            body = res.json()
        except ValueError:
            body = {}
        code = body.get("code")
        if res.status_code >= 400 or (code not in (0, None)):
            code = int(code) if isinstance(code, (int, str)) and str(code).isdigit() else None
            log.warning("OWNER: Kling error http %s code %s: %s (request %s)", res.status_code, code, str(body.get("message"))[:300], body.get("request_id"))
            retry = res.status_code >= 500 or code in (1302, 1303, 5000, 5001, 5002)
            raise VideoProviderError(NEUTRAL.get(code, "The video could not be made this time. Try again later."), code=code, retry=retry)
        return body

    def create(self, *, first_frame: bytes, last_frame: bytes | None, prompt: str, seconds: int = 10, resolution: str = "720p",
               audio: bool = False, external_id: str | None = None) -> str:
        contents = [{"type": "prompt", "text": prompt[:2500]}, {"type": "first_frame", "url": base64.b64encode(first_frame).decode()}]
        if last_frame is not None:
            contents.append({"type": "last_frame", "url": base64.b64encode(last_frame).decode()})
        body = {"contents": contents,
                "settings": {"resolution": resolution, "duration": int(max(3, min(15, seconds))), "audio": "native" if audio else "off", "multi_shot": False},
                "options": {"watermark_info": {"enabled": False}, **({"external_task_id": external_id} if external_id else {})}}
        try:
            res = self._http.post(f"/image-to-video/{self.model}", json=body, headers=self._headers)
        except httpx.HTTPError as exc:
            raise VideoProviderError("Could not reach the video service. Try again in a moment.", retry=True) from exc
        data = self._check(res).get("data") or {}
        task = data.get("id") or data.get("task_id")
        if not task:
            raise VideoProviderError("The video service did not start the clip. Try again.")
        return str(task)

    def status(self, task_id: str) -> ClipStatus:
        try:
            res = self._http.get("/tasks", params={"task_ids": task_id}, headers=self._headers)
        except httpx.HTTPError as exc:
            raise VideoProviderError("Could not reach the video service.", retry=True) from exc
        data = self._check(res).get("data")
        item = (data[0] if isinstance(data, list) and data else data) or {}
        st = str(item.get("status") or item.get("task_status") or "processing").lower()
        st = "succeeded" if st == "succeed" else st
        vid = next((o for o in (item.get("outputs") or []) if o.get("type") == "video" and o.get("url")), None)
        if vid is None:   # the legacy shape, in case the account is still on it
            vid = next(iter((item.get("task_result") or {}).get("videos") or []), None)
        dur = None
        try:
            dur = float(vid.get("duration")) if vid and vid.get("duration") else None
        except (TypeError, ValueError):
            pass
        return ClipStatus(status=st, video_url=vid.get("url") if vid else None, duration=dur,
                          message=item.get("message") or item.get("task_status_msg"), billing=item.get("billing") or [])

    def download(self, url: str, limit: int = 300 * 1024 * 1024) -> bytes:
        try:
            with httpx.Client(timeout=httpx.Timeout(300, connect=20), follow_redirects=True) as c, c.stream("GET", url) as r:
                if r.status_code >= 400:
                    raise VideoProviderError("The finished clip could not be fetched. Try again.", retry=True)
                buf = bytearray()
                for chunk in r.iter_bytes():
                    buf += chunk
                    if len(buf) > limit:
                        raise VideoProviderError("The finished clip was too large to save.")
                return bytes(buf)
        except httpx.HTTPError as exc:
            raise VideoProviderError("The finished clip could not be fetched. Try again.", retry=True) from exc
