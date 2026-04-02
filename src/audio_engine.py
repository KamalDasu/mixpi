"""
Core audio recording engine for MixPi
Handles multi-channel recording with auto-start and signal detection
"""

import sounddevice as sd
import soundfile as sf
import numpy as np
import threading
import queue
import time
import logging
from typing import Optional, List, Callable, Dict
from datetime import datetime
from pathlib import Path
import collections

from .mixer_detector import MixerDetector
from .mixer_profiles import MixerProfile


class AudioEngine:
    """
    Multi-channel audio recording engine
    
    Features:
    - Simultaneous recording of multiple channels to separate files
    - Auto-start recording on signal detection
    - Pre-roll buffer for capturing audio before trigger
    - Real-time level monitoring
    - Graceful shutdown with proper file finalization
    """
    
    def __init__(self, config: dict):
        """
        Initialize audio engine
        
        Args:
            config: Configuration dictionary
        """
        self.config = config
        self.logger = logging.getLogger('mixpi.audio_engine')
        
        # Run mixer detection before applying audio config
        self._detection_result = None
        self.mixer_profile: Optional[MixerProfile] = None
        device_setting = config['audio'].get('device', 'auto')

        if device_setting in (None, 'auto', 'Auto', 'AUTO'):
            detector = MixerDetector(config)
            self._detection_result = detector.detect()
            self.mixer_profile = self._detection_result.profile
            self.device = self._detection_result.device_name
        else:
            self.device = device_setting

        # Audio configuration – profile overrides sample_rate and channels (hardware limits),
        # but bit_depth always comes from config — the XR18 wire format is always float32
        # regardless, and soundfile converts to any depth when writing WAV files.
        if self.mixer_profile:
            cfg_rate = config['audio']['sample_rate']
            cfg_ch   = config['audio']['channels']
            self.sample_rate = (
                cfg_rate if self.mixer_profile.supports_sample_rate(cfg_rate)
                else self.mixer_profile.sample_rates[-1]
            )
            if cfg_rate != self.sample_rate:
                self.logger.warning(
                    f"Config sample_rate {cfg_rate}Hz not supported by "
                    f"{self.mixer_profile.name}. Using {self.sample_rate}Hz instead."
                )
            self.channels = min(cfg_ch, self.mixer_profile.usb_in)
            if cfg_ch > self.mixer_profile.usb_in:
                self.logger.warning(
                    f"Config requested {cfg_ch} channels but {self.mixer_profile.name} "
                    f"only provides {self.mixer_profile.usb_in}. Capping at "
                    f"{self.mixer_profile.usb_in}."
                )
            # Recording depth is user's choice — not the USB wire format
            self.bit_depth = config['audio']['bit_depth']
        else:
            self.sample_rate = config['audio']['sample_rate']
            self.channels    = config['audio']['channels']
            self.bit_depth   = config['audio']['bit_depth']

        self.buffer_size = config['audio']['buffer_size']
        
        # Recording state
        self.is_recording = False
        self.is_monitoring = False
        self.recording_thread: Optional[threading.Thread] = None
        self.audio_queue = queue.Queue()
        
        # File writers for each channel
        self.file_writers: List[Optional[sf.SoundFile]] = [None] * self.channels
        self.session_path: Optional[Path] = None
        
        # Auto-start configuration
        self.auto_start_enabled = config['recording']['auto_start']['enabled']
        self.auto_start_threshold = config['recording']['auto_start']['threshold_dbfs']
        self.silence_timeout = config['recording']['auto_start']['silence_timeout']
        self.pre_roll_seconds = config['recording']['pre_roll']
        
        # Pre-roll buffer — stores audio *blocks*, not individual samples.
        # maxlen must be in blocks: (seconds × rate) / block_size
        pre_roll_blocks = max(1, int(
            self.pre_roll_seconds * self.sample_rate / self.buffer_size
        ))
        self.pre_roll_buffer = collections.deque(maxlen=pre_roll_blocks)
        
        # Level monitoring
        self.current_levels: np.ndarray = np.zeros(self.channels)
        self.peak_levels: np.ndarray = np.zeros(self.channels)
        self.level_callbacks: List[Callable] = []
        
        # Auto-start state
        self.waiting_for_signal = False
        self.last_signal_time = 0
        self._monitor_start_time: float = 0.0
        self._auto_start_fired: bool = False  # prevent re-arm after trigger

        # Rate-limit overflow warnings: only log once per 60 s
        self._last_overflow_log: float = 0
        self._overflow_count: int = 0
        
        # Recording statistics
        self.frames_recorded = 0
        self.start_time: Optional[float] = None
        
        # Markers
        self.markers: List[Dict] = []
        
        if self.mixer_profile:
            self.logger.info(
                f"Mixer profile: {self.mixer_profile.name} — "
                f"{self.channels}ch @ {self.sample_rate}Hz / "
                f"{'Float32' if self.bit_depth == 32 else f'PCM_{self.bit_depth}'}"
            )
        else:
            self.logger.info(
                f"Audio engine initialized: {self.channels}ch @ "
                f"{self.sample_rate}Hz/{self.bit_depth}bit"
            )
        if self.device:
            self.logger.info(f"Audio device: {self.device}")
        else:
            self.logger.info("No specific audio device configured, using system default")
    
    def get_detection_info(self) -> dict:
        """Return a serialisable summary of mixer detection results."""
        r = self._detection_result
        profile = self.mixer_profile
        return {
            'method': r.method if r else 'manual',
            'osc_reachable': r.osc_reachable if r else False,
            'device_name': self.device or 'system default',
            # Pass active channels/sample_rate so bit-rate figures are accurate
            'profile': profile.to_dict(
                channels=self.channels,
                sample_rate=self.sample_rate,
            ) if profile else None,
        }

    def list_devices(self) -> List[Dict]:
        """
        List available audio devices
        
        Returns:
            List of device information dictionaries
        """
        devices = sd.query_devices()
        return [
            {
                'index': i,
                'name': dev['name'],
                'channels': dev['max_input_channels'],
                'sample_rate': dev['default_samplerate']
            }
            for i, dev in enumerate(devices)
            if dev['max_input_channels'] > 0
        ]
    
    def find_device(self) -> Optional[int]:
        """
        Find the configured audio device by name.
        Tries exact substring match first, then keyword match, then logs all
        available devices to help debug mismatches.
        Returns device index or None (system default).
        """
        if self.device is None:
            return None

        devices = sd.query_devices()
        needle = self.device.lower()

        # Pass 1: configured name is a substring of the ALSA device name
        for i, dev in enumerate(devices):
            if needle in dev['name'].lower() and dev['max_input_channels'] > 0:
                self.logger.info(f"Audio device matched: [{i}] {dev['name']}")
                return i

        # Pass 2: any word from the configured name matches
        words = [w for w in needle.split() if len(w) >= 3]
        for i, dev in enumerate(devices):
            name_lower = dev['name'].lower()
            if any(w in name_lower for w in words) and dev['max_input_channels'] > 0:
                self.logger.info(
                    f"Audio device partial match: [{i}] {dev['name']} "
                    f"(configured: '{self.device}')"
                )
                return i

        avail = [(i, d['name'], d['max_input_channels'])
                 for i, d in enumerate(devices) if d['max_input_channels'] > 0]
        self.logger.warning(
            f"Device '{self.device}' not found. Available input devices: {avail}"
        )
        return None
    
    def start_recording(
        self,
        session_path: Path,
        channel_names: List[str],
        enabled_channels: Optional[List[int]] = None,
    ) -> bool:
        """
        Start recording to files.

        Args:
            session_path:     Path to session directory
            channel_names:    List of channel names used for WAV filenames
            enabled_channels: 1-based list of channels to record, e.g. [1,2,5].
                              None (default) = record all channels.

        Returns:
            True if recording started successfully
        """
        if self.is_recording:
            self.logger.warning("Already recording")
            return False

        # Build a set of 0-based indices that are enabled
        if enabled_channels:
            enabled_set = {ch - 1 for ch in enabled_channels
                           if 1 <= ch <= self.channels}
        else:
            enabled_set = set(range(self.channels))

        if not enabled_set:
            self.logger.warning("No channels enabled — nothing to record")
            return False

        self.session_path = session_path
        session_path.mkdir(parents=True, exist_ok=True)

        # Determine WAV subtype based on configured bit depth
        # X Air 18 USB streams 32-bit float; other devices may differ
        subtype_map = {
            16: 'PCM_16',
            24: 'PCM_24',
            32: 'FLOAT',   # 32-bit float - correct for X Air 18
        }
        subtype = subtype_map.get(self.bit_depth, 'FLOAT')

        # Open file writers only for enabled channels
        try:
            for i in range(self.channels):
                if i not in enabled_set:
                    self.file_writers[i] = None  # skip this channel
                    continue

                channel_name = channel_names[i] if i < len(channel_names) else f"Ch{i+1:02d}"
                safe_name = "".join(
                    c for c in channel_name if c.isalnum() or c in (' ', '-', '_')
                ).strip().replace(' ', '_')

                # Name-first format: EKick_ch01.wav (falls back to ch01.wav if no name)
                if safe_name:
                    filename = session_path / f"{safe_name}_ch{i+1:02d}.wav"
                else:
                    filename = session_path / f"ch{i+1:02d}.wav"
                self.file_writers[i] = sf.SoundFile(
                    filename,
                    mode='w',
                    samplerate=self.sample_rate,
                    channels=1,
                    subtype=subtype,
                )
                self.logger.debug(f"Opened file: {filename}")

            self.logger.info(
                f"Armed channels: {sorted(i+1 for i in enabled_set)} "
                f"({len(enabled_set)}/{self.channels})"
            )

            # Write pre-roll buffer if available
            if len(self.pre_roll_buffer) > 0:
                pre_roll_secs = len(self.pre_roll_buffer) * self.buffer_size / self.sample_rate
                self.logger.info(
                    f"Writing pre-roll buffer: {len(self.pre_roll_buffer)} blocks "
                    f"({pre_roll_secs:.2f}s)"
                )
                pre_roll_data = list(self.pre_roll_buffer)
                for audio_data in pre_roll_data:
                    for ch in range(self.channels):
                        if self.file_writers[ch]:
                            self.file_writers[ch].write(audio_data[:, ch])
            
            self.is_recording = True
            self.frames_recorded = 0
            self.start_time = time.time()
            self.markers = []
            self.waiting_for_signal = False
            self._auto_start_fired = False  # allow auto-start again after next stop
            
            self.logger.info(f"Recording started: {session_path}")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to start recording: {e}")
            self._close_files()
            return False
    
    def stop_recording(self) -> bool:
        """
        Stop recording and close files
        
        Returns:
            True if recording stopped successfully
        """
        if not self.is_recording:
            self.logger.warning("Not recording")
            return False
        
        self.is_recording = False
        self._close_files()
        
        duration = time.time() - self.start_time if self.start_time else 0
        self.logger.info(f"Recording stopped. Duration: {duration:.1f}s, Frames: {self.frames_recorded}")
        
        return True
    
    def close_channel(self, channel_idx: int) -> bool:
        """Close a single channel's file writer mid-recording (un-arm).

        Args:
            channel_idx: 0-based channel index.
        Returns:
            True if the channel was closed, False if not recording or not active.
        """
        if not self.is_recording:
            return False
        if channel_idx < 0 or channel_idx >= self.channels:
            return False
        writer = self.file_writers[channel_idx]
        if writer is None:
            return False
        try:
            writer.close()
        except Exception as e:
            self.logger.error(f"Error closing channel {channel_idx + 1}: {e}")
        self.file_writers[channel_idx] = None
        self.logger.info(f"Channel {channel_idx + 1} unarmed mid-recording")
        return True

    def _close_files(self) -> None:
        """Close all open file writers"""
        for i, writer in enumerate(self.file_writers):
            if writer:
                try:
                    writer.close()
                    self.logger.debug(f"Closed file writer for channel {i+1}")
                except Exception as e:
                    self.logger.error(f"Error closing file writer {i}: {e}")
                self.file_writers[i] = None
    
    def add_marker(self, label: str = "") -> Dict:
        """
        Add a marker at current recording position
        
        Args:
            label: Optional marker label
            
        Returns:
            Marker dictionary with timestamp and position
        """
        if not self.is_recording:
            return {}
        
        marker = {
            'time': time.time() - self.start_time if self.start_time else 0,
            'frame': self.frames_recorded,
            'label': label,
            'timestamp': datetime.now().isoformat()
        }
        
        self.markers.append(marker)
        self.logger.info(f"Marker added: {marker['time']:.2f}s - {label}")
        
        return marker
    
    def start_monitoring(self) -> bool:
        """
        Start audio monitoring (without recording)
        
        Returns:
            True if monitoring started successfully
        """
        if self.is_monitoring:
            self.logger.warning("Already monitoring")
            return False
        
        self.is_monitoring = True
        self.waiting_for_signal = False  # held off until warm-up completes
        self._monitor_start_time = time.time()

        # Start audio stream
        self.recording_thread = threading.Thread(target=self._audio_callback_thread, daemon=True)
        self.recording_thread.start()
        
        self.logger.info("Audio monitoring started")
        if self.waiting_for_signal:
            threshold_linear = 10 ** (self.auto_start_threshold / 20.0)
            self.logger.info(f"Waiting for signal above {self.auto_start_threshold} dBFS (linear: {threshold_linear:.4f})")
        
        return True
    
    def stop_monitoring(self) -> bool:
        """
        Stop audio monitoring
        
        Returns:
            True if monitoring stopped successfully
        """
        if not self.is_monitoring:
            return False
        
        self.is_monitoring = False
        
        if self.recording_thread:
            self.recording_thread.join(timeout=2.0)
        
        self.logger.info("Audio monitoring stopped")
        return True
    
    def update_settings(self, sample_rate: int, bit_depth: int) -> bool:
        """
        Apply new sample_rate and bit_depth, restarting the audio stream.
        Safe to call at any time when not recording.

        Returns True on success.
        """
        was_monitoring = self.is_monitoring
        if was_monitoring:
            self.stop_monitoring()
            time.sleep(0.3)   # give the OS a moment to release the device

        self.sample_rate = sample_rate
        self.bit_depth = bit_depth
        self.logger.info(f"Settings updated: {sample_rate} Hz / {bit_depth}-bit")

        if was_monitoring:
            return self.start_monitoring()
        return True

    def _audio_callback_thread(self) -> None:
        """Audio callback thread that processes incoming audio"""
        device_index = self.find_device()
        
        dtype = 'float32'

        # Cap channel count to what the device actually supports so we don't
        # get overflow errors on stereo mics / VM virtual audio devices.
        actual_channels = self.channels
        try:
            dev_info = sd.query_devices(device_index or sd.default.device[0])
            max_in = int(dev_info.get('max_input_channels', self.channels))
            if max_in < self.channels:
                self.logger.warning(
                    f"Device supports only {max_in} input channels "
                    f"(config requests {self.channels}). "
                    f"Recording {max_in} channels."
                )
                actual_channels = max_in
        except Exception:
            pass

        # Always use the device's hardware sample rate — the XR18 (and other
        # USB mixers) lock the rate in firmware (e.g. via X Air Edit).
        # Reading default_samplerate gives us whatever the mixer is currently
        # configured to (44100 or 48000), so we never need to guess or fall back.
        try:
            dev_info = sd.query_devices(device_index or sd.default.device[0])
            hw_rate = int(dev_info.get('default_samplerate', self.sample_rate))
        except Exception:
            hw_rate = self.sample_rate

        if hw_rate != self.sample_rate:
            self.logger.info(
                f"Device native rate {hw_rate} Hz differs from config "
                f"{self.sample_rate} Hz — using hardware rate"
            )
        actual_rate = hw_rate
        self.sample_rate = actual_rate  # keep engine state in sync with hardware

        try:
            with sd.InputStream(
                device=device_index,
                channels=actual_channels,
                samplerate=actual_rate,
                blocksize=self.buffer_size,
                dtype=dtype,
                callback=self._audio_callback
            ):
                self.logger.info(
                    f"Audio stream started — device: {device_index}, "
                    f"channels: {actual_channels}, "
                    f"rate: {actual_rate} Hz"
                )
                while self.is_monitoring:
                    time.sleep(0.1)

        except Exception as e:
            self.logger.error(f"Audio stream error: {e}")
            self.is_monitoring = False
    
    def _audio_callback(self, indata: np.ndarray, frames: int, time_info, status) -> None:
        """
        Audio callback function called by sounddevice
        
        Args:
            indata: Input audio data (frames x channels)
            frames: Number of frames
            time_info: Timing information
            status: Stream status
        """
        if status:
            now = time.time()
            self._overflow_count += 1
            if now - self._last_overflow_log >= 60.0:
                self.logger.warning(
                    f"Audio callback status: {status} "
                    f"(x{self._overflow_count} in last 60s)"
                )
                self._last_overflow_log = now
                self._overflow_count = 0
        
        # Make a copy of the data
        audio_data = indata.copy()

        # 2-second warm-up: arm auto-start once after the stream settles.
        # _auto_start_fired prevents re-arming until recording resets it.
        if (not self.waiting_for_signal
                and self.auto_start_enabled
                and not self.is_recording
                and not self._auto_start_fired):
            if time.time() - self._monitor_start_time >= 2.0:
                self.waiting_for_signal = True

        # Update level monitoring
        self._update_levels(audio_data)
        
        # Add to pre-roll buffer if not recording
        if not self.is_recording:
            self.pre_roll_buffer.append(audio_data)
        
        # Check for auto-start trigger
        if self.waiting_for_signal and not self.is_recording:
            max_level = np.max(np.abs(audio_data))
            threshold_linear = 10 ** (self.auto_start_threshold / 20.0)
            
            if max_level > threshold_linear:
                self.logger.info(f"Signal detected! Level: {max_level:.4f}, Threshold: {threshold_linear:.4f}")
                self.waiting_for_signal = False
                self._auto_start_fired = True  # hold off re-arm until recording starts
                # Trigger auto-start (will be handled by external controller)
                for callback in self.level_callbacks:
                    try:
                        callback('auto_start_triggered', {})
                    except Exception as e:
                        self.logger.error(f"Error in callback: {e}")
        
        # Write to files if recording
        if self.is_recording:
            try:
                for ch in range(self.channels):
                    if self.file_writers[ch]:
                        self.file_writers[ch].write(audio_data[:, ch])
                
                self.frames_recorded += frames
                
                # Check for silence timeout (auto-stop)
                if self.auto_start_enabled and self.silence_timeout > 0:
                    max_level = np.max(np.abs(audio_data))
                    threshold_linear = 10 ** (self.auto_start_threshold / 20.0)
                    
                    if max_level > threshold_linear:
                        self.last_signal_time = time.time()
                    elif self.last_signal_time > 0:
                        silence_duration = time.time() - self.last_signal_time
                        if silence_duration > self.silence_timeout:
                            self.logger.info(f"Silence timeout reached: {silence_duration:.1f}s")
                            # Reset to prevent repeated triggers
                            self.last_signal_time = 0
                            # Trigger auto-stop
                            for callback in self.level_callbacks:
                                try:
                                    callback('auto_stop_triggered', {})
                                except Exception as e:
                                    self.logger.error(f"Error in callback: {e}")
                            
            except Exception as e:
                self.logger.error(f"Error writing audio data: {e}")
    
    def _update_levels(self, audio_data: np.ndarray) -> None:
        """
        Update current and peak levels
        
        Args:
            audio_data: Audio data array (frames x channels)
        """
        # audio_data may have fewer channels than self.channels if the device
        # was capped at open time — pad to full width with silence.
        actual_ch = audio_data.shape[1] if audio_data.ndim > 1 else 1
        if actual_ch < self.channels:
            pad = np.zeros((audio_data.shape[0], self.channels - actual_ch), dtype=np.float32)
            audio_data = np.concatenate([audio_data, pad], axis=1)

        # RMS per channel (linear)
        rms_linear = np.sqrt(np.mean(audio_data ** 2, axis=0))
        self.current_levels = rms_linear

        # Instantaneous peak per channel (linear)
        peaks_linear = np.max(np.abs(audio_data), axis=0)
        self.peak_levels = np.maximum(self.peak_levels, peaks_linear)

        # Convert to dBFS for the UI  (floor at -90 dB)
        def to_db(linear: np.ndarray) -> list:
            with np.errstate(divide='ignore'):
                db = 20.0 * np.log10(np.maximum(linear, 1e-9))
            return np.maximum(db, -90.0).tolist()

        # Notify callbacks with dBFS values so meters display correctly
        for callback in self.level_callbacks:
            try:
                callback('levels', {
                    'rms':      to_db(rms_linear),
                    'peak':     to_db(peaks_linear),
                    'peak_hold': to_db(self.peak_levels),
                })
            except Exception as e:
                self.logger.error(f"Error in level callback: {e}")
    
    def reset_peak_levels(self) -> None:
        """Reset peak level indicators"""
        self.peak_levels = np.zeros(self.channels)
    
    def add_level_callback(self, callback: Callable) -> None:
        """
        Add callback for level updates
        
        Args:
            callback: Function to call with level data
        """
        self.level_callbacks.append(callback)
    
    def get_recording_info(self) -> Dict:
        """
        Get current recording information
        
        Returns:
            Dictionary with recording stats
        """
        duration = time.time() - self.start_time if self.start_time and self.is_recording else 0
        
        # Which channels (1-based) have active file writers right now
        armed = [i + 1 for i, w in enumerate(self.file_writers) if w is not None]

        return {
            'is_recording': self.is_recording,
            'is_monitoring': self.is_monitoring,
            'duration': duration,
            'frames': self.frames_recorded,
            'sample_rate': self.sample_rate,
            'channels': self.channels,
            'armed_channels': armed,
            'markers': len(self.markers),
            'waiting_for_signal': self.waiting_for_signal,
        }
