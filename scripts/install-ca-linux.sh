#!/bin/bash
# =============================================================================
#  MixPi — Install CA Certificate on Linux workstation
#
#  Installs the mkcert CA from the Pi into:
#    • Chrome / Chromium  (via ~/.pki/nssdb)
#    • Firefox            (via ~/.mozilla NSS databases)
#    • System trust store (curl, wget, Python requests, etc.)
#
#  Run from your workstation (not the Pi):
#    ./scripts/install-ca-linux.sh kdrums@192.168.1.91
#    ./scripts/install-ca-linux.sh kdrums@mixpi1.local
#
# =============================================================================
set -euo pipefail

PI_TARGET="${1:-}"
CA_NAME="MixPi Local CA"
CA_TMP="/tmp/mixpi-ca.crt"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'
ok()   { echo -e "${GREEN}  ✓  $*${NC}"; }
info() { echo -e "${CYAN}  →  $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠  $*${NC}"; }

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║    MixPi — Install CA on Linux  ✓        ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""

# Resolve Pi target with interactive prompt if not provided
if [ -z "$PI_TARGET" ]; then
    if [ -n "${PI_USER:-}" ] && [ -n "${PI_HOST:-}" ]; then
        PI_TARGET="${PI_USER}@${PI_HOST}"
    else
        echo -e "${YELLOW}No Pi target specified.${NC}"
        read -rp "Enter Pi target (user@host or IP, e.g. kdrums@192.168.1.91): " PI_TARGET
        if [ -z "$PI_TARGET" ]; then
            err "No target provided. Aborting."
        fi
    fi
fi

# ── 2. Download CA cert from Pi ───────────────────────────────────────────────
info "Downloading CA cert from $PI_TARGET..."
scp "$PI_TARGET:/opt/mixpi/certs/mixpi-ca.crt" "$CA_TMP"
ok "CA cert saved to $CA_TMP"

# ── 3. Install libnss3-tools if missing ───────────────────────────────────────
if ! command -v certutil &>/dev/null; then
    info "Installing libnss3-tools..."
    sudo apt-get install -y libnss3-tools -qq
    ok "libnss3-tools installed"
fi

# ── 4. Chrome / Chromium (NSS database) ──────────────────────────────────────
info "Installing into Chrome/Chromium NSS database..."
mkdir -p "$HOME/.pki/nssdb"
# Initialise the db if it's new
certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password 2>/dev/null || true
# Remove old cert if present, then add fresh
certutil -d "sql:$HOME/.pki/nssdb" -D -n "$CA_NAME" 2>/dev/null || true
certutil -d "sql:$HOME/.pki/nssdb" -A -t "CT,," -n "$CA_NAME" -i "$CA_TMP"
ok "Chrome/Chromium: CA trusted"

# ── 5. Firefox (finds all NSS profile databases) ──────────────────────────────
FF_ADDED=0
for ff_dir in \
    "$HOME/.mozilla/firefox/"*.default-release \
    "$HOME/.mozilla/firefox/"*.default \
    "$HOME/snap/firefox/common/.mozilla/firefox/"*.default-release; do
    if [ -d "$ff_dir" ]; then
        certutil -d "sql:$ff_dir" -D -n "$CA_NAME" 2>/dev/null || true
        certutil -d "sql:$ff_dir" -A -t "CT,," -n "$CA_NAME" -i "$CA_TMP"
        ok "Firefox ($(basename "$ff_dir")): CA trusted"
        FF_ADDED=1
    fi
done
[ "$FF_ADDED" -eq 0 ] && warn "No Firefox profile found — skipping"

# ── 6. System trust store ─────────────────────────────────────────────────────
info "Installing into system trust store..."
sudo cp "$CA_TMP" /usr/local/share/ca-certificates/mixpi-ca.crt
sudo update-ca-certificates --fresh 2>&1 | grep -E 'added|removed|updated' || true
ok "System trust store updated (curl, wget, Python requests, etc.)"

# ── Done ─────────────────────────────────────────────────────────────────────
PI_HOST_ONLY="${PI_TARGET##*@}"
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║       CA Certificate Installed!  ✓       ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${YELLOW}Restart Chrome/Firefox for changes to take effect.${NC}"
echo ""
echo -e "  Then open: ${CYAN}https://${PI_HOST_ONLY}:5000${NC}"
echo ""
