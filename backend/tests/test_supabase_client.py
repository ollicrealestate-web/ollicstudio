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
