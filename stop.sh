#!/usr/bin/env bash
# ─── OpenClaude Web UI — Stopper ────────────────────────────────────────
# PID-safe: only kills processes recorded in the pid files. Never uses
# `fuser -k` indiscriminately (which would kill unrelated dev tooling
# happening to bind 5173).
set -uo pipefail

LOG_DIR="$HOME/openclaude-webui/logs"

stop_pid_file() {
    local pid_file="$1" name="$2"
    if [[ ! -f "$pid_file" ]]; then
        echo "[openclaude] No PID file for $name"
        return
    fi
    local pid
    pid=$(cat "$pid_file")
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
        echo "[openclaude] $name was already stopped"
        rm -f "$pid_file"
        return
    fi
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
    fi
    echo "[openclaude] Stopped $name (pid $pid)"
    rm -f "$pid_file"
}

stop_pid_file "$LOG_DIR/api.pid" api
stop_pid_file "$LOG_DIR/ui.pid" ui
echo "[openclaude] Done."
