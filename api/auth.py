"""OpenClaude Web UI — token authentication.

Mirrors the Hermes auth pattern: a single shared token stored in
~/.openclaw/openclaw.json (gateway.auth.token).
"""
from __future__ import annotations

import hashlib
import secrets

from .config import get_auth_token


def check_token(token: str) -> bool:
    """Verify the provided token against the stored gateway token.

    Uses constant-time comparison to prevent timing attacks.
    """
    expected = get_auth_token()
    if not expected:
        return False
    return secrets.compare_digest(token.strip(), expected.strip())


def require_auth(handler):
    """Decorator for route handlers that require a valid auth token.

    Expects the token in the Authorization header as 'Bearer <token>'
    or in a cookie named 'oc_auth_token'.
    """
    def wrapper(self, *args, **kwargs):
        # Try Authorization header
        auth_header = self.headers.get("Authorization", "")
        token = ""
        if auth_header.lower().startswith("bearer "):
            token = auth_header[7:].strip()
        else:
            # Try cookie
            cookie = self.headers.get("Cookie", "")
            for part in cookie.split(";"):
                part = part.strip()
                if part.startswith("oc_auth_token="):
                    token = part[14:]
                    break

        if not token or not check_token(token):
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":"Unauthorized"}')
            return

        return handler(self, *args, **kwargs)
    return wrapper
