"""OpenClaude Web UI — HTTP request handlers."""
from __future__ import annotations

import json
import mimetypes
import os
import queue
import time
import uuid
from datetime import datetime, timezone
from email.parser import Parser
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# ─── Session Token & Cost Tracking ───────────────────────────────────────
_session_token_usage: dict[str, dict] = {}  # session_id -> {input, output, cost, messages}

from . import config as cfg
from .auth import check_token
from .file_ingestion import build_attachment_prompt, extract_text
from .model_switcher import (
    discover_and_save_models,
    get_model_info,
    switch_model,
)
from .pty_session import cancel_session, get_active_runner, run_message
from .sessions import (
    add_message,
    create_session,
    delete_session,
    get_session,
    list_sessions,
    update_session_title,
)

HOME = Path.home()
STATIC_DIR = HOME / "openclaude-webui" / "static"
UPLOADS_DIR = HOME / "openclaude-webui" / "uploads"

# ─── Rate Limiting ───────────────────────────────────────────────────────
_AUTH_WINDOW = 60  # seconds
_AUTH_MAX_ATTEMPTS = 10
_auth_attempts: dict[str, list[float]] = {}


def _check_rate_limit(client_ip: str) -> bool:
    """Return True if the IP is within rate limits."""
    now = time.time()
    attempts = _auth_attempts.get(client_ip, [])
    attempts = [t for t in attempts if now - t < _AUTH_WINDOW]
    _auth_attempts[client_ip] = attempts
    if len(attempts) >= _AUTH_MAX_ATTEMPTS:
        return False
    attempts.append(now)
    return True


# ─── Cost Estimation ─────────────────────────────────────────────────────
def _get_model_cost(model_id: str) -> dict[str, float]:
    """Approximate cost per 1M tokens for common models."""
    cost_map = {
        "kimi-k2-5": (2.0, 8.0),
        "glm-5": (1.5, 7.5),
        "grok-3": (3.0, 15.0),
        "grok-4": (5.0, 20.0),
        "llama-4-maverick": (0.2, 0.8),
        "gemma": (0.4, 1.6),
        "deepseek": (0.5, 2.0),
        "claude": (3.0, 15.0),
    }
    for key, cost in cost_map.items():
        if key in model_id.lower():
            return {"input_per_m": cost[0], "output_per_m": cost[1]}
    return {"input_per_m": 1.0, "output_per_m": 4.0}


def _json_response(handler, data: dict, status: int = 200) -> None:
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.end_headers()
    handler.wfile.write(json.dumps(data).encode("utf-8"))


def _send_file(handler, path: Path, content_type: str | None = None) -> None:
    if not path.exists():
        handler.send_response(404)
        handler.end_headers()
        return
    ct = content_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    handler.send_response(200)
    handler.send_header("Content-Type", ct)
    handler.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
    handler.end_headers()
    with open(path, "rb") as f:
        handler.wfile.write(f.read())


class RequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    # ─── Security helpers ────────────────────────────────────────────────

    def _is_loopback(self) -> bool:
        """Check if request originates from localhost / loopback."""
        return self.client_address[0] in ("127.0.0.1", "::1", "localhost")

    def _auth_ok(self) -> bool:
        if self._is_loopback():
            return True
        auth_header = self.headers.get("Authorization", "")
        token = ""
        if auth_header.lower().startswith("bearer "):
            token = auth_header[7:].strip()
        else:
            cookie = self.headers.get("Cookie", "")
            for part in cookie.split(";"):
                part = part.strip()
                if part.startswith("oc_auth_token="):
                    token = part[14:]
                    break
        return bool(token) and check_token(token)

    def _check_auth(self) -> bool:
        """Verify auth and enforce rate limiting for non-localhost."""
        if self._is_loopback():
            return True
        if not self._auth_ok():
            self._send_error(401, "Unauthorized")
            return False
        return True

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8")
        return json.loads(body) if body else {}

    def _send_error(self, status: int, message: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": message}).encode("utf-8"))

    # ─── CORS ────────────────────────────────────────────────────────────

    def _send_cors_headers(self) -> None:
        """Send CORS headers — localhost only."""
        if self._is_loopback():
            host = self.headers.get("Host", "localhost:8788")
            self.send_header("Access-Control-Allow-Origin", f"http://{host}")
        else:
            self.send_header("Access-Control-Allow-Origin", "null")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    # ─── Routing ─────────────────────────────────────────────────────────

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        # Static files (no auth required)
        if path == "/" or path == "/index.html":
            _send_file(self, STATIC_DIR / "index.html", "text/html")
            return
        if path.startswith("/static/"):
            # SECURITY: prevent path traversal
            relative = path[len("/static/"):]
            if ".." in relative or relative.startswith("/"):
                self._send_error(403, "Forbidden")
                return
            file_path = (STATIC_DIR / relative).resolve()
            if not str(file_path).startswith(str(STATIC_DIR.resolve())):
                self._send_error(403, "Forbidden")
                return
            _send_file(self, file_path)
            return

        if not self._auth_ok():
            self._send_error(401, "Unauthorized")
            return

        # API routes
        if path in ("/api/sessions", "/api/session"):
            self._handle_list_sessions()
        elif path.startswith("/api/sessions/"):
            parts = path.split("/")
            if len(parts) == 4:
                self._handle_get_session(parts[3])
            else:
                self._send_error(404, "Not found")
        elif path == "/api/model" or path == "/api/model/info":
            self._handle_get_model()
        elif path == "/api/providers":
            self._handle_get_providers()
        elif path == "/api/models":
            self._handle_list_models(query)
        elif path == "/api/provider_keys":
            self._handle_get_provider_keys()
        elif path == "/api/status":
            self._handle_status()
        elif path == "/api/restart":
            self._handle_restart_backend()
        elif path == "/api/themes":
            self._handle_themes_list()
        elif path.startswith("/api/sessions/search"):
            self._handle_search_sessions(query)
        else:
            self._send_error(404, "Not found")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/auth":
            self._handle_auth()
            return

        # Rate limit non-localhost
        if not self._is_loopback():
            client_ip = self.client_address[0]
            if not _check_rate_limit(client_ip):
                self._send_error(429, "Too many auth attempts. Try again later.")
                return

        if not self._check_auth():
            return

        # API routes
        if path in ("/api/sessions", "/api/session/new"):
            self._handle_create_session()
        elif path in ("/api/switch-model", "/api/model/switch"):
            self._handle_switch_model()
        elif path == "/api/discover-models":
            self._handle_discover_models()
        elif path == "/api/provider_keys":
            self._handle_set_provider_key()
        elif path == "/api/upload":
            self._handle_upload()
        elif path == "/api/message/regenerate":
            self._handle_regenerate_message()
        elif path.startswith("/api/sessions/"):
            parts = path.split("/")
            if len(parts) >= 5:
                session_id = parts[3]
                remainder = parts[4]
                if remainder == "messages":
                    self._handle_send_message(session_id)
                elif remainder in ("delete", "cancel", "export"):
                    if remainder == "delete":
                        self._handle_delete_session(session_id)
                    elif remainder == "cancel":
                        self._handle_cancel_session(session_id)
                    elif remainder == "export":
                        self._handle_export_session(session_id)
                elif remainder == "delete-message":
                    self._handle_delete_message(session_id)
                elif remainder == "rename":
                    self._handle_rename_session(session_id)
                else:
                    self._send_error(404, "Not found")
            elif len(parts) == 4:
                self._handle_send_message(parts[3])
            else:
                self._send_error(404, "Not found")
        elif path.startswith("/api/session/"):
            parts = path.split("/")
            if len(parts) >= 4:
                session_id = parts[3]
                remainder = "/".join(parts[4:]) if len(parts) > 4 else ""
                if remainder == "send":
                    self._handle_send_message(session_id)
                elif remainder == "delete":
                    self._handle_delete_session(session_id)
                elif remainder == "cancel":
                    self._handle_cancel_session(session_id)
                else:
                    self._send_error(404, "Not found")
            else:
                self._send_error(404, "Not found")
        else:
            self._send_error(404, "Not found")

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if not self._auth_ok():
            self._send_error(401, "Unauthorized")
            return

        if path.startswith("/api/sessions/"):
            parts = path.split("/")
            if len(parts) == 4:
                self._handle_delete_session(parts[3])
            else:
                self._send_error(404, "Not found")
        else:
            self._send_error(404, "Not found")

    # ─── Handler implementations ─────────────────────────────────────────

    def _handle_auth(self):
        client_ip = self.client_address[0]
        if not _check_rate_limit(client_ip):
            self._send_error(429, "Too many auth attempts. Try again later.")
            return
        data = self._read_json()
        token = data.get("token", "")
        if check_token(token):
            _json_response(self, {"ok": True, "token": token})
        else:
            self._send_error(401, "Invalid token")

    def _handle_list_sessions(self):
        sessions = list_sessions()
        _json_response(self, {"sessions": sessions})

    def _handle_get_session(self, session_id: str):
        session = get_session(session_id)
        if session:
            _json_response(self, {
                "session": session,
                "messages": session.get("messages", []),
                "model_id": session.get("model_id", ""),
            })
        else:
            self._send_error(404, "Session not found")

    def _handle_create_session(self):
        data = self._read_json()
        model_id = data.get("model_id", cfg.get_current_primary_model())
        if not model_id:
            self._send_error(400, "No model selected")
            return
        session = create_session(model_id)
        _json_response(self, {"session": session, "id": session["id"]})

    def _handle_delete_session(self, session_id: str):
        delete_session(session_id)
        _json_response(self, {"status": "ok"})

    def _handle_cancel_session(self, session_id: str):
        cancel_session(session_id)
        _json_response(self, {"status": "ok"})

    def _handle_send_message(self, session_id: str):
        data = self._read_json()
        content = data.get("message", data.get("content", "")).strip()
        attachments = data.get("attachments", [])
        if not content and not attachments:
            self._send_error(400, "Empty message")
            return

        session = get_session(session_id)
        if not session:
            self._send_error(404, "Session not found")
            return

        # Build prompt with attachment content
        if attachments:
            for f in attachments:
                f["extracted_text"] = extract_text(Path(f["path"]))

        message_data = {"content": content or ""}
        if attachments:
            message_data["attachments"] = attachments
        add_message(session_id, "user", content or "", extra=message_data if attachments else None)

        runner = get_active_runner(session_id)
        if runner:
            cancel_session(session_id)
            time.sleep(0.1)

        # SSE response
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "http://localhost:8788")
        self.end_headers()

        prompt = content or ""
        if attachments:
            for f in attachments:
                f["extracted_text"] = extract_text(Path(f["path"]))
            attachment_block = build_attachment_prompt(attachments)
            if attachment_block:
                prompt = attachment_block + "\n\n" + prompt if prompt else attachment_block

        run_message(session_id, session.get("model_id", ""), prompt)

        runner = get_active_runner(session_id)
        response_text = ""
        if runner:
            try:
                while True:
                    try:
                        event_type, data = runner.queue.get(timeout=120)
                        if event_type == "chunk":
                            response_text += data
                            self.wfile.write(
                                f"data: {json.dumps({'type': 'chunk', 'content': data})}\n\n".encode()
                            )
                        elif event_type == "error":
                            self.wfile.write(
                                f"data: {json.dumps({'type': 'error', 'content': data})}\n\n".encode()
                            )
                        elif event_type == "usage":
                            # Track token usage for cost estimation
                            usage_data = json.loads(data)
                            _session_token_usage[session_id] = {
                                "input": usage_data.get("input_tokens", 0),
                                "output": usage_data.get("output_tokens", 0),
                            }
                            self.wfile.write(
                                f"data: {json.dumps({'type': 'usage', 'data': usage_data})}\n\n".encode()
                            )
                        elif event_type == "status":
                            status_data = json.loads(data)
                            if status_data.get("type") == "done":
                                self.wfile.write(f"data: {json.dumps({'type': 'done'})}\n\n".encode())
                                break
                        self.wfile.flush()
                    except queue.Empty:
                        self.wfile.write(
                            f"data: {json.dumps({'type': 'error', 'content': 'Timeout waiting for response'})}\n\n".encode()
                        )
                        break
            except Exception as e:
                self.wfile.write(
                    f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n".encode()
                )
            finally:
                if response_text.strip():
                    # Add token usage data to assistant message if available
                    extra = None
                    if session_id in _session_token_usage:
                        usage = _session_token_usage[session_id]
                        costs = _get_model_cost(session.get("model_id", ""))
                        est_cost = (usage["input"] * costs["input_per_m"] / 1_000_000) + (usage["output"] * costs["output_per_m"] / 1_000_000)
                        extra = {
                            "input_tokens": usage["input"],
                            "output_tokens": usage["output"],
                            "estimated_cost": round(est_cost, 6),
                        }
                        del _session_token_usage[session_id]
                    add_message(session_id, "assistant", response_text.strip(), extra=extra)
                cancel_session(session_id)

    def _handle_model_switch_result(self, provider: str, model: str) -> dict:
        """Helper to format model switch results."""
        model_id = f"{provider}/{model}"

        result = switch_model(provider, model)
        if result.get("status") == "error":
            return {"status": "error", "error": result.get("error", "Switch failed")}

        return {
            "status": "ok",
            "provider": provider,
            "model": model,
            "model_id": model_id,
        }

    def _handle_get_model(self):
        info = get_model_info()
        _json_response(self, info)

    def _handle_get_providers(self):
        _json_response(self, {"providers": cfg.get_all_providers()})

    def _handle_list_models(self, query: dict):
        provider = query.get("provider", [None])[0]
        if provider:
            models = cfg.get_models_by_provider(provider)
        else:
            models = cfg.get_configured_models()
        current = cfg.get_current_primary_model()
        parts = current.split("/", 1) if current else ["", ""]
        _json_response(self, {
            "models": models,
            "current": current,
            "current_model": parts[1] if len(parts) > 1 else current,
            "current_provider": parts[0] if len(parts) > 1 else "",
        })

    def _handle_get_provider_keys(self):
        keys = cfg.get_all_provider_keys()
        # SECURTY: never send raw API keys to the client
        masked = {p: {"has_key": bool(k), "last4": k[-4:] if len(k) > 4 else "****"} for p, k in keys.items()}
        _json_response(self, {"keys": masked})

    def _handle_switch_model(self):
        data = self._read_json()
        provider = data.get("provider", "").strip().lower()
        model = data.get("model", "").strip()
        api_key = data.get("api_key", "").strip() or None
        discover = data.get("discover", False)

        if not provider or not model:
            self._send_error(400, "Provider and model are required")
            return

        result = switch_model(provider, model, api_key=api_key, discover=discover)
        if result.get("status") == "error":
            self._send_error(400, result.get("error", "Switch failed"))
            return
        _json_response(self, result)

    def _handle_discover_models(self):
        data = self._read_json()
        provider = data.get("provider", "").strip().lower()
        api_key = data.get("api_key", "").strip() or None

        if not provider:
            self._send_error(400, "Provider is required")
            return

        models = discover_and_save_models(provider, api_key)
        _json_response(self, {
            "status": "ok",
            "provider": provider,
            "count": len(models),
            "models": [{"id": m["id"], "alias": m["alias"], "model": m["model"]} for m in models],
        })

    def _handle_set_provider_key(self):
        data = self._read_json()
        provider = data.get("provider", "").strip().lower()
        api_key = data.get("api_key", "").strip()

        if not provider or not api_key:
            self._send_error(400, "Provider and api_key are required")
            return

        cfg.set_provider_api_key(provider, api_key)
        _json_response(self, {"status": "ok", "provider": provider})

    # ─── Multipart upload (no deprecated cgi module) ─────────────────────

    def _handle_upload(self):
        """Handle multipart/form-data file uploads without the cgi module."""
        UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data"):
            self._send_error(400, "Expected multipart/form-data")
            return

        # Parse boundary from Content-Type header
        boundary = None
        for param in content_type.split(";"):
            param = param.strip()
            if param.startswith("boundary="):
                boundary = param[len("boundary="):].strip('"')
                break

        if not boundary:
            self._send_error(400, "Missing multipart boundary")
            return

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 50 * 1024 * 1024:  # 50MB max
            self._send_error(400, "File too large (max 50MB)")
            return

        raw = self.rfile.read(content_length)
        body = raw.decode("utf-8", errors="replace")

        # Manual multipart parser
        files = []
        boundary_marker = f"--{boundary}"

        # Split by boundary markers
        parts = body.split(boundary_marker)

        for part in parts:
            part = part.strip()
            if not part or part == "--":
                continue

            # Must end with \r\n to have a valid header section
            if "\r\n\r\n" not in part:
                continue

            header_section, file_content = part.split("\r\n\r\n", 1)

            # Parse headers
            filename = None
            field_name = None
            for line in header_section.split("\r\n"):
                if line.lower().startswith("content-disposition:"):
                    for param in line.split(";"):
                        param = param.strip()
                        if param.startswith("filename="):
                            filename = param[len("filename="):].strip('"')
                        elif param.startswith("name="):
                            field_name = param[len("name="):].strip('"')

            if filename and field_name == "files":
                # Sanitize filename
                safe_name = Path(filename).name
                if not safe_name:
                    safe_name = f"upload_{int(time.time())}"

                dest = UPLOADS_DIR / safe_name
                counter = 1
                stem = dest.stem
                suffix = dest.suffix
                while dest.exists():
                    dest = UPLOADS_DIR / f"{stem}_{counter}{suffix}"
                    counter += 1

                # Clean trailing \r\n-- if present
                if file_content.endswith("--"):
                    file_content = file_content[:-2].rstrip("\r\n")
                elif file_content.endswith("\r\n"):
                    file_content = file_content[:-2]

                dest.write_bytes(file_content.encode("utf-8"))
                files.append({
                    "name": safe_name,
                    "path": str(dest),
                    "size": dest.stat().st_size,
                })

        _json_response(self, {"status": "ok", "files": files})

    # ─── New Feature Endpoints ───────────────────────────────────────────

    def _handle_status(self):
        """System status: model, provider, API key health, session count, active runner."""
        current_model = cfg.get_current_primary_model()
        providers = cfg.get_all_providers()
        keys = cfg.get_all_provider_keys()
        sessions = list_sessions()

        # Find active runners
        from .pty_session import _active_runners
        active_runners = {
            sid: runner.is_alive()
            for sid, runner in _active_runners.items()
            if runner.is_alive()
        }

        # Provider key health
        key_health = {}
        for p in providers:
            pid = p["id"]
            has_key = bool(keys.get(pid) or os.environ.get(p.get("env_key", "")))
            key_health[pid] = "green" if has_key else "red"

        # Calculate running totals from all sessions
        total_input = 0
        total_output = 0
        total_cost = 0.0
        for s in sessions:
            sess = get_session(s["id"])
            if sess:
                for msg in sess.get("messages", []):
                    total_input += msg.get("input_tokens", 0)
                    total_output += msg.get("output_tokens", 0)
                    total_cost += msg.get("estimated_cost", 0.0)

        _json_response(self, {
            "model": current_model,
            "providers": [{"id": p["id"], "name": p["name"], "key_status": key_health.get(p["id"], "red")} for p in providers],
            "session_count": len(sessions),
            "active_runners": active_runners,
            "total_input_tokens": total_input,
            "total_output_tokens": total_output,
            "total_cost": round(total_cost, 4),
        })

    def _handle_restart_backend(self):
        """Signal the backend to restart — parent will handle shutdown."""
        import signal, os, sys
        # Write a restart marker the parent process can pick up
        marker = Path.home() / ".openclaude-webui" / "restart_marker"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(str(os.getpid()))
        # SIGUSR1 to current process (daemon handler) or just exit to let supervisor/start.sh restart
        _json_response(self, {"status": "ok", "message": "Restart signal sent. Server will restart shortly."})

    def _handle_themes_list(self):
        """List available themes."""
        _json_response(self, {
            "themes": [
                {"id": "dark", "name": "Dark (Default)"},
                {"id": "dark-amoled", "name": "AMOLED Pure Black"},
                {"id": "gruvbox", "name": "Gruvbox"},
                {"id": "nord", "name": "Nord"},
                {"id": "solarized", "name": "Solarized"},
            ]
        })

    def _handle_search_sessions(self, query: dict):
        """Search sessions by query string"""
        q = query.get("q", [""])[0].lower()
        if not q:
            self._handle_list_sessions()
            return

        sessions = list_sessions()
        results = []
        for s in sessions:
            # Search title
            if q in s.get("title", "").lower():
                results.append(s)
                continue
            # Search message content
            session = get_session(s["id"])
            if session:
                for msg in session.get("messages", []):
                    if q in msg.get("content", "").lower():
                        results.append(s)
                        break

        _json_response(self, {"sessions": results, "query": q})

    def _handle_export_session(self, session_id: str):
        """Export a session as markdown or JSON."""
        query = parse_qs(urlparse(self.path).query)
        fmt = query.get("format", ["markdown"])[0]

        session = get_session(session_id)
        if not session:
            self._send_error(404, "Session not found")
            return

        if fmt == "json":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Disposition", f'attachment; filename="{session_id[:8]}.json"')
            self.end_headers()
            self.wfile.write(json.dumps(session, indent=2).encode())
        else:
            # Markdown export
            lines = [
                f"# {session.get('title', 'Untitled Chat')}",
                f"Exported: {datetime.now(timezone.utc).isoformat()}",
                f"Model: {session.get('model_id', 'Unknown')}",
                "",
                "---",
                "",
            ]
            for msg in session.get("messages", []):
                role = msg["role"].capitalize()
                timestamp = msg.get("timestamp", "")[:19]
                lines.append(f"### {role} ({timestamp})")
                lines.append("")
                lines.append(msg.get("content", ""))
                lines.append("")
                lines.append("---")
                lines.append("")

            md = "\n".join(lines)
            self.send_response(200)
            self.send_header("Content-Type", "text/markdown")
            self.send_header("Content-Disposition", f'attachment; filename="{session_id[:8]}.md"')
            self.end_headers()
            self.wfile.write(md.encode())

    def _handle_rename_session(self, session_id: str):
        """Rename a session."""
        data = self._read_json()
        title = data.get("title", "")
        if not title:
            self._send_error(400, "Title is required")
            return
        update_session_title(session_id, title)
        _json_response(self, {"status": "ok", "title": title})

    def _handle_delete_message(self, session_id: str):
        """Delete a specific message from a session."""
        data = self._read_json()
        index = data.get("index")
        if index is None:
            self._send_error(400, "Message index is required")
            return

        session = get_session(session_id)
        if not session:
            self._send_error(404, "Session not found")
            return

        messages = session.get("messages", [])
        if index < 0 or index >= len(messages):
            self._send_error(400, f"Message index {index} out of range")
            return

        messages.pop(index)
        session["messages"] = messages
        session["updated_at"] = datetime.now(timezone.utc).isoformat()

        from .sessions import _save_session
        _save_session(session)
        _json_response(self, {"status": "ok"})

    def _handle_regenerate_message(self):
        """Regenerate the last assistant response."""
        data = self._read_json()
        session_id = data.get("session_id", "").strip()
        if not session_id:
            self._send_error(400, "Session ID is required")
            return

        session = get_session(session_id)
        if not session:
            self._send_error(404, "Session not found")

        messages = session.get("messages", [])

        # Find the last assistant message
        last_ai_idx = None
        for i in range(len(messages) - 1, -1, -1):
            if messages[i]["role"] == "assistant":
                last_ai_idx = i
                break

        if last_ai_idx is None:
            self._send_error(400, "No assistant message to regenerate")
            return

        # Delete the last assistant message
        messages.pop(last_ai_idx)
        session["messages"] = messages
        session["updated_at"] = datetime.now(timezone.utc).isoformat()

        from .sessions import _save_session
        _save_session(session)

        # Find the last user message before the deleted one
        last_user_idx = None
        for i in range(last_ai_idx - 1, -1, -1):
            if messages[i]["role"] == "user":
                last_user_idx = i
                break

        if last_user_idx is None:
            self._send_error(400, "No user message to regenerate from")
            return

        # Re-send the message
        user_content = messages[last_user_idx]["content"]

        # Cancel any existing runner
        runner = get_active_runner(session_id)
        if runner:
            cancel_session(session_id)
            time.sleep(0.1)

        # SSE response
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "http://localhost:8788")
        self.end_headers()

        run_message(session_id, session.get("model_id", ""), user_content)

        runner = get_active_runner(session_id)
        response_text = ""
        if runner:
            try:
                while True:
                    try:
                        event_type, data = runner.queue.get(timeout=120)
                        if event_type == "chunk":
                            response_text += data
                            self.wfile.write(
                                f"data: {json.dumps({'type': 'chunk', 'content': data})}\n\n".encode()
                            )
                        elif event_type == "error":
                            self.wfile.write(
                                f"data: {json.dumps({'type': 'error', 'content': data})}\n\n".encode()
                            )
                        elif event_type == "usage":
                            # Track token usage for cost estimation
                            usage_data = json.loads(data)
                            _session_token_usage[session_id] = {
                                "input": usage_data.get("input_tokens", 0),
                                "output": usage_data.get("output_tokens", 0),
                            }
                            self.wfile.write(
                                f"data: {json.dumps({'type': 'usage', 'data': usage_data})}\n\n".encode()
                            )
                        elif event_type == "status":
                            status_data = json.loads(data)
                            if status_data.get("type") == "done":
                                self.wfile.write(f"data: {json.dumps({'type': 'done'})}\n\n".encode())
                                break
                        self.wfile.flush()
                    except queue.Empty:
                        self.wfile.write(
                            f"data: {json.dumps({'type': 'error', 'content': 'Timeout waiting for response'})}\n\n".encode()
                        )
                        break
            except Exception as e:
                self.wfile.write(
                    f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n".encode()
                )
            finally:
                if response_text.strip():
                    add_message(session_id, "assistant", response_text.strip())
                cancel_session(session_id)
