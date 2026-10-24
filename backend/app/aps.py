"""Revit (.rvt) to IFC through Autodesk Platform Services (APS).

The steps follow Autodesk's documentation:
  * a two-legged token: POST /authentication/v2/token (client credentials, Basic auth);
  * a transient bucket (POST /oss/v2/buckets, 409 when it already exists);
  * direct-to-S3 upload: GET .../signeds3upload for a signed URL, PUT the bytes there, then
    POST .../signeds3upload with the uploadKey; the answer carries the objectId;
  * the translation: POST /modelderivative/v2/designdata/job with output.formats [{"type": "ifc"}],
    then GET .../{urn}/manifest until it says success or failed;
  * the download: GET .../{urn}/manifest/{derivativeUrn}/signedcookies gives the file URL and
    CloudFront cookies, which are sent with the download.
Customers never see the provider's name; errors are neutral.
"""

from __future__ import annotations

import base64
import logging
import re
import time
from decimal import Decimal
from urllib.parse import quote

import httpx

log = logging.getLogger("ollic.aps")
BASE = "https://developer.api.autodesk.com"
SCOPES = "data:read data:write data:create bucket:create bucket:read"
# Model Derivative is charged in Flex tokens (about 0.1 to 0.5 a translation); Flex list price $3 a token.
TRANSLATE_COST = Decimal("1.50")
PRICE_SOURCE = "aps.autodesk.com Flex rate table (Model Derivative, complex job, upper estimate) at $3 a token"


class ModelServiceError(Exception):
    def __init__(self, message: str, retry: bool = False):
        super().__init__(message)
        self.message, self.retry = message, retry


def urn_of(object_id: str) -> str:
    return base64.urlsafe_b64encode(object_id.encode()).decode().rstrip("=")


def bucket_for(client_id: str) -> str:
    """Bucket keys are unique across all of APS, so this one is tied to the app's own client id."""
    return ("ollic-" + re.sub(r"[^a-z0-9]", "", client_id.lower())[:40]) or "ollic-models"


class AutodeskModels:
    provider = "autodesk"

    def __init__(self, client_id: str, client_secret: str, bucket: str | None = None, client: httpx.Client | None = None,
                 outside: httpx.Client | None = None):
        self.client_id, self.client_secret = client_id, client_secret
        self.bucket = bucket or bucket_for(client_id)
        self.http = client or httpx.Client(base_url=BASE, timeout=httpx.Timeout(60, connect=15))
        self.outside = outside or httpx.Client(timeout=httpx.Timeout(600, connect=15))   # S3 and the download CDN
        self._token, self._expires = None, 0.0

    # ------------------------------------------------------------ plumbing
    def token(self) -> str:
        if self._token and time.time() < self._expires - 60:
            return self._token
        r = self.http.post("/authentication/v2/token", auth=(self.client_id, self.client_secret),
                           data={"grant_type": "client_credentials", "scope": SCOPES}, headers={"Accept": "application/json"})
        self._raise(r, "sign in")
        body = r.json()
        self._token, self._expires = body["access_token"], time.time() + int(body.get("expires_in") or 3599)
        return self._token

    def _h(self, **extra) -> dict:
        return {"Authorization": f"Bearer {self.token()}", **extra}

    @staticmethod
    def _raise(r: httpx.Response, what: str) -> None:
        if r.status_code < 400:
            return
        log.warning("OWNER: APS %s failed with %s: %s", what, r.status_code, r.text[:500])
        if r.status_code in (401, 403):
            raise ModelServiceError("Revit files are not set up on Ollic yet. Export IFC from Revit for now.")
        if r.status_code == 429 or r.status_code >= 500:
            raise ModelServiceError("The Revit reader is busy. Try again in a few minutes.", retry=True)
        raise ModelServiceError("This Revit file could not be read. Export IFC from Revit instead.")

    # ------------------------------------------------------------ steps
    def ensure_bucket(self) -> None:
        r = self.http.post("/oss/v2/buckets", headers=self._h(), json={"bucketKey": self.bucket, "policyKey": "transient"})
        if r.status_code != 409:
            self._raise(r, "bucket")

    def upload(self, object_key: str, data: bytes) -> str:
        """Uploads the file; returns its URN for Model Derivative."""
        self.ensure_bucket()
        path = f"/oss/v2/buckets/{self.bucket}/objects/{quote(object_key, safe='')}/signeds3upload"
        r = self.http.get(path, headers=self._h(), params={"minutesExpiration": 30})
        self._raise(r, "upload link")
        signed = r.json()
        put = self.outside.put(signed["urls"][0], content=data)
        if put.status_code >= 400:
            log.warning("OWNER: S3 upload failed %s: %s", put.status_code, put.text[:300])
            raise ModelServiceError("The Revit file could not be sent for reading. Try again.", retry=True)
        r = self.http.post(path, headers=self._h(), json={"uploadKey": signed["uploadKey"]})
        self._raise(r, "upload complete")
        return urn_of(r.json()["objectId"])

    def start(self, urn: str) -> None:
        # the default IFC export (IFC2x3), which the viewer and the IFC reader both handle
        body = {"input": {"urn": urn}, "output": {"formats": [{"type": "ifc"}]}}
        r = self.http.post("/modelderivative/v2/designdata/job", headers=self._h(**{"x-ads-force": "true"}), json=body)
        self._raise(r, "translate")

    def manifest(self, urn: str) -> dict:
        r = self.http.get(f"/modelderivative/v2/designdata/{urn}/manifest", headers=self._h())
        self._raise(r, "manifest")
        return r.json()

    @staticmethod
    def ifc_urn(manifest: dict) -> str | None:
        def walk(nodes):
            for n in nodes or []:
                u = n.get("urn") or ""
                if u.lower().endswith(".ifc") or (n.get("role") == "ifc" and u):
                    return u
                found = walk(n.get("children"))
                if found:
                    return found
            return None
        return walk([d for d in manifest.get("derivatives", []) if (d.get("outputType") or "").lower() == "ifc"])

    def download(self, urn: str, derivative_urn: str) -> bytes:
        r = self.http.get(f"/modelderivative/v2/designdata/{urn}/manifest/{quote(derivative_urn, safe='')}/signedcookies",
                          headers=self._h(), params={"minutesExpiration": 60})
        self._raise(r, "download link")
        cookies = "; ".join(f"{k}={v}" for k, v in r.cookies.items() if k.startswith("CloudFront-"))
        if not cookies:   # read the raw headers when the cookie jar refused a cross-domain cookie
            cookies = "; ".join(m.group(1) for h in r.headers.get_list("set-cookie") if (m := re.match(r"(CloudFront-[^=]+=[^;]+)", h)))
        f = self.outside.get(r.json()["url"], headers={"Cookie": cookies})
        if f.status_code >= 400:
            log.warning("OWNER: derivative download failed %s", f.status_code)
            raise ModelServiceError("The IFC from your Revit file could not be downloaded. Try again.", retry=True)
        return f.content

    def to_ifc(self, name: str, data: bytes, progress=lambda stage: None, poll: float = 8.0, max_wait: float = 1800) -> bytes:
        progress("Sending your Revit file")
        urn = self.upload(f"{int(time.time())}-{re.sub(r'[^A-Za-z0-9._-]', '_', name)[:80]}", data)
        progress("Converting Revit to IFC")
        self.start(urn)
        started = time.monotonic()
        while True:
            m = self.manifest(urn)
            state = (m.get("status") or "").lower()
            if state == "success":
                break
            if state in ("failed", "timeout"):
                log.warning("OWNER: APS translation failed: %s", str(m)[:800])
                raise ModelServiceError("This Revit file could not be converted. Open it in Revit, save it, and try again, or export IFC.")
            if time.monotonic() - started > max_wait:
                raise ModelServiceError("Converting the Revit file took too long. Try again later or export IFC.", retry=True)
            progress(f"Converting Revit to IFC ({m.get('progress') or 'working'})")
            time.sleep(poll)
        d = self.ifc_urn(m)
        if not d:
            log.warning("OWNER: APS manifest had no IFC: %s", str(m)[:800])
            raise ModelServiceError("This Revit file has no 3D view to convert. Add a 3D view in Revit and try again.")
        progress("Downloading the IFC")
        return self.download(urn, d)
