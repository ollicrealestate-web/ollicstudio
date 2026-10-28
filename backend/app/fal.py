"""fal.ai, behind the "Ollic VS" option (images and video). Checked against fal's docs on 2026-10-23:

- Queue API: POST https://queue.fal.run/<endpoint> with header `Authorization: Key <FAL_KEY>` and the
  model's JSON input -> {request_id, status_url, response_url, cancel_url}. Status and result URLs use
  only the owner/app part of the endpoint (e.g. bytedance/seedance-2.0), so the URLs fal returns are
  used as they are. GET status_url -> status IN_QUEUE / IN_PROGRESS / COMPLETED (with `error` when it
  failed); GET response_url -> the model's output. Output media links expire, so files are saved at once.
- Images: fal-ai/flux-pro/kontext (prompt + image_url), .../kontext/multi (image_urls), and
  .../kontext/text-to-image; $0.04 an image. Output: images[].url.
- Video: bytedance/seedance-2.0/image-to-video (prompt, image_url, end_image_url, resolution
  480p/720p/1080p, duration "4".."15", aspect_ratio, generate_audio). Output: video.url.
  $0.3034 a second at 720p, $0.682 at 1080p.
- File inputs are sent as base64 data URIs (small JPEGs).

Customers never see the provider's name; messages here are neutral; details go to the log as OWNER.
"""

from __future__ import annotations

import base64
import io
import logging
import time
from decimal import ROUND_HALF_UP, Decimal

import httpx
from PIL import Image

from .kling import ClipStatus, VideoProviderError
from .openai_images import ImageResult, ProviderError

log = logging.getLogger("ollic.fal")
QUEUE = "https://queue.fal.run"

IMAGE_EDIT = "fal-ai/flux-pro/kontext"
IMAGE_MULTI = "fal-ai/flux-pro/kontext/multi"
IMAGE_TEXT = "fal-ai/flux-pro/kontext/text-to-image"
IMAGE_PRICE = Decimal("0.04")
# Ollic Exact: FLUX with the depth control LoRA; the depth map is the model's own (preprocess_depth false).
# Input per fal's published client types (fal-ai/fal-js endpoints.ts, DepthLoraInput), read 2026-10-24:
# prompt, control_lora_image_url, control_lora_strength, preprocess_depth, image_size {width, height},
# num_inference_steps, guidance_scale, output_format. No list price was found: about $0.04 is an estimate.
EXACT_MODEL = "fal-ai/flux-control-lora-depth"
# Guided by the model's line drawing (white lines on black, like a Canny edge map): every floor edge, opening and
# balcony is in the guide, which a depth map of a flat facade does not carry. Same input shape as the depth model.
EXACT_LINES_MODEL = "fal-ai/flux-control-lora-canny"
EXACT_SIZES = {"1536x1024": (1536, 1024), "1024x1536": (1024, 1536), "1024x1024": (1024, 1024)}
VIDEO_MODEL = "bytedance/seedance-2.0/image-to-video"
VIDEO_PRICES = {"720p": Decimal("0.3034"), "1080p": Decimal("0.682")}
PRICE_SOURCE = "fal.ai model pages (Flux Kontext Pro $0.04 an image; Seedance 2.0 per second), read 2026-10-23"
ASPECT = {"1536x1024": "3:2", "1024x1536": "2:3", "1024x1024": "1:1", "landscape": "3:2", "portrait": "2:3", "square": "1:1"}


def video_cost(resolution: str, seconds: int) -> Decimal:
    return (VIDEO_PRICES.get(resolution, VIDEO_PRICES["720p"]) * seconds).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)


def data_uri(data: bytes, mime: str = "image/jpeg", max_side: int = 2048) -> str:
    """A compact JPEG data URI (large pictures are scaled down so the request stays small)."""
    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
        if max(img.size) > max_side:
            img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
        buf = io.BytesIO(); img.save(buf, "JPEG", quality=90)
        data, mime = buf.getvalue(), "image/jpeg"
    except Exception:
        pass
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


class _Fal:
    def __init__(self, api_key: str, client: httpx.Client | None = None):
        self._http = client or httpx.Client(timeout=httpx.Timeout(120, connect=15), follow_redirects=True)
        self._headers = {"Authorization": f"Key {api_key}", "Content-Type": "application/json"}

    def _json(self, res: httpx.Response, kind: str) -> dict:
        try:
            body = res.json()
        except ValueError:
            body = {}
        if res.status_code >= 400:
            detail = body.get("detail") if isinstance(body, dict) else None
            log.warning("OWNER: fal %s error http %s: %s", kind, res.status_code, str(detail)[:400])
            raise _Failed(res.status_code, str(detail))
        return body if isinstance(body, dict) else {}

    def submit(self, endpoint: str, body: dict) -> dict:
        res = self._http.post(f"{QUEUE}/{endpoint}", json=body, headers=self._headers)
        out = self._json(res, "submit")
        if not out.get("request_id"):
            raise _Failed(502, "no request id")
        return out

    def get(self, url: str, kind: str) -> dict:
        return self._json(self._http.get(url, headers=self._headers), kind)

    def fetch(self, url: str, limit: int) -> bytes:
        with httpx.Client(timeout=httpx.Timeout(300, connect=20), follow_redirects=True) as c, c.stream("GET", url) as r:
            if r.status_code >= 400:
                raise _Failed(r.status_code, "download")
            buf = bytearray()
            for chunk in r.iter_bytes():
                buf += chunk
                if len(buf) > limit:
                    raise _Failed(413, "too large")
            return bytes(buf)


class _Failed(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


def _neutral(status: int, what: str) -> str:
    if status in (401, 403):
        return f"The {what} service is not set up correctly. The owner has been told."
    if status == 402:
        return f"The {what} service has run out of credit. The owner has been told."
    if status == 422:
        return f"The {what} service refused these pictures. Try other views."
    if status == 429:
        return f"The {what} service is busy. Try again in a minute."
    return f"The {what} could not be made this time. Try again later."


class FalImages(_Fal):
    """Same shape as the other image clients (edit / generate), so renders use it unchanged."""
    provider = "fal"
    poll_seconds = 1.5
    max_wait = 240

    def _run(self, prompt: str, images: list[tuple[bytes, str]], size: str) -> ImageResult:
        body = {"prompt": prompt[:4000], "aspect_ratio": ASPECT.get(size, "3:2"), "output_format": "jpeg", "num_images": 1, "safety_tolerance": "2"}
        if len(images) == 1:
            endpoint, body["image_url"] = IMAGE_EDIT, data_uri(*images[0])
        elif images:
            endpoint, body["image_urls"] = IMAGE_MULTI, [data_uri(d, m, 1536) for d, m in images[:4]]
        else:
            endpoint = IMAGE_TEXT
        return self._image(endpoint, body)

    def _image(self, endpoint: str, body: dict) -> ImageResult:
        try:
            sub = self.submit(endpoint, body)
            started = time.monotonic()
            while True:
                st = self.get(sub["status_url"], "image status")
                if st.get("status") == "COMPLETED":
                    break
                if time.monotonic() - started > self.max_wait:
                    raise ProviderError("The image service took too long. Try again.")
                time.sleep(self.poll_seconds)
            if st.get("error"):
                log.warning("OWNER: fal image failed: %s %s", st.get("error_type"), str(st.get("error"))[:300])
                raise ProviderError("The image service could not make this picture. Try describing it differently.")
            out = self.get(sub["response_url"], "image result")
            url = next((i.get("url") for i in out.get("images") or [] if i.get("url")), None)
            if not url:
                raise ProviderError("The image service returned no picture. Try again.")
            if url.startswith("data:"):
                data = base64.b64decode(url.split(",", 1)[1])
            else:
                data = self.fetch(url, 50 * 1024 * 1024)
        except _Failed as exc:
            raise ProviderError(_neutral(exc.status, "image"), status=exc.status, owner_detail=f"http {exc.status}: {exc.detail}"[:400]) from exc
        except httpx.HTTPError as exc:
            raise ProviderError("Could not reach the image service. Try again in a moment.") from exc
        return ImageResult(data=data, output_format="jpeg", model=endpoint, usage={"images": 1}, request_id=sub.get("request_id"))

    def edit(self, *, model: str, prompt: str, images: list[tuple[bytes, str]], size: str = "1536x1024", quality: str | None = None, user_id: str | None = None) -> ImageResult:
        return self._run(prompt, images, size)

    def generate(self, *, model: str, prompt: str, size: str = "1536x1024", quality: str | None = None, user_id: str | None = None) -> ImageResult:
        return self._run(prompt, [], size)


class FalExact(FalImages):
    guide = "depth"     # "depth" (the model's depth map) or "lines" (the model's line drawing)
    strength = 1.0      # how strictly the guide is followed

    """Ollic Exact: the first picture given is the model's guide from the same camera: its line drawing
    (guide "lines", white on black) or its depth map (guide "depth", white near, black far); the picture is generated on that exact depth, so the geometry and the camera
    come from the model and the AI only adds materials, light and setting."""

    def edit(self, *, model: str, prompt: str, images: list[tuple[bytes, str]], size: str = "1536x1024", quality: str | None = None, user_id: str | None = None) -> ImageResult:
        if not images:
            raise ProviderError("Ollic Exact needs a view of your model. Capture the view again.")
        w, h = EXACT_SIZES.get(size, (1536, 1024))
        depth = data_uri(images[0][0], images[0][1], max(w, h))
        body = {"prompt": prompt[:4000], "control_lora_image_url": depth, "control_lora_strength": self.strength,
                "image_size": {"width": w, "height": h}, "num_inference_steps": 28, "guidance_scale": 3.5, "num_images": 1,
                "output_format": "jpeg", "enable_safety_checker": True}
        endpoint = EXACT_LINES_MODEL if self.guide == "lines" else EXACT_MODEL
        if endpoint == EXACT_MODEL:
            body["preprocess_depth"] = False
        out = self._image(endpoint, body)
        out.model = endpoint
        return out

    def generate(self, *, model: str, prompt: str, size: str = "1536x1024", quality: str | None = None, user_id: str | None = None) -> ImageResult:
        raise ProviderError("Ollic Exact renders from your model. Capture a view of the model first.")


class FalGemini(FalImages):
    """Google's image models (Nano Banana Pro = Gemini 3 Pro Image; Nano Banana 2) served by fal, so Ollic Ultra
    and Swift work with the fal key alone. Input per fal's client types (NanoBananaProEditInput): prompt,
    image_urls (several pictures at once), aspect_ratio, resolution 1K/2K/4K, output_format, num_images.
    Prices are estimates (fal's model pages list them per image; 4K costs more)."""

    def __init__(self, api_key: str, endpoint: str, price: str, client: httpx.Client | None = None):
        super().__init__(api_key, client)
        self.endpoint, self.model_name, self.price = endpoint, endpoint, Decimal(price)

    def _run(self, prompt: str, images: list[tuple[bytes, str]], size: str) -> ImageResult:
        body = {"prompt": prompt[:6000], "aspect_ratio": ASPECT.get(size, "3:2"), "resolution": "2K", "output_format": "jpeg", "num_images": 1}
        endpoint = self.endpoint
        if images:
            body["image_urls"] = [data_uri(d, m, 2048) for d, m in images[:6]]
        else:
            endpoint = endpoint.removesuffix("/edit")
        out = self._image(endpoint, body)
        out.extra = {"cost_usd": str(self.price), "price_source": f"fal.ai model page for {self.endpoint} (estimate at 2K), read 2026-10-24"}
        return out


class FalVideo(_Fal):
    """Same shape as the Kling client (create / status / download), so clips use it unchanged.
    The task id is "<request_id>|<status_url>|<response_url>", so polling survives a restart."""
    provider = "fal"
    model = VIDEO_MODEL

    def create(self, *, first_frame: bytes, last_frame: bytes | None, prompt: str, seconds: int = 10, resolution: str = "720p",
               audio: bool = False, external_id: str | None = None, aspect: str = "auto") -> str:
        body = {"prompt": prompt[:2500], "image_url": data_uri(first_frame), "resolution": resolution,
                "duration": str(int(max(4, min(15, seconds)))), "aspect_ratio": aspect, "generate_audio": bool(audio)}
        if last_frame is not None:
            body["end_image_url"] = data_uri(last_frame)
        if external_id:
            body["end_user_id"] = external_id[:64]
        try:
            sub = self.submit(VIDEO_MODEL, body)
        except _Failed as exc:
            raise VideoProviderError(_neutral(exc.status, "video"), code=exc.status, retry=exc.status >= 500 or exc.status == 429,
                                     owner_detail=f"fal http {exc.status}: {str(exc.detail)[:200]}") from exc
        except httpx.HTTPError as exc:
            raise VideoProviderError("Could not reach the video service. Try again in a moment.", retry=True) from exc
        return f"{sub['request_id']}|{sub['status_url']}|{sub['response_url']}"

    def status(self, task_id: str) -> ClipStatus:
        _, status_url, response_url = task_id.split("|", 2)
        try:
            st = self.get(status_url, "video status")
            if st.get("status") != "COMPLETED":
                return ClipStatus(status="processing")
            if st.get("error"):
                return ClipStatus(status="failed", message=f"{st.get('error_type')}: {str(st.get('error'))[:300]}")
            out = self.get(response_url, "video result")
        except _Failed as exc:
            if exc.status == 422:      # fal reports a failed generation on the result URL
                return ClipStatus(status="failed", message=exc.detail[:300])
            raise VideoProviderError(_neutral(exc.status, "video"), code=exc.status, retry=exc.status >= 500 or exc.status == 429,
                                     owner_detail=f"fal http {exc.status}: {str(exc.detail)[:200]}") from exc
        except httpx.HTTPError as exc:
            raise VideoProviderError("Could not reach the video service.", retry=True) from exc
        url = (out.get("video") or {}).get("url")
        return ClipStatus(status="succeeded" if url else "failed", video_url=url, message=None if url else "no video in result")

    def download(self, url: str, limit: int = 300 * 1024 * 1024) -> bytes:
        try:
            return self.fetch(url, limit)
        except (_Failed, httpx.HTTPError) as exc:
            raise VideoProviderError("The finished clip could not be fetched. Try again.", retry=True) from exc


DEPTH_VIDEO_MODEL = "fal-ai/wan-22-vace-fun-a14b/depth"
DEPTH_VIDEO_PRICE = Decimal("0.10")   # a second at 720p, fal model page (wan-22-vace-fun-a14b), read 2026-10-26
DEPTH_VIDEO_SOURCE = "fal.ai model page: wan-22-vace-fun-a14b $0.10 per video second at 720p, read 2026-10-26"


class FalDepthVideo(FalVideo):
    """Ollic Path Exact: the video follows the model's own depth along the camera path (video_url, already a
    depth video: preprocess off), with its first and last frames pinned to approved renders. Input per fal's
    client types (WanVace14bPoseInput, shared by the VACE depth endpoints); output video.url."""
    model = DEPTH_VIDEO_MODEL

    def film(self, *, depth_video_url: str, first_frame: bytes, last_frame: bytes | None, prompt: str, aspect: str = "16:9") -> str:
        body = {"prompt": prompt[:2500], "video_url": depth_video_url, "first_frame_url": data_uri(first_frame), "preprocess": False,
                "match_input_num_frames": True, "match_input_frames_per_second": True, "resolution": "720p",
                "aspect_ratio": aspect if aspect in ("16:9", "9:16", "1:1") else "auto", "video_quality": "high",
                "enable_safety_checker": True}
        if last_frame is not None:
            body["last_frame_url"] = data_uri(last_frame)
        try:
            sub = self.submit(DEPTH_VIDEO_MODEL, body)
        except _Failed as exc:
            raise VideoProviderError(_neutral(exc.status, "video"), code=exc.status, retry=exc.status >= 500 or exc.status == 429,
                                     owner_detail=f"fal http {exc.status}: {str(exc.detail)[:200]}") from exc
        except httpx.HTTPError as exc:
            raise VideoProviderError("Could not reach the video service. Try again in a moment.", retry=True) from exc
        return f"{sub['request_id']}|{sub['status_url']}|{sub['response_url']}"


def depth_video_cost(seconds: float) -> Decimal:
    return (DEPTH_VIDEO_PRICE * Decimal(str(seconds))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
