"""Test fixtures.

The fake repository and storage behave like Supabase with row-level security on:
every read and write is limited to the calling user's rows. They let the API's own
ownership checks be tested here; the same isolation is checked against a real
Supabase project by scripts/verify_isolation.py once one is configured.
"""

from __future__ import annotations

import copy
import time
import uuid
from datetime import datetime, timezone

import jwt
import pytest
from fastapi.testclient import TestClient

from app.auth import TokenVerifier
from app.config import Settings
from app.main import create_app

SECRET = "test-secret-for-hs256-tokens-only-0123456789"


class FakeRepo:
    def __init__(self):
        self.projects: dict[str, dict] = {}
        self.files: dict[str, dict] = {}

    def _now(self):
        return datetime.now(timezone.utc).isoformat()

    def create_project(self, user, name):
        row = {"id": str(uuid.uuid4()), "owner_id": user.id, "name": name, "status": "draft", "input_type": "unknown", "created_at": self._now(), "updated_at": self._now()}
        self.projects[row["id"]] = row
        return copy.deepcopy(row)

    def list_projects(self, user):
        return [copy.deepcopy(p) for p in sorted(self.projects.values(), key=lambda p: p["created_at"], reverse=True) if p["owner_id"] == user.id]

    def get_project(self, user, project_id):
        p = self.projects.get(project_id)
        return copy.deepcopy(p) if p and p["owner_id"] == user.id else None

    def update_project(self, user, project_id, fields):
        p = self.projects.get(project_id)
        if not p or p["owner_id"] != user.id:
            return None
        p.update(fields)
        return copy.deepcopy(p)

    def delete_project(self, user, project_id):
        p = self.projects.get(project_id)
        if not p or p["owner_id"] != user.id:
            return False
        del self.projects[project_id]
        for fid in [k for k, f in self.files.items() if f["project_id"] == project_id]:
            del self.files[fid]
        return True

    def create_source_file(self, user, record):
        p = self.projects.get(record["project_id"])
        assert p and p["owner_id"] == user.id, "row-level security would reject this insert"
        row = {**record, "owner_id": user.id, "created_at": self._now()}
        self.files[row["id"]] = row
        return copy.deepcopy(row)

    def list_source_files(self, user, project_id):
        return [copy.deepcopy(f) for f in self.files.values() if f["project_id"] == project_id and f["owner_id"] == user.id]


class FakeStorage:
    def __init__(self):
        self.objects: dict[str, tuple[bytes, str]] = {}

    def upload(self, user, path, data, content_type):
        assert path.split("/")[0] == user.id, "storage policy would reject an upload outside the user's folder"
        assert path not in self.objects, "originals are never overwritten"
        self.objects[path] = (bytes(data), content_type)

    def remove(self, user, paths):
        for p in paths:
            assert p.split("/")[0] == user.id
            self.objects.pop(p, None)


def make_token(sub: str, *, email: str | None = None, exp_in: int = 3600, aud: str = "authenticated", role: str = "authenticated", secret: str = SECRET) -> str:
    now = int(time.time())
    return jwt.encode({"sub": sub, "email": email or f"{sub[:8]}@example.com", "aud": aud, "role": role, "iat": now, "exp": now + exp_in}, secret, algorithm="HS256")


@pytest.fixture
def settings():
    return Settings(supabase_url="https://example.supabase.co", supabase_anon_key="anon-public-key", supabase_jwt_secret=SECRET, max_upload_bytes=2 * 1024 * 1024)


@pytest.fixture
def repo():
    return FakeRepo()


@pytest.fixture
def storage():
    return FakeStorage()


@pytest.fixture
def client(settings, repo, storage):
    app = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings))
    return TestClient(app)


@pytest.fixture
def alice():
    uid = str(uuid.uuid4())
    return {"id": uid, "headers": {"Authorization": f"Bearer {make_token(uid)}"}}


@pytest.fixture
def bob():
    uid = str(uuid.uuid4())
    return {"id": uid, "headers": {"Authorization": f"Bearer {make_token(uid)}"}}
