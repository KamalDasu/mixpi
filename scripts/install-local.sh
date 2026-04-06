#!/bin/bash
# MixPi Recorder - Local Development Installation Script
# For Ubuntu/Debian-based systems (development machines)

set -e

# Spinner while pip/venv runs
CYAN='\033[0;36m'
NC='\033[0m'
run_with_spinner() {
    local msg="$1"
    shift
    (
        local i=0
        local frames='|/-\'
        while true; do
            printf "\r  ${CYAN}%s${NC} %s" "${frames:i%4:1}" "$msg"
            sleep 0.12
            i=$((i + 1))
        done
    ) &
    local spid=$!
    set +e
    "$@"
    local rc=$?
    set -e
    kill "$spid" 2>/dev/null || true
    wait "$spid" 2>/dev/null || true
    printf "\r\033[K"
    if [ "$rc" -ne 0 ]; then
        return "$rc"
    fi
    return 0
}

_mixpi_use_piwheels_if_arm() {
    case "$(uname -m)" in
        aarch64 | armv7l | armv6l)
            export PIP_EXTRA_INDEX_URL="${PIP_EXTRA_INDEX_URL:-https://www.piwheels.org/simple}"
            echo "Using piwheels.org extra index (pre-built ARM wheels)."
            ;;
    esac
}

_mixpi_pip_install_requirements() {
    local pip="$1" req="$2" log="/tmp/mixpi-pip-install.log"
    export PIP_PROGRESS_BAR=off
    _mixpi_use_piwheels_if_arm
    rm -f "$log"
    if ! run_with_spinner "Installing Python packages (full log: $log)…" \
        bash -c '"$0" install -q --upgrade pip >>"$2" 2>&1 && "$0" install -r "$1" --prefer-binary -q >>"$2" 2>&1' \
        "$pip" "$req" "$log"; then
        echo "pip install failed. Last 50 lines of $log:" >&2
        tail -50 "$log" >&2 || true
        echo "Complete log: $log" >&2
        exit 1
    fi
    rm -f "$log"
}

echo "=========================================="
echo "MixPi Recorder - Local Installation"
echo "=========================================="
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo "Please run WITHOUT sudo (script will ask for sudo when needed)"
    exit 1
fi

INSTALL_DIR=$(pwd)

echo "Installing to: $INSTALL_DIR"
echo ""

# Update system
echo "Updating system packages..."
sudo apt-get update

# Install system dependencies
echo "Installing system dependencies..."
sudo apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    gcc \
    build-essential \
    libasound2-dev \
    libportaudio2 \
    portaudio19-dev \
    libsndfile1 \
    alsa-utils \
    git

echo ""
echo "System dependencies installed successfully!"
echo ""

# Create virtual environment if it doesn't exist (--system-site-packages: reuse
# apt-installed python3-* packages where compatible; pip still satisfies pins.)
if [ ! -d "venv" ]; then
    echo "Creating Python virtual environment..."
    run_with_spinner "Creating Python virtual environment..." \
        python3 -m venv --system-site-packages venv
else
    echo "Virtual environment already exists, skipping..."
fi

# Activate virtual environment and install Python dependencies
echo "Installing Python dependencies..."
# shellcheck source=/dev/null
source venv/bin/activate
PIP="$(command -v pip)"
REQ="$INSTALL_DIR/requirements.txt"
_mixpi_pip_install_requirements "$PIP" "$REQ"

echo ""
echo "Python dependencies installed successfully!"
echo ""

# Create config file if it doesn't exist
if [ ! -f "config.yaml" ]; then
    echo "Creating configuration file..."
    cp config.yaml.example config.yaml
    echo "Configuration file created: config.yaml"
    echo "Please edit config.yaml with your settings"
else
    echo "Configuration file already exists, skipping..."
fi

# Create recordings directory
echo "Creating recordings directory..."
mkdir -p recordings

echo ""
echo "=========================================="
echo "Installation Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Edit configuration: nano config.yaml"
echo "2. Activate virtual environment: source venv/bin/activate"
echo "3. Run application: python -m web.app"
echo "4. Access web interface: http://localhost:5000"
echo ""
echo "To test audio devices:"
echo "  arecord -l"
echo ""
echo "For Raspberry Pi deployment, use: curl -fsSL https://raw.githubusercontent.com/KamalDasu/mixpi/main/scripts/install-pi.sh | bash"
echo ""
