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
    def get_source_file(self, user: CurrentUser, file_id: str) -> dict | None: ...
    # Phase 2
    def create_job(self, user: CurrentUser, record: dict) -> dict: ...
    def get_job(self, user: CurrentUser, job_id: str) -> dict | None: ...
    def find_job_by_key(self, user: CurrentUser, key: str) -> dict | None: ...
    def update_job(self, user: CurrentUser, job_id: str, fields: dict) -> dict | None: ...
    def list_jobs(self, user: CurrentUser, project_id: str, limit: int = 20) -> list[dict]: ...
    def count_jobs_since(self, user: CurrentUser, since_iso: str, statuses: tuple[str, ...], tier: str) -> int: ...
    def get_profile(self, user: CurrentUser) -> dict | None: ...
    def create_rendered_image(self, user: CurrentUser, record: dict) -> dict: ...
    def get_rendered_image(self, user: CurrentUser, image_id: str) -> dict | None: ...
    def list_rendered_images(self, user: CurrentUser, project_id: str) -> list[dict]: ...
    def create_usage_event(self, user: CurrentUser, record: dict) -> dict: ...
    def list_usage_events(self, user: CurrentUser, limit: int = 100) -> list[dict]: ...


class FileStorage(Protocol):
    def upload(self, user: CurrentUser, path: str, data: bytes, content_type: str, bucket: str | None = None) -> None: ...
    def remove(self, user: CurrentUser, paths: list[str], bucket: str | None = None) -> None: ...
    def download(self, user: CurrentUser, path: str, bucket: str | None = None) -> bytes: ...
    def signed_urls(self, user: CurrentUser, paths: list[str], bucket: str | None = None, expires_in: int = 3600) -> dict[str, str]: ...


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

    def get_source_file(self, user, file_id):
        rows = self._call("GET", "/source_files", user, params={"select": "*", "id": _eq(file_id), "owner_id": _eq(user.id)})
        return rows[0] if rows else None

    # ------------------------------------------------------------ Phase 2: jobs, renders, usage
    def _insert(self, table, user, record):
        return self._call("POST", f"/{table}", user, json={**record, "owner_id": user.id}, prefer="return=representation")[0]

    def _one(self, table, user, row_id):
        rows = self._call("GET", f"/{table}", user, params={"select": "*", "id": _eq(row_id), "owner_id": _eq(user.id)})
        return rows[0] if rows else None

    def create_job(self, user, record):
        return self._insert("jobs", user, record)

    def get_job(self, user, job_id):
        return self._one("jobs", user, job_id)

    def find_job_by_key(self, user, key):
        rows = self._call("GET", "/jobs", user, params={"select": "*", "idempotency_key": _eq(key), "owner_id": _eq(user.id)})
        return rows[0] if rows else None

    def update_job(self, user, job_id, fields):
        rows = self._call("PATCH", "/jobs", user, params={"id": _eq(job_id), "owner_id": _eq(user.id)}, json=fields, prefer="return=representation")
        return rows[0] if rows else None

    def list_jobs(self, user, project_id, limit=20):
        return self._call("GET", "/jobs", user, params={"select": "*", "project_id": _eq(project_id), "owner_id": _eq(user.id), "order": "created_at.desc", "limit": str(limit)})

    def count_jobs_since(self, user, since_iso, statuses, tier):
        rows = self._call("GET", "/jobs", user, params={"select": "id", "owner_id": _eq(user.id), "created_at": f"gte.{since_iso}",
                                                       "status": f"in.({','.join(statuses)})", "input->>tier": _eq(tier), "limit": "1000"})
        return len(rows)

    def get_profile(self, user):
        rows = self._call("GET", "/profiles", user, params={"select": "id,plan,role", "id": _eq(user.id)})
        return rows[0] if rows else None

    def create_rendered_image(self, user, record):
        return self._insert("rendered_images", user, record)

    def get_rendered_image(self, user, image_id):
        return self._one("rendered_images", user, image_id)

    def list_rendered_images(self, user, project_id):
        return self._call("GET", "/rendered_images", user, params={"select": "*", "project_id": _eq(project_id), "owner_id": _eq(user.id), "order": "created_at.desc"})

    def create_usage_event(self, user, record):
        return self._insert("usage_events", user, record)

    def list_usage_events(self, user, limit=100):
        return self._call("GET", "/usage_events", user, params={"select": "*", "owner_id": _eq(user.id), "order": "created_at.desc", "limit": str(limit)})


class SupabaseStorage:
    def __init__(self, settings: Settings, client: httpx.Client | None = None):
        self._s = settings
        self._http = client or httpx.Client(base_url=f"{settings.supabase_url}/storage/v1", timeout=120)

    def _bucket(self, bucket):
        return bucket or self._s.storage_bucket

    def upload(self, user, path, data, content_type, bucket=None):
        headers = {**_user_headers(self._s, user), "Content-Type": content_type, "x-upsert": "false"}
        try:
            res = self._http.post(f"/object/{self._bucket(bucket)}/{path}", content=data, headers=headers)
        except httpx.HTTPError as exc:
            raise BackendUnavailable("File storage could not be reached.") from exc
        if res.status_code >= 400:
            raise BackendUnavailable(f"File storage returned {res.status_code} for the upload.")

    def remove(self, user, paths, bucket=None):
        if not paths:
            return
        try:
            res = self._http.request("DELETE", f"/object/{self._bucket(bucket)}", json={"prefixes": paths}, headers=_user_headers(self._s, user))
        except httpx.HTTPError as exc:
            raise BackendUnavailable("File storage could not be reached.") from exc
        if res.status_code >= 400:
            raise BackendUnavailable(f"File storage returned {res.status_code} when deleting files.")

    def download(self, user, path, bucket=None):
        try:
            res = self._http.get(f"/object/{self._bucket(bucket)}/{path}", headers=_user_headers(self._s, user))
        except httpx.HTTPError as exc:
            raise BackendUnavailable("File storage could not be reached.") from exc
        if res.status_code >= 400:
            raise BackendUnavailable(f"File storage returned {res.status_code} when reading a file.")
        return res.content

    def signed_urls(self, user, paths, bucket=None, expires_in=3600):
        """Short-lived links the browser can open directly; signing as the user means storage policies still apply."""
        if not paths:
            return {}
        try:
            res = self._http.post(f"/object/sign/{self._bucket(bucket)}", json={"expiresIn": expires_in, "paths": paths}, headers=_user_headers(self._s, user))
        except httpx.HTTPError as exc:
            raise BackendUnavailable("File storage could not be reached.") from exc
        if res.status_code >= 400:
            raise BackendUnavailable(f"File storage returned {res.status_code} when signing links.")
        out = {}
        for item in res.json():
            link = item.get("signedURL") or item.get("signedUrl")
            if item.get("error") or not link:
                continue
            url = link if link.startswith("http") else f"{self._s.supabase_url}/storage/v1{link}"
            out[item["path"]] = url
        return out
