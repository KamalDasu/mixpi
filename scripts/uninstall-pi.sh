#!/bin/bash
# =============================================================================
#  MixPi — Pi-Direct Uninstaller
#
#  Run this ON the Raspberry Pi to completely remove the MixPi application
#  and revert system configurations (WiFi AP, mDNS, systemd service, etc.).
#
#    sudo bash /opt/mixpi/scripts/uninstall-pi.sh
#
# =============================================================================

set -euo pipefail

_UNINSTALL_SCR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$_UNINSTALL_SCR/mixpi_constants.sh" ]; then
    # shellcheck source=mixpi_constants.sh
    . "$_UNINSTALL_SCR/mixpi_constants.sh"
fi
: "${MIXPI_NM_CON_NAME:=MixPi-AP}"
: "${MIXPI_NM_LEGACY_CON_NAMES:=mixpi-1}"
: "${MIXPI_SYSTEMD_SERVICE:=mixpi-recorder.service}"
: "${MIXPI_AVAHI_SERVICE_FILE:=mixpi.service}"
: "${MIXPI_SUDOERS_BASES:=mixpi-system mixpi-storage}"
MIXPI_SVC="${MIXPI_SYSTEMD_SERVICE%.service}"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; NC='\033[0m'; BOLD='\033[1m'

ok()   { echo -e "${GREEN}  ✓  $*${NC}"; }
info() { echo -e "${CYAN}  →  $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠  $*${NC}"; }
err()  { echo -e "${RED}  ✗  $*${NC}"; exit 1; }
hdr()  { echo -e "\n${BOLD}${CYAN}══ $* ══${NC}"; }

if [ "$EUID" -ne 0 ]; then
    err "Please run as root: sudo bash $0"
fi

echo ""
echo -e "${BOLD}${RED}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${RED}║      MixPi — Raspberry Pi Uninstaller    ║${NC}"
echo -e "${BOLD}${RED}╚══════════════════════════════════════════╝${NC}"
echo ""

read -rp "Are you sure you want to completely remove MixPi? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    info "Uninstall cancelled."
    exit 0
fi

# 1. Stop and disable service (unit name from mixpi_constants.sh)
hdr "Removing systemd service"
if systemctl is-active --quiet "$MIXPI_SVC" || systemctl is-enabled --quiet "$MIXPI_SVC"; then
    systemctl stop "$MIXPI_SVC" 2>/dev/null || true
    systemctl disable "$MIXPI_SVC" 2>/dev/null || true
    rm -f "/etc/systemd/system/$MIXPI_SYSTEMD_SERVICE"
    systemctl daemon-reload
    ok "$MIXPI_SVC service removed"
else
    info "Service not found or already removed"
fi

# 2. Remove WiFi AP (NM profile name is fixed; SSID shown to users is separate)
hdr "Removing WiFi Access Point"
if command -v nmcli &>/dev/null; then
    REMOVED_AP=0
    # shellcheck disable=SC2086
    for con in "$MIXPI_NM_CON_NAME" $MIXPI_NM_LEGACY_CON_NAMES; do
        nmcli connection delete "$con" &>/dev/null && REMOVED_AP=1 || true
    done
    if [ "$REMOVED_AP" -eq 1 ]; then
        ok "WiFi AP connection removed"
    else
        info "MixPi WiFi AP connection not found"
    fi
else
    info "nmcli not found — skipping AP removal"
fi

# 3. Remove mDNS
hdr "Removing mDNS configuration"
AVAHI_MIXPI="/etc/avahi/services/$MIXPI_AVAHI_SERVICE_FILE"
if [ -f "$AVAHI_MIXPI" ]; then
    rm -f "$AVAHI_MIXPI"
    systemctl restart avahi-daemon 2>/dev/null || true
    ok "mDNS configuration removed"
else
    info "mDNS config not found"
fi

# 4. Remove Sudoers (basenames listed in mixpi_constants.sh)
hdr "Removing sudoers configuration"
REMOVED=0
for base in $MIXPI_SUDOERS_BASES; do
    f="/etc/sudoers.d/$base"
    if [ -f "$f" ]; then
        rm -f "$f"
        REMOVED=1
    fi
done
if [ "$REMOVED" -eq 1 ]; then
    ok "Sudoers config removed"
else
    info "Sudoers config not found"
fi

# 5. Revert Pi Optimisations
hdr "Reverting system optimisations"
if [ -f /etc/modprobe.d/mixpi-alsa.conf ]; then
    rm -f /etc/modprobe.d/mixpi-alsa.conf
    ok "ALSA USB audio config removed"
fi

if [ -f /etc/security/limits.d/audio.conf ]; then
    rm -f /etc/security/limits.d/audio.conf
    ok "RT audio priorities removed"
fi

if [ -f /etc/rc.local ]; then
    sed -i '/scaling_governor/d' /etc/rc.local
    ok "CPU governor override removed from rc.local"
fi

if command -v dphys-swapfile &>/dev/null && grep -q '^CONF_SWAPSIZE=1024' /etc/dphys-swapfile; then
    dphys-swapfile swapoff 2>/dev/null || true
    sed -i 's/^CONF_SWAPSIZE=1024/CONF_SWAPSIZE=100/' /etc/dphys-swapfile
    dphys-swapfile setup >/dev/null 2>&1 || true
    dphys-swapfile swapon >/dev/null 2>&1 || true
    ok "Swap size reverted to 100MB"
fi

# 6. Remove Application Directory
hdr "Removing application files"
if [ -d /opt/mixpi ]; then
    rm -rf /opt/mixpi
    ok "/opt/mixpi directory removed"
else
    info "/opt/mixpi not found"
fi

# 7. Remove User Recordings Directory (Optional)
hdr "Removing recordings directory"
SVC_USER="${SUDO_USER:-pi}"
if [ -d "/home/${SVC_USER}/recordings" ]; then
    read -rp "Do you also want to delete all recordings in /home/${SVC_USER}/recordings? [y/N] " DEL_REC
    if [[ "$DEL_REC" =~ ^[Yy]$ ]]; then
        rm -rf "/home/${SVC_USER}/recordings"
        ok "Recordings directory removed"
    else
        info "Recordings directory kept"
    fi
else
    info "Recordings directory not found"
fi

# 8. Remove mkcert CA (optional but thorough)
hdr "Removing local Certificate Authority"
if command -v mkcert &>/dev/null; then
    # We need to find the user who ran the install, or just clean the root CA
    # Since mkcert was run as the service user, we'll try to uninstall it for them
    SVC_USER="${SUDO_USER:-pi}"
    sudo -u "$SVC_USER" mkcert -uninstall 2>/dev/null || true
    ok "mkcert CA uninstalled from system trust"
else
    info "mkcert not found, skipping CA removal"
fi

echo ""
ok "MixPi has been completely uninstalled."
echo -e "  ${YELLOW}Note: System packages (ffmpeg, python3, etc.) were left installed.${NC}"
echo -e "  ${YELLOW}A reboot is recommended to clear audio and CPU states.${NC}"
echo ""