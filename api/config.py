"""OpenClaude Web UI — configuration module."""
from __future__ import annotations

import json
import os
from pathlib import Path

# ─── Paths ────────────────────────────────────────────────────────────────

HOME = Path.home()

STATE_DIR = HOME / ".openclaude-webui" / "state"
SESSIONS_DIR = STATE_DIR / "sessions"
PREFERENCES_FILE = STATE_DIR / "preferences.json"
SETTINGS_FILE = STATE_DIR / "settings.json"
MODELS_FILE = STATE_DIR / "models.json"
AUTH_FILE = STATE_DIR / "auth.json"
PROVIDER_KEYS_FILE = STATE_DIR / "provider_keys.json"
ENV_FILE = HOME / ".env"

# Ensure state directories exist
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

# ─── Server config ────────────────────────────────────────────────────────

HOST = os.environ.get("OPENCLAUDE_WEBUI_HOST", "0.0.0.0")
PORT = int(os.environ.get("OPENCLAUDE_WEBUI_PORT", "8788"))

# ─── Provider config ──────────────────────────────────────────────────────

_PROVIDER_MAP: dict[str, dict[str, str]] = {
    "venice": {
        "base_url": "https://api.venice.ai/api/v1",
        "env_key": "VENICE_API_KEY",
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "env_key": "OPENROUTER_API_KEY",
    },
    "xai": {
        "base_url": "https://api.x.ai/v1",
        "env_key": "XAI_API_KEY",
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "env_key": "GROQ_API_KEY",
    },
    "dolphin": {
        "base_url": "https://chat.dolphin.ru/api/v1",
        "env_key": "DOLPHIN_API_KEY",
    },
    "nineteen": {
        "base_url": "https://api.nineteen.ai/v1",
        "env_key": "NINETEEN_API_KEY",
    },
}


# ─── API key storage ──────────────────────────────────────────────────────


def get_provider_api_key(provider: str) -> str | None:
    """Return the stored API key for a provider (from JSON or env fallback)."""
    # 1. Check provider_keys.json
    if PROVIDER_KEYS_FILE.exists():
        with open(PROVIDER_KEYS_FILE, encoding="utf-8") as f:
            keys = json.load(f)
        if key := keys.get(provider):
            return key

    # 2. Check env var
    env_key = _PROVIDER_MAP.get(provider, {}).get("env_key", "")
    val = os.environ.get(env_key, "")
    if val:
        return val

    # 3. Check ~/.env
    env = get_current_env()
    if key := env.get(env_key, ""):
        return key

    return None


def set_provider_api_key(provider: str, api_key: str) -> None:
    """Store an API key for a provider."""
    keys = {}
    if PROVIDER_KEYS_FILE.exists():
        with open(PROVIDER_KEYS_FILE, encoding="utf-8") as f:
            keys = json.load(f)
    keys[provider] = api_key
    with open(PROVIDER_KEYS_FILE, "w", encoding="utf-8") as f:
        json.dump(keys, f, indent=2)


def get_all_provider_keys() -> dict[str, str]:
    """Return all stored provider API keys."""
    keys = {}
    if PROVIDER_KEYS_FILE.exists():
        with open(PROVIDER_KEYS_FILE, encoding="utf-8") as f:
            keys = json.load(f)
    return keys


# ─── Provider helpers ─────────────────────────────────────────────────────


def get_provider_base_url(provider: str) -> str | None:
    """Return the base URL for a provider."""
    return _PROVIDER_MAP.get(provider, {}).get("base_url")


def get_provider_env_key(provider: str) -> str | None:
    """Return the env var name that holds this provider's API key."""
    return _PROVIDER_MAP.get(provider, {}).get("env_key")


def get_all_providers() -> list[dict]:
    """Return all supported providers with metadata."""
    _NAMES = {
        "venice": "Venice.ai",
        "openrouter": "OpenRouter",
        "xai": "xAI",
        "groq": "Groq",
        "dolphin": "Dolphin",
        "nineteen": "Nineteen",
    }
    return [
        {
            "id": pid,
            "name": _NAMES.get(pid, pid.capitalize()),
            "base_url": meta["base_url"],
        }
        for pid, meta in _PROVIDER_MAP.items()
    ]


# ─── Model config (our own file, separate from OpenClaw) ──────────────────


def get_configured_models() -> list[dict]:
    """Return a flat list of all configured models.

    Each entry: { "id": "venice/kimi-k2-5", "alias": "Kimi K2.5", "provider": "venice" }
    """
    data = {}
    if MODELS_FILE.exists():
        with open(MODELS_FILE, encoding="utf-8") as f:
            data = json.load(f)

    result = []
    for model_id, meta in data.items():
        provider = meta.get("provider", model_id.split("/")[0] if "/" in model_id else "unknown")
        result.append(
            {
                "id": model_id,
                "alias": meta.get("alias", model_id.split("/")[-1]),
                "provider": provider,
                "model": meta.get("model", model_id.split("/", 1)[1] if "/" in model_id else model_id),
            }
        )
    return result


def get_models_by_provider(provider: str) -> list[dict]:
    """Return all configured models for a specific provider."""
    return [m for m in get_configured_models() if m["provider"] == provider]


def get_model_entry(model_id: str) -> dict | None:
    """Return the full entry for a model ID."""
    if not MODELS_FILE.exists():
        return None
    with open(MODELS_FILE, encoding="utf-8") as f:
        data = json.load(f)
    return data.get(model_id)


def add_model_entry(model_id: str, provider: str, model: str, alias: str) -> None:
    """Add or update a model entry in models.json."""
    data = {}
    if MODELS_FILE.exists():
        with open(MODELS_FILE, encoding="utf-8") as f:
            data = json.load(f)
    data[model_id] = {
        "provider": provider,
        "model": model,
        "alias": alias,
        "base_url": "",
    }
    with open(MODELS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def remove_model_entry(model_id: str) -> None:
    """Remove a model entry from models.json."""
    if not MODELS_FILE.exists():
        return
    with open(MODELS_FILE, encoding="utf-8") as f:
        data = json.load(f)
    data.pop(model_id, None)
    with open(MODELS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def get_current_primary_model() -> str:
    """Return the current primary model from preferences."""
    prefs = load_preferences()
    return prefs.get("default_model_id", "")


# ─── Auth ─────────────────────────────────────────────────────────────────


def get_auth_token() -> str:
    """Return the Web UI auth token."""
    if not AUTH_FILE.exists():
        return ""
    with open(AUTH_FILE, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("token", "")


# ─── Env file helpers ─────────────────────────────────────────────────────


def _read_env_file(path: Path) -> dict[str, str]:
    """Parse a shell env file (export KEY=VALUE or KEY=VALUE) into a dict."""
    env: dict[str, str] = {}
    if not path.exists():
        return env
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:]
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            env[key] = value
    return env


def get_current_env() -> dict[str, str]:
    """Read current OpenClaude env vars from ~/.env."""
    return _read_env_file(ENV_FILE)


# ─── Preferences ──────────────────────────────────────────────────────────


def load_preferences() -> dict:
    if not PREFERENCES_FILE.exists():
        # Fallback: read from ~/.env so the UI shows the correct selection
        env = _load_env_file()
        model = env.get("OPENAI_MODEL", "")
        base_url = env.get("OPENAI_BASE_URL", "")
        provider = ""
        if "venice" in base_url:
            provider = "venice"
        elif "openrouter" in base_url:
            provider = "openrouter"
        elif "x.ai" in base_url or "grok" in model.lower():
            provider = "xai"
        return {
            "default_provider": provider,
            "default_model": model,
            "default_model_id": f"{provider}/{model}" if provider and model else model,
        }
    with open(PREFERENCES_FILE, encoding="utf-8") as f:
        return json.load(f)


def save_preferences(prefs: dict) -> None:
    PREFERENCES_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(PREFERENCES_FILE, "w", encoding="utf-8") as f:
        json.dump(prefs, f, indent=2)
