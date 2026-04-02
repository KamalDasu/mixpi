"""
X Air OSC Client
Integrates with Behringer X Air mixer via OSC
"""

import logging
from typing import Optional, List, Callable
import threading
import time

try:
    import xair_api
    XAIR_AVAILABLE = True
except ImportError:
    XAIR_AVAILABLE = False
    logging.warning("xair-api not available. X Air integration disabled.")


class XAirClient:
    """
    X Air mixer OSC client
    
    Features:
    - Connect to X Air mixer
    - Sync channel names from mixer
    - Read mute/solo status
    - Monitor mixer state
    """
    
    def __init__(self, config: dict):
        """
        Initialize X Air client
        
        Args:
            config: Configuration dictionary
        """
        self.config = config
        self.logger = logging.getLogger('mixpi.xair')
        
        self.enabled = config['osc']['enabled'] and XAIR_AVAILABLE
        self.ip = config['osc']['xair_ip']
        self.port = config['osc']['xair_port']
        
        self.mixer: Optional[any] = None
        self.connected = False
        self.monitor_thread: Optional[threading.Thread] = None
        self.is_monitoring = False
        
        self.callbacks: List[Callable] = []
        
        if not XAIR_AVAILABLE:
            self.logger.warning("xair-api library not installed. X Air integration disabled.")
            self.enabled = False
    
    def connect(self) -> bool:
        """
        Connect to X Air mixer
        
        Returns:
            True if connected successfully
        """
        if not self.enabled:
            self.logger.info("X Air integration disabled")
            return False
        
        try:
            self.logger.info(f"Connecting to X Air at {self.ip}:{self.port}")
            
            # Connect to mixer (XR18 model)
            self.mixer = xair_api.connect('XR18', ip=self.ip, port=self.port)
            
            self.connected = True
            self.logger.info("Connected to X Air mixer")
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to connect to X Air: {e}")
            self.connected = False
            return False
    
    def disconnect(self) -> None:
        """Disconnect from X Air mixer"""
        if self.mixer:
            try:
                # Stop monitoring
                self.stop_monitoring()
                
                # Disconnect
                self.mixer = None
                self.connected = False
                
                self.logger.info("Disconnected from X Air mixer")
            except Exception as e:
                self.logger.error(f"Error disconnecting: {e}")
    
    def get_channel_names(self) -> List[str]:
        """
        Get channel names from mixer
        
        Returns:
            List of channel names
        """
        if not self.connected or not self.mixer:
            return []
        
        try:
            names = []
            
            # Get names for all 18 input channels
            for i in range(18):
                try:
                    # X Air channel indexing starts at 0
                    name = self.mixer.strip[i].config.name
                    names.append(name if name else f"Ch {i+1}")
                except Exception as e:
                    self.logger.debug(f"Could not get name for channel {i}: {e}")
                    names.append(f"Ch {i+1}")
            
            self.logger.info(f"Retrieved {len(names)} channel names from mixer")
            return names
            
        except Exception as e:
            self.logger.error(f"Failed to get channel names: {e}")
            return []
    
    def get_channel_mute_status(self, channel: int) -> Optional[bool]:
        """
        Get mute status for a channel
        
        Args:
            channel: Channel index (0-17)
            
        Returns:
            True if muted, False if not, None if error
        """
        if not self.connected or not self.mixer:
            return None
        
        try:
            # Get mute status (on=unmuted, off=muted in X Air)
            is_on = self.mixer.strip[channel].mix.on
            return not is_on  # Invert because on=unmuted
        except Exception as e:
            self.logger.error(f"Failed to get mute status for channel {channel}: {e}")
            return None
    
    def start_monitoring(self, interval: float = 5.0) -> None:
        """
        Start monitoring mixer state
        
        Args:
            interval: Monitoring interval in seconds
        """
        if not self.connected or self.is_monitoring:
            return
        
        self.is_monitoring = True
        self.monitor_thread = threading.Thread(
            target=self._monitor_loop,
            args=(interval,),
            daemon=True
        )
        self.monitor_thread.start()
        
        self.logger.info("Started X Air monitoring")
    
    def stop_monitoring(self) -> None:
        """Stop monitoring mixer state"""
        if not self.is_monitoring:
            return
        
        self.is_monitoring = False
        
        if self.monitor_thread:
            self.monitor_thread.join(timeout=2.0)
        
        self.logger.info("Stopped X Air monitoring")
    
    def _monitor_loop(self, interval: float) -> None:
        """
        Monitoring loop
        
        Args:
            interval: Monitoring interval in seconds
        """
        while self.is_monitoring:
            try:
                # Get channel names periodically
                names = self.get_channel_names()
                
                if names:
                    # Notify callbacks
                    for callback in self.callbacks:
                        try:
                            callback('channel_names_updated', {'names': names})
                        except Exception as e:
                            self.logger.error(f"Error in callback: {e}")
                
            except Exception as e:
                self.logger.error(f"Error in monitoring loop: {e}")
            
            time.sleep(interval)
    
    def add_callback(self, callback: Callable) -> None:
        """
        Add callback for mixer events
        
        Args:
            callback: Function to call with event data
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
