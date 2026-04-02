#!/bin/bash
# Start MixPi Development Server

set -e

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Check if venv exists
if [ ! -d "venv" ]; then
    echo "Virtual environment not found!"
    echo "Run ./dev/setup.sh first"
    exit 1
fi

# Activate virtual environment
source venv/bin/activate

# Use development config
export MIXPI_CONFIG="dev/config.dev.yaml"

# Parse arguments
USE_MOCK=false
USE_MIC=false
PORT=${PORT:-5000}

for arg in "$@"; do
    case $arg in
        --mock)
            USE_MOCK=true
            shift
            ;;
        --mic)
            USE_MIC=true
            shift
            ;;
        --port=*)
            PORT="${arg#*=}"
            shift
            ;;
        *)
            ;;
    esac
done

# Set mock device if requested
if [ "$USE_MOCK" = true ]; then
    export MIXPI_MOCK_AUDIO=1
    echo "Using mock audio device (18ch simulated)"
fi

# Mic/headset test mode: use PulseAudio default input, 2 channels
if [ "$USE_MIC" = true ]; then
    export MIXPI_AUDIO_DEVICE="pulse"
    export MIXPI_AUDIO_CHANNELS="2"
    echo "Mic test mode: using PulseAudio default input (2ch)"
    echo "Plug in your headset/mic and ensure it is set as default input"
    echo "in your system sound settings."
fi

echo "=========================================="
echo "MixPi Development Server"
echo "=========================================="
echo ""
echo "Configuration: $MIXPI_CONFIG"
echo "Port: $PORT"
echo "Mock audio: $USE_MOCK"
echo ""
echo "Starting server..."
echo "Press Ctrl+C to stop"
echo ""

# Create log directory
mkdir -p dev/logs

# Run application with logging
python -m web.app 2>&1 | tee dev/logs/mixpi.log
