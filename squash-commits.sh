#!/bin/bash
# Squash development commits into clean history

echo "=========================================="
echo "Squash Commits for Clean History"
echo "=========================================="
echo ""

cd /home/kd923030/mixpi

echo "Current commits:"
git log --oneline -15
echo ""

echo "This will squash all commits into a clean history:"
echo "  1. Initial commit with complete implementation"
echo "  2. Bug fixes"
echo "  3. Feature additions"
echo ""

read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled"
    exit 1
fi

# Create a new branch with clean history
echo "Creating clean history..."

# Get the initial commit
INITIAL_COMMIT=$(git rev-list --max-parents=0 HEAD)

# Create new orphan branch
git checkout --orphan clean-history

# Stage all files
git add -A

# Create single clean commit
git commit -m "$(cat <<'EOF'
Initial commit — MixPi multi-track recorder v1.0

Professional 18-channel USB audio recorder for Behringer X Air 18 on Raspberry Pi 4.

Features:
- 18-channel simultaneous recording to separate WAV files
- Web-based control interface with real-time level meters
- OSC integration with X Air mixer for channel name sync
- Auto-start recording on signal detection with pre-roll buffer
- Marker system for DAW import
- Session management with metadata and custom naming
- File download with ZIP support
- Touchscreen LCD support with optimized UI
- Systemd service for auto-start on boot
- Complete installation and deployment scripts

Components:
- Core audio engine (ALSA/sounddevice) with 18-channel support
- Flask REST API and WebSocket server for real-time updates
- Responsive web UI with Canvas-based level meters
- X Air OSC client for mixer integration
- Storage manager with disk space monitoring
- Local development environment with mock audio device
- Comprehensive test suite
- Complete documentation

Technical Stack:
- Python 3.10+ with Flask, SocketIO, sounddevice
- HTML5/CSS3/JavaScript frontend
- ALSA audio backend
- OSC protocol for mixer control

Ready for production deployment on Raspberry Pi 4.
EOF
)"

echo ""
echo "Clean history created on branch 'clean-history'"
echo ""
echo "To apply this clean history:"
echo "  git branch -D main"
echo "  git branch -m clean-history main"
echo ""
echo "Or to keep both:"
echo "  git checkout main  # Go back to original"
echo "  git branch -D clean-history  # Delete clean branch"
echo ""
