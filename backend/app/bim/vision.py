"""Reads room names and written areas off a floor plan with a vision model (Cloudflare
Workers AI, free daily allowance). The answer is a suggestion: positions are approximate
and every name or area it gives is marked "ai" for the customer to confirm."""

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
    "This is an architectural floor plan. List every room label written on it. "
    "For each label give: name (the room name exactly as written), area_m2 (the area written under or next to the name, "
    "as a number in square metres, or null if none is written), x and y (the position of the label's centre as fractions "
    "of the image width and height, 0 at the top-left, 1 at the bottom-right). "
    "Also give overall_width_m and overall_depth_m if the plan writes the building's overall dimensions (convert mm to m), else null. "
    "Answer with JSON only, no other text, in this shape: "
    '{"rooms":[{"name":"Living","area_m2":38.5,"x":0.3,"y":0.6}],"overall_width_m":null,"overall_depth_m":null}'
)


class VisionUnavailable(Exception):
    pass


def _image_payload(img: Image.Image) -> str:
    im = img.convert("RGB")
    im.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def parse_answer(text) -> dict:
    if not isinstance(text, str):
        text = json.dumps(text) if isinstance(text, (dict, list)) else str(text or "")
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise VisionUnavailable("no JSON in the answer")
    try:
        data = json.loads(m.group(0))
    except ValueError as exc:
        raise VisionUnavailable("the answer was not valid JSON") from exc
    rooms = []
    for r in data.get("rooms") or []:
        if not isinstance(r, dict) or not str(r.get("name") or "").strip():
            continue
        def num(v):
            try:
                v = float(str(v).replace("m2", "").replace("m²", "").strip())
                return v if v == v else None
            except (TypeError, ValueError):
                return None
        x, y = num(r.get("x")), num(r.get("y"))
        if x is None or y is None:
            continue
        if x > 1.5 or y > 1.5:  # the model answered in percent
            x, y = x / 100, y / 100
        rooms.append({"name": str(r["name"]).strip()[:60], "area_m2": num(r.get("area_m2")), "x": x, "y": y})
    def opt(k):
        try:
            v = data.get(k)
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None
    return {"rooms": rooms, "overall_width_m": opt("overall_width_m"), "overall_depth_m": opt("overall_depth_m")}


class CloudflareVision:
    def __init__(self, account_id: str, api_token: str, client: httpx.Client | None = None, model: str = VISION_MODEL):
        self._http = client or httpx.Client(base_url="https://api.cloudflare.com", timeout=httpx.Timeout(120, connect=15))
        self._acct, self._model = account_id, model
        self._headers = {"Authorization": f"Bearer {api_token}"}

    def read_labels(self, img: Image.Image) -> dict:
        messages = [{"role": "user", "content": [{"type": "text", "text": PROMPT}, {"type": "image_url", "image_url": {"url": _image_payload(img)}}]}]
        body = {"messages": messages, "max_tokens": 1500, "temperature": 0}
        try:
            res = self._http.post(f"/client/v4/accounts/{self._acct}/ai/run/{self._model}", json=body, headers=self._headers)
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
        if text is None and isinstance(result.get("choices"), list) and result["choices"]:  # OpenAI-style answer
            text = (result["choices"][0].get("message") or {}).get("content")
        out = parse_answer(text)
        out["model"] = self._model
        out["usage"] = result.get("usage")
        return out
