#!/usr/bin/env bash
# ─── OpenClaude Web UI — Installer ──────────────────────────────────────
# Full setup: installs openclaude CLI, runs onboarding, then sets up the web UI.
# Run:  bash install.sh
set -euo pipefail

echo ""
echo "  ╔═══════════════════════════════════════════════╗"
echo "  ║  OpenClaude Web UI — Full Installer           ║"
echo "  ╚═══════════════════════════════════════════════╝"
echo ""

# ─── 1. System prerequisites ────────────────────────────────────────────
echo "── [1/6] Checking system prerequisites ──"

MISSING=()
command -v node  >/dev/null 2>&1  || MISSING+=("node")
command -v npm   >/dev/null 2>&1  || MISSING+=("npm")

if [ ${#MISSING[@]} -gt 0 ]; then
    echo "ERROR: Missing required tools: ${MISSING[*]}"
    echo ""
    echo "Install them with:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "  sudo apt install -y nodejs npm"
    echo "  sudo npm install -g npm"
    exit 1
fi

echo "  ✓ Node.js $(node --version)"
echo "  ✓ npm $(npm --version)"

# ─── 2. Install openclaude CLI ──────────────────────────────────────────
echo ""
echo "── [2/6] Installing openclaude CLI ──"

if command -v openclaude >/dev/null 2>&1; then
    CURRENT_VER=$(openclaude --version 2>/dev/null || echo "unknown")
    echo "  ✓ openclaude ${CURRENT_VER} already installed"
else
    echo "  Installing @gitlawb/openclaude globally..."
    npm install -g @gitlawb/openclaude
    echo "  ✓ openclaude installed ($(openclaude --version))"
fi

# ─── 3. openclaude onboarding ───────────────────────────────────────────
echo ""
echo "── [3/6] openclaude onboarding ──"

if [ ! -d "$HOME/.openclaw" ]; then
    echo ""
    echo "  openclaude has not been set up yet."
    echo "  Running the interactive onboarding wizard..."
    echo "  (Set up your LLM provider, model, and API key)"
    echo ""
    openclaude init
    echo ""
    echo "  ✓ openclaude onboarding complete"
else
    echo "  ✓ openclaude already configured ($HOME/.openclaw exists)"
fi

# ─── 4. Verify openclaude works ─────────────────────────────────────────
echo ""
echo "── [4/6] Verifying openclaude ──"

if openclaude --version >/dev/null 2>&1; then
    echo "  ✓ openclaude CLI is ready"
else
    echo "  ✗ openclaude setup failed. The web UI needs openclaude to work."
    echo "  Run 'openclaude init' manually and re-run this script."
    exit 1
fi

# ─── 5. Install web UI ──────────────────────────────────────────────────
echo ""
echo "── [5/6] Setting up the web UI ──"

APP_DIR="$HOME/openclaude-webui"
DESKTOP_FILE="$HOME/.local/share/applications/openclaude-webui.desktop"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"

echo "  Syncing files to ${APP_DIR}..."
mkdir -p "$APP_DIR"
for item in dist src vite.config.ts tsconfig.json tsconfig.node.json \
            package.json package-lock.json stop.sh \
            start.sh install.sh openclaude-webui.desktop; do
    [ -e "$item" ] && cp -r "$item" "$APP_DIR/"
done
chmod +x "$APP_DIR/start.sh" "$APP_DIR/install.sh" "$APP_DIR/stop.sh"

echo "  Installing npm dependencies..."
cd "$APP_DIR"
npm install 2>&1 | tail -3

# ─── 6. Desktop launcher ────────────────────────────────────────────────
echo ""
echo "── [6/6] Installing desktop launcher ──"

mkdir -p "$(dirname "$DESKTOP_FILE")"
mkdir -p "$ICON_DIR"

cp openclaude-webui.desktop "$DESKTOP_FILE"
chmod +x "$DESKTOP_FILE"

if [ -f "src/ui/assets/icon.png" ] && command -v convert &>/dev/null; then
    convert "src/ui/assets/icon.png" -resize 256x256 "$ICON_DIR/openclaude-webui.png" 2>/dev/null || true
fi

update-desktop-database "$HOME/.local/share/applications/" 2>/dev/null || true

echo ""
echo "═══════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Everything you need:"
echo "    • openclaude CLI    $(openclaude --version 2>/dev/null || echo 'installed')"
echo "    • Web UI server     port 8789"
echo "    • Web UI interface   port 5173"
echo ""
echo "  Launch:"
echo "    From menu: OpenClaude Web UI"
echo "    From CLI:  $APP_DIR/start.sh"
echo "═══════════════════════════════════════════"
