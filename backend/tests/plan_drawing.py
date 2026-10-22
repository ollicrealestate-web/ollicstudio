"""Draws a floor plan image from a Layout, the way an architect's PNG usually looks:
thick black walls, door gaps with swing arcs, windows as thin lines across the wall,
room names with areas, a dimension line and some furniture clutter. Used to test the
plan reader against a known answer."""

from __future__ import annotations

import io
import math

from PIL import Image, ImageDraw, ImageFont

from app.bim.layout import Layout


def draw_plan(L: Layout, px_per_m: float = 60, margin: int = 90, clutter: bool = True) -> tuple[bytes, dict]:
    xs = [p[0] for w in L.walls for p in (w.a, w.b)]
    ys = [p[1] for w in L.walls for p in (w.a, w.b)]
    W = int((max(xs) - min(xs)) * px_per_m + 2 * margin)
    H = int((max(ys) - min(ys)) * px_per_m + 2 * margin)
    ox, oy = min(xs), min(ys)
    to_px = lambda p: (margin + (p[0] - ox) * px_per_m, H - margin - (p[1] - oy) * px_per_m)
    img = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.load_default(size=16)
        small = ImageFont.load_default(size=12)
    except TypeError:
        font = small = ImageFont.load_default()

    walls = {w.id: w for w in L.walls}
    gaps: dict[str, list[tuple[float, float, str]]] = {}
    for o in L.openings:
        gaps.setdefault(o.wall, []).append((o.offset - o.width / 2, o.offset + o.width / 2, o.kind))
    for w in L.walls:
        ax, ay = w.a
        ux, uy = (w.b[0] - ax) / w.length, (w.b[1] - ay) / w.length
        cuts = sorted(gaps.get(w.id, []))
        t = w.thickness * px_per_m
        pos = -w.thickness / 2
        pieces, prev = [], pos
        for s, e, _ in cuts:
            pieces.append((prev, s)); prev = e
        pieces.append((prev, w.length + w.thickness / 2))
        for s, e in pieces:
            if e - s <= 0.01:
                continue
            p1, p2 = to_px((ax + ux * s, ay + uy * s)), to_px((ax + ux * e, ay + uy * e))
            d.line([p1, p2], fill=0, width=max(3, round(t)))
        for s, e, kind in cuts:
            p1, p2 = to_px((ax + ux * s, ay + uy * s)), to_px((ax + ux * e, ay + uy * e))
            if kind == "window":  # three thin lines across the opening
                nx, ny = -uy * w.thickness / 2, ux * w.thickness / 2
                for k in (-1, 0, 1):
                    q1 = to_px((ax + ux * s + nx * k, ay + uy * s + ny * k)); q2 = to_px((ax + ux * e + nx * k, ay + uy * e + ny * k))
                    d.line([q1, q2], fill=0, width=1)
                d.line([p1, to_px((ax + ux * s - nx, ay + uy * s - ny))], fill=0, width=1)
            else:  # door leaf and swing arc
                r = (e - s) * px_per_m
                leaf_end = to_px((ax + ux * s - uy * (e - s), ay + uy * s + ux * (e - s)))
                d.line([p1, leaf_end], fill=0, width=2)
                ang = math.degrees(math.atan2(-(uy), ux))
                d.arc([p1[0] - r, p1[1] - r, p1[0] + r, p1[1] + r], ang - 90, ang, fill=0, width=1)

    labels = []
    for room in L.rooms:
        cx = sum(p[0] for p in room.polygon) / len(room.polygon)
        cy = sum(p[1] for p in room.polygon) / len(room.polygon)
        x, y = to_px((cx, cy))
        name = room.name.upper()
        d.text((x, y - 10), name, fill=0, font=font, anchor="mm")
        if room.area_label:
            d.text((x, y + 10), f"{room.area_label:g} m²".replace("²", "2"), fill=0, font=small, anchor="mm")
        labels.append({"name": room.name, "area_m2": room.area_label, "x": x / W, "y": y / H})

    if clutter:  # thin dimension line along the top and a few furniture outlines
        y0 = margin * 0.45
        d.line([(margin, y0), (W - margin, y0)], fill=0, width=1)
        for x in (margin, W - margin):
            d.line([(x, y0 - 8), (x, y0 + 8)], fill=0, width=1)
        d.text((W / 2, y0 - 12), f"{(max(xs) - min(xs)) * 1000:.0f}", fill=0, font=small, anchor="mm")
        bx, by = to_px((8.0, 1.0))
        d.rectangle([bx, by - 2.0 * px_per_m, bx + 1.6 * px_per_m, by], outline=0, width=1)   # bed
        sx, sy = to_px((1.0, 1.0))
        d.rectangle([sx, sy - 0.9 * px_per_m, sx + 2.2 * px_per_m, sy], outline=0, width=1)   # sofa
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue(), {"px_per_m": px_per_m, "width": W, "height": H, "labels": labels}
