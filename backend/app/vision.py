"""Reads an architect's floor plan with a vision model (Cloudflare Workers AI, free daily
allowance) and describes it in plain words for the render brief: what kind of building it
is, how the floor is arranged, and anything the render should keep. The description is a
starting point the architect edits; nothing in it is treated as measured fact."""

from __future__ import annotations

import base64
import io
import json
import logging
import re

import httpx
from PIL import Image

log = logging.getLogger("ollic.vision")

VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct"
PROMPT = (
    "You are helping an architect brief a rendering artist. This image is an architectural floor plan or drawing sheet. "
    "Read it carefully, including the title block, room labels and dimensions. Answer with JSON only, no other text, in this shape:\n"
    '{"building_type": "e.g. 6-storey residential apartment block", '
    '"drawing_title": "the sheet title if written, else null", '
    '"storeys": number of floors if the drawing says so (e.g. "1st - 6th floor" means 6 typical floors), else null, '
    '"units_per_floor": number of flats or units on this floor, else null, '
    '"layout": "two or three sentences on how the floor is arranged: units, core, stairs, lifts, corridors, symmetry", '
    '"rooms": ["main room names you can read"], '
    '"features": ["things the exterior render should show, e.g. balconies on both long sides, terraces at the corners, curved corners, central stair core"], '
    '"overall_width_m": overall width in metres if a dimension is written (convert mm), else null, '
    '"overall_depth_m": overall depth in metres if written, else null}'
)


class VisionUnavailable(Exception):
    pass


def load_image(data: bytes, kind: str) -> Image.Image:
    """A PNG or JPEG as an RGB image (transparent parts on white)."""
    img = Image.open(io.BytesIO(data))
    img.load()
    if img.mode in ("RGBA", "LA", "P"):
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, img.convert("RGBA"))
    return img.convert("RGB")


def image_png(img: Image.Image, max_side: int = 1024) -> bytes:
    im = img.copy()
    im.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _num(v):
    try:
        v = float(str(v).replace(",", "").strip())
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def parse_reading(text) -> dict:
    if not isinstance(text, str):
        text = json.dumps(text) if isinstance(text, (dict, list)) else str(text or "")
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise VisionUnavailable("no JSON in the answer")
    try:
        d = json.loads(m.group(0))
    except ValueError as exc:
        raise VisionUnavailable("the answer was not valid JSON") from exc
    words = lambda v, n: str(v).strip()[:n] if v not in (None, "", "null") else None
    lst = lambda v: [str(x).strip()[:80] for x in v if str(x).strip()][:20] if isinstance(v, list) else []
    storeys = _num(d.get("storeys"))
    units = _num(d.get("units_per_floor"))
    return {
        "building_type": words(d.get("building_type"), 120),
        "drawing_title": words(d.get("drawing_title"), 120),
        "storeys": int(storeys) if storeys and 1 <= storeys <= 80 else None,
        "units_per_floor": int(units) if units and 1 <= units <= 50 else None,
        "layout": words(d.get("layout"), 800),
        "rooms": lst(d.get("rooms")),
        "features": lst(d.get("features")),
        "overall_width_m": _num(d.get("overall_width_m")),
        "overall_depth_m": _num(d.get("overall_depth_m")),
    }


def summary_text(r: dict) -> str:
    """One editable paragraph for the render brief."""
    parts = []
    if r.get("building_type"):
        bt = r["building_type"].rstrip(".")
        parts.append(bt[:1].upper() + bt[1:] + ".")
    if r.get("layout"):
        parts.append(r["layout"].rstrip(".") + ".")
    if r.get("features"):
        parts.append("Show: " + "; ".join(r["features"][:8]) + ".")
    # Sizes the model reads off a drawing are often wrong (a live A103 sheet read 48 m for about 31 m),
    # so they are not put into the brief, where they would mislead the render.
    return " ".join(parts)[:2000]


class CloudflareVision:
    def __init__(self, account_id: str, api_token: str, client: httpx.Client | None = None, model: str = VISION_MODEL):
        self._http = client or httpx.Client(base_url="https://api.cloudflare.com", timeout=httpx.Timeout(90, connect=15))
        self._acct, self._model = account_id, model
        self._headers = {"Authorization": f"Bearer {api_token}"}

    def read_plan(self, img: Image.Image) -> dict:
        url = "data:image/png;base64," + base64.b64encode(image_png(img)).decode()
        messages = [{"role": "user", "content": [{"type": "text", "text": PROMPT}, {"type": "image_url", "image_url": {"url": url}}]}]
        try:
            res = self._http.post(f"/client/v4/accounts/{self._acct}/ai/run/{self._model}",
                                  json={"messages": messages, "max_tokens": 1200, "temperature": 0}, headers=self._headers)
        except httpx.HTTPError as exc:
            raise VisionUnavailable(f"could not reach the vision model: {exc.__class__.__name__}") from exc
        try:
            payload = res.json()
        except ValueError:
            payload = {}
        if res.status_code >= 400 or payload.get("success") is False:
            errs = payload.get("errors") or [{}]
            raise VisionUnavailable(f"vision model error {res.status_code}: {str(errs[0].get('message'))[:200]}")
        result = payload.get("result") if isinstance(payload.get("result"), dict) else payload
        text = result.get("response")
        if text is None and isinstance(result.get("choices"), list) and result["choices"]:
            text = (result["choices"][0].get("message") or {}).get("content")
        out = parse_reading(text)
        out["model"] = self._model
        out["usage"] = result.get("usage")
        return out
