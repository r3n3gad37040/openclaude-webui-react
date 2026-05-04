#!/usr/bin/env bash
# ─── OpenClaude Web UI — Launcher ───────────────────────────────────────
# Runs API (8789) and UI (5173) as detached processes.
# Safe to close the terminal — servers keep running.
# Stop with: ~/openclaude-webui/stop.sh
set -euo pipefail

APP_DIR="$HOME/openclaude-webui"
LOG_DIR="$APP_DIR/logs"
API_PORT="${API_PORT:-8789}"
UI_PORT="${UI_PORT:-5173}"
API_LOG="$LOG_DIR/api.log"
UI_LOG="$LOG_DIR/ui.log"
API_PID="$LOG_DIR/api.pid"
UI_PID="$LOG_DIR/ui.pid"

mkdir -p "$LOG_DIR"
cd "$APP_DIR"

# ── PID-safe stop: only kill what we started, never indiscriminate fuser -k.
# fuser -k would kill ANY process holding the port, including unrelated
# vite/dev tooling on 5173.
stop_pid_file() {
    local pid_file="$1" name="$2"
    if [[ -f "$pid_file" ]]; then
        local pid
        pid=$(cat "$pid_file")
        if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            for _ in 1 2 3 4 5; do
                kill -0 "$pid" 2>/dev/null || break
                sleep 0.2
            done
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$pid_file"
    fi
}

# ── Log rotation: cap each log at 10 MB by rolling to .1 on each start.
rotate_log() {
    local log="$1"
    if [[ -f "$log" ]] && [[ $(stat -c%s "$log" 2>/dev/null || echo 0) -gt 10485760 ]]; then
        mv "$log" "${log}.1"
    fi
}

stop_pid_file "$API_PID" api
stop_pid_file "$UI_PID" ui
rotate_log "$API_LOG"
rotate_log "$UI_LOG"

# ─── API server ──────────────────────────────────────────────────────────
echo "[openclaude] Starting API server on port ${API_PORT}..."
PORT="$API_PORT" setsid npx tsx src/server/index.ts > "$API_LOG" 2>&1 &
API_BG_PID=$!
echo "$API_BG_PID" > "$API_PID"

for i in $(seq 1 30); do
    curl -s "http://localhost:${API_PORT}/api/healthz" > /dev/null 2>&1 && break
    if ! kill -0 "$API_BG_PID" 2>/dev/null && [[ $i -gt 5 ]]; then
        echo "[openclaude] ERROR: API failed to start. Last log:"
        tail -20 "$API_LOG"
        exit 1
    fi
    sleep 1
done

# Save the actual port-owning PID (might be a child of the launched process
# tree). Fall back to the launched PID if fuser isn't available or returns
# nothing.
if command -v fuser >/dev/null 2>&1; then
    real_pid=$(fuser "${API_PORT}/tcp" 2>/dev/null | tr ' ' '\n' | grep -v '^$' | head -1 || true)
    if [[ -n "$real_pid" ]]; then
        echo "$real_pid" > "$API_PID"
    fi
fi
echo "[openclaude] API ready (pid $(cat "$API_PID")). Logs: $API_LOG"

# ─── UI server ───────────────────────────────────────────────────────────
echo "[openclaude] Starting UI on port ${UI_PORT}..."
setsid npx vite preview --port "$UI_PORT" > "$UI_LOG" 2>&1 &
UI_BG_PID=$!
echo "$UI_BG_PID" > "$UI_PID"
sleep 2

if command -v fuser >/dev/null 2>&1; then
    real_pid=$(fuser "${UI_PORT}/tcp" 2>/dev/null | tr ' ' '\n' | grep -v '^$' | head -1 || true)
    if [[ -n "$real_pid" ]]; then
        echo "$real_pid" > "$UI_PID"
    fi
fi
echo "[openclaude] UI ready (pid $(cat "$UI_PID")). Logs: $UI_LOG"

echo ""
echo "  OpenClaude running at → http://localhost:${UI_PORT}"
echo "  Stop with: $APP_DIR/stop.sh"
echo ""
xdg-open "http://localhost:${UI_PORT}" 2>/dev/null &
