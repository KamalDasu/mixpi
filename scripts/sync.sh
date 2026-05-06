#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# MixPi — Quick sync to Raspberry Pi
#
# Usage:
#   ./scripts/sync.sh                        # rsync from this machine → Pi (default host)
#   ./scripts/sync.sh user@192.168.1.50      # rsync to specific host
#   ./scripts/sync.sh --no-restart           # rsync without restarting service
#   ./scripts/sync.sh --git-only [user@host] # Pi only: git fetch + reset --hard origin/main
#                                            # (requires /opt/mixpi to be a git clone on the Pi;
#                                            #  skips rsync — Pi must reach GitHub)
#
# Before rsync, writes web/mixpi_version.json from local git so the Pi (no .git)
# still reports the correct hash in /api/version and the UI build badge.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DEFAULT_USER="${PI_USER:-$(whoami)}"
DEFAULT_HOST="${PI_HOST:-mixpi.local}"
DEFAULT_TARGET="${DEFAULT_USER}@${DEFAULT_HOST}"

REMOTE_DIR="/opt/mixpi"
RESTART=true
GIT_ONLY=false

# Colour helpers
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

# Strip flags; remaining args are the optional user@host
FILTERED=()
for arg in "$@"; do
    case "$arg" in
        --git-only) GIT_ONLY=true ;;
        --no-restart) RESTART=false ;;
        *) FILTERED+=("$arg") ;;
    esac
done
set -- "${FILTERED[@]}"

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

echo "============================================"
echo "  MixPi — Sync to Pi"
echo "============================================"
echo "  Target : $REMOTE:$REMOTE_DIR"
echo "  Restart: $RESTART"
if $GIT_ONLY; then
    echo "  Mode   : --git-only (no rsync; Pi tracks origin/main)"
fi
echo "--------------------------------------------"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Git-only update on the Pi (clone at /opt/mixpi) ─────────────────────────
if $GIT_ONLY; then
    if ! ssh "$REMOTE" "test -d $REMOTE_DIR/.git" 2>/dev/null; then
        echo -e "  ${YELLOW}⚠  $REMOTE:$REMOTE_DIR has no .git — use normal sync (rsync) instead.${NC}"
        echo "     Or clone once on the Pi: sudo git clone https://github.com/…/mixpi.git $REMOTE_DIR"
        exit 1
    fi
    echo "  Updating Pi from GitHub (fetch + reset --hard origin/main)…"
    # Run git as the repo owner (no sudo) so .git/objects stay user-owned.
    # The app (git_updater.py) also runs as the same user; root-owned objects
    # cause "insufficient permission" errors on subsequent app-initiated fetches.
    if ! ssh "$REMOTE" "cd $REMOTE_DIR && git fetch origin main && git reset --hard origin/main"; then
        echo -e "  ${YELLOW}⚠  git update failed (network or credentials on Pi).${NC}"
        echo -e "  ${YELLOW}   If you see a permission error, repair with:${NC}"
        echo -e "  ${CYAN}   ssh $REMOTE 'sudo chown -R \$(whoami):\$(whoami) $REMOTE_DIR/.git'${NC}"
        exit 1
    fi
    echo ""
    echo "✓ Pi is at origin/main"
    if $RESTART; then
        echo "  Restarting MixPi service…"
        ssh "$REMOTE" "sudo systemctl restart mixpi-recorder 2>/dev/null || \
            (cd $REMOTE_DIR && pkill -f 'python.*app.py' 2>/dev/null; \
             nohup python3 -m web.app > /tmp/mixpi.log 2>&1 &)" 2>/dev/null || true
        sleep 2
        HOST_ONLY="${REMOTE##*@}"
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
    exit 0
fi

echo "  Stamping build version (web/mixpi_version.json)…"
if ! (cd "$ROOT" && python3 - <<'PY'
import json
import subprocess
import sys
from pathlib import Path

repo = Path.cwd()
sys.path.insert(0, str(repo))

def run_git(args):
    try:
        return subprocess.check_output(
            ["git", "-C", str(repo)] + args,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        ).strip()
    except Exception:
        return ""

short = run_git(["rev-parse", "--short=7", "HEAD"])
date = run_git(["log", "-1", "--format=%cd", "--date=short"])
if not short:
    short = "unknown"

try:
    from web import __version__ as semver
except Exception:
    semver = "0"

Path("web/mixpi_version.json").write_text(
    json.dumps({"hash": short, "date": date, "semver": semver}, separators=(",", ":")),
    encoding="utf-8",
)
print(f"    hash={short} date={date!r}")
PY
); then
    echo -e "  ${YELLOW}⚠  Could not write mixpi_version.json (need python3 + git in repo)${NC}"
fi

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
