"""Phases 3 and 3b: IFC builder, IFC import, floor-plan reading, review and model build.
Brief acceptance tests 4, 8, 9 (the honest MEP note), 14, 16, 17, 22 and 37."""

from __future__ import annotations

import io
import json
import math

import ifcopenshell
import pytest
import trimesh
from fastapi.testclient import TestClient
from PIL import Image

from app.auth import TokenVerifier
from app.bim.builder import build_ifc
from app.bim.confirm import ConfirmIn, to_layout
from app.bim.importer import ImportFailed, import_ifc
from app.bim.layout import Layout, sample_house
from app.bim.plan_trace import TraceFailed, load_plan_image, trace
from app.bim.vision import parse_answer
from app.jobs import InlineRunner
from app.main import create_app

from . import samples
from .plan_drawing import draw_plan


# ---------------------------------------------------------------- builder and importer
@pytest.fixture(scope="module")
def sample_ifc():
    return build_ifc(sample_house(), seed="test-draft")


@pytest.fixture(scope="module")
def imported(sample_ifc):
    return import_ifc(sample_ifc)


def test_builder_writes_a_real_ifc4_house(sample_ifc):
    f = ifcopenshell.file.from_string(sample_ifc.decode())
    assert f.schema == "IFC4"
    count = lambda t: len(f.by_type(t))
    assert (count("IfcWall"), count("IfcDoor"), count("IfcWindow"), count("IfcSpace"), count("IfcRoof"), count("IfcSlab")) == (8, 5, 6, 5, 1, 1)
    assert count("IfcOpeningElement") == 11 and count("IfcRelVoidsElement") == 11 and count("IfcRelFillsElement") == 11
    assert {s.Name for s in f.by_type("IfcSpace")} == {"Living", "Kitchen", "Bath", "Bedroom 1", "Bedroom 2"}
    assert f.by_type("IfcSIUnit")[0].Prefix is None  # metres


def test_rebuilding_the_same_layout_keeps_every_global_id(sample_ifc):
    again = build_ifc(sample_house(), seed="test-draft")
    other = build_ifc(sample_house(), seed="another-draft")
    # every element and space (what the animation and the components table refer to)
    ids = lambda b: sorted(e.GlobalId for e in ifcopenshell.file.from_string(b.decode()).by_type("IfcProduct"))
    assert ids(sample_ifc) == ids(again)
    assert set(ids(sample_ifc)).isdisjoint(ids(other))


def test_import_report_counts_checks_and_honest_mep_note(imported):
    r = imported.report
    assert r["status"] == "pass" and r["schema"] == "IFC4" and r["units"] == "metres"
    assert r["counts"] == {"IfcWall": 8, "IfcWindow": 6, "IfcDoor": 5, "IfcSpace": 5, "IfcRoof": 1, "IfcSlab": 1}
    w, d, h = r["size_m"]
    assert 13 <= w <= 14 and 10 <= d <= 11 and 5 < h < 6        # 12 x 9 m plus walls and 0.6 m eaves; hip roof
    mep = next(c for c in r["checks"] if c["key"] == "mep")
    assert mep["status"] == "info" and "rather than invent" in mep["message"]   # brief test 9


def test_glb_has_one_node_per_element_named_by_global_id(imported):
    scene = trimesh.load(io.BytesIO(imported.glb), file_type="glb")
    ids = {c["global_id"] for c in imported.components}
    assert set(scene.geometry) == ids and len(ids) == 26
    wall = next(c for c in imported.components if c["ifc_type"] == "IfcWall" and c["properties"].get("Pset_WallCommon.IsExternal"))
    assert wall["storey"] == "Ground floor" and wall["family"] == "structure" and wall["properties"]["Ollic_Layout.Source"] == "drawing"
    lo, hi = scene.bounds
    assert abs(lo[1]) < 1e-6 and hi[1] > 5  # y-up, standing on the ground


def test_bad_ifc_files_fail_with_plain_reasons():
    with pytest.raises(ImportFailed) as e:
        import_ifc(b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCWALL(\n")
    assert "could not be read" in e.value.message or "IfcProject" in e.value.message
    with pytest.raises(ImportFailed) as e:
        import_ifc(samples.ifc("IFC4"))  # a project and nothing else
    assert "geometry" in e.value.message


# ---------------------------------------------------------------- reading floor plans
def labels_for(meta):
    return [{"name": l["name"].upper(), "area_m2": l["area_m2"], "x": l["x"], "y": l["y"]} for l in meta["labels"]]


def test_plan_reader_finds_every_wall_door_window_and_room():
    png, meta = draw_plan(sample_house())
    p = trace(load_plan_image(png, "png"), labels_for(meta))
    kinds = [o["kind"] for o in p["openings"]]
    assert len(p["walls"]) == 8 and kinds.count("door") == 5 and kinds.count("window") == 6
    assert sum(w["exterior"] for w in p["walls"]) == 4
    assert sorted(r["name"] for r in p["rooms"]) == ["Bath", "Bedroom 1", "Bedroom 2", "Kitchen", "Living"]
    assert all(r["name_source"] == "ai" and r["area_source"] == "ai" for r in p["rooms"])
    true = 1 / meta["px_per_m"]
    assert abs(p["scale"]["m_per_px"] - true) / true < 0.06 and p["scale"]["source"] == "ai"   # brief test 37
    assert any(f["target"] == "heights" for f in p["flags"])  # defaults are flagged, not passed off as read


def test_plan_reader_measures_openings():
    png, meta = draw_plan(sample_house())
    p = trace(load_plan_image(png, "png"), labels_for(meta))
    widths = sorted(round(o["width_px"] / meta["px_per_m"], 1) for o in p["openings"] if o["kind"] == "window")
    assert widths == [0.6, 1.2, 1.5, 1.5, 1.5, 2.4]


def test_without_written_areas_the_scale_is_flagged_never_invented():
    png, meta = draw_plan(sample_house())
    p = trace(load_plan_image(png, "png"), [])
    assert p["scale"]["m_per_px"] is None
    targets = {f["target"]: f["kind"] for f in p["flags"]}
    assert targets["scale"] == "missing" and targets["rooms"] == "missing"   # brief test 17
    assert all(r["name_source"] == "default" for r in p["rooms"])


def test_double_line_walls_are_read_too():
    """Many plans draw walls as two thin parallel lines rather than solid black."""
    png, meta = draw_plan(sample_house(), clutter=False)
    img = Image.open(io.BytesIO(png)).convert("L")
    import numpy as np, cv2
    a = np.array(img)
    solid = (a < 128).astype(np.uint8) * 255
    inner = cv2.erode(solid, np.ones((5, 5), np.uint8))
    outline = cv2.subtract(solid, inner)  # hollow walls: only their edges remain
    buf = io.BytesIO(); Image.fromarray(255 - outline).save(buf, "PNG")
    p = trace(load_plan_image(buf.getvalue(), "png"), labels_for(meta))
    assert len(p["walls"]) >= 8 and len(p["rooms"]) == 5


def test_unreadable_images_fail_with_a_reason():
    buf = io.BytesIO(); Image.new("L", (800, 600), 10).save(buf, "PNG")
    with pytest.raises(TraceFailed) as e:
        trace(load_plan_image(buf.getvalue(), "png"))
    assert "dark" in e.value.message
    buf = io.BytesIO(); Image.new("L", (800, 600), 255).save(buf, "PNG")
    with pytest.raises(TraceFailed) as e:
        trace(load_plan_image(buf.getvalue(), "png"))
    assert "walls" in e.value.message


def test_vision_answers_are_parsed_defensively():
    out = parse_answer('Here you go:\n```json\n{"rooms":[{"name":"LIVING","area_m2":"38.5 m2","x":30,"y":60},{"name":"","x":0.1,"y":0.1},{"name":"Bath","x":"?"}],"overall_width_m":12}\n```')
    assert out["rooms"] == [{"name": "LIVING", "area_m2": 38.5, "x": 0.3, "y": 0.6}] and out["overall_width_m"] == 12.0


# ---------------------------------------------------------------- confirmed plan -> layout (metres)
def confirm_from(p, scale, **kw):
    return ConfirmIn(draft_id="d", scale_m_per_px=scale, scale_source="ai", image_height_px=p["image"]["height"],
                     walls=[{"id": w["id"], "a": w["a"], "b": w["b"], "thickness_m": max(0.1, round(w["thickness_px"] * scale, 3)), "exterior": w["exterior"]} for w in p["walls"]],
                     openings=[{"id": o["id"], "wall": o["wall"], "kind": o["kind"], "offset_px": o["offset_px"], "width_m": o["width_px"] * scale,
                                "height_m": o["height"], "sill_m": o["sill"]} for o in p["openings"]],
                     rooms=[{"id": r["id"], "name": r["name"], "polygon_px": r["polygon_px"], "area_label": r["area_label"]} for r in p["rooms"]], **kw)


def test_confirmed_plan_becomes_a_layout_in_metres_and_a_valid_ifc():
    png, meta = draw_plan(sample_house())
    p = trace(load_plan_image(png, "png"), labels_for(meta))
    layout, notes = to_layout(confirm_from(p, 1 / meta["px_per_m"], roof={"type": "gable", "pitch": 30}))
    xs = [c for w in layout.walls for c in (w.a[0], w.b[0])]
    ys = [c for w in layout.walls for c in (w.a[1], w.b[1])]
    assert math.isclose(max(xs) - min(xs), 12.0, abs_tol=0.1) and math.isclose(max(ys) - min(ys), 9.0, abs_tol=0.1)
    living = next(r for r in layout.rooms if r.name == "Living")
    assert min(pt[1] for pt in living.polygon) < 1.0   # living is at the bottom of the page = south: y was flipped
    report = import_ifc(build_ifc(layout, seed="x")).report
    assert report["status"] == "pass" and report["counts"]["IfcWindow"] == 6 and report["counts"]["IfcDoor"] == 5   # brief test 16


def test_two_storeys_and_impossible_layouts():
    png, meta = draw_plan(sample_house())
    p = trace(load_plan_image(png, "png"), labels_for(meta))
    layout, notes = to_layout(confirm_from(p, 1 / meta["px_per_m"], storeys=2))
    assert len(layout.levels) == 2 and any(w.level == 1 for w in layout.walls) and "first floor" in notes[0].lower()
    r = import_ifc(build_ifc(layout, seed="x")).report
    assert r["storeys"] == ["Ground floor", "First floor"] and r["size_m"][2] > 8
    with pytest.raises(ValueError):
        Layout(levels=[{"name": "G", "elevation": 0, "height": 3}], walls=[{"id": "a", "level": 0, "a": (0, 0), "b": (0, 0.05), "thickness": 0.2}] * 3)


# ---------------------------------------------------------------- API journeys
class FakeVision:
    def __init__(self, labels):
        self.labels, self.calls = labels, 0

    def read_labels(self, img):
        self.calls += 1
        return {"rooms": self.labels, "model": "fake-vision", "usage": {"prompt_tokens": 900}}


@pytest.fixture
def bim(settings, repo, storage):
    png, meta = draw_plan(sample_house())
    vision = FakeVision(labels_for(meta))
    app = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings), runner=InlineRunner(), vision=vision)
    return TestClient(app), png, meta, vision


def upload(c, user, pid, name, data):
    r = c.post(f"/api/projects/{pid}/uploads", files={"file": (name, data)}, headers=user["headers"])
    assert r.status_code == 201, r.text
    return r.json()


def test_ifc_upload_import_report_model_and_components(bim, alice, bob, sample_ifc, repo, storage):
    c = bim[0]
    pid = c.post("/api/projects", json={"name": "Revit house"}, headers=alice["headers"]).json()["id"]
    f = upload(c, alice, pid, "house.ifc", sample_ifc)
    job = c.post(f"/api/projects/{pid}/import-ifc", json={"source_file_id": f["id"]}, headers=alice["headers"]).json()
    job = c.get(f"/api/jobs/{job['id']}", headers=alice["headers"]).json()
    assert job["status"] == "succeeded", job
    (m,) = c.get(f"/api/projects/{pid}/models", headers=alice["headers"]).json()
    assert m["report"]["status"] == "pass" and m["glb_url"].startswith("https://example.supabase.co/storage/v1/object/sign/models/")
    comps = c.get(f"/api/models/{m['id']}/components", headers=alice["headers"]).json()
    assert len(comps) == 26 and len({x["global_id"] for x in comps}) == 26
    # another customer gets nothing (brief test 14)
    assert c.get(f"/api/projects/{pid}/models", headers=bob["headers"]).status_code == 404
    assert c.get(f"/api/models/{m['id']}/components", headers=bob["headers"]).status_code == 404
    assert c.post(f"/api/projects/{pid}/import-ifc", json={"source_file_id": f["id"]}, headers=bob["headers"]).status_code == 404
    # only IFC can be imported
    png = upload(c, alice, pid, "plan.png", samples.png())
    assert c.post(f"/api/projects/{pid}/import-ifc", json={"source_file_id": png["id"]}, headers=alice["headers"]).json()["detail"]["code"] == "not_ifc"
    # deleting the project removes the model file too (brief test 22)
    assert storage.buckets["models"]
    c.delete(f"/api/projects/{pid}", headers=alice["headers"])
    assert storage.buckets["models"] == {} and repo.models == {} and repo.components == []


def test_a_broken_ifc_fails_the_job_with_its_reason(bim, alice):
    c = bim[0]
    pid = c.post("/api/projects", json={"name": "x"}, headers=alice["headers"]).json()["id"]
    f = upload(c, alice, pid, "empty.ifc", samples.ifc("IFC4"))
    job = c.post(f"/api/projects/{pid}/import-ifc", json={"source_file_id": f["id"]}, headers=alice["headers"]).json()
    job = c.get(f"/api/jobs/{job['id']}", headers=alice["headers"]).json()
    assert job["status"] == "failed" and "geometry" in job["error"]


def test_floor_plan_to_3d_model_end_to_end(bim, alice, bob, repo, storage):
    c, png, meta, vision = bim
    pid = c.post("/api/projects", json={"name": "From a plan"}, headers=alice["headers"]).json()["id"]
    f = upload(c, alice, pid, "ground-floor.png", png)
    job = c.post(f"/api/projects/{pid}/plan/trace", json={"source_file_id": f["id"]}, headers=alice["headers"]).json()
    job = c.get(f"/api/jobs/{job['id']}", headers=alice["headers"]).json()
    assert job["status"] == "succeeded" and job["result"]["walls"] == 8 and vision.calls == 1
    lay = c.get(f"/api/projects/{pid}/layout", headers=alice["headers"]).json()["draft"]
    p = lay["proposal"]
    assert lay["status"] == "proposed" and lay["image_url"] and p["vision"]["status"] == "ok"
    assert repo.usage[-1]["operation"] == "vision_read"
    assert c.get(f"/api/projects/{pid}/layout", headers=bob["headers"]).status_code == 404

    # the customer confirms (here: exactly what was proposed, with the read scale)
    body = json.loads(confirm_from(p, p["scale"]["m_per_px"]).model_dump_json())
    body.update(draft_id=lay["id"], name="From a plan")
    r = c.put(f"/api/projects/{pid}/layout", json=body, headers=alice["headers"])
    assert r.status_code == 202, r.text
    build = c.get(f"/api/jobs/{r.json()['id']}", headers=alice["headers"]).json()
    assert build["status"] == "succeeded" and build["type"] == "model_build", build
    (m,) = c.get(f"/api/projects/{pid}/models", headers=alice["headers"]).json()
    assert m["layout_draft_id"] == lay["id"] and m["report"]["counts"]["IfcSpace"] == 5
    assert repo.drafts[lay["id"]]["status"] == "built"
    generated = [x for x in repo.files.values() if x.get("origin") == "generated"]
    assert len(generated) == 1 and generated[0]["detected_type"] == "ifc"   # the IFC is kept and downloadable
    assert c.put(f"/api/projects/{pid}/layout", json=body, headers=bob["headers"]).status_code == 404


def test_confirming_an_impossible_layout_explains_why(bim, alice):
    c, png, meta, _ = bim
    pid = c.post("/api/projects", json={"name": "x"}, headers=alice["headers"]).json()["id"]
    f = upload(c, alice, pid, "plan.png", png)
    c.post(f"/api/projects/{pid}/plan/trace", json={"source_file_id": f["id"]}, headers=alice["headers"])
    lay = c.get(f"/api/projects/{pid}/layout", headers=alice["headers"]).json()["draft"]
    body = json.loads(confirm_from(lay["proposal"], 1 / meta["px_per_m"]).model_dump_json())
    body["draft_id"] = lay["id"]
    body["walls"] = body["walls"][:2]
    r = c.put(f"/api/projects/{pid}/layout", json=body, headers=alice["headers"])
    assert r.status_code == 422


def test_plan_reading_without_the_vision_model_still_works_and_says_so(settings, repo, storage, alice):
    c = TestClient(create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings), runner=InlineRunner(), vision=None))
    png, meta = draw_plan(sample_house())
    pid = c.post("/api/projects", json={"name": "x"}, headers=alice["headers"]).json()["id"]
    f = upload(c, alice, pid, "plan.png", png)
    job = c.post(f"/api/projects/{pid}/plan/trace", json={"source_file_id": f["id"]}, headers=alice["headers"]).json()
    assert c.get(f"/api/jobs/{job['id']}", headers=alice["headers"]).json()["status"] == "succeeded"
    p = c.get(f"/api/projects/{pid}/layout", headers=alice["headers"]).json()["draft"]["proposal"]
    assert p["vision"]["status"] == "off" and p["scale"]["m_per_px"] is None and p["flags"][0]["target"] == "vision"
