"""
OSC Command Server
Receives OSC commands to control the recorder
"""

import logging
from typing import Optional, Callable, Dict
import threading

try:
    from pythonosc import dispatcher
    from pythonosc import osc_server
    OSC_AVAILABLE = True
except ImportError:
    OSC_AVAILABLE = False
    logging.warning("python-osc not available. OSC server disabled.")


class OSCServer:
    """
    OSC command server for remote control
    
    Supports commands:
    - /mixpi/record/start - Start recording
    - /mixpi/record/stop - Stop recording
    - /mixpi/record/marker - Add marker
    - /mixpi/status - Get status
    """
    
    def __init__(self, config: dict):
        """
        Initialize OSC server
        
        Args:
            config: Configuration dictionary
        """
        self.config = config
        self.logger = logging.getLogger('mixpi.osc_server')
        
        self.enabled = config['osc']['enabled'] and OSC_AVAILABLE
        self.port = config['osc']['server_port']
        
        self.server: Optional[any] = None
        self.server_thread: Optional[threading.Thread] = None
        self.is_running = False
        
        self.command_handlers: Dict[str, Callable] = {}
        
        if not OSC_AVAILABLE:
            self.logger.warning("python-osc library not installed. OSC server disabled.")
            self.enabled = False
    
    def register_handler(self, command: str, handler: Callable) -> None:
        """
        Register command handler
        
        Args:
            command: Command name (e.g., 'start', 'stop')
            handler: Handler function
        """
        self.command_handlers[command] = handler
    
    def start(self) -> bool:
        """
        Start OSC server
        
        Returns:
            True if started successfully
        """
        if not self.enabled:
            self.logger.info("OSC server disabled")
            return False
        
        if self.is_running:
            self.logger.warning("OSC server already running")
            return False
        
        try:
            # Create dispatcher
            disp = dispatcher.Dispatcher()
            
            # Register handlers
            disp.map("/mixpi/record/start", self._handle_start)
            disp.map("/mixpi/record/stop", self._handle_stop)
            disp.map("/mixpi/record/marker", self._handle_marker)
            disp.map("/mixpi/status", self._handle_status)
            
            # Create server
            self.server = osc_server.ThreadingOSCUDPServer(
                ("0.0.0.0", self.port),
                disp
            )
            
            # Start server thread
            self.server_thread = threading.Thread(
                target=self.server.serve_forever,
                daemon=True
            )
            self.server_thread.start()
            
            self.is_running = True
            self.logger.info(f"OSC server started on port {self.port}")
            
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to start OSC server: {e}")
            return False
    
    def stop(self) -> None:
        """Stop OSC server"""
        if not self.is_running:
            return
        
        try:
            if self.server:
                self.server.shutdown()
            
            if self.server_thread:
                self.server_thread.join(timeout=2.0)
            
            self.is_running = False
            self.logger.info("OSC server stopped")
            
        except Exception as e:
            self.logger.error(f"Error stopping OSC server: {e}")
    
    def _handle_start(self, address: str, *args) -> None:
        """Handle start recording command"""
        self.logger.info("Received start command via OSC")
        
        handler = self.command_handlers.get('start')
        if handler:
            try:
                handler()
            except Exception as e:
                self.logger.error(f"Error in start handler: {e}")
    
    def _handle_stop(self, address: str, *args) -> None:
        """Handle stop recording command"""
        self.logger.info("Received stop command via OSC")
        
        handler = self.command_handlers.get('stop')
        if handler:
            try:
                handler()
            except Exception as e:
                self.logger.error(f"Error in stop handler: {e}")
    
    def _handle_marker(self, address: str, *args) -> None:
        """Handle add marker command"""
        label = args[0] if args else ""
        self.logger.info(f"Received marker command via OSC: {label}")
        
        handler = self.command_handlers.get('marker')
        if handler:
            try:
                handler(label)
            except Exception as e:
                self.logger.error(f"Error in marker handler: {e}")
    
    def _handle_status(self, address: str, *args) -> None:
        """Handle status request"""
        self.logger.info("Received status request via OSC")
        
        handler = self.command_handlers.get('status')
        if handler:
            try:
                handler()
            except Exception as e:
                self.logger.error(f"Error in status handler: {e}")
