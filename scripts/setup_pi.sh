#!/bin/bash
# Raspberry Pi System Optimisation for MixPi Recorder
# Designed for Raspberry Pi OS Bookworm (Debian 12)

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓  $*${NC}"; }
info() { echo -e "${CYAN}  →  $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠  $*${NC}"; }

if [ "$EUID" -ne 0 ]; then
    echo "Please run as root (use sudo)"
    exit 1
fi

if [ -n "${SUDO_USER:-}" ]; then
    SVC_USER="$SUDO_USER"
else
    SVC_USER="$(whoami)"
fi

echo ""
echo "=========================================="
echo "  Raspberry Pi System Optimisation"
echo "=========================================="
echo ""

# ── CPU governor ──────────────────────────────────────────────────────────────
info "Setting CPU governor to performance..."
if ls /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor &>/dev/null; then
    echo performance | tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor > /dev/null
    # Persist across reboots via rc.local if it exists
    if [ -f /etc/rc.local ]; then
        grep -q 'scaling_governor' /etc/rc.local || \
            sed -i '/^exit 0/i echo performance | tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor > /dev/null' /etc/rc.local
    fi
    ok "CPU governor set to performance"
else
    warn "CPU frequency scaling not available — skipping"
fi

# ── ALSA / USB audio ──────────────────────────────────────────────────────────
info "Configuring ALSA for low-latency USB audio..."
cat > /etc/modprobe.d/mixpi-alsa.conf <<'EOF'
# MixPi — reduce USB audio interrupt packing for lower latency
options snd-usb-audio nrpacks=1
EOF
ok "ALSA USB audio configured"

# ── Audio group permissions ───────────────────────────────────────────────────
info "Adding $SVC_USER to audio group..."
usermod -a -G audio "$SVC_USER" && ok "$SVC_USER added to audio group" || warn "Could not add $SVC_USER to audio group"

# ── Swap ──────────────────────────────────────────────────────────────────────
info "Increasing swap to 1 GB..."
if command -v dphys-swapfile &>/dev/null; then
    dphys-swapfile swapoff 2>/dev/null || true
    sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
    dphys-swapfile setup
    dphys-swapfile swapon
    ok "Swap set to 1 GB"
else
    warn "dphys-swapfile not found — skipping swap config"
fi

# ── Real-time audio priorities ────────────────────────────────────────────────
info "Setting real-time audio priorities..."
cat > /etc/security/limits.d/audio.conf <<'EOF'
@audio   -  rtprio     95
@audio   -  memlock    unlimited
@audio   -  nice      -19
EOF
ok "RT audio priorities configured"

# ── Disable unnecessary services ─────────────────────────────────────────────
info "Disabling unnecessary services..."
for svc in bluetooth hciuart triggerhappy; do
    systemctl disable "${svc}.service" 2>/dev/null && ok "Disabled ${svc}" || true
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "=========================================="
echo "  Optimisation Complete!"
echo "=========================================="
echo ""
echo "  Changes take full effect after a reboot."
echo "  sudo reboot"
echo ""
