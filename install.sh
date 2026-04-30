#!/usr/bin/env bash
# ─── OpenClaude Web UI — Installer ──────────────────────────────────────
# Installs the app, dependencies, and desktop launcher.
# Run:  bash install.sh
set -euo pipefail

APP_DIR="$HOME/openclaude-webui"
DESKTOP_FILE="$HOME/.local/share/applications/openclaude-webui.desktop"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"

echo "═══════════════════════════════════════════"
echo "  OpenClaude Web UI — Installer"
echo "═══════════════════════════════════════════"
echo ""

# ─── 1. Check prerequisites ──────────────────────────────────────────────
command -v node  >/dev/null 2>&1 || { echo "ERROR: node is required. Install Node.js first."; exit 1; }
command -v npm   >/dev/null 2>&1 || { echo "ERROR: npm is required. Install npm first."; exit 1; }

echo "[1/4] Node.js $(node --version) ✓"
echo "      npm $(npm --version) ✓"

# ─── 2. Sync app files (never wipes the directory) ───────────────────────
echo "[2/4] Syncing files to ${APP_DIR}..."
mkdir -p "$APP_DIR"
# Copy source files explicitly — never touch node_modules or state
for item in dist src vite.config.ts tsconfig.json tsconfig.node.json \
            package.json package-lock.json \
            start.sh install.sh openclaude-webui.desktop; do
    [ -e "$item" ] && cp -r "$item" "$APP_DIR/"
done
chmod +x "$APP_DIR/start.sh" "$APP_DIR/install.sh"

# ─── 3. Install npm dependencies ──────────────────────────────────────────
echo "[3/4] Installing npm dependencies..."
cd "$APP_DIR"
npm install 2>&1 | tail -3

# ─── 4. Install desktop launcher + icon ───────────────────────────────────
echo "[4/4] Installing desktop launcher..."

# Create .desktop entry
mkdir -p "$(dirname "$DESKTOP_FILE")"
cp "$APP_DIR/openclaude-webui.desktop" "$DESKTOP_FILE"
chmod +x "$DESKTOP_FILE"

# Generate icon from SVG or use a fallback
mkdir -p "$ICON_DIR"
if command -v convert &>/dev/null; then
    # Try to create icon from OpenClaude logo SVG if it exists
    ICON_SRC=""
    for ext in png svg ico; do
        if [ -f "$APP_DIR/src/ui/assets/icon.${ext}" ]; then
            ICON_SRC="$APP_DIR/src/ui/assets/icon.${ext}"
            break
        fi
    done
    if [ -n "$ICON_SRC" ]; then
        convert "$ICON_SRC" -resize 256x256 "$ICON_DIR/openclaude-webui.png" 2>/dev/null || true
    fi
fi

# Update desktop database so the launcher appears immediately
update-desktop-database "$HOME/.local/share/applications/" 2>/dev/null || true

echo ""
echo "═══════════════════════════════════════════"
echo "  Installation complete!"
echo ""
echo "  Launch from your application menu:"
echo "    → OpenClaude Web UI"
echo ""
echo "  Or from terminal:"
echo "    $APP_DIR/start.sh"
echo "═══════════════════════════════════════════"
