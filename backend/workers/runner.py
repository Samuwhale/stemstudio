from __future__ import annotations

import signal
import threading
import time

from backend.adapters.separator import terminate_active_separator_processes
from backend.core.config import RuntimeSettings, get_runtime_settings
from backend.core.worker_health import touch_worker_heartbeat
from backend.db.session import SessionLocal, init_database
from backend.services.tracks import (
    backfill_pipeline_run_deduplication,
    claim_next_run,
    recover_orphaned_runs,
)
from backend.workers.processor import process_run


shutdown_requested = False
HEARTBEAT_INTERVAL_SECONDS = 5


def _touch_worker_heartbeat_or_log(runtime_settings: RuntimeSettings, last_error: str | None) -> str | None:
    try:
        touch_worker_heartbeat(runtime_settings)
    except OSError as error:
        message = str(error)
        if message != last_error:
            print(f"[worker] could not update heartbeat: {message}", flush=True)
        return message
    return None


def _handle_shutdown(_signum: int, _frame: object) -> None:
    global shutdown_requested
    if shutdown_requested:
        terminate_active_separator_processes(force=True)
        return
    shutdown_requested = True
    terminate_active_separator_processes()
    print("[worker] shutdown requested, stopping active processing", flush=True)


def _start_heartbeat_thread(runtime_settings: RuntimeSettings) -> None:
    # Heartbeat runs on its own thread so it keeps ticking while a separation
    # job is occupying the main loop for minutes at a time.
    def _loop() -> None:
        last_heartbeat_error: str | None = None
        while not shutdown_requested:
            last_heartbeat_error = _touch_worker_heartbeat_or_log(runtime_settings, last_heartbeat_error)
            time.sleep(HEARTBEAT_INTERVAL_SECONDS)

    thread = threading.Thread(target=_loop, name="worker-heartbeat", daemon=True)
    thread.start()


def main() -> None:
    runtime_settings = get_runtime_settings()
    runtime_settings.ensure_directories()
    init_database()

    signal.signal(signal.SIGINT, _handle_shutdown)
    signal.signal(signal.SIGTERM, _handle_shutdown)

    _touch_worker_heartbeat_or_log(runtime_settings, None)
    _start_heartbeat_thread(runtime_settings)

    with SessionLocal() as session:
        recovered = recover_orphaned_runs(session)
        deduplicated = backfill_pipeline_run_deduplication(session)
        if recovered:
            print(f"[worker] recovered {recovered} orphaned run(s) from previous session", flush=True)
        if deduplicated:
            print(f"[worker] removed {deduplicated} redundant output run(s)", flush=True)

    while not shutdown_requested:
        processed_run = False
        with SessionLocal() as session:
            run = claim_next_run(session)
            if run is not None:
                session.commit()
                process_run(session, runtime_settings, run)
                processed_run = True
        if shutdown_requested:
            break
        if processed_run:
            continue
        time.sleep(runtime_settings.worker_poll_interval_seconds)


if __name__ == "__main__":
    main()
