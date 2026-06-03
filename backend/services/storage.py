from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta
from os import PathLike
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from backend.core.config import RuntimeSettings
from backend.core.worker_health import WORKER_HEARTBEAT_FILENAME
from backend.db.models import ACTIVE_RUN_STATUSES, AppSettings, ImportDraft, Track
from backend.schemas.storage import (
    ExportBundleCleanupResponse,
    LibraryResetResponse,
    NonKeeperCleanupResponse,
    StorageBucketKey,
    StorageBucketResponse,
    StorageOverviewResponse,
    TempCleanupResponse,
)
from backend.services.tracks import list_tracks, purge_non_keeper_runs

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PROJECT_DATA_ROOT = PROJECT_ROOT / "data"
MANAGED_MARKER_FILENAME = ".stemstudio-managed"
STORAGE_METADATA_FILENAMES = {
    ".gitkeep",
    MANAGED_MARKER_FILENAME,
    WORKER_HEARTBEAT_FILENAME,
}
MANAGED_STORAGE_LABELS = {
    "uploads_dir": "Uploads directory",
    "outputs_dir": "Outputs directory",
    "exports_dir": "Exports directory",
    "temp_dir": "Temp directory",
    "model_cache_dir": "Processing cache directory",
}


@dataclass(frozen=True)
class StoragePaths:
    database_path: Path
    uploads_dir: Path
    outputs_dir: Path
    exports_dir: Path
    temp_dir: Path
    model_cache_dir: Path

    @property
    def export_bundles_dir(self) -> Path:
        return self.exports_dir / "bundles"

    @property
    def managed_directories(self) -> tuple[Path, ...]:
        return (
            self.uploads_dir,
            self.outputs_dir,
            self.exports_dir,
            self.temp_dir,
            self.model_cache_dir,
        )

    def ensure_directories(self) -> None:
        try:
            self.database_path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise ValueError(f"Database folder is not writable or could not be created: {self.database_path.parent}") from error
        for directory in self.managed_directories:
            ensure_managed_directory(directory)
        try:
            self.export_bundles_dir.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise ValueError(f"Export bundle folder is not writable or could not be created: {self.export_bundles_dir}") from error


def storage_path_from_setting(value: Any, default: Path) -> Path:
    candidate = value if isinstance(value, (str, PathLike)) and str(value).strip() else default
    return Path(candidate).expanduser().resolve()


def configured_storage_paths(runtime_settings: RuntimeSettings, settings: AppSettings) -> StoragePaths:
    uploads_dir = storage_path_from_setting(settings.uploads_directory, runtime_settings.uploads_dir)
    outputs_dir = storage_path_from_setting(settings.outputs_directory, runtime_settings.output_dir)
    exports_dir = storage_path_from_setting(settings.exports_directory, runtime_settings.exports_dir)
    temp_dir = storage_path_from_setting(settings.temp_directory, runtime_settings.temp_dir)
    model_cache_dir = storage_path_from_setting(settings.model_cache_directory, runtime_settings.model_cache_dir)
    return StoragePaths(
        database_path=runtime_settings.database_path.expanduser().resolve(),
        uploads_dir=uploads_dir,
        outputs_dir=outputs_dir,
        exports_dir=exports_dir,
        temp_dir=temp_dir,
        model_cache_dir=model_cache_dir,
    )


def resolve_storage_paths(runtime_settings: RuntimeSettings, settings: AppSettings) -> StoragePaths:
    paths = configured_storage_paths(runtime_settings, settings)
    validate_storage_paths(paths)
    paths.ensure_directories()
    return paths


def _path_contains(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
    except ValueError:
        return False
    return True


def _is_storage_metadata(path: Path) -> bool:
    return path.name in STORAGE_METADATA_FILENAMES


def _is_project_data_directory(path: Path) -> bool:
    return _path_contains(PROJECT_DATA_ROOT.resolve(), path.resolve())


def _directory_has_user_content(path: Path) -> bool:
    if not path.exists():
        return False
    return any(not _is_storage_metadata(child) for child in path.iterdir())


def ensure_managed_directory(path: Path) -> None:
    if path.exists() and not path.is_dir():
        raise ValueError(f"Storage path must be a folder: {path}")

    marker_path = path / MANAGED_MARKER_FILENAME
    try:
        if not path.exists():
            path.mkdir(parents=True)
        elif not marker_path.exists() and _directory_has_user_content(path) and not _is_project_data_directory(path):
            raise ValueError(f"Storage folder must be empty or already managed by StemStudio: {path}")

        marker_path.touch(exist_ok=True)
    except OSError as error:
        raise ValueError(f"Storage folder is not writable or could not be created: {path}") from error


def _validate_storage_directory(label: str, path: Path, paths: StoragePaths) -> None:
    home = Path.home().resolve()
    project_root = PROJECT_ROOT.resolve()
    database_path = paths.database_path.resolve()
    protected_paths = {
        Path(path.anchor).resolve(),
        home,
        project_root,
        database_path,
    }
    protected_paths.update(Path(raw).resolve() for raw in ("/bin", "/etc", "/opt", "/sbin", "/tmp", "/usr", "/var"))
    if path in protected_paths:
        raise ValueError(f"{label} is too broad for automatic cleanup: {path}")
    if any(_path_contains(path, protected) for protected in (home, project_root, database_path)):
        raise ValueError(f"{label} would cover protected files: {path}")


def validate_storage_paths(paths: StoragePaths) -> None:
    managed_paths = {
        "uploads_dir": paths.uploads_dir,
        "outputs_dir": paths.outputs_dir,
        "exports_dir": paths.exports_dir,
        "temp_dir": paths.temp_dir,
        "model_cache_dir": paths.model_cache_dir,
    }
    for field_name, path in managed_paths.items():
        _validate_storage_directory(MANAGED_STORAGE_LABELS[field_name], path, paths)

    items = list(managed_paths.items())
    for index, (field_name, path) in enumerate(items):
        for other_field_name, other_path in items[index + 1:]:
            if path == other_path or _path_contains(path, other_path) or _path_contains(other_path, path):
                label = MANAGED_STORAGE_LABELS[field_name]
                other_label = MANAGED_STORAGE_LABELS[other_field_name]
                raise ValueError(f"{label} and {other_label} must be separate folders.")


def file_size(path: Path) -> int:
    try:
        if path.is_symlink():
            return path.lstat().st_size
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


def directory_size(path: Path) -> int:
    if not path.exists() and not path.is_symlink():
        return 0
    if path.is_symlink() or path.is_file():
        return file_size(path)

    total = 0
    for entry in path.rglob("*"):
        if entry.is_symlink() or entry.is_file():
            total += file_size(entry)
    return total


def entry_count(path: Path) -> int:
    if not path.exists() and not path.is_symlink():
        return 0
    if path.is_symlink() or path.is_file():
        return 1
    return sum(1 for _ in path.rglob("*"))


def _iter_export_download_entries(paths: StoragePaths) -> list[Path]:
    if not paths.exports_dir.is_dir():
        return []

    entries: list[Path] = []
    for child in sorted(paths.exports_dir.iterdir()):
        if _is_storage_metadata(child):
            continue
        if child.is_symlink():
            entries.append(child)
            continue
        if child == paths.export_bundles_dir:
            if child.is_dir():
                entries.extend(
                    sorted(
                        path
                        for path in child.iterdir()
                        if path.is_symlink() or path.is_file() or path.is_dir()
                    )
                )
            continue
        if child.is_file() or child.is_dir():
            entries.append(child)
    return entries


def _delete_path(path: Path) -> tuple[int, int]:
    if not path.exists() and not path.is_symlink():
        return 0, 0
    reclaimed = directory_size(path)
    deleted = entry_count(path)
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)
    return deleted, reclaimed


def _live_output_directories(session: Session) -> set[Path]:
    live: set[Path] = set()
    for track in list_tracks(session):
        for run in track.runs:
            if not run.output_directory:
                continue
            live.add(Path(run.output_directory).resolve())
    return live


def _iter_orphaned_output_entries(
    session: Session,
    paths: StoragePaths,
) -> list[Path]:
    if not paths.outputs_dir.is_dir():
        return []

    live_output_dirs = _live_output_directories(session)
    orphans: list[Path] = []
    for track_dir in sorted(paths.outputs_dir.iterdir()):
        if _is_storage_metadata(track_dir):
            continue
        if track_dir.is_symlink():
            orphans.append(track_dir)
            continue
        if not track_dir.is_dir():
            orphans.append(track_dir)
            continue

        resolved_track_dir = track_dir.resolve()
        live_children = {
            child.resolve()
            for child in track_dir.iterdir()
            if child.resolve() in live_output_dirs
        }
        if not live_children and not any(path.parent == resolved_track_dir for path in live_output_dirs):
            orphans.append(track_dir)
            continue

        for child in sorted(track_dir.iterdir()):
            if child.is_symlink():
                orphans.append(child)
                continue
            if child.resolve() in live_children:
                continue
            orphans.append(child)

    # A parent may have been queued after its children; delete children first.
    unique = {path.resolve(): path for path in orphans}
    return sorted(unique.values(), key=lambda path: len(path.parts), reverse=True)


def orphaned_output_bytes(
    session: Session,
    paths: StoragePaths,
) -> int:
    return sum(directory_size(path) for path in _iter_orphaned_output_entries(session, paths))


def _cleanup_orphaned_output_artifacts(session: Session, paths: StoragePaths) -> tuple[int, int]:
    deleted = 0
    reclaimed = 0

    for path in _iter_orphaned_output_entries(session, paths):
        child_deleted, child_reclaimed = _delete_path(path)
        deleted += child_deleted
        reclaimed += child_reclaimed

    return deleted, reclaimed


def cleanup_orphaned_output_artifacts(
    session: Session,
    runtime_settings: RuntimeSettings,
) -> tuple[int, int]:
    from backend.services.settings import get_or_create_settings

    settings = get_or_create_settings(session, runtime_settings)
    paths = resolve_storage_paths(runtime_settings, settings)
    return _cleanup_orphaned_output_artifacts(session, paths)


def cleanup_temp_storage(paths: StoragePaths, *, older_than: timedelta | None = None) -> TempCleanupResponse:
    deleted = 0
    reclaimed = 0
    cutoff = datetime.utcnow() - older_than if older_than is not None else None
    if not paths.temp_dir.is_dir():
        return TempCleanupResponse(deleted_entry_count=0, bytes_reclaimed=0)

    for child in list(paths.temp_dir.iterdir()):
        if _is_storage_metadata(child):
            continue
        if cutoff is not None:
            try:
                modified_at = datetime.utcfromtimestamp(child.stat().st_mtime)
            except OSError:
                continue
            if modified_at > cutoff:
                continue
        child_deleted, child_reclaimed = _delete_path(child)
        deleted += child_deleted
        reclaimed += child_reclaimed

    return TempCleanupResponse(deleted_entry_count=deleted, bytes_reclaimed=reclaimed)


def cleanup_export_bundles(
    paths: StoragePaths,
    *,
    older_than: timedelta | None = None,
) -> ExportBundleCleanupResponse:
    deleted = 0
    reclaimed = 0
    cutoff = datetime.utcnow() - older_than if older_than is not None else None

    for path in _iter_export_download_entries(paths):
        if cutoff is not None:
            try:
                modified_at = datetime.utcfromtimestamp(path.stat().st_mtime)
            except OSError:
                continue
            if modified_at > cutoff:
                continue
        _, child_reclaimed = _delete_path(path)
        reclaimed += child_reclaimed
        deleted += 1

    return ExportBundleCleanupResponse(deleted_bundle_count=deleted, bytes_reclaimed=reclaimed)


def apply_storage_retention(session: Session, runtime_settings: RuntimeSettings) -> None:
    from backend.services.settings import get_or_create_settings

    settings = get_or_create_settings(session, runtime_settings)
    paths = resolve_storage_paths(runtime_settings, settings)
    cleanup_orphaned_output_artifacts(session, runtime_settings)
    cleanup_temp_storage(paths, older_than=timedelta(hours=settings.temp_max_age_hours or 24))
    cleanup_export_bundles(
        paths,
        older_than=timedelta(days=settings.export_bundle_max_age_days or 7),
    )


def _sum_unique_paths(paths: set[Path]) -> int:
    return sum(directory_size(path) for path in paths)


def _non_keeper_reclaimable_bytes(track: Track) -> int:
    if not track.keeper_run_id:
        return 0
    reclaimable = 0
    seen_paths: set[Path] = set()
    for run in track.runs:
        if run.id == track.keeper_run_id:
            continue
        if run.status not in {"completed", "failed", "cancelled"}:
            continue
        if run.output_directory:
            seen_paths.add(Path(run.output_directory))
        for artifact in run.artifacts:
            if artifact.kind == "source":
                continue
            artifact_path = Path(artifact.path)
            if run.output_directory and artifact_path.is_relative_to(Path(run.output_directory)):
                continue
            seen_paths.add(artifact_path)
    reclaimable += _sum_unique_paths(seen_paths)
    return reclaimable


def collect_storage_overview(
    session: Session,
    runtime_settings: RuntimeSettings,
) -> StorageOverviewResponse:
    from backend.services.settings import get_or_create_settings

    settings = get_or_create_settings(session, runtime_settings)
    paths = resolve_storage_paths(runtime_settings, settings)
    library_tracks = list_tracks(session)

    non_keeper_reclaimable = sum(_non_keeper_reclaimable_bytes(track) for track in library_tracks)
    orphan_outputs_reclaimable = orphaned_output_bytes(session, paths)
    export_download_bytes = directory_size(paths.exports_dir)

    items = [
        StorageBucketResponse(
            key=StorageBucketKey.database,
            label="Database",
            path=str(paths.database_path),
            total_bytes=file_size(paths.database_path),
            reclaimable_bytes=0,
        ),
        StorageBucketResponse(
            key=StorageBucketKey.uploads,
            label="Source uploads",
            path=str(paths.uploads_dir),
            total_bytes=directory_size(paths.uploads_dir),
            reclaimable_bytes=0,
        ),
        StorageBucketResponse(
            key=StorageBucketKey.outputs,
            label="Run outputs",
            path=str(paths.outputs_dir),
            total_bytes=directory_size(paths.outputs_dir),
            reclaimable_bytes=non_keeper_reclaimable + orphan_outputs_reclaimable,
        ),
        StorageBucketResponse(
            key=StorageBucketKey.export_bundles,
            label="Export downloads",
            path=str(paths.exports_dir),
            total_bytes=export_download_bytes,
            reclaimable_bytes=export_download_bytes,
        ),
        StorageBucketResponse(
            key=StorageBucketKey.temp,
            label="Temp workspace",
            path=str(paths.temp_dir),
            total_bytes=directory_size(paths.temp_dir),
            reclaimable_bytes=directory_size(paths.temp_dir),
        ),
        StorageBucketResponse(
            key=StorageBucketKey.model_cache,
            label="Processing cache",
            path=str(paths.model_cache_dir),
            total_bytes=directory_size(paths.model_cache_dir),
            reclaimable_bytes=0,
        ),
    ]
    total_bytes = sum(item.total_bytes for item in items)
    return StorageOverviewResponse(items=items, total_bytes=total_bytes)


def _wipe_directory_contents(directory: Path) -> int:
    if not directory.is_dir():
        return 0
    reclaimed = 0
    for child in list(directory.iterdir()):
        if _is_storage_metadata(child):
            continue
        _, child_reclaimed = _delete_path(child)
        reclaimed += child_reclaimed
    return reclaimed


def reset_library(
    session: Session,
    runtime_settings: RuntimeSettings,
) -> LibraryResetResponse:
    from backend.services.settings import get_or_create_settings

    tracks = list_tracks(session)
    if any(run.status in ACTIVE_RUN_STATUSES for track in tracks for run in track.runs):
        raise ValueError("Wait for active stem creation to finish or cancel it before clearing the library.")

    settings = get_or_create_settings(session, runtime_settings)
    paths = resolve_storage_paths(runtime_settings, settings)

    deleted_track_count = len(tracks)
    reclaimed = 0
    reclaimed += _wipe_directory_contents(paths.uploads_dir)
    reclaimed += _wipe_directory_contents(paths.outputs_dir)
    reclaimed += _wipe_directory_contents(paths.exports_dir)
    reclaimed += _wipe_directory_contents(paths.temp_dir)
    paths.ensure_directories()

    deleted_draft_count = session.query(ImportDraft).delete()
    for track in tracks:
        session.delete(track)
    session.commit()

    return LibraryResetResponse(
        deleted_track_count=deleted_track_count,
        deleted_draft_count=deleted_draft_count,
        bytes_reclaimed=reclaimed,
    )


def cleanup_non_keeper_runs_library(
    session: Session,
    runtime_settings: RuntimeSettings,
) -> NonKeeperCleanupResponse:
    from backend.services.settings import get_or_create_settings

    settings = get_or_create_settings(session, runtime_settings)
    paths = resolve_storage_paths(runtime_settings, settings)

    deleted_run_count = 0
    bytes_reclaimed = 0
    purged_track_count = 0
    skipped_track_count = 0

    for track in list_tracks(session):
        if not track.keeper_run_id or any(run.status in ACTIVE_RUN_STATUSES for run in track.runs):
            skipped_track_count += 1
            continue
        deleted, reclaimed = purge_non_keeper_runs(session, track.id, commit=False)
        if deleted > 0:
            purged_track_count += 1
            deleted_run_count += deleted
            bytes_reclaimed += reclaimed

    if deleted_run_count > 0:
        session.commit()

    try:
        _, orphan_bytes_reclaimed = _cleanup_orphaned_output_artifacts(session, paths)
        bytes_reclaimed += orphan_bytes_reclaimed
    except OSError as error:
        if deleted_run_count == 0:
            raise
        logger.warning("Skipped orphaned output cleanup after non-keeper purge: %s", error)

    return NonKeeperCleanupResponse(
        purged_track_count=purged_track_count,
        skipped_track_count=skipped_track_count,
        deleted_run_count=deleted_run_count,
        bytes_reclaimed=bytes_reclaimed,
    )
