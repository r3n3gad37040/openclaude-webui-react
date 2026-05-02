"""OpenClaude Web UI — message runner.

Spawns a fresh `openclaude --print` subprocess for each message,
streams JSON output, and pushes text chunks into a queue for SSE.
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
from typing import Callable


def _load_env_file(path: str = os.path.expanduser("~/.env")) -> dict[str, str]:
    """Parse a simple .env file (export KEY=\"value\" lines) and return as dict."""
    env: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[7:]
                if "=" in line:
                    key, val = line.split("=", 1)
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    env[key] = val
    except FileNotFoundError:
        pass
    return env


class MessageRunner:
    """Runs a single message through openclaude CLI and streams output."""

    def __init__(self, session_id: str, model_id: str):
        self.session_id = session_id
        self.model_id = model_id
        self.queue: queue.Queue[tuple[str, str]] = queue.Queue()
        self._proc: subprocess.Popen | None = None
        self._reader_thread: threading.Thread | None = None
        self._stop_event = threading.Event()

    def run(self, message: str, workspace: str = "") -> None:
        """Spawn openclaude, send message via stdin, stream output."""
        # We do NOT pass --model here. The openclaude CLI reads OPENAI_MODEL
        # from the environment (~/.env), which the model_switcher keeps updated.
        # Use the actual openclaude binary directly, NOT the ~/.local/bin wrapper
        # which hardcodes Venice credentials.
        openclaude_bin = os.path.expanduser(
            "~/.npm-global/lib/node_modules/@gitlawb/openclaude/bin/openclaude"
        )
        # Merge current env with ~/.env vars (so API keys and model settings are available)
        env = os.environ.copy()
        env.update(_load_env_file())

        cmd = [
            openclaude_bin,
            "--print",
            "--verbose",
            "--output-format=stream-json",
            "--include-partial-messages",
            "--permission-mode", "bypassPermissions",
            "--bare",  # Bypass model validation against hardcoded list
        ]

        if workspace:
            cmd.extend(["--add-dir", workspace])

        # The original ~/.local/bin/openclaude wrapper sets these — we must too
        env["CLAUDE_CONFIG_DIR"] = "/home/johnny/.openclaw-openclaude"
        env["ANTHROPIC_API_KEY"] = ""
        env["FORCE_COLOR"] = "0"
        env["TERM"] = "dumb"

        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            env=env,
        )

        self._stop_event.clear()
        self._reader_thread = threading.Thread(
            target=self._read_loop, daemon=True
        )
        self._reader_thread.start()

        # Send message to stdin and close it
        if self._proc.stdin:
            self._proc.stdin.write(message + "\n")
            self._proc.stdin.close()

    def _read_loop(self) -> None:
        """Background thread: read stdout line-by-line, enqueue events."""
        assert self._proc is not None and self._proc.stdout is not None

        accumulated = ""
        emitted = ""  # tracks text already sent to queue (dedup)

        def emit(text: str) -> None:
            """Emit text only if it hasn't been emitted already."""
            nonlocal emitted
            if not text:
                return
            # Case 1: text is identical to or a prefix of already-emitted
            if text.startswith(emitted):
                new_part = text[len(emitted):]
                if new_part:
                    self.queue.put(("chunk", new_part))
                    emitted += new_part
                return
            # Case 2: text is a suffix continuation (normal streaming)
            if text.startswith(emitted[-len(text):]) if len(text) <= len(emitted) else False:
                return
            # Case 3: genuinely new text (different provider/format)
            self.queue.put(("chunk", text))
            emitted += text

        for line in self._proc.stdout:
            if self._stop_event.is_set():
                break

            line = line.strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue

            event_type = data.get("type")

            # Skip system/init metadata
            if event_type == "system":
                continue

            # Skip stream_event wrappers — extract the actual delta
            if event_type == "stream_event":
                event = data.get("event", {})
                ev_type = event.get("type")

                if ev_type == "content_block_delta":
                    delta = event.get("delta", {})
                    delta_type = delta.get("type")

                    if delta_type == "text_delta":
                        text = delta.get("text", "")
                        if text:
                            accumulated += text
                            emit(text)
                    elif delta_type == "thinking_delta":
                        thinking = delta.get("thinking", "")
                        if thinking:
                            # Accumulate thinking but don't stream it yet
                            pass

                elif ev_type == "message_stop":
                    # Extract usage data (token counts) from message_stop event
                    usage = data.get("event", {}).get("message", {}).get("usage", {})
                    if usage:
                        self.queue.put(("usage", json.dumps(usage)))
                    self.queue.put(("status", json.dumps({"type": "done"})))

                continue

            # Assistant message (openclaude --print emits type="assistant"
            # with message.content[] containing text/thinking blocks).
            # Venice emits assistant first then stream deltas (same text).
            # XAI/OpenRouter emit only assistant messages (no deltas).
            # The emit() helper deduplicates in all cases.
            if event_type == "assistant":
                msg = data.get("message", {})
                for block in msg.get("content", []):
                    if block.get("type") == "text":
                        text = block.get("text", "")
                        if text:
                            accumulated += text
                            emit(text)
                continue

            # Result/summary
            if event_type == "result":
                self.queue.put(("status", json.dumps({"type": "done"})))
                continue

            # Error
            if event_type == "error":
                self.queue.put(("error", data.get("message", "Unknown error")))
                continue

        # Wait for process to finish
        self._proc.wait()
        self.queue.put(("status", json.dumps({"type": "done"})))

    def cancel(self) -> None:
        """Kill the subprocess."""
        self._stop_event.set()
        if self._proc is not None and self._proc.poll() is None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=2)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
        if self._reader_thread is not None:
            self._reader_thread.join(timeout=2)

    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None


# ─── Session registry ─────────────────────────────────────────────────────

_active_runners: dict[str, MessageRunner] = {}


def run_message(session_id: str, model_id: str, message: str, workspace: str = "") -> MessageRunner:
    """Run a message and return the runner (output goes to runner.queue)."""
    # Cancel any existing runner for this session
    cancel_session(session_id)

    runner = MessageRunner(session_id, model_id)
    runner.run(message, workspace)
    _active_runners[session_id] = runner
    return runner


def get_active_runner(session_id: str) -> MessageRunner | None:
    runner = _active_runners.get(session_id)
    if runner is None or not runner.is_alive():
        return None
    return runner


def cancel_session(session_id: str) -> bool:
    runner = _active_runners.pop(session_id, None)
    if runner:
        runner.cancel()
        return True
    return False
