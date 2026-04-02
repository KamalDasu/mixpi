"""
Mixer capability profiles for known Behringer/Midas/Soundcraft USB audio interfaces.

Each profile describes a mixer model's static USB audio capabilities.
These are used for:
  - Auto-configuring the audio engine (channels, sample rate, bit depth)
  - Validating OSC connectivity
  - Displaying device info in the web UI

Profile fields:
  name            Human-readable model name
  osc_model_ids   Strings the mixer returns in its OSC /xinfo or /info response
  usb_patterns    Substrings to match against ALSA/sounddevice device names (lowercase)
  usb_in          Number of USB input channels (what the Pi records)
  usb_out         Number of USB output channels (playback to mixer)
  sample_rates    Supported USB sample rates in Hz
  bit_depth       USB audio bit depth: 32 = float32, 24 = PCM_24, 16 = PCM_16
  osc_port        Default OSC UDP port
  osc_query_addr  OSC address to send for mixer identification
  notes           Any important caveats

Computed (not stored, derived from the fields above):
  bit_rate_per_channel_bps   sample_rate × bit_depth  (bits/sec per channel)
  total_bit_rate_bps         sample_rate × bit_depth × usb_in  (bits/sec, all ch)
  storage_per_hour_gb        total bytes written per hour at the highest sample rate

  For the XR18 at 48 kHz / 32-bit / 18 ch:
      48000 × 32 × 18 = 27,648,000 bps  ≈  27.6 Mbps  ≈  3.45 MB/s  ≈  12.4 GB/hr
"""

from dataclasses import dataclass
from typing import List, Optional


@dataclass
class MixerProfile:
    key: str
    name: str
    osc_model_ids: List[str]
    usb_patterns: List[str]
    usb_in: int
    usb_out: int
    sample_rates: List[int]
    bit_depth: int
    osc_port: int
    osc_query_addr: str = '/xinfo'
    notes: str = ''

    # ------------------------------------------------------------------
    # Bit-rate helpers
    # All three methods accept optional overrides so callers can compute
    # for a specific channel count or sample rate (e.g. a partial session).
    # ------------------------------------------------------------------

    def bit_rate_per_channel(self, sample_rate: Optional[int] = None) -> int:
        """Bits per second for a single channel at the given (or max) sample rate."""
        rate = sample_rate or max(self.sample_rates)
        return rate * self.bit_depth

    def total_bit_rate(
        self,
        channels: Optional[int] = None,
        sample_rate: Optional[int] = None,
    ) -> int:
        """
        Total USB bit rate in bits/sec for all recorded channels.

        Args:
            channels:    Override channel count (default: usb_in)
            sample_rate: Override sample rate   (default: highest supported)
        """
        ch = channels or self.usb_in
        return self.bit_rate_per_channel(sample_rate) * ch

    def storage_per_hour_gb(
        self,
        channels: Optional[int] = None,
        sample_rate: Optional[int] = None,
    ) -> float:
        """
        Estimated uncompressed WAV storage in GB for one hour of recording.

        Formula: total_bit_rate_bps × 3600 seconds / 8 bits / 1024^3 bytes
        """
        bits_per_hour = self.total_bit_rate(channels, sample_rate) * 3600
        return bits_per_hour / 8 / (1024 ** 3)

    def bandwidth_mbps(
        self,
        channels: Optional[int] = None,
        sample_rate: Optional[int] = None,
    ) -> float:
        """Total USB bandwidth in Mbit/s (useful for verifying USB 2.0 headroom)."""
        return self.total_bit_rate(channels, sample_rate) / 1_000_000

    # ------------------------------------------------------------------

    def supports_sample_rate(self, rate: int) -> bool:
        return rate in self.sample_rates

    def to_dict(
        self,
        channels: Optional[int] = None,
        sample_rate: Optional[int] = None,
    ) -> dict:
        ch = channels or self.usb_in
        rate = sample_rate or max(self.sample_rates)
        return {
            'key': self.key,
            'name': self.name,
            'usb_in': self.usb_in,
            'usb_out': self.usb_out,
            'sample_rates': self.sample_rates,
            'bit_depth': self.bit_depth,
            'bit_format': 'Float32' if self.bit_depth == 32 else f'PCM_{self.bit_depth}',
            'osc_port': self.osc_port,
            'notes': self.notes,
            # Computed bit-rate fields (at active ch/rate, or profile max)
            'bit_rate_per_channel_kbps': round(self.bit_rate_per_channel(rate) / 1000, 1),
            'total_bit_rate_mbps': round(self.bandwidth_mbps(ch, rate), 2),
            'storage_per_hour_gb': round(self.storage_per_hour_gb(ch, rate), 2),
        }


# ---------------------------------------------------------------------------
# Profile database
# ---------------------------------------------------------------------------

MIXER_PROFILES: List[MixerProfile] = [

    # ------------------------------------------------------------------
    # Behringer X Air series  (USB class-compliant, 32-bit float)
    # ------------------------------------------------------------------
    MixerProfile(
        key='xr18',
        name='Behringer X Air 18 (XR18)',
        osc_model_ids=['XR18', 'X Air 18', 'XAIR18'],
        usb_patterns=['x air 18', 'xr18'],
        usb_in=18,
        usb_out=18,
        sample_rates=[44100, 48000],
        bit_depth=32,
        osc_port=10024,
        notes='16 mono mic/line inputs (Ch 1–16) + stereo Main L/R mix (Ch 17–18). '
              'USB audio is 32-bit float. 48 kHz recommended.',
    ),
    MixerProfile(
        key='xr16',
        name='Behringer X Air 16 (XR16)',
        osc_model_ids=['XR16', 'X Air 16', 'XAIR16'],
        usb_patterns=['x air 16', 'xr16'],
        usb_in=16,
        usb_out=16,
        sample_rates=[44100, 48000],
        bit_depth=32,
        osc_port=10024,
        notes='16 mic/line inputs. USB audio is 32-bit float.',
    ),
    MixerProfile(
        key='xr12',
        name='Behringer X Air 12 (XR12)',
        osc_model_ids=['XR12', 'X Air 12', 'XAIR12'],
        usb_patterns=['x air 12', 'xr12'],
        usb_in=12,
        usb_out=12,
        sample_rates=[44100, 48000],
        bit_depth=32,
        osc_port=10024,
        notes='12 inputs (8 mic/line + 2 stereo). USB audio is 32-bit float.',
    ),

    # ------------------------------------------------------------------
    # Behringer X32 family  (requires X-USB card for USB audio)
    # The X32 USB card provides 32 channels at 44.1/48kHz, 32-bit float
    # ------------------------------------------------------------------
    MixerProfile(
        key='x32',
        name='Behringer X32',
        osc_model_ids=['X32', 'X-32'],
        usb_patterns=['x32', 'x-32', 'behringer x32'],
        usb_in=32,
        usb_out=32,
        sample_rates=[44100, 48000],
        bit_depth=32,
        osc_port=10023,
        osc_query_addr='/info',
        notes='Requires X-USB expansion card. 32 channels at 48kHz.',
    ),
    MixerProfile(
        key='x32_compact',
        name='Behringer X32 Compact',
        osc_model_ids=['X32COMPACT', 'X32 Compact'],
        usb_patterns=['x32 compact', 'x32compact'],
        usb_in=32,
        usb_out=32,
        sample_rates=[44100, 48000],
        bit_depth=32,
        osc_port=10023,
        osc_query_addr='/info',
        notes='Same USB capabilities as X32 full. Requires X-USB card.',
    ),
    MixerProfile(
        key='x32_producer',
        name='Behringer X32 Producer',
        osc_model_ids=['X32PRODUCER', 'X32 Producer'],
        usb_patterns=['x32 producer', 'x32producer'],
        usb_in=32,
        usb_out=32,
        sample_rates=[44100, 48000],
        bit_depth=32,
        osc_port=10023,
        osc_query_addr='/info',
        notes='Same USB capabilities as X32. Requires X-USB card.',
    ),
    MixerProfile(
        key='x32_rack',
        name='Behringer X32 Rack',
        osc_model_ids=['X32RACK', 'X32 Rack'],
        usb_patterns=['x32 rack', 'x32rack'],
        usb_in=32,
        usb_out=32,
        sample_rates=[44100, 48000],
        bit_depth=32,
        osc_port=10023,
        osc_query_addr='/info',
        notes='Rackmount X32. Requires X-USB card.',
    ),

    # ------------------------------------------------------------------
    # Behringer WING
    # ------------------------------------------------------------------
    MixerProfile(
        key='wing',
        name='Behringer WING',
        osc_model_ids=['WING'],
        usb_patterns=['wing', 'behringer wing'],
        usb_in=24,
        usb_out=24,
        sample_rates=[44100, 48000, 96000],
        bit_depth=32,
        osc_port=2222,
        osc_query_addr='/xinfo',
        notes='24 USB channels. Supports up to 96kHz.',
    ),

    # ------------------------------------------------------------------
    # Midas M32 family  (OSC-compatible with X32)
    # ------------------------------------------------------------------
    MixerProfile(
        key='m32',
        name='Midas M32',
        osc_model_ids=['M32'],
        usb_patterns=['midas m32', 'm32'],
        usb_in=32,
        usb_out=32,
        sample_rates=[44100, 48000],
        bit_depth=32,
        osc_port=10023,
        osc_query_addr='/info',
        notes='Uses same OSC protocol as X32. Requires DL32 or X-USB for USB audio.',
    ),
    MixerProfile(
        key='m32r',
        name='Midas M32R',
        osc_model_ids=['M32R', 'M32 R'],
        usb_patterns=['midas m32r', 'm32r', 'm32 r'],
        usb_in=32,
        usb_out=32,
        sample_rates=[44100, 48000],
        bit_depth=32,
        osc_port=10023,
        osc_query_addr='/info',
        notes='Compact M32. X32-compatible OSC protocol.',
    ),
    MixerProfile(
        key='m32c',
        name='Midas M32C',
        osc_model_ids=['M32C', 'M32 C'],
        usb_patterns=['midas m32c', 'm32c'],
        usb_in=32,
        usb_out=32,
        sample_rates=[44100, 48000],
        bit_depth=32,
        osc_port=10023,
        osc_query_addr='/info',
        notes='Rackmount M32. X32-compatible OSC protocol.',
    ),

    # ------------------------------------------------------------------
    # Behringer XR series (older / rebranded)
    # ------------------------------------------------------------------
    MixerProfile(
        key='xr18_v1',
        name='Behringer X18 (original XR18)',
        osc_model_ids=['X18'],
        usb_patterns=['x18', 'behringer x18'],
        usb_in=18,
        usb_out=18,
        sample_rates=[44100, 48000],
        bit_depth=32,
        osc_port=10024,
        notes='Original X18 model (pre-XR18 rebranding). '
              '16 mono inputs (Ch 1–16) + stereo Main L/R (Ch 17–18).',
    ),
]


# ---------------------------------------------------------------------------
# Lookup helpers
# ---------------------------------------------------------------------------

def get_profile_by_key(key: str) -> Optional[MixerProfile]:
    for p in MIXER_PROFILES:
        if p.key == key:
            return p
    return None


def find_profile_by_osc_model(model_string: str) -> Optional[MixerProfile]:
    """Match a string returned by the mixer's OSC /xinfo or /info command."""
    model_upper = model_string.upper().strip()
    for p in MIXER_PROFILES:
        for mid in p.osc_model_ids:
            if mid.upper() == model_upper or mid.upper() in model_upper:
                return p
    return None


def find_profile_by_usb_name(device_name: str) -> Optional[MixerProfile]:
    """Match an ALSA/sounddevice device name against known USB device patterns."""
    name_lower = device_name.lower()
    for p in MIXER_PROFILES:
        for pat in p.usb_patterns:
            if pat in name_lower:
                return p
    return None


def list_profiles() -> List[dict]:
    """Return all profiles as serialisable dicts, sorted by USB channel count."""
    return [p.to_dict() for p in sorted(MIXER_PROFILES, key=lambda p: p.usb_in)]
