"""Pure geometry for Ollic Sketch in Blender. No bpy import, so it can be tested anywhere.

Plan units arriving from Claude are millimetres; everything returned here is metres.
Axes: x = east (right on plan), y = north (up on plan), z = up.
"""
import math

MM = 0.001


def m(v, default=None):
    return default if v is None else float(v) * MM


# ---------------------------------------------------------------- walls

def wall_pieces(wall, openings, z0):
    """Splits one wall into solid boxes around its doors and windows.

    wall: {start:{x,y}, end:{x,y}, thickness_mm, height_mm}
    openings: [{offset_mm (start of wall to opening centre), width_mm, height_mm, sill_mm, kind}]
    Returns (boxes, panels). Each box: dict(cx, cy, cz, length, thick, height, angle).
    Panels are glass or door leaves in the openings.
    """
    ax, ay = m(wall["start"]["x"]), m(wall["start"]["y"])
    bx, by = m(wall["end"]["x"]), m(wall["end"]["y"])
    length = math.hypot(bx - ax, by - ay)
    if length < 0.05:
        return [], []
    ux, uy = (bx - ax) / length, (by - ay) / length
    angle = math.atan2(uy, ux)
    t = m(wall.get("thickness_mm"), 0.225)
    h = m(wall.get("height_mm"), 3.0)
    # walls run past their end points by half a thickness so corners close
    s0, s1 = -t / 2, length + t / 2

    ops = []
    for o in openings:
        w = m(o.get("width_mm"), 0.9 if o.get("kind") == "door" else 1.2)
        kind = o.get("kind", "window")
        sill = m(o.get("sill_mm"), 0.0 if kind == "door" else 0.9)
        oh = m(o.get("height_mm"), 2.1 if kind == "door" else 1.2)
        c = m(o.get("offset_mm"), length / 2)
        c = max(w / 2 + 0.05, min(length - w / 2 - 0.05, c))
        top = min(h - 0.05, sill + oh)
        ops.append((c - w / 2, c + w / 2, sill, top, kind))
    ops.sort()

    boxes, panels = [], []

    def box(p0, p1, y0, y1):
        if p1 - p0 < 0.005 or y1 - y0 < 0.005:
            return
        mid = (p0 + p1) / 2
        boxes.append(dict(cx=ax + ux * mid, cy=ay + uy * mid, cz=z0 + (y0 + y1) / 2,
                          length=p1 - p0, thick=t, height=y1 - y0, angle=angle))

    cursor = s0
    for (o0, o1, sill, top, kind) in ops:
        if o0 < cursor:  # overlapping openings: skip the overlap
            o0 = cursor
        if o1 <= o0:
            continue
        box(cursor, o0, 0, h)
        box(o0, o1, 0, sill)
        box(o0, o1, top, h)
        mid = (o0 + o1) / 2
        panels.append(dict(kind=kind, cx=ax + ux * mid, cy=ay + uy * mid, cz=z0 + (sill + top) / 2,
                           length=(o1 - o0) - (0.04 if kind == "door" else 0.0),
                           thick=0.05 if kind == "door" else 0.02, height=top - sill, angle=angle))
        cursor = o1
    box(cursor, s1, 0, h)
    return boxes, panels


def plan_bbox(walls, outer=True):
    """Rectangle around the walls (outer faces if outer=True) in metres."""
    xs, ys = [], []
    for w in walls:
        t = m(w.get("thickness_mm"), 0.225) / 2 if outer else 0
        for p in (w["start"], w["end"]):
            xs += [m(p["x"]) - t, m(p["x"]) + t]
            ys += [m(p["y"]) - t, m(p["y"]) + t]
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def is_external(wall, walls):
    x0, y0, x1, y1 = plan_bbox(walls, outer=False)
    a, b = wall["start"], wall["end"]
    ax, ay, bx, by = m(a["x"]), m(a["y"]), m(b["x"]), m(b["y"])
    e = 0.01
    if abs(ax - bx) < e and (abs(ax - x0) < e or abs(ax - x1) < e):
        return True
    if abs(ay - by) < e and (abs(ay - y0) < e or abs(ay - y1) < e):
        return True
    return False


# ---------------------------------------------------------------- roof

def roof_mesh(bbox, base_z, style="gable", pitch_deg=25.0, overhang=0.6, ridge="auto", thickness=0.15):
    """Roof surfaces over a rectangle. Returns (verts, faces, ridge_z). Gable walls are separate (gable_walls)."""
    x0, y0, x1, y1 = bbox
    lx, ly = x1 - x0, y1 - y0
    along_x = ridge == "x" or (ridge == "auto" and lx >= ly)
    o = overhang if style != "flat" else 0.3
    tp = math.tan(math.radians(pitch_deg))

    def P(a, b, z):  # a = along ridge, b = across
        return (a, b, z) if along_x else (b, a, z)

    if along_x:
        a0, a1, b0, b1 = x0, x1, y0, y1
    else:
        a0, a1, b0, b1 = y0, y1, x0, x1
    bm, d, span = (b0 + b1) / 2, (b1 - b0) / 2, b1 - b0
    ye = base_z - o * tp
    yr = base_z + d * tp
    if style == "flat":
        z = base_z
        v = [P(a0 - o, b0 - o, z), P(a1 + o, b0 - o, z), P(a1 + o, b1 + o, z), P(a0 - o, b1 + o, z)]
        v += [(x, y, zz + thickness) for (x, y, zz) in v]
        f = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
        return v, f, z + thickness
    if style == "gable":
        v = [P(a0 - o, b0 - o, ye), P(a1 + o, b0 - o, ye), P(a1 + o, bm, yr), P(a0 - o, bm, yr),
             P(a0 - o, b1 + o, ye), P(a1 + o, b1 + o, ye)]
        f = [(0, 1, 2, 3), (4, 3, 2, 5)]
        return v, f, yr
    if style == "hip":
        r1, r2 = P(a0 + d, bm, yr), P(a1 - d, bm, yr)
        if a1 - d < a0 + d:  # square plan: pyramid
            r1 = r2 = P((a0 + a1) / 2, bm, yr)
        c = [P(a0 - o, b0 - o, ye), P(a1 + o, b0 - o, ye), P(a1 + o, b1 + o, ye), P(a0 - o, b1 + o, ye)]
        v = c + [r1, r2]
        f = [(0, 1, 5, 4), (2, 3, 4, 5), (3, 0, 4), (1, 2, 5)]
        return v, f, yr
    if style == "mono":
        yh = ye + (span + 2 * o) * tp
        v = [P(a0 - o, b1 + o, ye), P(a1 + o, b1 + o, ye), P(a1 + o, b0 - o, yh), P(a0 - o, b0 - o, yh)]
        return v, [(0, 1, 2, 3)], yh
    raise ValueError("roof style must be gable, hip, mono or flat")


def gable_walls(bbox, base_z, style, pitch_deg, ridge="auto"):
    """Triangular infill walls under gable and mono-pitch roofs. Returns list of (verts, faces)."""
    if style not in ("gable", "mono"):
        return []
    x0, y0, x1, y1 = bbox
    along_x = ridge == "x" or (ridge == "auto" and (x1 - x0) >= (y1 - y0))
    tp = math.tan(math.radians(pitch_deg))
    out = []
    if along_x:
        ends, b0, b1 = (x0, x1), y0, y1
        P = lambda a, b, z: (a, b, z)
    else:
        ends, b0, b1 = (y0, y1), x0, x1
        P = lambda a, b, z: (b, a, z)
    for a in ends:
        if style == "gable":
            bm = (b0 + b1) / 2
            out.append(([P(a, b0, base_z), P(a, b1, base_z), P(a, bm, base_z + (bm - b0) * tp)], [(0, 1, 2)]))
        else:
            out.append(([P(a, b0, base_z), P(a, b1, base_z), P(a, b0, base_z + (b1 - b0) * tp)], [(0, 1, 2)]))
    return out


# ---------------------------------------------------------------- rooms and furniture

def room_rect(room):
    if "polygon" in room and room["polygon"]:
        xs = [m(p["x"]) for p in room["polygon"]]
        ys = [m(p["y"]) for p in room["polygon"]]
        return min(xs), min(ys), max(xs), max(ys)
    return (min(m(room["x0"]), m(room["x1"])), min(m(room["y0"]), m(room["y1"])),
            max(m(room["x0"]), m(room["x1"])), max(m(room["y0"]), m(room["y1"])))


def room_kind(name):
    n = (name or "").lower()
    for kind, words in (("bedroom", ("bed", "master", "guest room", "boys", "girls")),
                        ("bath", ("toilet", "bath", "wc", "shower", "ensuite", "en-suite", "powder")),
                        ("kitchen", ("kitchen", "pantry")),
                        ("dining", ("dining",)),
                        ("living", ("living", "lounge", "sitting", "family", "parlour", "parlor")),
                        ("office", ("office", "study")),
                        ("store", ("store", "laundry", "utility")),
                        ("circulation", ("lobby", "hall", "corridor", "foyer", "passage", "porch", "veranda", "terrace"))):
        if any(wd in n for wd in words):
            return kind
    return "other"


def furniture_for(room, z0):
    """Simple furniture blocks so walkthroughs read as rooms. Returns list of dict(name, cx, cy, cz, sx, sy, sz, mat)."""
    x0, y0, x1, y1 = room_rect(room)
    w, d = x1 - x0, y1 - y0
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    k = room_kind(room.get("name"))
    out = []

    def add(name, px, py, sx, sy, sz, mat="fabric", lift=0.0):
        sx, sy = min(sx, w - 0.4), min(sy, d - 0.4)
        if sx <= 0.2 or sy <= 0.2:
            return
        out.append(dict(name=name, cx=px, cy=py, cz=z0 + lift + sz / 2, sx=sx, sy=sy, sz=sz, mat=mat))

    if k == "bedroom":
        add("Bed", cx, y1 - 1.15, 1.8, 2.0, 0.5, "fabric")
        add("Headboard", cx, y1 - 0.2, 1.9, 0.08, 1.0, "wood")
        add("Wardrobe", x0 + 0.35, cy - 0.3, 0.6, min(2.0, d - 1.0), 2.1, "wood")
    elif k == "living":
        add("Sofa", cx, y0 + 0.65, min(2.6, w - 1.0), 0.9, 0.8, "fabric")
        add("Coffee table", cx, cy, 1.2, 0.6, 0.4, "wood")
        add("Rug", cx, cy, min(3.0, w - 1.2), min(2.2, d - 1.2), 0.01, "rug")
        add("TV unit", cx, y1 - 0.3, 1.8, 0.45, 0.5, "wood")
    elif k == "dining":
        add("Dining table", cx, cy, 1.8, 0.9, 0.75, "wood")
    elif k == "kitchen":
        add("Counter", cx, y1 - 0.3, w - 0.5, 0.6, 0.9, "stone")
        add("Wall cabinets", cx, y1 - 0.18, w - 0.5, 0.35, 0.7, "wood", lift=1.5)
    elif k == "bath":
        add("WC", x0 + 0.45, y1 - 0.4, 0.4, 0.65, 0.4, "ceramic")
        add("Basin", x1 - 0.45, y1 - 0.3, 0.55, 0.45, 0.85, "ceramic")
    elif k == "office":
        add("Desk", cx, y1 - 0.45, 1.4, 0.7, 0.75, "wood")
    return out


# ---------------------------------------------------------------- tour route

def _inside(r, x, y, pad=0.0):
    return r[0] + pad <= x <= r[2] - pad and r[1] + pad <= y <= r[3] - pad


def door_links(rooms, walls, openings_by_wall):
    """Finds which rooms each door joins. Returns list of dict(x, y, nx, ny, a, b) where a/b are room indices or -1 (outside)."""
    rects = [room_rect(r) for r in rooms]
    links = []
    for wi, w in enumerate(walls):
        ax, ay, bx, by = m(w["start"]["x"]), m(w["start"]["y"]), m(w["end"]["x"]), m(w["end"]["y"])
        L = math.hypot(bx - ax, by - ay)
        if L < 0.05:
            continue
        ux, uy = (bx - ax) / L, (by - ay) / L
        nx, ny = -uy, ux
        for o in openings_by_wall.get(wi, []):
            if o.get("kind") != "door":
                continue
            c = m(o.get("offset_mm"), L / 2)
            px, py = ax + ux * c, ay + uy * c
            probe = 0.6
            side = []
            for sgn in (1, -1):
                qx, qy = px + nx * probe * sgn, py + ny * probe * sgn
                hit = next((i for i, r in enumerate(rects) if _inside(r, qx, qy)), -1)
                side.append(hit)
            links.append(dict(x=px, y=py, nx=nx, ny=ny, a=side[0], b=side[1], width=m(o.get("width_mm"), 0.9)))
    return links


def auto_route(rooms, walls, openings_by_wall):
    """Walk from outside the main entrance through every reachable room, passing through doors.

    Returns list of stops dict(x, y, hold, label) in metres; hold > 0 at room centres.
    """
    rects = [room_rect(r) for r in rooms]
    links = door_links(rooms, walls, openings_by_wall)
    if not rects:
        return []
    entrances = [l for l in links if (l["a"] == -1) != (l["b"] == -1)]
    if entrances:
        ent = max(entrances, key=lambda l: l["width"])
        inside_room = ent["b"] if ent["a"] == -1 else ent["a"]
        sgn = 1 if ent["a"] == -1 else -1  # direction of outside along the normal
        start = (ent["x"] + ent["nx"] * 2.0 * sgn, ent["y"] + ent["ny"] * 2.0 * sgn)
        path = [dict(x=start[0], y=start[1], hold=1.5, label="Entrance"),
                dict(x=ent["x"], y=ent["y"], hold=0, label=None)]
    else:
        inside_room = 0
        path = []
    adj = {i: [] for i in range(len(rects))}
    for l in links:
        if l["a"] >= 0 and l["b"] >= 0 and l["a"] != l["b"]:
            adj[l["a"]].append((l["b"], l))
            adj[l["b"]].append((l["a"], l))

    def centre(i):
        r = rects[i]
        return (r[0] + r[2]) / 2, (r[1] + r[3]) / 2

    def through(l, frm, to):
        # approach the door from inside room `frm`, cross it, step into `to`
        s = 1 if _inside(rects[frm], l["x"] + l["nx"] * 0.6, l["y"] + l["ny"] * 0.6) else -1
        return [dict(x=l["x"] + l["nx"] * 0.6 * s, y=l["y"] + l["ny"] * 0.6 * s, hold=0, label=None),
                dict(x=l["x"], y=l["y"], hold=0, label=None),
                dict(x=l["x"] - l["nx"] * 0.6 * s, y=l["y"] - l["ny"] * 0.6 * s, hold=0, label=None)]

    seen = set()

    def visit(i):
        seen.add(i)
        cx, cy = centre(i)
        path.append(dict(x=cx, y=cy, hold=3.0, label=rooms[i].get("name") or f"Room {i + 1}", room=i))
        for j, l in sorted(adj[i], key=lambda t: t[0]):
            if j in seen:
                continue
            path.extend(through(l, i, j))
            visit(j)
            path.extend(through(l, j, i))
            path.append(dict(x=cx, y=cy, hold=0, label=None))

    visit(inside_room)
    for i in range(len(rects)):  # rooms with no door found: visit directly at the end
        if i not in seen:
            cx, cy = centre(i)
            path.append(dict(x=cx, y=cy, hold=3.0, label=rooms[i].get("name") or f"Room {i + 1}", room=i))
            seen.add(i)
    # drop the trailing walk back to the start of the last room
    while path and path[-1].get("hold", 0) == 0 and len(path) > 1:
        path.pop()
    return path


def sample_path(stops, eye=1.5, speed=0.9, fps=24, z0=0.0, look_ahead=1.2):
    """Turns stops into one camera pose per frame: list of (x, y, z, yaw_radians, label_or_None).

    The camera walks at `speed` m/s, slows near stops, and at each stop with hold > 0
    pans slowly (+/- 30 degrees) for `hold` seconds.
    """
    pts = [(s["x"], s["y"]) for s in stops]
    if len(pts) < 2:
        raise ValueError("a camera path needs at least two points")
    seg = []
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        seg.append(math.hypot(x1 - x0, y1 - y0))
    total = sum(seg)
    frames = []

    def pos_at(dist):
        dist = max(0.0, min(total, dist))
        acc = 0.0
        for i, L in enumerate(seg):
            if acc + L >= dist or i == len(seg) - 1:
                t = 0 if L == 0 else (dist - acc) / L
                (x0, y0), (x1, y1) = pts[i], pts[i + 1]
                return x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
            acc += L
        return pts[-1]

    stop_at = []
    acc = 0.0
    for i, s in enumerate(stops):
        if i > 0:
            acc += seg[i - 1]
        stop_at.append(acc)

    def yaw_at(dist):
        x0, y0 = pos_at(dist)
        x1, y1 = pos_at(dist + look_ahead)
        if math.hypot(x1 - x0, y1 - y0) < 1e-6:
            x1, y1 = pos_at(dist + 0.01)
            x0, y0 = pos_at(dist - 0.01)
        return math.atan2(y1 - y0, x1 - x0)

    step = speed / fps
    dist = 0.0
    yaw_prev = yaw_at(0)
    next_stop = 0
    while True:
        while next_stop < len(stops) and stop_at[next_stop] <= dist + 1e-9:
            s = stops[next_stop]
            hold = float(s.get("hold") or 0)
            if hold > 0:
                x, y = pos_at(stop_at[next_stop])
                n = int(hold * fps)
                base = yaw_prev
                for k in range(n):
                    pan = math.radians(30) * math.sin(2 * math.pi * k / max(1, n))
                    frames.append((x, y, z0 + eye, base + pan, s.get("label")))
            next_stop += 1
        if dist >= total:
            break
        # ease: slower within 1 m of the next held stop
        nxt = next((stop_at[j] for j in range(next_stop, len(stops)) if (stops[j].get("hold") or 0) > 0), None)
        f = 1.0
        if nxt is not None:
            f = max(0.35, min(1.0, (nxt - dist) / 1.0))
        dist = min(total, dist + step * f)
        x, y = pos_at(dist)
        target = yaw_at(dist)
        dyaw = (target - yaw_prev + math.pi) % (2 * math.pi) - math.pi
        yaw_prev = yaw_prev + dyaw * 0.15
        frames.append((x, y, z0 + eye, yaw_prev, None))
    return frames


# ---------------------------------------------------------------- light

def sun_for_hour(hour, latitude=6.5):
    """Simple sun model. Returns dict(elevation_deg, azimuth_deg, strength, color, sky, night)."""
    hour = max(0.0, min(24.0, float(hour)))
    day = 6.0 <= hour <= 18.8
    t = (hour - 6.0) / 12.8
    elevation = max(-10.0, 90.0 * math.sin(math.pi * t) * math.cos(math.radians(latitude))) if day else -10.0
    azimuth = 90.0 + 180.0 * t  # east in the morning, west in the evening
    if not day:
        return dict(elevation_deg=-10, azimuth_deg=azimuth, strength=0.0, color=(0.6, 0.7, 1.0),
                    sky=(0.01, 0.015, 0.035), sky_strength=0.15, night=True)
    low = max(0.0, 1.0 - elevation / 25.0)  # 1 near the horizon
    color = (1.0, 1.0 - 0.35 * low, 1.0 - 0.65 * low)
    sky = (0.45 + 0.4 * low, 0.6 - 0.1 * low, 0.85 - 0.45 * low)
    return dict(elevation_deg=elevation, azimuth_deg=azimuth, strength=1.5 + 3.0 * (1 - low),
                color=color, sky=sky, sky_strength=0.4 + 0.6 * (1 - low), night=False)


# ---------------------------------------------------------------- construction stages

STAGES = ["foundation", "slab", "structure", "walls", "floors", "roof", "openings", "mep", "finishes", "furniture"]

STAGE_WORDS = {
    "foundation": ("foundation", "footing", "pad", "strip"),
    "slab": ("ground slab", "ground floor slab", "oversite"),
    "structure": ("column", "beam", "framing", "lintel", "ring beam", "structural"),
    "walls": ("wall", "parapet", "gable"),
    "floors": ("floor", "slab", "stair", "landing"),
    "roof": ("roof", "fascia", "gutter", "truss"),
    "openings": ("door", "window", "glass", "glazing", "curtain", "flush", "single-", "double-", "sliding", "casement", "louvre", "louver", "fixed"),
    "mep": ("pipe", "duct", "conduit", "cable", "plumbing", "sanitary", "light fixture", "lighting", "socket", "panel board", "mechanical"),
    "finishes": ("ceiling", "tile", "skirting", "finish", "paint", "rug"),
    "furniture": ("furniture", "bed", "sofa", "table", "chair", "desk", "wardrobe", "counter", "cabinet", "basin", "wc", "toilet", "plant", "casework"),
}


def stage_of(name, collection=""):
    """Construction stage for an object, from its collection or name (works for Revit FBX names too)."""
    for text in ((collection or "").lower(), (name or "").lower()):
        if not text:
            continue
        for st in STAGES:
            if text.startswith("ollic " + st) or text == st:
                return st
        # check specific words first so 'ground slab' beats 'slab' and 'wall cabinets' is furniture
        for st in ("slab", "furniture", "openings", "mep", "roof", "structure", "foundation", "finishes", "floors", "walls"):
            if any(wd in text for wd in STAGE_WORDS[st]):
                return st
    return "walls"
