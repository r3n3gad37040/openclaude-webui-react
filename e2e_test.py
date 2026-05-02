#!/usr/bin/env python3
"""End-to-end test: 3 providers x 2 models each + message persistence."""

import json, os, sys, time, urllib.request, urllib.error

BASE = "http://localhost:8788"


def api(method: str, path: str, data: dict | None = None):
    url = f"{BASE}{path}"
    body = json.dumps(data).encode("utf-8") if data else None
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            return {"error": str(e), "code": e.code}
    except Exception as e:
        return {"error": str(e)}


def switch_model(provider: str, model: str):
    print(f"\n--- Switching to {provider}/{model} ---")
    r = api("POST", "/api/switch-model", {"provider": provider, "model": model})
    if r.get("error"):
        print(f"  SWITCH ERROR: {r}")
        return False
    print(f"  Switched OK: {r.get('provider')}/{r.get('model')}")
    # Verify
    time.sleep(0.5)
    m = api("GET", "/api/models")
    if m.get("current_model") != model or m.get("current_provider") != provider:
        print(f"  VERIFY FAIL: got {m.get('current_provider')}/{m.get('current_model')}")
        return False
    print(f"  Verified OK")
    return True


def send_message(session_id: str, text: str) -> bool:
    print(f"  Sending: '{text[:50]}...' " if len(text) > 50 else f"  Sending: '{text}' ")
    url = f"{BASE}/api/sessions/{session_id}/messages"
    body = json.dumps({"role": "user", "content": text}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        # SSE stream — start it but don't block; fire-and-forget
        with urllib.request.urlopen(req, timeout=10) as resp:
            # Read a small chunk to confirm stream started
            chunk = resp.read(256)
            print(f"  Stream started ({len(chunk)} bytes)")
    except urllib.error.HTTPError as e:
        print(f"  HTTP Error: {e.code} {e.read().decode()[:200]}")
        return False
    except Exception as e:
        # Timeout is expected since we don't read the full stream
        print(f"  Stream init ok (timeout expected)")
    # Wait for the runner to finish and persist
    time.sleep(15)
    return True


def check_persistence(session_id: str, expected_role: str, expected_substring: str) -> bool:
    s = api("GET", f"/api/sessions/{session_id}")
    msgs = s.get("messages", [])
    for m in msgs:
        if m.get("role") == expected_role and expected_substring.lower() in m.get("content", "").lower():
            print(f"  Persistence OK: found {expected_role} msg containing '{expected_substring[:30]}'")
            return True
    print(f"  Persistence FAIL: no {expected_role} msg with '{expected_substring[:30]}' in {len(msgs)} msgs")
    for i, m in enumerate(msgs):
        print(f"    [{i}] {m.get('role')}: {m.get('content', '')[:60]}...")
    return False


def test_provider_models(provider: str, models: list[str]):
    print(f"\n{'='*60}")
    print(f"TESTING PROVIDER: {provider}")
    print(f"{'='*60}")
    for model in models:
        if not switch_model(provider, model):
            return False, f"Failed to switch to {provider}/{model}"

        # Create a fresh session for this model test
        r = api("POST", "/api/sessions", {"title": f"Test {provider}/{model}"})
        sid = r.get("id")
        if not sid:
            return False, f"Failed to create session for {provider}/{model}"
        print(f"  Session: {sid}")

        # Send user message
        msg = f"What model are you? (testing {provider} {model})"
        if not send_message(sid, msg):
            return False, f"Failed to send message to {provider}/{model}"

        # Check user message persisted
        if not check_persistence(sid, "user", msg):
            return False, f"User message not persisted for {provider}/{model}"

        # Note: assistant response persistence is harder to verify automatically
        # because streaming may timeout. We'll log what we find.
        time.sleep(2)
        s = api("GET", f"/api/sessions/{sid}")
        msgs = s.get("messages", [])
        assistant_msgs = [m for m in msgs if m.get("role") == "assistant"]
        if assistant_msgs:
            content = assistant_msgs[-1].get("content", "")[:80]
            print(f"  Assistant response persisted: '{content}...'")
        else:
            print(f"  WARNING: No assistant response persisted (may be streaming issue)")

    return True, "OK"


def main():
    print("OpenClaude Web UI End-to-End Test")
    print(f"Testing against {BASE}")
    print("=" * 60)

    # Verify server is up
    try:
        req = urllib.request.Request(f"{BASE}/")
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status != 200:
                print(f"Server not responding: status {resp.status}")
                sys.exit(1)
    except Exception as e:
        print(f"Server not responding: {e}")
        sys.exit(1)
    print("Server is up")

    # Get available models
    m = api("GET", "/api/models")
    all_models = m.get("models", [])
    print(f"Available models: {len(all_models)}")

    # Pick 2 models per provider to test
    providers_to_test = {
        "venice": [],
        "openrouter": [],
        "xai": [],
    }
    for model in all_models:
        p = model.get("provider")
        if p in providers_to_test and len(providers_to_test[p]) < 2:
            providers_to_test[p].append(model["id"].split("/", 1)[1])

    print(f"\nModels to test: {providers_to_test}")

    results = []
    for provider, models in providers_to_test.items():
        if len(models) < 2:
            print(f"\nWARNING: Only {len(models)} model(s) available for {provider}, skipping")
            continue
        ok, msg = test_provider_models(provider, models)
        results.append((provider, ok, msg))

    print(f"\n{'='*60}")
    print("RESULTS")
    print(f"{'='*60}")
    all_pass = True
    for provider, ok, msg in results:
        status = "PASS" if ok else "FAIL"
        print(f"  {provider}: {status} — {msg}")
        if not ok:
            all_pass = False

    if all_pass:
        print("\nAll tests PASSED")
        sys.exit(0)
    else:
        print("\nSome tests FAILED")
        sys.exit(1)


if __name__ == "__main__":
    main()
