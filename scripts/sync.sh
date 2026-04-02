#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# MixPi — Quick sync to Raspberry Pi
#
# Usage:
#   ./scripts/sync.sh                        # sync to default host
#   ./scripts/sync.sh user@192.168.1.50      # sync to specific IP
#   ./scripts/sync.sh --no-restart           # sync without restarting service
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DEFAULT_USER="${PI_USER:-$(whoami)}"
DEFAULT_HOST="${PI_HOST:-mixpi.local}"
DEFAULT_TARGET="${DEFAULT_USER}@${DEFAULT_HOST}"

REMOTE_DIR="/opt/mixpi"
RESTART=true

# Colour helpers
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

# Resolve Pi target with interactive prompt if not provided
if [[ -z "${1:-}" && -z "${PI_HOST:-}" ]]; then
    echo -e "${YELLOW}No Pi target specified.${NC}"
    read -rp "Enter Pi target (user@host or IP, e.g. pi@mixpi.local): " INPUT_TARGET
    if [ -n "$INPUT_TARGET" ]; then
        REMOTE="$INPUT_TARGET"
    else
        REMOTE="$DEFAULT_TARGET"
    fi
else
    REMOTE="${1:-$DEFAULT_TARGET}"
fi

# Parse arguments
if [[ "$REMOTE" == "--no-restart" ]]; then
    REMOTE="$DEFAULT_TARGET"
    RESTART=false
fi
if [[ "${2:-}" == "--no-restart" ]]; then
    RESTART=false
fi

echo "============================================"
echo "  MixPi — Sync to Pi"
echo "============================================"
echo "  Target : $REMOTE:$REMOTE_DIR"
echo "  Restart: $RESTART"
echo "--------------------------------------------"

# Sync source files (exclude dev artifacts, venv, recordings)
rsync -avz --delete \
    --exclude '.git/' \
    --exclude '__pycache__/' \
    --exclude '*.pyc' \
    --exclude 'venv/' \
    --exclude '.venv/' \
    --exclude 'recordings/' \
    --exclude 'dev/recordings/' \
    --exclude 'dev/*.log' \
    --exclude 'node_modules/' \
    --exclude '*.egg-info/' \
    --exclude '.env' \
    --exclude 'id_ed25519*' \
    --exclude 'id_rsa*' \
    --exclude 'config.yaml' \
    --exclude 'certs/' \
    --exclude 'web/static/mixpi-ca.crt' \
    ./ "$REMOTE:$REMOTE_DIR/"

# Push config.yaml only if it doesn't exist on the Pi yet (first deploy)
if ! ssh "$REMOTE" "test -f $REMOTE_DIR/config.yaml" 2>/dev/null; then
    echo "  First deploy — copying config.yaml to Pi…"
    rsync -avz config.yaml "$REMOTE:$REMOTE_DIR/config.yaml"
    echo "  ⚠  Edit $REMOTE_DIR/config.yaml on the Pi to set the XR18 IP"
fi

echo ""
echo "✓ Files synced"

if $RESTART; then
    echo "  Restarting MixPi service…"
    ssh "$REMOTE" "sudo systemctl restart mixpi-recorder 2>/dev/null || \
        (cd $REMOTE_DIR && pkill -f 'python.*app.py' 2>/dev/null; \
         nohup python3 -m web.app > /tmp/mixpi.log 2>&1 &)" 2>/dev/null || true

    sleep 2

    # Quick health check
    HOST_ONLY="${REMOTE##*@}"
    # Try HTTPS first (if enabled), fall back to HTTP
    if curl -sfk "https://${HOST_ONLY}:5000/api/recording/status" >/dev/null 2>&1; then
        echo "✓ MixPi is up at https://${HOST_ONLY}:5000"
    elif curl -sf "http://${HOST_ONLY}:5000/api/recording/status" >/dev/null 2>&1; then
        echo "✓ MixPi is up at http://${HOST_ONLY}:5000"
    else
        echo "  Service restarted — may take a few more seconds to start"
        echo "  Open: http://${HOST_ONLY}:5000"
    fi
fi

echo "============================================"
