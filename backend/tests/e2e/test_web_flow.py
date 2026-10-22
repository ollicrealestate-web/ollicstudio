"""End-to-end: the real website and the real API in a browser, with only Supabase replaced.

A small stand-in for Supabase Auth issues HS256 tokens with the test secret; the API
verifies them exactly as it verifies real ones. Skipped when Playwright is missing.
"""

from __future__ import annotations

import socket
import threading
import time
import uuid
from pathlib import Path

import jwt
import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from app.auth import TokenVerifier
from app.config import Settings
from app.main import create_app

from ..conftest import SECRET, FakeRepo, FakeStorage
from .. import samples

playwright = pytest.importorskip("playwright.sync_api")
WEB = Path(__file__).resolve().parents[3] / "web"


def _free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close(); return port


def fake_supabase_auth() -> FastAPI:
    users: dict[str, dict] = {}
    auth = FastAPI()

    def session(u):
        now = int(time.time())
        token = jwt.encode({"sub": u["id"], "email": u["email"], "aud": "authenticated", "role": "authenticated", "iat": now, "exp": now + 3600}, SECRET, algorithm="HS256")
        return {"access_token": token, "refresh_token": "r-" + u["id"], "expires_in": 3600, "expires_at": now + 3600, "user": {"id": u["id"], "email": u["email"]}}

    @auth.post("/auth/v1/signup")
    async def signup(req: Request):
        b = await req.json()
        if b["email"] in users:
            return JSONResponse({"msg": "User already registered"}, 422)
        users[b["email"]] = {"id": str(uuid.uuid4()), "email": b["email"], "password": b["password"]}
        return session(users[b["email"]])

    @auth.post("/auth/v1/token")
    async def token(req: Request, grant_type: str):
        b = await req.json()
        if grant_type == "password":
            u = users.get(b["email"])
            if not u or u["password"] != b["password"]:
                return JSONResponse({"error_description": "Invalid login credentials"}, 400)
            return session(u)
        u = next((u for u in users.values() if "r-" + u["id"] == b.get("refresh_token")), None)
        return session(u) if u else JSONResponse({"msg": "Invalid Refresh Token"}, 400)

    @auth.get("/auth/v1/user")
    async def user(req: Request):
        claims = jwt.decode(req.headers["authorization"].split()[1], SECRET, algorithms=["HS256"], audience="authenticated")
        return {"id": claims["sub"], "email": claims["email"]}

    @auth.post("/auth/v1/logout")
    async def logout():
        return Response(status_code=204)
    return auth


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    web = tmp_path_factory.mktemp("web")
    for p in WEB.rglob("*"):
        if p.is_file():
            dest = web / p.relative_to(WEB); dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(p.read_bytes())
    auth_port, api_port = _free_port(), _free_port()
    (web / "assets" / "config.js").write_text(f'window.OLLIC_CONFIG = {{ supabaseUrl: "http://127.0.0.1:{auth_port}", supabaseAnonKey: "anon", apiUrl: "" }};')
    settings = Settings(supabase_url=f"http://127.0.0.1:{auth_port}", supabase_anon_key="anon", supabase_jwt_secret=SECRET, web_dir=str(web), web_origins=(f"http://127.0.0.1:{api_port}",))
    repo, storage = FakeRepo(), FakeStorage()
    api = create_app(settings, repo=repo, storage=storage, verifier=TokenVerifier(settings))
    auth = fake_supabase_auth()
    from fastapi.middleware.cors import CORSMiddleware
    auth.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    servers = [uvicorn.Server(uvicorn.Config(a, host="127.0.0.1", port=p, log_level="warning")) for a, p in ((auth, auth_port), (api, api_port))]
    threads = [threading.Thread(target=s.run, daemon=True) for s in servers]
    for t in threads: t.start()
    for s in servers:
        while not s.started: time.sleep(0.05)
    yield {"url": f"http://127.0.0.1:{api_port}", "repo": repo, "storage": storage, "dir": web}
    for s in servers: s.should_exit = True


def test_customer_journey_and_isolation(stack, tmp_path):
    png = tmp_path / "ground-floor.png"; png.write_bytes(samples.png(800, 600))
    fake = tmp_path / "site-photo.png"; fake.write_bytes(samples.pdf())
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.route("**/fonts.googleapis.com/**", lambda r: r.abort()); page.route("**/fonts.gstatic.com/**", lambda r: r.abort())
        errors = []; page.on("pageerror", lambda e: errors.append(str(e)))

        # sign up and land on an empty dashboard
        page.goto(stack["url"] + "/app.html#sign-up")
        page.fill("#upName", "Ada Okafor"); page.fill("#upEmail", "ada@example.com"); page.fill("#upPassword", "correct-horse-1")
        page.click("#signUpForm button[type=submit]")
        page.wait_for_selector("#projectsView:not([hidden])")
        assert page.is_visible("#projectsEmpty") and page.inner_text("#userEmail") == "ada@example.com"

        # create a project and upload a real PNG, then a PDF renamed to .png
        page.fill("#newProjectName", "Lekki duplex"); page.click("#newProjectForm button[type=submit]")
        page.wait_for_selector("#projectView:not([hidden])")
        assert page.inner_text("#projectName") == "Lekki duplex"
        page.set_input_files("#fileInput", str(png))
        page.wait_for_selector("#fileRows tr")
        row = page.inner_text("#fileRows tr")
        assert "ground-floor.png" in row and "PNG" in row and "800 × 600 px" in row
        page.set_input_files("#fileInput", str(fake))
        page.wait_for_selector(".upload-row.error .reason")
        assert "contents are a PDF" in page.inner_text(".upload-row.error .reason")
        project_url = page.url
        assert len(stack["storage"].objects) == 1
        page.screenshot(path=str(stack["dir"].parent / "e2e-project.png"), full_page=True)

        # a second customer sees nothing and cannot open the first one's project by its link
        page.click("#signOutBtn"); page.wait_for_selector("#authView:not([hidden])")
        page.click("#tabUp")
        page.fill("#upName", "Bayo"); page.fill("#upEmail", "bayo@example.com"); page.fill("#upPassword", "another-pass-2")
        page.click("#signUpForm button[type=submit]")
        page.wait_for_selector("#projectsView:not([hidden])")
        assert page.is_visible("#projectsEmpty")
        page.goto(project_url)
        page.wait_for_selector("#projectsView:not([hidden])")
        assert "not yours" in page.inner_text("#toast")

        # the owner signs back in and deletes the project with the in-page confirmation
        page.click("#signOutBtn"); page.wait_for_selector("#authView:not([hidden])")
        page.fill("#inEmail", "ada@example.com"); page.fill("#inPassword", "wrong")
        page.click("#signInForm button[type=submit]")
        page.wait_for_selector("#authMsg:not([hidden])")
        assert "do not match" in page.inner_text("#authMsg")
        page.fill("#inPassword", "correct-horse-1"); page.click("#signInForm button[type=submit]")
        page.wait_for_selector(".project")
        page.click(".project"); page.wait_for_selector("#fileRows tr")
        page.click("#deleteBtn"); page.click("text=Yes, delete it")
        page.wait_for_selector("#projectsView:not([hidden])"); page.wait_for_selector("#projectsEmpty:not([hidden])")
        assert stack["storage"].objects == {} and stack["repo"].projects == {}
        assert errors == []
        browser.close()
