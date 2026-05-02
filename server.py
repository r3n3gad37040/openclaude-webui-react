#!/usr/bin/env python3
"""OpenClaude Web UI — HTTP server entry point.

Usage:
    python3 server.py              # foreground
    python3 server.py --daemon     # background daemon

Environment:
    OPENCLAUDE_WEBUI_HOST  (default: 0.0.0.0)
    OPENCLAUDE_WEBUI_PORT  (default: 8788)
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

# Ensure our api/ package is importable
sys.path.insert(0, str(Path(__file__).parent))

from api.config import HOST, PORT
from api.routes import RequestHandler


class AutoRestartThreadingHTTPServer(ThreadingHTTPServer):
    """Automatically retries bind on port conflict."""
    allow_reuse_address = True
    allow_reuse_port = True

def run_server():
    AutoRestartThreadingHTTPServer.allow_reuse_address = True
    AutoRestartThreadingHTTPServer.allow_reuse_port = True
    server = AutoRestartThreadingHTTPServer((HOST, PORT), RequestHandler)
    print(f"[OpenClaude Web UI] http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


def run_daemon():
    """Run server in background, write PID file."""
    pid_file = Path.home() / ".openclaude-webui" / "server.pid"
    pid_file.parent.mkdir(parents=True, exist_ok=True)

    # Check if already running
    if pid_file.exists():
        old_pid = pid_file.read_text().strip()
        if old_pid and Path(f"/proc/{old_pid}").exists():
            print(f"[OpenClaude Web UI] Already running (PID {old_pid})")
            sys.exit(0)

    # Double-fork daemon pattern
    pid = os.fork()
    if pid > 0:
        sys.exit(0)

    os.setsid()
    pid = os.fork()
    if pid > 0:
        sys.exit(0)

    # Redirect stdout/stderr
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    os.close(devnull)

    server = ThreadingHTTPServer((HOST, PORT), RequestHandler)
    pid_file.write_text(str(os.getpid()))
    server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description="OpenClaude Web UI Server")
    parser.add_argument("--daemon", action="store_true", help="Run as background daemon")
    args = parser.parse_args()

    if args.daemon:
        run_daemon()
    else:
        run_server()


if __name__ == "__main__":
    main()
