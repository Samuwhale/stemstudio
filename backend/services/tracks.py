from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import Select, select
from sqlalchemy.orm import Session, object_session, selectinload

from backend.core.config import RuntimeSettings
from backend.core.stems import is_stem_kind, parse_export_stem_kind, stem_name_from_kind
from backend.db.models import (
    ACTIVE_RUN_STATUSES,
    IN_PROGRESS_RUN_STATUSES,
    TERMINAL_RUN_STATUSES,
    Run,
    RunArtifact,
    RunStatus,
    Track,
)
from backend.db.session import schedule_path_cleanup
from backend.schemas.tracks import (
    MIX_GAIN_DB_MAX,
    MIX_GAIN_DB_MIN,
    ArtifactMetricsResponse,
    RunArtifactResponse,
    RunDetailResponse,
    RunMixInput,
    RunMixState,
    RunMixStemEntry,
    RunSummaryResponse,
    TrackDetailResponse,
    TrackSummaryResponse,
)
from backend.services.processing import (
    ProcessingConfig,
    resolve_run_processing,
    serialize_processing_config,
    update_visible_stems,
)

UNSET = object()


def _slugify(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower())
    return normalized.strip("-") or "track"


def compute_file_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def _artifact_download_url(artifact_id: str) -> str:
    return f"/api/artifacts/{artifact_id}"


def _track_source_download_url(track_id: str) -> str:
    return f"/api/tracks/{track_id}/source"


def track_source_path(track: Track) -> Path:
    return Path(track.source_path)


def track_output_root(track: Track, outputs_dir: Path) -> Path:
    for run in _sorted_runs(track):
        if run.output_directory:
            return Path(run.output_directory).resolve().parent

    source_slug = (track.metadata_json or {}).get("source_slug") or track.id
    return outputs_dir / str(source_slug)


def _source_format(source_filename: str) -> str:
    return Path(source_filename).suffix.lstrip(".").upper() or "FILE"


def _track_source_type(track: Track) -> str:
    metadata = track.metadata_json or {}
    source_type = metadata.get("source_type")
    return str(source_type) if source_type else "file"


def _track_source_url(track: Track) -> str | None:
    metadata = track.metadata_json or {}
    source_url = metadata.get("source_url")
    return str(source_url) if source_url else None


def _track_thumbnail_url(track: Track) -> str | None:
    metadata = track.metadata_json or {}
    thumbnail_url = metadata.get("thumbnail_url")
    return str(thumbnail_url) if thumbnail_url else None


def _build_track_query() -> Select[tuple[Track]]:
    return select(Track).options(selectinload(Track.runs).selectinload(Run.artifacts))


def _sorted_runs(track: Track) -> list[Run]:
    return sorted(track.runs, key=lambda run: run.created_at, reverse=True)


def _serialize_artifact_metrics(metrics: dict[str, Any] | None) -> ArtifactMetricsResponse | None:
    if not metrics:
        return None
    return ArtifactMetricsResponse(
        duration_seconds=metrics.get("duration_seconds"),
        sample_rate=metrics.get("sample_rate"),
        channels=metrics.get("channels"),
        size_bytes=metrics.get("size_bytes"),
        integrated_lufs=metrics.get("integrated_lufs"),
        true_peak_dbfs=metrics.get("true_peak_dbfs"),
        peaks=list(metrics.get("peaks") or []),
    )


def serialize_run_artifact(artifact: RunArtifact) -> RunArtifactResponse:
    return RunArtifactResponse(
        id=artifact.id,
        kind=artifact.kind,
        label=artifact.label,
        format=artifact.format,
        path=artifact.path,
        created_at=artifact.created_at,
        download_url=_artifact_download_url(artifact.id),
        metrics=_serialize_artifact_metrics(artifact.metrics_json),
    )


def _touch_track(track: Track | None) -> None:
    if track is not None:
        track.updated_at = datetime.utcnow()


def _run_is_active(run: Run) -> bool:
    return run.status in ACTIVE_RUN_STATUSES


def _run_visible_in_library(run: Run) -> bool:
    return not (
        run.dismissed_at is not None
        and run.status in {RunStatus.failed.value, RunStatus.cancelled.value}
    )


def serialize_run_summary(run: Run) -> RunSummaryResponse:
    return RunSummaryResponse(
        id=run.id,
        processing=serialize_processing_config(resolve_run_processing(run)),
        status=run.status,
        progress=run.progress,
        status_message=run.status_message,
        error_message=run.error_message,
        output_directory=run.output_directory,
        created_at=run.created_at,
        updated_at=run.updated_at,
        last_active_status=run.last_active_status,
        dismissed_at=run.dismissed_at,
    )


def visible_stem_names(run: Run) -> set[str]:
    return set(resolve_run_processing(run).visible_stems)


def generated_stem_names(run: Run) -> set[str]:
    return set(resolve_run_processing(run).generated_stems)


def _artifact_visible(run: Run, artifact: RunArtifact) -> bool:
    stem_name = stem_name_from_kind(artifact.kind)
    if stem_name is not None:
        return stem_name in visible_stem_names(run)
    parsed_export_stem = parse_export_stem_kind(artifact.kind)
    if parsed_export_stem is not None:
        return parsed_export_stem[1] in visible_stem_names(run)
    return True


def visible_artifacts(run: Run) -> list[RunArtifact]:
    return [artifact for artifact in run.artifacts if _artifact_visible(run, artifact)]


def mixable_artifacts(run: Run) -> list[RunArtifact]:
    visible_stems = visible_stem_names(run)
    return [
        artifact
        for artifact in run.artifacts
        if is_stem_kind(artifact.kind)
        and (stem_name_from_kind(artifact.kind) in visible_stems)
    ]


def mixable_artifact_ids(run: Run) -> set[str]:
    return {artifact.id for artifact in mixable_artifacts(run)}


def _run_has_mixable_stems(run: Run) -> bool:
    return bool(mixable_artifacts(run))


def _run_pipeline_key(run: Run) -> str:
    return resolve_run_processing(run).pipeline_key


def _pipeline_runs(track: Track, pipeline_key: str, *, exclude_run_id: str | None = None) -> list[Run]:
    return [
        run
        for run in track.runs
        if run.id != exclude_run_id and _run_pipeline_key(run) == pipeline_key
    ]


def _pick_terminal_run_to_keep(runs: list[Run], keeper_run_id: str | None) -> Run:
    keeper = next((run for run in runs if run.id == keeper_run_id), None)
    if keeper is not None:
        return keeper

    completed_runs = [run for run in runs if run.status == RunStatus.completed.value]
    if completed_runs:
        return max(completed_runs, key=lambda run: run.updated_at)

    return max(runs, key=lambda run: run.updated_at)


def _is_default_stem(entry: dict[str, Any] | RunMixStemEntry) -> bool:
    gain = getattr(entry, "gain_db", None)
    muted = getattr(entry, "muted", None)
    if gain is None and isinstance(entry, dict):
        gain = entry.get("gain_db")
        muted = entry.get("muted")
    return abs(float(gain or 0.0)) < 0.01 and not bool(muted)


def serialize_run_mix(run: Run) -> RunMixState:
    raw = run.mix_json or {}
    stems_raw = raw.get("stems") if isinstance(raw, dict) else None
    visible_ids = mixable_artifact_ids(run)
    stems: list[RunMixStemEntry] = []
    if isinstance(stems_raw, list):
        for entry in stems_raw:
            if not isinstance(entry, dict):
                continue
            artifact_id = entry.get("artifact_id")
            if not isinstance(artifact_id, str):
                continue
            if artifact_id not in visible_ids:
                continue
            gain = float(entry.get("gain_db") or 0.0)
            gain = max(MIX_GAIN_DB_MIN, min(MIX_GAIN_DB_MAX, gain))
            stems.append(
                RunMixStemEntry(
                    artifact_id=artifact_id,
                    gain_db=gain,
                    muted=bool(entry.get("muted") or False),
                )
            )
    is_default = all(_is_default_stem(entry) for entry in stems)
    return RunMixState(stems=stems, is_default=is_default)


def serialize_run_detail(run: Run) -> RunDetailResponse:
    return RunDetailResponse(
        **serialize_run_summary(run).model_dump(),
        metadata_json=run.metadata_json or {},
        artifacts=[serialize_run_artifact(artifact) for artifact in visible_artifacts(run)],
        mix=serialize_run_mix(run),
    )


def _summary_mix_run(runs: list[Run], keeper_run_id: str | None) -> Run | None:
    if keeper_run_id:
        keeper_run = next(
            (
                run
                for run in runs
                if run.id == keeper_run_id and run.status == RunStatus.completed.value
            ),
            None,
        )
        if keeper_run is not None:
            return keeper_run
    return next((run for run in runs if run.status == RunStatus.completed.value), None)


def _summary_latest_run(runs: list[Run]) -> Run | None:
    return next((run for run in runs if _run_visible_in_library(run)), None)


def _pick_reusable_completed_run(
    track: Track,
    processing: ProcessingConfig,
    *,
    session: Session,
) -> Run | None:
    required_generated_stems = set(processing.generated_stems)
    best_priority: tuple[int, int, int, float] | None = None
    best_run: Run | None = None

    for run in _sorted_runs(track):
        if run in session.deleted or run.status != RunStatus.completed.value:
            continue

        run_processing = resolve_run_processing(run)
        run_generated_stems = generated_stem_names(run)
        if run_processing.quality != processing.quality:
            continue
        if not required_generated_stems.issubset(run_generated_stems):
            continue

        priority = (
            1 if run_processing.visible_stems == processing.visible_stems else 0,
            1 if run_processing.pipeline_key == processing.pipeline_key else 0,
            -len(run_generated_stems - required_generated_stems),
            run.updated_at.timestamp(),
        )
        if best_priority is None or priority > best_priority:
            best_priority = priority
            best_run = run

    return best_run


def set_run_mix(session: Session, track_id: str, run_id: str, payload: RunMixInput) -> Run:
    track = get_track(session, track_id)
    if track is None:
        raise LookupError(f"Track '{track_id}' does not exist.")

    run = session.get(Run, run_id, options=[selectinload(Run.artifacts)])
    if run is None or run.track_id != track.id:
        raise ValueError("Run does not belong to this track.")
    if run.status != RunStatus.completed.value:
        raise ValueError("Only completed runs can have a mix.")

    mixable_ids = mixable_artifact_ids(run)
    seen: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for entry in payload.stems:
        if entry.artifact_id not in mixable_ids:
            raise ValueError(f"Artifact '{entry.artifact_id}' is not a mixable stem for this run.")
        if entry.artifact_id in seen:
            raise ValueError(f"Duplicate mix entry for artifact '{entry.artifact_id}'.")
        seen.add(entry.artifact_id)
        normalized.append(
            {
                "artifact_id": entry.artifact_id,
                "gain_db": float(entry.gain_db),
                "muted": bool(entry.muted),
            }
        )

    missing = mixable_ids - seen
    if missing:
        raise ValueError("Mix must include every stem in the run.")

    run.mix_json = None if all(_is_default_stem(entry) for entry in normalized) else {
        "version": 1,
        "stems": normalized,
    }
    _touch_track(track)
    session.commit()
    session.refresh(run)
    return run


def _collect_source_peaks(runs: list[Run]) -> list[float]:
    for run in runs:
        for artifact in run.artifacts:
            if artifact.kind != "source":
                continue
            metrics = artifact.metrics_json or {}
            peaks = metrics.get("peaks")
            if isinstance(peaks, list) and peaks:
                return [float(value) for value in peaks if isinstance(value, (int, float))]
    return []


def _visible_run_count(runs: list[Run]) -> int:
    return sum(1 for run in runs if _run_visible_in_library(run))


def serialize_track_summary(track: Track) -> TrackSummaryResponse:
    runs = _sorted_runs(track)
    latest_run = _summary_latest_run(runs)
    mix_summary_run = _summary_mix_run(runs, track.keeper_run_id)
    has_custom_mix = (
        mix_summary_run is not None
        and not serialize_run_mix(mix_summary_run).is_default
    )
    return TrackSummaryResponse(
        id=track.id,
        title=track.title,
        artist=track.artist,
        source_type=_track_source_type(track),
        source_url=_track_source_url(track),
        thumbnail_url=_track_thumbnail_url(track),
        source_filename=track.source_filename,
        duration_seconds=track.duration_seconds,
        created_at=track.created_at,
        updated_at=track.updated_at,
        latest_run=serialize_run_summary(latest_run) if latest_run else None,
        run_count=_visible_run_count(runs),
        keeper_run_id=track.keeper_run_id,
        has_custom_mix=has_custom_mix,
        source_peaks=_collect_source_peaks(runs),
    )


def serialize_track_detail(track: Track) -> TrackDetailResponse:
    return TrackDetailResponse(
        id=track.id,
        title=track.title,
        artist=track.artist,
        source_type=_track_source_type(track),
        source_url=_track_source_url(track),
        thumbnail_url=_track_thumbnail_url(track),
        source_filename=track.source_filename,
        source_format=_source_format(track.source_filename),
        source_download_url=_track_source_download_url(track.id),
        duration_seconds=track.duration_seconds,
        metadata_json=track.metadata_json or {},
        created_at=track.created_at,
        updated_at=track.updated_at,
        runs=[serialize_run_detail(run) for run in _sorted_runs(track)],
        keeper_run_id=track.keeper_run_id,
    )


def list_tracks(session: Session) -> list[Track]:
    statement = _build_track_query().order_by(Track.updated_at.desc())
    return list(session.scalars(statement))


def list_track_library(session: Session) -> list[Track]:
    statement = select(Track).order_by(Track.updated_at.desc())
    return list(session.scalars(statement))


def get_track(session: Session, track_id: str) -> Track | None:
    statement = _build_track_query().where(Track.id == track_id)
    return session.scalars(statement).first()


def backfill_content_hashes(session: Session) -> int:
    updated = 0
    for track in session.scalars(select(Track)):
        metadata = dict(track.metadata_json or {})
        if metadata.get("content_hash"):
            continue
        source_path = Path(track.source_path)
        if not source_path.exists():
            continue
        metadata["content_hash"] = compute_file_sha256(source_path)
        track.metadata_json = metadata
        updated += 1
    if updated:
        session.commit()
    return updated


def create_track(
    session: Session,
    *,
    source_path: Path,
    source_filename: str,
    title: str,
    artist: str | None,
    source_metadata: dict[str, Any] | None = None,
) -> Track:
    clean_title = title.strip() or "Untitled Track"
    clean_artist = artist.strip() if artist else None
    metadata = {
        "source_slug": _slugify(clean_title),
        "source_type": "file",
    }
    if source_metadata:
        metadata.update(source_metadata)

    track = Track(
        title=clean_title,
        artist=clean_artist or None,
        source_filename=source_filename,
        source_path=str(source_path.resolve()),
        metadata_json=metadata,
    )
    session.add(track)
    session.flush()
    return track


def create_run(
    track: Track,
    processing: ProcessingConfig,
    *,
    allow_reuse_completed: bool = True,
) -> Run:
    session = object_session(track)
    if session is not None:
        prune_terminal_runs_without_stems(session, track)
        deduplicate_terminal_runs_by_pipeline(session, track)

        if allow_reuse_completed:
            reusable = _pick_reusable_completed_run(track, processing, session=session)
            if reusable is not None:
                update_visible_stems(reusable, processing.visible_stems)
                _touch_track(track)
                return reusable

    active_same_pipeline = next(
        (
            run
            for run in _pipeline_runs(track, processing.pipeline_key)
            if _run_is_active(run)
        ),
        None,
    )
    if active_same_pipeline is not None:
        raise ValueError(f"{processing.label} is already queued or running for this song.")

    _touch_track(track)
    run = Run(
        track_id=track.id,
        pipeline_key=processing.pipeline_key,
        status=RunStatus.queued.value,
        progress=0.0,
        status_message="",
        metadata_json={"processing": processing.to_metadata()},
    )
    run.artifacts.append(
        RunArtifact(
            kind="source",
            label="Imported source",
            format=_source_format(track.source_filename),
            path=track.source_path,
        )
    )
    track.runs.append(run)
    return run


def add_run_artifact(
    run: Run,
    *,
    kind: str,
    label: str,
    format_name: str,
    path: Path,
) -> RunArtifact:
    artifact = RunArtifact(
        kind=kind,
        label=label,
        format=format_name,
        path=str(path.resolve()),
    )
    run.artifacts.append(artifact)
    return artifact


def set_run_state(
    run: Run,
    *,
    status: RunStatus,
    progress: float,
    status_message: str,
    error_message: str | None = None,
) -> Run:
    run.status = status.value
    run.progress = progress
    run.status_message = status_message
    run.error_message = error_message
    if status.value in IN_PROGRESS_RUN_STATUSES:
        run.last_active_status = status.value
    if status.value in TERMINAL_RUN_STATUSES:
        _touch_track(run.track)
    return run


def assign_run_metadata(run: Run, *, output_directory: Path, metadata_json: dict[str, Any]) -> Run:
    run.output_directory = str(output_directory.resolve())
    run.metadata_json = metadata_json
    return run


def claim_next_run(session: Session) -> Run | None:
    statement = (
        select(Run)
        .options(selectinload(Run.track), selectinload(Run.artifacts))
        .where(Run.status == RunStatus.queued.value)
        .order_by(Run.created_at.asc())
    )
    run = session.scalars(statement).first()
    if run is None:
        return None

    set_run_state(
        run,
        status=RunStatus.preparing,
        progress=0.05,
        status_message="",
    )
    session.flush()
    return run


def recover_orphaned_runs(session: Session) -> int:
    statement = select(Run).where(Run.status.in_(list(IN_PROGRESS_RUN_STATUSES)))
    orphaned = list(session.scalars(statement))
    for run in orphaned:
        set_run_state(
            run,
            status=RunStatus.failed,
            progress=run.progress,
            status_message="",
            error_message="Worker restarted before this run could finish.",
        )
    if orphaned:
        session.commit()
    return len(orphaned)


def request_run_cancellation(session: Session, run_id: str) -> Run:
    run = session.get(Run, run_id, options=[selectinload(Run.track), selectinload(Run.artifacts)])
    if run is None:
        raise LookupError(f"Run '{run_id}' does not exist.")

    if run.status == RunStatus.cancelled.value:
        return run
    if run.status in {RunStatus.completed.value, RunStatus.failed.value}:
        raise ValueError(f"Run is already {run.status}; nothing to cancel.")

    if run.status == RunStatus.queued.value:
        set_run_state(
            run,
            status=RunStatus.cancelled,
            progress=run.progress,
            status_message="",
            error_message=None,
        )
    else:
        metadata = dict(run.metadata_json or {})
        metadata["cancellation_requested"] = True
        run.metadata_json = metadata
        run.status_message = "Stopping at next stage"

    session.commit()
    return run


def dismiss_run(session: Session, run_id: str) -> Run:
    run = session.get(Run, run_id, options=[selectinload(Run.track)])
    if run is None:
        raise LookupError(f"Run '{run_id}' does not exist.")
    if run.status not in {RunStatus.failed.value, RunStatus.cancelled.value}:
        raise ValueError("Only failed or cancelled runs can be dismissed from the queue.")

    if run.dismissed_at is None:
        run.dismissed_at = datetime.utcnow()
        _touch_track(run.track)
        session.commit()

    return run


def is_cancellation_requested(run: Run) -> bool:
    metadata = run.metadata_json or {}
    return bool(metadata.get("cancellation_requested"))


def mark_run_cancelled(run: Run) -> None:
    set_run_state(
        run,
        status=RunStatus.cancelled,
        progress=run.progress,
        status_message="",
        error_message=None,
    )
    metadata = dict(run.metadata_json or {})
    metadata.pop("cancellation_requested", None)
    run.metadata_json = metadata


def delete_run(session: Session, run_id: str) -> None:
    run = session.get(Run, run_id, options=[selectinload(Run.track), selectinload(Run.artifacts)])
    if run is None:
        raise LookupError(f"Run '{run_id}' does not exist.")
    if run.status not in TERMINAL_RUN_STATUSES:
        raise ValueError("Only completed, failed, or cancelled runs can be deleted.")
    if run.track and run.track.keeper_run_id == run.id:
        raise ValueError("Clear the preferred stem set before deleting this run.")

    if run.track is not None:
        _touch_track(run.track)

    schedule_path_cleanup(session, *_run_file_paths(run, include_source=False))
    session.delete(run)
    session.commit()


def retry_run(session: Session, run_id: str) -> Run:
    source_run = session.get(Run, run_id, options=[selectinload(Run.track)])
    if source_run is None:
        raise LookupError(f"Run '{run_id}' does not exist.")
    if source_run.status not in {RunStatus.failed.value, RunStatus.cancelled.value}:
        raise ValueError("Only failed or cancelled runs can be retried.")

    # Drop the failed/cancelled source run from the queue view so it doesn't
    # sit next to the retry that replaces it.
    if source_run.dismissed_at is None:
        source_run.dismissed_at = datetime.utcnow()

    track = source_run.track
    processing = resolve_run_processing(source_run)
    new_run = create_run(track, processing, allow_reuse_completed=False)
    session.commit()
    session.refresh(new_run)
    return new_run


def prune_terminal_runs_without_stems(session: Session, track: Track) -> int:
    deleted = 0
    for run in list(track.runs):
        if run.status not in TERMINAL_RUN_STATUSES:
            continue
        if run.id == track.keeper_run_id:
            continue
        if _run_has_mixable_stems(run):
            continue

        schedule_path_cleanup(session, *_run_file_paths(run, include_source=False))
        session.delete(run)
        deleted += 1

    return deleted


def deduplicate_terminal_runs_by_pipeline(session: Session, track: Track) -> int:
    deleted = 0
    pipeline_keys = {_run_pipeline_key(run) for run in track.runs}

    for pipeline_key in pipeline_keys:
        matching_runs = _pipeline_runs(track, pipeline_key)
        if any(_run_is_active(run) for run in matching_runs):
            continue

        terminal_runs = [run for run in matching_runs if run.status in TERMINAL_RUN_STATUSES]
        if len(terminal_runs) < 2:
            continue

        keep_run = _pick_terminal_run_to_keep(terminal_runs, track.keeper_run_id)
        for run in terminal_runs:
            if run.id == keep_run.id:
                continue
            schedule_path_cleanup(session, *_run_file_paths(run, include_source=False))
            session.delete(run)
            deleted += 1

    if deleted:
        _touch_track(track)
    return deleted


def replace_terminal_runs_for_completed_pipeline(session: Session, completed_run: Run) -> int:
    track = session.get(
        Track,
        completed_run.track_id,
        options=[selectinload(Track.runs).selectinload(Run.artifacts)],
    )
    if track is None:
        return 0

    replaced_keeper = False
    deleted = 0
    for run in _pipeline_runs(track, _run_pipeline_key(completed_run), exclude_run_id=completed_run.id):
        if run.status not in TERMINAL_RUN_STATUSES:
            continue
        if track.keeper_run_id == run.id:
            replaced_keeper = True
        schedule_path_cleanup(session, *_run_file_paths(run, include_source=False))
        session.delete(run)
        deleted += 1

    if replaced_keeper:
        track.keeper_run_id = completed_run.id
    if deleted or replaced_keeper:
        _touch_track(track)
    return deleted


def backfill_pipeline_run_deduplication(session: Session) -> int:
    deleted = 0
    for track in list_tracks(session):
        deleted += deduplicate_terminal_runs_by_pipeline(session, track)
    if deleted:
        session.commit()
    return deleted


def set_keeper_run(session: Session, track_id: str, run_id: str | None) -> Track:
    track = get_track(session, track_id)
    if track is None:
        raise LookupError(f"Track '{track_id}' does not exist.")

    if track.keeper_run_id == run_id:
        return track

    if run_id is None:
        track.keeper_run_id = None
        _touch_track(track)
        session.commit()
        session.refresh(track)
        return track

    run = session.get(Run, run_id)
    if run is None or run.track_id != track.id:
        raise ValueError("Run does not belong to this track.")
    if run.status != RunStatus.completed.value:
        raise ValueError("Only completed runs can be marked as the keeper.")

    track.keeper_run_id = run.id
    _touch_track(track)
    session.commit()
    session.refresh(track)
    return track


def update_track(
    session: Session,
    track_id: str,
    *,
    title: str | None,
    artist: str | None | object = UNSET,
) -> Track:
    track = get_track(session, track_id)
    if track is None:
        raise LookupError(f"Track '{track_id}' does not exist.")

    did_change = False

    if title is not None:
        clean_title = title.strip()
        if not clean_title:
            raise ValueError("Title cannot be empty.")
        if clean_title != track.title:
            track.title = clean_title
            did_change = True

    if artist is not UNSET:
        clean_artist = artist.strip() if isinstance(artist, str) else None
        clean_artist = clean_artist or None
        if clean_artist != track.artist:
            track.artist = clean_artist
            did_change = True

    if not did_change:
        return track

    _touch_track(track)
    session.commit()
    session.refresh(track)
    return track


def purge_non_keeper_runs(
    session: Session,
    track_id: str,
    *,
    commit: bool = True,
) -> tuple[int, int]:
    track = get_track(session, track_id)
    if track is None:
        raise LookupError(f"Track '{track_id}' does not exist.")
    if not track.keeper_run_id:
        raise ValueError("Set a keeper run before cleaning up other runs.")

    deleted = 0
    reclaimed = 0
    for run in list(track.runs):
        if run.id == track.keeper_run_id:
            continue
        if run.status not in TERMINAL_RUN_STATUSES:
            continue

        reclaimed += _measure_run_files(run, include_source=False)
        schedule_path_cleanup(session, *_run_file_paths(run, include_source=False))

        session.delete(run)
        deleted += 1

    if deleted:
        _touch_track(track)
        if commit:
            session.commit()
    return deleted, reclaimed


def _prepare_track_delete(
    session: Session,
    track_id: str,
) -> None:
    track = get_track(session, track_id)
    if track is None:
        raise LookupError(f"Track '{track_id}' does not exist.")

    if any(_run_is_active(run) for run in track.runs):
        raise ValueError("Cancel or wait for queued or running stem jobs before deleting this track.")

    for run in list(track.runs):
        schedule_path_cleanup(session, *_run_file_paths(run, include_source=False))

    if track.source_path:
        schedule_path_cleanup(session, Path(track.source_path))
    session.delete(track)


def batch_delete_tracks(session: Session, track_ids: list[str]) -> tuple[int, list[str], list[str]]:
    deleted = 0
    blocked: list[str] = []
    missing: list[str] = []

    for track_id in track_ids:
        try:
            _prepare_track_delete(session, track_id)
            deleted += 1
        except LookupError:
            missing.append(track_id)
        except ValueError:
            blocked.append(track_id)

    if deleted:
        session.commit()

    return deleted, blocked, missing


def _path_size(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        try:
            return path.stat().st_size
        except OSError:
            return 0

    total = 0
    for entry in path.rglob("*"):
        if entry.is_file():
            try:
                total += entry.stat().st_size
            except OSError:
                continue
    return total


def _measure_paths(paths: Iterable[Path]) -> int:
    unique_paths = {path.resolve() for path in paths if path.exists()}
    return sum(_path_size(path) for path in unique_paths)


def _run_file_paths(run: Run, *, include_source: bool) -> set[Path]:
    paths: set[Path] = set()
    output_root = Path(run.output_directory).resolve() if run.output_directory else None
    if output_root is not None:
        paths.add(output_root)
    for artifact in run.artifacts:
        if not include_source and artifact.kind == "source":
            continue
        artifact_path = Path(artifact.path).resolve()
        if output_root is not None and artifact_path == output_root:
            continue
        if output_root is not None and artifact_path.is_relative_to(output_root):
            continue
        paths.add(artifact_path)
    return paths


def _measure_run_files(run: Run, *, include_source: bool) -> int:
    return _measure_paths(_run_file_paths(run, include_source=include_source))


def write_metadata_file(track: Track, run: Run, target_path: Path) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_text(
        json.dumps(
            {
                "track": {
                    "id": track.id,
                    "title": track.title,
                    "artist": track.artist,
                    "source_filename": track.source_filename,
                    "duration_seconds": track.duration_seconds,
                    "metadata": track.metadata_json or {},
                },
                "run": {
                    "id": run.id,
                    "pipeline_key": run.pipeline_key,
                    "status": run.status,
                    "progress": run.progress,
                    "status_message": run.status_message,
                    "metadata": run.metadata_json or {},
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )
