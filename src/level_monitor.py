"""
Real-time audio level monitoring for MixPi recorder
Provides RMS and peak level calculation with configurable update rate
"""

import numpy as np
import time
import threading
import logging
from typing import Callable, List, Dict, Optional


class LevelMonitor:
    """
    Real-time audio level monitor
    
    Features:
    - RMS and peak level calculation
    - Configurable update rate
    - Peak hold with decay
    - Multiple callback support
    """
    
    def __init__(self, config: dict, channels: int):
        """
        Initialize level monitor
        
        Args:
            config: Configuration dictionary
            channels: Number of audio channels
        """
        self.config = config
        self.channels = channels
        self.logger = logging.getLogger('mixpi.level_monitor')
        
        # Configuration
        self.update_rate = config['monitoring']['update_rate'] / 1000.0  # Convert to seconds
        self.peak_hold_time = config['monitoring']['peak_hold'] / 1000.0  # Convert to seconds
        
        # Level data
        self.rms_levels: np.ndarray = np.zeros(channels)
        self.peak_levels: np.ndarray = np.zeros(channels)
        self.peak_hold_levels: np.ndarray = np.zeros(channels)
        self.peak_hold_times: np.ndarray = np.zeros(channels)
        
        # Callbacks
        self.callbacks: List[Callable] = []
        
        # Monitoring thread
        self.is_monitoring = False
        self.monitor_thread: Optional[threading.Thread] = None
        
        self.logger.info(f"Level monitor initialized: {channels} channels, {self.update_rate*1000:.0f}ms update rate")
    
    def start(self) -> None:
        """Start level monitoring"""
        if self.is_monitoring:
            return
        
        self.is_monitoring = True
        self.monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self.monitor_thread.start()
        
        self.logger.debug("Level monitoring started")
    
    def stop(self) -> None:
        """Stop level monitoring"""
        if not self.is_monitoring:
            return
        
        self.is_monitoring = False
        
        if self.monitor_thread:
            self.monitor_thread.join(timeout=1.0)
        
        self.logger.debug("Level monitoring stopped")
    
    def update_levels(self, rms: np.ndarray, peak: np.ndarray) -> None:
        """
        Update level data
        
        Args:
            rms: RMS levels for each channel
            peak: Peak levels for each channel
        """
        self.rms_levels = rms.copy()
        self.peak_levels = peak.copy()
        
        # Update peak hold
        current_time = time.time()
        for i in range(self.channels):
            if peak[i] > self.peak_hold_levels[i]:
                self.peak_hold_levels[i] = peak[i]
                self.peak_hold_times[i] = current_time
            elif current_time - self.peak_hold_times[i] > self.peak_hold_time:
                # Decay peak hold
                self.peak_hold_levels[i] = peak[i]
    
    def reset_peaks(self) -> None:
        """Reset peak hold levels"""
        self.peak_hold_levels = np.zeros(self.channels)
        self.peak_hold_times = np.zeros(self.channels)
    
    def get_levels(self) -> Dict:
        """
        Get current levels
        
        Returns:
            Dictionary with RMS, peak, and peak hold levels
        """
        return {
            'rms': self._to_db(self.rms_levels).tolist(),
            'peak': self._to_db(self.peak_levels).tolist(),
            'peak_hold': self._to_db(self.peak_hold_levels).tolist()
        }
    
    def _to_db(self, linear: np.ndarray) -> np.ndarray:
        """
        Convert linear amplitude to decibels
        
        Args:
            linear: Linear amplitude values
            
        Returns:
            Values in decibels
        """
        # Avoid log of zero
        linear = np.maximum(linear, 1e-10)
        return 20 * np.log10(linear)
    
    def add_callback(self, callback: Callable) -> None:
        """
        Add callback for level updates
        
        Args:
            callback: Function to call with level data
        """
        self.callbacks.append(callback)
    
    def remove_callback(self, callback: Callable) -> None:
        """
        Remove callback
        
        Args:
            callback: Callback function to remove
        """
        if callback in self.callbacks:
            self.callbacks.remove(callback)
    
    def _monitor_loop(self) -> None:
        """Monitoring loop that broadcasts level updates"""
        while self.is_monitoring:
            # Get current levels
            levels = self.get_levels()
            
            # Broadcast to callbacks
            for callback in self.callbacks:
                try:
                    callback(levels)
                except Exception as e:
                    self.logger.error(f"Error in level callback: {e}")
            
            # Sleep until next update
            time.sleep(self.update_rate)
