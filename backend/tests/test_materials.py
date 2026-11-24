"""Realistic materials: what each part shows is saved per model and comes back; favourites; owner only."""
import uuid


def _model(client, repo, user):
    pid = client.post("/api/projects", json={"name": "Lekki duplex"}, headers=user["headers"]).json()["id"]
    owner = type("U", (), {"id": user["id"]})()
    return repo.create_model(owner, {"id": str(uuid.uuid4()), "project_id": pid, "source_file_id": None, "job_id": None,
                                     "glb_path": f"{user['id']}/{pid}/m.glb", "report": {}})["id"]


def test_assignments_are_saved_per_model_and_come_back(client, repo, alice):
    mid = _model(client, repo, alice)
    assert client.get(f"/api/models/{mid}/materials", headers=alice["headers"]).json()["assignments"] == {}
    body = {"assignments": {
        "2O2Fr$t4X7Zf8NOew3FLOH#0": {"id": "mt-travertine"},
        "2O2Fr$t4X7Zf8NOew3FLOH#1/+": {"id": "mt-paint-sand", "tint": "#d6c39f", "scale": 1.5, "rotation": 90, "rough": 0.4, "offset": [0.1, 0.2]},
    }}
    r = client.put(f"/api/models/{mid}/materials", json=body, headers=alice["headers"])
    assert r.status_code == 200, r.text
    got = client.get(f"/api/models/{mid}/materials", headers=alice["headers"]).json()["assignments"]
    assert got["2O2Fr$t4X7Zf8NOew3FLOH#0"] == {"id": "mt-travertine"}
    assert got["2O2Fr$t4X7Zf8NOew3FLOH#1/+"] == {"id": "mt-paint-sand", "tint": "#d6c39f", "scale": 1.5, "rotation": 90, "rough": 0.4, "offset": [0.1, 0.2]}
    # saving again replaces (an undo that removed a part's material removes it here too)
    client.put(f"/api/models/{mid}/materials", json={"assignments": {"2O2Fr$t4X7Zf8NOew3FLOH#0": {"id": "mt-brick-red"}}}, headers=alice["headers"])
    assert client.get(f"/api/models/{mid}/materials", headers=alice["headers"]).json()["assignments"] == {"2O2Fr$t4X7Zf8NOew3FLOH#0": {"id": "mt-brick-red"}}


def test_only_the_owner_sees_or_changes_a_models_materials(client, repo, alice, bob):
    mid = _model(client, repo, alice)
    client.put(f"/api/models/{mid}/materials", json={"assignments": {"abc#0": {"id": "mt-travertine"}}}, headers=alice["headers"])
    assert client.get(f"/api/models/{mid}/materials", headers=bob["headers"]).status_code == 404
    assert client.put(f"/api/models/{mid}/materials", json={"assignments": {}}, headers=bob["headers"]).status_code == 404


def test_bad_assignments_are_refused(client, repo, alice):
    mid = _model(client, repo, alice)
    for bad in ({"not a key": {"id": "mt-travertine"}}, {"abc#0": {"id": "travertine"}}, {"abc#0": {"id": "mt-travertine", "tint": "red"}},
                {"abc#0": {"id": "mt-travertine", "scale": 0}}, {"abc#0": {"id": "mt-travertine", "rough": 2}}):
        assert client.put(f"/api/models/{mid}/materials", json={"assignments": bad}, headers=alice["headers"]).status_code == 422, bad


def test_favourites_and_recent(client, alice, bob):
    assert client.get("/api/material-prefs", headers=alice["headers"]).json() == {"favourites": [], "recent": []}
    r = client.put("/api/material-prefs", json={"favourites": ["mt-travertine", "mt-travertine", "mt-timber-teak"], "recent": ["mt-brick-red"]}, headers=alice["headers"])
    assert r.json() == {"favourites": ["mt-travertine", "mt-timber-teak"], "recent": ["mt-brick-red"]}
    assert client.get("/api/material-prefs", headers=bob["headers"]).json() == {"favourites": [], "recent": []}
    assert client.put("/api/material-prefs", json={"favourites": ["<script>"]}, headers=alice["headers"]).status_code == 422


# ---------------------------------------------------------------- My materials (made from photos)
import io
import json

from PIL import Image


def _jpeg(colour=(200, 180, 150), size=(64, 64)):
    b = io.BytesIO(); Image.new("RGB", size, colour).save(b, "JPEG"); return b.getvalue()


def _meta(**kw):
    return json.dumps({"name": "Beige porcelain from the showroom", "cls": "tile", "size": 1.8, "sizeV": 1.5, "rough": 0.3, "plain": "#d6c8b0",
                       "tiles": [6, 5], "tile_mm": [300, 300], "checks": {"deltaE": 1.2, "seam": 0.9}, **kw})


def test_my_material_is_saved_privately_and_listed_with_its_pictures(client, storage, alice, bob):
    files = {"color": ("c.jpg", _jpeg(), "image/jpeg"), "normal": ("n.jpg", _jpeg((128, 128, 255)), "image/jpeg"),
             "rough": ("r.jpg", _jpeg((90, 90, 90)), "image/jpeg"), "ao": ("a.jpg", _jpeg((250, 250, 250)), "image/jpeg"), "original": ("o.jpg", _jpeg(size=(300, 200)), "image/jpeg")}
    r = client.post("/api/my-materials", data={"meta": _meta()}, files=files, headers=alice["headers"])
    assert r.status_code == 201, r.text
    m = r.json()
    assert m["id"].startswith("my-") and m["category"] == "My materials" and m["cls"] == "tile" and m["size"] == 1.8 and m["sizeV"] == 1.5
    assert set(m["urls"]) == {"color", "normal", "rough", "ao", "original"}
    stored = storage.buckets["user-materials"]
    assert all(p.startswith(f"{alice['id']}/{m['id'][3:]}/") for p in stored) and len(stored) == 5
    assert [x["id"] for x in client.get("/api/my-materials", headers=alice["headers"]).json()] == [m["id"]]
    assert client.get("/api/my-materials", headers=bob["headers"]).json() == []
    assert client.delete(f"/api/my-materials/{m['id'][3:]}", headers=bob["headers"]).status_code == 404
    # it can be put on a model like a library material
    assert client.delete(f"/api/my-materials/{m['id'][3:]}", headers=alice["headers"]).status_code == 204
    assert client.get("/api/my-materials", headers=alice["headers"]).json() == [] and not storage.buckets["user-materials"]


def test_my_material_refuses_what_is_not_a_picture_or_not_right(client, alice):
    ok = {"color": ("c.jpg", _jpeg(), "image/jpeg")}
    assert client.post("/api/my-materials", data={"meta": _meta()}, files={"color": ("c.jpg", b"not an image", "image/jpeg")}, headers=alice["headers"]).status_code == 422
    assert client.post("/api/my-materials", data={"meta": _meta(cls="lava")}, files=ok, headers=alice["headers"]).status_code == 422
    assert client.post("/api/my-materials", data={"meta": _meta(plain="beige")}, files=ok, headers=alice["headers"]).status_code == 422
    assert client.post("/api/my-materials", data={"meta": "{"}, files=ok, headers=alice["headers"]).status_code == 422
    assert client.post("/api/my-materials", data={"meta": _meta()}, files=ok, headers=alice["headers"]).status_code == 201


def test_my_material_can_be_assigned_to_a_model(client, repo, alice):
    mid = _model(client, repo, alice)
    my = client.post("/api/my-materials", data={"meta": _meta()}, files={"color": ("c.jpg", _jpeg(), "image/jpeg")}, headers=alice["headers"]).json()
    r = client.put(f"/api/models/{mid}/materials", json={"assignments": {"abc#0": {"id": my["id"]}}}, headers=alice["headers"])
    assert r.status_code == 200 and r.json()["assignments"]["abc#0"]["id"] == my["id"]


def test_ollic_ai_suggests_what_the_photo_shows(settings, repo, storage, alice):
    from fastapi.testclient import TestClient
    from app.auth import TokenVerifier
    from app.jobs import InlineRunner
    from app.main import create_app

    class Writer:
        model = "test"
        def ask_json(self, system, content, max_tokens=0, timeout=0):
            assert content[0]["type"] == "image" and "never mention brands" in system
            return {"answer": {"name": "Travertine, honed", "cls": "stone", "rough": 0.45, "metal": 0, "size_mm": 600, "tile_mm": [600, 300], "notes": "Cream stone."}, "usage": {}, "cost_usd": 0.001}

    c = TestClient(create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings), runner=InlineRunner(), prompt_writer=Writer()))
    r = c.post("/api/my-materials/suggest", files={"image": ("p.jpg", _jpeg(), "image/jpeg")}, headers=alice["headers"])
    assert r.status_code == 200, r.text
    assert r.json() == {"name": "Travertine, honed", "cls": "stone", "rough": 0.45, "metal": 0, "size_mm": 600.0, "tile_mm": [600.0, 300.0], "notes": "Cream stone."}


def test_without_ollic_ai_the_suggestion_says_so(client, alice):
    r = client.post("/api/my-materials/suggest", files={"image": ("p.jpg", _jpeg(), "image/jpeg")}, headers=alice["headers"])
    assert r.status_code == 503
