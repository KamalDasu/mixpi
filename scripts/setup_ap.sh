#!/bin/bash
# =============================================================================
#  MixPi — WiFi Access Point setup
#
#  Turns wlan0 into a dedicated "mixpi-1" WiFi hotspot so the recorder
#  is always reachable at a fixed IP (192.168.4.1) regardless of venue WiFi.
#
#  Prerequisites: Raspberry Pi OS Bookworm / Debian 12+ with NetworkManager
#
#  Run on the Raspberry Pi:
#      sudo bash /opt/mixpi/scripts/setup_ap.sh
#
#  After running:
#    • Connect your iPad/laptop to WiFi network "mixpi-1"
#    • Open https://192.168.4.1:5000
# =============================================================================
set -euo pipefail

AP_SSID="${AP_SSID:-mixpi-1}"
AP_PASSWORD="${AP_PASSWORD:-mixpi123}"
AP_IP="10.10.10.1"
AP_IFACE="wlan0"
CON_NAME="MixPi-AP"
CERT_DIR="/opt/mixpi/certs"
SERVICE="mixpi-recorder.service"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}▶  $*${NC}"; }
ok()    { echo -e "${GREEN}✓  $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠  $*${NC}"; }

if [ "$EUID" -ne 0 ]; then
    echo "Please run with sudo:  sudo bash $0"
    exit 1
fi

# ── 1. Remove old AP profile if it exists ────────────────────────────────────
info "Removing any previous MixPi-AP profile…"
nmcli con delete "$CON_NAME" 2>/dev/null || true

# ── 2. Create the AP connection ───────────────────────────────────────────────
info "Creating WiFi access point: SSID=$AP_SSID  IP=$AP_IP"
nmcli con add \
    type wifi \
    ifname "$AP_IFACE" \
    con-name "$CON_NAME" \
    autoconnect yes \
    ssid "$AP_SSID" \
    mode ap \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.proto rsn \
    wifi-sec.pairwise ccmp \
    wifi-sec.group ccmp \
    wifi-sec.psk "$AP_PASSWORD" \
    ipv4.method shared \
    ipv4.addresses "${AP_IP}/24" \
    ipv6.method disabled
ok "Connection profile created"

# ── 3. Activate the AP (disconnects any current WiFi client connection) ───────
info "Activating AP on $AP_IFACE…"
nmcli con up "$CON_NAME"
ok "AP is up — SSID: $AP_SSID  IP: $AP_IP"

# ── 4. Note on HTTPS cert ─────────────────────────────────────────────────────
# The HTTPS cert (including AP IP 10.10.10.1) is managed by setup_https.sh.
# If setup_https.sh has already been run, the cert is already valid for this IP.
if [ -f "$CERT_DIR/cert.pem" ]; then
    ok "HTTPS cert already present at $CERT_DIR"
else
    warn "HTTPS cert not found — run setup_https.sh to generate it"
fi

# ── 5. Restart the recorder service ──────────────────────────────────────────
info "Restarting MixPi service…"
systemctl restart "$SERVICE"
sleep 2
systemctl is-active "$SERVICE" && ok "Service running" || warn "Service may have failed — check: journalctl -u $SERVICE"

# ── Done ─────────────────────────────────────────────────────────────────────
echo
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo -e "${GREEN}  MixPi Access Point ready!${NC}"
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo -e "  WiFi SSID    : ${CYAN}${AP_SSID}${NC}"
echo -e "  WiFi password: ${CYAN}${AP_PASSWORD}${NC}"
echo -e "  Web UI       : ${CYAN}https://${AP_IP}:5000${NC}"
echo
echo -e "  First visit on iPad:"
echo -e "  1. Join WiFi '${AP_SSID}'"
echo -e "  2. Open Safari → https://${AP_IP}:5000/install-ca"
echo -e "  3. Install the profile (Settings → VPN & Device Management)"
echo -e "  4. Trust the CA (Settings → About → Certificate Trust Settings)"
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo
warn "Ethernet (eth0) stays connected for SSH/internet access."
warn "To customise SSID/password, run:"
warn "  AP_SSID='YourName' AP_PASSWORD='YourPass' sudo bash $0"
