from __future__ import annotations

import logging
import shutil
from collections.abc import Callable
from pathlib import Path

from sqlalchemy.orm import Session, selectinload

from backend.adapters.ffmpeg import FfmpegAdapter
from backend.adapters.separator import AudioSeparatorAdapter, SeparationError
from backend.core.config import RuntimeSettings
from backend.core.stems import (
    export_stem_kind,
    stem_display_label,
    stem_display_order,
    stem_kind,
)
from backend.db.models import Run, RunStatus
from backend.db.session import rollback_session
from backend.services.metrics import populate_run_metrics
from backend.services.mixing import ensure_worker_mix_wav
from backend.services.processing import resolve_run_processing
from backend.services.settings import get_or_create_settings
from backend.services.storage import apply_storage_retention, resolve_storage_paths
from backend.services.tracks import (
    add_run_artifact,
    assign_run_metadata,
    is_cancellation_requested,
    mark_run_cancelled,
    metadata_dict,
    progress_value,
    replace_terminal_runs_for_completed_pipeline,
    set_run_state,
    write_metadata_file,
)

logger = logging.getLogger(__name__)


class RunCancelled(Exception):
    """Raised internally when a running separation job is cancelled."""


def _merge_step_stems(
    *,
    step_key: str,
    allowed_stems: tuple[str, ...],
    required_stems: tuple[str, ...],
    separated_stems: dict[str, Path],
    raw_stems: dict[str, Path],
) -> None:
    allowed = set(allowed_stems)
    accepted = {
        name: path
        for name, path in separated_stems.items()
        if name in allowed
    }
    missing = [stem for stem in required_stems if stem not in accepted]
    if missing:
        produced = ", ".join(sorted(separated_stems)) or "none"
        expected = ", ".join(missing)
        raise SeparationError(
            f"Model step '{step_key}' did not produce required stem output: {expected}. "
            f"Detected outputs: {produced}."
        )

    for name, path in accepted.items():
        previous = raw_stems.get(name)
        if previous is not None and previous != path:
            previous.unlink(missing_ok=True)
        raw_stems[name] = path


def _stage_progress_updater(
    session: Session,
    run: Run,
    *,
    stage: RunStatus,
    stage_range: tuple[float, float],
    status_message: str,
) -> Callable[[float], None]:
    """Map a 0.0–1.0 sub-task fraction into a global run percentage and commit."""
    start, end = stage_range
    span = max(0.0, end - start)
    last_progress = progress_value(run.progress)

    def callback(fraction: float) -> None:
        nonlocal last_progress
        _check_cancellation(session, run)
        clamped = max(0.0, min(1.0, fraction))
        global_progress = start + span * clamped
        if global_progress <= last_progress:
            return
        set_run_state(
            run,
            status=stage,
            progress=global_progress,
            status_message=status_message,
        )
        session.commit()
        last_progress = global_progress

    return callback


def _check_cancellation(session: Session, run: Run) -> None:
    session.refresh(run, attribute_names=["metadata_json", "status"])
    if is_cancellation_requested(run) or run.status == RunStatus.cancelled.value:
        raise RunCancelled()


def process_run(session: Session, runtime_settings: RuntimeSettings, run: Run) -> None:
    output_directory: Path | None = None

    try:
        session.refresh(run, attribute_names=["track", "artifacts"])
        track = run.track
        ffmpeg_adapter = FfmpegAdapter(runtime_settings)
        separator_adapter = AudioSeparatorAdapter(runtime_settings)
        app_settings = get_or_create_settings(session, runtime_settings)
        storage_paths = resolve_storage_paths(runtime_settings, app_settings)
        processing = resolve_run_processing(run)

        source_path = Path(track.source_path)
        if not source_path.exists():
            set_run_state(
                run,
                status=RunStatus.failed,
                progress=0.0,
                status_message="",
                error_message=f"Source file no longer exists: {source_path}",
            )
            session.commit()
            return

        source_slug = metadata_dict(track.metadata_json).get("source_slug", track.id)
        output_directory = storage_paths.outputs_dir / source_slug / run.id
        work_directory = output_directory / "work"
        raw_stems_directory = work_directory / "raw-stems"
        stems_directory = output_directory / "stems"
        export_directory = output_directory / "export"
        output_directory.mkdir(parents=True, exist_ok=True)

        _check_cancellation(session, run)
        set_run_state(
            run,
            status=RunStatus.preparing,
            progress=0.06,
            status_message="Probing source audio",
        )
        session.commit()
        metadata = ffmpeg_adapter.probe(source_path)

        _check_cancellation(session, run)
        set_run_state(
            run,
            status=RunStatus.preparing,
            progress=0.09,
            status_message="Preparing working WAV",
        )
        session.commit()
        normalized_path = work_directory / "normalized.wav"
        ffmpeg_adapter.normalize(source_path, normalized_path)

        if track.duration_seconds is None:
            track.duration_seconds = metadata.duration_seconds

        assign_run_metadata(
            run,
            output_directory=output_directory,
            metadata_json={
                **metadata_dict(run.metadata_json),
                "sample_rate": metadata.sample_rate,
                "channels": metadata.channels,
                "normalized_source": str(normalized_path.resolve()),
                "processing": processing.to_metadata(),
            },
        )
        add_run_artifact(
            run,
            kind="normalized",
            label="Normalized working WAV",
            format_name="WAV",
            path=normalized_path,
        )
        session.commit()

        _check_cancellation(session, run)
        steps = processing.steps
        raw_stems: dict[str, Path] = {}
        if not steps:
            raise SeparationError("No processing route was selected.")

        separating_start = 0.10
        separating_end = 0.85
        step_span = (separating_end - separating_start) / len(steps)

        for index, step in enumerate(steps):
            step_start = separating_start + (step_span * index)
            step_end = step_start + step_span
            step_number = f" ({index + 1}/{len(steps)})" if len(steps) > 1 else ""
            step_message = f"Creating {processing.label}{step_number}"

            source_for_step = normalized_path
            if step.source_stem is not None:
                source_for_step = raw_stems.get(step.source_stem)
                if source_for_step is None:
                    raise SeparationError(
                        f"Could not create requested stems because {step.source_stem} was not produced."
                    )

            set_run_state(
                run,
                status=RunStatus.separating,
                progress=step_start,
                status_message=step_message,
            )
            session.commit()

            separation = separator_adapter.run(
                source_path=source_for_step,
                output_dir=raw_stems_directory / step.key,
                model_cache_dir=storage_paths.model_cache_dir,
                model_filename=step.model_filename,
                progress_callback=_stage_progress_updater(
                    session,
                    run,
                    stage=RunStatus.separating,
                    stage_range=(step_start, step_end),
                    status_message=step_message,
                ),
            )
            if not separation.stems:
                raise SeparationError("Separation produced no stems.")

            _merge_step_stems(
                step_key=step.key,
                allowed_stems=step.output_stems,
                required_stems=step.required_stems,
                separated_stems=separation.stems,
                raw_stems=raw_stems,
            )

        if not raw_stems:
            raise SeparationError("Separation finished without any usable stems.")

        metadata = dict(metadata_dict(run.metadata_json))
        processing_raw = metadata.get("processing")
        processing_metadata = dict(processing_raw if isinstance(processing_raw, dict) else {})
        processing_metadata["generated_stems"] = sorted(raw_stems.keys(), key=lambda name: (stem_display_order(name), name))
        metadata["processing"] = processing_metadata
        run.metadata_json = metadata

        stems_directory.mkdir(parents=True, exist_ok=True)

        ordered_stem_names = sorted(
            raw_stems.keys(),
            key=lambda name: (stem_display_order(name), name),
        )
        stem_wav_paths: dict[str, Path] = {}
        for name in ordered_stem_names:
            raw_path = raw_stems[name]
            suffix = raw_path.suffix.lower() or ".wav"
            stable_path = stems_directory / f"{name}{suffix}"
            shutil.move(raw_path, stable_path)
            stem_wav_paths[name] = stable_path
            add_run_artifact(
                run,
                kind=stem_kind(name),
                label=stem_display_label(name),
                format_name=suffix.lstrip(".").upper() or "WAV",
                path=stable_path,
            )
        session.commit()

        _check_cancellation(session, run)
        set_run_state(
            run,
            status=RunStatus.exporting,
            progress=0.87,
            status_message="Copying stems",
        )
        session.commit()

        export_directory.mkdir(parents=True, exist_ok=True)
        for name, stem_path in stem_wav_paths.items():
            export_wav = export_directory / f"{name}.wav"
            shutil.copy2(stem_path, export_wav)
            add_run_artifact(
                run,
                kind=export_stem_kind(name, fmt="wav"),
                label=f"{stem_display_label(name)} WAV export",
                format_name="WAV",
                path=export_wav,
            )
        session.commit()

        _check_cancellation(session, run)
        set_run_state(
            run,
            status=RunStatus.exporting,
            progress=0.93,
            status_message="Writing metadata",
        )
        session.commit()

        metadata_path = export_directory / "metadata.json"
        write_metadata_file(track, run, metadata_path)
        add_run_artifact(
            run,
            kind="metadata",
            label="Metadata JSON",
            format_name="JSON",
            path=metadata_path,
        )
        session.commit()

        _check_cancellation(session, run)
        set_run_state(
            run,
            status=RunStatus.exporting,
            progress=0.97,
            status_message="Rendering mixdown",
        )
        session.commit()

        # Keep a bitrate-free whole-run render around for compare/preview
        # without reintroducing render-time MP3 work.
        ensure_worker_mix_wav(session, runtime_settings, run)
        _check_cancellation(session, run)

        set_run_state(
            run,
            status=RunStatus.completed,
            progress=1.0,
            status_message="",
            error_message=None,
        )
        replace_terminal_runs_for_completed_pipeline(session, run)
        session.commit()
        try:
            apply_storage_retention(session, runtime_settings)
        except (OSError, ValueError) as error:
            logger.warning("Skipped storage retention after completed run %s: %s", run.id, error)

        try:
            populate_run_metrics(session, runtime_settings, run)
        except Exception as metrics_error:
            rollback_session(session)
            run = session.get(Run, run.id, options=[selectinload(Run.artifacts)])
            if run is not None:
                metadata = dict(metadata_dict(run.metadata_json))
                metadata["metrics_error"] = f"{metrics_error.__class__.__name__}: {metrics_error}"
                run.metadata_json = metadata
                session.commit()
    except RunCancelled:
        rollback_session(session)
        run = session.get(Run, run.id, options=[selectinload(Run.track), selectinload(Run.artifacts)])
        if run is None:
            return
        if output_directory is not None:
            shutil.rmtree(output_directory, ignore_errors=True)
        run.output_directory = None
        for artifact in list(run.artifacts):
            if artifact.kind != "source":
                run.artifacts.remove(artifact)
        mark_run_cancelled(run)
        session.commit()
    except (OSError, ValueError) as error:
        rollback_session(session)
        run = session.get(Run, run.id, options=[selectinload(Run.track), selectinload(Run.artifacts)])
        if run is None:
            return
        set_run_state(
            run,
            status=RunStatus.failed,
            progress=run.progress,
            status_message="",
            error_message=str(error),
        )
        session.commit()
    except RuntimeError as error:
        rollback_session(session)
        run = session.get(Run, run.id, options=[selectinload(Run.track), selectinload(Run.artifacts)])
        if run is None:
            return
        set_run_state(
            run,
            status=RunStatus.failed,
            progress=run.progress,
            status_message="",
            error_message=str(error),
        )
        session.commit()
    except Exception as error:
        rollback_session(session)
        run = session.get(Run, run.id, options=[selectinload(Run.track), selectinload(Run.artifacts)])
        if run is None:
            return
        set_run_state(
            run,
            status=RunStatus.failed,
            progress=run.progress,
            status_message="",
            error_message=f"Unexpected processing error: {error.__class__.__name__}: {error}",
        )
        session.commit()
