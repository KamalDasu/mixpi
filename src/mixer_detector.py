"""
Mixer detection: identify the connected mixer and load its capability profile.

Detection order:
  1. OSC query  – send /xinfo (or /info) to the configured mixer IP and parse
                  the model string from the response. Most reliable when the
                  mixer is on the network.
  2. USB name   – scan sounddevice input devices for known USB device name
                  patterns from mixer_profiles.
  3. Highest-ch – if nothing matches, pick the input device with the most
                  channels (>=4) as a generic fallback.
  4. None       – let sounddevice use the system default.
"""

import logging
import socket
import time
from typing import Optional, Tuple

import sounddevice as sd

from .mixer_profiles import (
    MixerProfile,
    find_profile_by_osc_model,
    find_profile_by_usb_name,
)

logger = logging.getLogger('mixpi.mixer_detector')

# How long to wait for an OSC /xinfo UDP response
OSC_TIMEOUT_S = 2.0


# ---------------------------------------------------------------------------
# OSC helpers (minimal, no dependency on python-osc for this probe)
# ---------------------------------------------------------------------------

def _build_osc_message(address: str) -> bytes:
    """
    Build a minimal OSC message for a no-argument query (e.g. '/xinfo').
    OSC strings are null-terminated and padded to 4-byte boundaries.
    The type-tag string is ',\0\0\0' (empty argument list).
    """
    def pad(s: bytes) -> bytes:
        pad_len = (4 - len(s) % 4) % 4
        return s + b'\x00' * (pad_len if pad_len else 4)

    addr_bytes = address.encode('utf-8') + b'\x00'
    type_bytes = b',\x00'
    return pad(addr_bytes) + pad(type_bytes)


def _parse_osc_string(data: bytes, offset: int) -> Tuple[str, int]:
    """Extract a null-terminated, 4-byte-padded OSC string from a byte buffer."""
    end = data.index(b'\x00', offset)
    s = data[offset:end].decode('utf-8', errors='replace')
    # advance past the string and its padding
    padded_end = end + (4 - end % 4) % 4
    if padded_end == end:
        padded_end += 4
    return s, padded_end


def _query_osc_xinfo(ip: str, port: int, address: str = '/xinfo') -> Optional[str]:
    """
    Send an OSC query and return the model string from the response, or None.

    X Air /xinfo response args: ip, name, model, version
    X32  /info  response args:  name, version, model, serial
    We try to extract a model-like token from any of the string arguments.
    """
    msg = _build_osc_message(address)
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(OSC_TIMEOUT_S)
        sock.sendto(msg, (ip, port))
        data, _ = sock.recvfrom(512)
        sock.close()
    except (socket.timeout, OSError) as e:
        logger.debug(f"OSC probe {address}@{ip}:{port} failed: {e}")
        return None

    # Parse the OSC address from the response to confirm it's an OSC packet
    try:
        resp_addr, offset = _parse_osc_string(data, 0)
    except (ValueError, UnicodeDecodeError):
        return None

    # Skip the type-tag string (starts with ',')
    try:
        type_tag, offset = _parse_osc_string(data, offset)
    except (ValueError, UnicodeDecodeError):
        return None

    # Collect all string arguments; the model is typically 2–4 chars like
    # 'XR18', 'X32', 'WING', 'M32'
    strings = []
    while offset < len(data):
        try:
            s, offset = _parse_osc_string(data, offset)
            if s:
                strings.append(s)
        except (ValueError, UnicodeDecodeError):
            break

    logger.debug(f"OSC {address} response strings: {strings}")

    # Prefer the shortest uppercase-ish token that looks like a model ID
    for s in strings:
        stripped = s.strip()
        if 2 <= len(stripped) <= 20 and not stripped.startswith('/') and not '.' in stripped:
            logger.info(f"OSC identified mixer model: '{stripped}'")
            return stripped

    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

class MixerDetector:
    """
    Detects the connected mixer and resolves its MixerProfile.

    Usage:
        detector = MixerDetector(config)
        result = detector.detect()
        # result.profile  – MixerProfile or None
        # result.device_name – USB audio device name or None
        # result.method   – 'osc', 'usb', 'highest_channels', or 'default'
    """

    class DetectionResult:
        def __init__(
            self,
            profile: Optional[MixerProfile],
            device_name: Optional[str],
            method: str,
            osc_reachable: bool = False,
        ):
            self.profile = profile
            self.device_name = device_name
            self.method = method
            self.osc_reachable = osc_reachable

        def __repr__(self) -> str:
            pname = self.profile.name if self.profile else 'unknown'
            return (
                f"DetectionResult(profile={pname!r}, device={self.device_name!r}, "
                f"method={self.method!r}, osc={self.osc_reachable})"
            )

    def __init__(self, config: dict):
        self.config = config
        self.osc_ip: str = config.get('osc', {}).get('xair_ip', '')
        self.osc_enabled: bool = config.get('osc', {}).get('enabled', False)

    # ------------------------------------------------------------------
    # Step 1 – OSC probe
    # ------------------------------------------------------------------

    def _detect_via_osc(self) -> Optional['MixerDetector.DetectionResult']:
        if not self.osc_enabled or not self.osc_ip:
            logger.debug("OSC detection skipped (disabled or no IP configured)")
            return None

        # Try /xinfo first (X Air / WING), then /info (X32 / M32)
        for addr, port in [('/xinfo', 10024), ('/info', 10023), ('/xinfo', 2222)]:
            model_str = _query_osc_xinfo(self.osc_ip, port, addr)
            if model_str:
                profile = find_profile_by_osc_model(model_str)
                if profile:
                    logger.info(
                        f"Mixer identified via OSC: {profile.name} "
                        f"(model string: '{model_str}')"
                    )
                    device_name = self._find_usb_device_for_profile(profile)
                    if not device_name:
                        # USB name scan failed (PulseAudio/PipeWire name differs) —
                        # fall back to highest-channel device
                        device_name, ch = self._best_usb_device()
                        if device_name:
                            logger.info(
                                f"USB name match failed for {profile.name}; "
                                f"using highest-channel device: '{device_name}' ({ch}ch)"
                            )
                        else:
                            logger.warning(
                                f"No multi-channel USB device found; "
                                f"falling back to system default"
                            )
                    return self.DetectionResult(
                        profile=profile,
                        device_name=device_name,
                        method='osc',
                        osc_reachable=True,
                    )
                else:
                    logger.warning(
                        f"OSC returned model '{model_str}' but no profile matched. "
                        f"Falling back to USB detection."
                    )
                    device_name, _ = self._best_usb_device()
                    return self.DetectionResult(
                        profile=None,
                        device_name=device_name,
                        method='osc_unknown',
                        osc_reachable=True,
                    )

        return None

    # ------------------------------------------------------------------
    # Step 2 – USB device name matching
    # ------------------------------------------------------------------

    def _detect_via_usb(self) -> 'MixerDetector.DetectionResult':
        try:
            devices = sd.query_devices()
        except Exception as e:
            logger.error(f"Could not query audio devices: {e}")
            return self.DetectionResult(None, None, 'default')

        for dev in devices:
            if dev['max_input_channels'] < 2:
                continue
            profile = find_profile_by_usb_name(dev['name'])
            if profile:
                logger.info(
                    f"Mixer identified via USB device name: {profile.name} "
                    f"(device: '{dev['name']}')"
                )
                return self.DetectionResult(
                    profile=profile,
                    device_name=dev['name'],
                    method='usb',
                )

        # Fallback: highest channel-count device
        name, ch = self._best_usb_device()
        if name:
            logger.warning(
                f"No known mixer found via USB name. Using highest channel device: "
                f"'{name}' ({ch}ch)"
            )
            return self.DetectionResult(None, name, 'highest_channels')

        logger.warning("No suitable audio input device found, using system default")
        return self.DetectionResult(None, None, 'default')

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _best_usb_device(self):
        """
        Return (name, channels) for the highest channel-count input device.
        Prefers devices with >=4 channels; falls back to >=2 if nothing larger found.
        Logs all visible input devices to aid debugging.
        """
        try:
            devices = sd.query_devices()
        except Exception:
            return None, 0

        input_devs = [(d['name'], d['max_input_channels'])
                      for d in devices if d['max_input_channels'] > 0]
        logger.debug(f"Available input devices: {input_devs}")

        # Pass 1: prefer ≥4ch (true multi-channel device)
        best_name, best_ch = None, 0
        for name, ch in input_devs:
            if ch > best_ch and ch >= 4:
                best_ch, best_name = ch, name

        # Pass 2: accept ≥2ch if nothing better found
        if not best_name:
            for name, ch in input_devs:
                if ch > best_ch and ch >= 2:
                    best_ch, best_name = ch, name

        return best_name, best_ch

    def _find_usb_device_for_profile(self, profile: MixerProfile) -> Optional[str]:
        """Find the ALSA device name for a known profile."""
        try:
            devices = sd.query_devices()
        except Exception:
            return None
        for dev in devices:
            for pat in profile.usb_patterns:
                if pat in dev['name'].lower() and dev['max_input_channels'] >= 2:
                    return dev['name']
        return None

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    def detect(self) -> 'MixerDetector.DetectionResult':
        """
        Run the full detection sequence and return a DetectionResult.
        This is safe to call at startup (no exceptions escape).
        """
        logger.info("Starting mixer detection...")

        # 1. Try OSC
        result = self._detect_via_osc()
        if result:
            return result

        # 2. Try USB name matching
        return self._detect_via_usb()
