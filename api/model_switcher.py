"""OpenClaude Web UI — model switcher.

Updates ~/.env and local preferences.json when the user switches models
via the Web UI. OpenClaw's config (~/.openclaw/openclaw.json) is kept
completely separate and untouched.
"""
from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

from .config import (
    get_current_primary_model,
    ENV_FILE,
    MODELS_FILE,
    PREFERENCES_FILE,
    get_all_providers,
    get_configured_models,
    get_current_env,
    get_model_entry,
    get_provider_api_key,
    get_provider_base_url,
    load_preferences,
    save_preferences,
    set_provider_api_key,
)


# ─── Model discovery via provider APIs ────────────────────────────────────


def _fetch_venice_models(api_key: str) -> list[dict]:
    """Fetch available models from Venice.ai API."""
    try:
        req = urllib.request.Request(
            "https://api.venice.ai/api/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        models = []
        for m in data.get("data", []):
            mid = m.get("id", "")
            if not mid:
                continue
            models.append({
                "id": f"venice/{mid}",
                "provider": "venice",
                "model": mid,
                "alias": m.get("name", mid),
            })
        return models
    except Exception:
        return []


def _fetch_openrouter_models(api_key: str) -> list[dict]:
    """Fetch available models from OpenRouter API."""
    try:
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        models = []
        for m in data.get("data", []):
            mid = m.get("id", "")
            if not mid:
                continue
            models.append({
                "id": f"openrouter/{mid}",
                "provider": "openrouter",
                "model": mid,
                "alias": m.get("name", mid),
            })
        return models
    except Exception:
        return []


def _fetch_xai_models(api_key: str) -> list[dict]:
    """Fetch available models from xAI API."""
    try:
        req = urllib.request.Request(
            "https://api.x.ai/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        models = []
        for m in data.get("data", []):
            mid = m.get("id", "")
            if not mid:
                continue
            models.append({
                "id": f"xai/{mid}",
                "provider": "xai",
                "model": mid,
                "alias": m.get("name", mid),
            })
        return models
    except Exception:
        return []


def fetch_models_for_provider(provider: str, api_key: str | None = None) -> list[dict]:
    """Fetch live model list from a provider's API."""
    if not api_key:
        api_key = get_provider_api_key(provider)
    if not api_key:
        return []

    fetchers = {
        "venice": _fetch_venice_models,
        "openrouter": _fetch_openrouter_models,
        "xai": _fetch_xai_models,
    }
    fetcher = fetchers.get(provider)
    if not fetcher:
        return []
    return fetcher(api_key)


def discover_and_save_models(provider: str, api_key: str | None = None) -> list[dict]:
    """Fetch models from a provider and persist them to models.json."""
    models = fetch_models_for_provider(provider, api_key)
    if not models:
        return models

    data = {}
    if MODELS_FILE.exists():
        with open(MODELS_FILE, encoding="utf-8") as f:
            data = json.load(f)

    # Remove old entries for this provider
    to_remove = [k for k in data if data[k].get("provider") == provider]
    for k in to_remove:
        data.pop(k, None)

    # Add newly discovered models
    for m in models:
        data[m["id"]] = {
            "provider": m["provider"],
            "model": m["model"],
            "alias": m["alias"],
            "base_url": "",
        }

    with open(MODELS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    return models


# ─── Env file updates ─────────────────────────────────────────────────────


def _update_env_file(provider: str, model: str, api_key: str | None = None) -> None:
    """Rewrite ~/.env with the new provider/model/settings."""
    env = get_current_env()

    base_url = get_provider_base_url(provider)
    if base_url:
        env["OPENAI_BASE_URL"] = base_url

    # OPENAI_MODEL should NOT include the provider prefix
    env["OPENAI_MODEL"] = model

    # Preserve CLAUDE_CODE_USE_OPENAI flag
    env["CLAUDE_CODE_USE_OPENAI"] = "1"

    # Provider-specific metadata
    if provider == "venice":
        env["VENICE_MODEL_NAME"] = model
        env["VENICE_UNCENSORED"] = "true"
    else:
        env.pop("VENICE_MODEL_NAME", None)
        env.pop("VENICE_UNCENSORED", None)

    # Always set OPENAI_API_KEY to the key for the *current* provider,
    # regardless of whether a new key was supplied or a stored one is reused.
    if api_key:
        env["OPENAI_API_KEY"] = api_key

        # Also set provider-specific key for clarity
        provider_env_keys = {
            "venice": "VENICE_API_KEY",
            "openrouter": "OPENROUTER_API_KEY",
            "xai": "XAI_API_KEY",
        }
        env_key_name = provider_env_keys.get(provider)
        if env_key_name:
            env[env_key_name] = api_key

    _write_env_file(env)


def _write_env_file(env: dict[str, str]) -> None:
    """Write env dict back to ~/.env, preserving structure."""
    header_lines = [
        "# OpenClaude Environment Configuration",
        "# Auto-updated by OpenClaude Web UI",
        "",
    ]

    body_lines: list[str] = []
    for key, val in env.items():
        body_lines.append(f'export {key}="{val}"')

    with open(ENV_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(header_lines + body_lines) + "\n")


# ─── Public API ───────────────────────────────────────────────────────────


def get_model_info() -> dict:
    """Return current model + available models."""
    prefs = load_preferences()
    return {
        "current_model_id": prefs.get("default_model_id", ""),
        "current_provider": prefs.get("default_provider", ""),
        "current_model": prefs.get("default_model", ""),
        "models": [
            {"id": m["id"], "alias": m["alias"], "provider": m["provider"]}
            for m in get_configured_models()
        ],
        "providers": get_all_providers(),
    }


def switch_model(
    provider: str,
    model: str,
    api_key: str | None = None,
    discover: bool = False,
) -> dict:
    """Switch to a new provider/model and update ~/.env.

    Parameters
    ----------
    provider:
        Provider ID (venice, openrouter, xai, …).
    model:
        The model name *without* the provider prefix
        (e.g. "kimi-k2-5", not "venice/kimi-k2-5").
    api_key:
        Optional API key. If omitted, the existing key for the provider
        is reused.
    discover:
        If True, fetch the live model list from the provider and persist
        it before switching.

    Returns
    -------
    dict with status, current model, and any error message.
    """
    # Validate provider
    base_url = get_provider_base_url(provider)
    if not base_url:
        return {"status": "error", "error": f"Unknown provider: {provider}"}

    # Resolve API key
    resolved_key = api_key or get_provider_api_key(provider)
    if not resolved_key:
        return {
            "status": "error",
            "error": f"No API key available for provider: {provider}",
        }

    # Persist the key if it was newly supplied
    if api_key:
        set_provider_api_key(provider, api_key)

    # Optionally discover models from the provider API
    if discover:
        discover_and_save_models(provider, resolved_key)

    model_id = f"{provider}/{model}"

    # Ensure the model exists in models.json
    entry = get_model_entry(model_id)
    if not entry:
        # Create a minimal entry so the UI can display it
        from .config import add_model_entry

        add_model_entry(model_id, provider, model, alias=model)

    # Update ~/.env with resolved key (always present)
    _update_env_file(provider, model, resolved_key)

    # Update preferences
    prefs = load_preferences()
    prefs["default_provider"] = provider
    prefs["default_model"] = model
    prefs["default_model_id"] = model_id
    save_preferences(prefs)

    return {
        "status": "ok",
        "provider": provider,
        "model": model,
        "model_id": model_id,
    }
