#!/usr/bin/env bash
# ─── OpenClaude Web UI — Launcher ───────────────────────────────────────
# Runs API (8789) and UI (5173) as detached processes.
# Safe to close the terminal — servers keep running.
# Stop with: ~/openclaude-webui/stop.sh
set -euo pipefail

APP_DIR="$HOME/openclaude-webui"
LOG_DIR="$APP_DIR/logs"
API_PORT=8789
UI_PORT=5173

mkdir -p "$LOG_DIR"
cd "$APP_DIR"

# Stop any existing instances
fuser -k "${API_PORT}/tcp" 2>/dev/null || true
fuser -k "${UI_PORT}/tcp" 2>/dev/null || true
rm -f "$LOG_DIR/api.pid" "$LOG_DIR/ui.pid"
sleep 0.5

# ─── API server ──────────────────────────────────────────────────────────
echo "[openclaude] Starting API server on port ${API_PORT}..."
setsid npx tsx src/server/index.ts > "$LOG_DIR/api.log" 2>&1 &

for i in $(seq 1 30); do
    curl -s "http://localhost:${API_PORT}/api/status" > /dev/null 2>&1 && break
    # Check if something went wrong
    if ! fuser "${API_PORT}/tcp" > /dev/null 2>&1 && [[ $i -gt 5 ]]; then
        echo "[openclaude] ERROR: API failed to start. Last log:"
        tail -20 "$LOG_DIR/api.log"
        exit 1
    fi
    sleep 1
done

# Save actual port-owning PID
fuser "${API_PORT}/tcp" 2>/dev/null | tr ' ' '\n' | grep -v '^$' | head -1 > "$LOG_DIR/api.pid"
echo "[openclaude] API ready (pid $(cat "$LOG_DIR/api.pid")). Logs: $LOG_DIR/api.log"

# ─── UI server ───────────────────────────────────────────────────────────
echo "[openclaude] Starting UI on port ${UI_PORT}..."
setsid npx vite preview > "$LOG_DIR/ui.log" 2>&1 &
sleep 2

fuser "${UI_PORT}/tcp" 2>/dev/null | tr ' ' '\n' | grep -v '^$' | head -1 > "$LOG_DIR/ui.pid"
echo "[openclaude] UI ready (pid $(cat "$LOG_DIR/ui.pid")). Logs: $LOG_DIR/ui.log"

# ─── Done ────────────────────────────────────────────────────────────────
echo ""
echo "  OpenClaude running at → http://localhost:${UI_PORT}"
echo "  Stop with: $APP_DIR/stop.sh"
echo ""
xdg-open "http://localhost:${UI_PORT}" 2>/dev/null &
