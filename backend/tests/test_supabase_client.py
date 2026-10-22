"""Checks the exact requests sent to Supabase, using a mock transport (no network)."""

import json
import pathlib
import re

import httpx

from app.auth import CurrentUser
from app.config import Settings
from app.supabase import SupabaseRepository, SupabaseStorage

USER = CurrentUser(id="11111111-1111-4111-8111-111111111111", email="a@example.com", token="user-access-token")
SETTINGS = Settings(supabase_url="https://proj.supabase.co", supabase_anon_key="anon-public-key")


def _recorder(responses):
    calls = []

    def handler(request: httpx.Request):
        calls.append(request)
        body = responses(request)
        return httpx.Response(200, json=body) if body is not None else httpx.Response(200)
    return calls, handler


def test_database_calls_act_as_the_user_and_filter_by_owner():
    calls, handler = _recorder(lambda r: [{"id": "p1", "owner_id": USER.id}])
    repo = SupabaseRepository(SETTINGS, httpx.Client(base_url="https://proj.supabase.co/rest/v1", transport=httpx.MockTransport(handler)))
    repo.list_projects(USER)
    repo.get_project(USER, "22222222-2222-4222-8222-222222222222")
    repo.create_project(USER, "House")
    repo.delete_project(USER, "22222222-2222-4222-8222-222222222222")
    for req in calls:
        assert req.headers["apikey"] == "anon-public-key"
        assert req.headers["authorization"] == "Bearer user-access-token"  # the user's own token, so RLS applies
    get_list, get_one, post, delete = calls
    assert get_list.url.params["owner_id"] == f"eq.{USER.id}"
    assert get_one.url.params["owner_id"] == f"eq.{USER.id}" and get_one.url.params["id"].startswith("eq.")
    assert json.loads(post.content) == {"name": "House", "owner_id": USER.id} and post.headers["prefer"] == "return=representation"
    assert delete.method == "DELETE" and delete.url.params["owner_id"] == f"eq.{USER.id}"


def test_storage_uploads_never_overwrite_and_deletes_list_paths():
    calls, handler = _recorder(lambda r: None)
    st = SupabaseStorage(SETTINGS, httpx.Client(base_url="https://proj.supabase.co/storage/v1", transport=httpx.MockTransport(handler)))
    st.upload(USER, f"{USER.id}/p/f.png", b"data", "image/png")
    st.remove(USER, [f"{USER.id}/p/f.png"])
    up, rm = calls
    assert up.url.path == f"/storage/v1/object/source-files/{USER.id}/p/f.png" and up.headers["x-upsert"] == "false"
    assert up.headers["authorization"] == "Bearer user-access-token"
    assert json.loads(rm.content) == {"prefixes": [f"{USER.id}/p/f.png"]}


def test_request_handlers_never_touch_the_service_role_key():
    """Module L: the service-role key bypasses RLS, so it must not appear in API code."""
    app_dir = pathlib.Path(__file__).resolve().parents[1] / "app"
    for path in app_dir.rglob("*.py"):
        assert not re.search(r"service[_-]?role", path.read_text(), re.IGNORECASE), f"{path.name} mentions the service role"


def test_phase2_tables_are_read_and_written_as_the_user_with_owner_filters():
    calls, handler = _recorder(lambda r: [{"id": "j1", "owner_id": USER.id}])
    repo = SupabaseRepository(SETTINGS, httpx.Client(base_url="https://proj.supabase.co/rest/v1", transport=httpx.MockTransport(handler)))
    repo.create_job(USER, {"project_id": "p", "type": "concept_render", "input": {}})
    repo.get_job(USER, "j1")
    repo.update_job(USER, "j1", {"status": "running"})
    repo.list_rendered_images(USER, "p")
    repo.create_usage_event(USER, {"provider": "openai"})
    repo.list_usage_events(USER)
    for req in calls:
        assert req.headers["authorization"] == "Bearer user-access-token"
        if req.method in ("GET", "PATCH"):
            assert req.url.params["owner_id"] == f"eq.{USER.id}"
        else:
            assert json.loads(req.content)["owner_id"] == USER.id
    assert [c.url.path for c in calls] == ["/rest/v1/jobs", "/rest/v1/jobs", "/rest/v1/jobs", "/rest/v1/rendered_images", "/rest/v1/usage_events", "/rest/v1/usage_events"]


def test_storage_signs_and_downloads_in_the_named_bucket():
    def handler(request: httpx.Request):
        if request.url.path.startswith("/storage/v1/object/sign/"):
            paths = json.loads(request.content)["paths"]
            return httpx.Response(200, json=[{"path": p, "signedURL": f"/object/sign/renders/{p}?token=abc", "error": None} for p in paths])
        return httpx.Response(200, content=b"jpeg-bytes")
    calls = []
    store = SupabaseStorage(SETTINGS, httpx.Client(base_url="https://proj.supabase.co/storage/v1", transport=httpx.MockTransport(lambda r: calls.append(r) or handler(r))))
    links = store.signed_urls(USER, [f"{USER.id}/p/r.jpg"], bucket="renders", expires_in=600)
    assert links == {f"{USER.id}/p/r.jpg": f"https://proj.supabase.co/storage/v1/object/sign/renders/{USER.id}/p/r.jpg?token=abc"}
    assert json.loads(calls[0].content) == {"expiresIn": 600, "paths": [f"{USER.id}/p/r.jpg"]}
    assert store.download(USER, f"{USER.id}/p/r.jpg", bucket="renders") == b"jpeg-bytes"
    assert calls[1].url.path == f"/storage/v1/object/renders/{USER.id}/p/r.jpg"
    assert all(c.headers["authorization"] == "Bearer user-access-token" for c in calls)
