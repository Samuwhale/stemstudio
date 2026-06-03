from __future__ import annotations

import os
import re
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from backend.core.binaries import resolve_binary
from backend.core.config import RuntimeSettings
from backend.core.stems import detect_stem_name


class SeparationError(RuntimeError):
    """Raised when stem separation cannot produce usable output."""


@dataclass(frozen=True)
class SeparationResult:
    stems: dict[str, Path]


# audio-separator drives each pass through a tqdm progress bar that rewrites
# itself via carriage returns — e.g. "\r 42%|████▌     | 42/100 [00:12<00:15]".
# We split the raw byte stream on both \r and \n so we surface intermediate
# ticks while the model is still running.
_PROGRESS_PATTERN = re.compile(r"(\d+(?:\.\d+)?)\s*%\s*\|")
_PROGRESS_REPORT_STEP = 0.01
_STREAM_READ_SIZE = 4096
_STOP_TIMEOUT_SECONDS = 5.0
_STOP_POLL_INTERVAL_SECONDS = 0.05
_DIAGNOSTIC_TIMEOUT_SECONDS = 10
_KILL_SIGNAL = getattr(signal, "SIGKILL", signal.SIGTERM)
_USES_POSIX_PROCESS_GROUPS = hasattr(os, "killpg") and hasattr(os, "setsid")
_ACTIVE_SEPARATOR_PROCESSES: dict[subprocess.Popen[bytes], int] = {}
_STOP_REQUESTED_PIDS: set[int] = set()
_WORKER_SHUTDOWN_REQUESTED = False
_ACTIVE_PROCESS_LOCK = threading.RLock()


class AudioSeparatorAdapter:
    def __init__(self, runtime_settings: RuntimeSettings):
        self.binary = resolve_binary(runtime_settings.separator_binary)

    def run(
        self,
        source_path: Path,
        output_dir: Path,
        model_cache_dir: Path,
        model_filename: str,
        progress_callback: Callable[[float], None] | None = None,
    ) -> SeparationResult:
        output_dir.mkdir(parents=True, exist_ok=True)
        model_cache_dir.mkdir(parents=True, exist_ok=True)
        command = [
            self.binary,
            str(source_path),
            "--model_filename",
            model_filename,
            "--output_dir",
            str(output_dir),
            "--model_file_dir",
            str(model_cache_dir),
            "--output_format",
            "WAV",
        ]
        # Binary mode + stderr merged into stdout so tqdm's \r-rewritten lines
        # arrive byte-for-byte without TextIOWrapper line buffering delaying them.
        if _worker_shutdown_requested():
            raise SeparationError("audio-separator was not started because the worker is shutting down.")

        try:
            popen = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                **_process_group_popen_options(),
            )
        except FileNotFoundError as error:
            raise SeparationError(f"Missing separator binary '{self.binary}' on PATH.") from error
        except OSError as error:
            raise SeparationError(f"Could not run separator binary '{self.binary}': {error}") from error

        stopped_by_worker_shutdown = False
        with popen as process:
            _register_process(process)
            try:
                if _worker_shutdown_requested():
                    _stop_process(process)
                    raise SeparationError("audio-separator was stopped because the worker is shutting down.")
                try:
                    tail = _stream_progress(process, progress_callback)
                except Exception:
                    _stop_process(process)
                    raise
                returncode = process.wait()
                stopped_by_worker_shutdown = _was_stop_requested(process)
            finally:
                _unregister_process(process)
        if returncode != 0:
            if stopped_by_worker_shutdown:
                raise SeparationError("audio-separator was stopped because the worker is shutting down.")
            raise SeparationError(tail.strip() or f"audio-separator exited with code {returncode}.")

        generated_audio = sorted(
            path
            for path in output_dir.iterdir()
            if path.is_file() and path.suffix.lower() in {".wav", ".flac", ".mp3", ".m4a"}
        )
        if not generated_audio:
            raise SeparationError("audio-separator completed without writing any output stems.")

        stems: dict[str, Path] = {}
        fallback_index = 1
        for path in generated_audio:
            name = detect_stem_name(path.name, fallback_index=fallback_index)
            if name.startswith("stem-"):
                fallback_index += 1
            # Distinct files that resolve to the same canonical name (e.g. two
            # "other" outputs) keep both by suffixing the second one.
            if name in stems:
                collision_index = 2
                while f"{name}-{collision_index}" in stems:
                    collision_index += 1
                name = f"{name}-{collision_index}"
            stems[name] = path

        return SeparationResult(stems=stems)

    def env_info(self) -> str | None:
        try:
            completed = subprocess.run(
                [self.binary, "--env_info"],
                capture_output=True,
                text=True,
                check=False,
                timeout=_DIAGNOSTIC_TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        if completed.returncode != 0:
            return None
        return "\n".join(line for line in (completed.stdout, completed.stderr) if line).strip()

    def version(self) -> str | None:
        try:
            completed = subprocess.run(
                [self.binary, "--version"],
                capture_output=True,
                text=True,
                check=False,
                timeout=_DIAGNOSTIC_TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        if completed.returncode != 0:
            return None
        return next((line for line in completed.stdout.splitlines() if line.strip()), None)


def _stream_progress(
    process: subprocess.Popen[bytes],
    progress_callback: Callable[[float], None] | None,
) -> str:
    """Consume merged stdout/stderr, emit progress ticks, return the tail for error messages."""
    stream = process.stdout
    assert stream is not None
    buffer = bytearray()
    tail: list[str] = []
    last_reported = -1.0

    def flush() -> None:
        nonlocal last_reported
        if not buffer:
            return
        chunk = buffer.decode("utf-8", errors="replace").strip()
        buffer.clear()
        if not chunk:
            return
        tail.append(chunk)
        if len(tail) > 40:
            del tail[:-40]
        if progress_callback is None:
            return
        match = _PROGRESS_PATTERN.search(chunk)
        if match is None:
            return
        fraction = max(0.0, min(1.0, float(match.group(1)) / 100.0))
        # Throttle to visible changes so we don't commit once per tqdm tick.
        if fraction - last_reported < _PROGRESS_REPORT_STEP and fraction < 1.0:
            return
        last_reported = fraction
        progress_callback(fraction)

    for chunk in iter(lambda: stream.read(_STREAM_READ_SIZE), b""):
        for byte in chunk:
            if byte in (13, 10):
                flush()
            else:
                buffer.append(byte)
    flush()
    return "\n".join(tail)


def terminate_active_separator_processes(*, force: bool = False) -> None:
    global _WORKER_SHUTDOWN_REQUESTED
    with _ACTIVE_PROCESS_LOCK:
        _WORKER_SHUTDOWN_REQUESTED = True
        active = tuple(_ACTIVE_SEPARATOR_PROCESSES.items())
        _STOP_REQUESTED_PIDS.update(process.pid for process, _process_group_id in active)

    for process, process_group_id in active:
        _stop_process_group(process, process_group_id=process_group_id, force=force)


def _process_group_popen_options() -> dict[str, object]:
    if _USES_POSIX_PROCESS_GROUPS:
        return {"start_new_session": True}
    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    if creationflags:
        return {"creationflags": creationflags}
    return {}


def _register_process(process: subprocess.Popen[bytes]) -> None:
    with _ACTIVE_PROCESS_LOCK:
        _ACTIVE_SEPARATOR_PROCESSES[process] = process.pid


def _unregister_process(process: subprocess.Popen[bytes]) -> None:
    with _ACTIVE_PROCESS_LOCK:
        _ACTIVE_SEPARATOR_PROCESSES.pop(process, None)
        _STOP_REQUESTED_PIDS.discard(process.pid)


def _was_stop_requested(process: subprocess.Popen[bytes]) -> bool:
    with _ACTIVE_PROCESS_LOCK:
        return process.pid in _STOP_REQUESTED_PIDS


def _worker_shutdown_requested() -> bool:
    with _ACTIVE_PROCESS_LOCK:
        return _WORKER_SHUTDOWN_REQUESTED


def _registered_process_group_id(process: subprocess.Popen[bytes]) -> int:
    with _ACTIVE_PROCESS_LOCK:
        return _ACTIVE_SEPARATOR_PROCESSES.get(process, process.pid)


def _stop_process(process: subprocess.Popen[bytes]) -> None:
    _stop_process_group(process, process_group_id=_registered_process_group_id(process))


def _stop_process_group(
    process: subprocess.Popen[bytes],
    *,
    process_group_id: int,
    force: bool = False,
) -> None:
    if not force:
        _send_process_signal(process, process_group_id, signal.SIGTERM)
        if _wait_for_process_exit(process, process_group_id, timeout=_STOP_TIMEOUT_SECONDS):
            return

    _send_process_signal(process, process_group_id, _KILL_SIGNAL)
    _wait_for_process_exit(process, process_group_id, timeout=1.0)


def _send_process_signal(
    process: subprocess.Popen[bytes],
    process_group_id: int,
    signum: int,
) -> None:
    if _USES_POSIX_PROCESS_GROUPS:
        try:
            os.killpg(process_group_id, signum)
            return
        except ProcessLookupError:
            pass
        except OSError:
            pass

    if process.poll() is not None:
        return
    try:
        if signum == _KILL_SIGNAL:
            process.kill()
        else:
            process.terminate()
    except OSError:
        return


def _wait_for_process_exit(
    process: subprocess.Popen[bytes],
    process_group_id: int,
    *,
    timeout: float,
) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        process.poll()
        if _process_group_has_exited(process_group_id, process):
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(_STOP_POLL_INTERVAL_SECONDS, remaining))


def _process_group_has_exited(process_group_id: int, process: subprocess.Popen[bytes]) -> bool:
    if not _USES_POSIX_PROCESS_GROUPS:
        return process.poll() is not None
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return process.poll() is not None
    except PermissionError:
        return False
    return False
