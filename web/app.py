"""
MixPi Flask Application
Main entry point for the web interface
"""

import sys
import os
import time
import threading
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from flask import Flask, send_from_directory, send_file
from flask_socketio import SocketIO
from flask_cors import CORS
import logging

from src.utils import load_config, setup_logging
from src.audio_engine import AudioEngine
from src.storage_manager import StorageManager
from src.metadata import MetadataManager
from src.xair_osc_client import XAirOSCClient
from web.routes import api, init_routes
from web.websocket import init_websocket


def _apply_mock_audio_if_requested():
    """
    If MIXPI_MOCK_AUDIO=1 is set, patch sounddevice before AudioEngine
    imports it so that all 18 channels produce simulated signals.
    This lets you run the full UI locally without any audio hardware.
    """
    if os.environ.get('MIXPI_MOCK_AUDIO') == '1':
        from dev.mock_audio import patch_sounddevice
        patch_sounddevice()
        return True
    return False


def create_app(config_path='config.yaml'):
    """
    Create and configure Flask application
    
    Args:
        config_path: Path to configuration file
        
    Returns:
        Tuple of (Flask app, SocketIO instance)
    """
    # Patch audio backend before anything else touches sounddevice
    mock_mode = _apply_mock_audio_if_requested()

    # Load configuration
    try:
        config = load_config(config_path)
    except FileNotFoundError:
        print(f"Configuration file not found: {config_path}")
        print("Please copy config.yaml.example to config.yaml and configure it.")
        sys.exit(1)

    # Environment variable overrides (used by --mic / --device flags in dev/run.sh)
    if os.environ.get('MIXPI_AUDIO_DEVICE'):
        config.setdefault('audio', {})['device'] = os.environ['MIXPI_AUDIO_DEVICE']
    if os.environ.get('MIXPI_AUDIO_CHANNELS'):
        config.setdefault('audio', {})['channels'] = int(os.environ['MIXPI_AUDIO_CHANNELS'])

    # Setup logging
    logger = setup_logging(config['web'].get('debug', False))
    logger.info("Starting MixPi Recorder")
    
    # Create Flask app
    app = Flask(__name__, static_folder='static', static_url_path='')
    app.config['SECRET_KEY'] = 'mixpi-secret-key-change-in-production'
    
    # Enable CORS
    CORS(app)
    
    # Create SocketIO instance
    socketio = SocketIO(app, cors_allowed_origins="*")
    
    # Initialize components
    if mock_mode:
        logger.info("MOCK AUDIO MODE — simulating 18-channel X Air 18")
    logger.info("Initializing components...")
    
    audio_engine = AudioEngine(config)
    storage_manager = StorageManager(config)
    metadata_manager = MetadataManager()

    # OSC channel strip client (connects to mixer for channel names / states)
    osc_client = XAirOSCClient(config)

    def _on_channel_update(ch_num, strip):
        socketio.emit('channel_update', {
            'channel': ch_num,
            'strip': strip.to_dict(),
        })
    osc_client.add_update_callback(_on_channel_update)

    def _start_osc_background():
        """
        Connect to the mixer in a background thread.
        1. Try the configured IP first (instant if correct).
        2. Fall back to UDP broadcast discovery on all interfaces.
        3. Retry every 30 s until the mixer is found (handles boot-before-mixer).
        """
        RETRY_INTERVAL = 30  # seconds between retries

        while True:
            # ── Try configured IP ──────────────────────────────────────────
            if osc_client.mixer_ip and osc_client.mixer_ip not in ('', '0.0.0.0'):
                if osc_client.connect():
                    osc_client.fetch_all(usb_channels=audio_engine.channels)
                    osc_client.start_subscription()
                    logger.info(f"OSC connected to configured IP {osc_client.mixer_ip}")
                    return

            # ── Broadcast discovery ────────────────────────────────────────
            logger.info("OSC: configured IP unreachable — broadcasting to discover mixer…")
            found_ip = XAirOSCClient.discover()
            if found_ip:
                if osc_client.reconnect(found_ip):
                    logger.info(f"OSC auto-discovered and connected to {found_ip}")
                    return

            logger.info(f"OSC: mixer not found, retrying in {RETRY_INTERVAL}s…")
            time.sleep(RETRY_INTERVAL)

    osc_thread = threading.Thread(target=_start_osc_background, daemon=True,
                                  name='osc-init')
    osc_thread.start()

    # Initialize routes
    init_routes(audio_engine, storage_manager, metadata_manager, osc_client)
    app.register_blueprint(api)

    # Initialize WebSocket
    init_websocket(socketio, audio_engine)

    # Start audio monitoring
    audio_engine.start_monitoring()
    
    # Serve static files
    @app.route('/')
    def index():
        return send_from_directory(app.static_folder, 'index.html')
    
    @app.route('/<path:path>')
    def static_files(path):
        return send_from_directory(app.static_folder, path)
    
    # Serve the local CA certificate so iOS/macOS can install it before HTTPS is trusted.
    # Open http://<hostname>.local:5000/install-ca in Safari → tap Install.
    @app.route('/install-ca')
    def install_ca():
        ca_path = Path('/opt/mixpi/certs/mixpi-ca.crt')
        if ca_path.exists():
            # application/x-x509-ca-cert triggers the iOS profile-install flow in Safari
            return send_file(str(ca_path), mimetype='application/x-x509-ca-cert',
                             download_name='mixpi-ca.crt', as_attachment=True)
        return ("CA certificate not found on this Pi.\n"
                "Run  sudo scripts/setup_https.sh  to generate it."), 404

    logger.info("MixPi Recorder initialized")

    return app, socketio


def _start_ca_http_server(ca_path: Path, https_port: int, http_port: int = 8080,
                          display_host: str = ''):
    """
    Serve the mkcert CA cert over plain HTTP so devices can install it
    before they trust HTTPS.
    """
    import socket as _socket
    from http.server import HTTPServer, BaseHTTPRequestHandler

    if not display_host:
        display_host = f"{_socket.gethostname()}.local"

    _CA_HTML = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MixPi — Install Certificate</title>
<style>
  body{{font-family:-apple-system,sans-serif;background:#111;color:#eee;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}}
  .card{{background:#1e1e1e;border-radius:16px;padding:32px;max-width:440px;text-align:center}}
  h1{{font-size:1.4rem;margin:0 0 6px}}
  p{{color:#aaa;font-size:.9rem;line-height:1.6}}
  .btn{{display:inline-block;background:#c00;color:#fff;text-decoration:none;
        padding:14px 28px;border-radius:8px;font-size:1rem;font-weight:600;margin-top:16px}}
  hr{{border-color:#333;margin:24px 0}}
  ol{{text-align:left;color:#aaa;font-size:.85rem;line-height:1.9}}
  a.app{{color:#f66}}
</style>
</head>
<body>
<div class="card">
  <h1>&#127925; MixPi</h1>
  <p>Install the local CA certificate to enable secure HTTPS connections
     from this device.</p>
  <a href="/mixpi-ca.crt" class="btn">&#8659;&nbsp; Install Certificate</a>
  <hr>
  <ol>
    <li>Tap <strong>Install Certificate</strong> above</li>
    <li><strong>iPad / iPhone:</strong> Settings &rarr; VPN &amp; Device Management
        &rarr; tap the MixPi profile &rarr; <em>Install</em></li>
    <li>Settings &rarr; General &rarr; About &rarr; Certificate Trust Settings
        &rarr; toggle MixPi <em>on</em></li>
    <li>Open <a class="app" href="https://{display_host}:{https_port}">
        https://{display_host}:{https_port}</a></li>
  </ol>
</div>
</body>
</html>"""

    class _CAHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path in ('/mixpi-ca.crt', '/install-ca'):
                try:
                    data = ca_path.read_bytes()
                    self.send_response(200)
                    # 'attachment' disposition + correct MIME type triggers
                    # the iOS "Profile Downloaded" install flow in Safari
                    self.send_header('Content-Type', 'application/x-x509-ca-cert')
                    self.send_header('Content-Disposition',
                                     'attachment; filename="mixpi-ca.crt"')
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except Exception:
                    self.send_response(500)
                    self.end_headers()
            else:
                body = _CA_HTML.encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        def log_message(self, *_):
            pass  # suppress access log noise

    try:
        from http.server import ThreadingHTTPServer
        server = ThreadingHTTPServer(('0.0.0.0', http_port), _CAHandler)
        server.serve_forever()
    except OSError:
        pass  # port already in use — ignore silently


def main():
    """Main entry point"""
    app, socketio = create_app()

    config = load_config()
    host  = config['web']['host']
    port  = config['web']['port']
    debug = config['web']['debug']

    # Load TLS certificates if generated by scripts/setup_https.sh
    cert_dir  = Path('/opt/mixpi/certs')
    cert_file = cert_dir / 'cert.pem'
    key_file  = cert_dir / 'key.pem'
    ca_file   = cert_dir / 'mixpi-ca.crt'
    ssl_context = None
    scheme = 'http'
    if cert_file.exists() and key_file.exists():
        ssl_context = (str(cert_file), str(key_file))
        scheme = 'https'

    import socket as _socket
    display_host = f"{_socket.gethostname()}.local" if host == '0.0.0.0' else host

    # Start plain-HTTP CA-install helper alongside the main HTTPS server
    if ssl_context and ca_file.exists():
        t = threading.Thread(
            target=_start_ca_http_server,
            args=(ca_file, port, 8080, display_host),
            daemon=True,
            name='ca-http',
        )
        t.start()

    print(f"\n{'='*60}")
    print(f"  MixPi Recorder")
    print(f"{'='*60}")
    print(f"  Web interface : {scheme}://{display_host}:{port}")
    if ssl_context:
        print(f"  HTTPS         : enabled  ({cert_dir})")
        print(f"  CA install    : http://{display_host}:8080  ← open this FIRST")
        print(f"                  on any new device to install the certificate")
    else:
        print(f"  HTTPS         : disabled")
        print(f"  Enable HTTPS  : sudo /opt/mixpi/scripts/setup_https.sh")
    print(f"{'='*60}\n")

    socketio.run(app, host=host, port=port, debug=debug,
                 allow_unsafe_werkzeug=True, ssl_context=ssl_context)


if __name__ == '__main__':
    main()
