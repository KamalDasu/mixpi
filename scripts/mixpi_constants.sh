# shellcheck shell=bash
# =============================================================================
#  MixPi — shared identifiers for install / AP / uninstall
#
#  Why not derive these at uninstall time?
#  • systemd, sudoers, Avahi, and NetworkManager store configs under fixed paths
#    and names chosen when MixPi was installed.
#  • The WiFi *SSID* is dynamic (<hostname>-ap-<MAC4>), but NetworkManager’s
#    *connection profile name* (con-name) is still MIXPI_NM_CON_NAME — clients
#    see SSID; nmcli deletes by profile name.
#  • Legacy entries cover renames from older installer versions.
#
#  Source from scripts in this directory:
#    . "$(dirname "${BASH_SOURCE[0]}")/mixpi_constants.sh"
# =============================================================================

# NetworkManager: profile created by setup_ap.sh (nmcli con-name …)
export MIXPI_NM_CON_NAME="${MIXPI_NM_CON_NAME:-MixPi-AP}"

# Older installs may have left a connection literally named after the old SSID
export MIXPI_NM_LEGACY_CON_NAMES="${MIXPI_NM_LEGACY_CON_NAMES:-mixpi-1}"

export MIXPI_SYSTEMD_SERVICE="${MIXPI_SYSTEMD_SERVICE:-mixpi-recorder.service}"

# Avahi service filename under /etc/avahi/services/
export MIXPI_AVAHI_SERVICE_FILE="${MIXPI_AVAHI_SERVICE_FILE:-mixpi.service}"

# sudoers drop-ins under /etc/sudoers.d/ (basename only)
export MIXPI_SUDOERS_BASES="${MIXPI_SUDOERS_BASES:-mixpi-system mixpi-storage}"
