"""
Storage manager for MixPi recorder
Two-level hierarchy: {storage}/{show}/recording{N}_{timestamp}/
"""

import os
import time
import shutil
import json
import csv
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional
import logging

# Cache: path_str -> (write_mbps, timestamp)
_speed_cache: Dict[str, tuple] = {}
_SPEED_CACHE_TTL = 300  # seconds


class StorageManager:
    """
    Manages recording storage and file organisation.

    Hierarchy
    ---------
    storage_path/
      session1/                        ← show folder (named by user)
        README.txt                     ← show notes (written on first recording)
        recording1_2026-03-29_.../     ← per-recording folder (auto-numbered)
          ch01.wav, ch02.wav ...
          session.json                 ← per-recording metadata
          bounce/
            stereo_mix.wav             ← auto-generated after recording stops
        recording2_.../
          ...
    """

    def __init__(self, config: dict):
        self.config = config
        self.logger = logging.getLogger('mixpi.storage')

        self.storage_path = Path(config['recording']['storage_path'])
        self.file_format = config['recording']['file_format']

        self.storage_path.mkdir(parents=True, exist_ok=True)
        self.logger.info(f"Storage manager initialised: {self.storage_path}")

    # ------------------------------------------------------------------
    # Session creation
    # ------------------------------------------------------------------

    def create_session(self, metadata: Optional[Dict] = None) -> Path:
        """
        Create a new recording folder under the show directory.

        Path: storage / show_name / recording{N}_{timestamp}

        Returns the recording path (not the show path).
        """
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")

        # Show (session) name — default "session1"
        raw_show = (metadata or {}).get('session_name', '') or 'session1'
        show_name = "".join(c for c in raw_show if c.isalnum() or c in ('_', '-')).strip() or 'session1'

        show_path = self.storage_path / show_name
        show_path.mkdir(parents=True, exist_ok=True)

        # Track (song) name — optional, engineer-entered before each recording
        raw_track  = (metadata or {}).get('track_name', '') or ''
        track_name = "".join(
            c for c in raw_track if c.isalnum() or c in ('_', '-', ' ')
        ).strip().replace(' ', '_')

        # Count all existing take dirs regardless of prefix (named or auto)
        existing_takes = [d for d in show_path.iterdir() if d.is_dir()]
        n = len(existing_takes) + 1

        if track_name:
            # Named take: e.g. "Wonderwall_2026-03-30_21-00-00"
            recording_path = show_path / f"{track_name}_{timestamp}"
        else:
            # Auto-numbered fallback: song1, song2, …
            recording_path = show_path / f"song{n}_{timestamp}"

        recording_path.mkdir(parents=True, exist_ok=True)

        # Write README.txt on first recording in this show
        readme = show_path / 'README.txt'
        if not readme.exists():
            notes = (metadata or {}).get('notes', '')
            try:
                readme.write_text(
                    f"Session: {show_name}\nDate: {timestamp}\n\n{notes}\n"
                )
            except Exception:
                pass

        # Per-recording metadata
        if metadata:
            self.save_metadata(recording_path, metadata)

        self.logger.info(f"Created recording: {recording_path}")
        return recording_path

    # ------------------------------------------------------------------
    # Metadata helpers
    # ------------------------------------------------------------------

    def save_metadata(self, session_path: Path, metadata: Dict) -> None:
        metadata_file = session_path / "session.json"
        if 'timestamp' not in metadata:
            metadata['timestamp'] = datetime.now().isoformat()
        try:
            with open(metadata_file, 'w') as f:
                json.dump(metadata, f, indent=2)
        except Exception as e:
            self.logger.error(f"Failed to save metadata: {e}")

    def load_metadata(self, session_path: Path) -> Optional[Dict]:
        metadata_file = session_path / "session.json"
        if not metadata_file.exists():
            return None
        try:
            with open(metadata_file, 'r') as f:
                return json.load(f)
        except Exception as e:
            self.logger.error(f"Failed to load metadata: {e}")
            return None

    def save_markers(self, session_path: Path, markers: List[Dict]) -> None:
        if not markers:
            return
        markers_file = session_path / "markers.csv"
        try:
            with open(markers_file, 'w', newline='') as f:
                writer = csv.writer(f)
                writer.writerow(['Time (s)', 'Frame', 'Label', 'Timestamp'])
                for marker in markers:
                    writer.writerow([
                        f"{marker['time']:.3f}",
                        marker['frame'],
                        marker.get('label', ''),
                        marker.get('timestamp', '')
                    ])
        except Exception as e:
            self.logger.error(f"Failed to save markers: {e}")

    # ------------------------------------------------------------------
    # Session listing (two-level)
    # ------------------------------------------------------------------

    def get_sessions(self, limit: int = 50) -> List[Dict]:
        """
        Return a list of shows, each with their recordings nested inside.

        Response shape:
        [
          {
            "name": "session1",
            "notes": "...",
            "modified": "...",
            "recordings": [ { ... recording info ... }, ... ]
          }
        ]
        """
        shows = []
        try:
            dirs = sorted(
                [d for d in self.storage_path.iterdir() if d.is_dir()],
                key=lambda x: x.stat().st_mtime,
                reverse=True
            )
            for show_dir in dirs[:limit]:
                rec_dirs = sorted(
                    [d for d in show_dir.iterdir()
                     if d.is_dir() and (d / 'session.json').exists()],
                    key=lambda x: x.stat().st_mtime,
                    reverse=True
                )
                recordings = []
                for rec_dir in rec_dirs:
                    info = self.get_recording_info(rec_dir, show_dir.name)
                    if info:
                        recordings.append(info)

                readme = show_dir / 'README.txt'
                notes = ''
                if readme.exists():
                    try:
                        notes = readme.read_text().strip()
                    except Exception:
                        pass

                shows.append({
                    'name':       show_dir.name,
                    'path':       str(show_dir),
                    'notes':      notes,
                    'recordings': recordings,
                    'modified':   datetime.fromtimestamp(
                                    show_dir.stat().st_mtime).isoformat(),
                })
        except Exception as e:
            self.logger.error(f"Failed to get sessions: {e}")
        return shows

    def get_recording_info(self, recording_path: Path,
                           show_name: str) -> Optional[Dict]:
        """Return info dict for a single recording folder."""
        if not recording_path.exists():
            return None
        try:
            metadata = self.load_metadata(recording_path)

            # Channel WAVs are directly in the recording folder (not bounce/)
            all_wavs = list(recording_path.glob(f"*.{self.file_format}"))
            channel_wavs = [f for f in all_wavs if 'stereo_mix' not in f.name]
            audio_files  = channel_wavs if channel_wavs else all_wavs

            total_size = sum(f.stat().st_size for f in audio_files)

            duration_s = None
            if audio_files:
                try:
                    import soundfile as sf
                    info_sf = sf.info(str(audio_files[0]))
                    duration_s = round(info_sf.duration, 1)
                except Exception:
                    pass

            bounce_path = recording_path / 'bounce' / 'stereo_mix.wav'
            bounce_ready = bounce_path.exists() and bounce_path.stat().st_size > 44

            rel_path = f"{show_name}/{recording_path.name}"

            return {
                'name':         recording_path.name,
                'show':         show_name,
                'path':         str(recording_path),
                'rel_path':     rel_path,
                'files':        len(audio_files),
                'size':         total_size,
                'duration_s':   duration_s,
                'bounce_ready': bounce_ready,
                'modified':     datetime.fromtimestamp(
                                  recording_path.stat().st_mtime).isoformat(),
                'metadata':     metadata or {},
            }
        except Exception as e:
            self.logger.error(f"Failed to get recording info: {e}")
            return None

    # kept for any internal callers that still use the old signature
    def get_session_info(self, session_path: Path) -> Optional[Dict]:
        show_name = session_path.parent.name if session_path.parent != self.storage_path else ''
        return self.get_recording_info(session_path, show_name)

    # ------------------------------------------------------------------
    # Deletion
    # ------------------------------------------------------------------

    def delete_session(self, session_path: Path) -> bool:
        """Delete a recording folder or entire show folder."""
        if not session_path.exists():
            self.logger.warning(f"Not found: {session_path}")
            return False
        try:
            shutil.rmtree(session_path)
            self.logger.info(f"Deleted: {session_path}")
            return True
        except Exception as e:
            self.logger.error(f"Failed to delete: {e}")
            return False

    # ------------------------------------------------------------------
    # Disk helpers
    # ------------------------------------------------------------------

    def get_disk_space(self) -> Dict:
        try:
            stat = shutil.disk_usage(self.storage_path)
            return {
                'total':        stat.total,
                'used':         stat.used,
                'free':         stat.free,
                'percent_used': (stat.used / stat.total * 100) if stat.total > 0 else 0
            }
        except Exception as e:
            self.logger.error(f"Failed to get disk space: {e}")
            return {'total': 0, 'used': 0, 'free': 0, 'percent_used': 0}

    def check_disk_space(self, required_gb: float = 1.0) -> bool:
        space = self.get_disk_space()
        available = space['free'] >= required_gb * 1024 ** 3
        if not available:
            self.logger.warning(
                f"Insufficient disk space. Required: {required_gb:.1f} GB, "
                f"Available: {space['free'] / (1024**3):.1f} GB"
            )
        return available

    def set_storage_path(self, new_path: Path) -> None:
        new_path = Path(new_path)
        new_path.mkdir(parents=True, exist_ok=True)
        self.storage_path = new_path
        self.logger.info(f"Storage path switched to: {new_path}")

    def benchmark_write_speed(self, path: Path, size_mb: int = 8) -> float:
        path_str = str(path)
        now = time.monotonic()
        if path_str in _speed_cache:
            mbps, ts = _speed_cache[path_str]
            if now - ts < _SPEED_CACHE_TTL:
                return mbps
        test_file = Path(path) / '.mixpi_speedtest'
        data = bytes(size_mb * 1024 * 1024)
        mbps = 0.0
        try:
            t0 = time.monotonic()
            with open(test_file, 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            elapsed = time.monotonic() - t0
            mbps = round(size_mb / elapsed, 1) if elapsed > 0 else 0.0
        except Exception as e:
            self.logger.warning(f"Speed test failed for {path}: {e}")
        finally:
            try:
                test_file.unlink()
            except Exception:
                pass
        _speed_cache[path_str] = (mbps, time.monotonic())
        return mbps

    def estimate_recording_time(self, sample_rate: int, channels: int,
                                bit_depth: int) -> float:
        space = self.get_disk_space()
        bytes_per_second = sample_rate * channels * (bit_depth // 8)
        return (space['free'] / bytes_per_second) / 3600

    def cleanup_old_sessions(self, keep_count: int = 10) -> int:
        sessions = self.get_sessions(limit=1000)
        if len(sessions) <= keep_count:
            return 0
        deleted = 0
        for session in sessions[keep_count:]:
            if self.delete_session(Path(session['path'])):
                deleted += 1
        return deleted
