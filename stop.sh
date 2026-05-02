#!/usr/bin/env bash
LOG_DIR="$HOME/openclaude-webui/logs"

for f in api ui; do
    PID_FILE="$LOG_DIR/${f}.pid"
    if [[ -f "$PID_FILE" ]]; then
        PID=$(cat "$PID_FILE")
        kill "$PID" 2>/dev/null && echo "[openclaude] Stopped $f (pid $PID)" || echo "[openclaude] $f was already stopped"
        rm -f "$PID_FILE"
    else
        echo "[openclaude] No PID file for $f"
    fi
done

fuser -k 8789/tcp 2>/dev/null || true
fuser -k 5173/tcp 2>/dev/null || true
echo "[openclaude] Done."
