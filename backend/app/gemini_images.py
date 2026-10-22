"""Google Gemini API, called directly, for Nano Banana images (used for the construction
animation's line drawings). Interactions API as documented at ai.google.dev/gemini-api/docs/
image-generation (read 2026-10-22):

POST https://generativelanguage.googleapis.com/v1beta/interactions, header x-goog-api-key,
body {"model", "input": [{"type": "text", "text"}, {"type": "image", "mime_type", "data" (base64)}],
"response_format": {"type": "image", "mime_type", "aspect_ratio", "image_size": "1K"|"2K"|"4K"}}.
The image comes back as base64 in an image block (steps[].content[] with type "image"); the parser
also accepts the older generateContent shape (candidates[].content.parts[].inlineData), so a
change of response layout does not break it silently.
"""

from __future__ import annotations

import base64
import logging
from decimal import Decimal

import httpx

from .openai_images import ImageResult, ProviderError

log = logging.getLogger("ollic.gemini")

# US$ per output image by size, Gemini API price list (via BenchLM, read 2026-10-13)
PRICES = {"gemini-nano-banana-2.1": {"1K": "0.0336", "2K": "0.0504", "4K": "0.0756"},
          "gemini-3-pro-image": {"1K": "0.134", "2K": "0.134", "4K": "0.24"}}
PRICE_SOURCE = "Gemini API image prices (ai.google.dev pricing via BenchLM), read 2026-10-13"
ASPECT = {"1536x1024": "3:2", "1024x1536": "2:3", "1024x1024": "1:1", "landscape": "3:2", "portrait": "2:3", "square": "1:1"}


def cost_usd(model: str, size: str = "2K") -> Decimal | None:
    p = PRICES.get(model, {}).get(size)
    return Decimal(p) if p else None


def _find_image(node, found=None):
    """The last image in the response, wherever the API put it."""
    if isinstance(node, dict):
        if node.get("type") == "image" and isinstance(node.get("data"), str) and len(node["data"]) > 100:
            found = node["data"]
        for k in ("inlineData", "inline_data"):
            v = node.get(k)
            if isinstance(v, dict) and isinstance(v.get("data"), str) and len(v["data"]) > 100:
                found = v["data"]
        for k, v in node.items():
            if k not in ("inlineData", "inline_data"):
                found = _find_image(v, found)
    elif isinstance(node, list):
        for v in node:
            found = _find_image(v, found)
    return found


class GeminiImages:
    provider = "google"

    def __init__(self, api_key: str, client: httpx.Client | None = None):
        self._http = client or httpx.Client(base_url="https://generativelanguage.googleapis.com", timeout=httpx.Timeout(180, connect=15))
        self._headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}

    def _run(self, model: str, prompt: str, images: list[tuple[bytes, str]], size: str) -> ImageResult:
        inputs = [{"type": "text", "text": prompt}]
        inputs += [{"type": "image", "mime_type": mime, "data": base64.b64encode(data).decode()} for data, mime in images]
        body = {"model": model, "input": inputs,
                "response_format": {"type": "image", "mime_type": "image/jpeg", "aspect_ratio": ASPECT.get(size, "3:2"), "image_size": "2K"}}
        try:
            res = self._http.post("/v1beta/interactions", json=body, headers=self._headers)
        except httpx.HTTPError as exc:
            raise ProviderError("Could not reach the image service. Try again in a moment.") from exc
        try:
            payload = res.json()
        except ValueError:
            payload = {}
        if res.status_code >= 400:
            err = (payload.get("error") or {}) if isinstance(payload, dict) else {}
            log.warning("OWNER: Gemini error %s: %s", res.status_code, str(err.get("message"))[:300])
            msg = ("The image service has run out of credit. The owner has been told." if res.status_code in (402, 429) and "quota" in str(err).lower()
                   else "The image service refused this request. Try again." if res.status_code == 400 else "The image service is not available right now. Try again later.")
            raise ProviderError(msg, status=res.status_code)
        data = _find_image(payload)
        if not data:
            log.warning("OWNER: Gemini returned no image; keys %s", list(payload)[:10] if isinstance(payload, dict) else type(payload))
            raise ProviderError("The image service returned no picture. Try again, or describe it differently.")
        usage = payload.get("usage") or payload.get("usageMetadata") or payload.get("usage_metadata")
        return ImageResult(data=base64.b64decode(data), output_format="jpeg", model=model, usage=usage, request_id=payload.get("id"))

    def edit(self, *, model: str, prompt: str, images: list[tuple[bytes, str]], size: str = "1536x1024", quality: str | None = None, user_id: str | None = None) -> ImageResult:
        return self._run(model, prompt, images, size)

    def generate(self, *, model: str, prompt: str, size: str = "1536x1024", quality: str | None = None, user_id: str | None = None) -> ImageResult:
        return self._run(model, prompt, [], size)
