#!/bin/bash
# MixPi Recorder - Local Development Installation Script
# For Ubuntu/Debian-based systems (development machines)

set -e

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

# Create virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv venv
else
    echo "Virtual environment already exists, skipping..."
fi

# Activate virtual environment and install Python dependencies
echo "Installing Python dependencies..."
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

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
