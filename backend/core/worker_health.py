from __future__ import annotations

import os
import time
from pathlib import Path

from backend.core.config import RuntimeSettings


WORKER_HEARTBEAT_FILENAME = "worker.heartbeat"
# Worker polls every ~3s; treat it as offline once we've missed ~10 cycles.
WORKER_HEARTBEAT_TIMEOUT_SECONDS = 30


def _heartbeat_path(settings: RuntimeSettings) -> Path:
    return settings.temp_dir.expanduser() / WORKER_HEARTBEAT_FILENAME


def touch_worker_heartbeat(settings: RuntimeSettings) -> None:
    path = _heartbeat_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(exist_ok=True)
    os.utime(path, None)


def is_worker_alive(settings: RuntimeSettings) -> bool:
    path = _heartbeat_path(settings)
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return False
    return (time.time() - mtime) < WORKER_HEARTBEAT_TIMEOUT_SECONDS
