#!/bin/bash
# Local Development Setup Script

set -e

echo "=========================================="
echo "MixPi - Local Development Setup"
echo "=========================================="
echo ""

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo "Please run WITHOUT sudo (script will ask for sudo when needed)"
    exit 1
fi

echo "Project root: $PROJECT_ROOT"
echo ""

# Install system dependencies
echo "Installing system dependencies..."
echo "This requires sudo access..."
sudo apt-get update
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
echo "System dependencies installed!"
echo ""

# Create virtual environment
if [ ! -d "venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv venv
else
    echo "Virtual environment already exists"
fi

# Activate and install Python packages
echo "Installing Python dependencies..."
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements-dev.txt

echo ""
echo "Python dependencies installed!"
echo ""

# Create development directories
echo "Creating development directories..."
mkdir -p dev/recordings
mkdir -p dev/logs

# Create development config
if [ ! -f "dev/config.dev.yaml" ]; then
    echo "Creating development configuration..."
    cat > dev/config.dev.yaml <<EOF
audio:
  device: null  # Use default device or set to "mock" for testing
  sample_rate: 48000
  bit_depth: 24
  channels: 18
  buffer_size: 512

recording:
  storage_path: "./dev/recordings"
  file_format: "wav"
  auto_start:
    enabled: false  # Disabled for development
    threshold_dbfs: -40
    silence_timeout: 5
  pre_roll: 2

monitoring:
  update_rate: 50
  peak_hold: 2000

web:
  host: "127.0.0.1"  # Localhost only for development
  port: 5000
  debug: true  # Enable debug mode

osc:
  xair_ip: "192.168.1.100"
  xair_port: 10024
  server_port: 10025
  enabled: false  # Disabled by default for development

channels:
  names:
    - "Ch 1"
    - "Ch 2"
    - "Ch 3"
    - "Ch 4"
    - "Ch 5"
    - "Ch 6"
    - "Ch 7"
    - "Ch 8"
    - "Ch 9"
    - "Ch 10"
    - "Ch 11"
    - "Ch 12"
    - "Ch 13"
    - "Ch 14"
    - "Ch 15"
    - "Ch 16"
    - "Ch 17"
    - "Ch 18"
EOF
    echo "Development config created: dev/config.dev.yaml"
else
    echo "Development config already exists"
fi

# Create main config if it doesn't exist
if [ ! -f "config.yaml" ]; then
    echo "Creating main configuration..."
    cp dev/config.dev.yaml config.yaml
else
    echo "Main config already exists"
fi

# Create .gitignore for dev directory
cat > dev/.gitignore <<EOF
# Development files
recordings/
logs/
*.log
*.pyc
__pycache__/
.pytest_cache/
.coverage
htmlcov/
EOF

echo ""
echo "=========================================="
echo "Setup Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Start development server:"
echo "     ./dev/run.sh"
echo ""
echo "  2. Run tests:"
echo "     ./dev/test.sh"
echo ""
echo "  3. Access web interface:"
echo "     http://localhost:5000"
echo ""
echo "Development configuration: dev/config.dev.yaml"
echo "Recordings will be saved to: dev/recordings/"
echo ""
