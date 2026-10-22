"""Cloudflare Workers AI image models, called only from the server (free daily allowance).

REST: POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}
FLUX.2 models take multipart form data: prompt, width, height (256-1920) and up to
four reference images, input_image_0..3, each smaller than 512x512. FLUX.2 [klein]
runs a fixed 4 steps. Checked against developers.cloudflare.com on 22 Oct 2026.
"""

from __future__ import annotations

import base64
import io
import logging
import math

import httpx
from PIL import Image

from .openai_images import ImageResult, ProviderError

log = logging.getLogger("ollic.cloudflare")

# Neurons per 512x512 tile for FLUX.2 [klein] 4B (input, output), and the list price
# beyond the free 10,000 neurons a day. Cloudflare's pricing page, 22 Oct 2026.
KLEIN_4B_NEURONS = (5.37, 26.05)
USD_PER_1000_NEURONS = 0.011
FREE_NEURONS_PER_DAY = 10_000
MAX_INPUT_SIDE = 504  # inputs must be under 512x512; keep a margin


def _tiles(w: int, h: int) -> int:
    return math.ceil(w / 512) * math.ceil(h / 512)


def shrink_for_input(data: bytes) -> tuple[bytes, int, int]:
    """Reference images must be under 512x512: scale down, keep the shape, send as PNG."""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    img.thumbnail((MAX_INPUT_SIDE, MAX_INPUT_SIDE), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue(), img.width, img.height


def estimate_neurons(out_w: int, out_h: int, inputs: list[tuple[int, int]]) -> float:
    n_in, n_out = KLEIN_4B_NEURONS
    return round(_tiles(out_w, out_h) * n_out + sum(_tiles(w, h) for w, h in inputs) * n_in, 2)


class CloudflareImages:
    provider = "cloudflare"

    def __init__(self, account_id: str, api_token: str, client: httpx.Client | None = None):
        if not account_id or not api_token:
            raise ValueError("Cloudflare account id and API token are required")
        self._path = f"/client/v4/accounts/{account_id}/ai/run/"
        self._http = client or httpx.Client(base_url="https://api.cloudflare.com", timeout=httpx.Timeout(180, connect=15))
        self._headers = {"Authorization": f"Bearer {api_token}"}

    def generate(self, *, model: str, prompt: str, size: str, quality: str, user_id: str) -> ImageResult:
        return self._run(model, prompt, size, [])

    def edit(self, *, model: str, prompt: str, images: list[tuple[bytes, str]], size: str, quality: str, user_id: str) -> ImageResult:
        return self._run(model, prompt, size, [d for d, _ in images])

    def _run(self, model: str, prompt: str, size: str, images: list[bytes]) -> ImageResult:
        w, h = (int(x) for x in size.split("x")) if "x" in size else (1024, 768)
        files, input_sizes = {}, []
        for i, data in enumerate(images[:4]):
            png, iw, ih = shrink_for_input(data)
            files[f"input_image_{i}"] = (f"input_{i}.png", png, "image/png")
            input_sizes.append((iw, ih))
        # (None, value) parts are plain form fields, so even a prompt-only request goes as
        # multipart/form-data, which the FLUX.2 models require.
        parts = {"prompt": (None, prompt[:2048]), "width": (None, str(w)), "height": (None, str(h)), **files}
        try:
            res = self._http.post(self._path + model, files=parts, headers=self._headers)
        except httpx.TimeoutException as exc:
            raise ProviderError("The image model took too long to answer. Try again.", code="timeout") from exc
        except httpx.HTTPError as exc:
            raise ProviderError("Could not reach the image model. Try again in a moment.", code="unreachable") from exc
        try:
            payload = res.json()
        except ValueError:
            payload = {}
        if res.status_code >= 400 or payload.get("success") is False:
            raise _error_from(res.status_code, payload)
        result = payload.get("result") if isinstance(payload.get("result"), dict) else payload
        try:
            data = base64.b64decode(result["image"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ProviderError("The image model returned no image. Try again.", code="empty_response", charged=True) from exc
        neurons = estimate_neurons(w, h, input_sizes)
        return ImageResult(data=data, output_format="jpeg", model=model, request_id=res.headers.get("cf-ray"),
                           usage={"estimated_neurons": neurons, "output_size": f"{w}x{h}", "input_images": [f"{a}x{b}" for a, b in input_sizes]})


def _error_from(status: int, payload: dict) -> ProviderError:
    errors = payload.get("errors") or []
    first = errors[0] if errors and isinstance(errors[0], dict) else {}
    code, text = first.get("code"), str(first.get("message") or "")
    log.warning("Cloudflare AI %s error %s: %s", status, code, text[:500])
    low = text.lower()
    if code == 4006 or "daily free allocation" in low or "neurons" in low and ("used up" in low or "exceeded" in low):
        msg = "Today's free render allowance is used up. It resets at 01:00 Lagos time (midnight UTC)."
        return ProviderError(msg, status=status, code="daily_allowance_used")
    if status in (401, 403) or code in (10000, 10001):
        return ProviderError("The server's Cloudflare token was refused. The owner needs to check CLOUDFLARE_API_TOKEN (Workers AI permission) and CLOUDFLARE_ACCOUNT_ID.", status=status, code="auth")
    if status == 429:
        return ProviderError("The image model is busy. Wait a minute and try again.", status=status, code="rate_limit")
    if "nsfw" in low or "safety" in low or "flagged" in low:
        return ProviderError("The image model declined this request under its content rules. Reword the description and try again.", status=status, code="moderation_blocked")
    if status >= 500:
        return ProviderError("The image model had a problem on its side. Try again in a moment.", status=status, code="server_error")
    return ProviderError("The image model rejected the request: " + (text or f"HTTP {status}")[:300], status=status, code=str(code) if code else None)


def cost_usd_estimate(usage: dict | None) -> float | None:
    if not usage or "estimated_neurons" not in usage:
        return None
    return round(usage["estimated_neurons"] * USD_PER_1000_NEURONS / 1000, 6)
