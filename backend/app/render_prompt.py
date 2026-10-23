"""Writes the rendering prompt from what the architect gives: the picture to render (a captured view
of their 3D model, a sketch, a 3D image or a floor plan), up to three reference pictures whose scene
to copy and a plain-words description.

Claude writes it when it is set up (it sees every picture); otherwise the free Cloudflare vision
model writes it from the main picture. The architect can edit the prompt before rendering, and the
render then uses it as written. The pictures are numbered here in the same order the render sends
them to the image model (renders.ROLE_ORDER), so "Image 1", "Image 2" mean the same in both.
"""

from __future__ import annotations

import base64
import json
import logging
import re

import httpx

from .vision import VISION_MODEL, image_png, load_image

log = logging.getLogger("ollic.render_prompt")

ROLE_INTRO = {
    "model": "Image {n} is the VIEW TO RENDER: a plain, untextured 3D view of the architect's building (a Revit, SketchUp or Lumion export).",
    "base": "Image {n} is the VIEW TO RENDER: the architect's design (a sketch, 3D image or photo).",
    "plan": "Image {n} is the architect's FLOOR PLAN of a typical floor.",
    "style": "Image {n} is a REFERENCE: copy its scene (setting, landscaping, sky, light, mood and material palette), never its building.",
}

SYSTEM = (
    "You are a senior architectural visualisation artist. You write the prompt an AI image model will use to turn the architect's "
    "picture into a photorealistic, professional render of THEIR building. Accuracy matters more than anything: the render must be "
    "this building and no other.\n"
    "Study the pictures closely before writing. On the view to render, count and describe exactly what is there: the massing and "
    "setbacks, the number of floors, the roof and parapets, every band of windows and how it is divided, balconies, louvres, fins, "
    "cladding panels, columns, canopies, the entrance, terraces and roof plant, and the camera position, height, angle and framing. "
    "On a floor plan, read the footprint, units, core and balconies. On a "
    "reference, note only its scene: surroundings, landscaping, sky, time of day, light, mood and materials palette.\n"
    "Then write ONE prompt that: (1) tells the image model to keep the view to render exactly: same building form, same number of "
    "floors, same openings and facade elements in the same places, same camera and framing; it may only add realistic materials, "
    "glass with reflections, lighting, sky, landscaping, context and entourage; (2) names concrete materials and colours for each "
    "part, from the architect's description or the references, or tasteful choices that suit the design if none are given; (3) sets "
    "the light, time of day, sky and surroundings; (4) asks for professional architectural photography quality, true verticals and "
    "realistic scale. Refer to the pictures as Image 1, Image 2 and so on, in the order given. Never invent floors, wings or features "
    "that are not in the pictures. Never ask for text, labels, logos or watermarks. Keep it under 450 words.\n"
    'Answer with JSON only: {"prompt": "...", "notes": "one short sentence for the architect on what you saw"}'
)


class PromptUnavailable(Exception):
    pass


def _user_text(description: str, roles: list[str]) -> str:
    parts = [ROLE_INTRO[r].format(n=i) for i, r in enumerate(roles, 1)]
    parts.append("Architect's description: " + (description.strip() or "(none given: choose tasteful, realistic materials and a natural setting that suit the design)"))
    return "\n".join(parts)


def _parse(text: str | None) -> dict:
    m = re.search(r"\{.*\}", text or "", re.S)
    try:
        out = json.loads(m.group(0)) if m else {}
    except ValueError:
        out = {}
    prompt = str(out.get("prompt") or "").strip()
    if len(prompt) < 60:
        raise PromptUnavailable("no usable prompt in the reply")
    return {"prompt": prompt[:6000], "notes": str(out.get("notes") or "")[:300]}


def write_with_claude(writer, images: list[tuple[bytes, str]], roles: list[str], description: str) -> dict:
    """writer: prompt_writer.ClaudePromptWriter (sees every picture)."""
    from .prompt_writer import PromptWriterFailed, _image_block
    content = []
    for i, ((data, _), role) in enumerate(zip(images, roles), 1):
        content.append({"type": "text", "text": ROLE_INTRO[role].format(n=i)})
        content.append(_image_block(data))
    content.append({"type": "text", "text": _user_text(description, [])})
    try:
        out = writer._call(SYSTEM, content)
    except PromptWriterFailed as exc:
        raise PromptUnavailable(str(exc)) from exc
    return out | {"provider": "anthropic"}


def write_with_cloudflare(vision, images: list[tuple[bytes, str]], roles: list[str], description: str) -> dict:
    """vision: vision.CloudflareVision. The free model sees the main picture; references are described in words."""
    data, _ = images[0]
    img = load_image(data, "image")
    url = "data:image/png;base64," + base64.b64encode(image_png(img, max_side=1024)).decode()
    text = _user_text(description, roles[:1])
    if len(roles) > 1:
        text += f"\nThe architect also gave {len(roles) - 1} reference picture(s) for the scene; ask for a refined, realistic setting that suits the design."
    messages = [{"role": "system", "content": SYSTEM},
                {"role": "user", "content": [{"type": "text", "text": text}, {"type": "image_url", "image_url": {"url": url}}]}]
    try:
        res = vision._http.post(f"/client/v4/accounts/{vision._acct}/ai/run/{vision._model}",
                                json={"messages": messages, "max_tokens": 1400, "temperature": 0.2}, headers=vision._headers)
        payload = res.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise PromptUnavailable(f"could not reach the vision model: {exc.__class__.__name__}") from exc
    if res.status_code >= 400 or payload.get("success") is False:
        raise PromptUnavailable(f"vision model error {res.status_code}")
    result = payload.get("result") if isinstance(payload.get("result"), dict) else payload
    reply = result.get("response")
    if reply is None and isinstance(result.get("choices"), list) and result["choices"]:
        reply = (result["choices"][0].get("message") or {}).get("content")
    if isinstance(reply, dict):
        reply = json.dumps(reply)
    return _parse(reply) | {"provider": "cloudflare", "model": VISION_MODEL, "usage": result.get("usage"), "cost_usd": None}
