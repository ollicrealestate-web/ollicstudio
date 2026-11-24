"""Camera angles: saved views and the front come back for the model, owner only; words to numbers with Ollic AI."""
import uuid

POSE = {"position": [10, 1.6, 30], "target": [10, 1.6, 4], "fov": 25.36, "aspect": 1.5, "shift": [0, 0.18]}
THUMB = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=="


def _model(client, repo, user):
    pid = client.post("/api/projects", json={"name": "Katampe apartments"}, headers=user["headers"]).json()["id"]
    owner = type("U", (), {"id": user["id"]})()
    return repo.create_model(owner, {"id": str(uuid.uuid4()), "project_id": pid, "source_file_id": None, "job_id": None, "glb_path": f"{user['id']}/{pid}/m.glb", "report": {}})["id"]


def test_saved_views_and_the_front_come_back(client, repo, alice, bob):
    mid = _model(client, repo, alice)
    assert client.get(f"/api/models/{mid}/cameras", headers=alice["headers"]).json() == {"front": None, "views": []}
    body = {"front": {"dir": [1, 0], "from": "you"}, "views": [
        {"id": "v1", "name": "Corner drone NE", "settings": {"preset": "drone-corner-right", "lens": 28, "height": 21.6, "azimuth": 45, "straight": True, "aspect": "3:2"},
         "pose": POSE, "thumb": THUMB, "words": "elevated three-quarter corner view"}]}
    r = client.put(f"/api/models/{mid}/cameras", json=body, headers=alice["headers"])
    assert r.status_code == 200, r.text
    got = client.get(f"/api/models/{mid}/cameras", headers=alice["headers"]).json()
    assert got["front"] == {"dir": [1, 0], "from": "you"}
    v = got["views"][0]
    assert v["name"] == "Corner drone NE" and v["settings"]["lens"] == 28 and v["pose"]["shift"] == [0, 0.18] and v["thumb"] == THUMB
    assert client.get(f"/api/models/{mid}/cameras", headers=bob["headers"]).status_code == 404
    assert client.put(f"/api/models/{mid}/cameras", json=body, headers=bob["headers"]).status_code == 404


def test_bad_views_are_refused(client, repo, alice):
    mid = _model(client, repo, alice)
    for bad in ({"views": [{"id": "v", "name": "x", "pose": {**POSE, "fov": 0}}]},
                {"views": [{"id": "v", "name": "x", "pose": POSE, "settings": {"preset": "fisheye"}}]},
                {"views": [{"id": "v", "name": "x", "pose": POSE, "settings": {"aspect": "2:1"}}]},
                {"views": [{"id": "v", "name": "x", "pose": POSE, "thumb": "javascript:alert(1)"}]}):
        assert client.put(f"/api/models/{mid}/cameras", json=bad, headers=alice["headers"]).status_code == 422, bad


def test_words_need_ollic_ai_and_are_read_with_it(settings, repo, storage, alice, client):
    assert client.post("/api/camera/words", json={"text": "front at eye level, 35 mm"}, headers=alice["headers"]).status_code == 503
    from fastapi.testclient import TestClient
    from app.auth import TokenVerifier
    from app.jobs import InlineRunner
    from app.main import create_app

    class Writer:
        model = "test"
        def ask_json(self, system, content, max_tokens=0, timeout=0):
            assert "low drone height" in system.lower() and "16.0 m high" in content[0]["text"]
            return {"answer": {"preset": "drone-corner-right", "lens": 24, "height": 21, "azimuth": 45, "pitch": 30, "straight": True, "aspect": "3:2",
                               "foreground": "street", "understood": ["corner", "low drone", "24 mm"]}, "usage": {}}

    c = TestClient(create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings), runner=InlineRunner(), prompt_writer=Writer()))
    r = c.post("/api/camera/words", json={"text": "elevated three-quarter corner view, low drone height, 24 mm, street intersection in foreground", "building_height": 16},
               headers=alice["headers"])
    assert r.status_code == 200, r.text
    s = r.json()["settings"]
    assert s["preset"] == "drone-corner-right" and s["lens"] == 24 and s["height"] == 21 and s["pitch"] == 0 and s["straight"] is True and s["foreground"] == "street"
