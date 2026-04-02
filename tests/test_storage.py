"""
Unit tests for StorageManager
"""

import unittest
import tempfile
import shutil
from pathlib import Path
from src.storage_manager import StorageManager


class TestStorageManager(unittest.TestCase):
    """Test cases for StorageManager"""
    
    def setUp(self):
        """Set up test fixtures"""
        self.temp_dir = tempfile.mkdtemp()
        
        self.config = {
            'recording': {
                'storage_path': self.temp_dir,
                'file_format': 'wav'
            }
        }
        
        self.storage = StorageManager(self.config)
    
    def tearDown(self):
        """Clean up test fixtures"""
        if Path(self.temp_dir).exists():
            shutil.rmtree(self.temp_dir)
    
    def test_initialization(self):
        """Test storage manager initialization"""
        self.assertEqual(str(self.storage.storage_path), self.temp_dir)
        self.assertEqual(self.storage.file_format, 'wav')
        self.assertTrue(self.storage.storage_path.exists())
    
    def test_create_session(self):
        """Test creating a new session"""
        metadata = {
            'venue': 'Test Venue',
            'artist': 'Test Artist'
        }
        
        session_path = self.storage.create_session(metadata)
        
        self.assertTrue(session_path.exists())
        self.assertTrue(session_path.is_dir())
        
        # Check metadata file
        metadata_file = session_path / "session.json"
        self.assertTrue(metadata_file.exists())
    
    def test_save_load_metadata(self):
        """Test saving and loading metadata"""
        session_path = self.storage.create_session()
        
        metadata = {
            'venue': 'Test Venue',
            'artist': 'Test Artist',
            'engineer': 'Test Engineer',
            'notes': 'Test notes'
        }
        
        self.storage.save_metadata(session_path, metadata)
        loaded = self.storage.load_metadata(session_path)
        
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded['venue'], 'Test Venue')
        self.assertEqual(loaded['artist'], 'Test Artist')
        self.assertIn('timestamp', loaded)
    
    def test_save_markers(self):
        """Test saving markers"""
        session_path = self.storage.create_session()
        
        markers = [
            {'time': 10.5, 'frame': 504000, 'label': 'Marker 1', 'timestamp': '2026-03-25T10:00:00'},
            {'time': 25.3, 'frame': 1214400, 'label': 'Marker 2', 'timestamp': '2026-03-25T10:00:15'}
        ]
        
        self.storage.save_markers(session_path, markers)
        
        markers_file = session_path / "markers.csv"
        self.assertTrue(markers_file.exists())
        
        # Read and verify
        with open(markers_file, 'r') as f:
            lines = f.readlines()
            self.assertEqual(len(lines), 3)  # Header + 2 markers
    
    def test_get_sessions(self):
        """Test getting list of sessions"""
        import time
        # Create multiple sessions with a small delay to ensure different timestamps
        session1 = self.storage.create_session({'session_name': 'Session1', 'artist': 'Artist 1'})
        time.sleep(1.1)
        session2 = self.storage.create_session({'session_name': 'Session2', 'artist': 'Artist 2'})
        
        sessions = self.storage.get_sessions()
        
        self.assertIsInstance(sessions, list)
        self.assertGreaterEqual(len(sessions), 2)
    
    def test_get_session_info(self):
        """Test getting session information"""
        session_path = self.storage.create_session({'artist': 'Test Artist'})
        
        # Create a dummy audio file
        test_file = session_path / "ch01_test.wav"
        test_file.write_text("dummy audio data")
        
        info = self.storage.get_session_info(session_path)
        
        self.assertIsNotNone(info)
        self.assertIn('name', info)
        self.assertIn('path', info)
        self.assertIn('files', info)
        self.assertIn('size', info)
        self.assertEqual(info['files'], 1)
    
    def test_delete_session(self):
        """Test deleting a session"""
        session_path = self.storage.create_session()
        
        self.assertTrue(session_path.exists())
        
        success = self.storage.delete_session(session_path)
        
        self.assertTrue(success)
        self.assertFalse(session_path.exists())
    
    def test_get_disk_space(self):
        """Test getting disk space information"""
        space = self.storage.get_disk_space()
        
        self.assertIn('total', space)
        self.assertIn('used', space)
        self.assertIn('free', space)
        self.assertIn('percent_used', space)
        
        self.assertGreater(space['total'], 0)
        self.assertGreaterEqual(space['free'], 0)
    
    def test_check_disk_space(self):
        """Test checking available disk space"""
        # Should have at least 0.001 GB available
        result = self.storage.check_disk_space(0.001)
        self.assertTrue(result)
        
        # Should not have 1000000 GB available
        result = self.storage.check_disk_space(1000000)
        self.assertFalse(result)
    
    def test_estimate_recording_time(self):
        """Test estimating available recording time"""
        hours = self.storage.estimate_recording_time(
            sample_rate=48000,
            channels=18,
            bit_depth=24
        )
        
        self.assertIsInstance(hours, float)
        self.assertGreater(hours, 0)


if __name__ == '__main__':
    unittest.main()
