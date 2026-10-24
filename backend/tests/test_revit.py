"""Revit files: recognised on upload, converted to IFC through Autodesk (a stand-in transport that
follows the documented requests), and saved as an IFC in the same project."""

from __future__ import annotations

import base64
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.aps import AutodeskModels, ModelServiceError, urn_of
from app.auth import TokenVerifier
from app.filetypes import OLE, REVIT_STREAM, inspect_upload
from app.jobs import InlineRunner
from app.main import create_app

from .conftest import FakeImages
from .fixtures.builder import build_ifc
from .fixtures.layout import sample_house
from .test_studio import new_project, upload

RVT = OLE + b"\x00" * 504 + REVIT_STREAM + b"\x00" * 8000
IFC = build_ifc(sample_house(), seed="rvt")


def test_revit_files_are_recognised_by_their_contents():
    assert inspect_upload(RVT, "Villa.rvt").kind == "rvt"
    with pytest.raises(Exception) as e:
        inspect_upload(OLE + b"\x00" * 9000, "Villa.rvt")          # an Office file renamed .rvt
    assert "not a Revit model" in e.value.reason
    with pytest.raises(Exception) as e:
        inspect_upload(RVT, "Villa.ifc")
    assert e.value.code == "renamed"


class APS:
    """Answers the documented APS requests; records what was sent."""

    def __init__(self, manifest_after=1, fail=None):
        self.seen, self.polls, self.manifest_after, self.fail = [], 0, manifest_after, fail

    def handle(self, req: httpx.Request) -> httpx.Response:
        self.seen.append(req)
        p = req.url.path
        if p == "/authentication/v2/token":
            if self.fail == "auth":
                return httpx.Response(401, json={"developerMessage": "bad client"})
            return httpx.Response(200, json={"access_token": "tok", "token_type": "Bearer", "expires_in": 3599})
        if req.url.host in ("s3.test", "cdn.test"):
            assert "Authorization" not in req.headers          # signed links: the token never leaves Autodesk
            if req.url.host == "s3.test":
                return httpx.Response(200)
            assert "CloudFront-Signature=sig" in req.headers.get("Cookie", "")
            return httpx.Response(200, content=IFC)
        assert req.headers["Authorization"] == "Bearer tok"
        if p == "/oss/v2/buckets":
            return httpx.Response(409, json={"reason": "Bucket already exists"})
        if p.endswith("/signeds3upload") and req.method == "GET":
            return httpx.Response(200, json={"uploadKey": "up-1", "urls": ["https://s3.test/put-here"]})
        if p.endswith("/signeds3upload") and req.method == "POST":
            assert json.loads(req.content) == {"uploadKey": "up-1"}
            key = p.split("/objects/")[1].split("/")[0]
            return httpx.Response(200, json={"objectId": f"urn:adsk.objects:os.object:ollic-abc/{key}", "size": 1})
        if p == "/s3.test/put-here" or req.url.host == "s3.test":
            return httpx.Response(200)
        if p == "/modelderivative/v2/designdata/job":
            return httpx.Response(200, json={"result": "created"})
        if p.endswith("/manifest"):
            self.polls += 1
            if self.fail == "translate":
                return httpx.Response(200, json={"status": "failed", "derivatives": []})
            if self.polls <= self.manifest_after:
                return httpx.Response(200, json={"status": "inprogress", "progress": "40% complete"})
            urn = p.split("/designdata/")[1].split("/")[0]
            return httpx.Response(200, json={"status": "success", "progress": "complete", "derivatives": [
                {"outputType": "svf2", "children": [{"urn": "urn:x/out.svf"}]},
                {"outputType": "ifc", "status": "success", "children": [{"role": "ifc", "urn": f"urn:adsk.viewing:fs.file:{urn}/output/Villa.ifc", "mime": "application/octet-stream"}]}]})
        if p.endswith("/signedcookies"):
            return httpx.Response(200, json={"url": "https://cdn.test/Villa.ifc", "size": len(IFC)},
                                  headers=[("Set-Cookie", "CloudFront-Policy=pol; Path=/; Domain=cdn.test"), ("Set-Cookie", "CloudFront-Key-Pair-Id=kp; Path=/"),
                                           ("Set-Cookie", "CloudFront-Signature=sig; Path=/")])
        if req.url.host == "cdn.test":
            assert "CloudFront-Signature=sig" in req.headers.get("Cookie", "")
            return httpx.Response(200, content=IFC)
        return httpx.Response(404)


def client_for(fake: APS) -> AutodeskModels:
    t = httpx.MockTransport(fake.handle)
    return AutodeskModels("ClientID-123", "secret", client=httpx.Client(base_url="https://developer.api.autodesk.com", transport=t), outside=httpx.Client(transport=t))


def test_the_conversion_follows_the_documented_steps():
    fake = APS()
    stages = []
    out = client_for(fake).to_ifc("Villa A.rvt", RVT, progress=stages.append, poll=0)
    assert out == IFC
    tok = fake.seen[0]
    assert tok.headers["Authorization"] == "Basic " + base64.b64encode(b"ClientID-123:secret").decode() and b"grant_type=client_credentials" in tok.content
    put = next(r for r in fake.seen if r.url.host == "s3.test")
    assert put.method == "PUT" and put.content == RVT
    job = next(r for r in fake.seen if r.url.path.endswith("/designdata/job"))
    body = json.loads(job.content)
    assert body["output"]["formats"] == [{"type": "ifc"}] and job.headers["x-ads-force"] == "true"
    key = next(r for r in fake.seen if r.url.path.endswith("/signeds3upload")).url.path.split("/objects/")[1].split("/")[0]
    assert body["input"]["urn"] == urn_of(f"urn:adsk.objects:os.object:ollic-abc/{key}") and key.endswith("Villa_A.rvt")
    assert "=" not in body["input"]["urn"] and base64.urlsafe_b64decode(body["input"]["urn"] + "==").startswith(b"urn:adsk.objects:os.object:")
    assert any("40% complete" in s for s in stages) and stages[-1] == "Downloading the IFC"
    assert sum(1 for r in fake.seen if r.url.path == "/authentication/v2/token") == 1     # the token is reused


@pytest.mark.parametrize("fail,words", [("auth", "not set up"), ("translate", "could not be converted")])
def test_failures_are_neutral(fail, words):
    with pytest.raises(ModelServiceError) as e:
        client_for(APS(fail=fail)).to_ifc("Villa.rvt", RVT, poll=0)
    assert words in e.value.message and "Autodesk" not in e.value.message


@pytest.fixture
def rvt_app(render_settings, repo, storage):
    def make(aps="fake"):
        app = create_app(render_settings, repo=repo, storage=storage, verifier=TokenVerifier(render_settings), image_client=FakeImages(), runner=InlineRunner(),
                         aps=client_for(APS()) if aps == "fake" else aps, kling=None, gemini=None, fal={}, runway=None)
        app.state.aps_poll_seconds = 0
        return TestClient(app)
    return make


def test_a_revit_upload_becomes_an_ifc_in_the_project(rvt_app, alice, bob, repo):
    c = rvt_app()
    pid = new_project(c, alice)
    f = upload(c, alice, pid, "Villa A.rvt", RVT)
    assert f["detected_type"] == "rvt"
    assert c.post(f"/api/projects/{pid}/revit-to-ifc", json={"source_file_id": f["id"]}, headers=alice["headers"]).json()["detail"]["code"] == "premium_only"
    repo.roles[alice["id"]] = "admin"
    r = c.post(f"/api/projects/{pid}/revit-to-ifc", json={"source_file_id": f["id"]}, headers=alice["headers"])
    assert r.status_code == 202, r.text
    job = repo.jobs[r.json()["id"]]
    assert job["status"] == "succeeded", job["error"]
    ifc = repo.files[job["result"]["ifc_file_id"]]
    assert ifc["original_name"] == "Villa A.ifc" and ifc["detected_type"] == "ifc" and ifc["validation"]["details"]["from_revit"] == f["id"]
    assert any(e["provider"] == "autodesk" and e["operation"] == "model_translate" for e in repo.usage)
    # someone else's file, and a file that is not Revit
    assert c.post(f"/api/projects/{pid}/revit-to-ifc", json={"source_file_id": ifc["id"]}, headers=alice["headers"]).json()["detail"]["code"] == "not_revit"
    assert c.post(f"/api/projects/{pid}/revit-to-ifc", json={"source_file_id": f["id"]}, headers=bob["headers"]).status_code == 404


def test_without_autodesk_keys_the_customer_is_told_to_export_ifc(rvt_app, alice, repo):
    c = rvt_app(aps=None)
    repo.roles[alice["id"]] = "admin"
    pid = new_project(c, alice)
    f = upload(c, alice, pid, "Villa.rvt", RVT)
    r = c.post(f"/api/projects/{pid}/revit-to-ifc", json={"source_file_id": f["id"]}, headers=alice["headers"])
    assert r.status_code == 503 and "Export > IFC" in r.json()["detail"]["reason"]
