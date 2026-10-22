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
from app.jobs import InlineRunner
from app.main import create_app
from app.openai_images import ImageResult, ProviderError

SECRET = "test-secret-for-hs256-tokens-only-0123456789"


class FakeRepo:
    def __init__(self):
        self.projects: dict[str, dict] = {}
        self.files: dict[str, dict] = {}
        self.jobs: dict[str, dict] = {}
        self.images: dict[str, dict] = {}
        self.usage: list[dict] = []
        self.plans: dict[str, str] = {}  # user id -> "premium"; everyone else is on "free"
        self.models: dict[str, dict] = {}
        self.components: list[dict] = []
        self.drafts: dict[str, dict] = {}

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
        for table in (self.files, self.jobs, self.images, self.models, self.drafts):  # on delete cascade
            for k in [k for k, r in table.items() if r["project_id"] == project_id]:
                del table[k]
        self.components = [c for c in self.components if c["project_id"] != project_id]
        for e in self.usage:  # on delete set null: usage history is kept
            if e.get("project_id") == project_id:
                e["project_id"] = None
        return True

    def create_source_file(self, user, record):
        p = self.projects.get(record["project_id"])
        assert p and p["owner_id"] == user.id, "row-level security would reject this insert"
        row = {**record, "owner_id": user.id, "created_at": self._now()}
        self.files[row["id"]] = row
        return copy.deepcopy(row)

    def list_source_files(self, user, project_id):
        return [copy.deepcopy(f) for f in self.files.values() if f["project_id"] == project_id and f["owner_id"] == user.id]

    def get_source_file(self, user, file_id):
        f = self.files.get(file_id)
        return copy.deepcopy(f) if f and f["owner_id"] == user.id else None

    # Phase 2 tables, with the same per-owner rules as row-level security
    def _owned_project(self, user, project_id):
        p = self.projects.get(project_id)
        assert p and p["owner_id"] == user.id, "row-level security would reject this insert"

    def _own(self, table, user, row_id):
        r = getattr(self, table).get(row_id)
        return copy.deepcopy(r) if r and r["owner_id"] == user.id else None

    def create_job(self, user, record):
        self._owned_project(user, record["project_id"])
        if record.get("idempotency_key") and any(j["owner_id"] == user.id and j.get("idempotency_key") == record["idempotency_key"] for j in self.jobs.values()):
            raise AssertionError("unique (owner_id, idempotency_key) would reject this insert")
        row = {"id": str(uuid.uuid4()), "attempts": 0, "result": None, "error": None, "started_at": None, "finished_at": None, "worker": None,
               **record, "owner_id": user.id, "created_at": self._now(), "updated_at": self._now()}
        self.jobs[row["id"]] = row
        return copy.deepcopy(row)

    def get_job(self, user, job_id):
        return self._own("jobs", user, job_id)

    def find_job_by_key(self, user, key):
        return next((copy.deepcopy(j) for j in self.jobs.values() if j["owner_id"] == user.id and j.get("idempotency_key") == key), None)

    def update_job(self, user, job_id, fields):
        j = self.jobs.get(job_id)
        if not j or j["owner_id"] != user.id:
            return None
        allowed = {"status", "stage", "result", "error", "attempts", "worker", "started_at", "finished_at"}
        assert set(fields) <= allowed, f"column grants would reject updating {set(fields) - allowed}"
        j.update(fields, updated_at=self._now())
        return copy.deepcopy(j)

    def list_jobs(self, user, project_id, limit=20):
        rows = [j for j in self.jobs.values() if j["project_id"] == project_id and j["owner_id"] == user.id]
        return [copy.deepcopy(j) for j in sorted(rows, key=lambda j: j["created_at"], reverse=True)][:limit]

    def count_jobs_since(self, user, since_iso, statuses, tier):
        return sum(1 for j in self.jobs.values() if j["owner_id"] == user.id and j["created_at"] >= since_iso and j["status"] in statuses and j["input"].get("tier") == tier)

    # Phase 3 and 3b
    def create_model(self, user, record):
        self._owned_project(user, record["project_id"])
        assert record["glb_path"].split("/")[:2] == [user.id, record["project_id"]], "path check constraint"
        row = {**record, "owner_id": user.id, "created_at": self._now()}
        self.models[row["id"]] = row
        return copy.deepcopy(row)

    def get_model(self, user, model_id):
        return self._own("models", user, model_id)

    def list_models(self, user, project_id):
        rows = [m for m in self.models.values() if m["project_id"] == project_id and m["owner_id"] == user.id]
        return [copy.deepcopy(m) for m in sorted(rows, key=lambda m: m["created_at"], reverse=True)]

    def add_components(self, user, rows):
        for r in rows:
            m = self.models.get(r["model_id"])
            assert m and m["owner_id"] == user.id, "row-level security would reject this insert"
            assert not any(c["model_id"] == r["model_id"] and c["global_id"] == r["global_id"] for c in self.components), "unique (model_id, global_id)"
            self.components.append({**r, "owner_id": user.id})

    def list_components(self, user, model_id, limit=5000):
        return [copy.deepcopy(c) for c in self.components if c["model_id"] == model_id and c["owner_id"] == user.id][:limit]

    def create_draft(self, user, record):
        self._owned_project(user, record["project_id"])
        row = {"layout": None, **record, "owner_id": user.id, "created_at": self._now(), "updated_at": self._now()}
        self.drafts[row["id"]] = row
        return copy.deepcopy(row)

    def get_draft(self, user, draft_id):
        return self._own("drafts", user, draft_id)

    def update_draft(self, user, draft_id, fields):
        d = self.drafts.get(draft_id)
        if not d or d["owner_id"] != user.id:
            return None
        d.update(fields, updated_at=self._now())
        return copy.deepcopy(d)

    def list_drafts(self, user, project_id):
        rows = [d for d in self.drafts.values() if d["project_id"] == project_id and d["owner_id"] == user.id]
        return [copy.deepcopy(d) for d in sorted(rows, key=lambda d: d["created_at"], reverse=True)]

    def get_profile(self, user):
        return {"id": user.id, "plan": self.plans.get(user.id, "free"), "role": "customer"}

    def create_rendered_image(self, user, record):
        self._owned_project(user, record["project_id"])
        assert record["storage_path"].split("/")[:2] == [user.id, record["project_id"]], "path check constraint"
        assert record["kind"] != "concept" or "concept" in record["label"].lower(), "concept label constraint"
        row = {**record, "owner_id": user.id, "created_at": self._now()}
        self.images[row["id"]] = row
        return copy.deepcopy(row)

    def get_rendered_image(self, user, image_id):
        return self._own("images", user, image_id)

    def list_rendered_images(self, user, project_id):
        rows = [i for i in self.images.values() if i["project_id"] == project_id and i["owner_id"] == user.id]
        return [copy.deepcopy(i) for i in sorted(rows, key=lambda i: i["created_at"], reverse=True)]

    def create_usage_event(self, user, record):
        if record.get("project_id"):
            self._owned_project(user, record["project_id"])
        row = {"id": str(uuid.uuid4()), **record, "owner_id": user.id, "created_at": self._now()}
        self.usage.append(row)
        return copy.deepcopy(row)

    def list_usage_events(self, user, limit=100):
        return [copy.deepcopy(e) for e in reversed(self.usage) if e["owner_id"] == user.id][:limit]


class FakeStorage:
    """Buckets keyed by name; source files live in "source-files" (the default)."""

    def __init__(self):
        self.buckets: dict[str, dict[str, tuple[bytes, str]]] = {"source-files": {}, "renders": {}, "models": {}}

    @property
    def objects(self):
        return self.buckets["source-files"]

    def upload(self, user, path, data, content_type, bucket=None):
        assert path.split("/")[0] == user.id, "storage policy would reject an upload outside the user's folder"
        b = self.buckets[bucket or "source-files"]
        assert path not in b, "objects are never overwritten"
        b[path] = (bytes(data), content_type)

    def remove(self, user, paths, bucket=None):
        for p in paths:
            assert p.split("/")[0] == user.id
            self.buckets[bucket or "source-files"].pop(p, None)

    def download(self, user, path, bucket=None):
        assert path.split("/")[0] == user.id, "storage policy would hide another user's file"
        return self.buckets[bucket or "source-files"][path][0]

    def signed_urls(self, user, paths, bucket=None, expires_in=3600):
        return {p: f"https://example.supabase.co/storage/v1/object/sign/{bucket}/{p}?token=t" for p in paths if p.split("/")[0] == user.id and p in self.buckets[bucket or "source-files"]}


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
    app = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings), runner=InlineRunner())
    return TestClient(app)


def jpeg_bytes(w=96, h=64, color=(180, 120, 90)) -> bytes:
    import io

    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "JPEG")
    return buf.getvalue()


class FakeImages:
    """Stands in for OpenAI in tests: records each call and returns a real JPEG with token usage."""

    USAGE = {"input_tokens": 1300, "input_tokens_details": {"text_tokens": 250, "image_tokens": 1050}, "output_tokens": 4160, "total_tokens": 5460}

    def __init__(self):
        self.calls: list[dict] = []
        self.fail_with: ProviderError | None = None
        self.usage: dict | None = dict(self.USAGE)
        self.on_call = None

    def _go(self, kind, **kw):
        self.calls.append({"kind": kind, **kw})
        if self.on_call:
            self.on_call()
        if self.fail_with:
            raise self.fail_with
        return ImageResult(data=jpeg_bytes(150, 100), output_format="jpeg", model=kw["model"], usage=self.usage, request_id="req_test")

    def generate(self, **kw):
        return self._go("generate", **kw)

    def edit(self, **kw):
        return self._go("edit", **kw)


@pytest.fixture
def fake_images():
    return FakeImages()


@pytest.fixture
def render_settings():
    return Settings(supabase_url="https://example.supabase.co", supabase_anon_key="anon-public-key", supabase_jwt_secret=SECRET,
                    max_upload_bytes=2 * 1024 * 1024, openai_api_key="sk-test-not-a-real-key",
                    cloudflare_account_id="acct-test", cloudflare_api_token="cf-test-not-a-real-token")


@pytest.fixture
def rclient(render_settings, repo, storage, fake_images):
    app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=fake_images, runner=InlineRunner())
    return TestClient(app)


@pytest.fixture
def alice():
    uid = str(uuid.uuid4())
    return {"id": uid, "headers": {"Authorization": f"Bearer {make_token(uid)}"}}


@pytest.fixture
def bob():
    uid = str(uuid.uuid4())
    return {"id": uid, "headers": {"Authorization": f"Bearer {make_token(uid)}"}}
