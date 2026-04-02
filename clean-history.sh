#!/bin/bash
# Create clean git history - Simple version

cd /home/kd923030/mixpi

echo "=========================================="
echo "Create Clean Git History"
echo "=========================================="
echo ""
echo "This will:"
echo "  1. Backup current branch as 'main-backup'"
echo "  2. Create new clean history with single commit"
echo "  3. Replace main branch"
echo ""

read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled"
    exit 1
fi

# Backup current branch
echo "Backing up current branch..."
git branch -f main-backup main

# Create new orphan branch
echo "Creating clean history..."
git checkout --orphan temp-clean

# Add all files
git add -A

# Create single commit
git commit -m "Initial commit — MixPi multi-track recorder v1.0

Professional 18-channel USB audio recorder for Behringer X Air 18 on Raspberry Pi 4.

Features:
- 18-channel simultaneous recording to separate WAV files
- Web-based control interface with real-time level meters  
- OSC integration with X Air mixer
- Auto-start recording with pre-roll buffer
- Marker system and session metadata
- File download with ZIP support
- Touchscreen LCD support
- Systemd service for auto-start
- Complete installation scripts

Components:
- Core audio engine (ALSA/sounddevice)
- Flask REST API and WebSocket server
- Responsive web UI with level meters
- X Air OSC client
- Storage manager
- Development environment
- Test suite
- Complete documentation

Ready for production deployment."

# Replace main branch
echo "Replacing main branch..."
git branch -D main
git branch -m main

echo ""
echo "✓ Clean history created!"
echo ""
echo "Current commit:"
git log --oneline -1
echo ""
echo "To restore old history if needed:"
echo "  git branch -D main"
echo "  git branch -m main-backup main"
echo ""
