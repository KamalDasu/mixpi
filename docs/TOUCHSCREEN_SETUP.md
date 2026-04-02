# Touchscreen LCD Setup for MixPi

Guide for using MixPi with Waveshare and other touchscreen LCDs on Raspberry Pi.

## Recommended Screens

### 7" HDMI LCD (1024×600) - Best Choice
- **Model**: Waveshare 7" HDMI LCD (C)
- **Resolution**: 1024×600
- **Touch**: Capacitive (better than resistive)
- **Connection**: HDMI + USB (for touch)
- **Price**: ~$60-70
- **Why**: Perfect size, good resolution, all 18 meters visible

### 5" HDMI LCD (800×480) - Compact
- **Model**: Waveshare 5" HDMI LCD
- **Resolution**: 800×480
- **Touch**: Resistive or Capacitive
- **Connection**: HDMI + USB
- **Price**: ~$40-50
- **Why**: More portable, still usable

### 3.5" GPIO LCD (480×320) - Ultra Compact
- **Model**: Waveshare 3.5" LCD
- **Resolution**: 480×320
- **Touch**: Resistive
- **Connection**: GPIO pins
- **Price**: ~$15-25
- **Why**: Very compact, basic control only

## Installation

### Step 1: Install Waveshare Drivers

```bash
# SSH to your Raspberry Pi
ssh pi@<hostname>.local

# Download drivers
cd ~
git clone https://github.com/waveshare/LCD-show.git
cd LCD-show/

# Install for your screen model:

# For 7" HDMI LCD (1024×600)
sudo ./LCD7-show

# For 5" HDMI LCD (800×480)
sudo ./LCD5-show

# For 3.5" GPIO LCD (480×320)
sudo ./LCD35-show

# Pi will reboot automatically
```

### Step 2: Install Chromium Browser

```bash
sudo apt-get update
sudo apt-get install -y chromium-browser unclutter
```

### Step 3: Configure Auto-Start

Create autostart directory:
```bash
mkdir -p ~/.config/autostart
```

Create MixPi browser launcher:
```bash
nano ~/.config/autostart/mixpi-browser.desktop
```

Add this content:
```ini
[Desktop Entry]
Type=Application
Name=MixPi Browser
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --disable-restore-session-state http://localhost:5000
# Note: use localhost when running on the Pi itself; use http://<hostname>.local:5000 from another device
X-GNOME-Autostart-enabled=true
```

### Step 4: Hide Mouse Cursor

Add to LXDE autostart:
```bash
nano ~/.config/lxsession/LXDE-pi/autostart
```

Add this line:
```
@unclutter -idle 0.1 -root
```

### Step 5: Disable Screen Blanking

```bash
nano ~/.config/lxsession/LXDE-pi/autostart
```

Add these lines:
```
@xset s off
@xset -dpms
@xset s noblank
```

### Step 6: Reboot

```bash
sudo reboot
```

## Touchscreen Calibration

If touch is not accurate:

```bash
# Install calibration tool
sudo apt-get install -y xinput-calibrator

# Run calibration
DISPLAY=:0.0 xinput_calibrator

# Follow on-screen instructions
# Save the output to /etc/X11/xorg.conf.d/99-calibration.conf
```

## Kiosk Mode Features

The browser will:
- ✅ Start automatically on boot
- ✅ Open MixPi in fullscreen
- ✅ Hide browser UI (no address bar)
- ✅ Hide mouse cursor
- ✅ Prevent screen blanking
- ✅ Auto-reconnect if connection lost

## Mobile View — Optimised for Touchscreens

MixPi has a dedicated **Mobile view** that is ideal for touchscreens. It activates automatically on viewports narrower than 768 px and can also be toggled manually with the **Mobile** button in the header.

Mobile view features:
- **Compact 6×3 channel tile grid** — all 18 channels visible at once with no scrolling
- **Tap anywhere on a tile** to arm or disarm a channel (no small REC button to hit)
- **Red top bar wiggles** on an armed tile when audio signal is detected
- **Tabs at the top** (not bottom) — Home | Recordings | Markers | Storage
- **Compact pre-record grid** — Quality, Channels, Storage, Session, Notes, Song in a 2×3 grid
- **Minimal discovery bar** — mixer name + channel count, Scan, and Restart only
- **Pi hostname in the header** instead of verbose disk space info

The preference is persisted in `localStorage` so the view remembers your choice across page loads.

### 7" Screen (1024×600) — Recommended
- Desktop view: all 18 channel strips with VU meters, peak hold, dB readout
- Mobile view: all 18 tiles visible, compact layout

### 5" Screen (800×480)
- Mobile view recommended — tiles fit without scrolling

### 3.5" Screen (480×320)
- Mobile view only — tiles are compact enough to fit
- Reduce meter update rate to ease CPU:
  ```yaml
  monitoring:
    update_rate: 100  # ms (was 50)
  ```

## Physical Mounting

### Desktop Stand
Use a tablet stand or:
```
┌─────────────┐
│   Screen    │
│             │
└─────┬───────┘
      │ Stand
    ──┴──
```

### Mixer Mount
Attach to mixer with:
- Velcro strips
- RAM mount
- Custom 3D printed bracket

### Rack Mount
Use 1U or 2U rack shelf with:
- Angled mounting for better viewing
- Cable management

## Troubleshooting

### Screen Not Detected
```bash
# Check HDMI connection
tvservice -s

# Check USB touch device
lsusb

# Reinstall drivers
cd ~/LCD-show
sudo ./LCD7-show
```

### Touch Not Working
```bash
# List input devices
xinput list

# Check if touch device is detected
dmesg | grep -i touch
```

### Screen Rotated Wrong
```bash
# Rotate 180 degrees
sudo nano /boot/config.txt

# Add:
display_rotate=2

# Or for LCD-show screens:
cd ~/LCD-show
sudo ./rotate.sh 180
```

### Browser Not Starting
```bash
# Check autostart file
cat ~/.config/autostart/mixpi-browser.desktop

# Test manually
DISPLAY=:0 chromium-browser --kiosk http://localhost:5000
```

### MixPi Service Not Running
```bash
# Check service status
sudo systemctl status mixpi-recorder

# View logs
sudo journalctl -u mixpi-recorder -f
```

## Performance Tips

### For 3.5" Screens
Edit config to reduce load:
```yaml
monitoring:
  update_rate: 100  # Slower updates (was 50ms)
```

### Reduce CPU Usage
```bash
# Lower Chromium GPU usage
chromium-browser --kiosk --disable-gpu http://localhost:5000
```

## Advanced: Custom Resolution

If screen resolution is wrong:

```bash
sudo nano /boot/config.txt
```

Add:
```
hdmi_group=2
hdmi_mode=87
hdmi_cvt=1024 600 60 6 0 0 0
```

Reboot:
```bash
sudo reboot
```

## Testing

### Test Touch
```bash
# Install test app
sudo apt-get install -y evtest

# Test touch input
sudo evtest
# Select your touch device and tap screen
```

### Test Browser
```bash
# Start browser manually
DISPLAY=:0 chromium-browser --kiosk http://localhost:5000
```

## Complete Setup Script

Save this as `setup-touchscreen.sh`:

```bash
#!/bin/bash
# Complete touchscreen setup for MixPi

echo "Installing packages..."
sudo apt-get update
sudo apt-get install -y chromium-browser unclutter xinput-calibrator

echo "Creating autostart directory..."
mkdir -p ~/.config/autostart

echo "Creating browser autostart..."
cat > ~/.config/autostart/mixpi-browser.desktop <<EOF
[Desktop Entry]
Type=Application
Name=MixPi Browser
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble http://localhost:5000
X-GNOME-Autostart-enabled=true
EOF

echo "Configuring LXDE autostart..."
mkdir -p ~/.config/lxsession/LXDE-pi
cat >> ~/.config/lxsession/LXDE-pi/autostart <<EOF
@unclutter -idle 0.1 -root
@xset s off
@xset -dpms
@xset s noblank
EOF

echo "Setup complete!"
echo "Reboot to test: sudo reboot"
```

Run it:
```bash
chmod +x setup-touchscreen.sh
./setup-touchscreen.sh
```

## Recommended Workflow

1. **Mount screen** near mixer
2. **Power on** - MixPi starts automatically
3. **Touch "Record"** to start
4. **Monitor levels** on screen
5. **Add markers** during performance
6. **Touch "Stop"** when done
7. **Download recordings** from another device

## Shopping List

- Waveshare 7" HDMI LCD (~$60)
- HDMI cable (short, 6-12")
- USB cable for touch (usually included)
- Tablet stand or RAM mount (~$15)
- Optional: Protective case

Total: ~$75-100

Perfect for live shows, rehearsals, and studio recording! 🎵
