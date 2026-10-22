"""Verifies the Supabase access token on every request.

Request handlers act as the signed-in user: they forward the user's own token to
Supabase, so row-level security applies as a second layer behind the ownership
checks in code. The privileged admin key is never used here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import jwt
from fastapi import Header, HTTPException, Request, status

from .config import Settings

ASYMMETRIC_ALGORITHMS = ("RS256", "ES256")


@dataclass(frozen=True)
class CurrentUser:
    id: str
    email: str | None
    token: str


class AuthError(Exception):
    pass


class SigningKeySource(Protocol):
    def get_signing_key_from_jwt(self, token: str): ...


class TokenVerifier:
    def __init__(self, settings: Settings, jwks: SigningKeySource | None = None):
        self._settings = settings
        self._jwks = jwks

    def _jwks_client(self) -> SigningKeySource:
        if self._jwks is None:
            self._jwks = jwt.PyJWKClient(self._settings.jwks_url, cache_keys=True, lifespan=600, timeout=10)
        return self._jwks

    def verify(self, token: str) -> CurrentUser:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise AuthError("The sign-in token is malformed.") from exc
        alg = header.get("alg")
        if alg == "HS256":
            if not self._settings.supabase_jwt_secret:
                raise AuthError("This server does not accept HS256 tokens.")
            key = self._settings.supabase_jwt_secret
        elif alg in ASYMMETRIC_ALGORITHMS:
            try:
                key = self._jwks_client().get_signing_key_from_jwt(token).key
            except jwt.PyJWTError as exc:
                raise AuthError("The token's signing key is not one of this project's keys.") from exc
        else:
            raise AuthError("Unsupported token algorithm.")
        try:
            claims = jwt.decode(
                token,
                key,
                algorithms=[alg],
                audience=self._settings.jwt_audience,
                options={"require": ["exp", "sub", "aud"]},
                leeway=10,
            )
        except jwt.ExpiredSignatureError as exc:
            raise AuthError("Your session has expired. Sign in again.") from exc
        except jwt.PyJWTError as exc:
            raise AuthError("The sign-in token is not valid.") from exc
        if claims.get("role") != "authenticated":
            raise AuthError("This token is not a signed-in user's token.")
        return CurrentUser(id=str(claims["sub"]), email=claims.get("email"), token=token)


def get_current_user(request: Request, authorization: str | None = Header(default=None)) -> CurrentUser:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sign in to continue.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization.split(" ", 1)[1].strip()
    try:
        return request.app.state.verifier.verify(token)
    except AuthError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc), headers={"WWW-Authenticate": "Bearer"}
        ) from exc
