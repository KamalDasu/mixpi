#!/bin/bash
# =============================================================================
# MixPi — Touchscreen kiosk (Chromium fullscreen + cursor hide + no blanking)
#
# Run ON the Raspberry Pi as the user that logs into the desktop (e.g. pi):
#
#   bash /opt/mixpi/scripts/setup-touchscreen-kiosk.sh
#
# Or from a clone:
#   bash scripts/setup-touchscreen-kiosk.sh
#
# Does NOT install Waveshare/LCD drivers — configure DSI/HDMI per Waveshare wiki first.
# Does NOT install MixPi — use scripts/install-pi.sh for that.
#
# Environment (optional):
#   MIXPI_URL   URL for kiosk (default: http://localhost:5000)
#   MIXPI_KIOSK_ENGINE=firefox   Use Firefox kiosk instead of Chromium (often fewer
#                                  keyring/GPU issues on Pi). Installs firefox-esr.
#   MIXPI_OSK=1 Install matchbox-keyboard and start it at login (X11 / LXDE).
#
# Launcher: ~/.local/bin/mixpi-chromium-kiosk.sh (Chromium or Firefox per env).
# The web UI also ships /manifest.json so Chromium/Edge can “Install” MixPi as a PWA.
# =============================================================================

set -euo pipefail

MIXPI_URL="${MIXPI_URL:-http://localhost:5000}"
MIXPI_KIOSK_ENGINE="${MIXPI_KIOSK_ENGINE:-chromium}"
MIXPI_OSK="${MIXPI_OSK:-0}"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓  $*${NC}"; }
info() { echo -e "${CYAN}  →  $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠  $*${NC}"; }

# Desktop user whose $HOME gets autostart files
if [ -n "${SUDO_USER:-}" ] && [ "${EUID:-$(id -u)}" -eq 0 ]; then
  CFG_USER="$SUDO_USER"
elif [ "${EUID:-$(id -u)}" -eq 0 ]; then
  echo "Run this script as your normal desktop user, or use: sudo -u pi bash $0"
  exit 1
else
  CFG_USER="$USER"
fi

CFG_HOME="$(getent passwd "$CFG_USER" | cut -d: -f6)"
if [ -z "$CFG_HOME" ] || [ ! -d "$CFG_HOME" ]; then
  echo "Cannot resolve home directory for user: $CFG_USER"
  exit 1
fi

append_line_once() {
  local f="$1"
  local line="$2"
  mkdir -p "$(dirname "$f")"
  touch "$f"
  grep -Fxq "$line" "$f" 2>/dev/null || echo "$line" >> "$f"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIOSK_LAUNCHER_SRC="$SCRIPT_DIR/mixpi-chromium-kiosk.sh"
KIOSK_LAUNCHER="$CFG_HOME/.local/bin/mixpi-chromium-kiosk.sh"

echo ""
echo "=========================================="
echo "  MixPi — Touchscreen kiosk setup"
echo "  User: $CFG_USER  Home: $CFG_HOME"
echo "=========================================="
echo ""

info "Installing packages (apt)..."
sudo apt-get update -qq
sudo apt-get install -y unclutter x11-xserver-utils xinput-calibrator

if [ "$MIXPI_KIOSK_ENGINE" = "firefox" ] || [ "$MIXPI_KIOSK_ENGINE" = "firefox-esr" ]; then
  info "Installing Firefox ESR (kiosk engine)…"
  sudo apt-get install -y firefox-esr
  ok "Firefox ESR is available"
else
  if ! sudo apt-get install -y chromium-browser; then
    sudo apt-get install -y chromium
  fi
  if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1 \
      && [ ! -x /usr/lib/chromium/chromium ]; then
    warn "Chromium not found — install chromium package, then re-run this script"
  else
    ok "Chromium is available"
  fi
fi

mkdir -p "$CFG_HOME/.local/bin" "$CFG_HOME/.config"
if [ ! -f "$KIOSK_LAUNCHER_SRC" ]; then
  echo "Missing $KIOSK_LAUNCHER_SRC — sync mixpi to this machine or use the full repo." >&2
  exit 1
fi
install -m 0755 "$KIOSK_LAUNCHER_SRC" "$KIOSK_LAUNCHER"
chown "$CFG_USER:$CFG_USER" "$KIOSK_LAUNCHER" 2>/dev/null || true
ok "Installed kiosk launcher: $KIOSK_LAUNCHER"

# URL + engine for the launcher (edit ~/.config/mixpi-kiosk.env to change later)
info "Writing $CFG_HOME/.config/mixpi-kiosk.env ..."
{
  echo "MIXPI_KIOSK_URL=$MIXPI_URL"
  echo "MIXPI_KIOSK_ENGINE=$MIXPI_KIOSK_ENGINE"
} > "$CFG_HOME/.config/mixpi-kiosk.env"
chown "$CFG_USER:$CFG_USER" "$CFG_HOME/.config/mixpi-kiosk.env" 2>/dev/null || true

AUTOSTART_DIR="$CFG_HOME/.config/autostart"
DESKTOP_FILE="$AUTOSTART_DIR/mixpi-browser.desktop"
LXDE_AUTOSTART="$CFG_HOME/.config/lxsession/LXDE-pi/autostart"

info "Writing $DESKTOP_FILE ..."
mkdir -p "$AUTOSTART_DIR"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=MixPi Browser
Exec=$KIOSK_LAUNCHER
X-GNOME-Autostart-enabled=true
EOF
chown "$CFG_USER:$CFG_USER" "$DESKTOP_FILE" 2>/dev/null || true
ok "Kiosk autostart installed"

info "Ensuring LXDE session extras (cursor hide, no blanking)..."
append_line_once "$LXDE_AUTOSTART" "@unclutter -idle 0.1 -root"
append_line_once "$LXDE_AUTOSTART" "@xset s off"
append_line_once "$LXDE_AUTOSTART" "@xset -dpms"
append_line_once "$LXDE_AUTOSTART" "@xset s noblank"
chown "$CFG_USER:$CFG_USER" "$LXDE_AUTOSTART" 2>/dev/null || true
ok "LXDE autostart updated ($LXDE_AUTOSTART)"

if [ "$MIXPI_OSK" = "1" ]; then
  info "Installing on-screen keyboard (matchbox-keyboard)..."
  if sudo apt-get install -y matchbox-keyboard; then
    append_line_once "$LXDE_AUTOSTART" "@matchbox-keyboard"
    chown "$CFG_USER:$CFG_USER" "$LXDE_AUTOSTART" 2>/dev/null || true
    ok "matchbox-keyboard added to LXDE autostart (remove that line to disable)"
  else
    warn "Could not install matchbox-keyboard — use the desktop environment’s on-screen keyboard"
  fi
fi

echo ""
ok "Done."
info "DSI/HDMI drivers: follow Waveshare wiki for your panel before relying on this."
info "MixPi app: install with  bash scripts/install-pi.sh  (or curl installer) if needed."
info "Log out and back in, or reboot:  sudo reboot"
echo ""
