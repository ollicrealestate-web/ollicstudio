import time
import uuid

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from app.auth import AuthError, TokenVerifier
from app.config import Settings

from .conftest import make_token


def test_health_needs_no_sign_in(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_missing_token_is_rejected(client):
    res = client.get("/api/projects")
    assert res.status_code == 401 and res.headers["www-authenticate"] == "Bearer"


@pytest.mark.parametrize("token", ["not-a-jwt", "a.b.c"])
def test_malformed_token_is_rejected(client, token):
    assert client.get("/api/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_wrong_signature_is_rejected(client):
    token = make_token(str(uuid.uuid4()), secret="someone-elses-secret-0123456789abcdef")
    assert client.get("/api/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_expired_token_is_rejected(client):
    token = make_token(str(uuid.uuid4()), exp_in=-120)
    res = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 401 and "expired" in res.json()["detail"]


def test_wrong_audience_and_anon_role_are_rejected(client):
    for token in (make_token(str(uuid.uuid4()), aud="something-else"), make_token(str(uuid.uuid4()), role="anon")):
        assert client.get("/api/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_valid_token_identifies_the_user(client, alice):
    res = client.get("/api/me", headers=alice["headers"])
    assert res.status_code == 200 and res.json()["id"] == alice["id"]


class StaticJWKS:
    """Stands in for the project's JWKS endpoint (asymmetric signing keys)."""

    def __init__(self, public_key, kid):
        self.public_key, self.kid = public_key, kid

    def get_signing_key_from_jwt(self, token):
        if jwt.get_unverified_header(token).get("kid") != self.kid:
            raise jwt.PyJWKClientError("unknown kid")
        return type("K", (), {"key": self.public_key})()


def _es256(sub, private, kid):
    now = int(time.time())
    return jwt.encode({"sub": sub, "aud": "authenticated", "role": "authenticated", "exp": now + 600, "iat": now}, private, algorithm="ES256", headers={"kid": kid})


def test_asymmetric_es256_tokens_are_checked_against_the_projects_keys():
    private = ec.generate_private_key(ec.SECP256R1())
    settings = Settings(supabase_url="https://x.supabase.co", supabase_anon_key="anon")
    verifier = TokenVerifier(settings, jwks=StaticJWKS(private.public_key(), "key-1"))
    sub = str(uuid.uuid4())
    assert verifier.verify(_es256(sub, private, "key-1")).id == sub
    with pytest.raises(AuthError):
        verifier.verify(_es256(sub, private, "key-2"))
    other = ec.generate_private_key(ec.SECP256R1())
    with pytest.raises(AuthError):
        verifier.verify(_es256(sub, other, "key-1"))


def test_hs256_is_refused_when_no_secret_is_configured():
    settings = Settings(supabase_url="https://x.supabase.co", supabase_anon_key="anon")
    with pytest.raises(AuthError):
        TokenVerifier(settings).verify(make_token(str(uuid.uuid4())))
