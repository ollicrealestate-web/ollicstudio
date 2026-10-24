"""Checks that an AI picture or video kept the building's geometry.

The guide is drawn from the architect's model at the same camera: a line drawing (every edge of
the building) or a clay frame. The check measures how many of the guide's building edges appear in
the AI result, within a small tolerance (about 0.6% of the picture's width): the AI may add texture,
plants and people, which do not count against it, but a missing floor, a moved window or a changed
roof line does. When Claude is connected it also compares the two pictures and lists any
differences it sees (floors, openings, roof, entrance).

The score is a guide, not a measurement: it is shown to the customer as "match" with the result,
and a render that scores low is made again once.
"""

from __future__ import annotations

import io
import logging

import numpy as np
from PIL import Image, ImageFilter

log = logging.getLogger("ollic.geometry")
SIZE = 512            # pictures are compared at this width
GOOD, FAIR = 0.7, 0.5  # match bands (calibrated on a real render: the same building 0.92, moved 5% 0.52, mirrored 0.56, another building 0.23)
CHECK_SYSTEM = (
    "You check AI architectural renders for geometric accuracy. Image 1 is an exact view of the architect's model (the guide). "
    "Image 2 is the AI result from the same camera. Ignore materials, colours, light, sky, plants, people and cars. Compare only "
    "the building: number of floors, the roof line and parapets, the position and number of window and door openings on each "
    "floor, balconies, columns, the entrance, setbacks and overall proportions, and the camera angle. "
    'Answer with JSON only: {"ok": true or false, "issues": ["short description of each geometric difference"]}. '
    "ok is false if any floor, opening, roof or major element is added, removed or moved."
)


def _gray(img: Image.Image, w: int) -> np.ndarray:
    img = img.convert("L")
    h = max(8, round(img.height * w / img.width))
    return np.asarray(img.resize((w, h), Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(1.0)), dtype=np.float32)


def edge_map(img: Image.Image, w: int = SIZE, keep: float = 0.07) -> np.ndarray:
    """The strongest edges (about the top `keep` share of gradient), as a boolean map."""
    g = _gray(img, w)
    gx = np.zeros_like(g); gy = np.zeros_like(g)
    gx[:, 1:-1] = g[:, 2:] - g[:, :-2]; gy[1:-1, :] = g[2:, :] - g[:-2, :]
    m = np.hypot(gx, gy)
    if not m.any():
        return m > 0
    t = max(np.quantile(m, 1 - keep), 1e-3)
    return m >= t


def line_map(img: Image.Image, w: int = SIZE) -> np.ndarray:
    """A guide line drawing (light lines on black) as a boolean map."""
    return _gray(img, w) > 60


def _dilate(mask: np.ndarray, r: int) -> np.ndarray:
    img = Image.fromarray((mask * 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.MaxFilter(2 * r + 1))) > 0


def match(guide: Image.Image, result: Image.Image, guide_is_lines: bool = True) -> float:
    """Share of the guide's building edges found in the result (0 to 1)."""
    g = line_map(guide) if guide_is_lines else edge_map(guide)
    r = edge_map(result.resize(guide.size) if result.size != guide.size else result)
    if g.shape != r.shape:
        h = min(g.shape[0], r.shape[0]); g, r = g[:h], r[:h]
    total = int(g.sum())
    if total < 50:
        return 1.0          # nothing to compare (an empty guide)
    tol = max(2, SIZE // 170)
    return round(float((g & _dilate(r, tol)).sum()) / total, 3)


def band(score: float) -> str:
    return "good" if score >= GOOD else "fair" if score >= FAIR else "poor"


def claude_check(writer, guide_jpg: bytes, result_jpg: bytes) -> dict | None:
    """Claude's own comparison; None when Claude is not connected or does not answer."""
    if writer is None or not hasattr(writer, "ask_json"):
        return None
    from .prompt_writer import PromptWriterFailed, _image_block
    content = [{"type": "text", "text": "Image 1 (guide):"}, _image_block(guide_jpg), {"type": "text", "text": "Image 2 (AI result):"}, _image_block(result_jpg)]
    try:
        out = writer.ask_json(CHECK_SYSTEM, content, max_tokens=600)
    except (PromptWriterFailed, KeyError, TypeError) as exc:
        log.warning("geometry check by Claude failed: %s", exc)
        return None
    a = out["answer"]
    return {"ok": bool(a.get("ok")), "issues": [str(x)[:200] for x in (a.get("issues") or [])][:8],
            "usage": out.get("usage"), "cost_usd": str(out["cost_usd"]) if out.get("cost_usd") is not None else None}


def jpeg(img: Image.Image, q: int = 90) -> bytes:
    b = io.BytesIO(); img.convert("RGB").save(b, "JPEG", quality=q); return b.getvalue()
