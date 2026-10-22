"""OpenAI Image API, called only from the server (brief Module C).

Uses the JSON form of /v1/images/generations and /v1/images/edits. Reference and
base images are sent as base64 data URLs, so nothing in storage is ever made public.
Model names and parameters were checked against developers.openai.com on 22 Oct 2026.
"""

from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass, field

import logging

import httpx

log = logging.getLogger("ollic.openai")

SIZES = {"landscape": "1536x1024", "portrait": "1024x1536", "square": "1024x1024"}


class ProviderError(Exception):
    """The image provider refused or failed the request. `message` is safe to show the user."""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None, charged: bool = False):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.charged = charged


@dataclass
class ImageResult:
    data: bytes
    output_format: str
    model: str
    usage: dict | None
    request_id: str | None = None
    extra: dict = field(default_factory=dict)


def safety_identifier(user_id: str) -> str:
    """OpenAI asks for a stable per-user id for abuse monitoring; a hash keeps the real id private."""
    return hashlib.sha256(f"ollic:{user_id}".encode()).hexdigest()[:64]


def _data_url(data: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


class OpenAIImages:
    def __init__(self, api_key: str, base_url: str = "https://api.openai.com/v1", client: httpx.Client | None = None):
        if not api_key:
            raise ValueError("OpenAI API key is required")
        self._http = client or httpx.Client(base_url=base_url, timeout=httpx.Timeout(300, connect=15))
        self._headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    def generate(self, *, model: str, prompt: str, size: str, quality: str, user_id: str) -> ImageResult:
        body = {"model": model, "prompt": prompt, "n": 1, "size": size, "quality": quality,
                "output_format": "jpeg", "output_compression": 92, "safety_identifier": safety_identifier(user_id)}
        return self._post("/images/generations", body, model)

    def edit(self, *, model: str, prompt: str, images: list[tuple[bytes, str]], size: str, quality: str, user_id: str) -> ImageResult:
        body = {"model": model, "prompt": prompt, "n": 1, "size": size, "quality": quality,
                "images": [{"image_url": _data_url(d, m)} for d, m in images],
                "output_format": "jpeg", "output_compression": 92, "safety_identifier": safety_identifier(user_id)}
        return self._post("/images/edits", body, model)

    def _post(self, path: str, body: dict, model: str) -> ImageResult:
        try:
            res = self._http.post(path, json=body, headers=self._headers)
        except httpx.TimeoutException as exc:
            raise ProviderError("The image model took too long to answer. Try again.", code="timeout") from exc
        except httpx.HTTPError as exc:
            raise ProviderError("Could not reach the image model. Try again in a moment.", code="unreachable") from exc
        request_id = res.headers.get("x-request-id")
        if res.status_code >= 400:
            raise _error_from(res)
        try:
            payload = res.json()
            item = payload["data"][0]
            data = base64.b64decode(item["b64_json"])
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderError("The image model returned no image. Try again.", code="empty_response", charged=True) from exc
        return ImageResult(data=data, output_format=payload.get("output_format") or "jpeg", model=model,
                           usage=payload.get("usage"), request_id=request_id,
                           extra={k: payload.get(k) for k in ("quality", "size", "background") if payload.get(k)})


def _error_from(res: httpx.Response) -> ProviderError:
    try:
        err = res.json().get("error") or {}
    except ValueError:
        err = {}
    # OpenAI's error text names limits and models, never the key; keep it in the logs for the owner.
    log.warning("OpenAI %s error %s: %s", res.status_code, err.get("code") or err.get("type"), str(err.get("message"))[:500])
    code = err.get("code") or err.get("type") or ""
    status = res.status_code
    if code == "moderation_blocked" or "safety" in str(err.get("message", "")).lower():
        msg = "The image model declined this request under its content rules. Reword the description and try again."
    elif status == 401:
        msg = "The server's OpenAI key was refused. The owner needs to check OPENAI_API_KEY."
    elif status == 403:
        msg = "The server's OpenAI key is not allowed to use this image model. The owner needs to check the key's permissions or the organisation's verification."
    elif status == 429 and code == "insufficient_quota":
        msg = "The OpenAI account has run out of credit. The owner needs to add credit at platform.openai.com."
    elif status == 429:
        detail = str(err.get("message") or "")[:240]
        msg = "The image model refused for now (rate limit). Wait a minute and try again." + (f" OpenAI said: {detail}" if detail else "")
    elif status == 404 or code == "model_not_found":
        msg = "The configured image model is not available to this OpenAI account."
    elif status >= 500:
        msg = "The image model had a problem on its side. Try again in a moment."
    else:
        msg = "The image model rejected the request: " + (str(err.get("message")) or f"HTTP {status}")[:300]
    return ProviderError(msg, status=status, code=code or None)
