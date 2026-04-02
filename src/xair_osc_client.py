"""
X Air / X32 / Wing OSC channel strip client.

Fetches and subscribes to channel strip data (names, fader, mute, phantom,
gate, compressor, EQ) from Behringer/Midas mixers over UDP OSC.

How the X Air OSC protocol works:
  - All communication is UDP on port 10024 (X Air) or 10023 (X32/M32).
  - Query a parameter: send the OSC address with no arguments.
    The mixer responds on the same UDP source port.
  - Subscribe for push updates: send /xremote (no args) every <10 s.
    While subscribed, the mixer pushes every parameter change automatically.
  - /ch/NN addresses are 1-based, zero-padded: /ch/01 … /ch/16.
  - Stereo returns (AUX inputs) are /rtn/01 and /rtn/02 on X Air.
  - X32/M32 uses the same /ch/ scheme; WING is largely compatible.

Key OSC addresses queried here (X Air 18 layout):
  /ch/01/config/name        String  - channel name (≤12 chars)
  /ch/01/config/color       Int     - strip colour index (0–15)
  /ch/01/mix/on             Int     - 1=unmuted, 0=muted
  /ch/01/mix/fader          Float   - fader position 0.0–1.0
  /ch/01/mix/pan            Float   - pan 0.0 (L) – 1.0 (R), 0.5 = centre
  /ch/01/preamp/phantom     Int     - 1=48V on
  /ch/01/gate/on            Int     - noise gate engaged
  /ch/01/dyn/on             Int     - compressor engaged
  /ch/01/eq/on              Int     - EQ engaged
  /rtn/01/config/name       String  - stereo return 1 name
  /rtn/01/mix/on            Int
  /rtn/01/mix/fader         Float
"""

import socket
import struct
import threading
import time
import logging
from dataclasses import dataclass
from typing import Optional, Dict, List, Callable, Tuple, Any

logger = logging.getLogger('mixpi.osc_client')

# How long to wait for a single OSC query response
_QUERY_TIMEOUT_S = 0.4
# /xremote expires after 10 s; renew every 8 s for safety
_XREMOTE_INTERVAL_S = 8.0


# ---------------------------------------------------------------------------
# Minimal OSC codec (no external dependencies beyond stdlib)
# ---------------------------------------------------------------------------

def _pad4(n: int) -> int:
    """Round n up to the next multiple of 4."""
    return (n + 3) & ~3


def _encode_string(s: str) -> bytes:
    raw = s.encode('utf-8') + b'\x00'
    return raw.ljust(_pad4(len(raw)), b'\x00')


def _encode_osc_message(address: str, *args) -> bytes:
    """
    Build a binary OSC message.

    Supported arg types: int, float, str, bool (mapped to int 0/1).
    An empty args list produces a valid no-argument query message.
    """
    out = _encode_string(address)
    if not args:
        out += _encode_string(',')
        return out

    type_tag = ','
    payloads = []
    for a in args:
        if isinstance(a, bool):
            type_tag += 'i'
            payloads.append(struct.pack('>i', int(a)))
        elif isinstance(a, int):
            type_tag += 'i'
            payloads.append(struct.pack('>i', a))
        elif isinstance(a, float):
            type_tag += 'f'
            payloads.append(struct.pack('>f', a))
        elif isinstance(a, str):
            type_tag += 's'
            payloads.append(_encode_string(a))
        else:
            raise TypeError(f"Unsupported OSC arg type: {type(a)}")

    out += _encode_string(type_tag)
    for p in payloads:
        out += p
    return out


def _decode_osc_message(data: bytes) -> Tuple[str, List[Any]]:
    """
    Decode a binary OSC message into (address, [args]).
    Returns ('', []) on parse failure.
    """
    try:
        offset = 0

        # Address string
        end = data.index(b'\x00', offset)
        address = data[offset:end].decode('utf-8', errors='replace')
        offset = _pad4(end + 1)

        # Type tag string
        end = data.index(b'\x00', offset)
        type_tag = data[offset:end].decode('utf-8', errors='replace')
        offset = _pad4(end + 1)

        args: List[Any] = []
        for t in type_tag.lstrip(','):
            if t == 'i':
                args.append(struct.unpack('>i', data[offset:offset + 4])[0])
                offset += 4
            elif t == 'f':
                args.append(struct.unpack('>f', data[offset:offset + 4])[0])
                offset += 4
            elif t == 's':
                end = data.index(b'\x00', offset)
                args.append(data[offset:end].decode('utf-8', errors='replace'))
                offset = _pad4(end + 1)
            elif t in ('T', 'F'):
                args.append(t == 'T')
            # skip blobs, timestamps, etc.

        return address, args
    except Exception:
        return '', []


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class ChannelStrip:
    """Snapshot of one mixer channel strip."""
    number: int          # 1-based
    osc_prefix: str      # e.g. '/ch/01' or '/rtn/01'
    name: str = ''
    color: int = 0
    muted: bool = False  # True = muted (mix/on == 0)
    fader: float = 0.75  # 0.0–1.0  (unity ≈ 0.75 on X Air)
    pan: float = 0.5     # 0.5 = centre
    phantom: bool = False
    gate_on: bool = False
    comp_on: bool = False
    eq_on: bool = True

    def display_name(self) -> str:
        return self.name.strip() if self.name.strip() else f'Ch {self.number}'

    def to_dict(self) -> dict:
        return {
            'number': self.number,
            'osc_prefix': self.osc_prefix,
            'name': self.display_name(),
            'raw_name': self.name,
            'color': self.color,
            'muted': self.muted,
            'fader': round(self.fader, 3),
            'fader_db': round(_fader_to_db(self.fader), 1),
            'pan': round(self.pan, 3),
            'phantom': self.phantom,
            'gate_on': self.gate_on,
            'comp_on': self.comp_on,
            'eq_on': self.eq_on,
        }


def _fader_to_db(f: float) -> float:
    """
    Convert X Air fader float (0–1) to approximate dB value.
    X Air uses a log taper: f=0.75 ≈ 0 dB, f=0 = -∞ dB.
    """
    if f <= 0:
        return -90.0
    # Approximation valid for the X Air log curve
    if f >= 0.75:
        db = (f - 0.75) / 0.25 * 10.0        # 0 dB .. +10 dB
    elif f >= 0.5:
        db = (f - 0.5) / 0.25 * 10.0 - 10.0  # -10 dB .. 0 dB
    elif f >= 0.25:
        db = (f - 0.25) / 0.25 * 20.0 - 30.0 # -30 dB .. -10 dB
    else:
        db = f / 0.25 * 30.0 - 60.0           # -60 dB .. -30 dB
    return round(db, 1)


# ---------------------------------------------------------------------------
# Channel address map
# ---------------------------------------------------------------------------

def _build_channel_map(usb_in: int) -> List[Tuple[int, str]]:
    """
    Return [(channel_number, osc_prefix), ...] for a mixer with usb_in channels.
    Covers mono channels (/ch/01…16) and stereo returns (/rtn/01, /rtn/02).
    """
    entries = []
    mono = min(usb_in, 16)
    for i in range(1, mono + 1):
        entries.append((i, f'/ch/{i:02d}'))
    # Stereo returns for remaining channels (XR18 = ch17, ch18)
    rtn_count = max(0, usb_in - 16)
    for i in range(1, min(rtn_count, 2) + 1):
        entries.append((16 + i, f'/rtn/{i:02d}'))
    return entries


# ---------------------------------------------------------------------------
# OSC socket helper
# ---------------------------------------------------------------------------

class _OSCSocket:
    """
    Thin wrapper around a UDP socket for sending OSC messages and
    receiving responses on the same port.
    """

    def __init__(self, mixer_ip: str, mixer_port: int):
        self.mixer_ip = mixer_ip
        self.mixer_port = mixer_port
        self._sock: Optional[socket.socket] = None

    def open(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.bind(('', 0))  # OS picks an ephemeral port

    def close(self) -> None:
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None

    def send(self, address: str, *args) -> None:
        if not self._sock:
            return
        msg = _encode_osc_message(address, *args)
        self._sock.sendto(msg, (self.mixer_ip, self.mixer_port))

    def query(self, address: str, timeout: float = _QUERY_TIMEOUT_S
              ) -> Optional[List[Any]]:
        """
        Send a no-argument query and wait for the mixer's response.
        Returns the argument list, or None on timeout.
        """
        if not self._sock:
            return None
        self._sock.settimeout(timeout)
        self.send(address)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                data, _ = self._sock.recvfrom(512)
                resp_addr, args = _decode_osc_message(data)
                if resp_addr == address:
                    return args
            except socket.timeout:
                break
            except Exception:
                break
        return None

    def recv_with_timeout(self, timeout: float) -> Optional[Tuple[str, List[Any]]]:
        if not self._sock:
            return None
        self._sock.settimeout(timeout)
        try:
            data, _ = self._sock.recvfrom(1024)
            return _decode_osc_message(data)
        except socket.timeout:
            return None
        except Exception:
            return None


# ---------------------------------------------------------------------------
# Main client
# ---------------------------------------------------------------------------

class XAirOSCClient:
    """
    Reads and subscribes to channel strip data from an X Air / X32 / Wing mixer.

    Usage:
        client = XAirOSCClient(config)
        if client.connect():
            client.fetch_all()          # one-shot full snapshot
            client.start_subscription() # background thread for push updates
        strips = client.get_strips()    # {ch_number: ChannelStrip}
        client.stop()
    """

    def __init__(self, config: dict):
        osc_cfg = config.get('osc', {})
        self.enabled: bool = osc_cfg.get('enabled', False)
        self.mixer_ip: str = osc_cfg.get('xair_ip', '')
        self.mixer_port: int = int(osc_cfg.get('xair_port', 10024))

        self._sock = _OSCSocket(self.mixer_ip, self.mixer_port)
        self._strips: Dict[int, ChannelStrip] = {}
        # USB routing: 9 ints — one source index per stereo pair (pairs 1-9)
        self._routing: List[int] = []
        self._lock = threading.Lock()
        self._sub_thread: Optional[threading.Thread] = None
        self._running = False
        self._connected = False
        self._on_update_callbacks: List[Callable] = []
        self._on_routing_callbacks: List[Callable] = []

        # Determine channel map from mixer profile if available
        self._channel_map: List[Tuple[int, str]] = _build_channel_map(18)

    # ------------------------------------------------------------------
    # Connect / disconnect
    # ------------------------------------------------------------------

    def connect(self) -> bool:
        """
        Open UDP socket and verify the mixer actually responds to /xinfo.
        Returns True only if the mixer sends a reply within the timeout.
        """
        if not self.enabled or not self.mixer_ip:
            logger.info("OSC client disabled or no mixer IP configured")
            return False
        try:
            self._sock.open()
            self._sock.send('/xinfo')
            result = self._sock.recv_with_timeout(1.5)
            if result is None:
                logger.warning(
                    f"OSC: no response from {self.mixer_ip}:{self.mixer_port} "
                    f"— mixer not reachable, OSC disabled"
                )
                self._sock.close()
                self._connected = False
                return False
            self._connected = True
            logger.info(f"OSC client connected to {self.mixer_ip}:{self.mixer_port}")
            return True
        except Exception as e:
            logger.warning(f"OSC client could not connect: {e}")
            self._connected = False
            return False

    def stop(self) -> None:
        """Stop the subscription thread and close the socket."""
        self._running = False
        if self._sub_thread:
            self._sub_thread.join(timeout=3.0)
        self._sock.close()
        self._connected = False

    @staticmethod
    def discover(port: int = 10024, timeout: float = 2.5) -> Optional[str]:
        """
        Broadcast /xinfo on the local network and return the first
        responding mixer's IP address, or None if nothing is found.
        Works on any subnet the host has an interface on.
        """
        msg = b'/xinfo\x00\x00,\x00\x00\x00'
        found_ip: Optional[str] = None
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(0.3)
        try:
            sock.bind(('', 0))
            # Send to global broadcast AND every interface's directed broadcast
            targets = {'255.255.255.255'}
            try:
                import subprocess
                out = subprocess.check_output(
                    ['ip', '-4', 'addr', 'show'], text=True, timeout=2)
                import re
                for bcast in re.findall(r'brd\s+([\d.]+)', out):
                    targets.add(bcast)
            except Exception:
                pass
            for tgt in targets:
                try:
                    sock.sendto(msg, (tgt, port))
                except Exception:
                    pass
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    _, (src_ip, _) = sock.recvfrom(512)
                    found_ip = src_ip
                    break
                except socket.timeout:
                    pass
        except Exception as e:
            logger.debug(f"OSC broadcast discover error: {e}")
        finally:
            sock.close()
        if found_ip:
            logger.info(f"OSC broadcast discovered mixer at {found_ip}")
        return found_ip

    def reconnect(self, new_ip: str) -> bool:
        """
        Switch to a new mixer IP and reconnect.
        Stops any running subscription, updates the IP, and calls connect().
        Returns True if the new connection succeeds.
        """
        logger.info(f"OSC reconnecting: {self.mixer_ip} → {new_ip}")
        self.stop()
        self.mixer_ip = new_ip
        self._sock = _OSCSocket(new_ip, self.mixer_port)
        ok = self.connect()
        if ok:
            self.fetch_all()
            self.start_subscription()
        return ok

    @property
    def is_connected(self) -> bool:
        return self._connected

    # ------------------------------------------------------------------
    # One-shot full snapshot
    # ------------------------------------------------------------------

    def fetch_all(self, usb_channels: int = 18) -> Dict[int, ChannelStrip]:
        """
        Query every channel strip parameter synchronously.
        Returns the updated strips dict.
        Typically called once at startup; updates come via subscription after.
        """
        if not self._connected:
            return {}

        self._channel_map = _build_channel_map(usb_channels)

        for ch_num, prefix in self._channel_map:
            strip = self._fetch_strip(ch_num, prefix)
            with self._lock:
                self._strips[ch_num] = strip

        logger.info(
            f"Fetched channel strip data for {len(self._strips)} channels"
        )

        # Also fetch USB routing
        self.fetch_routing()

        return dict(self._strips)

    def _fetch_strip(self, ch_num: int, prefix: str) -> ChannelStrip:
        """Query all parameters for one channel strip."""
        strip = ChannelStrip(number=ch_num, osc_prefix=prefix)

        def _q(addr):
            return self._sock.query(addr)

        # Name
        r = _q(f'{prefix}/config/name')
        if r:
            strip.name = str(r[0]) if r else ''

        # Color
        r = _q(f'{prefix}/config/color')
        if r:
            strip.color = int(r[0])

        # Mute (mix/on: 1=unmuted, 0=muted)
        r = _q(f'{prefix}/mix/on')
        if r is not None:
            strip.muted = int(r[0]) == 0

        # Fader
        r = _q(f'{prefix}/mix/fader')
        if r:
            strip.fader = float(r[0])

        # Pan
        r = _q(f'{prefix}/mix/pan')
        if r:
            strip.pan = float(r[0])

        # Phantom (only available on mono channels)
        if '/ch/' in prefix:
            r = _q(f'{prefix}/preamp/phantom')
            if r:
                strip.phantom = bool(int(r[0]))

            # Gate
            r = _q(f'{prefix}/gate/on')
            if r:
                strip.gate_on = bool(int(r[0]))

            # Compressor
            r = _q(f'{prefix}/dyn/on')
            if r:
                strip.comp_on = bool(int(r[0]))

            # EQ
            r = _q(f'{prefix}/eq/on')
            if r:
                strip.eq_on = bool(int(r[0]))

        return strip

    # ------------------------------------------------------------------
    # Real-time subscription
    # ------------------------------------------------------------------

    def start_subscription(self) -> None:
        """
        Start a background thread that:
          1. Sends /xremote every 8 s to keep the push subscription alive.
          2. Receives pushed parameter changes and updates the strips cache.
          3. Calls registered on_update callbacks with (ch_num, strip).
        """
        if self._sub_thread and self._sub_thread.is_alive():
            return
        self._running = True
        self._sub_thread = threading.Thread(
            target=self._subscription_loop, daemon=True, name='osc-subscriber'
        )
        self._sub_thread.start()
        logger.info("OSC subscription started")

    def add_update_callback(self, cb: Callable) -> None:
        """Register a callback called with (channel_number, ChannelStrip) on change."""
        self._on_update_callbacks.append(cb)

    def _subscription_loop(self) -> None:
        """Background thread: renew /xremote and process push updates."""
        last_renew = 0.0
        # Open a dedicated receiving socket
        recv_sock = _OSCSocket(self.mixer_ip, self.mixer_port)
        try:
            recv_sock.open()
        except Exception as e:
            logger.error(f"OSC subscription socket error: {e}")
            return

        while self._running:
            now = time.monotonic()
            if now - last_renew >= _XREMOTE_INTERVAL_S:
                recv_sock.send('/xremote')
                last_renew = now

            result = recv_sock.recv_with_timeout(0.5)
            if result:
                addr, args = result
                self._handle_push(addr, args)

        recv_sock.close()

    def _handle_push(self, addr: str, args: List[Any]) -> None:
        """
        Handle a pushed parameter update from the mixer.
        Maps OSC address back to the correct strip and field.
        """
        if not args:
            return

        # USB routing update
        if addr == self._ROUTING_ADDR:
            routing = [int(v) for v in args[:self._USB_PAIRS]]
            with self._lock:
                self._routing = routing
            for cb in self._on_routing_callbacks:
                try:
                    cb(list(routing))
                except Exception as e:
                    logger.error(f"Routing push callback error: {e}")
            return

        with self._lock:
            for ch_num, prefix in self._channel_map:
                if not addr.startswith(prefix):
                    continue
                strip = self._strips.get(ch_num)
                if strip is None:
                    strip = ChannelStrip(number=ch_num, osc_prefix=prefix)
                    self._strips[ch_num] = strip

                suffix = addr[len(prefix):]
                val = args[0]

                if suffix == '/config/name':
                    strip.name = str(val)
                elif suffix == '/config/color':
                    strip.color = int(val)
                elif suffix == '/mix/on':
                    strip.muted = int(val) == 0
                elif suffix == '/mix/fader':
                    strip.fader = float(val)
                elif suffix == '/mix/pan':
                    strip.pan = float(val)
                elif suffix == '/preamp/phantom':
                    strip.phantom = bool(int(val))
                elif suffix == '/gate/on':
                    strip.gate_on = bool(int(val))
                elif suffix == '/dyn/on':
                    strip.comp_on = bool(int(val))
                elif suffix == '/eq/on':
                    strip.eq_on = bool(int(val))
                else:
                    return  # unhandled parameter

                # Notify callbacks
                for cb in self._on_update_callbacks:
                    try:
                        cb(ch_num, strip)
                    except Exception as e:
                        logger.error(f"OSC update callback error: {e}")
                return

    # ------------------------------------------------------------------
    # USB routing read / write
    # ------------------------------------------------------------------

    # Number of USB stereo pairs on the XR18 (9 pairs = 18 channels)
    _USB_PAIRS = 9
    _ROUTING_ADDR = '/config/routing/CARD'

    def fetch_routing(self) -> List[int]:
        """
        Query the mixer for current USB routing.
        Returns a list of _USB_PAIRS ints (source index per stereo pair),
        or an empty list if the mixer is not reachable.
        """
        if not self._connected:
            return []
        result = self._sock.query(self._ROUTING_ADDR, timeout=1.0)
        if result is None:
            logger.warning("fetch_routing: no response from mixer")
            return []
        routing = [int(v) for v in result[:self._USB_PAIRS]]
        with self._lock:
            self._routing = routing
        logger.info(f"Fetched USB routing: {routing}")
        return list(routing)

    def set_routing(self, pairs: List[int]) -> bool:
        """
        Write a full 9-int routing vector to /config/routing/CARD.
        Returns True on success (fire-and-forget — no ACK from mixer).
        """
        if not self._connected:
            return False
        if len(pairs) != self._USB_PAIRS:
            logger.error(
                f"set_routing: expected {self._USB_PAIRS} values, got {len(pairs)}"
            )
            return False
        self._sock.send(self._ROUTING_ADDR, *[int(v) for v in pairs])
        with self._lock:
            self._routing = list(pairs)
        logger.info(f"USB routing set: {pairs}")
        for cb in self._on_routing_callbacks:
            try:
                cb(list(pairs))
            except Exception as e:
                logger.error(f"Routing callback error: {e}")
        return True

    def set_routing_pair(self, pair_index: int, source_index: int) -> bool:
        """
        Change a single stereo pair's source.
        pair_index is 0-based (0 = USB ch 1-2, 8 = USB ch 17-18).
        """
        if not (0 <= pair_index < self._USB_PAIRS):
            logger.error(f"set_routing_pair: invalid pair index {pair_index}")
            return False
        # Fetch fresh if cache is empty
        current = self.get_routing()
        if not current:
            current = self.fetch_routing()
        if not current:
            # Can't fetch — send a minimal message with just what we know
            current = [0] * self._USB_PAIRS
        current[pair_index] = int(source_index)
        return self.set_routing(current)

    def add_routing_callback(self, cb: Callable) -> None:
        """Register a callback called with (routing: list[int]) when routing changes."""
        self._on_routing_callbacks.append(cb)

    # ------------------------------------------------------------------
    # Accessors
    # ------------------------------------------------------------------

    def get_strips(self) -> Dict[int, ChannelStrip]:
        with self._lock:
            return dict(self._strips)

    def get_strip(self, ch_num: int) -> Optional[ChannelStrip]:
        with self._lock:
            return self._strips.get(ch_num)

    def get_routing(self) -> List[int]:
        with self._lock:
            return list(self._routing)

    def get_channel_names(self) -> List[str]:
        """
        Return an ordered list of channel display names (1-based).
        Useful for replacing config.yaml channel names with mixer labels.
        """
        strips = self.get_strips()
        names = []
        for ch_num, _ in self._channel_map:
            strip = strips.get(ch_num)
            names.append(strip.display_name() if strip else f'Ch {ch_num}')
        return names
