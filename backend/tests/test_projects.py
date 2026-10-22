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
    for name, data in (("plan.png", samples.png()), ("drawings.pdf", samples.pdf(3))):
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
