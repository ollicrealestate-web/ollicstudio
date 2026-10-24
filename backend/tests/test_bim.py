"""Phase 3: importing an architect's IFC model for rendering and animation.
Brief acceptance tests 4, 8 (GlobalIds kept), 9 (the honest MEP note), 14 and 22.
The sample IFC comes from a small builder that lives only in the tests (tests/fixtures)."""

from __future__ import annotations

import dataclasses
import io
import json
import math

import ifcopenshell
import pytest
import trimesh
from fastapi.testclient import TestClient
from PIL import Image

from app.auth import TokenVerifier
from app.bim.importer import ImportFailed, import_ifc
from app.jobs import InlineRunner
from tests.fixtures.builder import build_ifc
from tests.fixtures.layout import sample_house
from app.main import create_app

from . import samples


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


@pytest.fixture
def bim(settings, repo, storage):
    app = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings), runner=InlineRunner(), vision=None)
    return (TestClient(app),)


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


def test_files_have_private_download_links(bim, alice, bob, sample_ifc):
    c = bim[0]
    pid = c.post("/api/projects", json={"name": "x"}, headers=alice["headers"]).json()["id"]
    f = upload(c, alice, pid, "house.ifc", sample_ifc)
    link = c.get(f"/api/projects/{pid}/files/{f['id']}/link", headers=alice["headers"]).json()
    assert "/object/sign/source-files/" in link["url"] and link["download_url"].endswith("&download=house.ifc")
    assert c.get(f"/api/projects/{pid}/files/{f['id']}/link", headers=bob["headers"]).status_code == 404


def test_ifc2x3_models_from_revit_are_read(bim, alice):
    """IFC2X3 has no IfcMapConversion; asking for it used to fail every IFC2X3 model at the last step."""
    from tests.fixtures.ifc2x3_slab import IFC2X3_SLAB
    r = import_ifc(IFC2X3_SLAB)
    assert r.report["schema"] == "IFC2X3" and r.report["status"] == "pass" and r.stats["with_geometry"] == 1
    loc = next(c for c in r.report["checks"] if c["key"] == "location")
    assert loc["status"] == "info"
    scene = trimesh.load(io.BytesIO(r.glb), file_type="glb")
    lo, hi = scene.bounds
    assert abs(lo[1]) < 1e-6 and abs(hi[1] - 0.2) < 1e-4 and abs((hi[0] - lo[0]) - 6) < 1e-4    # y-up: 0.2 m thick, 6 m wide


def test_the_same_ifc_is_not_read_twice_and_big_ones_are_refused(bim, alice, sample_ifc, repo):
    from app.jobs import InlineRunner
    c = bim[0]
    pid = c.post("/api/projects", json={"name": "x"}, headers=alice["headers"]).json()["id"]
    f = upload(c, alice, pid, "house.ifc", sample_ifc)
    held = []
    c.app.state.runner = type("Hold", (), {"submit": lambda self, fn, *a: held.append((fn, a))})()   # jobs wait, as on a busy server
    one = c.post(f"/api/projects/{pid}/import-ifc", json={"source_file_id": f["id"]}, headers=alice["headers"])
    two = c.post(f"/api/projects/{pid}/import-ifc", json={"source_file_id": f["id"]}, headers=alice["headers"])
    assert one.status_code == 202 and two.status_code == 200 and one.json()["id"] == two.json()["id"] and len(held) == 1
    c.app.state.runner = InlineRunner()
    fn, a = held[0]; fn(*a)
    assert c.get(f"/api/jobs/{one.json()['id']}", headers=alice["headers"]).json()["status"] == "succeeded"
    c.app.state.settings = dataclasses.replace(c.app.state.settings, ifc_max_mb=1)
    repo.files[f["id"]]["size_bytes"] = 49_000_000
    r = c.post(f"/api/projects/{pid}/import-ifc", json={"source_file_id": f["id"]}, headers=alice["headers"])
    assert r.status_code == 413 and "49 MB" in r.json()["detail"]["reason"] and "up to 1 MB" in r.json()["detail"]["reason"]


def _browser_meta(imported, file_id, **over):
    rep = {k: imported.report[k] for k in ("status", "schema", "units", "checks", "counts", "families", "storeys", "size_m", "elements", "with_geometry")}
    rep["checks"] = [{k: c[k] for k in ("key", "status", "message")} for c in rep["checks"]]
    return json.dumps({"source_file_id": file_id, "report": rep, "components": imported.components, **over})


def test_a_model_read_in_the_browser_is_saved(bim, alice, bob, sample_ifc, imported, repo, storage):
    """The architect's browser reads the IFC (web-ifc) and sends the 3D file with its report and parts."""
    c = bim[0]
    pid = c.post("/api/projects", json={"name": "Revit house"}, headers=alice["headers"]).json()["id"]
    f = upload(c, alice, pid, "house.ifc", sample_ifc)
    files = {"file": ("model.glb", imported.glb, "model/gltf-binary")}
    r = c.post(f"/api/projects/{pid}/models/from-browser", files=files, data={"meta": _browser_meta(imported, f["id"])}, headers=alice["headers"])
    assert r.status_code == 201, r.text
    m = r.json()
    assert m["report"]["read_on"] == "browser" and m["stats"]["glb_bytes"] == len(imported.glb) and m["glb_url"]
    (listed,) = c.get(f"/api/projects/{pid}/models", headers=alice["headers"]).json()
    assert listed["id"] == m["id"] and listed["source_file_id"] == f["id"]
    assert len(c.get(f"/api/models/{m['id']}/components", headers=alice["headers"]).json()) == 26
    assert storage.buckets["models"][repo.models[m["id"]]["glb_path"]][0] == imported.glb
    # checked: not a 3D file, someone else's project or file, not an IFC, bad details
    bad = c.post(f"/api/projects/{pid}/models/from-browser", files={"file": ("x.glb", b"not a model", "model/gltf-binary")}, data={"meta": _browser_meta(imported, f["id"])}, headers=alice["headers"])
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "bad_model"
    assert c.post(f"/api/projects/{pid}/models/from-browser", files=files, data={"meta": _browser_meta(imported, f["id"])}, headers=bob["headers"]).status_code == 404
    png = upload(c, alice, pid, "plan.png", samples.png())
    assert c.post(f"/api/projects/{pid}/models/from-browser", files=files, data={"meta": _browser_meta(imported, png["id"])}, headers=alice["headers"]).json()["detail"]["code"] == "not_ifc"
    meta = json.loads(_browser_meta(imported, f["id"])); meta["components"][0]["family"] = "anything"
    assert c.post(f"/api/projects/{pid}/models/from-browser", files=files, data={"meta": json.dumps(meta)}, headers=alice["headers"]).status_code == 422
    assert len(repo.models) == 1
