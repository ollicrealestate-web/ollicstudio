"""Talks to Supabase's database (PostgREST) and storage APIs as the signed-in user.

Every call sends the project's public anon key plus the user's own access token,
so Supabase applies row-level security. Queries also filter by owner in code, so
a missing or mistaken policy still cannot expose another customer's data.
"""

from __future__ import annotations

from typing import Any, Protocol
from urllib.parse import quote

import httpx

from .auth import CurrentUser
from .config import Settings


class BackendUnavailable(Exception):
    """Supabase could not be reached or answered with an unexpected error."""


class Repository(Protocol):
    def create_project(self, user: CurrentUser, name: str) -> dict: ...
    def list_projects(self, user: CurrentUser) -> list[dict]: ...
    def get_project(self, user: CurrentUser, project_id: str) -> dict | None: ...
    def update_project(self, user: CurrentUser, project_id: str, fields: dict) -> dict | None: ...
    def delete_project(self, user: CurrentUser, project_id: str) -> bool: ...
    def create_source_file(self, user: CurrentUser, record: dict) -> dict: ...
    def list_source_files(self, user: CurrentUser, project_id: str) -> list[dict]: ...


class FileStorage(Protocol):
    def upload(self, user: CurrentUser, path: str, data: bytes, content_type: str) -> None: ...
    def remove(self, user: CurrentUser, paths: list[str]) -> None: ...


def _user_headers(settings: Settings, user: CurrentUser) -> dict[str, str]:
    return {"apikey": settings.supabase_anon_key, "Authorization": f"Bearer {user.token}"}


def _eq(value: str) -> str:
    return "eq." + quote(str(value), safe="-")


class SupabaseRepository:
    def __init__(self, settings: Settings, client: httpx.Client | None = None):
        self._s = settings
        self._http = client or httpx.Client(base_url=f"{settings.supabase_url}/rest/v1", timeout=20)

    def _call(self, method: str, path: str, user: CurrentUser, *, params=None, json: Any = None, prefer: str | None = None) -> Any:
        headers = _user_headers(self._s, user)
        if prefer:
            headers["Prefer"] = prefer
        try:
            res = self._http.request(method, path, params=params, json=json, headers=headers)
        except httpx.HTTPError as exc:
            raise BackendUnavailable(f"Supabase could not be reached: {exc.__class__.__name__}") from exc
        if res.status_code >= 400:
            raise BackendUnavailable(f"Supabase returned {res.status_code} for {method} {path}")
        return res.json() if res.content else None

    def create_project(self, user, name):
        rows = self._call("POST", "/projects", user, json={"name": name, "owner_id": user.id}, prefer="return=representation")
        return rows[0]

    def list_projects(self, user):
        return self._call("GET", "/projects", user, params={"select": "*", "owner_id": _eq(user.id), "order": "created_at.desc"})

    def get_project(self, user, project_id):
        rows = self._call("GET", "/projects", user, params={"select": "*", "id": _eq(project_id), "owner_id": _eq(user.id)})
        return rows[0] if rows else None

    def update_project(self, user, project_id, fields):
        rows = self._call("PATCH", "/projects", user, params={"id": _eq(project_id), "owner_id": _eq(user.id)}, json=fields, prefer="return=representation")
        return rows[0] if rows else None

    def delete_project(self, user, project_id):
        rows = self._call("DELETE", "/projects", user, params={"id": _eq(project_id), "owner_id": _eq(user.id)}, prefer="return=representation")
        return bool(rows)

    def create_source_file(self, user, record):
        rows = self._call("POST", "/source_files", user, json={**record, "owner_id": user.id}, prefer="return=representation")
        return rows[0]

    def list_source_files(self, user, project_id):
        return self._call("GET", "/source_files", user, params={"select": "*", "project_id": _eq(project_id), "owner_id": _eq(user.id), "order": "created_at.desc"})


class SupabaseStorage:
    def __init__(self, settings: Settings, client: httpx.Client | None = None):
        self._s = settings
        self._http = client or httpx.Client(base_url=f"{settings.supabase_url}/storage/v1", timeout=120)

    def upload(self, user, path, data, content_type):
        headers = {**_user_headers(self._s, user), "Content-Type": content_type, "x-upsert": "false"}
        try:
            res = self._http.post(f"/object/{self._s.storage_bucket}/{path}", content=data, headers=headers)
        except httpx.HTTPError as exc:
            raise BackendUnavailable("File storage could not be reached.") from exc
        if res.status_code >= 400:
            raise BackendUnavailable(f"File storage returned {res.status_code} for the upload.")

    def remove(self, user, paths):
        if not paths:
            return
        try:
            res = self._http.request("DELETE", f"/object/{self._s.storage_bucket}", json={"prefixes": paths}, headers=_user_headers(self._s, user))
        except httpx.HTTPError as exc:
            raise BackendUnavailable("File storage could not be reached.") from exc
        if res.status_code >= 400:
            raise BackendUnavailable(f"File storage returned {res.status_code} when deleting files.")
