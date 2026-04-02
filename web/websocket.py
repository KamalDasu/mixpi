"""
WebSocket event handlers for MixPi recorder
"""

from flask_socketio import emit
import logging

logger = logging.getLogger('mixpi.websocket')

# Global references (set by app.py)
socketio = None
audio_engine = None


def init_websocket(sio, engine):
    """
    Initialize WebSocket handlers
    
    Args:
        sio: SocketIO instance
        engine: AudioEngine instance
    """
    global socketio, audio_engine
    socketio = sio
    audio_engine = engine
    
    # Register audio engine callback for level updates
    audio_engine.add_level_callback(handle_audio_event)
    
    # Register WebSocket event handlers
    register_handlers()


def register_handlers():
    """Register WebSocket event handlers"""
    
    @socketio.on('connect')
    def handle_connect():
        """Handle client connection"""
        logger.info("Client connected")
        
        # Send current status
        try:
            info = audio_engine.get_recording_info()
            emit('status', {
                'event': 'connected',
                'recording': info
            })
        except Exception as e:
            logger.error(f"Error sending status on connect: {e}")
    
    @socketio.on('disconnect')
    def handle_disconnect():
        """Handle client disconnection"""
        logger.info("Client disconnected")
    
    @socketio.on('reset_peaks')
    def handle_reset_peaks():
        """Handle peak reset request"""
        try:
            audio_engine.reset_peak_levels()
            emit('status', {
                'event': 'peaks_reset',
                'message': 'Peak levels reset'
            })
        except Exception as e:
            logger.error(f"Error resetting peaks: {e}")
            emit('error', {'message': str(e)})


def handle_audio_event(event_type: str, data: dict):
    """
    Handle audio engine events and broadcast via WebSocket
    
    Args:
        event_type: Type of event ('levels', 'auto_start_triggered', etc.)
        data: Event data
    """
    if not socketio:
        return
    
    try:
        if event_type == 'levels':
            # Broadcast level updates
            socketio.emit('levels', data)
        
        elif event_type == 'auto_start_triggered':
            # Start recording server-side (no browser required)
            if audio_engine and not audio_engine.is_recording:
                from .routes import storage_manager, metadata_manager
                try:
                    metadata = metadata_manager.create_metadata()
                    session_path = storage_manager.create_session(metadata)
                    channel_names = [
                        f"Ch{i+1:02d}" for i in range(audio_engine.channels)
                    ]
                    audio_engine.start_recording(session_path, channel_names)
                    logger.info("Auto-start: recording started server-side")
                except Exception as e:
                    logger.error(f"Auto-start failed: {e}")
            socketio.emit('status', {
                'event': 'auto_start_triggered',
                'message': 'Recording auto-started'
            })

        elif event_type == 'auto_stop_triggered':
            # Stop recording server-side (no browser required)
            if audio_engine and audio_engine.is_recording:
                try:
                    audio_engine.stop_recording()
                    logger.info("Auto-stop: recording stopped server-side")
                except Exception as e:
                    logger.error(f"Auto-stop failed: {e}")
            socketio.emit('status', {
                'event': 'auto_stop_triggered',
                'message': 'Recording auto-stopped due to silence'
            })
    
    except Exception as e:
        logger.error(f"Error handling audio event: {e}")


def broadcast_status(event: str, message: str, **kwargs):
    """
    Broadcast status update to all clients
    
    Args:
        event: Event name
        message: Status message
        **kwargs: Additional data
    """
    if not socketio:
        return
    
    try:
        data = {
            'event': event,
            'message': message
        }
        data.update(kwargs)
        
        socketio.emit('status', data)
    except Exception as e:
        logger.error(f"Error broadcasting status: {e}")


def broadcast_error(message: str):
    """
    Broadcast error to all clients
    
    Args:
        message: Error message
    """
    if not socketio:
        return
    
    try:
        socketio.emit('error', {'message': message})
    except Exception as e:
        logger.error(f"Error broadcasting error: {e}")
