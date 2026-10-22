"""Reads a floor plan image into a layout proposal (brief Module B2 / N1).

Geometry comes from the drawing itself, with OpenCV: walls are the long, thick dark
strokes; a gap in a wall with thin lines across it is a window, an empty gap is a door;
rooms are the enclosed spaces between walls. Room names and written areas come from a
vision model (vision.py) and are marked "ai". Nothing here is final: every value is a
suggestion the customer reviews, and anything Ollic could not read is flagged rather
than invented. Version 1 reads walls drawn horizontally or vertically on the page.

All coordinates in the proposal are image pixels (x right, y down). The review screen
turns them into metres once the scale is confirmed.
"""

from __future__ import annotations

import io
import math
import statistics
from dataclasses import dataclass, field

import cv2
import numpy as np
from PIL import Image

MAX_SIDE = 1400
DEFAULTS = {"storey_height": 3.0, "door_height": 2.1, "window_height": 1.2, "window_sill": 0.9, "roof": "gable", "pitch": 25.0, "overhang": 0.5}


class TraceFailed(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


@dataclass
class Seg:
    horizontal: bool
    pos: float        # centre line: y for horizontal walls, x for vertical (px)
    lo: float         # start along the wall (px)
    hi: float         # end along the wall (px)
    t: float          # thickness (px)
    gaps: list = field(default_factory=list)  # (lo, hi, kind) along the wall

    @property
    def length(self):
        return self.hi - self.lo


def load_plan_image(data: bytes, kind: str) -> Image.Image:
    if kind == "pdf":
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(data)
        if len(pdf) == 0:
            raise TraceFailed("The PDF has no pages.")
        page = pdf[0]
        w, h = page.get_size()
        img = page.render(scale=min(4.0, 2000 / max(w, h)), fill_colour=(255, 255, 255, 255)).to_pil()
    else:
        img = Image.open(io.BytesIO(data))
        img.load()
        if img.mode in ("RGBA", "LA", "P"):
            bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
            img = Image.alpha_composite(bg, img.convert("RGBA"))
    img = img.convert("L")
    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
    elif max(img.size) < 700:
        f = 700 / max(img.size)
        img = img.resize((round(img.width * f), round(img.height * f)), Image.Resampling.LANCZOS)
    return img


# ---------------------------------------------------------------------------- main
def trace(img: Image.Image, labels: list[dict] | None = None) -> dict:
    g = np.asarray(img, dtype=np.uint8)
    H, W = g.shape
    _, ink = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if ink.mean() / 255 > 0.6:
        raise TraceFailed("The image is mostly dark. Upload a plan with dark lines on a light background.")

    walls_ink = _solid_walls(ink)
    L = max(15, int(max(W, H) * 0.02))
    # strokes thinner than 3 px across (window glazing lines, dimensions, furniture) are removed
    # before measuring, so a window's lines do not join the wall pieces either side of it
    horiz = cv2.morphologyEx(walls_ink, cv2.MORPH_OPEN, np.ones((1, L), np.uint8))
    horiz = cv2.morphologyEx(horiz, cv2.MORPH_OPEN, np.ones((3, 1), np.uint8))
    vert = cv2.morphologyEx(walls_ink, cv2.MORPH_OPEN, np.ones((L, 1), np.uint8))
    vert = cv2.morphologyEx(vert, cv2.MORPH_OPEN, np.ones((1, 3), np.uint8))
    hs, vs = _segments(horiz, True), _segments(vert, False)
    cut = _thickness_threshold([s.t for s in hs + vs])
    hs = [s for s in hs if s.t >= cut]
    vs = [s for s in vs if s.t >= cut]
    if len(hs) < 2 or len(vs) < 2:
        raise TraceFailed("Ollic could not find the walls in this image. Walls need to be drawn as thick dark lines; a clean architectural floor plan works best.")
    hs, vs = _drop_sheet_frame(hs, vs, W, H)
    tmed = _typical_thickness(hs + vs)
    hs = _merge(hs, ink, tmed)
    vs = _merge(vs, ink, tmed)
    _snap(hs, vs)
    walls = _main_building([s for s in hs + vs if s.length >= 2 * cut], tmed, (H, W))
    if len(walls) < 3:
        raise TraceFailed("Ollic could not find the walls in this image. Walls need to be drawn as thick dark lines; a clean architectural floor plan works best.")

    closed = np.zeros_like(ink)
    for s in walls:
        _draw(closed, s, s.lo, s.hi)
    footprint = _footprint(closed)
    # for finding rooms only: seal small gaps where wall ends do not quite meet
    k = int(max(3, tmed * 3)) | 1
    sealed = cv2.morphologyEx(closed, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    bx = [c for s in walls for c in ((s.lo, s.hi) if s.horizontal else (s.pos,))]
    by = [c for s in walls for c in ((s.pos,) if s.horizontal else (s.lo, s.hi))]
    rooms, lab = _rooms(sealed, (max(bx) - min(bx)) * (max(by) - min(by)))

    # ------------------------------------------------------------ assemble the proposal
    out_walls, out_open = [], []
    for i, s in enumerate(sorted(walls, key=lambda s: (not s.horizontal, s.pos, s.lo)), 1):
        a, b = ((s.lo, s.pos), (s.hi, s.pos)) if s.horizontal else ((s.pos, s.lo), (s.pos, s.hi))
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        exterior = footprint is not None and abs(cv2.pointPolygonTest(footprint, mid, True)) <= s.t * 0.8 + 3
        wid = f"w{i}"
        out_walls.append({"id": wid, "a": _r(a), "b": _r(b), "thickness_px": round(s.t, 1), "exterior": bool(exterior), "source": "drawing"})
        for lo, hi, kind in s.gaps:
            out_open.append({"id": f"o{len(out_open) + 1}", "wall": wid, "kind": kind, "offset_px": round((lo + hi) / 2 - s.lo, 1),
                             "width_px": round(hi - lo, 1), "source": "drawing",
                             "height": DEFAULTS["door_height"] if kind == "door" else DEFAULTS["window_height"],
                             "sill": 0.0 if kind == "door" else DEFAULTS["window_sill"], "height_source": "default"})

    out_rooms = []
    for i, r in enumerate(rooms, 1):
        out_rooms.append({"id": f"r{i}", "name": f"Room {i}", "name_source": "default", "polygon_px": r["polygon"],
                          "area_px": r["area_px"], "area_label": None, "area_source": None, "_label": r["label"]})
    used_labels = _assign_labels(out_rooms, lab, labels or [], W, H)

    # the building's extent from all its walls (its outline contour can be just one wing)
    wx = [c for s in walls for c in ((s.lo, s.hi) if s.horizontal else (s.pos,))]
    wy = [c for s in walls for c in ((s.pos,) if s.horizontal else (s.lo, s.hi))]
    scale = _scale_from_areas(out_rooms, (max(wx) - min(wx), max(wy) - min(wy)))
    flags = []
    if scale["m_per_px"] is None:
        flags.append({"kind": "missing", "target": "scale", "message": "No room areas could be read, so the scale is unknown. Enter the real length of one wall."})
    elif scale["spread"] > 0.12:
        flags.append({"kind": "check", "target": "scale", "message": f"The room areas disagree by {scale['spread'] * 100:.0f}% about the scale. Check it against one wall you know."})
    unnamed = [r["id"] for r in out_rooms if r["name_source"] == "default"]
    if unnamed:
        flags.append({"kind": "missing", "target": "rooms", "ids": unnamed, "message": f"{len(unnamed)} room{'s' if len(unnamed) > 1 else ''} could not be named from the drawing. Name them, or keep the suggested names."})
    if not out_open:
        flags.append({"kind": "check", "target": "openings", "message": "No doors or windows were found. Add them before building."})
    flags.append({"kind": "check", "target": "heights", "message": "Storey height, door and window heights, and the roof are standard values, not read from the plan. Check them."})
    for r in out_rooms:
        r.pop("_label", None)
    return {
        "version": 1, "image": {"width": W, "height": H}, "wall_threshold_px": round(cut, 1),
        "walls": out_walls, "openings": out_open, "rooms": out_rooms, "scale": scale,
        "levels": [{"name": "Ground floor", "elevation": 0.0, "height": DEFAULTS["storey_height"], "source": "default"}],
        "roof": {"type": DEFAULTS["roof"], "pitch": DEFAULTS["pitch"], "overhang": DEFAULTS["overhang"], "source": "default"},
        "labels_used": used_labels, "flags": flags,
        "footprint_px": [_r(p[0]) for p in footprint.tolist()] if footprint is not None else None,
    }


def _r(p):
    return [round(float(p[0]), 1), round(float(p[1]), 1)]


# ---------------------------------------------------------------------------- walls
def _solid_walls(ink: np.ndarray) -> np.ndarray:
    """Many plans draw walls as two thin parallel lines instead of a solid band. When there
    are almost no thick strokes, close the space between close parallel lines so those walls
    read as solid. Plans with solid walls are left as they are."""
    dist = cv2.distanceTransform(ink, cv2.DIST_L2, 3)
    thick = (dist >= 2.5).sum() / max(1, (ink > 0).sum())
    if thick > 0.08:
        return ink
    best, best_score = ink, -1.0
    for k in (5, 7, 9, 11, 13):
        hc = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((k, 1), np.uint8))
        vc = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((1, k), np.uint8))
        merged = cv2.bitwise_or(hc, vc)
        d = cv2.distanceTransform(merged, cv2.DIST_L2, 3)
        score = (d >= 2.5).sum() / max(1, (merged > 0).sum())
        if score > best_score + 0.05:
            best, best_score = merged, score
    return best


def _segments(mask: np.ndarray, horizontal: bool) -> list[Seg]:
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    out = []
    for i in range(1, n):
        x, y, w, h, area = (int(v) for v in stats[i])
        if horizontal:
            out.append(Seg(True, y + h / 2, float(x), float(x + w), area / max(w, 1)))
        else:
            out.append(Seg(False, x + w / 2, float(y), float(y + h), area / max(h, 1)))
    return out


def _thickness_threshold(ts: list[float]) -> float:
    """Walls are the thick strokes; text, dimension lines, furniture and window lines are thin."""
    if not ts:
        return 3.0
    hi = float(np.percentile(np.array(ts), 90))
    return max(3.0, hi * 0.35)


def _drop_sheet_frame(hs: list[Seg], vs: list[Seg], W: int, H: int) -> tuple[list[Seg], list[Seg]]:
    """Drawing sheets have a border and frame lines running almost the whole page; they are not walls."""
    def frame(s: Seg) -> bool:
        span = W if s.horizontal else H
        return s.length > 0.8 * span
    return [s for s in hs if not frame(s)], [s for s in vs if not frame(s)]


def _typical_thickness(segs: list[Seg]) -> float:
    """Length-weighted median wall thickness: the scale for door and window sizes."""
    pairs = sorted((s.t, s.length) for s in segs)
    half, acc = sum(l for _, l in pairs) / 2, 0.0
    for t, l in pairs:
        acc += l
        if acc >= half:
            return t
    return pairs[-1][0] if pairs else 6.0


def _main_building(walls: list[Seg], t: float, shape: tuple[int, int]) -> list[Seg]:
    """Keeps the building: walls are drawn into a mask, grown by a few wall-thicknesses so
    walls separated by doors and windows join up, and the group with the most walls wins.
    Title blocks, legends and boxes around notes sit apart from it and are dropped."""
    if not walls:
        return walls
    H, W = shape
    mask = np.zeros((H, W), np.uint8)
    for s in walls:
        _draw(mask, s, s.lo, s.hi)
    k = int(max(9, t * 8)) | 1
    grown = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    n, lab = cv2.connectedComponents(grown)
    groups: dict[int, list[Seg]] = {}
    for s in walls:
        mx, my = ((s.lo + s.hi) / 2, s.pos) if s.horizontal else (s.pos, (s.lo + s.hi) / 2)
        groups.setdefault(int(lab[min(H - 1, int(my)), min(W - 1, int(mx))]), []).append(s)
    main = max(groups.values(), key=lambda g: (len(g), sum(w.length for w in g)))
    # wings separated from the main group by wide openings still belong to the building if they
    # sit inside or against its outline; title blocks and legends sit well outside it
    def box(g):
        xs = [c for w in g for c in ((w.lo, w.hi) if w.horizontal else (w.pos,))]
        ys = [c for w in g for c in ((w.pos,) if w.horizontal else (w.lo, w.hi))]
        return min(xs), min(ys), max(xs), max(ys)
    x0, y0, x1, y1 = box(main)
    m = k
    keep = list(main)
    for g in groups.values():
        if g is main:
            continue
        gx0, gy0, gx1, gy1 = box(g)
        if gx0 >= x0 - m and gx1 <= x1 + m and gy0 >= y0 - m and gy1 <= y1 + m:
            keep += g
    return keep


def _merge(segs: list[Seg], ink: np.ndarray, tmed: float) -> list[Seg]:
    """Joins pieces of the same wall. A gap between pieces is an opening: a window when
    glazing lines cross it, a door when it is empty and door-sized. Wider empty gaps are
    open passages between rooms, so the pieces stay separate walls."""
    segs = sorted(segs, key=lambda s: s.pos)
    lines: list[list[Seg]] = []
    for s in segs:
        if lines and abs(lines[-1][-1].pos - s.pos) <= max(lines[-1][-1].t, s.t) / 2 + 2:
            lines[-1].append(s)
        else:
            lines.append([s])
    out = []
    for group in lines:
        group.sort(key=lambda s: s.lo)
        cur = Seg(group[0].horizontal, group[0].pos, group[0].lo, group[0].hi, group[0].t)
        weight = cur.length
        for s in group[1:]:
            gap = s.lo - cur.hi
            kind = _classify_gap(ink, cur, cur.hi, s.lo) if gap > 2 else None
            # typical walls are 0.15-0.23 m: doors up to about 8 thicknesses (1.2-1.8 m),
            # windows up to about 20 (3-4.6 m)
            if gap <= 2:
                pass
            elif (kind == "door" and gap <= 8 * tmed) or (kind == "window" and gap <= 20 * tmed):
                cur.gaps.append((cur.hi, s.lo, kind))
            else:
                out.append(cur)
                cur = Seg(s.horizontal, s.pos, s.lo, s.hi, s.t)
                weight = cur.length
                continue
            cur.t = (cur.t * weight + s.t * s.length) / (weight + s.length)
            cur.pos = (cur.pos * weight + s.pos * s.length) / (weight + s.length)
            weight += s.length
            cur.hi = max(cur.hi, s.hi)
        out.append(cur)
    return out


def _classify_gap(ink: np.ndarray, s: Seg, lo: float, hi: float) -> str:
    half = max(s.t / 2, 2)
    a, b = int(lo + 2), int(hi - 2)
    if b <= a:
        return "door"
    if s.horizontal:
        band = ink[int(s.pos - half):int(s.pos + half) + 1, a:b]
        lines_across = (band > 0).mean(axis=1)   # rows of ink running along the opening
    else:
        band = ink[a:b, int(s.pos - half):int(s.pos + half) + 1]
        lines_across = (band > 0).mean(axis=0)
    return "window" if band.size and (lines_across > 0.6).sum() >= 2 else "door"


def _snap(hs: list[Seg], vs: list[Seg]) -> None:
    """Extends wall ends to the centre line of the wall they meet, so corners and T-junctions close."""
    for mine, theirs in ((hs, vs), (vs, hs)):
        for s in mine:
            for end in ("lo", "hi"):
                v = getattr(s, end)
                best = None
                for o in theirs:
                    near = abs(o.pos - v) <= o.t / 2 + s.t + 3
                    across = o.lo - o.t <= s.pos <= o.hi + o.t
                    if near and across and (best is None or abs(o.pos - v) < abs(best.pos - v)):
                        best = o
                if best is not None:
                    setattr(s, end, best.pos)


def _draw(mask, s: Seg, lo, hi):
    h = max(1, int(round(s.t / 2)))
    if s.horizontal:
        cv2.rectangle(mask, (int(lo - h), int(s.pos - h)), (int(hi + h), int(s.pos + h)), 255, -1)
    else:
        cv2.rectangle(mask, (int(s.pos - h), int(lo - h)), (int(s.pos + h), int(hi + h)), 255, -1)


def _footprint(closed: np.ndarray):
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    c = max(contours, key=cv2.contourArea)
    return cv2.approxPolyDP(c, 2.0, True)


# ---------------------------------------------------------------------------- rooms
def _rooms(closed: np.ndarray, building_area_px: float) -> tuple[list[dict], np.ndarray]:
    H, W = closed.shape
    free = cv2.bitwise_not(closed)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(free, connectivity=4)
    total = building_area_px or H * W
    rooms = []
    for i in range(1, n):
        x, y, w, h, area = (int(v) for v in stats[i])
        if x == 0 or y == 0 or x + w >= W or y + h >= H:
            continue  # outside the building
        if area < total * 0.006:
            continue  # cupboards, shafts and drawing noise
        m = (lab == i).astype(np.uint8) * 255
        cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        c = max(cs, key=cv2.contourArea)
        poly = cv2.approxPolyDP(c, max(2.0, 0.01 * cv2.arcLength(c, True)), True).reshape(-1, 2)
        rooms.append({"label": i, "area_px": int(area), "polygon": [[int(px), int(py)] for px, py in poly]})
    return rooms, lab


def _assign_labels(rooms: list[dict], lab: np.ndarray, labels: list[dict], W: int, H: int) -> list[dict]:
    by_label = {r["_label"]: r for r in rooms}
    used = []
    for lb in labels:
        try:
            x, y = float(lb["x"]) * W, float(lb["y"]) * H
        except (KeyError, TypeError, ValueError):
            continue
        if not (0 <= x < W and 0 <= y < H):
            continue
        room = by_label.get(int(lab[int(y), int(x)]))
        if room is None:  # the label point sits on a wall or furniture line: look around it
            best, bd = None, 1e9
            for r in rooms:
                cx = sum(p[0] for p in r["polygon_px"]) / len(r["polygon_px"])
                cy = sum(p[1] for p in r["polygon_px"]) / len(r["polygon_px"])
                d = math.hypot(cx - x, cy - y)
                if d < bd:
                    best, bd = r, d
            room = best if bd < 0.12 * max(W, H) else None
        if room is None or room["name_source"] == "ai":
            continue
        name = str(lb.get("name") or "").strip()[:60]
        if name:
            room["name"], room["name_source"] = name.title() if name.isupper() else name, "ai"
        area = lb.get("area_m2")
        if isinstance(area, (int, float)) and 0.5 <= area <= 2000:
            room["area_label"], room["area_source"] = float(area), "ai"
        used.append({"room": room["id"], **{k: lb.get(k) for k in ("name", "area_m2", "x", "y")}})
    return used


def _scale_from_areas(rooms: list[dict], building_px: tuple[float, float]) -> dict:
    """Plans often show room areas but no dimensions. Each labelled room gives metres per pixel.
    A label matched to the wrong room gives an absurd building size, so such evidence is dropped,
    and if nothing sensible is left the scale stays unknown for the customer to set."""
    evidence, rejected = [], 0
    bw, bh = building_px
    for r in rooms:
        if r.get("area_label") and r["area_px"] > 0:
            s = math.sqrt(r["area_label"] / r["area_px"])
            tiny = r["area_px"] < 0.004 * bw * bh                      # a cupboard or shaft, not a labelled room
            if tiny or not (4 <= max(bw, bh) * s <= 80):   # a house or block between 4 m and 80 m across
                rejected += 1
                continue
            evidence.append({"room": r["id"], "name": r["name"], "area_m2": r["area_label"], "area_px": r["area_px"], "m_per_px": s})
    if not evidence:
        return {"m_per_px": None, "source": None, "evidence": [], "spread": None, "rejected": rejected}
    vals = [e["m_per_px"] for e in evidence]
    med = statistics.median(vals)
    spread = (max(vals) - min(vals)) / med if len(vals) > 1 else 0.0
    if len(vals) > 2:  # drop matches far from the rest
        keep = [e for e in evidence if abs(e["m_per_px"] - med) / med <= 0.25]
        if len(keep) >= 2 and len(keep) < len(evidence):
            rejected += len(evidence) - len(keep)
            evidence, vals = keep, [e["m_per_px"] for e in keep]
            med = statistics.median(vals)
            spread = (max(vals) - min(vals)) / med
    return {"m_per_px": med, "source": "ai", "evidence": evidence, "spread": round(spread, 3), "rejected": rejected}
