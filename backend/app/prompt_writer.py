"""Premium prompting: Claude looks at the architect's plan, model view, sketches and look
references, reads the brief, and writes the image model's prompt (and, for revisions, turns a
plain-words request into a precise edit). Called only from the server; customers never see
which model does this. If Claude is not set up or fails, the standard written prompt is used.

Messages API, checked against platform.claude.com on 22 Oct 2026. Prices per million tokens.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import re
from decimal import ROUND_HALF_UP, Decimal

import httpx
from PIL import Image

log = logging.getLogger("ollic.prompts")

API_VERSION = "2023-06-01"
PRICES = {"claude-opus-5-5": ("4", "20"), "claude-fable-5-1": ("10", "50"), "claude-sonnet-5-5": ("2", "10")}
PRICE_SOURCE = "platform.claude.com/docs/en/models/overview, checked 2026-10-22"
ROLE_NAMES = {"base": "design to keep (shape and camera)", "model": "3D view of the architect's model (keep shape and camera)",
              "plan": "architect's floor plan of a typical floor", "style": "look and materials reference"}

SYSTEM = (
    "You are a senior architectural visualisation artist who writes prompts for an AI image model. "
    "The architect gives you a brief, some choices, and up to four images, each with a role. Study every image closely: "
    "on a floor plan read the footprint, the number and arrangement of units, the core, balconies, terraces, curves and symmetry; "
    "on a model view or sketch note the exact massing, floor count, openings and camera; on a look reference note facade materials, "
    "glazing, balustrades, cladding, colours and details. Then write one prompt for the image model that produces a photorealistic, "
    "professional render of THIS building. Refer to the supplied images as Image 1, Image 2 and so on, in the order given, and say what to take "
    "from each. Be concrete about massing, floor count, ground floor, facade, materials, glazing, cantilevers, landscaping, camera, lens and light. "
    "Never invent dimensions the drawings do not show, never ask for text, logos or watermarks in the picture, and keep the prompt under 900 words. "
    'Answer with JSON only: {"prompt": "...", "notes": "one short sentence for the architect on how you read their images"}'
)
EDIT_SYSTEM = (
    "You are a senior architectural visualisation artist. Image 1 is the current render. The architect asks for a change in plain words. "
    "Write a precise edit instruction for an AI image model: say exactly what to change and where, and list what must stay the same "
    "(building form, floor count, openings, camera, and lighting unless the request is about light). Never ask for text or watermarks. "
    'Answer with JSON only: {"prompt": "...", "notes": "one short sentence on what will change"}'
)


class PromptWriterFailed(Exception):
    pass


def _image_block(data: bytes) -> dict:
    img = Image.open(io.BytesIO(data)).convert("RGB")
    img.thumbnail((1568, 1568), Image.Resampling.LANCZOS)  # the size Claude reads best
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=88)
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(buf.getvalue()).decode()}}


def cost_usd(model: str, usage: dict | None) -> Decimal | None:
    prices = PRICES.get(model)
    if not prices or not usage:
        return None
    pin, pout = (Decimal(p) for p in prices)
    tokens_in = int(usage.get("input_tokens") or 0) + int(usage.get("cache_creation_input_tokens") or 0) + int(usage.get("cache_read_input_tokens") or 0)
    total = (tokens_in * pin + int(usage.get("output_tokens") or 0) * pout) / Decimal(1_000_000)
    return total.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)


class ClaudePromptWriter:
    def __init__(self, api_key: str, model: str = "claude-opus-5-5", client: httpx.Client | None = None):
        self.model = model
        self._http = client or httpx.Client(base_url="https://api.anthropic.com", timeout=httpx.Timeout(120, connect=15))
        self._headers = {"x-api-key": api_key, "anthropic-version": API_VERSION, "content-type": "application/json"}

    def write(self, *, brief: str, choices: dict, images: list[tuple[bytes, str]], roles: list[str]) -> dict:
        content = []
        for i, ((data, _), role) in enumerate(zip(images, roles), 1):
            content.append({"type": "text", "text": f"Image {i}: {ROLE_NAMES[role]}."})
            content.append(_image_block(data))
        chosen = "; ".join(f"{k.replace('_', ' ')}: {v}" for k, v in choices.items() if v not in (None, "", []))
        content.append({"type": "text", "text": f"Architect's brief: {brief}\nChoices: {chosen or 'none'}"})
        return self._call(SYSTEM, content)

    def write_edit(self, *, instruction: str, current: bytes) -> dict:
        content = [{"type": "text", "text": "Image 1: the current render."}, _image_block(current),
                   {"type": "text", "text": f"The architect asks: {instruction}"}]
        return self._call(EDIT_SYSTEM, content)

    def ask_json(self, system: str, content: list, max_tokens: int = 1800) -> dict:
        """Any question whose answer is one JSON object: returns {"answer": dict, "usage", "cost_usd", "model"}."""
        body = {"model": self.model, "max_tokens": max_tokens, "system": system, "messages": [{"role": "user", "content": content}]}
        try:
            res = self._http.post("/v1/messages", json=body, headers=self._headers)
        except httpx.HTTPError as exc:
            raise PromptWriterFailed(f"could not reach Claude: {exc.__class__.__name__}") from exc
        if res.status_code >= 400:
            log.warning("Claude error %s", res.status_code)
            raise PromptWriterFailed(f"Claude error {res.status_code}")
        payload = res.json()
        text = "".join(b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text")
        m = re.search(r"\{.*\}", text, re.S)
        try:
            out = json.loads(m.group(0)) if m else None
        except ValueError:
            out = None
        if not isinstance(out, dict):
            raise PromptWriterFailed("Claude returned no JSON")
        usage = payload.get("usage")
        return {"answer": out, "usage": usage, "cost_usd": cost_usd(self.model, usage), "model": self.model}

    def _call(self, system: str, content: list) -> dict:
        body = {"model": self.model, "max_tokens": 1800, "system": system, "messages": [{"role": "user", "content": content}]}
        try:
            res = self._http.post("/v1/messages", json=body, headers=self._headers)
        except httpx.HTTPError as exc:
            raise PromptWriterFailed(f"could not reach the prompt writer: {exc.__class__.__name__}") from exc
        if res.status_code >= 400:
            try:
                err = (res.json().get("error") or {}).get("message", "")
            except ValueError:
                err = ""
            log.warning("prompt writer error %s: %s", res.status_code, str(err)[:300])
            raise PromptWriterFailed(f"prompt writer error {res.status_code}")
        payload = res.json()
        text = "".join(b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text")
        m = re.search(r"\{.*\}", text, re.S)
        try:
            out = json.loads(m.group(0)) if m else {}
        except ValueError:
            out = {}
        prompt = str(out.get("prompt") or "").strip()
        if len(prompt) < 40:
            raise PromptWriterFailed("the prompt writer returned no usable prompt")
        usage = payload.get("usage")
        return {"prompt": prompt[:30000], "notes": str(out.get("notes") or "")[:300], "model": self.model,
                "usage": usage, "cost_usd": cost_usd(self.model, usage)}
