"""
Unit tests for AudioEngine
"""

import unittest
import numpy as np
from pathlib import Path
import tempfile
import shutil
from src.audio_engine import AudioEngine


class TestAudioEngine(unittest.TestCase):
    """Test cases for AudioEngine"""
    
    def setUp(self):
        """Set up test fixtures"""
        self.config = {
            'audio': {
                'device': None,
                'sample_rate': 48000,
                'channels': 18,
                'bit_depth': 24,
                'buffer_size': 512
            },
            'recording': {
                'auto_start': {
                    'enabled': False,
                    'threshold_dbfs': -40,
                    'silence_timeout': 5
                },
                'pre_roll': 2
            }
        }
        
        self.temp_dir = tempfile.mkdtemp()
        self.engine = AudioEngine(self.config)
    
    def tearDown(self):
        """Clean up test fixtures"""
        if self.engine.is_monitoring:
            self.engine.stop_monitoring()
        if self.engine.is_recording:
            self.engine.stop_recording()
        
        # Clean up temp directory
        if Path(self.temp_dir).exists():
            shutil.rmtree(self.temp_dir)
    
    def test_initialization(self):
        """Test engine initialization"""
        self.assertEqual(self.engine.sample_rate, 48000)
        self.assertEqual(self.engine.channels, 18)
        self.assertEqual(self.engine.bit_depth, 24)
        self.assertFalse(self.engine.is_recording)
        self.assertFalse(self.engine.is_monitoring)
    
    def test_list_devices(self):
        """Test listing audio devices"""
        devices = self.engine.list_devices()
        self.assertIsInstance(devices, list)
        # Should have at least one input device (or none in CI)
        for device in devices:
            self.assertIn('name', device)
            self.assertIn('channels', device)
    
    def test_recording_info(self):
        """Test getting recording info"""
        info = self.engine.get_recording_info()
        
        self.assertIn('is_recording', info)
        self.assertIn('is_monitoring', info)
        self.assertIn('duration', info)
        self.assertIn('frames', info)
        self.assertIn('sample_rate', info)
        self.assertIn('channels', info)
        
        self.assertFalse(info['is_recording'])
        self.assertEqual(info['sample_rate'], 48000)
        self.assertEqual(info['channels'], 18)
    
    def test_marker_without_recording(self):
        """Test adding marker when not recording"""
        marker = self.engine.add_marker("Test Marker")
        self.assertEqual(marker, {})
    
    def test_level_callback(self):
        """Test level callback registration"""
        callback_called = []
        
        def test_callback(event_type, data):
            callback_called.append((event_type, data))
        
        self.engine.add_level_callback(test_callback)
        self.assertEqual(len(self.engine.level_callbacks), 1)
    
    def test_peak_reset(self):
        """Test peak level reset"""
        # Set some peak levels
        self.engine.peak_levels = np.array([0.5] * 18)
        
        # Reset
        self.engine.reset_peak_levels()
        
        # Check all zeros
        self.assertTrue(np.all(self.engine.peak_levels == 0))


class TestAudioEngineRecording(unittest.TestCase):
    """Test cases for recording functionality"""
    
    def setUp(self):
        """Set up test fixtures"""
        self.config = {
            'audio': {
                'device': None,
                'sample_rate': 48000,
                'channels': 2,  # Use 2 channels for testing
                'bit_depth': 16,
                'buffer_size': 512
            },
            'recording': {
                'auto_start': {
                    'enabled': False,
                    'threshold_dbfs': -40,
                    'silence_timeout': 5
                },
                'pre_roll': 0
            }
        }
        
        self.temp_dir = Path(tempfile.mkdtemp())
        self.engine = AudioEngine(self.config)
    
    def tearDown(self):
        """Clean up test fixtures"""
        if self.engine.is_recording:
            self.engine.stop_recording()
        
        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir)
    
    def test_start_stop_recording(self):
        """Test starting and stopping recording"""
        session_path = self.temp_dir / "test_session"
        channel_names = ["Ch1", "Ch2"]
        
        # Start recording
        success = self.engine.start_recording(session_path, channel_names)
        self.assertTrue(success)
        self.assertTrue(self.engine.is_recording)
        self.assertTrue(session_path.exists())
        
        # Stop recording
        success = self.engine.stop_recording()
        self.assertTrue(success)
        self.assertFalse(self.engine.is_recording)
        
        # Check files were created
        wav_files = list(session_path.glob("*.wav"))
        self.assertEqual(len(wav_files), 2)
    
    def test_add_marker_during_recording(self):
        """Test adding markers during recording"""
        session_path = self.temp_dir / "test_session"
        channel_names = ["Ch1", "Ch2"]
        
        # Start recording
        self.engine.start_recording(session_path, channel_names)
        
        # Add marker
        marker = self.engine.add_marker("Test Marker")
        
        self.assertIsInstance(marker, dict)
        self.assertIn('time', marker)
        self.assertIn('label', marker)
        self.assertEqual(marker['label'], "Test Marker")
        self.assertEqual(len(self.engine.markers), 1)
        
        # Stop recording
        self.engine.stop_recording()


if __name__ == '__main__':
    unittest.main()
