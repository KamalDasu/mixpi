#!/bin/bash
# =============================================================================
#  MixPi — Local HTTPS setup via mkcert
#
#  Creates a locally-trusted CA + TLS certificate for raspberrypi.local so
#  that the Web Share API (AirDrop) works without requiring a public domain.
#
#  Run on the Raspberry Pi:
#      sudo bash /opt/mixpi/scripts/setup_https.sh
#
#  After running, follow the printed iOS/macOS steps, then:
#      sudo systemctl restart mixpi-recorder.service
# =============================================================================
set -euo pipefail

CERT_DIR=/opt/mixpi/certs
STATIC_DIR=/opt/mixpi/web/static
SERVICE=mixpi-recorder.service
MKCERT_BIN=$(command -v mkcert || echo "/usr/local/bin/mkcert")
AUTO=0

# Parse flags
for arg in "$@"; do
    case $arg in
        --auto) AUTO=1 ;;
    esac
done

# ── colour helpers ─────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}▶ $*${NC}"; }
ok()    { echo -e "${GREEN}✓ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠ $*${NC}"; }
step()  { echo; echo -e "${CYAN}══ $* ══${NC}"; }

# ── root check ────────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    echo "Please run with sudo:  sudo bash $0"
    exit 1
fi

# ── detect service user (default: current user) ──────────────────────────────
if [ -n "${SUDO_USER:-}" ]; then
    SVC_USER="$SUDO_USER"
else
    SVC_USER="$(whoami)"
fi

echo
echo "=================================================="
echo "  MixPi HTTPS Setup"
echo "=================================================="
echo

# ─────────────────────────────────────────────────────────────────────────────
step "1 — Install dependencies"
apt-get install -y -q libnss3-tools curl
ok "libnss3-tools / curl ready"

# ─────────────────────────────────────────────────────────────────────────────
step "2 — Install mkcert"
if [ -x "$MKCERT_BIN" ]; then
    ok "mkcert already installed: $($MKCERT_BIN --version)"
else
    ARCH=$(uname -m)
    case $ARCH in
        aarch64) MKCERT_ARCH="linux-arm64" ;;
        armv7l)  MKCERT_ARCH="linux-arm"   ;;
        x86_64)  MKCERT_ARCH="linux-amd64" ;;
        *)
            echo "Unsupported architecture: $ARCH"
            exit 1 ;;
    esac

    info "Downloading mkcert for $MKCERT_ARCH …"
    LATEST=$(curl -s https://api.github.com/repos/FiloSottile/mkcert/releases/latest \
             | grep '"tag_name"' | head -1 | cut -d'"' -f4)
    LATEST=${LATEST:-v1.4.4}   # fallback if GitHub API is rate-limited
    curl -fsSL \
      "https://github.com/FiloSottile/mkcert/releases/download/${LATEST}/mkcert-${LATEST}-${MKCERT_ARCH}" \
      -o "$MKCERT_BIN"
    chmod +x "$MKCERT_BIN"
    ok "mkcert $LATEST installed"
fi

# ─────────────────────────────────────────────────────────────────────────────
step "3 — Install local Certificate Authority"
# Run as the service user so CAROOT lands in their home dir
sudo -u "$SVC_USER" "$MKCERT_BIN" -install
CAROOT=$(sudo -u "$SVC_USER" "$MKCERT_BIN" -CAROOT)
ok "CA root: $CAROOT"

# ─────────────────────────────────────────────────────────────────────────────
step "4 — Generate TLS certificate"
mkdir -p "$CERT_DIR"
chown "$SVC_USER":"$SVC_USER" "$CERT_DIR"

# Use only mDNS hostnames — no IP address in the cert.
# The Pi's LAN IP changes with DHCP; hostname.local (Avahi/mDNS) is stable.
HOSTNAME_SHORT=$(hostname)

info "Generating cert for: ${HOSTNAME_SHORT}.local, localhost, 127.0.0.1, 10.10.10.1"

sudo -u "$SVC_USER" "$MKCERT_BIN" \
    -cert-file "$CERT_DIR/cert.pem" \
    -key-file  "$CERT_DIR/key.pem" \
    "${HOSTNAME_SHORT}.local" \
    localhost \
    127.0.0.1 \
    10.10.10.1

chown "$SVC_USER":"$SVC_USER" "$CERT_DIR"/*.pem
chmod 600 "$CERT_DIR/key.pem"
ok "Certificate written to $CERT_DIR/"

# ─────────────────────────────────────────────────────────────────────────────
step "5 — Export CA cert for device installation"
cp "$CAROOT/rootCA.pem" "$CERT_DIR/mixpi-ca.crt"
# Also make available from the web root so iOS can fetch it over HTTP
cp "$CERT_DIR/mixpi-ca.crt" "$STATIC_DIR/mixpi-ca.crt"
chown "$SVC_USER":"$SVC_USER" "$CERT_DIR/mixpi-ca.crt" "$STATIC_DIR/mixpi-ca.crt"
ok "CA cert copied to $STATIC_DIR/mixpi-ca.crt"

# ─────────────────────────────────────────────────────────────────────────────
echo
echo "=================================================="
echo "  NEXT STEPS — Install CA on every device"
echo "=================================================="
echo
echo "  The service is still running on HTTP."
echo "  Install the CA certificate on each device BEFORE"
echo "  restarting to HTTPS (one-time per device):"
echo
echo "  ┌─ iPhone / iPad ─────────────────────────────────────────┐"
echo "  │  1. Open Safari and go to:                              │"
echo "  │     http://${HOSTNAME_SHORT}.local:5000/mixpi-ca.crt          │"
echo "  │  2. Settings → 'Profile Downloaded' → Install           │"
echo "  │  3. Settings → General → About →                        │"
echo "  │        Certificate Trust Settings →                     │"
echo "  │        enable 'mkcert …' toggle                         │"
echo "  └─────────────────────────────────────────────────────────┘"
echo
echo "  ┌─ Mac ───────────────────────────────────────────────────┐"
echo "  │  Keychain Access already trusts it (mkcert -install)   │"
echo "  │  OR: http://${HOSTNAME_SHORT}.local:5000/mixpi-ca.crt         │"
echo "  │      double-click → Keychain Access → Trust → Always   │"
echo "  └─────────────────────────────────────────────────────────┘"
echo
echo "  CA cert also saved at:"
echo "  $CERT_DIR/mixpi-ca.crt"
echo

# ─────────────────────────────────────────────────────────────────────────────
if [ "$AUTO" = "1" ]; then
    CONFIRM="y"
else
    read -rp "Have you installed the CA on all devices? Restart to HTTPS now? [y/N] " CONFIRM
fi

if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
    systemctl restart "$SERVICE" || true
    sleep 2
    if systemctl is-active --quiet "$SERVICE"; then
        echo
        ok "Service restarted — now serving HTTPS"
        echo
        echo "  Open https://${HOSTNAME_SHORT}.local:5000 in Safari"
        echo "  AirDrop share from the Recordings tab will now work directly."
        echo
    else
        warn "Service not yet active — will start once config is ready"
        echo "  Check: journalctl -u $SERVICE -n 30"
    fi
else
    echo
    warn "Service NOT restarted yet."
    echo "  When ready, run:  sudo systemctl restart $SERVICE"
    echo
fi
