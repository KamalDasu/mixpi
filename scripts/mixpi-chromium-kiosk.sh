#!/bin/bash
# MixPi — launch a browser fullscreen (kiosk) for the MixPi web UI.
# Installed to ~/.local/bin/mixpi-chromium-kiosk.sh by setup-touchscreen-kiosk.sh.
#
# Optional: ~/.config/mixpi-kiosk.env
#   MIXPI_KIOSK_URL=http://127.0.0.1:5000
#   MIXPI_KIOSK_ENGINE=chromium   # or: firefox  (often fewer keyring/GPU issues on Pi)
#   MIXPI_CHROMIUM_BIN=/path/to/chromium   # optional override

set -euo pipefail

[ -f "${HOME}/.config/mixpi-kiosk.env" ] && . "${HOME}/.config/mixpi-kiosk.env"

URL="${MIXPI_KIOSK_URL:-http://localhost:5000}"
ENGINE="${MIXPI_KIOSK_ENGINE:-chromium}"

# ── Firefox / Firefox ESR — no Chromium keyring; different GPU path ─────────
if [ "$ENGINE" = "firefox" ] || [ "$ENGINE" = "firefox-esr" ]; then
  _ff=""
  for candidate in firefox firefox-esr; do
    if command -v "$candidate" >/dev/null 2>&1; then
      _ff="$candidate"
      break
    fi
  done
  if [ -z "$_ff" ]; then
    echo "mixpi-kiosk: no firefox or firefox-esr in PATH (sudo apt install firefox-esr)" >&2
    exit 1
  fi
  exec "$_ff" --kiosk "$URL"
fi

# ── Chromium (default) ─────────────────────────────────────────────────────
_chrome=""
for candidate in "${MIXPI_CHROMIUM_BIN:-}" \
    /usr/lib/chromium/chromium \
    /usr/lib/chromium-browser/chromium-browser; do
  [ -z "$candidate" ] && continue
  if [ -x "$candidate" ]; then
    _chrome="$candidate"
    break
  fi
done
if [ -z "$_chrome" ]; then
  if command -v chromium >/dev/null 2>&1; then
    _chrome="$(command -v chromium)"
  elif command -v chromium-browser >/dev/null 2>&1; then
    _chrome="$(command -v chromium-browser)"
  fi
fi
if [ -z "$_chrome" ]; then
  echo "mixpi-kiosk: no chromium binary found" >&2
  exit 1
fi

unset GNOME_KEYRING_PID 2>/dev/null || true
unset GNOME_KEYRING_CONTROL 2>/dev/null || true

# "basic" = plain file store — Pi OS Chromium 146+ rejects "none" (unknown password store).
exec "$_chrome" \
  --password-store=basic \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-restore-session-state \
  "$URL"
