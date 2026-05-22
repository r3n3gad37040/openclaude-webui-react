#!/usr/bin/env bash
# ─── OpenClaude Web UI — Silent Launcher ────────────────────────────────
# No terminal. Opens browser automatically. Closing tab → kills servers.
# Kills all prior openclaude-webui servers before starting.
set -euo pipefail

APP_DIR="$HOME/openclaude-webui"
LOG_DIR="$APP_DIR/logs"
API_PORT=8789
UI_PORT=5173
API_LOG="$LOG_DIR/api.log"
UI_LOG="$LOG_DIR/ui.log"
API_PID="$LOG_DIR/api.pid"
UI_PID="$LOG_DIR/ui.pid"
URL="http://localhost:${UI_PORT}"

mkdir -p "$LOG_DIR"
cd "$APP_DIR"

# ═══════════════════════════════════════════════════════════════════════
# PHASE 1 — KILL PRIOR INSTANCES
# ═══════════════════════════════════════════════════════════════════════
kill_gentle() { kill -TERM "$1" 2>/dev/null || true; }
kill_hard()   { kill -9    "$1" 2>/dev/null || true; }

# 1a. PID files
for pf in "$API_PID" "$UI_PID"; do
    if [[ -f "$pf" ]]; then
        pid=$(cat "$pf" 2>/dev/null || true)
        [[ -n "$pid" ]] && kill_gentle "$pid"
        rm -f "$pf"
    fi
done

# 1b. Port listeners
for port in $API_PORT $UI_PORT; do
    (lsof -ti ":$port" 2>/dev/null || true) | while read -r pid; do
        [[ -n "$pid" ]] && kill_gentle "$pid"
    done
done
sleep 0.5
for port in $API_PORT $UI_PORT; do
    (lsof -ti ":$port" 2>/dev/null || true) | while read -r pid; do
        [[ -n "$pid" ]] && kill_hard "$pid"
    done
done

# 1c. Processes with openclaude-webui in cmdline
OUR_PIDS="$PPID $$"
for pass in TERM KILL; do
    for proc in $(pgrep -f "openclaude-webui" 2>/dev/null || true); do
        skip=0
        for p in $OUR_PIDS; do [[ "$proc" == "$p" ]] && skip=1; done
        [[ "$skip" == "1" ]] && continue
        if [[ "$pass" == "TERM" ]]; then kill_gentle "$proc"; else kill_hard "$proc"; fi
    done
    [[ "$pass" == "KILL" ]] && sleep 0.3
done

# ═══════════════════════════════════════════════════════════════════════
# PHASE 2 — LOG ROTATION
# ═══════════════════════════════════════════════════════════════════════
for logfile in "$API_LOG" "$UI_LOG"; do
    if [[ -f "$logfile" ]]; then
        size=$(stat -c%s "$logfile" 2>/dev/null || echo 0)
        [[ "$size" -gt 10485760 ]] && mv "$logfile" "${logfile}.1" 2>/dev/null || true
    fi
done

# ═══════════════════════════════════════════════════════════════════════
# PHASE 3 — START SERVERS
# ═══════════════════════════════════════════════════════════════════════

# API server
PORT="$API_PORT" nohup npx tsx src/server/index.ts >> "$API_LOG" 2>&1 &
echo "$!" > "$API_PID"

API_READY=0
for i in $(seq 1 30); do
    if curl -s "http://localhost:${API_PORT}/api/healthz" > /dev/null 2>&1; then
        API_READY=1
        break
    fi
    if ! kill -0 "$(cat "$API_PID")" 2>/dev/null && [[ $i -gt 5 ]]; then
        notify-send "OpenClaude" "API server failed to start" 2>/dev/null || true
        exit 1
    fi
    sleep 1
done
[[ "$API_READY" -eq 0 ]] && { notify-send "OpenClaude" "API server timed out" 2>/dev/null || true; exit 1; }

real_pid=$(lsof -ti ":${API_PORT}" 2>/dev/null | head -1 || true)
[[ -n "$real_pid" ]] && echo "$real_pid" > "$API_PID"

# UI server
nohup npx vite preview --port "$UI_PORT" >> "$UI_LOG" 2>&1 &
echo "$!" > "$UI_PID"
sleep 3

real_pid=$(lsof -ti ":${UI_PORT}" 2>/dev/null | head -1 || true)
[[ -n "$real_pid" ]] && echo "$real_pid" > "$UI_PID"

# ═══════════════════════════════════════════════════════════════════════
# PHASE 4 — OPEN BROWSER + WAIT FOR CONNECTION
# ═══════════════════════════════════════════════════════════════════════

xdg-open "$URL" &>/dev/null &
disown

# ── Stage A: Wait for the browser to connect (long timeout) ──
# Chrome with a fresh profile can take 5-15 seconds to initialize and connect.
CONNECTED=0
for i in $(seq 1 60); do
    sleep 1
    # Check API still alive
    curl -s "http://localhost:${API_PORT}/api/healthz" > /dev/null 2>&1 || break

    CONNS=$(ss -tn state established "sport = :${UI_PORT}" 2>/dev/null | tail -n +2 | wc -l)
    if [[ "$CONNS" -gt 0 ]]; then
        CONNECTED=1
        break
    fi
done

# If browser never connected within 60s, just exit (servers die naturally)
if [[ "$CONNECTED" -eq 0 ]]; then
    # Browser didn't connect; clean shutdown
    :
else
    # ── Stage B: Monitor for disconnect ──
    # Browser is connected. When connections drop to 0 for 10s, user closed tab.
    IDLE_COUNT=0
    while true; do
        sleep 2

        # Check API still alive
        API_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
            "http://localhost:${API_PORT}/api/healthz" 2>/dev/null || echo "000")
        [[ "$API_CODE" != "200" ]] && break

        CONNS=$(ss -tn state established "sport = :${UI_PORT}" 2>/dev/null | tail -n +2 | wc -l)

        if [[ "$CONNS" -eq 0 ]]; then
            IDLE_COUNT=$((IDLE_COUNT + 1))
            [[ "$IDLE_COUNT" -ge 5 ]] && break   # 5 × 2s = 10s grace
        else
            IDLE_COUNT=0
        fi
    done
fi

# ═══════════════════════════════════════════════════════════════════════
# PHASE 5 — SHUTDOWN
# ═══════════════════════════════════════════════════════════════════════

shutdown_proc() {
    local pid_file="$1"
    if [[ -f "$pid_file" ]]; then
        local pid
        pid=$(cat "$pid_file" 2>/dev/null || true)
        [[ -n "$pid" ]] && kill_gentle "$pid"
        rm -f "$pid_file"
    fi
}

shutdown_proc "$UI_PID"
shutdown_proc "$API_PID"
sleep 0.5

for port in $API_PORT $UI_PORT; do
    (lsof -ti ":$port" 2>/dev/null || true) | while read -r pid; do
        [[ -n "$pid" ]] && kill_hard "$pid"
    done
done