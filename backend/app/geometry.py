"""Checks that an AI picture or video kept the building's geometry, and puts it back in the
architect's camera when the AI only reframed it.

The reference is the exact view captured from the architect's model (a shaded view or a clay frame).
1. Framing: the AI often draws the right building but a little smaller, bigger or moved. The best
   zoom and shift that line the result up with the model view is found by correlating their edge
   maps over a range of zooms (FFT); `realign` then crops the result back to the model's camera
   (it only crops and scales the AI picture; small gaps at an edge are filled from the edge).
2. Shape: after lining up, the building's edges are compared both ways (found in the result and not
   invented by it) within about 0.6% of the width, giving an F-score from 0 to 1.

Calibrated on a real render of a 7-storey model (24 Oct 2026): the same building, reframed by the AI,
0.81 after lining up; mirrored 0.56; another building 0.49. A line-drawing check was used before;
it could not tell a different building from the right one on dense models and was replaced.
When Claude is connected it also compares the two pictures and lists any differences it sees.
"""

from __future__ import annotations

import io
import logging

import numpy as np
from PIL import Image, ImageFilter

log = logging.getLogger("ollic.geometry")
SIZE = 512            # pictures are compared at this width
GOOD, FAIR = 0.8, 0.65  # bands; below GOOD a render is made once more, geometry first
ZOOMS = np.geomspace(0.6, 1.6, 41)
MAX_GAP = 0.06        # realign only when the gap to fill at any edge is at most this share of the picture
CHECK_SYSTEM = (
    "You check AI architectural renders for geometric accuracy. Image 1 is an exact view of the architect's model (the guide). "
    "Image 2 is the AI result from the same camera. Ignore materials, colours, light, sky, plants, people and cars. Compare only "
    "the building: number of floors, the roof line and parapets, the position and number of window and door openings on each "
    "floor, balconies, columns, the entrance, setbacks and overall proportions, and the camera angle. "
    'Answer with JSON only: {"ok": true or false, "issues": ["short description of each geometric difference"]}. '
    "ok is false if any floor, opening, roof or major element is added, removed or moved. Write each issue as a short instruction "
    "an image model can follow to fix it, e.g. \"the model has 7 floors above the ground floor; the result shows 6: add the missing floor\"."
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


def _soft(mask: np.ndarray, sigma: float) -> np.ndarray:
    return np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(sigma)), dtype=np.float32)


def find_frame(view: Image.Image, result: Image.Image, w: int = 256) -> dict:
    """The zoom and shift that put `result` onto `view`: scale the result by `scale` about its centre,
    then move it by (dx, dy), given as shares of the width and height. `corr` is how well they line up."""
    ve = _soft(edge_map(view, w), 2.0); ve -= ve.mean()
    H, W = ve.shape
    best = (-1.0, 1.0, 0, 0)
    for s in ZOOMS:
        rw, rh = max(8, round(W * s)), max(8, round(H * s))
        re = _soft(edge_map(result.resize((rw, rh)), rw), 2.0)
        c = np.zeros((H, W), np.float32)
        x0, y0 = (W - rw) // 2, (H - rh) // 2
        sx, sy, px, py = max(0, -x0), max(0, -y0), max(0, x0), max(0, y0)
        ww, hh = min(W - px, rw - sx), min(H - py, rh - sy)
        c[py:py + hh, px:px + ww] = re[sy:sy + hh, sx:sx + ww]
        c -= c.mean()
        f = np.fft.irfft2(np.fft.rfft2(ve) * np.conj(np.fft.rfft2(c)), s=(H, W))
        k = int(np.argmax(f)); dy, dx = divmod(k, W)
        dy, dx = (dy - H if dy > H // 2 else dy), (dx - W if dx > W // 2 else dx)
        corr = float(f.flat[k] / (np.linalg.norm(ve) * np.linalg.norm(c) + 1e-6))
        if corr > best[0]:
            best = (corr, float(s), dx, dy)
    corr, s, dx, dy = best
    return {"corr": round(corr, 3), "scale": round(s, 3), "dx": round(dx / W, 4), "dy": round(dy / H, 4)}


def realign(result: Image.Image, frame: dict) -> Image.Image | None:
    """The result put back in the model's camera (same size as the result), or None when that would
    leave too large a gap at an edge (the AI zoomed in too far: render again instead)."""
    W, H = result.size
    s = frame["scale"]
    rw, rh = round(W * s), round(H * s)
    ox, oy = round((W - rw) / 2 + frame["dx"] * W), round((H - rh) / 2 + frame["dy"] * H)
    left, top, right, bottom = max(0, ox), max(0, oy), max(0, W - (ox + rw)), max(0, H - (oy + rh))
    if max(left, right) > MAX_GAP * W or max(top, bottom) > MAX_GAP * H:
        return None
    im = result.convert("RGB").resize((rw, rh), Image.Resampling.LANCZOS)
    a = np.asarray(im)[top - oy:top - oy + H - top - bottom, left - ox:left - ox + W - left - right]
    a = np.pad(a, ((top, bottom), (left, right), (0, 0)), mode="edge")
    return Image.fromarray(a)


def fidelity(view: Image.Image, result: Image.Image, keep: float = 0.08) -> float:
    """Building edges of the model view and the (lined-up) result compared both ways: F-score 0 to 1."""
    result = result.resize(view.size) if result.size != view.size else result
    ve, e = edge_map(view, keep=keep), edge_map(result, keep=keep)
    if ve.sum() < 50:
        return 1.0
    tol = max(2, SIZE // 170)
    rec = (ve & _dilate(e, tol)).sum() / ve.sum()
    pre = (e & _dilate(ve, tol)).sum() / max(1, e.sum())
    return round(float(2 * rec * pre / (rec + pre + 1e-9)), 3)


def assess(view: Image.Image, result: Image.Image, fix_framing: bool = True) -> tuple[dict, Image.Image | None]:
    """The check, and the result put back in the model's camera when the AI only reframed it
    (None when it was already in place or could not be put back)."""
    view = view.convert("RGB")
    frame = find_frame(view, result)
    moved = abs(frame["scale"] - 1) > 0.02 or abs(frame["dx"]) > 0.01 or abs(frame["dy"]) > 0.01
    fixed = realign(result, frame) if (fix_framing and moved) else None
    score = fidelity(view, fixed if fixed is not None else result)
    if moved and fixed is None:
        score = min(score, fidelity(view, result))
    check = {"score": score, "band": band(score), "framing": "corrected" if fixed is not None else ("moved" if moved else "kept"),
             "frame": frame}
    return check, fixed


def match(guide: Image.Image, result: Image.Image, guide_is_lines: bool = False) -> float:
    """Kept for old callers: the shape score of `result` against a shaded model view, after lining up."""
    check, _ = assess(guide, result)
    return check["score"]


def band(score: float) -> str:
    return "good" if score >= GOOD else "fair" if score >= FAIR else "poor"


def claude_check(writer, guide_jpg: bytes, result_jpg: bytes, facts: str = "") -> dict | None:
    """Claude's own comparison; None when Claude is not connected or does not answer."""
    if writer is None or not hasattr(writer, "ask_json"):
        return None
    from .prompt_writer import PromptWriterFailed, _image_block
    content = [{"type": "text", "text": "Image 1 (guide):"}, _image_block(guide_jpg), {"type": "text", "text": "Image 2 (AI result):"}, _image_block(result_jpg)]
    if facts:
        content.append({"type": "text", "text": "Facts from the architect's model (use them to count floors and openings; the numbers cover the whole "
                                                "building, not only the faces in view):\n" + facts})
    try:
        out = writer.ask_json(CHECK_SYSTEM, content, max_tokens=1500)
    except (PromptWriterFailed, KeyError, TypeError) as exc:
        log.warning("geometry check by Claude failed: %s", exc)
        return {"error": str(exc)[:200]}
    a = out["answer"]
    return {"ok": bool(a.get("ok")), "issues": [str(x)[:200] for x in (a.get("issues") or [])][:8],
            "usage": out.get("usage"), "cost_usd": str(out["cost_usd"]) if out.get("cost_usd") is not None else None}


def jpeg(img: Image.Image, q: int = 90) -> bytes:
    b = io.BytesIO(); img.convert("RGB").save(b, "JPEG", quality=q); return b.getvalue()
