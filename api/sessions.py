"""OpenClaude Web UI — session persistence.

Sessions are stored as JSON files in ~/.openclaude-webui/state/sessions/.
Each session has:
  - id (UUID)
  - title (auto-generated from first message)
  - model_id (e.g. "venice/kimi-k2-5")
  - created_at, updated_at (ISO timestamps)
  - messages (list of {role, content, timestamp})
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .config import SESSIONS_DIR


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _session_path(session_id: str) -> Path:
    return SESSIONS_DIR / f"{session_id}.json"


def create_session(model_id: str, title: str = "New Chat", workspace: str = "") -> dict:
    """Create a new session file and return its metadata."""
    sid = str(uuid.uuid4())
    session = {
        "id": sid,
        "title": title,
        "model_id": model_id,
        "workspace": workspace,
        "created_at": _now(),
        "updated_at": _now(),
        "messages": [],
    }
    _save_session(session)
    return session


def _save_session(session: dict) -> None:
    path = _session_path(session["id"])
    with open(path, "w", encoding="utf-8") as f:
        json.dump(session, f, indent=2)


def get_session(session_id: str) -> dict | None:
    path = _session_path(session_id)
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        session = json.load(f)
    if "workspace" not in session:
        session["workspace"] = ""
    return session


def list_sessions() -> list[dict]:
    """Return metadata for all sessions, sorted by updated_at desc."""
    sessions = []
    for path in SESSIONS_DIR.glob("*.json"):
        try:
            with open(path, encoding="utf-8") as f:
                s = json.load(f)
            sessions.append(
                {
                    "id": s["id"],
                    "title": s["title"],
                    "model_id": s.get("model_id", ""),
                    "created_at": s.get("created_at", ""),
                    "updated_at": s.get("updated_at", ""),
                    "message_count": len(s.get("messages", [])),
                }
            )
        except Exception:
            continue
    sessions.sort(key=lambda x: x["updated_at"], reverse=True)
    return sessions


def add_message(session_id: str, role: str, content: str, extra: dict | None = None) -> dict | None:
    """Append a message to a session and update its title if needed."""
    session = get_session(session_id)
    if not session:
        return None
    msg = {
        "role": role,
        "content": content,
        "timestamp": _now(),
    }
    if extra:
        msg.update(extra)
    session["messages"].append(msg)
    # Auto-title from first user message
    if session["title"] == "New Chat" and role == "user":
        session["title"] = content[:50] + "..." if len(content) > 50 else content
    session["updated_at"] = _now()
    _save_session(session)
    return session


def update_session_title(session_id: str, title: str) -> dict | None:
    session = get_session(session_id)
    if not session:
        return None
    session["title"] = title
    session["updated_at"] = _now()
    _save_session(session)
    return session


def delete_session(session_id: str) -> bool:
    path = _session_path(session_id)
    if path.exists():
        path.unlink()
        return True
    return False
