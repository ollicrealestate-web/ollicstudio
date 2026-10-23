"""Checks a returned image and stamps the Ollicstudio mark onto the copy people see and share.
The record keeps the "AI concept — not to scale" label, shown beside the picture in the app."""

from __future__ import annotations

import io

from PIL import Image, ImageDraw, ImageFont

from pathlib import Path

CONCEPT_LABEL = "AI concept — not to scale"
STAMP_TEXT = "Ollicstudio"        # the mark on every picture people download and share
FONT = Path(__file__).parent / "fonts" / "Outfit.ttf"  # the site's typeface (SIL Open Font Licence)


class BadImage(Exception):
    pass


def open_image(data: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:  # Pillow raises several types for bad data
        raise BadImage("The image could not be read.") from exc
    return img.convert("RGB")


def to_jpeg(img: Image.Image, quality: int = 92) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def stamp_label(img: Image.Image, text: str = STAMP_TEXT) -> Image.Image:
    """Bottom-left tag, sized to the image, so the label survives when the file is shared."""
    out = img.copy()
    w, h = out.size
    size = max(14, round(min(w, h) * 0.026))
    try:
        font = ImageFont.truetype(str(FONT), size)
        font.set_variation_by_name("Medium")
    except (OSError, ValueError, AttributeError):
        font = ImageFont.load_default(size=size)
    draw = ImageDraw.Draw(out, "RGBA")
    pad = round(size * 0.6)
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    tw, th = right - left, bottom - top
    margin = round(size * 0.9)
    x0, y1 = margin, h - margin
    box = (x0, y1 - th - 2 * pad, x0 + tw + 2 * pad + round(size * 0.5), y1)
    draw.rectangle(box, fill=(7, 7, 7, 200))
    draw.rectangle((box[0], box[1], box[0] + round(size * 0.25), box[3]), fill=(212, 33, 39, 255))
    draw.text((box[0] + pad + round(size * 0.4) - left, box[1] + pad - top), text, font=font, fill=(255, 255, 255, 255))
    return out
