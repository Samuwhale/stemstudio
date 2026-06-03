from __future__ import annotations

import logging
import re
import shutil
import zipfile
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from sqlalchemy.orm import Session

from backend.adapters.ffmpeg import FfmpegAdapter, FfmpegCommandError
from backend.core.config import RuntimeSettings
from backend.core.stems import (
    parse_export_stem_kind,
    stem_display_label,
    stem_display_order,
    stem_name_from_kind,
)
from backend.db.models import Run, RunStatus, Track
from backend.schemas.exports import (
    ExportBundleRequest,
    ExportBundleResponse,
    ExportBundleSkip,
    ExportDeliveryKind,
    ExportPackagingMode,
    ExportPlanArtifact,
    ExportPlanRequest,
    ExportPlanResponse,
    ExportPlanTrack,
    ExportStemOption,
    ExportStemsRequest,
    ExportStemsResponse,
)
from backend.services.mixing import (
    MIX_MP3_KIND,
    MIX_WAV_KIND,
    ensure_mix_render,
    ensure_stem_mp3,
)
from backend.services.settings import get_or_create_settings
from backend.services.storage import apply_storage_retention, resolve_storage_paths
from backend.services.tracks import get_track, metadata_dict, mixable_artifacts
from backend.services.processing import resolve_run_processing


_STATIC_RUN_ARTIFACT_KIND = {
    "mix-wav": MIX_WAV_KIND,
    "mix-mp3": MIX_MP3_KIND,
    "metadata": "metadata",
}

_MIX_KINDS = frozenset({"mix-wav", "mix-mp3"})
_INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')
_TAGGABLE_AUDIO_SUFFIXES = frozenset({
    ".flac",
    ".m4a",
    ".mp3",
    ".mp4",
    ".ogg",
    ".opus",
    ".wav",
    ".webm",
})
logger = logging.getLogger(__name__)


def _mix_format(kind: str) -> str:
    return "wav" if kind == "mix-wav" else "mp3"


@dataclass(frozen=True)
class _ResolvedFile:
    filename: str
    path: Path
    metadata: dict[str, str | None] | None = None


@dataclass(frozen=True)
class _TrackExportEntry:
    track_label: str
    files: list[_ResolvedFile]


@dataclass(frozen=True)
class _PlannedExport:
    delivery: ExportDeliveryKind
    filename: str


def _clean_filename_component(value: str, *, fallback: str) -> str:
    cleaned = _INVALID_FILENAME_CHARS.sub(" ", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip().strip(".")
    return cleaned or fallback


def _bundle_root(exports_dir: Path) -> Path:
    return exports_dir / "bundles"


def export_job_path(session: Session, runtime_settings: RuntimeSettings, job_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise ValueError("Invalid export job id.")
    settings = get_or_create_settings(session, runtime_settings)
    storage_paths = resolve_storage_paths(runtime_settings, settings)
    job_dir = _bundle_root(storage_paths.exports_dir) / job_id
    if not job_dir.is_dir():
        return job_dir
    files = sorted(path for path in job_dir.iterdir() if path.is_file())
    if len(files) != 1:
        raise ValueError("Export download is incomplete.")
    return files[0]


def _select_run(track: Track, override_run_id: str | None) -> Run | None:
    if override_run_id:
        for run in track.runs:
            if run.id == override_run_id and run.status == RunStatus.completed.value:
                return run
        return None
    if track.keeper_run_id:
        keeper_run = next(
            (
                run
                for run in track.runs
                if run.id == track.keeper_run_id and run.status == RunStatus.completed.value
            ),
            None,
        )
        if keeper_run is not None:
            return keeper_run
    completed = [run for run in track.runs if run.status == RunStatus.completed.value]
    if not completed:
        return None
    return sorted(completed, key=lambda run: run.updated_at, reverse=True)[0]


@dataclass(frozen=True)
class _ResolvedArtifact:
    kind: str
    file: _ResolvedFile | None
    filename: str | None
    present: bool
    size_bytes: int | None
    missing_reason: str | None


def _track_title(track: Track) -> str:
    title = track.title.strip() or Path(track.source_filename).stem.strip() or "Untitled Track"
    return title


def _track_artist(track: Track) -> str | None:
    artist = (track.artist or "").strip()
    return artist or None


def _track_export_label(track: Track) -> str:
    return _track_title(track)


def _artifact_export_label(kind: str, *, stem_name: str | None = None) -> str:
    if kind == "source":
        return "Source"
    if kind in _MIX_KINDS:
        return "Mix"
    if kind == "metadata":
        return "Metadata"
    if stem_name is not None:
        return stem_display_label(stem_name)
    return "Export"


def _track_metadata_value(track: Track, key: str) -> str | None:
    metadata = metadata_dict(track.metadata_json)
    value = metadata.get(key)
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _audio_export_metadata(
    track: Track,
    kind: str,
    *,
    stem_name: str | None = None,
    output_label: str | None = None,
) -> dict[str, str | None] | None:
    if kind == "metadata":
        return None

    artist = _track_artist(track)
    artifact_label = _artifact_export_label(kind, stem_name=stem_name)
    title = _track_title(track)
    if kind != "source":
        title = f"{title} - {artifact_label}"

    comments = [artifact_label]
    if output_label and kind != "source":
        comments.append(output_label)
    source_url = _track_metadata_value(track, "source_url")
    if source_url:
        comments.append(source_url)

    return {
        "title": title,
        "artist": artist,
        "album_artist": artist,
        "comment": " | ".join(comments),
    }


def _output_export_label(run: Run | None) -> str | None:
    if run is None:
        return None
    return resolve_run_processing(run).label


def _run_visible_stems(run: Run) -> set[str]:
    return set(resolve_run_processing(run).visible_stems)


def _artifact_export_filename(
    track: Track,
    kind: str,
    suffix: str,
    *,
    stem_name: str | None = None,
    output_label: str | None = None,
) -> str:
    track_label = _clean_filename_component(_track_export_label(track), fallback="Track")
    artifact_label = _clean_filename_component(
        _artifact_export_label(kind, stem_name=stem_name),
        fallback="Export",
    )
    output_suffix = ""
    if kind != "source" and output_label:
        output_suffix = f" ({_clean_filename_component(output_label, fallback='Output')})"
    return f"{track_label} - {artifact_label}{output_suffix}{suffix}"


def _resolve_artifact(
    track: Track,
    run: Run | None,
    kind: str,
    *,
    mix_errors: dict[str, str] | None = None,
    stem_mp3_errors: dict[str, str] | None = None,
) -> _ResolvedArtifact:
    if kind == "source":
        source_path = Path(track.source_path)
        if not source_path.is_file():
            return _ResolvedArtifact(kind, None, None, False, None, "source file is not on disk")
        filename = _artifact_export_filename(track, kind, source_path.suffix)
        return _ResolvedArtifact(
            kind,
            _ResolvedFile(
                filename=filename,
                path=source_path,
                metadata=_audio_export_metadata(track, kind),
            ),
            filename,
            True,
            source_path.stat().st_size,
            None,
        )

    if run is None:
        return _ResolvedArtifact(kind, None, None, False, None, "no preferred or completed output yet")

    output_label = _output_export_label(run)

    if kind in _MIX_KINDS:
        return _resolve_mix_artifact(
            track,
            run,
            kind,
            output_label=output_label,
            render_error=(mix_errors or {}).get(kind),
        )

    stem_parsed = parse_export_stem_kind(kind)
    if stem_parsed is not None:
        fmt, stem_name = stem_parsed
        return _resolve_stem_artifact(
            track,
            run,
            kind,
            stem_name=stem_name,
            fmt=fmt,
            output_label=output_label,
            encode_error=(stem_mp3_errors or {}).get(stem_name) if fmt == "mp3" else None,
        )

    artifact_kind = _STATIC_RUN_ARTIFACT_KIND.get(kind)
    if artifact_kind is None:
        return _ResolvedArtifact(kind, None, None, False, None, f"unknown artifact kind: {kind}")

    artifact = next((a for a in run.artifacts if a.kind == artifact_kind), None)
    if artifact is None:
        return _ResolvedArtifact(kind, None, None, False, None, "not produced by this run")

    artifact_path = Path(artifact.path)
    if not artifact_path.is_file():
        return _ResolvedArtifact(kind, None, None, False, None, "file missing on disk")

    filename = _artifact_export_filename(track, kind, artifact_path.suffix, output_label=output_label)
    return _ResolvedArtifact(
        kind,
        _ResolvedFile(
            filename=filename,
            path=artifact_path,
            metadata=_audio_export_metadata(track, kind, output_label=output_label),
        ),
        filename,
        True,
        artifact_path.stat().st_size,
        None,
    )


def _resolve_stem_artifact(
    track: Track,
    run: Run,
    kind: str,
    *,
    stem_name: str,
    fmt: str,
    output_label: str | None = None,
    encode_error: str | None = None,
) -> _ResolvedArtifact:
    from backend.core.stems import export_stem_kind

    if fmt == "wav":
        if stem_name not in _run_visible_stems(run):
            return _ResolvedArtifact(kind, None, None, False, None, "stem is not selected for this output")
        target_kind = export_stem_kind(stem_name, fmt="wav")
        artifact = next((a for a in run.artifacts if a.kind == target_kind), None)
        if artifact is None:
            return _ResolvedArtifact(kind, None, None, False, None, f"run has no {stem_name} stem")
        artifact_path = Path(artifact.path)
        if not artifact_path.is_file():
            return _ResolvedArtifact(kind, None, None, False, None, "file missing on disk")
        filename = _artifact_export_filename(
            track,
            kind,
            artifact_path.suffix,
            stem_name=stem_name,
            output_label=output_label,
        )
        return _ResolvedArtifact(
            kind,
            _ResolvedFile(
                filename=filename,
                path=artifact_path,
                metadata=_audio_export_metadata(
                    track,
                    kind,
                    stem_name=stem_name,
                    output_label=output_label,
                ),
            ),
            filename,
            True,
            artifact_path.stat().st_size,
            None,
        )

    wav_kind = export_stem_kind(stem_name, fmt="wav")
    if stem_name not in _run_visible_stems(run):
        return _ResolvedArtifact(kind, None, None, False, None, "stem is not selected for this output")
    wav_artifact = next((a for a in run.artifacts if a.kind == wav_kind), None)
    if wav_artifact is None:
        return _ResolvedArtifact(kind, None, None, False, None, f"run has no {stem_name} stem")
    if not Path(wav_artifact.path).is_file():
        return _ResolvedArtifact(kind, None, None, False, None, "stem wav missing on disk")

    if encode_error:
        return _ResolvedArtifact(kind, None, None, False, None, f"mp3 encode failed: {encode_error}")

    mp3_kind = export_stem_kind(stem_name, fmt="mp3")
    mp3_artifact = next((a for a in run.artifacts if a.kind == mp3_kind), None)
    mp3_path = Path(mp3_artifact.path) if mp3_artifact is not None else None
    if mp3_path is not None and mp3_path.is_file():
        filename = _artifact_export_filename(
            track,
            kind,
            mp3_path.suffix,
            stem_name=stem_name,
            output_label=output_label,
        )
        return _ResolvedArtifact(
            kind,
            _ResolvedFile(
                filename=filename,
                path=mp3_path,
                metadata=_audio_export_metadata(
                    track,
                    kind,
                    stem_name=stem_name,
                    output_label=output_label,
                ),
            ),
            filename,
            True,
            mp3_path.stat().st_size,
            None,
        )

    return _ResolvedArtifact(
        kind,
        None,
        _artifact_export_filename(track, kind, ".mp3", stem_name=stem_name, output_label=output_label),
        True,
        None,
        None,
    )


def _resolve_mix_artifact(
    track: Track,
    run: Run,
    kind: str,
    *,
    output_label: str | None = None,
    render_error: str | None = None,
) -> _ResolvedArtifact:
    if not mixable_artifacts(run):
        return _ResolvedArtifact(kind, None, None, False, None, "no stems to mix")

    if render_error:
        return _ResolvedArtifact(kind, None, None, False, None, f"mix render failed: {render_error}")

    artifact_kind = _STATIC_RUN_ARTIFACT_KIND[kind]
    existing = next((a for a in run.artifacts if a.kind == artifact_kind), None)
    existing_path = Path(existing.path) if existing is not None else None
    file_ready = existing_path is not None and existing_path.is_file()

    if not file_ready:
        return _ResolvedArtifact(
            kind,
            None,
            _artifact_export_filename(
                track,
                kind,
                ".wav" if kind == "mix-wav" else ".mp3",
                output_label=output_label,
            ),
            True,
            None,
            None,
        )

    assert existing_path is not None
    filename = _artifact_export_filename(track, kind, existing_path.suffix, output_label=output_label)
    return _ResolvedArtifact(
        kind,
        _ResolvedFile(
            filename=filename,
            path=existing_path,
            metadata=_audio_export_metadata(track, kind, output_label=output_label),
        ),
        filename,
        True,
        existing_path.stat().st_size,
        None,
    )


def _render_requested_mixes(
    session: Session,
    runtime_settings: RuntimeSettings,
    run: Run,
    requested: list[str],
    bitrate: str,
) -> dict[str, str]:
    errors: dict[str, str] = {}
    for kind in requested:
        if kind not in _MIX_KINDS:
            continue
        try:
            fmt = _mix_format(kind)
            ensure_mix_render(
                session,
                runtime_settings,
                run,
                fmt,
                bitrate=bitrate if fmt == "mp3" else None,
            )
        except Exception as error:  # noqa: BLE001
            errors[kind] = str(error) or error.__class__.__name__
    return errors


def _encode_requested_stem_mp3s(
    session: Session,
    runtime_settings: RuntimeSettings,
    run: Run,
    requested: list[str],
    bitrate: str,
) -> dict[str, str]:
    errors: dict[str, str] = {}
    for kind in requested:
        parsed = parse_export_stem_kind(kind)
        if parsed is None or parsed[0] != "mp3":
            continue
        stem_name = parsed[1]
        try:
            ensure_stem_mp3(session, runtime_settings, run, stem_name, bitrate)
        except Exception as error:  # noqa: BLE001
            errors[stem_name] = str(error) or error.__class__.__name__
    return errors


def _resolve_track_files(
    resolved_artifacts: list[_ResolvedArtifact],
) -> tuple[list[_ResolvedFile], list[str]]:
    files: list[_ResolvedFile] = []
    missing: list[str] = []
    for resolved in resolved_artifacts:
        if resolved.file is not None:
            files.append(resolved.file)
        else:
            missing.append(resolved.missing_reason or "unavailable")
    return files, missing


def _resolve_requested_artifacts(
    track: Track,
    run: Run | None,
    requested: list[str],
    *,
    mix_errors: dict[str, str] | None = None,
    stem_mp3_errors: dict[str, str] | None = None,
) -> list[_ResolvedArtifact]:
    return [
        _resolve_artifact(
            track,
            run,
            kind,
            mix_errors=mix_errors,
            stem_mp3_errors=stem_mp3_errors,
        )
        for kind in requested
    ]


def _artifact_collection_label(requested: list[str]) -> str:
    if len(requested) != 1:
        return "Exports"
    kind = requested[0]
    if kind == "source":
        return "Source Files"
    if kind in _MIX_KINDS:
        return "Mixes"
    if kind == "metadata":
        return "Metadata"
    parsed = parse_export_stem_kind(kind)
    if parsed is not None:
        return stem_display_label(parsed[1])
    return "Exports"


def _plan_delivery(
    entries: list[_TrackExportEntry],
    *,
    requested: list[str],
    packaging: ExportPackagingMode,
) -> _PlannedExport:
    if len(entries) == 1 and len(entries[0].files) == 1:
        return _PlannedExport(
            delivery=ExportDeliveryKind.direct_file,
            filename=entries[0].files[0].filename,
        )

    if len(entries) == 1:
        base = _clean_filename_component(entries[0].track_label, fallback="Export")
        return _PlannedExport(
            delivery=ExportDeliveryKind.flat_zip,
            filename=f"{base} - export.zip",
        )

    if packaging == ExportPackagingMode.per_song_folders:
        delivery = ExportDeliveryKind.folder_zip
    elif packaging == ExportPackagingMode.flat:
        delivery = ExportDeliveryKind.flat_zip
    else:
        delivery = (
            ExportDeliveryKind.flat_zip
            if all(len(entry.files) == 1 for entry in entries)
            else ExportDeliveryKind.folder_zip
        )

    collection = _clean_filename_component(
        f"{_artifact_collection_label(requested)} - {len(entries)} songs",
        fallback="Exports",
    )
    return _PlannedExport(delivery=delivery, filename=f"{collection}.zip")


def _prepare_job_output(bundle_root: Path, job_id: str, filename: str) -> Path:
    job_dir = bundle_root / job_id
    job_dir.mkdir(parents=True, exist_ok=False)
    return job_dir / filename


def _discard_job_output(output_path: Path) -> None:
    shutil.rmtree(output_path.parent, ignore_errors=True)


def _ensure_unique_filename(name: str, seen: set[str]) -> str:
    if name not in seen:
        seen.add(name)
        return name
    path = Path(name)
    stem = path.stem
    suffix = path.suffix
    index = 2
    while True:
        candidate = f"{stem} ({index}){suffix}"
        if candidate not in seen:
            seen.add(candidate)
            return candidate
        index += 1


def _ensure_unique_label(label: str, seen: set[str]) -> str:
    if label not in seen:
        seen.add(label)
        return label
    index = 2
    while True:
        candidate = f"{label} ({index})"
        if candidate not in seen:
            seen.add(candidate)
            return candidate
        index += 1


def _should_write_audio_metadata(resolved: _ResolvedFile) -> bool:
    if resolved.metadata is None:
        return False
    suffix = Path(resolved.filename).suffix.lower() or resolved.path.suffix.lower()
    return suffix in _TAGGABLE_AUDIO_SUFFIXES


def _write_export_file(output_path: Path, resolved: _ResolvedFile, ffmpeg: FfmpegAdapter) -> None:
    if _should_write_audio_metadata(resolved):
        try:
            ffmpeg.copy_with_metadata(resolved.path, output_path, resolved.metadata or {})
            return
        except FfmpegCommandError:
            output_path.unlink(missing_ok=True)
            # Metadata is optional; a playable export is more important than
            # failing the whole download because a container rejected tags.
            shutil.copy2(resolved.path, output_path)
        return
    shutil.copy2(resolved.path, output_path)


def _write_direct_file(output_path: Path, resolved: _ResolvedFile, ffmpeg: FfmpegAdapter) -> None:
    _write_export_file(output_path, resolved, ffmpeg)


def _staged_export_path(staging_dir: Path, resolved: _ResolvedFile) -> Path:
    suffix = Path(resolved.filename).suffix or resolved.path.suffix
    return staging_dir / f"{uuid4().hex}{suffix}"


def _zip_resolved_file(
    zf: zipfile.ZipFile,
    resolved: _ResolvedFile,
    *,
    arcname: str,
    staging_dir: Path,
    ffmpeg: FfmpegAdapter,
) -> None:
    if not _should_write_audio_metadata(resolved):
        zf.write(resolved.path, arcname=arcname)
        return

    staging_dir.mkdir(parents=True, exist_ok=True)
    staged_path = _staged_export_path(staging_dir, resolved)
    _write_export_file(staged_path, resolved, ffmpeg)
    zf.write(staged_path, arcname=arcname)


def _write_flat_zip(output_path: Path, entries: list[_TrackExportEntry], ffmpeg: FfmpegAdapter) -> None:
    staging_dir = output_path.parent / "staging"
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
        try:
            seen: set[str] = set()
            for entry in entries:
                for resolved in entry.files:
                    _zip_resolved_file(
                        zf,
                        resolved,
                        arcname=_ensure_unique_filename(resolved.filename, seen),
                        staging_dir=staging_dir,
                        ffmpeg=ffmpeg,
                    )
        finally:
            shutil.rmtree(staging_dir, ignore_errors=True)


def _write_folder_zip(output_path: Path, entries: list[_TrackExportEntry], ffmpeg: FfmpegAdapter) -> None:
    staging_dir = output_path.parent / "staging"
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
        try:
            seen_folders: set[str] = set()
            for entry in entries:
                folder_name = _ensure_unique_label(
                    _clean_filename_component(entry.track_label, fallback="Track"),
                    seen_folders,
                )
                seen_files: set[str] = set()
                for resolved in entry.files:
                    filename = _ensure_unique_filename(resolved.filename, seen_files)
                    _zip_resolved_file(
                        zf,
                        resolved,
                        arcname=f"{folder_name}/{filename}",
                        staging_dir=staging_dir,
                        ffmpeg=ffmpeg,
                    )
        finally:
            shutil.rmtree(staging_dir, ignore_errors=True)


def build_export_bundle(
    session: Session,
    runtime_settings: RuntimeSettings,
    payload: ExportBundleRequest,
) -> ExportBundleResponse:
    settings = get_or_create_settings(session, runtime_settings)
    storage_paths = resolve_storage_paths(runtime_settings, settings)
    bundle_root = _bundle_root(storage_paths.exports_dir)
    bundle_root.mkdir(parents=True, exist_ok=True)

    job_id = uuid4().hex
    skipped: list[ExportBundleSkip] = []
    entries: list[_TrackExportEntry] = []

    for track_id in payload.track_ids:
        track = get_track(session, track_id)
        if track is None:
            skipped.append(
                ExportBundleSkip(
                    track_id=track_id,
                    track_title="(missing)",
                    reason="track no longer exists",
                )
            )
            continue

        run = _select_run(track, payload.run_ids.get(track_id))
        if run is None:
            mix_errors = {}
            stem_mp3_errors = {}
        else:
            mix_errors = _render_requested_mixes(session, runtime_settings, run, payload.artifacts, payload.bitrate)
            stem_mp3_errors = _encode_requested_stem_mp3s(
                session,
                runtime_settings,
                run,
                payload.artifacts,
                payload.bitrate,
            )

        resolved_artifacts = _resolve_requested_artifacts(
            track,
            run,
            payload.artifacts,
            mix_errors=mix_errors,
            stem_mp3_errors=stem_mp3_errors,
        )
        files, missing = _resolve_track_files(resolved_artifacts)
        if missing and not files:
            skipped.append(
                ExportBundleSkip(
                    track_id=track_id,
                    track_title=track.title,
                    reason="; ".join(missing),
                )
            )
            continue

        entries.append(
            _TrackExportEntry(
                track_label=_track_export_label(track),
                files=files,
            )
        )

    if not entries:
        raise ValueError("No tracks produced exportable files with the chosen settings.")

    planned = _plan_delivery(entries, requested=payload.artifacts, packaging=payload.packaging)
    output_path = _prepare_job_output(bundle_root, job_id, planned.filename)
    ffmpeg = FfmpegAdapter(runtime_settings)
    try:
        if planned.delivery == ExportDeliveryKind.direct_file:
            _write_direct_file(output_path, entries[0].files[0], ffmpeg)
        elif planned.delivery == ExportDeliveryKind.flat_zip:
            _write_flat_zip(output_path, entries, ffmpeg)
        else:
            _write_folder_zip(output_path, entries, ffmpeg)
    except Exception:
        _discard_job_output(output_path)
        raise
    try:
        apply_storage_retention(session, runtime_settings)
    except (OSError, ValueError) as error:
        logger.warning("Skipped storage retention after export: %s", error)

    return ExportBundleResponse(
        job_id=job_id,
        download_url=f"/api/exports/bundle/{job_id}",
        filename=planned.filename,
        delivery=planned.delivery,
        byte_count=output_path.stat().st_size,
        included_track_count=len(entries),
        skipped=skipped,
    )


def plan_export_bundle(
    session: Session,
    payload: ExportPlanRequest,
) -> ExportPlanResponse:
    tracks: list[ExportPlanTrack] = []
    total_bytes = 0
    included = 0
    skipped = 0
    included_entries: list[_TrackExportEntry] = []

    for track_id in payload.track_ids:
        track = get_track(session, track_id)
        if track is None:
            tracks.append(
                ExportPlanTrack(
                    track_id=track_id,
                    track_title="(deleted)",
                    run_id=None,
                    output_label=None,
                    artifacts=[],
                    skip_reason="track no longer exists",
                )
            )
            skipped += 1
            continue

        run = _select_run(track, payload.run_ids.get(track_id))
        resolved_artifacts: list[ExportPlanArtifact] = []
        present_files: list[_ResolvedFile] = []
        present_count = 0
        track_bytes = 0
        for resolved in _resolve_requested_artifacts(track, run, payload.artifacts):
            resolved_artifacts.append(
                ExportPlanArtifact(
                    kind=resolved.kind,
                    present=resolved.present,
                    size_bytes=resolved.size_bytes,
                    missing_reason=resolved.missing_reason,
                )
            )
            if resolved.present:
                present_count += 1
                if resolved.size_bytes is not None:
                    track_bytes += resolved.size_bytes
                if resolved.filename is not None:
                    present_files.append(_ResolvedFile(filename=resolved.filename, path=Path()))

        if present_count > 0:
            included += 1
            total_bytes += track_bytes
            skip_reason = None
            included_entries.append(
                _TrackExportEntry(
                    track_label=_track_export_label(track),
                    files=present_files,
                )
            )
        else:
            skipped += 1
            missing_reasons = {
                artifact.missing_reason
                for artifact in resolved_artifacts
                if artifact.missing_reason
            }
            skip_reason = (
                next(iter(missing_reasons))
                if len(missing_reasons) == 1
                else "no requested artifacts are available"
            )

        tracks.append(
            ExportPlanTrack(
                track_id=track_id,
                track_title=track.title,
                run_id=run.id if run is not None else None,
                output_label=_output_export_label(run),
                artifacts=resolved_artifacts,
                skip_reason=skip_reason,
            )
        )

    planned = (
        _plan_delivery(included_entries, requested=payload.artifacts, packaging=payload.packaging)
        if included_entries
        else None
    )

    return ExportPlanResponse(
        tracks=tracks,
        delivery=planned.delivery if planned is not None else None,
        filename=planned.filename if planned is not None else None,
        included_track_count=included,
        total_bytes=total_bytes,
        skipped_track_count=skipped,
    )


def list_export_stems(
    session: Session,
    payload: ExportStemsRequest,
) -> ExportStemsResponse:
    counts: dict[str, int] = {}
    for track_id in payload.track_ids:
        track = get_track(session, track_id)
        if track is None:
            continue
        run = _select_run(track, payload.run_ids.get(track_id))
        if run is None:
            continue
        seen_in_run: set[str] = set()
        for artifact in run.artifacts:
            stem_name = stem_name_from_kind(artifact.kind)
            if stem_name is None or stem_name in seen_in_run:
                continue
            if stem_name not in _run_visible_stems(run):
                continue
            seen_in_run.add(stem_name)
            counts[stem_name] = counts.get(stem_name, 0) + 1

    ordered = sorted(counts.items(), key=lambda pair: (stem_display_order(pair[0]), pair[0]))
    return ExportStemsResponse(
        stems=[
            ExportStemOption(
                name=name,
                label=stem_display_label(name),
                track_count=count,
            )
            for name, count in ordered
        ]
    )
