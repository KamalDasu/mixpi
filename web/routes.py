"""
REST API routes for MixPi recorder
"""

from flask import Blueprint, jsonify, request
from pathlib import Path
import logging
import re
import socket
import struct
import subprocess
import threading
import time

# Create blueprint
api = Blueprint('api', __name__, url_prefix='/api')
logger = logging.getLogger('mixpi.api')

# Global references (set by app.py)
audio_engine = None
storage_manager = None
metadata_manager = None
osc_client = None

# ---------------------------------------------------------------------------
# Background bounce (auto-downmix after recording stops)
# ---------------------------------------------------------------------------
_bounce_jobs: dict = {}   # str(recording_path) -> 'mixing' | 'done' | 'error'
_bounce_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Background USB playback (Play on Mixer)
# ---------------------------------------------------------------------------
_playback_thread   = None
_playback_stop     = threading.Event()
_playback_process  = None   # aplay subprocess — killed on stop
_playback_position = 0      # current frame offset into the output buffer
_playback_total    = 0      # total frames in the file
_playback_sr       = 48000  # sample rate of the playing file


def _find_xr18_alsa_device() -> str:
    """
    Return the ALSA device string (e.g. 'hw:3,0') for the XR18.
    Parses `aplay -l` output so we don't hard-code the card number.
    Falls back to 'hw:3,0' if parsing fails.
    """
    import re
    try:
        result = subprocess.run(
            ['/usr/bin/aplay', '-l'], capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.splitlines():
            if any(k in line.lower() for k in ('x18', 'xr18', 'x-air')):
                m = re.search(r'card\s+(\d+).*?device\s+(\d+)', line)
                if m:
                    return f"hw:{m.group(1)},{m.group(2)}"
    except Exception:
        pass
    return 'hw:3,0'

# ---------------------------------------------------------------------------
# Recording quality presets
# Storage is calculated per channel per hour (uncompressed WAV)
# ---------------------------------------------------------------------------
def _storage_mb_per_ch_hr(sample_rate: int, bit_depth: int) -> float:
    bytes_per_sec = sample_rate * (bit_depth / 8)
    return round(bytes_per_sec * 3600 / (1024 ** 2), 1)


RECORDING_PRESETS = [
    {
        'id': 'broadcast',
        'label': 'Broadcast',
        'tag': 'Auto kHz / 16-bit',
        'sample_rate': None,   # determined at runtime from hardware
        'bit_depth': 16,
        'description': 'Standard live recording — sample rate follows XR18 hardware setting',
        'default': True,
    },
    {
        'id': 'studio',
        'label': 'Studio',
        'tag': 'Auto kHz / 24-bit',
        'sample_rate': None,
        'bit_depth': 24,
        'description': 'Professional quality — recommended for DAW work',
    },
    {
        'id': 'xair',
        'label': 'X Air Native',
        'tag': 'Auto kHz / 32-bit Float',
        'sample_rate': None,
        'bit_depth': 32,
        'description': 'X Air 18 native float format — no conversion, maximum headroom',
    },
]

for _p in RECORDING_PRESETS:
    # Use 48000 as reference rate for storage estimate (actual rate is hardware-determined)
    _p['mb_per_ch_hr'] = _storage_mb_per_ch_hr(48000, _p['bit_depth'])
# ---------------------------------------------------------------------------


def init_routes(engine, storage, metadata, osc=None):
    """Initialize routes with engine, storage, metadata and optional OSC client."""
    global audio_engine, storage_manager, metadata_manager, osc_client
    audio_engine = engine
    storage_manager = storage
    metadata_manager = metadata
    osc_client = osc


@api.route('/recording/start', methods=['POST'])
def start_recording():
    """Start a new recording session"""
    try:
        data = request.get_json() or {}
        
        # Create metadata — include live recording settings so session.json
        # is self-contained (quality is known even without the app running)
        metadata = metadata_manager.create_metadata(
            venue=data.get('venue', ''),
            artist=data.get('artist', ''),
            engineer=data.get('engineer', ''),
            notes=data.get('notes', ''),
            session_name=data.get('session_name', 'session1'),  # show folder name
            track_name=data.get('track_name', ''),              # song/take name prefix
            # Recording settings snapshot
            sample_rate=audio_engine.sample_rate if audio_engine else None,
            bit_depth=audio_engine.bit_depth if audio_engine else None,
            channels=len(data.get('channels') or []) or (
                audio_engine.channels if audio_engine else None
            ),
            format='WAV Float32' if (audio_engine and audio_engine.bit_depth == 32)
                   else f'WAV PCM_{audio_engine.bit_depth}' if audio_engine else 'WAV',
        )

        # Create session
        session_path = storage_manager.create_session(metadata)
        
        # Channel names: from OSC if connected, else generic Ch N
        n_ch = audio_engine.channels
        if osc_client and osc_client.is_connected:
            channel_names = osc_client.get_channel_names() or [f'Ch {i}' for i in range(1, n_ch + 1)]
        else:
            channel_names = [f'Ch {i}' for i in range(1, n_ch + 1)]

        # Optional: caller can specify which channels to arm (1-based list)
        # e.g. {"channels": [1, 2, 5, 6]}  — None means arm all
        enabled_channels = data.get('channels') or None

        # Start recording
        success = audio_engine.start_recording(
            session_path, channel_names, enabled_channels=enabled_channels
        )

        if success:
            armed = audio_engine.get_recording_info()['armed_channels']
            return jsonify({
                'success': True,
                'session': str(session_path),
                'armed_channels': armed,
                'message': f'Recording started ({len(armed)} channels)',
            })
        else:
            return jsonify({
                'success': False,
                'message': 'Failed to start recording'
            }), 500
            
    except Exception as e:
        logger.error(f"Error starting recording: {e}")
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500


@api.route('/recording/stop', methods=['POST'])
def stop_recording():
    """Stop current recording and kick off background downmix."""
    try:
        # Capture path before engine clears it
        rec_path = audio_engine.session_path

        success = audio_engine.stop_recording()

        if success:
            if rec_path and audio_engine.markers:
                storage_manager.save_markers(rec_path, audio_engine.markers)

            # Auto-downmix in background so bounce is ready for playback
            if rec_path:
                _start_bounce_job(Path(rec_path))

            return jsonify({'success': True, 'message': 'Recording stopped'})
        else:
            return jsonify({'success': False, 'message': 'Not recording'}), 400

    except Exception as e:
        logger.error(f"Error stopping recording: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


@api.route('/recording/channel/<int:channel>', methods=['DELETE'])
def unarm_channel(channel):
    """Un-arm (close) a single channel mid-recording. channel is 1-based."""
    try:
        if not audio_engine.is_recording:
            return jsonify({'success': False, 'message': 'Not recording'}), 400
        ok = audio_engine.close_channel(channel - 1)
        if ok:
            return jsonify({'success': True, 'channel': channel})
        return jsonify({'success': False, 'message': f'Channel {channel} not active'}), 400
    except Exception as e:
        logger.error(f"Error unarming channel {channel}: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


@api.route('/recording/marker', methods=['POST'])
def add_marker():
    """Add a marker during recording"""
    try:
        data = request.get_json() or {}
        label = data.get('label', '')
        
        marker = audio_engine.add_marker(label)
        
        if marker:
            return jsonify({
                'success': True,
                'marker': marker
            })
        else:
            return jsonify({
                'success': False,
                'message': 'Not recording'
            }), 400
            
    except Exception as e:
        logger.error(f"Error adding marker: {e}")
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500


@api.route('/recording/status', methods=['GET'])
def get_status():
    """Get current recording status"""
    try:
        info = audio_engine.get_recording_info()
        disk_space = storage_manager.get_disk_space()

        detection = audio_engine.get_detection_info()
        profile = detection.get('profile')

        # Compute bit-rate directly so it's available even without a named profile
        rate = audio_engine.sample_rate
        ch = audio_engine.channels
        depth = audio_engine.bit_depth
        total_bps = rate * depth * ch
        total_mbps = round(total_bps / 1_000_000, 2)
        storage_gb_hr = round(total_bps * 3600 / 8 / (1024 ** 3), 2)

        return jsonify({
            'success': True,
            'recording': info,
            'disk_space': disk_space,
            'audio_device': {
                'name': detection['device_name'],
                'sample_rate': rate,
                'channels': ch,
                'bit_depth': depth,
                'format': (profile or {}).get('bit_format',
                           'Float32' if depth == 32 else f'PCM_{depth}'),
                'mixer_name': (profile or {}).get('name'),
                'detection_method': detection['method'],
                'osc_reachable': detection['osc_reachable'],
                # Bit-rate figures
                'total_bit_rate_mbps': total_mbps,
                'storage_per_hour_gb': storage_gb_hr,
                'bit_rate_per_channel_kbps': round(rate * depth / 1000, 1),
            }
        })
        
    except Exception as e:
        logger.error(f"Error getting status: {e}")
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500


@api.route('/sessions', methods=['GET'])
def get_sessions():
    """Get list of recording sessions"""
    try:
        limit = request.args.get('limit', 50, type=int)
        sessions = storage_manager.get_sessions(limit=limit)
        
        return jsonify({
            'success': True,
            'sessions': sessions
        })
        
    except Exception as e:
        logger.error(f"Error getting sessions: {e}")
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500


@api.route('/sessions/<path:session_name>', methods=['DELETE'])
def delete_session(session_name):
    """Delete a recording session"""
    try:
        session_path = storage_manager.storage_path / session_name
        success = storage_manager.delete_session(session_path)
        
        if success:
            return jsonify({
                'success': True,
                'message': 'Session deleted'
            })
        else:
            return jsonify({
                'success': False,
                'message': 'Session not found'
            }), 404
            
    except Exception as e:
        logger.error(f"Error deleting session: {e}")
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500


@api.route('/config', methods=['GET'])
def get_config():
    """Get current configuration"""
    try:
        cfg = audio_engine.config
        config = {
            'audio':      cfg.get('audio', {}),
            'recording':  cfg.get('recording', {}),
            'monitoring': cfg.get('monitoring', {}),
            'channels':   {'count': audio_engine.channels},
        }
        
        return jsonify({
            'success': True,
            'config': config
        })
        
    except Exception as e:
        logger.error(f"Error getting config: {e}")
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500


@api.route('/channels/names', methods=['POST'])
def update_channel_names():
    """Update channel names (no-op: names come live from mixer via OSC)"""
    return jsonify({'success': True, 'message': 'Names are read live from mixer via OSC'})


@api.route('/devices', methods=['GET'])
def get_devices():
    """Get list of available audio devices and the currently selected one"""
    try:
        devices = audio_engine.list_devices()
        active_idx = audio_engine.find_device()

        active_device = None
        if active_idx is not None:
            active_device = devices[active_idx] if active_idx < len(devices) else None
        elif devices:
            # System default - describe what sounddevice will pick
            import sounddevice as sd
            default_idx = sd.default.device[0]
            active_device = devices[default_idx] if default_idx < len(devices) else None

        return jsonify({
            'success': True,
            'devices': devices,
            'active_device': active_device,
            'config': {
                'device_setting': audio_engine.device,
                'sample_rate': audio_engine.sample_rate,
                'channels': audio_engine.channels,
                'bit_depth': audio_engine.bit_depth,
            }
        })
        
    except Exception as e:
        logger.error(f"Error getting devices: {e}")
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500


@api.route('/mixer', methods=['GET'])
def get_mixer():
    """
    Return the detected mixer profile (with live bit-rate figures) and all
    known profiles (at their own maximum channel/rate).
    """
    try:
        from src.mixer_profiles import list_profiles

        detection = audio_engine.get_detection_info()

        # Re-compute bit-rate fields against the *active* configuration so
        # the numbers reflect what this session will actually record.
        if detection.get('profile'):
            profile_obj = audio_engine.mixer_profile
            detection['profile'] = profile_obj.to_dict(
                channels=audio_engine.channels,
                sample_rate=audio_engine.sample_rate,
            )

        return jsonify({
            'success': True,
            'detection': detection,
            'known_profiles': list_profiles(),
        })

    except Exception as e:
        logger.error(f"Error getting mixer info: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


@api.route('/channels', methods=['GET'])
def get_channels():
    """
    Return live channel strip data from the mixer via OSC.

    Falls back to channel names from config.yaml when OSC is not connected.
    Response includes per-channel: name, mute, fader (dB), pan, phantom, gate, comp, EQ.
    """
    try:
        if osc_client and osc_client.is_connected:
            strips = osc_client.get_strips()
            # Cache empty — OSC may have connected after initial fetch; re-query now
            if not strips:
                logger.info("Channel strip cache empty — re-fetching from mixer")
                strips = osc_client.fetch_all(audio_engine.channels)
            channels = []
            for i in range(1, audio_engine.channels + 1):
                strip = strips.get(i)
                if strip:
                    channels.append(strip.to_dict())
                else:
                    channels.append({
                        'number': i, 'name': f'Ch {i}',
                        'muted': False, 'fader': 0.75, 'fader_db': 0.0,
                        'pan': 0.5, 'phantom': False,
                        'gate_on': False, 'comp_on': False, 'eq_on': True,
                    })

            return jsonify({
                'success': True,
                'source': 'osc',
                'osc_connected': True,
                'channels': channels,
            })

        else:
            # OSC not available — generic Ch N placeholders
            channels = [
                {
                    'number': i + 1, 'name': f'Ch {i + 1}',
                    'muted': False, 'fader': 0.75, 'fader_db': 0.0,
                    'pan': 0.5, 'phantom': False,
                    'gate_on': False, 'comp_on': False, 'eq_on': True,
                }
                for i in range(audio_engine.channels)
            ]
            return jsonify({
                'success': True,
                'source': 'config',
                'osc_connected': False,
                'channels': channels,
            })

    except Exception as e:
        logger.error(f"Error getting channel data: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


@api.route('/sessions/<path:session_name>/files', methods=['GET'])
def get_session_files(session_name):
    """Get list of files in a session"""
    try:
        from pathlib import Path
        session_path = storage_manager.storage_path / session_name
        
        if not session_path.exists():
            return jsonify({
                'success': False,
                'message': 'Session not found'
            }), 404
        
        # Get all audio files
        files = []
        for file_path in sorted(session_path.glob('*.wav')):
            files.append({
                'name': file_path.name,
                'size': file_path.stat().st_size,
                'url': f'/api/sessions/{session_name}/download/{file_path.name}'
            })
        
        return jsonify({
            'success': True,
            'files': files
        })
        
    except Exception as e:
        logger.error(f"Error getting session files: {e}")
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500


def _resolve_session_file(session_name, filename):
    """Resolve and validate a session file path. Returns (absolute Path, error_response)."""
    # Resolve to absolute path immediately so send_file never re-resolves
    # against Flask's app root_path (web/) instead of the project root.
    session_path = (storage_manager.storage_path / session_name).resolve()
    file_path = (session_path / filename).resolve()
    if not str(file_path).startswith(str(session_path)):
        return None, (jsonify({'success': False, 'message': 'Invalid file path'}), 403)
    if not file_path.exists():
        return None, (jsonify({'success': False, 'message': 'File not found'}), 404)
    return file_path, None


@api.route('/sessions/<path:session_name>/download/<filename>', methods=['GET'])
def download_file(session_name, filename):
    """Download a specific file (forces browser save dialog)."""
    try:
        from flask import send_file
        file_path, err = _resolve_session_file(session_name, filename)
        if err:
            return err
        return send_file(file_path, as_attachment=True, download_name=filename)
    except Exception as e:
        logger.error(f"Error downloading file: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


def _serve_audio_wav(data, sr: int, filename: str):
    """
    Write PCM-16 WAV to a temp file and serve it with Flask's send_file.

    send_file on a real file automatically handles Accept-Ranges / 206
    Partial Content / ETag / If-Range — which in-memory BytesIO cannot.
    On Linux the file is unlinked after the response is prepared; the
    kernel keeps the data blocks alive until the fd is closed.
    """
    import os, tempfile
    from flask import send_file, after_this_request
    import soundfile as sf

    fd, tmp_path = tempfile.mkstemp(suffix='.wav', prefix='mixpi_stream_')
    os.close(fd)
    try:
        sf.write(tmp_path, data, sr, format='WAV', subtype='PCM_16')
    except Exception:
        try: os.unlink(tmp_path)
        except: pass
        raise

    @after_this_request
    def _cleanup(response):
        try: os.unlink(tmp_path)
        except: pass
        return response

    return send_file(tmp_path, mimetype='audio/wav',
                     as_attachment=False, conditional=True,
                     download_name=filename)


@api.route('/sessions/<path:session_name>/stream/<filename>', methods=['GET'])
def stream_file(session_name, filename):
    """
    Stream a file inline for browser <audio> playback.

    Always serves PCM_16 at ≤ 48 kHz — the only format all browsers
    (Chrome, Firefox, Safari) decode reliably.  Audio is normalised to
    −1 dBFS so individual channels sound as loud as the stereo mix.
    Supports HTTP Range requests so browsers can seek and re-buffer.
    The original file on disk is never modified; use /download/ for
    native-quality files.
    """
    try:
        import soundfile as sf
        import numpy as np

        file_path, err = _resolve_session_file(session_name, filename)
        if err:
            return err

        data, sr = sf.read(str(file_path), dtype='float32', always_2d=True)

        # Downsample if needed (simple decimation — browser-only stream)
        if sr > 48000:
            factor = sr // 48000
            data   = data[::factor]
            sr     = 48000

        # Normalise to −1 dBFS so individual channels are at a consistent
        # listening level, matching the stereo mix.
        peak = np.max(np.abs(data))
        if peak > 0.001:
            data = data * (0.891 / peak)
        data = np.clip(data, -1.0, 1.0)

        return _serve_audio_wav(data, sr, filename)

    except Exception as e:
        logger.error(f"Error streaming file: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


@api.route('/sessions/<path:session_name>/download-all', methods=['GET'])
def download_session_zip(session_name):
    """
    Download as ZIP.
    - When session_name is a show folder: includes all recordings recursively
      (channel WAVs, bounce, metadata, README) — full DAW-ready archive.
    - When session_name is a single recording: includes that recording only.
    Original file quality is always preserved (no transcoding).
    """
    try:
        from flask import send_file
        import zipfile, io

        target_path = (storage_manager.storage_path / session_name).resolve()
        if not target_path.exists():
            return jsonify({'success': False, 'message': 'Not found'}), 404

        memory_file = io.BytesIO()
        zip_name    = Path(session_name).name

        with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zf:
            for file_path in sorted(target_path.rglob('*')):
                if file_path.is_file():
                    arc_name = file_path.relative_to(target_path)
                    zf.write(file_path, arc_name)

        memory_file.seek(0)
        return send_file(memory_file, mimetype='application/zip',
                         as_attachment=True,
                         download_name=f'{zip_name}.zip')

    except Exception as e:
        logger.error(f"Error creating ZIP: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


@api.route('/sessions/<path:session_name>/download-mixes', methods=['GET'])
def download_mixes_zip(session_name):
    """
    Download a ZIP containing ONLY the stereo mixes for a session.
    Accepts ?format=wav|mp3|m4a (defaults to wav).
    Skips recordings that don't have a stereo mix generated yet.
    """
    if audio_engine and getattr(audio_engine, 'is_recording', False):
        return jsonify({'success': False, 'message': 'Cannot batch zip mixes while recording is active'}), 400

    fmt = request.args.get('format', 'wav').lower()
    fmt_map = {
        'wav': ('.wav', None, None),
        'm4a': ('.m4a', 'aac', '256k'),
        'mp3': ('.mp3', 'libmp3lame', '320k'),
    }
    if fmt not in fmt_map:
        return jsonify({'success': False, 'message': f'Unsupported format: {fmt}'}), 400

    suffix, codec, bitrate = fmt_map[fmt]

    try:
        from flask import send_file
        import zipfile, io, tempfile, subprocess

        target_path = (storage_manager.storage_path / session_name).resolve()
        if not target_path.exists():
            return jsonify({'success': False, 'message': 'Session not found'}), 404

        memory_file = io.BytesIO()
        zip_name = f"{Path(session_name).name}_StereoMixes"

        with tempfile.TemporaryDirectory() as tmpdir:
            with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zf:
                has_mixes = False
                import web.websocket
                # Find all recordings in this session
                for rec_dir in sorted(target_path.iterdir()):
                    if not rec_dir.is_dir():
                        continue
                    
                    bounce_path = rec_dir / 'bounce' / 'stereo_mix.wav'
                    if bounce_path.exists() and bounce_path.stat().st_size > 44:
                        has_mixes = True
                        rec_name = rec_dir.name
                        arc_name = f"{rec_name}{suffix}"
                        
                        if web.websocket.socketio:
                            web.websocket.socketio.emit('zip_progress', {
                                'session': session_name,
                                'file': arc_name
                            })
                            web.websocket.socketio.sleep(0)
                        
                        if fmt == 'wav':
                            zf.write(bounce_path, arc_name)
                        else:
                            tmp_file = Path(tmpdir) / arc_name
                            subprocess.run(
                                ['ffmpeg', '-y', '-i', str(bounce_path),
                                 '-c:a', codec, '-b:a', bitrate, str(tmp_file)],
                                check=True, capture_output=True
                            )
                            zf.write(tmp_file, arc_name)

        if not has_mixes:
            return jsonify({'success': False, 'message': 'No stereo mixes found in this session. Please generate them first.'}), 404

        memory_file.seek(0)
        return send_file(memory_file, mimetype='application/zip',
                         as_attachment=True,
                         download_name=f'{zip_name}.zip')

    except subprocess.CalledProcessError as e:
        logger.error(f"ffmpeg export failed during batch zip: {e.stderr.decode() if e.stderr else str(e)}")
        return jsonify({'success': False, 'message': 'Transcoding failed'}), 500
    except Exception as e:
        logger.error(f"Error creating mixes ZIP: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ---------------------------------------------------------------------------
# Stereo downmix helpers + auto-bounce
# ---------------------------------------------------------------------------

def _do_downmix(recording_path: Path) -> Path:
    """
    Create bounce/stereo_mix.wav from all channel WAVs in recording_path.
    Writes at the session's native bit depth (for full quality).
    Returns the output path.  Raises on error.
    """
    import numpy as np
    import soundfile as sf

    bounce_dir = recording_path / 'bounce'
    bounce_dir.mkdir(exist_ok=True)
    out_path = bounce_dir / 'stereo_mix.wav'

    # Channel WAVs only (not any pre-existing bounce)
    wav_files = sorted(
        [f for f in recording_path.glob('*.wav') if 'stereo_mix' not in f.name]
    )
    if not wav_files:
        raise ValueError('No WAV files found in recording')

    # Fast path: if Main LR channels (ch17/ch18) exist alongside other tracks,
    # use the desk's already-mixed stereo directly instead of algorithmic mixing.
    # This preserves the desk's EQ, compression, and panning for the bounce.
    main_l = next((f for f in wav_files if f.name.endswith('ch17.wav')), None)
    main_r = next((f for f in wav_files if f.name.endswith('ch18.wav')), None)
    if main_l and main_r and len(wav_files) > 2:
        logger.info(f"Downmix: using Main LR pass-through (ch17/ch18) in {recording_path.name}")
        l_data, sample_rate = sf.read(str(main_l), dtype='float32', always_2d=False)
        r_data, _           = sf.read(str(main_r), dtype='float32', always_2d=False)
        if l_data.ndim > 1: l_data = l_data.mean(axis=1)
        if r_data.ndim > 1: r_data = r_data.mean(axis=1)
        max_len = max(len(l_data), len(r_data))
        stereo = np.column_stack([
            np.pad(l_data, (0, max_len - len(l_data))),
            np.pad(r_data, (0, max_len - len(r_data))),
        ])
        # Determine output bit depth from session metadata
        import json as _json
        subtype = 'PCM_16'
        meta_path = recording_path / 'session.json'
        if meta_path.exists():
            try:
                bd = int(_json.loads(meta_path.read_text()).get('bit_depth', 16))
                if bd == 24:   subtype = 'PCM_24'
                elif bd == 32: subtype = 'FLOAT'
            except Exception:
                pass
        sf.write(str(out_path), stereo, sample_rate, subtype=subtype)
        logger.info(f"Bounce written (Main LR pass-through): {out_path} ({subtype})")
        return out_path

    tracks = []
    sample_rate = None
    for f in wav_files:
        data, sr = sf.read(str(f), dtype='float32', always_2d=False)
        if sample_rate is None:
            sample_rate = sr
        if data.ndim > 1:
            data = data.mean(axis=1)
        tracks.append(data)

    max_len = max(len(t) for t in tracks)
    tracks = [np.pad(t, (0, max_len - len(t))) for t in tracks]

    SILENCE_RMS = 0.001
    active = [t for t in tracks if np.sqrt(np.mean(t ** 2)) > SILENCE_RMS] or tracks
    n = len(active)
    logger.info(f"Downmix: {n}/{len(tracks)} active tracks in {recording_path.name}")

    if n == 1:
        stereo = np.column_stack([active[0], active[0]])
    elif n == 2:
        stereo = np.column_stack([active[0], active[1]])
    else:
        left  = np.mean([active[i] for i in range(0, n, 2)], axis=0)
        right_src = [active[i] for i in range(1, n, 2)]
        right = np.mean(right_src, axis=0) if right_src else left
        stereo = np.column_stack([left, right])

    peak = np.max(np.abs(stereo))
    if peak > 0.0:
        stereo = stereo * (0.891 / peak)
    stereo = np.clip(stereo, -1.0, 1.0)

    # Native bit depth — download button serves this original file
    import json as _json
    subtype = 'PCM_16'
    meta_path = recording_path / 'session.json'
    if meta_path.exists():
        try:
            bd = int(_json.loads(meta_path.read_text()).get('bit_depth', 16))
            if bd == 24:
                subtype = 'PCM_24'
            elif bd == 32:
                subtype = 'FLOAT'
        except Exception:
            pass

    sf.write(str(out_path), stereo, sample_rate, subtype=subtype)
    logger.info(f"Bounce written: {out_path} ({n} tracks, {subtype})")
    return out_path


def _start_bounce_job(recording_path: Path) -> None:
    """Kick off a background thread to create bounce/stereo_mix.wav."""
    key = str(recording_path)
    with _bounce_lock:
        if _bounce_jobs.get(key) == 'mixing':
            return
        _bounce_jobs[key] = 'mixing'

    def _run():
        try:
            _do_downmix(recording_path)
            with _bounce_lock:
                _bounce_jobs[key] = 'done'
        except Exception as e:
            logger.error(f"Auto-downmix failed for {recording_path.name}: {e}")
            with _bounce_lock:
                _bounce_jobs[key] = 'error'

    threading.Thread(target=_run, daemon=True).start()


@api.route('/sessions/<path:session_name>/bounce-status', methods=['GET'])
def get_bounce_status(session_name):
    """Poll whether the background bounce is ready."""
    recording_path = (storage_manager.storage_path / session_name).resolve()
    bounce_path    = recording_path / 'bounce' / 'stereo_mix.wav'
    key            = str(recording_path)

    if bounce_path.exists() and bounce_path.stat().st_size > 44:
        return jsonify({'success': True, 'status': 'done', 'ready': True})

    with _bounce_lock:
        status = _bounce_jobs.get(key, 'idle')
    return jsonify({'success': True, 'status': status, 'ready': False})


@api.route('/sessions/<path:session_name>/bounce', methods=['GET'])
def stream_bounce(session_name):
    """
    Stream the stereo mix for browser playback — always transcoded to
    PCM_16 / ≤ 48 kHz so every browser can decode it.
    Supports HTTP Range requests for reliable seeking and buffering.
    """
    import soundfile as sf

    recording_path = (storage_manager.storage_path / session_name).resolve()
    bounce_path    = recording_path / 'bounce' / 'stereo_mix.wav'

    if not bounce_path.exists():
        try:
            _do_downmix(recording_path)
        except Exception as e:
            return jsonify({'success': False, 'message': str(e)}), 404

    data, sr = sf.read(str(bounce_path), dtype='float32', always_2d=True)
    if sr > 48000:
        factor = sr // 48000
        data   = data[::factor]
        sr     = 48000
    return _serve_audio_wav(data, sr, 'stereo_mix.wav')


@api.route('/sessions/<path:session_name>/bounce/download', methods=['GET'])
def download_bounce(session_name):
    """Download bounce at original (native) quality for DAW use."""
    from flask import send_file

    recording_path = (storage_manager.storage_path / session_name).resolve()
    bounce_path    = recording_path / 'bounce' / 'stereo_mix.wav'

    if not bounce_path.exists():
        try:
            _do_downmix(recording_path)
        except Exception as e:
            return jsonify({'success': False, 'message': str(e)}), 404

    rec_name = Path(session_name).name  # e.g. "song4_20260329_120000"
    return send_file(bounce_path, as_attachment=True,
                     download_name=f'{rec_name}.wav')


@api.route('/sessions/<path:session_name>/bounce/export', methods=['GET'])
def export_bounce(session_name):
    """
    Export the stereo mix in a chosen format for sharing / AirDrop.
    ?format=wav  — original WAV (no transcoding)
    ?format=m4a  — AAC 256 kbps inside an M4A container (small, plays everywhere)
    ?format=mp3  — MP3 320 kbps
    """
    import tempfile, os
    from flask import after_this_request, send_file

    fmt            = request.args.get('format', 'wav').lower()
    recording_path = (storage_manager.storage_path / session_name).resolve()
    bounce_path    = recording_path / 'bounce' / 'stereo_mix.wav'
    rec_name       = Path(session_name).name   # e.g. "song4_20260329_120000"

    # Auto-create bounce if needed
    if not bounce_path.exists():
        try:
            _do_downmix(recording_path)
        except Exception as e:
            return jsonify({'success': False, 'message': str(e)}), 404

    if not bounce_path.exists():
        return jsonify({'success': False, 'message': 'Bounce not found'}), 404

    if fmt == 'wav':
        return send_file(bounce_path, as_attachment=True,
                         download_name=f'{rec_name}.wav')

    # Transcode via ffmpeg
    fmt_map = {
        'm4a': ('.m4a', 'aac',        '256k', 'audio/mp4'),
        'mp3': ('.mp3', 'libmp3lame', '320k', 'audio/mpeg'),
    }
    if fmt not in fmt_map:
        return jsonify({'success': False, 'message': f'Unsupported format: {fmt}'}), 400

    suffix, codec, bitrate, mime = fmt_map[fmt]
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tmp_name = tmp.name
    tmp.close()

    @after_this_request
    def _cleanup(response):
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        return response

    try:
        subprocess.run(
            ['ffmpeg', '-y', '-i', str(bounce_path),
             '-c:a', codec, '-b:a', bitrate, tmp_name],
            check=True, capture_output=True
        )
        return send_file(tmp_name, mimetype=mime, as_attachment=True,
                         download_name=f'{rec_name}{suffix}')
    except subprocess.CalledProcessError as e:
        logger.error(f"ffmpeg export failed: {e.stderr.decode()}")
        return jsonify({'success': False, 'message': 'Transcoding failed'}), 500


@api.route('/sessions/<path:session_name>/downmix', methods=['POST'])
def downmix_session(session_name):
    """Manual trigger: create bounce on demand (used as fallback)."""
    recording_path = (storage_manager.storage_path / session_name).resolve()
    if not recording_path.exists():
        return jsonify({'success': False, 'message': 'Session not found'}), 404

    bounce_path = recording_path / 'bounce' / 'stereo_mix.wav'
    if bounce_path.exists() and bounce_path.stat().st_size > 44:
        return jsonify({
            'success': True, 'cached': True,
            'url':  f'/api/sessions/{session_name}/bounce',
            'download_url': f'/api/sessions/{session_name}/bounce/download',
        })

    with _bounce_lock:
        status = _bounce_jobs.get(str(recording_path), 'idle')
    if status == 'mixing':
        return jsonify({'success': True, 'cached': False, 'status': 'mixing',
                        'url': None})

    try:
        _do_downmix(recording_path)
        return jsonify({
            'success': True, 'cached': False,
            'url':  f'/api/sessions/{session_name}/bounce',
            'download_url': f'/api/sessions/{session_name}/bounce/download',
        })
    except Exception as e:
        logger.error(f"Downmix error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ---------------------------------------------------------------------------
# USB hardware playback  (Play on Mixer → XR18 Aux via USB 17/18)
# ---------------------------------------------------------------------------

def _play_via_usb(file_path: Path) -> None:
    """
    Play stereo_mix.wav through XR18 USB channels 17/18 (Aux L/R) using aplay.

    Using aplay instead of sounddevice/PortAudio avoids a fatal ALSA assertion
    crash that occurs when a PortAudio OutputStream is opened on the same hw:
    device that the recording InputStream already holds.  aplay opens only the
    PLAYBACK PCM direction and coexists with the capture stream cleanly.
    """
    global _playback_position, _playback_total, _playback_sr, _playback_process
    import soundfile as sf
    import numpy as np

    _playback_position = 0
    _playback_total    = 0
    _playback_process  = None

    try:
        data, sr = sf.read(str(file_path), dtype='float32', always_2d=True)

        alsa_dev = _find_xr18_alsa_device()
        logger.info(f"USB playback → {alsa_dev}  sr={sr}  frames={len(data)}")

        # XR18 requires S32_LE (24-bit audio in 32-bit container, 18 ch, 48 kHz)
        n_out   = 18
        scale   = 2147483647  # 2^31 - 1
        out_i32 = np.zeros((len(data), n_out), dtype='int32')
        out_i32[:, 16] = np.clip(data[:, 0] * scale, -2147483648, scale).astype(np.int32)
        out_i32[:, 17] = np.clip(data[:, 1] * scale, -2147483648, scale).astype(np.int32)

        raw_bytes       = out_i32.tobytes()
        bytes_per_frame = n_out * 4          # 18 ch × 4 bytes
        chunk_frames    = 512                # ~10 ms — keeps stop latency short
        chunk_bytes     = chunk_frames * bytes_per_frame

        _playback_total = len(data)
        _playback_sr    = sr

        proc = subprocess.Popen(
            ['/usr/bin/aplay', '-D', alsa_dev,
             '-c', str(n_out), '-r', str(sr), '-f', 'S32_LE', '-q', '-'],
            stdin=subprocess.PIPE
        )
        _playback_process = proc

        pos_bytes = 0
        try:
            while pos_bytes < len(raw_bytes) and not _playback_stop.is_set():
                proc.stdin.write(raw_bytes[pos_bytes:pos_bytes + chunk_bytes])
                pos_bytes += chunk_bytes
                _playback_position = pos_bytes // bytes_per_frame
        except BrokenPipeError:
            pass
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

        if _playback_stop.is_set() and proc.poll() is None:
            proc.kill()
        proc.wait(timeout=3)

    except Exception as e:
        logger.error(f"USB playback error: {e}")
    finally:
        _playback_process = None
        if not _playback_stop.is_set():
            _playback_position = _playback_total


@api.route('/sessions/<path:session_name>/playback/start', methods=['POST'])
def start_playback(session_name):
    """Play bounce/stereo_mix.wav through XR18 USB 17/18 (Aux L/R)."""
    global _playback_thread

    # Refuse to play while a recording is in progress
    if audio_engine and audio_engine.is_recording:
        return jsonify({'success': False,
                        'message': 'Cannot play back while recording is active'}), 409

    recording_path = (storage_manager.storage_path / session_name).resolve()
    bounce_path    = recording_path / 'bounce' / 'stereo_mix.wav'

    if not bounce_path.exists():
        try:
            _do_downmix(recording_path)
        except Exception as e:
            return jsonify({'success': False,
                            'message': f'Bounce not ready: {e}'}), 400

    # Stop any current playback then start fresh
    _playback_stop.set()
    if _playback_thread and _playback_thread.is_alive():
        _playback_thread.join(timeout=2)

    # Clear the stop flag HERE (before the thread starts) so the status
    # endpoint never sees playing=false between thread-start and thread-clear.
    _playback_stop.clear()

    _playback_thread = threading.Thread(
        target=_play_via_usb, args=(bounce_path,), daemon=True)
    _playback_thread.start()

    return jsonify({'success': True, 'message': 'Playback started on mixer'})


@api.route('/playback/stop', methods=['POST'])
def stop_playback():
    """Stop any active USB mixer playback."""
    global _playback_process
    _playback_stop.set()
    if _playback_process is not None and _playback_process.poll() is None:
        try:
            _playback_process.kill()
        except Exception:
            pass
    return jsonify({'success': True, 'message': 'Playback stopped'})


@api.route('/playback/status', methods=['GET'])
def playback_status():
    """Return whether playback is active plus position/duration for the timeline."""
    active   = bool(_playback_thread and _playback_thread.is_alive()
                    and not _playback_stop.is_set())
    sr       = _playback_sr or 48000
    pos_sec  = round(_playback_position / sr, 2)
    dur_sec  = round(_playback_total    / sr, 2)
    pct      = round((pos_sec / dur_sec * 100) if dur_sec > 0 else 0, 1)
    return jsonify({
        'success':      True,
        'playing':      active,
        'position_sec': pos_sec,
        'duration_sec': dur_sec,
        'progress_pct': pct,
    })


# ---------------------------------------------------------------------------
# System restart
# ---------------------------------------------------------------------------

@api.route('/monitoring/restart', methods=['POST'])
def monitoring_restart():
    """Restart just the audio monitoring stream without restarting the service."""
    if not audio_engine:
        return jsonify({'success': False, 'message': 'Audio engine not available'}), 500
    try:
        if audio_engine.is_monitoring:
            audio_engine.stop_monitoring()
        ok = audio_engine.start_monitoring()
        return jsonify({'success': ok,
                        'message': 'Monitoring restarted' if ok else 'Failed to restart monitoring',
                        'sample_rate': audio_engine.sample_rate})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@api.route('/system/restart', methods=['POST'])
def system_restart():
    """
    Restart the mixpi-recorder systemd service.
    Spawns the restart command in a background thread so the HTTP response
    is returned before the process is killed.
    """
    import shutil

    if not shutil.which('systemctl'):
        return jsonify({'success': False,
                        'message': 'systemctl not available'}), 500

    def _do_restart():
        import time
        time.sleep(0.5)   # let the HTTP response fly first
        subprocess.run(['sudo', 'systemctl', 'restart', 'mixpi-recorder'],
                       check=False)

    threading.Thread(target=_do_restart, daemon=True).start()
    return jsonify({'success': True, 'message': 'Service restarting…'})


@api.route('/system/https/status', methods=['GET'])
def get_https_status():
    """Check if HTTPS certificates exist and return status."""
    cert_dir = Path('/opt/mixpi/certs')
    cert_file = cert_dir / 'cert.pem'
    key_file = cert_dir / 'key.pem'
    
    enabled = cert_file.exists() and key_file.exists()
    
    return jsonify({
        'success': True,
        'enabled': enabled,
        'certs_exist': enabled,
        'hostname': socket.gethostname()
    })


@api.route('/system/https/enable', methods=['POST'])
def enable_https():
    """Run setup_https.sh to generate certificates and restart the service."""
    if audio_engine and audio_engine.is_recording:
        return jsonify({'success': False, 'message': 'Cannot enable HTTPS while recording'}), 409

    def _do_enable():
        time.sleep(0.5)
        # Run the setup script with --auto flag
        subprocess.run(['sudo', 'bash', '/opt/mixpi/scripts/setup_https.sh', '--auto'], check=False)
        # The script itself might restart the service, but let's be sure
        subprocess.run(['sudo', 'systemctl', 'restart', 'mixpi-recorder'], check=False)

    threading.Thread(target=_do_enable, daemon=True).start()
    return jsonify({'success': True, 'message': 'Generating certificates and restarting service…'})


@api.route('/system/https/disable', methods=['POST'])
def disable_https():
    """Remove certificates and restart the service to fall back to HTTP."""
    if audio_engine and audio_engine.is_recording:
        return jsonify({'success': False, 'message': 'Cannot disable HTTPS while recording'}), 409

    def _do_disable():
        time.sleep(0.5)
        # Remove certs
        subprocess.run(['sudo', 'rm', '-f', '/opt/mixpi/certs/cert.pem', '/opt/mixpi/certs/key.pem'], check=False)
        # Restart service
        subprocess.run(['sudo', 'systemctl', 'restart', 'mixpi-recorder'], check=False)

    threading.Thread(target=_do_disable, daemon=True).start()
    return jsonify({'success': True, 'message': 'Removing certificates and restarting service…'})


@api.route('/system/reboot', methods=['POST'])
def system_reboot():
    """Reboot the Raspberry Pi."""
    if audio_engine and audio_engine.is_recording:
        return jsonify({'success': False, 'message': 'Cannot reboot while recording'}), 409

    def _do_reboot():
        time.sleep(0.5)
        subprocess.run(['sudo', 'reboot'], check=False)

    threading.Thread(target=_do_reboot, daemon=True).start()
    return jsonify({'success': True, 'message': 'System rebooting…'})


# ---------------------------------------------------------------------------
# Quality presets
# ---------------------------------------------------------------------------

@api.route('/presets', methods=['GET'])
def get_presets():
    """Return all recording quality presets plus the currently active one."""
    current_rate  = audio_engine.sample_rate if audio_engine else None
    current_depth = audio_engine.bit_depth   if audio_engine else None

    # Build human-readable rate string for tag substitution
    def _rate_label(hz):
        if hz is None: return 'Auto'
        return f'{hz // 1000} kHz' if hz % 1000 == 0 else f'{hz / 1000:.1f} kHz'

    rate_str = _rate_label(current_rate)

    presets = []
    for p in RECORDING_PRESETS:
        entry = dict(p)
        # Replace 'Auto kHz' placeholder with the actual detected hardware rate
        entry['tag'] = entry['tag'].replace('Auto kHz', rate_str)
        # Active = bit depth matches (sample rate is always hardware-determined)
        entry['active'] = (p['bit_depth'] == current_depth)
        presets.append(entry)

    return jsonify({
        'success': True,
        'presets': presets,
        'current': {'sample_rate': current_rate, 'bit_depth': current_depth},
    })


@api.route('/settings', methods=['POST'])
def update_settings():
    """Apply bit depth; sample rate is always auto-detected from hardware."""
    if audio_engine and audio_engine.is_recording:
        return jsonify({
            'success': False,
            'message': 'Cannot change settings while recording is active.',
        }), 409

    data = request.get_json() or {}
    bit_depth = data.get('bit_depth')

    if not bit_depth:
        return jsonify({'success': False, 'message': 'bit_depth required'}), 400

    # Always use the hardware-detected rate — never override from the request
    hw_rate = audio_engine.sample_rate if audio_engine else 48000

    try:
        result = audio_engine.update_settings(int(hw_rate), int(bit_depth))

        # Persist bit depth to config.yaml (not sample_rate — that's hardware-determined)
        import yaml as _yaml, os as _os
        config_file = _os.environ.get('MIXPI_CONFIG', 'config.yaml')
        try:
            with open(config_file, 'r') as _f:
                _cfg = _yaml.safe_load(_f)
            _cfg['audio']['bit_depth'] = int(bit_depth)
            with open(config_file, 'w') as _f:
                _yaml.dump(_cfg, _f, default_flow_style=False, allow_unicode=True)
            logger.info(f"Persisted quality {hw_rate}Hz/{bit_depth}bit → {config_file}")
        except Exception as _e:
            logger.warning(f"Could not persist quality to config: {_e}")

        return jsonify({
            'success': True,
            'message': f'Settings applied: {hw_rate} Hz / {bit_depth}-bit',
            'sample_rate': audio_engine.sample_rate,
            'bit_depth': audio_engine.bit_depth,
        })
    except Exception as e:
        logger.error(f"Error applying settings: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ---------------------------------------------------------------------------
# UI state — shared across all browsers / sessions
# ---------------------------------------------------------------------------

_UI_STATE_FILE = Path('ui_state.json')


def _load_ui_state() -> dict:
    try:
        if _UI_STATE_FILE.exists():
            import json as _json
            return _json.loads(_UI_STATE_FILE.read_text())
    except Exception:
        pass
    return {}


def _save_ui_state(updates: dict) -> None:
    import json as _json
    state = _load_ui_state()
    state.update({k: v for k, v in updates.items() if v is not None})
    _UI_STATE_FILE.write_text(_json.dumps(state, indent=2))


@api.route('/ui-state', methods=['GET'])
def get_ui_state():
    """Return the shared UI state (session name, notes, channel preset, etc.)."""
    return jsonify({'success': True, 'state': _load_ui_state()})


@api.route('/ui-state', methods=['POST'])
def save_ui_state():
    """Persist one or more UI-state fields so all browsers stay in sync."""
    data = request.get_json(silent=True) or {}
    try:
        _save_ui_state(data)
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"UI-state save error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


# ---------------------------------------------------------------------------
# USB audio device detection
# ---------------------------------------------------------------------------

# Known mixer USB audio device name substrings (case-insensitive)
_USB_MIXER_KEYWORDS = ['xr18', 'x-air', 'xair', 'x air', 'xr12', 'xr16', 'xr8', 'behringer']

@api.route('/devices/usb', methods=['GET'])
def get_usb_devices():
    """
    Scan for known mixer USB audio devices using sounddevice.
    Returns list of matched devices with channel/rate info.
    """
    try:
        import sounddevice as sd
        devices = sd.query_devices()
        found = []
        for i, dev in enumerate(devices):
            name_lower = dev['name'].lower()
            if any(kw in name_lower for kw in _USB_MIXER_KEYWORDS):
                found.append({
                    'index':          i,
                    'name':           dev['name'],
                    'input_channels': dev['max_input_channels'],
                    'output_channels':dev['max_output_channels'],
                    'sample_rate':    int(dev['default_samplerate']),
                })
        return jsonify({'success': True, 'devices': found})
    except Exception as e:
        logger.warning(f"USB device scan error: {e}")
        return jsonify({'success': False, 'error': str(e), 'devices': []})


# ---------------------------------------------------------------------------
# Storage locations
# ---------------------------------------------------------------------------

def _read_proc_mounts():
    """Return dict of mount_point -> (device, fs_type) from /proc/mounts."""
    mounts = {}
    try:
        with open('/proc/mounts', 'r') as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 3:
                    mounts[parts[1]] = (parts[0], parts[2])  # mount_point -> (device, fs_type)
    except Exception as e:
        logger.warning(f"Could not read /proc/mounts: {e}")
    return mounts


def _scan_usb_mount_dirs():
    """
    Return (path, device, fs_type) tuples for actual external mount points
    under /media or /mnt, read from /proc/mounts.
    """
    from pathlib import Path
    mounts = _read_proc_mounts()
    results = []
    for mount_point, (device, fs_type) in mounts.items():
        if (mount_point.startswith('/media/') or mount_point.startswith('/mnt/')):
            p = Path(mount_point)
            if p.is_dir():
                results.append((p, device, fs_type))
    return results


@api.route('/storage/locations', methods=['GET'])
def get_storage_locations():
    """
    Return available storage destinations with free space, benchmarked write speed,
    filesystem type, and block device path. The local recordings path is always
    included; mounted external drives are auto-detected from /proc/mounts.
    """
    try:
        from pathlib import Path
        import shutil as _shutil

        # Fixed local/SD-Card path — always the on-board storage, regardless of
        # what storage_path is currently configured (it may point to a USB drive).
        local_path  = Path('/opt/mixpi/recordings')
        active_path = storage_manager.storage_path
        required_mbps = (audio_engine.sample_rate * audio_engine.channels *
                         (audio_engine.bit_depth / 8)) / 1_000_000

        # Get fs_type for the local path from /proc/mounts
        mounts = _read_proc_mounts()
        local_fs = mounts.get(str(local_path), (None, 'ext4'))[1]

        def _location_info(path: Path, label: str, loc_type: str,
                           device: str = '', fs_type: str = '') -> dict:
            path.mkdir(parents=True, exist_ok=True)
            try:
                disk = _shutil.disk_usage(path)
                free_gb   = round(disk.free  / (1024 ** 3), 1)
                total_gb  = round(disk.total / (1024 ** 3), 1)
                pct_used  = round((disk.used / disk.total * 100) if disk.total else 0, 1)
            except Exception:
                free_gb = total_gb = pct_used = 0.0
            write_mbps = storage_manager.benchmark_write_speed(path)
            return {
                'path':         str(path),
                'label':        label,
                'type':         loc_type,
                'device':       device,
                'fs_type':      fs_type,
                'free_gb':      free_gb,
                'total_gb':     total_gb,
                'percent_used': pct_used,
                'write_mbps':   write_mbps,
                'sufficient':   write_mbps >= required_mbps * 2,
                'active':       path.resolve() == active_path.resolve(),
            }

        locations = [_location_info(local_path, 'Local (SD Card)', 'local',
                                    device='', fs_type=local_fs)]

        # USB drives: exclude anything that resolves to the same path as local_path
        seen = {local_path.resolve()}
        for mount, device, fs_type in _scan_usb_mount_dirs():
            try:
                rp = mount.resolve()
                if rp in seen:
                    continue
                seen.add(rp)
                label = f'USB: {mount.name}'
                locations.append(_location_info(mount, label, 'usb',
                                                device=device, fs_type=fs_type))
            except Exception:
                pass

        return jsonify({'success': True, 'locations': locations,
                        'required_mbps': round(required_mbps, 2)})
    except Exception as e:
        logger.error(f"Storage locations error: {e}")
        return jsonify({'success': False, 'error': str(e), 'locations': []}), 500


@api.route('/storage/benchmark', methods=['POST'])
def benchmark_storage():
    """
    Run a write-speed benchmark on a storage path.
    Body: { "path": "/media/music/MIXPI", "size_mb": 64 }
    Returns MB/s and a pass/fail against the required recording bitrate.
    """
    data      = request.get_json(silent=True) or {}
    path_str  = (data.get('path') or '').strip()
    size_mb   = min(int(data.get('size_mb', 64)), 256)   # cap at 256 MB

    if not path_str:
        return jsonify({'success': False, 'error': 'path required'}), 400

    path = Path(path_str)
    if not path.exists():
        return jsonify({'success': False, 'error': f'Path not found: {path_str}'}), 404

    # Invalidate cache so we always get a fresh result
    from src.storage_manager import _speed_cache
    _speed_cache.pop(path_str, None)

    try:
        mbps = storage_manager.benchmark_write_speed(path, size_mb=size_mb)
        required_mbps = 0.0
        if audio_engine:
            ch  = audio_engine.channels
            sr  = audio_engine.sample_rate
            bd  = audio_engine.bit_depth
            required_mbps = round((ch * sr * (bd / 8)) / (1024 * 1024), 1)

        sufficient = mbps >= required_mbps * 1.5 if required_mbps else mbps > 10
        rating = (
            'excellent' if mbps >= required_mbps * 3
            else 'good'     if mbps >= required_mbps * 1.5
            else 'marginal' if mbps >= required_mbps
            else 'too slow'
        )
        return jsonify({
            'success':      True,
            'write_mbps':   mbps,
            'required_mbps': required_mbps,
            'sufficient':   sufficient,
            'rating':       rating,
            'size_mb':      size_mb,
        })
    except Exception as e:
        logger.error(f"Benchmark error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@api.route('/storage/format', methods=['POST'])
def format_storage_device():
    """
    Format an external USB drive.
    Body: { "path": "...", "device": "...", "label": "MIXPI", "fs_format": "exfat" }
    fs_format: exfat | ext4 | hfsplus | vfat

    Safety: ONLY paths under /media/ or /mnt/ are accepted — the SD card / boot
    disk can never be formatted regardless of what the client sends.
    """
    import subprocess, re
    from pathlib import Path

    # Supported formats: display name, mkfs command builder, label flag, max label len
    FS_FORMATS = {
        'exfat':   {'name': 'exFAT',   'cmd': lambda dev, lbl: ['/usr/bin/sudo', '/usr/sbin/mkfs.exfat',  '-L', lbl, dev]},
        'ext4':    {'name': 'ext4',    'cmd': lambda dev, lbl: ['/usr/bin/sudo', '/usr/sbin/mkfs.ext4',   '-L', lbl, '-F', dev]},
        'hfsplus': {'name': 'HFS+',    'cmd': lambda dev, lbl: ['/usr/bin/sudo', '/usr/sbin/mkfs.hfsplus','-v', lbl, dev]},
        'vfat':    {'name': 'FAT32',   'cmd': lambda dev, lbl: ['/usr/bin/sudo', '/usr/sbin/mkfs.vfat',   '-F', '32', '-n', lbl, dev]},
    }

    data = request.get_json(silent=True) or {}
    path_str   = (data.get('path')      or '').strip()
    label_raw  = (data.get('label')     or 'MIXPI').strip()
    fs_format  = (data.get('fs_format') or 'exfat').strip().lower()

    if fs_format not in FS_FORMATS:
        return jsonify({'success': False,
                        'error': f'Unsupported format: {fs_format}. Choose: {", ".join(FS_FORMATS)}'}), 400

    fs_info = FS_FORMATS[fs_format]

    # Label constraints: FAT32/exFAT max 11 chars, ext4/HFS+ max 16 — cap at 11 for safety
    label = re.sub(r'[^A-Za-z0-9\-_]', '', label_raw).upper()[:11] or 'MIXPI'

    # ── Safety layer 1: path must be under /media/ or /mnt/ ──────────────────
    if not (path_str.startswith('/media/') or path_str.startswith('/mnt/')):
        logger.warning(f"Format rejected — path not external: {path_str}")
        return jsonify({'success': False,
                        'error': 'Only external drives under /media/ or /mnt/ can be formatted.'}), 403

    # ── Safety layer 2: path must be a real mount point in /proc/mounts ──────
    mounts = _read_proc_mounts()
    if path_str not in mounts:
        return jsonify({'success': False,
                        'error': f'Path {path_str} is not a mounted filesystem.'}), 409

    # Use device from /proc/mounts as ground truth
    real_device = mounts[path_str][0]

    # ── Safety layer 3: recording must not be in progress ────────────────────
    if audio_engine and getattr(audio_engine, 'is_recording', False):
        return jsonify({'success': False,
                        'error': 'Cannot format while recording is in progress.'}), 409

    logger.info(f"Formatting {real_device} (at {path_str}) as {fs_info['name']}, label={label}")

    try:
        # 1. Unmount
        subprocess.run(['/usr/bin/sudo', '/usr/bin/umount', path_str],
                       check=True, timeout=15,
                       capture_output=True, text=True)

        # 2. Format with chosen filesystem
        subprocess.run(fs_info['cmd'](real_device, label),
                       check=True, timeout=120,
                       capture_output=True, text=True)

        # 3. Re-mount using sudo mount (udisksctl requires a polkit/TTY session
        #    which a systemd service never has).
        # For FAT-family filesystems pass uid/gid so the service user can write;
        # ext4/HFS+ inherit ownership from the filesystem itself.
        new_mount = f'/media/music/{label}'
        subprocess.run(['/usr/bin/sudo', '/usr/bin/mkdir', '-p', new_mount],
                       timeout=5, capture_output=True)

        import pwd as _pwd
        try:
            _pw = _pwd.getpwnam('music')
            _uid, _gid = _pw.pw_uid, _pw.pw_gid
        except KeyError:
            _uid, _gid = 1000, 1000

        _fat_fs = fs_format in ('exfat', 'vfat')
        _mount_opts = f'uid={_uid},gid={_gid},fmask=0022,dmask=0022,iocharset=utf8' if _fat_fs else ''
        _mount_cmd = ['/usr/bin/sudo', '/usr/bin/mount']
        if _mount_opts:
            _mount_cmd += ['-o', _mount_opts]
        _mount_cmd += [real_device, new_mount]

        mount_result = subprocess.run(_mount_cmd, timeout=20, capture_output=True, text=True)
        if mount_result.returncode != 0:
            # Fall back — mount without specifying a path (OS picks one)
            fb = subprocess.run(
                ['/usr/bin/sudo', '/usr/bin/mount', real_device],
                timeout=20, capture_output=True, text=True)
            if fb.returncode != 0:
                new_mount = None
                logger.warning(f"Re-mount failed: {mount_result.stderr}")

        # Invalidate speed cache for old path
        from src.storage_manager import _speed_cache
        _speed_cache.pop(path_str, None)

        # If storage was pointing at the old path, update config.yaml and
        # the live storage_manager so the app can keep running without restart.
        if new_mount and storage_manager:
            try:
                storage_manager.set_storage_path(new_mount)
                import yaml as _yaml, os as _os
                config_file = _os.environ.get('MIXPI_CONFIG', 'config.yaml')
                with open(config_file, 'r') as _f:
                    _cfg = _yaml.safe_load(_f)
                _cfg.setdefault('storage', {})['storage_path'] = new_mount
                with open(config_file, 'w') as _f:
                    _yaml.dump(_cfg, _f, default_flow_style=False, allow_unicode=True)
                logger.info(f"Storage path updated to {new_mount} in config.yaml")
            except Exception as _e:
                logger.warning(f"Could not update storage path in config: {_e}")

        logger.info(f"Format complete: {real_device} → {fs_info['name']} label={label}, new mount={new_mount}")
        return jsonify({
            'success':   True,
            'message':   f'Drive formatted as {fs_info["name"]} with label "{label}".',
            'new_path':  new_mount,
            'label':     label,
        })

    except subprocess.CalledProcessError as e:
        err = e.stderr or str(e)
        logger.error(f"Format failed: {err}")
        return jsonify({'success': False, 'error': f'Format failed: {err}'}), 500
    except subprocess.TimeoutExpired:
        logger.error("Format timed out")
        return jsonify({'success': False, 'error': 'Format timed out.'}), 500
    except Exception as e:
        logger.error(f"Format error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@api.route('/storage/select', methods=['POST'])
def select_storage_location():
    """
    Switch the active storage path to a new location (in-memory only; reverts on restart).
    Body: { "path": "/media/music/KINGSTON" }
    """
    try:
        from pathlib import Path
        import shutil as _shutil

        data = request.get_json(silent=True) or {}
        path_str = (data.get('path') or '').strip()
        if not path_str:
            return jsonify({'success': False, 'error': 'path required'}), 400

        new_path = Path(path_str)
        storage_manager.set_storage_path(new_path)

        # Persist to config.yaml so the choice survives service restarts
        import yaml as _yaml, os as _os
        config_file = _os.environ.get('MIXPI_CONFIG', 'config.yaml')
        try:
            with open(config_file, 'r') as _f:
                _cfg = _yaml.safe_load(_f)
            _cfg['recording']['storage_path'] = str(new_path)
            with open(config_file, 'w') as _f:
                _yaml.dump(_cfg, _f, default_flow_style=False, allow_unicode=True)
            logger.info(f"Persisted storage_path → {config_file}")
        except Exception as _e:
            logger.warning(f"Could not persist storage_path to config: {_e}")

        disk = _shutil.disk_usage(new_path)
        free_gb = round(disk.free / (1024 ** 3), 1)
        total_gb = round(disk.total / (1024 ** 3), 1)
        logger.info(f"Storage switched to {new_path} ({free_gb} GB free)")

        return jsonify({
            'success':   True,
            'path':      str(new_path),
            'free_gb':   free_gb,
            'total_gb':  total_gb,
        })
    except Exception as e:
        logger.error(f"Storage select error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


# ---------------------------------------------------------------------------
# USB routing
# ---------------------------------------------------------------------------

# Source options for /config/routing/CARD on the XR18.
# Index matches the integer value sent/received via OSC.
USB_SOURCES = [
    'AN 1-2',    # 0
    'AN 3-4',    # 1
    'AN 5-6',    # 2
    'AN 7-8',    # 3
    'AN 9-10',   # 4
    'AN 11-12',  # 5
    'AN 13-14',  # 6
    'AN 15-16',  # 7
    'MIX 1-2',   # 8
    'MIX 3-4',   # 9
    'MIX 5-6',   # 10
    'MIX 7-8',   # 11
    'MIX 9-10',  # 12
    'MIX 11-12', # 13
    'MAIN L/R',  # 14
]

# Metadata for each of the 9 USB stereo recording pairs (1-based pair number)
# Each entry is one OSC routing block (two consecutive USB channels sharing a source).
# Whether those channels carry mono or stereo content depends on the channel
# Stereo Link setting — that is separate from this routing assignment.
USB_PAIRS_META = [
    {'pair': 1, 'ch_a': 1,  'ch_b': 2,  'label': 'USB Ch 1 & 2'},
    {'pair': 2, 'ch_a': 3,  'ch_b': 4,  'label': 'USB Ch 3 & 4'},
    {'pair': 3, 'ch_a': 5,  'ch_b': 6,  'label': 'USB Ch 5 & 6'},
    {'pair': 4, 'ch_a': 7,  'ch_b': 8,  'label': 'USB Ch 7 & 8'},
    {'pair': 5, 'ch_a': 9,  'ch_b': 10, 'label': 'USB Ch 9 & 10'},
    {'pair': 6, 'ch_a': 11, 'ch_b': 12, 'label': 'USB Ch 11 & 12'},
    {'pair': 7, 'ch_a': 13, 'ch_b': 14, 'label': 'USB Ch 13 & 14'},
    {'pair': 8, 'ch_a': 15, 'ch_b': 16, 'label': 'USB Ch 15 & 16'},
    {'pair': 9, 'ch_a': 17, 'ch_b': 18, 'label': 'USB Ch 17 & 18'},
]


@api.route('/routing', methods=['GET'])
def get_routing():
    """
    Return current USB recording routing from the mixer.
    Each entry describes one stereo pair and which source feeds it.
    When OSC is unavailable, returns the cached state (may be empty).
    """
    if not osc_client or not osc_client.is_connected:
        return jsonify({
            'success': True,
            'osc_connected': False,
            'pairs': [],
            'sources': USB_SOURCES,
        })

    raw = osc_client.get_routing()
    if not raw:
        raw = osc_client.fetch_routing()

    pairs = []
    for i, meta in enumerate(USB_PAIRS_META):
        source_idx = raw[i] if i < len(raw) else 0
        pairs.append({
            **meta,
            'source': source_idx,
            'source_label': USB_SOURCES[source_idx] if source_idx < len(USB_SOURCES) else str(source_idx),
        })

    return jsonify({
        'success': True,
        'osc_connected': True,
        'pairs': pairs,
        'sources': USB_SOURCES,
    })


@api.route('/routing', methods=['POST'])
def set_routing():
    """
    Update a single USB routing pair.
    Body: { "pair": 1, "source": 3 }   (1-based pair, source index)
    """
    if not osc_client or not osc_client.is_connected:
        return jsonify({'success': False, 'message': 'OSC not connected to mixer'}), 503

    data = request.get_json() or {}
    pair_1based = data.get('pair')
    source_idx = data.get('source')

    if pair_1based is None or source_idx is None:
        return jsonify({'success': False, 'message': 'pair and source are required'}), 400

    pair_idx = int(pair_1based) - 1  # convert to 0-based
    if not (0 <= pair_idx < len(USB_PAIRS_META)):
        return jsonify({'success': False, 'message': f'pair must be 1–{len(USB_PAIRS_META)}'}), 400

    source_idx = int(source_idx)
    if not (0 <= source_idx < len(USB_SOURCES)):
        return jsonify({'success': False, 'message': f'source must be 0–{len(USB_SOURCES) - 1}'}), 400

    ok = osc_client.set_routing_pair(pair_idx, source_idx)
    if not ok:
        return jsonify({'success': False, 'message': 'Failed to send routing command'}), 500

    return jsonify({
        'success': True,
        'pair': int(pair_1based),
        'source': source_idx,
        'source_label': USB_SOURCES[source_idx],
    })


# ---------------------------------------------------------------------------
# OSC connect / reconnect
# ---------------------------------------------------------------------------

@api.route('/osc/connect', methods=['POST'])
def osc_connect():
    """Connect (or reconnect) the OSC client to a given mixer IP.
    Body: { "ip": "192.168.1.xxx" }
    Triggers fetch_all + subscription so channel names load immediately.
    """
    data = request.get_json(silent=True) or {}
    ip = (data.get('ip') or '').strip()
    if not ip:
        return jsonify({'success': False, 'error': 'ip required'}), 400

    if not osc_client:
        return jsonify({'success': False, 'error': 'OSC client not initialised'}), 500

    try:
        ok = osc_client.reconnect(ip)
        if ok:
            logger.info(f"OSC reconnected to {ip} via API")
            return jsonify({'success': True, 'ip': ip, 'connected': True})
        else:
            return jsonify({'success': False, 'ip': ip, 'connected': False,
                            'error': f'Mixer at {ip} did not respond'})
    except Exception as e:
        logger.error(f"OSC connect error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


# Network discovery
# ---------------------------------------------------------------------------

def _build_osc_message(address: str) -> bytes:
    """Build a minimal OSC message with no arguments."""
    addr_enc = address.encode('ascii') + b'\x00'
    addr_pad = addr_enc + b'\x00' * ((4 - len(addr_enc) % 4) % 4)
    type_tag = b',\x00\x00\x00'
    return addr_pad + type_tag


def _osc_read_string(data: bytes, pos: int):
    """Read a null-terminated, 4-byte-padded OSC string at pos.
    Returns (string, next_pos) where next_pos is the first byte after padding."""
    end = data.find(b'\x00', pos)
    if end == -1:
        return data[pos:].decode('ascii', errors='replace'), len(data)
    s = data[pos:end].decode('ascii', errors='replace')
    # Advance to next 4-byte boundary after the null terminator
    return s, ((end + 4) // 4) * 4


def _parse_xinfo_response(data: bytes) -> dict:
    """Parse an OSC /xinfo (or /info) response from an XAir/X32 mixer.

    XAir response format:
        address:  /xinfo
        type tag: ,ssss
        args:     <IP string> <name string> <model string> <firmware string>
    """
    # Skip address (/xinfo)
    _, pos = _osc_read_string(data, 0)
    # Skip type tag (,ssss) — crucial: advance past the whole tag, not just its start
    _, pos = _osc_read_string(data, pos)
    # Read string arguments
    strings = []
    while pos < len(data):
        s, pos = _osc_read_string(data, pos)
        strings.append(s)
    return {
        'ip':       strings[0] if len(strings) > 0 else '',
        'name':     strings[1] if len(strings) > 1 else '',
        'model':    strings[2] if len(strings) > 2 else 'XAir',
        'firmware': strings[3] if len(strings) > 3 else '',
    }


def _get_discovery_targets(port: int, configured_host: str = '') -> list:
    """Return list of (host, port) tuples to send /xinfo discovery to.

    Priority order:
    1. Configured OSC host (unicast — most reliable)
    2. Directed subnet broadcasts from 'ip -4 addr show'
    3. /24 broadcast computed from hostname IPs (fallback)
    4. Global 255.255.255.255 broadcast (last resort)
    """
    targets = []
    seen: set = set()

    def add(h: str):
        if h and h not in seen:
            seen.add(h)
            targets.append((h, port))

    if configured_host and configured_host not in ('', '255.255.255.255', '0.0.0.0'):
        add(configured_host)

    try:
        result = subprocess.run(
            ['ip', '-4', 'addr', 'show'],
            capture_output=True, text=True, timeout=2
        )
        for m in re.finditer(r'inet\s+\S+\s+brd\s+(\S+)', result.stdout):
            add(m.group(1))
    except Exception:
        pass

    # Fallback if no subnet broadcasts found
    if not targets:
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                ip = info[4][0]
                if not ip.startswith('127.'):
                    parts = ip.split('.')
                    add('.'.join(parts[:3]) + '.255')
        except Exception:
            pass

    add('255.255.255.255')
    return targets


def _discover_xair(timeout: float = 2.5, port: int = 10024) -> list:
    """Broadcast /xinfo on the local network and collect XAir/X32 responses.
    Returns list of dicts: {ip, name, model, firmware}
    """
    msg_xinfo = _build_osc_message('/xinfo')
    msg_info  = _build_osc_message('/info')
    results = []
    seen: set = set()

    configured_host = ''
    try:
        from flask import current_app
        cfg = current_app.config.get('APP_CONFIG', {})
        osc_cfg = cfg.get('osc', {})
        configured_host = str(osc_cfg.get('xair_ip', '') or osc_cfg.get('host', ''))
    except Exception:
        pass

    targets = _get_discovery_targets(port, configured_host)
    logger.debug(f"XAir discovery targets: {[h for h, _ in targets]}")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.settimeout(0.3)

    try:
        sock.bind(('', 0))
        for host, p in targets:
            try:
                sock.sendto(msg_xinfo, (host, p))
                sock.sendto(msg_info, (host, p))
            except Exception as e:
                logger.debug(f"Discovery send to {host}:{p} failed: {e}")

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                data, (src_ip, _) = sock.recvfrom(512)
                if src_ip in seen:
                    continue
                seen.add(src_ip)
                try:
                    info = _parse_xinfo_response(data)
                    results.append({
                        'ip':       info['ip'] or src_ip,
                        'name':     info['name'],
                        'model':    info['model'] or 'XAir',
                        'firmware': info['firmware'],
                    })
                    logger.info(f"XAir found: {info}")
                except Exception as parse_err:
                    logger.debug(f"XAir parse error from {src_ip}: {parse_err}")
                    results.append({'ip': src_ip, 'name': src_ip, 'model': 'XAir', 'firmware': ''})
            except socket.timeout:
                pass
    except Exception as e:
        logger.warning(f"XAir discovery error: {e}")
    finally:
        sock.close()

    return results


@api.route('/discover', methods=['GET'])
def discover_devices():
    """Scan the local network for XAir/X32 mixers via OSC broadcast."""
    timeout = float(request.args.get('timeout', 2.0))
    mixers = _discover_xair(timeout=timeout)
    return jsonify({'success': True, 'mixers': mixers})


@api.route('/network', methods=['GET'])
def network_info():
    """Return this Pi's hostname and local IP addresses."""
    hostname = socket.gethostname()
    # All non-loopback IPv4 addresses
    ips = []
    try:
        result = subprocess.run(
            ['hostname', '-I'], capture_output=True, text=True, timeout=2
        )
        ips = [ip for ip in result.stdout.strip().split() if ':' not in ip]
    except Exception:
        try:
            ips = [socket.gethostbyname(hostname)]
        except Exception:
            pass

    mdns = f"{hostname}.local"
    return jsonify({
        'success': True,
        'hostname': hostname,
        'mdns': mdns,
        'ips': ips,
        'primary_ip': ips[0] if ips else None,
    })
