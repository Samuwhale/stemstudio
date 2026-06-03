from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from backend.adapters.ffmpeg import FfmpegAdapter, FfmpegCommandError
from backend.core.config import RuntimeSettings
from backend.core.stems import (
    EXPORT_STEM_MP3_PREFIX,
    EXPORT_STEM_WAV_PREFIX,
    is_stem_kind,
)
from backend.db.models import Run, RunArtifact, RunStatus


_STATIC_AUDIO_KINDS: frozenset[str] = frozenset(
    {
        "source",
        "normalized",
        "export-mix-wav",
        "export-mix-mp3",
    }
)


def _is_audio_artifact_kind(kind: str) -> bool:
    if kind in _STATIC_AUDIO_KINDS:
        return True
    if is_stem_kind(kind):
        return True
    return kind.startswith(EXPORT_STEM_WAV_PREFIX) or kind.startswith(EXPORT_STEM_MP3_PREFIX)

PEAKS_BUCKET_COUNT = 512


def _file_facts(path: Path) -> dict[str, Any]:
    try:
        size_bytes = path.stat().st_size
    except OSError:
        size_bytes = None
    return {"size_bytes": size_bytes}


def compute_artifact_metrics(ffmpeg: FfmpegAdapter, artifact: RunArtifact) -> dict[str, Any] | None:
    path = Path(artifact.path)
    if not path.exists():
        return None

    metrics: dict[str, Any] = _file_facts(path)

    if not _is_audio_artifact_kind(artifact.kind):
        return metrics

    try:
        metadata = ffmpeg.probe(path)
    except FfmpegCommandError:
        return metrics

    metrics["duration_seconds"] = metadata.duration_seconds
    metrics["sample_rate"] = metadata.sample_rate
    metrics["channels"] = metadata.channels

    try:
        integrated, peak = ffmpeg.measure_loudness(path)
        metrics["integrated_lufs"] = integrated
        metrics["true_peak_dbfs"] = peak
    except FfmpegCommandError:
        metrics["integrated_lufs"] = None
        metrics["true_peak_dbfs"] = None

    try:
        metrics["peaks"] = ffmpeg.extract_peaks(path, buckets=PEAKS_BUCKET_COUNT)
    except FfmpegCommandError:
        metrics["peaks"] = []

    return metrics


def populate_run_metrics(session: Session, runtime_settings: RuntimeSettings, run: Run) -> int:
    ffmpeg = FfmpegAdapter(runtime_settings)
    updated = 0
    for artifact in run.artifacts:
        if artifact.metrics_json is not None:
            continue
        metrics = compute_artifact_metrics(ffmpeg, artifact)
        if metrics is None:
            continue
        artifact.metrics_json = metrics
        updated += 1
    if updated:
        session.commit()
    return updated


def backfill_artifact_metrics(session: Session, runtime_settings: RuntimeSettings) -> int:
    statement = (
        select(Run)
        .options(selectinload(Run.artifacts))
        .where(Run.status == RunStatus.completed.value)
        .order_by(Run.updated_at.desc())
    )
    total = 0
    for run in session.scalars(statement):
        total += populate_run_metrics(session, runtime_settings, run)
    return total
