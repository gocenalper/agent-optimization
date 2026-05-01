#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
USER_HOME="$HOME"
PLIST_SRC="$SCRIPT_DIR/com.agent-optimization.plist"
PLIST_DST="$USER_HOME/Library/LaunchAgents/com.agent-optimization.plist"
DOCKER=$(command -v docker || echo "/usr/local/bin/docker")

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   Agent Optimization — Setup                 ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# 1. Check Docker (OrbStack or Docker Desktop)
if ! docker info > /dev/null 2>&1; then
  echo "→ Docker not ready, trying to start OrbStack…"
  open -a OrbStack 2>/dev/null || true
  for i in $(seq 1 15); do
    sleep 2
    docker info > /dev/null 2>&1 && break
    echo "   waiting… ($((i*2))s)"
  done
fi
if ! docker info > /dev/null 2>&1; then
  echo "⚠  Docker still not ready. Open OrbStack or Docker Desktop manually, then re-run."
  exit 1
fi
echo "✓ Docker is running ($(docker context show))"

# 2. Build & start with compose
# Check for API key
if [ ! -f "$SCRIPT_DIR/.env" ] || ! grep -q "OPENAI_API_KEY=.*sk-" "$SCRIPT_DIR/.env" 2>/dev/null; then
  echo ""
  echo "⚠  No OPENAI_API_KEY found in .env"
  echo "   → Add to $SCRIPT_DIR/.env:  OPENAI_API_KEY=sk-..."
  echo "   → Optional: OPENAI_ANALYSIS_MODEL=gpt-5.4-mini"
  echo "   → App will use heuristic fallback until key is set"
  echo ""
fi
if [ -f "$SCRIPT_DIR/.env" ]; then
  export $(grep -v '^#' "$SCRIPT_DIR/.env" | xargs)
fi
echo "→ Building image and starting container…"
cd "$SCRIPT_DIR"
docker compose up -d --build
echo "✓ Container started"

# 3. Install LaunchAgent (auto-start on login)
echo "→ Installing LaunchAgent…"
# Inject real home path and docker path into plist
sed "s|USER_PLACEHOLDER|$(whoami)|g; s|/usr/local/bin/docker compose|$DOCKER compose|g" \
  "$PLIST_SRC" > "$PLIST_DST"
# Unload if already loaded (ignore errors)
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "✓ LaunchAgent installed — will auto-start at login"

# 4. Open browser
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   Dashboard → http://localhost:4317           ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
sleep 1
open "http://localhost:4317" 2>/dev/null || true
