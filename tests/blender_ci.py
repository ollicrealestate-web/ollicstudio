"""Runs inside Blender (background) on GitHub: drives the Ollic Sketch commands the same way Claude does."""
import json, os, sys, time, traceback
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "blender-helper"))
out = os.path.abspath(sys.argv[sys.argv.index("--") + 1]) if "--" in sys.argv else os.path.abspath("out")
os.makedirs(out, exist_ok=True)
import bpy
import ollic_sketch
ollic_sketch.register()  # background: must not open a port
from ollic_sketch import commands as C, server
assert server._state["sock"] is None, "server must not start in background mode"

results, failed = {}, []
def step(name, fn):
    t = time.time()
    try:
        r = fn(); results[name] = {"ok": True, "seconds": round(time.time() - t, 1), "result": r}
        print(f"PASS {name} ({results[name]['seconds']} s): {json.dumps(r, default=str)[:300]}", flush=True)
        return r
    except Exception as e:
        traceback.print_exc(); failed.append(name); results[name] = {"ok": False, "error": str(e)}
        print(f"FAIL {name}: {e}", flush=True)

plan = json.load(open(os.path.join(here, "sample_plan.json")))
plan["levels"][0]["stairs"] = [{"x": 6200, "y": 4600, "direction": "up", "width_mm": 1000}]
plan["levels"].append({"name": "First floor", "elevation_mm": 3150, "height_mm": 3000,
    "walls": [w for w in plan["levels"][0]["walls"][:4]],
    "openings": [o for o in plan["levels"][0]["openings"] if o["wall"] < 4 and o["kind"] == "window"], "rooms": []})
step("build_from_plan", lambda: C.run("build_from_plan", plan))
step("scene_info", lambda: C.run("get_scene_info", {}))
step("time_of_day_evening", lambda: C.run("set_time_of_day", {"hour": 18.5}))
step("time_of_day_day", lambda: C.run("set_time_of_day", {"hour": 15}))
step("camera_path_auto", lambda: C.run("set_camera_path", {}))
step("still_exterior_realistic", lambda: C.run("render_still", {"view": "exterior", "quality": "preview", "width": 640, "height": 360, "path": os.path.join(out, "exterior.png")}))
step("still_walk_clay", lambda: C.run("render_still", {"view": "walk", "frame": 200, "style": "clay", "quality": "preview", "width": 640, "height": 360, "path": os.path.join(out, "walk-clay.png")}))
step("still_cycles", lambda: C.run("render_still", {"view": "aerial", "style": "realistic", "quality": "cycles", "width": 320, "height": 180, "path": os.path.join(out, "aerial-cycles.png")}))
step("walkthrough_video", lambda: C.run("render_video", {"kind": "walkthrough", "style": "realistic", "max_seconds": 3, "width": 480, "height": 270, "name": "walkthrough", "folder": os.path.join(out, "walkthrough"), "wait": True}))
step("construction_video", lambda: C.run("render_video", {"kind": "construction", "style": "realistic", "seconds_per_stage": 0.5, "max_seconds": 4, "width": 480, "height": 270, "name": "construction", "folder": os.path.join(out, "construction"), "wait": True}))
step("render_status", lambda: C.run("render_status", {}))
step("export_tour", lambda: C.run("export_tour", {"title": "Sample bungalow", "subtitle": "3 bedrooms · test", "selling_points": {"Living": "Wide windows on two sides", "Kitchen": "Room for a full island"}, "path": os.path.join(out, "tour.html")}))
def roundtrip():
    bpy.ops.export_scene.gltf(filepath=os.path.join(out, "model.glb"), export_format="GLB")
    return C.run("import_model", {"path": os.path.join(out, "model.glb")})
step("glb_roundtrip_import", roundtrip)
step("construction_on_imported", lambda: C.run("build_construction_animation", {"seconds_per_stage": 0.5}))
step("save", lambda: C.run("save", {"path": os.path.join(out, "model.blend")}))

for job in ("walkthrough", "construction"):
    st = results.get(job + "_video", {}).get("result") or {}
    f = st.get("file") or ""
    ok = f.endswith(".mp4") and os.path.exists(f) and os.path.getsize(f) > 1000
    print(f"{job}: status={st.get('status')} error={st.get('error')} file={f} ok={ok}", flush=True)
    if not ok:
        failed.append(job + "_mp4")
for name in ("exterior.png", "walk-clay.png", "aerial-cycles.png", "tour.html"):
    if not os.path.exists(os.path.join(out, name)):
        failed.append("missing " + name)
json.dump(results, open(os.path.join(out, "results.json"), "w"), indent=1, default=str)
print("FAILED:" if failed else "ALL PASSED", failed, flush=True)
sys.exit(1 if failed else 0)
