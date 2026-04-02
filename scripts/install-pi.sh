#!/bin/bash
# =============================================================================
#  MixPi — Pi-Direct Installer
#
#  Run this ON the Raspberry Pi (as the normal user, not root):
#
#    curl -fsSL https://raw.githubusercontent.com/KamalDasu/mixpi/main/scripts/install-pi.sh | bash
#
#  Or after cloning:
#    bash /opt/mixpi/scripts/install-pi.sh
#
#  What it does:
#    1. Installs all system packages (git, python3, ffmpeg, mkcert, etc.)
#    2. Clones the repo to /opt/mixpi
#    3. Creates Python venv and installs dependencies
#    4. Installs systemd service (auto-start on boot)
#    5. Sets up WiFi Access Point: mixpi-1 / mixpi123
#    6. Generates HTTPS certificate (hostname.local + 10.10.10.1)
#    7. Applies Pi optimisations (CPU governor, ALSA, audio priorities)
#    8. Starts the mixpi-recorder service
#
#  Optional environment variables:
#    AP_SSID=mixpi-1          WiFi network name  (default: mixpi-1)
#    AP_PASSWORD=mixpi123     WiFi password      (default: mixpi123)
#    SKIP_AP=1                Skip WiFi AP setup
#    SKIP_HTTPS=1             Skip HTTPS cert
#    SKIP_OPTIMIZE=1          Skip Pi optimisations
# =============================================================================

set -euo pipefail

REPO_URL="https://github.com/KamalDasu/mixpi.git"
INSTALL_DIR="/opt/mixpi"
SERVICE="mixpi-recorder"
AP_SSID="${AP_SSID:-mixpi-1}"
AP_PASSWORD="${AP_PASSWORD:-mixpi123}"
SKIP_AP="${SKIP_AP:-0}"
SKIP_HTTPS="${SKIP_HTTPS:-1}"
SKIP_OPTIMIZE="${SKIP_OPTIMIZE:-0}"
HOSTNAME_LOCAL="$(hostname).local"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; NC='\033[0m'; BOLD='\033[1m'

ok()   { echo -e "${GREEN}  ✓  $*${NC}"; }
info() { echo -e "${CYAN}  →  $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠  $*${NC}"; }
err()  { echo -e "${RED}  ✗  $*${NC}"; exit 1; }
hdr()  { echo -e "\n${BOLD}${CYAN}══ $* ══${NC}"; }

# Must NOT be run as root directly — we use sudo internally
if [ "$EUID" -eq 0 ]; then
    err "Run as your normal user (music / pi), not as root.\n  bash install-pi.sh"
fi

SVC_USER="$(whoami)"

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║      MixPi — Raspberry Pi Installer      ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Install dir : ${CYAN}$INSTALL_DIR${NC}"
echo -e "  Service user: ${CYAN}$SVC_USER${NC}"
echo -e "  WiFi AP     : $([ "$SKIP_AP" = "1" ] && echo 'skip' || echo "${CYAN}$AP_SSID${NC}")"
echo -e "  HTTPS       : $([ "$SKIP_HTTPS" = "1" ] && echo 'skip' || echo "${CYAN}enabled${NC}")"
echo ""

# ── Step 1 — System packages ─────────────────────────────────────────────────
hdr "Step 1 — Installing system packages"
info "Running apt update..."
sudo apt-get update -qq
info "Installing packages (this may take a few minutes)..."
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    python3 python3-pip python3-venv python3-dev \
    python3-numpy python3-psutil python3-yaml python3-flask \
    gcc build-essential \
    libasound2-dev libportaudio2 portaudio19-dev libsndfile1 alsa-utils \
    avahi-daemon mkcert \
    git exfatprogs dosfstools hfsprogs udisks2 \
    ffmpeg
ok "System packages installed"

# ── Step 2 — Clone or update repo ────────────────────────────────────────────
hdr "Step 2 — Installing MixPi application"
if [ ! -d "$INSTALL_DIR/.git" ]; then
    info "Cloning repository to $INSTALL_DIR..."
    sudo git clone "$REPO_URL" "$INSTALL_DIR"
    sudo chown -R "$SVC_USER":"$SVC_USER" "$INSTALL_DIR"
else
    info "Updating existing install at $INSTALL_DIR..."
    sudo chown -R "$SVC_USER":"$SVC_USER" "$INSTALL_DIR"
    git -C "$INSTALL_DIR" pull origin main
fi
ok "Code at $INSTALL_DIR"

# ── Step 3 — Python venv ─────────────────────────────────────────────────────
info "Setting up Python virtual environment..."
[ ! -d "$INSTALL_DIR/venv" ] && python3 -m venv --system-site-packages "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --upgrade pip --quiet
"$INSTALL_DIR/venv/bin/pip" install -r "$INSTALL_DIR/requirements.txt" --quiet
ok "Python dependencies installed"

# ── Step 4 — Config ───────────────────────────────────────────────────────────
if [ ! -f "$INSTALL_DIR/config.yaml" ]; then
    cp "$INSTALL_DIR/config.yaml.example" "$INSTALL_DIR/config.yaml"
    # Update default storage path to match the actual user
    sed -i "s|/media/pi/MIXPI|/home/${SVC_USER}/recordings|g" "$INSTALL_DIR/config.yaml"
    ok "config.yaml created"
else
    ok "config.yaml already present — keeping existing"
fi
mkdir -p "/home/${SVC_USER}/recordings"
chown -R "$SVC_USER":"$SVC_USER" "/home/${SVC_USER}/recordings"

# ── Step 5 — Sudoers ──────────────────────────────────────────────────────────
info "Configuring sudoers for system and storage commands..."
sudo tee /etc/sudoers.d/mixpi-system > /dev/null <<EOF
${SVC_USER} ALL=(ALL) NOPASSWD: /usr/bin/umount, /usr/sbin/mkfs.exfat, /usr/sbin/mkfs.ext4, /usr/sbin/mkfs.hfsplus, /usr/sbin/mkfs.vfat, /usr/bin/udisksctl, /usr/bin/systemctl restart mixpi-recorder, /usr/bin/bash /opt/mixpi/scripts/setup_https.sh *, /usr/bin/rm -f /opt/mixpi/certs/*, /usr/sbin/reboot
EOF
sudo chmod 440 /etc/sudoers.d/mixpi-system
ok "Sudoers configured"

# ── Step 6 — Systemd service ──────────────────────────────────────────────────
hdr "Step 3 — Installing systemd service"
sudo cp "$INSTALL_DIR/systemd/mixpi-recorder.service" /etc/systemd/system/
sudo sed -i "s/^User=.*/User=${SVC_USER}/" /etc/systemd/system/mixpi-recorder.service
sudo sed -i "s/^Group=.*/Group=${SVC_USER}/" /etc/systemd/system/mixpi-recorder.service
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE"
ok "Service enabled (will auto-start on boot)"

# ── Step 7 — Avahi mDNS ───────────────────────────────────────────────────────
info "Configuring mDNS (${HOSTNAME_LOCAL})..."
sudo tee /etc/avahi/services/mixpi.service > /dev/null <<AVAHI
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">MixPi Recorder on %h</name>
  <service>
    <type>_http._tcp</type>
    <port>5000</port>
    <txt-record>path=/</txt-record>
  </service>
</service-group>
AVAHI
sudo systemctl restart avahi-daemon
ok "${HOSTNAME_LOCAL} mDNS configured"

# ── Step 8 — WiFi AP ──────────────────────────────────────────────────────────
if [ "$SKIP_AP" != "1" ]; then
    hdr "Step 4 — Setting up WiFi Access Point"
    AP_SSID="$AP_SSID" AP_PASSWORD="$AP_PASSWORD" \
        sudo -E bash "$INSTALL_DIR/scripts/setup_ap.sh"
    ok "WiFi AP '$AP_SSID' ready"
else
    warn "Skipping WiFi AP setup (SKIP_AP=1)"
fi

# ── Step 9 — HTTPS cert ───────────────────────────────────────────────────────
if [ "$SKIP_HTTPS" != "1" ]; then
    hdr "Step 5 — Generating HTTPS certificate"
    sudo bash "$INSTALL_DIR/scripts/setup_https.sh" --auto
    ok "HTTPS certificate ready"
else
    warn "Skipping HTTPS (SKIP_HTTPS=1)"
fi

# ── Step 10 — Pi optimisations ────────────────────────────────────────────────
if [ "$SKIP_OPTIMIZE" != "1" ]; then
    hdr "Step 6 — Applying Pi optimisations"
    sudo bash "$INSTALL_DIR/scripts/setup_pi.sh"
    ok "Pi optimised"
else
    warn "Skipping Pi optimisations (SKIP_OPTIMIZE=1)"
fi

# ── Step 11 — Start service ───────────────────────────────────────────────────
hdr "Step 7 — Starting MixPi service"
sudo systemctl restart "$SERVICE"
sleep 4
if systemctl is-active --quiet "$SERVICE"; then
    ok "mixpi-recorder is running"
else
    warn "Service may need a moment — check: journalctl -u $SERVICE -n 20"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║       MixPi Setup Complete!  ✓           ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Web UI   : ${CYAN}http://${HOSTNAME_LOCAL}:5000${NC}"
echo -e "             ${CYAN}http://10.10.10.1:5000${NC}  (via $AP_SSID WiFi)"
echo ""
if [ "$SKIP_HTTPS" = "1" ]; then
    echo -e "  HTTPS    : ${YELLOW}Disabled${NC} (AirDrop/Web Share will not work)"
    echo -e "             To enable: ${CYAN}sudo bash $INSTALL_DIR/scripts/setup_https.sh${NC}"
else
    echo -e "  HTTPS    : ${CYAN}https://${HOSTNAME_LOCAL}:5000${NC} (AirDrop ready)"
    echo -e "  CA cert  : ${CYAN}http://${HOSTNAME_LOCAL}:5000/install-ca${NC}  ← open on each device"
fi
echo ""
echo -e "  WiFi     : ${CYAN}$AP_SSID${NC}  /  password: ${CYAN}$AP_PASSWORD${NC}"
echo -e "  SSH      : ${CYAN}ssh ${SVC_USER}@${HOSTNAME_LOCAL}${NC}"
echo ""
echo -e "  Logs     : ${CYAN}journalctl -u mixpi-recorder -f${NC}"
echo -e "  Config   : ${CYAN}nano $INSTALL_DIR/config.yaml${NC}"
echo ""
echo -e "${YELLOW}  Reboot recommended for all optimisations to take effect:${NC}"
echo -e "  ${CYAN}sudo reboot${NC}"
echo ""
