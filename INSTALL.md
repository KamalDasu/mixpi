# MixPi — Installation Guide

## System Requirements

| | Development machine | Raspberry Pi (production) |
|---|---|---|
| OS | Ubuntu 20.04+ / Debian 11+ / any Debian-based | Raspberry Pi OS 64-bit (Bookworm) |
| CPU | Any x86-64 or ARM64 | Raspberry Pi 4 or 5 (4 GB RAM recommended) |
| Python | 3.10 or higher | 3.10 or higher |
| Audio hardware | Optional (mock mode available) | Behringer X Air, X32, or Midas M32 via USB |
| Storage | Local disk | USB 3.0 SSD or fast flash drive |

---

## Raspberry Pi — One-Command Install

This is the recommended method for a fresh Pi. Run on the Pi as your normal user (not root):

```bash
curl -fsSL https://raw.githubusercontent.com/KamalDasu/mixpi/main/scripts/install-pi.sh | bash
```

Then reboot:

```bash
sudo reboot
```

See [README.md](README.md) for the full step-by-step walkthrough including CA certificate installation.

---

## Part 1 — System Dependencies

These packages are required on **both** development machines and the Raspberry Pi.

### 1. Update system

```bash
sudo apt-get update
sudo apt-get upgrade -y
```

### 2. Python and build tools

```bash
sudo apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    gcc \
    build-essential
```

| Package | Why |
|---------|-----|
| `python3` | Python interpreter (≥ 3.10) |
| `python3-pip` | pip package manager |
| `python3-venv` | virtual environment support |
| `python3-dev` | Python headers (needed to compile psutil) |
| `gcc`, `build-essential` | C compiler for native extensions |

### 3. Audio libraries

```bash
sudo apt-get install -y \
    libasound2-dev \
    libportaudio2 \
    portaudio19-dev \
    libsndfile1 \
    alsa-utils
```

| Package | Why |
|---------|-----|
| `libasound2-dev` | ALSA development headers |
| `libportaudio2` | PortAudio runtime (required by sounddevice) |
| `portaudio19-dev` | PortAudio headers |
| `libsndfile1` | Audio file read/write |
| `alsa-utils` | `arecord`, `aplay`, `alsamixer` |

### 4. Filesystem tools (required for USB drive management)

```bash
sudo apt-get install -y \
    exfatprogs \
    dosfstools \
    hfsprogs \
    udisks2
```

| Package | Why |
|---------|-----|
| `exfatprogs` | Format drives as exFAT (`mkfs.exfat`) |
| `dosfstools` | Format drives as FAT32 (`mkfs.vfat`) |
| `hfsprogs` | Format drives as HFS+ (`mkfs.hfsplus`) |
| `udisks2` | Userspace disk management daemon |

### 5. Network, HTTPS, and version control

```bash
sudo apt-get install -y \
    avahi-daemon \
    mkcert \
    git \
    ffmpeg
```

| Package | Why |
|---------|-----|
| `avahi-daemon` | mDNS — makes Pi reachable as `<hostname>.local` |
| `mkcert` | Generates locally-trusted HTTPS certificates |
| `git` | Version control |
| `ffmpeg` | Stereo mix export (M4A, MP3) |

---

## Part 2 — Application Installation

### Raspberry Pi (recommended)

```bash
# Run directly on the Pi
curl -fsSL https://raw.githubusercontent.com/KamalDasu/mixpi/main/scripts/install-pi.sh | bash
```

### Development machine

```bash
git clone https://github.com/KamalDasu/mixpi.git
cd mixpi
./scripts/install-local.sh
```

### Complete Uninstallation (Raspberry Pi)

If you need to completely remove MixPi and revert all system configurations (WiFi AP, mDNS, services) back to their original state for testing purposes, run the uninstaller script on the Pi:

```bash
sudo bash /opt/mixpi/scripts/uninstall-pi.sh
```
*(Note: This removes the application and configs, but leaves system packages like `ffmpeg` installed to speed up future re-installs).*

Or manually:

```bash
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
cp config.yaml.example config.yaml
mkdir -p recordings
```

---

## Part 3 — Python Packages

All packages are installed from `requirements.txt` via pip:

| Package | Purpose |
|---------|---------|
| flask | Web framework |
| flask-socketio | WebSocket push for level metering |
| flask-cors | Cross-origin resource sharing |
| python-socketio | SocketIO client/server |
| sounddevice | ALSA/PortAudio audio capture |
| soundfile | WAV file writing |
| numpy | Audio buffer processing |
| pyyaml | `config.yaml` parsing |
| xair-api | Behringer/Midas OSC control |
| watchdog | File system event monitoring |
| psutil | Disk space and system stats |

---

## Part 4 — Configure

```bash
nano /opt/mixpi/config.yaml
```

Key settings:

| Setting | Description |
|---------|-------------|
| `audio.device` | `"auto"` (recommended) or exact ALSA card name |
| `audio.sample_rate` | `48000` (XR18 native) |
| `audio.bit_depth` | `16` / `24` / `32` — 32 = S32_LE (XR18 hardware format) |
| `recording.storage_path` | Where to save WAV files (`/opt/mixpi/recordings` or USB path) |
| `osc.xair_ip` | Leave empty `""` — app auto-discovers mixer via UDP broadcast |

---

## Part 5 — HTTPS Certificate (Optional)

By default, MixPi runs on plain HTTP for simpler access and to avoid browser security warnings. HTTPS is only required if you want to use the **Web Share / AirDrop** feature on iOS.

### 1. Enable HTTPS on the Pi (Manual)

If you need HTTPS, run the following command on your Raspberry Pi:

```bash
sudo bash /opt/mixpi/scripts/setup_https.sh
```
This script will generate the necessary certificates and restart the MixPi service in HTTPS mode.

### 2. Installing the CA certificate on each device

This is a **one-time step per device**. It tells the device to trust the Pi's self-signed certificate.

**Why is this needed?** The certificate is signed by a local Certificate Authority (CA) that only the Pi knows about. Browsers don't trust unknown CAs by default, so you install it once.

#### iPhone / iPad

1. Open **Safari** and go to `http://<hostname>.local:8080`
2. Tap **Install Certificate**
3. Safari says *"This website is trying to download a configuration profile"* → tap **Allow**
4. Open the **Settings** app → tap **Profile Downloaded** (appears near the top)
5. Tap **Install** → enter your PIN → tap **Install** again to confirm
6. Go to **Settings → General → About → Certificate Trust Settings**
7. Find *"mkcert development certificate"* → toggle it **on** → tap **Continue**

> After this, `https://<hostname>.local:5000` is fully trusted on that device and the **Share** button in the Recordings tab will open the iOS share sheet (AirDrop, Messages, etc.)

#### Mac

1. Go to `http://<hostname>.local:8080` in any browser → click **Install Certificate**
2. Double-click the downloaded `mixpi-ca.crt` file — Keychain Access opens
3. Double-click the certificate in Keychain → expand **Trust**
4. Set *"When using this certificate"* to **Always Trust**
5. Close the window → enter your Mac password to save

#### Android / Chrome

1. Go to `http://<hostname>.local:8080` → tap **Install Certificate**
2. Open **Settings → Security → More security settings → Install certificate → CA Certificate**
3. Select the downloaded `mixpi-ca.crt` file

#### Linux / Chromium

```bash
# Download the cert
wget http://<hostname>.local:8080/mixpi-ca.crt

# Install system-wide
sudo cp mixpi-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates
```

---

## Part 6 — Verify

### Check audio device

```bash
arecord -l
# Should list your mixer (e.g., X Air 18, X-USB, M32) when connected
```

### Check service

```bash
systemctl is-active mixpi-recorder
sudo journalctl -u mixpi-recorder -n 30 --no-pager
```

### Test locally (development)

```bash
source venv/bin/activate
python -m web.app
# Open http://localhost:5000
```

---

## Raspberry Pi Specific

### Systemd service

```bash
sudo systemctl enable mixpi-recorder    # auto-start on boot
sudo systemctl start  mixpi-recorder
sudo systemctl status mixpi-recorder
sudo journalctl -u mixpi-recorder -f    # live logs
```

### WiFi Access Point

The Pi creates a WiFi hotspot `mixpi-1` (password: `mixpi123`) on `wlan0` so devices can connect without any other network infrastructure. To customise:

```bash
AP_SSID="MyStudio" AP_PASSWORD="MyPassword" sudo bash /opt/mixpi/scripts/setup_ap.sh
```

### mDNS

Avahi advertises the service on port 5000. The Pi is reachable as `<hostname>.local`. If mDNS doesn't resolve, use the direct AP IP: `http://10.10.10.1:5000`.

### sudoers

`install-pi.sh` creates `/etc/sudoers.d/mixpi-storage` to allow the service user to run `umount`, `mkfs.*`, and `udisksctl` without a password — required by the web UI's **Storage → Format** feature.

---

### All-in-One Quick Reference

#### Fresh Raspberry Pi

```bash
# On the Pi:
curl -fsSL https://raw.githubusercontent.com/KamalDasu/mixpi/main/scripts/install-pi.sh | bash
sudo reboot

# Open the app:
# http://<hostname>.local:5000

# Optional: Enable AirDrop (one-time per device)
# Run 'sudo bash /opt/mixpi/scripts/setup_https.sh' on Pi
# Open http://<hostname>.local:8080 and follow the certificate install steps
```

### Development machine

```bash
git clone https://github.com/KamalDasu/mixpi.git && cd mixpi
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp config.yaml.example config.yaml
python -m web.app
# Open http://localhost:5000
```

---

## Troubleshooting

### "PortAudio library not found"

```bash
sudo apt-get install -y libportaudio2 portaudio19-dev
pip uninstall sounddevice && pip install sounddevice
```

### "Python.h: No such file or directory"

```bash
sudo apt-get install -y python3-dev
pip install -r requirements.txt
```

### "No audio devices found"

```bash
lsusb | grep -i behringer   # check USB
arecord -l                  # list ALSA devices
sudo alsa force-reload      # reload drivers
```

### "Permission denied" on /opt/mixpi

```bash
sudo chown -R $(whoami):$(whoami) /opt/mixpi
```

### USB drive write speed = 0.0 MB/s

Drive is mounted as root. Use **Storage → Format** in the web UI, or remount manually:

```bash
sudo umount /dev/sda1
sudo mount -o uid=$(id -u),gid=$(id -g) /dev/sda1 /media/$(whoami)/MIXPI
```

### Safari shows "Not Secure" after CA install

Make sure you completed all three parts of the iOS install:
1. Downloaded and installed the profile (Settings → Profile Downloaded)
2. **And** enabled trust (Settings → General → About → Certificate Trust Settings)

Both steps are required — installing the profile alone is not enough.

---

## Next Steps

After installation:

1. Connect your mixer via USB to the Pi
2. Open `http://<hostname>.local:5000`
3. Click **Scan** in the discovery bar to locate the mixer on your network
4. Arm channels and press **● REC**
5. **Note for X32/M32 users:** Configure your Card Out routing via the mixer's screen or official app (MixPi's routing tab is currently X Air specific).
6. See [RASPBERRY_PI_DEPLOY.md](RASPBERRY_PI_DEPLOY.md) for USB storage setup and day-to-day workflow
