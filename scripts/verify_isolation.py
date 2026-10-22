"""Live check of acceptance tests 14 and 22 against a real Supabase project and a running API.

Needs two confirmed test accounts (Supabase dashboard > Authentication > Users > Add user,
tick "Auto confirm"). Settings come from the environment (see .env.example):

    SUPABASE_URL, SUPABASE_ANON_KEY, API_URL,
    TEST_USER_A_EMAIL, TEST_USER_A_PASSWORD, TEST_USER_B_EMAIL, TEST_USER_B_PASSWORD

Run:  python scripts/verify_isolation.py
It creates one project for user A, tries to reach it as user B through the API, the
database and storage, then deletes it. Every check prints PASS or FAIL.
"""

from __future__ import annotations

import os
import struct
import sys
import zlib

import httpx

env = os.environ.get
SB, ANON, API = env("SUPABASE_URL", "").rstrip("/"), env("SUPABASE_ANON_KEY", ""), env("API_URL", "http://localhost:8000").rstrip("/")
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, info: str = ""):
    results.append((name, ok, info))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({info})" if info and not ok else ""))


def sign_in(email: str, password: str) -> str:
    r = httpx.post(f"{SB}/auth/v1/token?grant_type=password", headers={"apikey": ANON}, json={"email": email, "password": password}, timeout=20)
    r.raise_for_status()
    return r.json()["access_token"]


def tiny_png() -> bytes:
    def chunk(k, d):
        return struct.pack(">I", len(d)) + k + d + struct.pack(">I", zlib.crc32(k + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"\x00" + b"\x00\x00\x00" * 2 + b"\x00" + b"\x00\x00\x00" * 2)) + chunk(b"IEND", b"")


def main() -> int:
    missing = [k for k in ("SUPABASE_URL", "SUPABASE_ANON_KEY", "TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD", "TEST_USER_B_EMAIL", "TEST_USER_B_PASSWORD") if not env(k)]
    if missing:
        print("Missing settings: " + ", ".join(missing)); return 2
    a = sign_in(env("TEST_USER_A_EMAIL"), env("TEST_USER_A_PASSWORD"))
    b = sign_in(env("TEST_USER_B_EMAIL"), env("TEST_USER_B_PASSWORD"))
    A, Bh = {"Authorization": f"Bearer {a}"}, {"Authorization": f"Bearer {b}"}
    api = httpx.Client(base_url=f"{API}/api", timeout=30)

    p = api.post("/projects", json={"name": "Isolation check"}, headers=A)
    check("user A can create a project", p.status_code == 201, p.text[:200])
    if p.status_code != 201:
        return 1
    pid = p.json()["id"]
    up = api.post(f"/projects/{pid}/uploads", files={"file": ("check.png", tiny_png(), "image/png")}, headers=A)
    check("user A can upload a file", up.status_code == 201, up.text[:200])
    path = up.json().get("storage_path", "") if up.status_code == 201 else ""

    check("API: B's project list does not include it", all(x["id"] != pid for x in api.get("/projects", headers=Bh).json()))
    check("API: B gets 404 opening it by ID", api.get(f"/projects/{pid}", headers=Bh).status_code == 404)
    check("API: B cannot upload into it", api.post(f"/projects/{pid}/uploads", files={"file": ("x.png", tiny_png())}, headers=Bh).status_code == 404)
    check("API: B cannot delete it", api.delete(f"/projects/{pid}", headers=Bh).status_code == 404)

    db = {"apikey": ANON, "Authorization": f"Bearer {b}"}
    rows = httpx.get(f"{SB}/rest/v1/projects", params={"id": f"eq.{pid}", "select": "*"}, headers=db, timeout=20).json()
    check("Database (RLS): B's direct query returns nothing", rows == [], str(rows)[:200])
    files = httpx.get(f"{SB}/rest/v1/source_files", params={"project_id": f"eq.{pid}", "select": "*"}, headers=db, timeout=20).json()
    check("Database (RLS): B cannot read its file records", files == [], str(files)[:200])
    upd = httpx.patch(f"{SB}/rest/v1/projects", params={"id": f"eq.{pid}"}, json={"name": "hacked"}, headers={**db, "Prefer": "return=representation"}, timeout=20)
    still = api.get(f"/projects/{pid}", headers=A).json().get("name")
    check("Database (RLS): B cannot rename it", upd.status_code < 400 and (not upd.content or upd.json() == []) and still == "Isolation check", f"{upd.status_code} {upd.text[:120]} name={still}")
    if path:
        r = httpx.get(f"{SB}/storage/v1/object/source-files/{path}", headers=db, timeout=20)
        check("Storage: B cannot download A's file", r.status_code in (400, 403, 404), str(r.status_code))
        r = httpx.get(f"{SB}/storage/v1/object/source-files/{path}", headers={"apikey": ANON, "Authorization": f"Bearer {a}"}, timeout=20)
        check("Storage: A can download their own file", r.status_code == 200 and r.content == tiny_png(), str(r.status_code))
        r = httpx.get(f"{SB}/storage/v1/object/public/source-files/{path}", timeout=20)
        check("Storage: the bucket is not public", r.status_code in (400, 403, 404), str(r.status_code))

    d = api.delete(f"/projects/{pid}", headers=A)
    check("user A can delete the project", d.status_code == 204, d.text[:200])
    if path:
        # Ask storage for the folder listing rather than downloading: Supabase's CDN can keep
        # serving a just-deleted object for up to a minute, but the listing is authoritative.
        folder, _, name = path.rpartition("/")
        r = httpx.post(f"{SB}/storage/v1/object/list/source-files", json={"prefix": f"{folder}/", "limit": 100},
                       headers={"apikey": ANON, "Authorization": f"Bearer {a}"}, timeout=20)
        left = [o.get("name") for o in r.json()] if r.status_code == 200 else None
        check("Deleting the project removed its file from storage", left is not None and name not in left, f"{r.status_code} {left}")
    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)} of {len(results)} checks passed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
