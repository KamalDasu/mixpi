"""
Utility functions for MixPi recorder
"""

import yaml
import logging
import os
from typing import Dict, Any


def load_config(config_path: str = "config.yaml") -> Dict[str, Any]:
    """
    Load configuration from YAML file.

    The path is resolved in this priority order:
      1. Explicit ``config_path`` argument (if caller overrides)
      2. ``MIXPI_CONFIG`` environment variable (e.g. set by dev/run.sh)
      3. Default ``config.yaml``

    Args:
        config_path: Path to configuration file

    Returns:
        Dictionary containing configuration

    Raises:
        FileNotFoundError: If config file doesn't exist
        yaml.YAMLError: If config file is invalid
    """
    # Allow the environment to override the default path (dev/run.sh sets this)
    env_path = os.environ.get('MIXPI_CONFIG')
    if env_path and config_path == "config.yaml":
        config_path = env_path

    if not os.path.exists(config_path):
        raise FileNotFoundError(
            f"Configuration file not found: {config_path}\n"
            f"Please copy config.yaml.example to config.yaml and configure it."
        )

    with open(config_path, 'r') as f:
        config = yaml.safe_load(f)

    return config


class _SuppressSSLDisconnect(logging.Filter):
    """
    Filter out harmless SSL EOF / BrokenPipe tracebacks that Werkzeug logs at
    ERROR level whenever a browser closes an HTTPS keep-alive connection mid-
    stream (e.g. during Socket.IO transport upgrade from polling to WebSocket).
    The connection drops are completely normal and do not indicate any fault.
    """
    _SKIP_EXC = frozenset({
        'BrokenPipeError',
        'ConnectionResetError',
    })
    _SKIP_MSG = ('UNEXPECTED_EOF_WHILE_READING',)

    def filter(self, record: logging.LogRecord) -> bool:
        if record.exc_info and record.exc_info[0]:
            if record.exc_info[0].__name__ in self._SKIP_EXC:
                return False
        msg = record.getMessage()
        if any(s in msg for s in self._SKIP_MSG):
            return False
        return True


def setup_logging(debug: bool = False) -> logging.Logger:
    """
    Setup logging configuration
    
    Args:
        debug: Enable debug logging
        
    Returns:
        Configured logger instance
    """
    log_level = logging.DEBUG if debug else logging.INFO

    logging.basicConfig(
        level=log_level,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )

    # Suppress noisy third-party loggers regardless of debug mode
    for noisy in ('watchdog.observers', 'watchdog.observers.inotify_buffer',
                  'engineio.server', 'socketio.server'):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    # Suppress harmless SSL drop errors from Werkzeug (Socket.IO transport upgrade)
    logging.getLogger('werkzeug').addFilter(_SuppressSSLDisconnect())

    logger = logging.getLogger('mixpi')
    return logger


def db_to_linear(db: float) -> float:
    """
    Convert decibels to linear amplitude
    
    Args:
        db: Value in decibels
        
    Returns:
        Linear amplitude value
    """
    return 10 ** (db / 20.0)


def linear_to_db(linear: float) -> float:
    """
    Convert linear amplitude to decibels
    
    Args:
        linear: Linear amplitude value
        
    Returns:
        Value in decibels
    """
    if linear <= 0:
        return -120.0  # Very quiet
    return 20 * (linear ** 0.5).log10() if hasattr(linear, 'log10') else 20 * __import__('math').log10(linear)


def format_time(seconds: float) -> str:
    """
    Format seconds as HH:MM:SS
    
    Args:
        seconds: Time in seconds
        
    Returns:
        Formatted time string
    """
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def format_file_size(bytes: int) -> str:
    """
    Format file size in human-readable format
    
    Args:
        bytes: Size in bytes
        
    Returns:
        Formatted size string (e.g., "1.5 GB")
    """
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if bytes < 1024.0:
            return f"{bytes:.1f} {unit}"
        bytes /= 1024.0
    return f"{bytes:.1f} PB"


def ensure_directory(path: str) -> None:
    """
    Ensure directory exists, create if it doesn't
    
    Args:
        path: Directory path to ensure
    """
    os.makedirs(path, exist_ok=True)
