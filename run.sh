#!/usr/bin/env bash
set -uo pipefail

LOG="/tmp/openclaude-webui.log"
cd /home/johnny/openclaude-webui

# Kill any existing instance and wait for port
existing=$(pgrep -f "python3.*server.py" | head -1)
if [ -n "$existing" ]; then
    kill "$existing" 2>/dev/null
    sleep 1
    kill -9 "$existing" 2>/dev/null
    sleep 0.5
fi

# Server runs in foreground mode (no daemon), auto-restarts on crash
while true; do
    echo "[$(date)] Starting server..." >> "$LOG"
    python3 server.py >> "$LOG" 2>&1
    echo "[$(date)] Server exited, restarting in 2s..." >> "$LOG"
    sleep 2
done
