"""Pure helpers for recording folder names (no audio deps)."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

# Matches suffix from StorageManager.create_session timestamp: _2026-04-08_12-00-00
_TAKE_TS_SUFFIX_RE = re.compile(r'_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$')


def recording_take_display_name(path: Optional[Path]) -> str:
    """Human-readable take / song name from the recording directory name."""
    if path is None:
        return ''
    name = path.name
    return _TAKE_TS_SUFFIX_RE.sub('', name) or name
