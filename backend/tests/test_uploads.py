import hashlib

import pytest

from app.filetypes import UploadRejected, inspect_upload

from . import samples


@pytest.fixture
def project(client, alice):
    return client.post("/api/projects", json={"name": "Test"}, headers=alice["headers"]).json()


def _up(client, user, project, name, data):
    return client.post(f"/api/projects/{project['id']}/uploads", files={"file": (name, data)}, headers=user["headers"])


@pytest.mark.parametrize("name,data,kind", [
    ("plan.png", samples.png(), "png"),
    ("photo.JPG", samples.jpeg(), "jpeg"),
])
def test_supported_files_are_stored_privately_and_unmodified(client, alice, project, storage, name, data, kind):
    res = _up(client, alice, project, name, data)
    assert res.status_code == 201, res.text
    rec = res.json()
    assert rec["detected_type"] == kind and rec["original_name"] == name and rec["size_bytes"] == len(data)
    assert rec["checksum_sha256"] == hashlib.sha256(data).hexdigest()
    assert rec["storage_path"].startswith(f"{alice['id']}/{project['id']}/")
    assert storage.objects[rec["storage_path"]][0] == data  # the original, byte for byte
    assert rec["validation"]["status"] == "valid" and rec["processing_status"] == "uploaded"


def test_details_are_read_from_the_file(project):
    assert inspect_upload(samples.png(640, 480), "a.png").details == {"width": 640, "height": 480}


def test_project_input_type_is_set_by_the_first_image(client, alice, project):
    _up(client, alice, project, "sketch.png", samples.png())
    assert client.get(f"/api/projects/{project['id']}", headers=alice["headers"]).json()["input_type"] == "sketch"


@pytest.mark.parametrize("name,data,code,words", [
    ("plan.png", b"just some text pretending to be a picture", "unsupported", "text file"),
    ("drawings.pdf", samples.pdf(), "unsupported", "images only"),
    ("plan.png", samples.pdf(), "unsupported", "This is a PDF"),
    ("house.ifc", samples.ifc("IFC2X3"), "unsupported", "This is an IFC model"),
    ("photo.png", samples.jpeg(), "renamed", "contents are a JPEG"),
    ("plan.png", samples.png()[:-12], "corrupt", "incomplete"),
    ("photo.jpg", samples.jpeg()[:-2], "corrupt", "incomplete"),
    ("house.rvt", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64, "unsupported", "PNG or JPEG"),
    ("plans.zip", b"PK\x03\x04" + b"\x00" * 40, "unsupported", "ZIP"),
    ("empty.png", b"", "empty", "empty"),
])
def test_unsupported_renamed_and_corrupt_files_get_a_clear_reason(client, alice, project, storage, name, data, code, words):
    """Acceptance test 5."""
    res = _up(client, alice, project, name, data)
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert detail["code"] == code and words in detail["reason"]
    assert storage.objects == {}  # nothing is stored for a rejected file


def test_files_over_the_limit_are_refused(client, alice, project, storage):
    big = samples.png() + b"\x00" * (2 * 1024 * 1024)
    res = _up(client, alice, project, "huge.png", big)
    assert res.status_code == 413 and res.json()["detail"]["code"] == "too_large"
    assert storage.objects == {}


def test_a_failed_database_write_does_not_leave_a_stored_file(client, alice, project, repo, storage):
    from app.supabase import BackendUnavailable

    def boom(*_a, **_k):
        raise BackendUnavailable("database down")
    repo.create_source_file = boom
    res = _up(client, alice, project, "plan.png", samples.png())
    assert res.status_code == 503 and storage.objects == {}


def test_inspect_upload_never_trusts_the_extension():
    with pytest.raises(UploadRejected) as e:
        inspect_upload(samples.png(), "house.jpg")
    assert e.value.code == "renamed"
    assert inspect_upload(samples.jpeg(), "house").kind == "jpeg"  # no extension: the contents decide
