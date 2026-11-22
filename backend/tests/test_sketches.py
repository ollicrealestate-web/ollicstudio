"""Sketch saving: create, list, open, save, rename, delete; only the owner can see or change a sketch."""

import uuid


def _doc(name="House", levels=1):
    return {"schemaVersion": 1, "name": name, "levels": [{"id": f"lv-{i}", "name": f"Level {i + 1}", "elevation": 3000 * i} for i in range(levels)],
            "walls": [], "lines": [{"id": "ml-1", "kind": "model", "levelId": "lv-0", "style": "thin", "shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 4500, "y": 0}}]}


def _create(client, user, name="Lekki duplex", doc=None):
    res = client.post("/api/sketches", json={"name": name, "doc": doc or _doc(name)}, headers=user["headers"])
    assert res.status_code == 201, res.text
    return res.json()


def test_create_list_open_save_and_delete(client, alice):
    s = _create(client, alice)
    assert s["owner_id"] == alice["id"] and s["name"] == "Lekki duplex" and s["doc"]["lines"][0]["b"]["x"] == 4500
    listed = client.get("/api/sketches", headers=alice["headers"]).json()
    assert [x["id"] for x in listed] == [s["id"]] and "doc" not in listed[0]
    doc = client.get(f"/api/sketches/{s['id']}", headers=alice["headers"]).json()["doc"]
    doc["lines"][0]["b"]["x"] = 6000
    up = client.put(f"/api/sketches/{s['id']}", json={"name": "Lekki duplex B", "doc": doc}, headers=alice["headers"])
    assert up.status_code == 200, up.text
    again = client.get(f"/api/sketches/{s['id']}", headers=alice["headers"]).json()
    assert again["name"] == "Lekki duplex B" and again["doc"]["lines"][0]["b"]["x"] == 6000 and again["doc"]["name"] == "Lekki duplex B"
    assert client.delete(f"/api/sketches/{s['id']}", headers=alice["headers"]).status_code == 204
    assert client.get(f"/api/sketches/{s['id']}", headers=alice["headers"]).status_code == 404


def test_another_user_cannot_see_open_save_or_delete_it(client, alice, bob):
    s = _create(client, alice)
    assert client.get("/api/sketches", headers=bob["headers"]).json() == []
    assert client.get(f"/api/sketches/{s['id']}", headers=bob["headers"]).status_code == 404
    assert client.put(f"/api/sketches/{s['id']}", json={"name": "mine now"}, headers=bob["headers"]).status_code == 404
    assert client.delete(f"/api/sketches/{s['id']}", headers=bob["headers"]).status_code == 404
    assert client.get(f"/api/sketches/{s['id']}", headers=alice["headers"]).json()["name"] == "Lekki duplex"


def test_needs_sign_in(client):
    assert client.get("/api/sketches").status_code == 401
    assert client.post("/api/sketches", json={"name": "x", "doc": _doc()}).status_code == 401


def test_documents_are_checked(client, alice):
    h = alice["headers"]
    assert client.post("/api/sketches", json={"name": "x", "doc": {"hello": 1}}, headers=h).status_code == 422
    assert client.post("/api/sketches", json={"name": "x", "doc": {"levels": []}}, headers=h).status_code == 422
    assert client.post("/api/sketches", json={"name": "x", "doc": _doc(levels=11)}, headers=h).status_code == 422
    assert client.post("/api/sketches", json={"name": "x", "doc": {**_doc(), "schemaVersion": 99}}, headers=h).status_code == 422
    assert client.post("/api/sketches", json={"name": "   ", "doc": _doc()}, headers=h).status_code == 422
    assert client.post("/api/sketches", json={"name": "x" * 121, "doc": _doc()}, headers=h).status_code == 422
    big = {**_doc(), "lines": [{"id": f"ml-{i}", "pad": "x" * 1000} for i in range(9000)]}
    assert client.post("/api/sketches", json={"name": "big", "doc": big}, headers=h).status_code == 422
    assert _create(client, alice, "  Ikeja   bungalow ")["name"] == "Ikeja bungalow"
    s = _create(client, alice)
    assert client.put(f"/api/sketches/{s['id']}", json={}, headers=h).status_code == 422


def test_unknown_and_malformed_ids(client, alice):
    assert client.get(f"/api/sketches/{uuid.uuid4()}", headers=alice["headers"]).status_code == 404
    assert client.get("/api/sketches/not-a-uuid", headers=alice["headers"]).status_code == 422
