import uuid

from . import samples


def _create(client, user, name="Lekki duplex"):
    res = client.post("/api/projects", json={"name": name}, headers=user["headers"])
    assert res.status_code == 201, res.text
    return res.json()


def test_create_list_and_open_a_project(client, alice):
    p = _create(client, alice)
    assert p["owner_id"] == alice["id"] and p["status"] == "draft" and p["input_type"] == "unknown"
    assert [x["id"] for x in client.get("/api/projects", headers=alice["headers"]).json()] == [p["id"]]
    detail = client.get(f"/api/projects/{p['id']}", headers=alice["headers"]).json()
    assert detail["name"] == "Lekki duplex" and detail["source_files"] == []


def test_project_names_are_validated_and_tidied(client, alice):
    assert client.post("/api/projects", json={"name": "   "}, headers=alice["headers"]).status_code == 422
    assert client.post("/api/projects", json={"name": "x" * 121}, headers=alice["headers"]).status_code == 422
    assert _create(client, alice, "  Ikeja   bungalow ")["name"] == "Ikeja bungalow"


def test_another_user_cannot_list_open_upload_to_or_delete_it(client, alice, bob):
    """Acceptance test 14, at the API layer: guessing an ID gets a plain 404."""
    p = _create(client, alice)
    assert client.get("/api/projects", headers=bob["headers"]).json() == []
    assert client.get(f"/api/projects/{p['id']}", headers=bob["headers"]).status_code == 404
    up = client.post(f"/api/projects/{p['id']}/uploads", files={"file": ("plan.png", samples.png(), "image/png")}, headers=bob["headers"])
    assert up.status_code == 404
    assert client.delete(f"/api/projects/{p['id']}", headers=bob["headers"]).status_code == 404
    assert client.get(f"/api/projects/{p['id']}", headers=alice["headers"]).status_code == 200


def test_unknown_and_malformed_ids(client, alice):
    assert client.get(f"/api/projects/{uuid.uuid4()}", headers=alice["headers"]).status_code == 404
    assert client.get("/api/projects/not-a-uuid", headers=alice["headers"]).status_code == 422


def test_deleting_a_project_removes_its_files_from_storage(client, alice, storage, repo):
    """Acceptance test 22."""
    p = _create(client, alice)
    for name, data in (("plan.png", samples.png()), ("photo.jpg", samples.jpeg())):
        assert client.post(f"/api/projects/{p['id']}/uploads", files={"file": (name, data)}, headers=alice["headers"]).status_code == 201
    assert len(storage.objects) == 2
    assert client.delete(f"/api/projects/{p['id']}", headers=alice["headers"]).status_code == 204
    assert storage.objects == {} and repo.files == {}
    assert client.get(f"/api/projects/{p['id']}", headers=alice["headers"]).status_code == 404


def test_website_config_is_served_from_settings_with_public_values_only(client, settings):
    res = client.get("/assets/config.js")
    assert res.status_code == 200 and res.headers["content-type"].startswith("application/javascript")
    assert settings.supabase_url in res.text and settings.supabase_anon_key in res.text
    assert settings.supabase_jwt_secret not in res.text


# ---------------------------------------------------------------- deleting files, renders and videos
def test_files_renders_and_videos_can_be_deleted(render_settings, repo, storage, alice, bob):
    from fastapi.testclient import TestClient
    from app.auth import TokenVerifier
    from app.jobs import InlineRunner
    from app.main import create_app
    from .conftest import FakeImages
    from .test_studio import new_project, upload
    from . import samples
    c = TestClient(create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=FakeImages(), runner=InlineRunner()))
    pid = new_project(c, alice)
    sketch = upload(c, alice, pid, "front.png", samples.png(64, 48))
    # a render, and a revision of it
    c.post(f"/api/projects/{pid}/architectural-render", json={"prompt": "white villa", "references": [{"file_id": sketch["id"], "role": "base"}]},
           headers={**alice["headers"], "Idempotency-Key": "del-test-0001"})
    (r1,) = c.get(f"/api/projects/{pid}/outputs", headers=alice["headers"]).json()["images"]
    c.post(f"/api/renders/{r1['id']}/edit", json={"instruction": "dark roof"}, headers={**alice["headers"], "Idempotency-Key": "del-test-0002"})
    assert len(repo.images) == 2
    # others cannot delete
    assert c.delete(f"/api/renders/{r1['id']}", headers=bob["headers"]).status_code == 404
    assert c.delete(f"/api/projects/{pid}/files/{sketch['id']}", headers=bob["headers"]).status_code == 404
    # delete the first render: its pictures go, the revision stays
    paths = [repo.images[r1["id"]]["storage_path"], repo.images[r1["id"]]["base_path"]]
    assert c.delete(f"/api/renders/{r1['id']}", headers=alice["headers"]).status_code == 204
    assert r1["id"] not in repo.images and not any(p in storage.buckets["renders"] for p in paths)
    (left,) = repo.images.values(); assert left["parent_image_id"] is None
    # delete the uploaded sketch: file and record go, the render made from it stays
    path = repo.files[sketch["id"]]["storage_path"]
    assert c.delete(f"/api/projects/{pid}/files/{sketch['id']}", headers=alice["headers"]).status_code == 204
    assert sketch["id"] not in repo.files and path not in storage.objects and len(repo.images) == 1
    # an older project's IFC, with the 3D model made from it: both go
    import uuid as _uuid
    user = c.app.state.verifier.verify(alice["headers"]["Authorization"].split()[1])
    fid, mid = str(_uuid.uuid4()), str(_uuid.uuid4())
    ifc_path, glb = f"{alice['id']}/{pid}/{fid}.ifc", f"{alice['id']}/{pid}/{mid}.glb"
    storage.upload(user, ifc_path, samples.ifc(), "application/x-step")
    storage.upload(user, glb, b"glTF", "model/gltf-binary", bucket="models")
    repo.create_source_file(user, {"id": fid, "project_id": pid, "original_name": "house.ifc", "storage_path": ifc_path, "detected_type": "ifc", "size_bytes": 10,
                                   "checksum_sha256": "0" * 64, "validation": {"status": "valid", "details": {}}, "processing_status": "uploaded"})
    repo.create_model(user, {"id": mid, "project_id": pid, "source_file_id": fid, "glb_path": glb})
    assert c.delete(f"/api/projects/{pid}/files/{fid}", headers=alice["headers"]).status_code == 204
    assert repo.models == {} and glb not in storage.buckets["models"] and fid not in repo.files
    # an older project's walkthrough shot: it goes with its picture
    pic = upload(c, alice, pid, "Shot - Kitchen.png", samples.png(32, 24))
    repo.create_shot(user, {"project_id": pid, "source_file_id": pic["id"], "name": "Kitchen", "pose": {}})
    assert c.delete(f"/api/projects/{pid}/files/{pic['id']}", headers=alice["headers"]).status_code == 204
    assert repo.shots == {}
    # a video
    vid = "11111111-2222-3333-4444-555555555555"
    vpath = f"{alice['id']}/{pid}/{vid}.mp4"
    storage.buckets["videos"][vpath] = (b"mp4", "video/mp4")
    repo.videos[vid] = {"id": vid, "project_id": pid, "owner_id": alice["id"], "storage_path": vpath, "format": "16:9", "created_at": "2026-10-22T00:00:00+00:00"}
    assert c.delete(f"/api/videos/{vid}", headers=bob["headers"]).status_code == 404
    assert c.delete(f"/api/videos/{vid}", headers=alice["headers"]).status_code == 204
    assert repo.videos == {} and storage.buckets["videos"] == {}
    assert c.delete(f"/api/videos/{vid}", headers=alice["headers"]).status_code == 404
