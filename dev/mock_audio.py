"""
Mock Audio Device for Development
Simulates X Air 18 without actual hardware
"""

import numpy as np
import time
import threading
from typing import Optional, Callable


class MockAudioDevice:
    """
    Mock audio device that simulates 18-channel recording
    Useful for development and testing without hardware
    """
    
    def __init__(self, sample_rate: int = 48000, channels: int = 18):
        """
        Initialize mock audio device
        
        Args:
            sample_rate: Sample rate in Hz
            channels: Number of channels
        """
        self.sample_rate = sample_rate
        self.channels = channels
        self.is_running = False
        self.callback: Optional[Callable] = None
        self.thread: Optional[threading.Thread] = None
        
    def start(self, callback: Callable, blocksize: int = 512):
        """
        Start mock audio stream
        
        Args:
            callback: Callback function to receive audio data
            blocksize: Number of frames per callback
        """
        if self.is_running:
            return
        
        self.callback = callback
        self.is_running = True
        self.thread = threading.Thread(
            target=self._generate_audio,
            args=(blocksize,),
            daemon=True
        )
        self.thread.start()
    
    def stop(self):
        """Stop mock audio stream"""
        self.is_running = False
        if self.thread:
            self.thread.join(timeout=1.0)
    
    def _generate_audio(self, blocksize: int):
        """
        Generate mock audio data.

        Each channel gets a sine wave at a unique frequency plus a noise floor
        so that all 18 meters are visibly active and clearly distinct.
        Channels 1-4 are louder (drums / bass) and the rest softer.
        """
        frame_duration = blocksize / self.sample_rate
        t = 0.0  # running time counter (seconds)

        # Base frequencies spread across the audible range, one per channel
        base_freqs = [
            80, 120, 200, 300, 440, 660, 880, 1000,
            1200, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 6000, 8000,
        ]

        while self.is_running:
            frames = np.arange(blocksize)
            ts = t + frames / self.sample_rate
            audio_data = np.zeros((blocksize, self.channels), dtype=np.float32)

            for ch in range(self.channels):
                freq = base_freqs[ch % len(base_freqs)]
                # First 4 channels louder to simulate kick/snare/bass
                amplitude = 0.35 if ch < 4 else 0.12
                # Slow amplitude envelope to simulate natural playing dynamics
                envelope = 0.6 + 0.4 * np.sin(2 * np.pi * 0.5 * ts)
                sine = np.sin(2 * np.pi * freq * ts).astype(np.float32)
                noise = np.random.normal(0, 0.01, blocksize).astype(np.float32)
                audio_data[:, ch] = (amplitude * envelope * sine + noise).astype(np.float32)

            t += blocksize / self.sample_rate

            if self.callback:
                try:
                    self.callback(audio_data, blocksize, None, None)
                except Exception as e:
                    print(f"Error in mock audio callback: {e}")

            time.sleep(frame_duration)
    
    @staticmethod
    def list_devices():
        """
        List mock devices
        
        Returns:
            List of mock device info
        """
        return [{
            'index': 0,
            'name': 'Mock X Air 18',
            'channels': 18,
            'sample_rate': 48000
        }]


def _mock_query_devices():
    """
    Return a device list in the format sounddevice.query_devices() produces
    so that MixerDetector and AudioEngine can iterate over it normally.
    """
    return [
        {
            'name': 'Mock X Air 18',
            'max_input_channels': 18,
            'max_output_channels': 18,
            'default_samplerate': 48000,
            'hostapi': 0,
        }
    ]


def patch_sounddevice():
    """
    Patch sounddevice module to use mock device.
    Must be called before AudioEngine / MixerDetector are instantiated.
    """
    import sys
    from unittest.mock import MagicMock

    mock_sd = MagicMock()
    mock_sd.InputStream = MockInputStream
    mock_sd.query_devices = _mock_query_devices
    # default.device used by /api/devices fallback
    mock_sd.default.device = [0, 0]

    sys.modules['sounddevice'] = mock_sd


class MockInputStream:
    """Mock InputStream compatible with sounddevice.InputStream"""

    def __init__(self, device=None, channels=18, samplerate=48000,
                 blocksize=512, dtype='float32', callback=None):
        """Initialize mock input stream"""
        self.device = MockAudioDevice(samplerate, channels)
        self.callback = callback
        self.blocksize = blocksize
        
    def __enter__(self):
        """Context manager entry"""
        if self.callback:
            self.device.start(self.callback, self.blocksize)
        return self
    
    def __exit__(self, *args):
        """Context manager exit"""
        self.device.stop()


# Example usage
if __name__ == '__main__':
    print("Mock Audio Device Test")
    print("=" * 50)
    
    def audio_callback(indata, frames, time_info, status):
        """Test callback"""
        rms = np.sqrt(np.mean(indata ** 2, axis=0))
        peak = np.max(np.abs(indata), axis=0)
        
        print(f"Frames: {frames}, RMS: {rms[0]:.4f}, Peak: {peak[0]:.4f}")
    
    device = MockAudioDevice()
    device.start(audio_callback, blocksize=512)
    
    try:
        print("Generating mock audio for 5 seconds...")
        time.sleep(5)
    finally:
        device.stop()
        print("Stopped")
