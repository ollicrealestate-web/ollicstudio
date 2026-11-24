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
