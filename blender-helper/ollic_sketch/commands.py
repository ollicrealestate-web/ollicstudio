"""Commands Claude can run in Blender through Ollic Sketch. Lengths in from Claude are mm; Blender works in metres."""
import base64
import json
import math
import os
import time

import bpy
from mathutils import Vector

from . import plan as P

COLL_PREFIX = "Ollic "
ADDON_DIR = os.path.dirname(os.path.abspath(__file__))


# ======================================================================= helpers

def _scene():
    return bpy.context.scene


def _out_dir(sub=""):
    base = os.path.join(os.path.expanduser("~"), "Documents", "Ollic Sketch", "Exports")
    d = os.path.join(base, sub) if sub else base
    os.makedirs(d, exist_ok=True)
    return d


def _coll(name):
    full = COLL_PREFIX + name
    c = bpy.data.collections.get(full)
    if c is None:
        c = bpy.data.collections.new(full)
    if c.name not in _scene().collection.children:
        _scene().collection.children.link(c)
    return c


def _set_input(node, names, value):
    for n in names:
        if n in node.inputs:
            try:
                node.inputs[n].default_value = value
                return True
            except Exception:
                pass
    return False


def _hex(h, default=(0.8, 0.8, 0.8)):
    try:
        h = h.lstrip("#")
        r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
        return (r ** 2.2, g ** 2.2, b ** 2.2)  # sRGB to linear
    except Exception:
        return default


PRESETS = {
    # key: (base colour linear, roughness, metallic, transmission)
    "wall_ext": ((0.80, 0.78, 0.72), 0.85, 0.0, 0.0),
    "wall_int": ((0.86, 0.85, 0.82), 0.9, 0.0, 0.0),
    "slab": ((0.42, 0.42, 0.40), 0.95, 0.0, 0.0),
    "foundation": ((0.35, 0.34, 0.32), 0.95, 0.0, 0.0),
    "floor_tiles": ((0.72, 0.70, 0.66), 0.25, 0.0, 0.0),
    "floor_wood": ((0.38, 0.22, 0.12), 0.45, 0.0, 0.0),
    "floor_concrete": ((0.45, 0.45, 0.44), 0.6, 0.0, 0.0),
    "ceiling": ((0.9, 0.9, 0.88), 0.9, 0.0, 0.0),
    "glass": ((0.75, 0.85, 0.9), 0.05, 0.0, 0.95),
    "door": ((0.30, 0.17, 0.08), 0.5, 0.0, 0.0),
    "frame": ((0.12, 0.12, 0.12), 0.4, 0.6, 0.0),
    "roof": ((0.05, 0.06, 0.07), 0.45, 0.6, 0.0),
    "fabric": ((0.55, 0.50, 0.45), 0.9, 0.0, 0.0),
    "wood": ((0.32, 0.19, 0.10), 0.5, 0.0, 0.0),
    "stone": ((0.75, 0.74, 0.72), 0.2, 0.0, 0.0),
    "ceramic": ((0.92, 0.92, 0.92), 0.1, 0.0, 0.0),
    "rug": ((0.10, 0.25, 0.30), 0.95, 0.0, 0.0),
    "grass": ((0.10, 0.20, 0.06), 0.95, 0.0, 0.0),
    "stair": ((0.62, 0.60, 0.56), 0.4, 0.0, 0.0),
    "clay": ((0.78, 0.78, 0.77), 0.8, 0.0, 0.0),
    "clay_glass": ((0.85, 0.88, 0.9), 0.1, 0.0, 0.6),
}


def _material(key, color=None):
    name = "Ollic " + key + ("" if color is None else "-%02x%02x%02x" % tuple(int(255 * c) for c in color))
    mat = bpy.data.materials.get(name)
    base, rough, metal, trans = PRESETS.get(key, PRESETS["clay"])
    if color is not None:
        base = color
    if mat is None:
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is not None:
        _set_input(bsdf, ["Base Color"], (*base, 1.0))
        _set_input(bsdf, ["Roughness"], rough)
        _set_input(bsdf, ["Metallic"], metal)
        if trans:
            _set_input(bsdf, ["Transmission Weight", "Transmission"], trans)
            _set_input(bsdf, ["Alpha"], 0.35)
            for attr, val in (("blend_method", "BLEND"), ("surface_render_method", "BLENDED")):
                try:
                    setattr(mat, attr, val)
                except Exception:
                    pass
    mat.diffuse_color = (*base, 1.0)
    return mat


def _mesh_obj(name, verts, faces, coll, mat_key, stage, loc=(0, 0, 0), rot_z=0.0):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    me.update()
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    ob.rotation_euler = (0, 0, rot_z)
    coll.objects.link(ob)
    ob.data.materials.append(_material(mat_key))
    ob["ollic_mat"] = mat_key
    ob["ollic_stage"] = stage
    return ob


def _box(name, cx, cy, cz, sx, sy, sz, angle, coll, mat_key, stage):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    v = [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz),
         (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return _mesh_obj(name, v, f, coll, mat_key, stage, (cx, cy, cz), angle)


def _plan():
    raw = _scene().get("ollic_plan")
    return json.loads(raw) if raw else None


def _mesh_objects():
    return [o for o in _scene().objects if o.type == "MESH"]


def _bounds(objs=None):
    objs = objs if objs is not None else [o for o in _mesh_objects() if not o.name.startswith("Ollic Site")]
    xs, ys, zs = [], [], []
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            xs.append(w.x); ys.append(w.y); zs.append(w.z)
    if not xs:
        return None
    return min(xs), min(ys), min(zs), max(xs), max(ys), max(zs)


# ======================================================================= scene info

def get_scene_info(a):
    s = _scene()
    b = _bounds()
    by_stage = {}
    for o in _mesh_objects():
        st = o.get("ollic_stage") or P.stage_of(o.name, o.users_collection[0].name if o.users_collection else "")
        by_stage[st] = by_stage.get(st, 0) + 1
    p = _plan()
    return {
        "blender_version": bpy.app.version_string,
        "file": bpy.data.filepath or "(not saved)",
        "objects": len(s.objects),
        "meshes_by_construction_stage": by_stage,
        "size_m": None if not b else {"x": round(b[3] - b[0], 2), "y": round(b[4] - b[1], 2), "z": round(b[5] - b[2], 2)},
        "rooms": [r.get("name") for lv in (p or {}).get("levels", []) for r in lv.get("rooms", [])],
        "has_walk_camera": "Ollic Walk Camera" in bpy.data.objects,
        "walk_seconds": round(s.get("ollic_walk_frames", 0) / max(1, s.render.fps), 1),
        "time_of_day": s.get("ollic_hour"),
        "render_jobs": [{k: j[k] for k in ("id", "kind", "status", "done", "total", "file")} for j in _jobs.values()],
    }


# ======================================================================= build from plan

def _clear_ollic():
    for c in list(bpy.data.collections):
        if c.name.startswith(COLL_PREFIX):
            for o in list(c.objects):
                bpy.data.objects.remove(o, do_unlink=True)
            bpy.data.collections.remove(c)
    for name in ("Ollic Walk Camera", "Ollic Orbit Camera", "Ollic Still Camera", "Ollic Sun", "Ollic Path"):
        o = bpy.data.objects.get(name)
        if o:
            bpy.data.objects.remove(o, do_unlink=True)


def _remove_starter_cube():
    """Blender's new-file cube would sit inside the house; remove it only if it is untouched."""
    o = bpy.data.objects.get("Cube")
    if (o and o.type == "MESH" and len(o.data.vertices) == 8 and not o.modifiers
            and tuple(round(v, 4) for v in o.location) == (0, 0, 0)
            and tuple(round(v, 4) for v in o.scale) == (1, 1, 1)
            and tuple(round(v, 4) for v in o.rotation_euler) == (0, 0, 0)):
        bpy.data.objects.remove(o, do_unlink=True)


def build_from_plan(a):
    """Builds walls, openings, floors, ceilings, stairs, roof, foundations, site and furniture from a dimensioned plan."""
    levels = a.get("levels") or []
    if not levels:
        raise ValueError("levels is required: [{name, elevation_mm, height_mm, walls, openings, rooms, stairs}]")
    if a.get("clear", True):
        _clear_ollic()
    _remove_starter_cube()
    C = {k: _coll(k) for k in ("Foundation", "Slab", "Walls", "Openings", "Floors", "Stairs", "Roof", "Finishes", "Furniture", "Site")}
    counts = dict(walls=0, openings=0, rooms=0, furniture=0, stairs=0)
    top = None
    for li, lv in enumerate(levels):
        z0 = P.m(lv.get("elevation_mm"), 0.0)
        h = P.m(lv.get("height_mm"), 3.0)
        walls = lv.get("walls") or []
        if not walls:
            continue
        by_wall = {}
        for o in lv.get("openings") or []:
            by_wall.setdefault(int(o.get("wall", -1)), []).append(o)
        for wi, w in enumerate(walls):
            w = dict(w)
            w.setdefault("height_mm", h * 1000)
            ext = P.is_external(w, walls)
            boxes, panels = P.wall_pieces(w, by_wall.get(wi, []), z0)
            for k, bx in enumerate(boxes):
                _box(f"Wall L{li}-{wi}.{k}", bx["cx"], bx["cy"], bx["cz"], bx["length"], bx["thick"], bx["height"], bx["angle"],
                     C["Walls"], "wall_ext" if ext else "wall_int", "walls")
            for k, pn in enumerate(panels):
                key = "glass" if pn["kind"] == "window" else "door"
                _box(f"{'Window' if key == 'glass' else 'Door'} L{li}-{wi}.{k}", pn["cx"], pn["cy"], pn["cz"],
                     pn["length"], pn["thick"], pn["height"], pn["angle"], C["Openings"], key, "openings")
                counts["openings"] += 1
            counts["walls"] += 1
            if li == 0:  # strip foundation under ground floor walls
                sx, sy, ex, ey = P.m(w["start"]["x"]), P.m(w["start"]["y"]), P.m(w["end"]["x"]), P.m(w["end"]["y"])
                L = math.hypot(ex - sx, ey - sy)
                ang = math.atan2(ey - sy, ex - sx)
                _box(f"Foundation {wi}", (sx + ex) / 2, (sy + ey) / 2, z0 - 0.45, L + 0.6, 0.675 if ext else 0.45, 0.6, ang,
                     C["Foundation"], "foundation", "foundation")
        bb = P.plan_bbox(walls)
        x0, y0, x1, y1 = bb
        slab_name = "Ground slab" if li == 0 else f"Floor slab L{li}"
        _box(slab_name, (x0 + x1) / 2, (y0 + y1) / 2, z0 - 0.075, x1 - x0, y1 - y0, 0.15, 0,
             C["Slab"] if li == 0 else C["Floors"], "slab", "slab" if li == 0 else "floors")
        for ri, r in enumerate(lv.get("rooms") or []):
            rx0, ry0, rx1, ry1 = P.room_rect(r)
            kind = P.room_kind(r.get("name"))
            fkey = {"wood": "floor_wood", "concrete": "floor_concrete"}.get(r.get("floor"), "floor_wood" if kind == "bedroom" else "floor_tiles")
            _box(f"Floor finish {r.get('name', ri)} L{li}", (rx0 + rx1) / 2, (ry0 + ry1) / 2, z0 + 0.005, rx1 - rx0, ry1 - ry0, 0.01, 0,
                 C["Finishes"], fkey, "finishes")
            _box(f"Ceiling {r.get('name', ri)} L{li}", (rx0 + rx1) / 2, (ry0 + ry1) / 2, z0 + h - 0.01, rx1 - rx0, ry1 - ry0, 0.02, 0,
                 C["Finishes"], "ceiling", "finishes")
            for f in P.furniture_for(r, z0):
                _box(f"{f['name']} ({r.get('name', ri)})", f["cx"], f["cy"], f["cz"], f["sx"], f["sy"], f["sz"], 0,
                     C["Furniture"], f["mat"], "furniture")
                counts["furniture"] += 1
            counts["rooms"] += 1
        for si, st in enumerate(lv.get("stairs") or []):
            _stair(st, z0, h + 0.15, C["Stairs"], li, si)
            counts["stairs"] += 1
        top = (z0 + h, bb)
    roof = a.get("roof") or {}
    style = roof.get("style", "gable")
    if top and style != "none":
        base_z, bb = top
        v, f, _ridge_z = P.roof_mesh(bb, base_z, style, float(roof.get("pitch_degrees", 25)),
                                     P.m(roof.get("overhang_mm"), 0.6), roof.get("ridge", "auto"))
        ob = _mesh_obj("Roof", v, f, C["Roof"], "roof", "roof")
        if style != "flat":
            ob.modifiers.new("thickness", "SOLIDIFY").thickness = 0.06
        if roof.get("color"):
            ob.data.materials[0] = _material("roof", _hex(roof["color"]))
        for k, (gv, gf) in enumerate(P.gable_walls(bb, base_z, style, float(roof.get("pitch_degrees", 25)), roof.get("ridge", "auto"))):
            g = _mesh_obj(f"Gable wall {k}", gv, gf, C["Walls"], "wall_ext", "walls")
            g.modifiers.new("thickness", "SOLIDIFY").thickness = 0.225
    if a.get("site", True):
        b = P.plan_bbox(levels[0].get("walls") or []) or (0, 0, 0, 0)
        _box("Ollic Site ground", (b[0] + b[2]) / 2, (b[1] + b[3]) / 2, -0.16, 400, 400, 0.02, 0, C["Site"], "grass", "site")
    _scene()["ollic_plan"] = json.dumps(a)
    _scene().unit_settings.system = "METRIC"
    if "Ollic Sun" not in bpy.data.objects:
        set_time_of_day({"hour": 15})
    return {"built": counts, "roof": style, "note": "Each part sits in an 'Ollic ...' collection (Walls, Openings, Roof, Furniture...)."}


def _stair(st, z0, ff, coll, li, si):
    rise_n = max(2, math.ceil(ff / 0.175))
    rise = ff / rise_n
    going = 0.25
    w = P.m(st.get("width_mm"), 1.0)
    d = {"up": (0, 1), "down": (0, -1), "left": (-1, 0), "right": (1, 0)}.get(st.get("direction", "up"), (0, 1))
    ang = math.atan2(d[1], d[0])
    x, y = P.m(st["x"]), P.m(st["y"])
    for k in range(rise_n - 1):
        cx, cy = x + d[0] * (k + 0.5) * going, y + d[1] * (k + 0.5) * going
        hgt = (k + 1) * rise
        _box(f"Stair L{li}-{si} step {k + 1}", cx, cy, z0 + hgt / 2, going, w, hgt, ang, coll, "stair", "floors")


# ======================================================================= import from Revit or other tools

IMPORTERS = {
    ".fbx": lambda p: bpy.ops.import_scene.fbx(filepath=p),
    ".glb": lambda p: bpy.ops.import_scene.gltf(filepath=p),
    ".gltf": lambda p: bpy.ops.import_scene.gltf(filepath=p),
    ".obj": lambda p: bpy.ops.wm.obj_import(filepath=p),
}


def import_model(a):
    path = a.get("path")
    if not path or not os.path.exists(path):
        raise ValueError(f"File not found: {path}")
    ext = os.path.splitext(path)[1].lower()
    if ext not in IMPORTERS:
        raise ValueError("Use an .fbx, .glb, .gltf or .obj file. From Revit, use revit_export_fbx.")
    if a.get("clear", True):
        _clear_ollic()
    before = set(bpy.data.objects)
    IMPORTERS[ext](path)
    new = [o for o in bpy.data.objects if o not in before]
    coll = _coll("Imported")
    for o in new:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        coll.objects.link(o)
    meshes = [o for o in new if o.type == "MESH"]
    b = _bounds(meshes)
    if not b:
        raise ValueError("The file has no 3D geometry.")
    size = max(b[3] - b[0], b[4] - b[1], b[5] - b[2])
    unit = a.get("unit", "auto")
    scale = {"m": 1.0, "mm": 0.001, "cm": 0.01, "ft": 0.3048, "in": 0.0254}.get(unit)
    if scale is None:
        scale = 0.001 if size > 400 else 1.0
    if scale != 1.0:
        for o in new:
            if o.parent is None:
                o.scale = [s * scale for s in o.scale]
                o.location = [v * scale for v in o.location]
        bpy.context.view_layer.update()
    for o in meshes:
        chain, p = [], o.parent
        while p:
            chain.append(p.name)
            p = p.parent
        o["ollic_stage"] = P.stage_of(o.name, " ".join(chain))
        o["ollic_orig"] = json.dumps([m.name if m else "" for m in o.data.materials])
    b = _bounds(meshes)
    stages = {}
    for o in meshes:
        stages[o["ollic_stage"]] = stages.get(o["ollic_stage"], 0) + 1
    _scene()["ollic_plan"] = ""
    return {"objects": len(new), "meshes": len(meshes), "scale_applied": scale,
            "size_m": {"x": round(b[3] - b[0], 2), "y": round(b[4] - b[1], 2), "z": round(b[5] - b[2], 2)},
            "meshes_by_construction_stage": stages,
            "check": "If the size looks wrong (a house is usually 8-40 m across), import again with unit set to mm, cm, ft or m."}


# ======================================================================= look

def apply_style(a):
    """clay = plain grey model (guide for AI video, clear massing); realistic = materials."""
    style = a.get("style", "realistic")
    wall = _hex(a["wall_color"]) if a.get("wall_color") else None
    roof = _hex(a["roof_color"]) if a.get("roof_color") else None
    floor = a.get("floor")
    n = 0
    for o in _mesh_objects():
        if o.data is None or not hasattr(o.data, "materials"):
            continue
        key = o.get("ollic_mat")
        if style == "clay":
            mk = "clay_glass" if key == "glass" else ("grass" if key == "grass" else "clay")
            mats = [_material(mk)] * max(1, len(o.data.materials))
        elif key:
            if key in ("wall_ext", "wall_int") and wall:
                mats = [_material(key, wall)]
            elif key == "roof" and roof:
                mats = [_material("roof", roof)]
            elif key in ("floor_tiles", "floor_wood", "floor_concrete") and floor:
                mats = [_material("floor_" + floor)]
            else:
                mats = [_material(key)]
        else:
            names = json.loads(o.get("ollic_orig") or "[]")
            mats = [bpy.data.materials.get(nm) for nm in names] or [None]
        o.data.materials.clear()
        for m_ in mats:
            o.data.materials.append(m_)
        n += 1
    _scene()["ollic_style"] = style
    return {"style": style, "objects": n}


def set_time_of_day(a):
    hour = float(a.get("hour", 15))
    lat = float(a.get("latitude", 6.5))
    north = float(a.get("north_degrees", 0))
    s = P.sun_for_hour(hour, lat)
    sun = bpy.data.objects.get("Ollic Sun")
    if sun is None:
        data = bpy.data.lights.new("Ollic Sun", "SUN")
        sun = bpy.data.objects.new("Ollic Sun", data)
        _scene().collection.objects.link(sun)
    sun.data.energy = s["strength"]
    sun.data.color = s["color"]
    sun.data.angle = math.radians(1.5)
    e, az = max(s["elevation_deg"], 1.0), s["azimuth_deg"]
    sun.rotation_euler = (math.radians(90 - e), 0, math.radians(180 - az + north))
    sun.hide_render = s["night"]
    world = _scene().world or bpy.data.worlds.new("Ollic World")
    _scene().world = world
    world.use_nodes = True
    bg = next((n for n in world.node_tree.nodes if n.type == "BACKGROUND"), None)
    if bg:
        bg.inputs[0].default_value = (*s["sky"], 1.0)
        bg.inputs[1].default_value = s["sky_strength"]
    lights = _coll("Lights")
    for o in list(lights.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    p = _plan()
    if p and (s["night"] or hour >= 17.5):
        for lv in p.get("levels", []):
            z0 = P.m(lv.get("elevation_mm"), 0.0)
            h = P.m(lv.get("height_mm"), 3.0)
            for r in lv.get("rooms") or []:
                x0, y0, x1, y1 = P.room_rect(r)
                ld = bpy.data.lights.new(f"Light {r.get('name')}", "POINT")
                ld.energy = 60 + 6 * (x1 - x0) * (y1 - y0)
                ld.color = (1.0, 0.82, 0.6)
                ld.shadow_soft_size = 0.4
                lo = bpy.data.objects.new(ld.name, ld)
                lo.location = ((x0 + x1) / 2, (y0 + y1) / 2, z0 + h - 0.35)
                lights.objects.link(lo)
    _scene()["ollic_hour"] = hour
    return {"hour": hour, "sun_elevation_deg": round(s["elevation_deg"], 1), "night": s["night"],
            "room_lights": len(lights.objects)}


# ======================================================================= cameras

def _camera(name, lens=18):
    ob = bpy.data.objects.get(name)
    if ob is None:
        cam = bpy.data.cameras.new(name)
        ob = bpy.data.objects.new(name, cam)
        _scene().collection.objects.link(ob)
    ob.data.lens = lens
    ob.data.clip_start = 0.05
    ob.data.clip_end = 1000
    ob.animation_data_clear()
    return ob


def _level(level):
    p = _plan()
    if not p:
        return None
    lvls = p.get("levels", [])
    if isinstance(level, str) and not level.isdigit():
        return next((l for l in lvls if (l.get("name") or "").lower() == level.lower()), None)
    i = int(level or 0)
    return lvls[i] if 0 <= i < len(lvls) else None


def _auto_stops(level=0):
    lv = _level(level)
    if lv is None:
        raise ValueError("Automatic paths need a model built with blender_build_from_plan. For imported models, give the path points.")
    by_wall = {}
    for o in lv.get("openings") or []:
        by_wall.setdefault(int(o.get("wall", -1)), []).append(o)
    stops = P.auto_route(lv.get("rooms") or [], lv.get("walls") or [], by_wall)
    if len(stops) < 2:
        raise ValueError("Could not find a route: add rooms and doors to the plan, or give the path points.")
    return stops


def set_camera_path(a):
    """Camera walks at eye height along the given points (mm) or an automatic route through every room."""
    fps = int(a.get("fps", 24))
    _scene().render.fps = fps
    level = a.get("level", 0)
    if a.get("points"):
        stops = [dict(x=P.m(pt["x"]), y=P.m(pt["y"]), hold=float(pt.get("hold_seconds", 0)), label=pt.get("label")) for pt in a["points"]]
    else:
        stops = _auto_stops(level)
    lv = _level(level)
    z0 = P.m((lv or {}).get("elevation_mm"), 0.0)
    eye = P.m(a.get("eye_height_mm"), 1.5)
    frames = P.sample_path(stops, eye=eye, speed=float(a.get("speed_m_per_s", 0.9)), fps=fps, z0=z0)
    cam = _camera("Ollic Walk Camera", lens=float(a.get("lens_mm", 18)))
    for i, (x, y, z, yaw, _label) in enumerate(frames, start=1):
        cam.location = (x, y, z)
        cam.rotation_euler = (math.radians(90), 0, yaw - math.pi / 2)
        cam.keyframe_insert("location", frame=i)
        cam.keyframe_insert("rotation_euler", frame=i)
    s = _scene()
    s["ollic_walk_frames"] = len(frames)
    s["ollic_path"] = json.dumps({"z0": z0, "eye": eye, "stops": stops})
    old = bpy.data.objects.get("Ollic Path")
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    cu = bpy.data.curves.new("Ollic Path", "CURVE")
    cu.dimensions = "3D"
    sp = cu.splines.new("POLY")
    sp.points.add(len(stops) - 1)
    for i, st in enumerate(stops):
        sp.points[i].co = (st["x"], st["y"], z0 + 0.05, 1)
    po = bpy.data.objects.new("Ollic Path", cu)
    po.hide_render = True
    s.collection.objects.link(po)
    s.camera = cam
    labels = [st["label"] for st in stops if st.get("label") and st.get("hold", 0) > 0]
    return {"frames": len(frames), "seconds": round(len(frames) / fps, 1), "stops": labels}


def _orbit_camera(seconds, fps, start=1):
    b = _bounds() or (0, 0, 0, 10, 10, 6)
    cx, cy = (b[0] + b[3]) / 2, (b[1] + b[4]) / 2
    r = max(b[3] - b[0], b[4] - b[1]) * 1.25 + 6
    hgt = max(b[5], 4) + r * 0.55
    cam = _camera("Ollic Orbit Camera", lens=30)
    n = max(2, int(seconds * fps))
    for i in range(n):
        t = -math.pi / 2 - math.pi * 0.25 + (math.pi * 0.9) * i / (n - 1)
        x, y = cx + r * math.cos(t), cy + r * math.sin(t)
        cam.location = (x, y, hgt)
        d = (cx - x, cy - y, (b[5] * 0.3) - hgt)
        yaw = math.atan2(d[1], d[0])
        pitch = math.atan2(d[2], math.hypot(d[0], d[1]))
        cam.rotation_euler = (math.radians(90) + pitch, 0, yaw - math.pi / 2)
        cam.keyframe_insert("location", frame=start + i)
        cam.keyframe_insert("rotation_euler", frame=start + i)
    return cam


# ======================================================================= construction film

def _clear_construction():
    for o in _mesh_objects():
        if o.get("ollic_build"):
            o.animation_data_clear()
            del o["ollic_build"]
        o.hide_render = False
        o.hide_viewport = False


def build_construction_animation(a):
    """Objects appear stage by stage: foundation, slab, structure, walls, floors, roof, openings, MEP, finishes, furniture."""
    fps = int(a.get("fps", 24))
    sec = float(a.get("seconds_per_stage", 3.0))
    order = a.get("stages") or P.STAGES
    _clear_construction()
    groups = {st: [] for st in order}
    for o in _mesh_objects():
        st = o.get("ollic_stage") or P.stage_of(o.name)
        if st == "site":
            continue
        groups.setdefault(st, []).append(o)
    frame = 1 + fps  # one second of empty site first
    per = max(2, int(sec * fps))
    shown = []
    for st in order:
        objs = sorted(groups.get(st, []), key=lambda o: (round(o.matrix_world.translation.z, 1), o.matrix_world.translation.x, o.matrix_world.translation.y))
        if not objs:
            continue
        for i, o in enumerate(objs):
            appear = frame + int(per * 0.8 * i / max(1, len(objs)))
            o["ollic_build"] = 1
            for prop in ("hide_render", "hide_viewport"):
                setattr(o, prop, True)
                o.keyframe_insert(prop, frame=1)
                setattr(o, prop, False)
                o.keyframe_insert(prop, frame=appear)
        shown.append({"stage": st, "objects": len(objs), "starts_at_s": round((frame - 1) / fps, 1)})
        frame += per
    end = frame + 2 * fps
    _orbit_camera((end - 1) / fps, fps)
    s = _scene()
    s["ollic_build_frames"] = end
    s.render.fps = fps
    return {"stages": shown, "seconds": round(end / fps, 1)}


# ======================================================================= rendering

_jobs = {}


def _engine(quality):
    items = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    if quality == "cycles" and "CYCLES" in items:
        return "CYCLES"
    for e in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        if e in items:
            return e
    return items[0]


def _setup_render(quality, width=None, height=None):
    s = _scene()
    r = s.render
    r.engine = _engine("cycles" if quality == "cycles" else "eevee")
    if quality == "final":
        r.resolution_x, r.resolution_y = int(width or 1920), int(height or 1080)
    else:
        r.resolution_x, r.resolution_y = int(width or 1280), int(height or 720)
    r.resolution_percentage = 100
    try:
        r.image_settings.media_type = "IMAGE"
    except Exception:
        pass
    r.image_settings.file_format = "PNG"
    if r.engine == "CYCLES":
        s.cycles.samples = 128 if quality == "final" else 32
        try:
            s.cycles.use_denoising = True
        except Exception:
            pass
    else:
        ee = s.eevee
        for attr, val in (("taa_render_samples", 64 if quality == "final" else 16),
                          ("use_shadows", True), ("use_raytracing", quality == "final"), ("use_gtao", True)):
            try:
                setattr(ee, attr, val)
            except Exception:
                pass
    return r


def render_video(a):
    """Starts a render job. kind = walkthrough or construction. Use render_status to follow it."""
    kind = a.get("kind", "walkthrough")
    s = _scene()
    if a.get("style"):
        apply_style({"style": a["style"]})
    if a.get("hour") is not None:
        set_time_of_day({"hour": a["hour"]})
    if kind == "walkthrough":
        if "Ollic Walk Camera" not in bpy.data.objects:
            set_camera_path({})
        _clear_construction()
        s.camera = bpy.data.objects["Ollic Walk Camera"]
        total = int(s.get("ollic_walk_frames", 0))
    elif kind == "construction":
        build_construction_animation({"seconds_per_stage": a.get("seconds_per_stage", 3.0)})
        s.camera = bpy.data.objects["Ollic Orbit Camera"]
        total = int(s.get("ollic_build_frames", 0))
    else:
        raise ValueError("kind must be walkthrough or construction")
    if a.get("max_seconds"):
        total = min(total, int(float(a["max_seconds"]) * s.render.fps))
    quality = a.get("quality", "preview")
    _setup_render(quality, a.get("width"), a.get("height"))
    name = a.get("name") or f"{kind}-{time.strftime('%Y%m%d-%H%M%S')}"
    folder = a.get("folder") or _out_dir(name)
    os.makedirs(os.path.join(folder, "frames"), exist_ok=True)
    job = {"id": name, "kind": kind, "status": "rendering", "done": 0, "total": total, "folder": folder,
           "file": None, "camera": s.camera.name, "started": time.time(), "error": None}
    _jobs[name] = job
    if a.get("wait"):
        while _advance(job):
            pass
    out = {k: job[k] for k in ("id", "kind", "status", "done", "total", "folder", "file", "error")}
    out["estimate"] = f"about {max(1, round(total * (6 if quality == 'final' else 1.5) / 60))} minutes on a typical PC"
    return out


def _advance(job):
    """Renders one frame; encodes the video when all frames are done. Returns True while work remains."""
    if job["status"] != "rendering":
        return False
    s = _scene()
    try:
        if job["done"] < job["total"]:
            f = job["done"] + 1
            s.camera = bpy.data.objects[job["camera"]]
            s.frame_set(f)
            s.render.filepath = os.path.join(job["folder"], "frames", f"{f:05d}.png")
            bpy.ops.render.render(write_still=True)
            job["done"] = f
            return True
        job["status"] = "encoding"
        job["file"] = _encode(job)
        job["status"] = "done"
    except Exception as e:
        job["status"] = "failed"
        job["error"] = str(e)
    return False


def step_jobs():
    busy = False
    for job in list(_jobs.values()):
        if job["status"] == "rendering":
            busy = _advance(job) or busy
            break  # one frame per tick keeps Blender responsive
    return busy


def _encode(job):
    frames_dir = os.path.join(job["folder"], "frames")
    files = sorted(f for f in os.listdir(frames_dir) if f.endswith(".png"))
    if not files:
        raise RuntimeError("no frames were rendered")
    src = _scene()
    enc = bpy.data.scenes.new("Ollic Encode")
    try:
        enc.render.fps = src.render.fps
        enc.render.resolution_x, enc.render.resolution_y = src.render.resolution_x, src.render.resolution_y
        enc.render.resolution_percentage = 100
        enc.frame_start, enc.frame_end = 1, len(files)
        se = enc.sequence_editor_create()
        strips = getattr(se, "strips", None)
        if strips is None:
            strips = se.sequences
        strip = strips.new_image(name="frames", filepath=os.path.join(frames_dir, files[0]), channel=1, frame_start=1)
        for fn in files[1:]:
            strip.elements.append(fn)
        rs = enc.render
        try:
            rs.image_settings.media_type = "VIDEO"
        except Exception:
            pass
        rs.image_settings.file_format = "FFMPEG"
        rs.ffmpeg.format = "MPEG4"
        rs.ffmpeg.codec = "H264"
        try:
            rs.ffmpeg.constant_rate_factor = "HIGH"
        except Exception:
            pass
        out = os.path.join(job["folder"], job["id"] + ".mp4")
        rs.filepath = out
        try:
            rs.use_file_extension = False
        except Exception:
            pass
        bpy.ops.render.render(animation=True, scene=enc.name)
        return out if os.path.exists(out) else frames_dir
    finally:
        bpy.data.scenes.remove(enc)


def render_status(a):
    jid = a.get("id")
    jobs = [_jobs[jid]] if jid and jid in _jobs else list(_jobs.values())
    out = []
    for j in jobs:
        el = time.time() - j["started"]
        left = (el / j["done"] * (j["total"] - j["done"])) if j["done"] else None
        row = {k: j[k] for k in ("id", "kind", "status", "done", "total", "file", "error", "folder")}
        row["minutes_left"] = None if left is None or j["status"] != "rendering" else round(left / 60, 1)
        out.append(row)
    return {"jobs": out}


def cancel_render(a):
    j = _jobs.get(a.get("id", ""))
    if not j:
        raise ValueError("No such render job.")
    j["status"] = "cancelled"
    return {"cancelled": j["id"], "frames_kept_in": os.path.join(j["folder"], "frames")}


def render_still(a):
    """One image: view = exterior (three-quarter view), aerial, or walk (a frame of the walkthrough)."""
    view = a.get("view", "exterior")
    s = _scene()
    if a.get("style"):
        apply_style({"style": a["style"]})
    if a.get("hour") is not None:
        set_time_of_day({"hour": a["hour"]})
    _clear_construction()
    if view == "walk":
        if "Ollic Walk Camera" not in bpy.data.objects:
            set_camera_path({})
        s.camera = bpy.data.objects["Ollic Walk Camera"]
        s.frame_set(int(a.get("frame", 1)))
    else:
        b = _bounds() or (0, 0, 0, 10, 10, 6)
        cx, cy = (b[0] + b[3]) / 2, (b[1] + b[4]) / 2
        span = max(b[3] - b[0], b[4] - b[1])
        cam = _camera("Ollic Still Camera", lens=35 if view == "exterior" else 28)
        ang = math.radians(float(a.get("angle_degrees", -60)))
        dist = span * (1.6 if view == "exterior" else 1.1) + 4
        hgt = 1.7 + span * 0.12 if view == "exterior" else span * 1.4 + 8
        cam.location = (cx + dist * math.cos(ang), cy + dist * math.sin(ang), hgt)
        d = (cx - cam.location.x, cy - cam.location.y, b[5] * 0.4 - hgt)
        cam.rotation_euler = (math.radians(90) + math.atan2(d[2], math.hypot(d[0], d[1])), 0, math.atan2(d[1], d[0]) - math.pi / 2)
        s.camera = cam
    _setup_render(a.get("quality", "final"), a.get("width"), a.get("height"))
    out = a.get("path") or os.path.join(_out_dir("stills"), f"{view}-{time.strftime('%Y%m%d-%H%M%S')}.png")
    s.render.filepath = out
    bpy.ops.render.render(write_still=True)
    return {"file": out}


# ======================================================================= buyer tour

def export_tour(a):
    """Writes one HTML file buyers open on any phone or computer: walk, dollhouse, guided tour, time of day, music."""
    title = a.get("title") or (_plan() or {}).get("title") or "3D home tour"
    safe = "".join(ch if ch.isalnum() or ch in " -_" else "" for ch in title).strip().replace(" ", "-") or "tour"
    out = a.get("path") or os.path.join(_out_dir("tours"), safe + ".html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    _clear_construction()
    apply_style({"style": "realistic"})
    glb = os.path.join(os.path.dirname(out), ".ollic-tour-tmp.glb")
    sel = [o for o in _mesh_objects() if not o.hide_render]
    for o in bpy.context.view_layer.objects:
        o.select_set(o in sel)
    bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True, export_apply=True)
    with open(glb, "rb") as fh:
        glb_b64 = base64.b64encode(fh.read()).decode("ascii")
    os.remove(glb)
    sells = {k.lower(): v for k, v in (a.get("selling_points") or {}).items()}
    p = _plan()
    rooms = []
    if p:
        for lv in p.get("levels", []):
            z0 = P.m(lv.get("elevation_mm"), 0.0)
            for r in lv.get("rooms") or []:
                x0, y0, x1, y1 = P.room_rect(r)
                nm = r.get("name") or "Room"
                rooms.append({"name": nm, "level": lv.get("name"), "area_m2": round((x1 - x0) * (y1 - y0), 1),
                              "x": (x0 + x1) / 2, "y": (y0 + y1) / 2, "z": z0, "selling_point": sells.get(nm.lower(), "")})
    raw_path = _scene().get("ollic_path")
    path = json.loads(raw_path) if raw_path else None
    if path is None and p:
        try:
            path = {"z0": 0.0, "eye": 1.5, "stops": _auto_stops(0)}
        except Exception:
            path = None
    b = _bounds(sel)
    data = {
        "title": title,
        "subtitle": a.get("subtitle", ""),
        "rooms": rooms,
        "path": path,
        "bounds": None if not b else {"x0": b[0], "y0": b[1], "z0": b[2], "x1": b[3], "y1": b[4], "z1": b[5]},
        "hide_in_dollhouse": ["Roof", "Ceiling", "Gable wall"],
        "hour": float(_scene().get("ollic_hour", 15)),
        "units": a.get("units", "m2"),
    }
    with open(os.path.join(ADDON_DIR, "tour_template.html"), encoding="utf-8") as fh:
        html = fh.read()
    html = html.replace("__OLLIC_TITLE__", title.replace("&", "&amp;").replace("<", "&lt;"))
    html = html.replace("/*__OLLIC_DATA__*/null", json.dumps(data).replace("</", "<\\/"))
    html = html.replace("__OLLIC_GLB__", glb_b64)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)
    return {"file": out, "size_mb": round(os.path.getsize(out) / 1e6, 2), "rooms": len(rooms),
            "share": "Send the file, upload it to your website, or host it anywhere. It opens in any browser; it loads the free Three.js 3D engine from the internet."}


# ======================================================================= saving

def save(a):
    path = a.get("path") or os.path.join(_out_dir(), "Ollic Sketch model.blend")
    bpy.ops.wm.save_as_mainfile(filepath=path)
    return {"file": path}


TOOLS = {
    "get_scene_info": get_scene_info,
    "build_from_plan": build_from_plan,
    "import_model": import_model,
    "apply_style": apply_style,
    "set_time_of_day": set_time_of_day,
    "set_camera_path": set_camera_path,
    "build_construction_animation": build_construction_animation,
    "render_video": render_video,
    "render_status": render_status,
    "cancel_render": cancel_render,
    "render_still": render_still,
    "export_tour": export_tour,
    "save": save,
}


def run(tool, args):
    fn = TOOLS.get(tool)
    if not fn:
        raise ValueError("Unknown Blender command: " + str(tool))
    return fn(args)
