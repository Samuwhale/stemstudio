from __future__ import annotations

import re
import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.adapters.youtube import YtDlpAdapter
from backend.core.config import RuntimeSettings
from backend.core.constants import SUPPORTED_IMPORT_EXTENSIONS
from backend.core.imports import DraftDuplicateAction, DraftSourceType, DraftStatus
from backend.db.models import (
    ImportDraft,
    RunStatus,
    Track,
)
from backend.schemas.imports import (
    ConfirmImportDraftsRequest,
    ConfirmImportDraftsResponse,
    ExistingTrackDuplicateResponse,
    ImportDraftResponse,
    ResolveLocalImportResponse,
    ResolveYouTubeImportResponse,
    UpdateImportDraftRequest,
)
from backend.services.processing import (
    ProcessingConfig,
    build_processing_from_request,
    serialize_processing_config,
    serialize_quality_options,
    serialize_stem_options,
)
from backend.services.settings import get_or_create_settings
from backend.services.storage import resolve_storage_paths
from backend.services.tracks import (
    compute_file_sha256,
    create_run,
    create_track,
    list_track_library,
    serialize_track_summary,
)


_SESSION_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
_PENDING_ID_PATTERN = re.compile(r"^[0-9a-f]{32}\.[0-9a-z]{1,8}$")
_UNSET = object()


@dataclass(frozen=True)
class DuplicateLookup:
    by_video_id: dict[str, list[Track]]
    by_source_url: dict[str, list[Track]]
    by_content_hash: dict[str, list[Track]]


@dataclass
class ConfirmSideEffects:
    rollback_actions: list[Callable[[], None]] = field(default_factory=list)
    post_commit_actions: list[Callable[[], None]] = field(default_factory=list)


@dataclass
class DraftCommitResult:
    track: Track
    rollback_actions: list[Callable[[], None]] = field(default_factory=list)
    post_commit_actions: list[Callable[[], None]] = field(default_factory=list)


def _unique_tracks(tracks: list[Track]) -> list[Track]:
    seen_ids: set[str] = set()
    unique: list[Track] = []
    for track in tracks:
        if track.id in seen_ids:
            continue
        seen_ids.add(track.id)
        unique.append(track)
    return unique


# ---------------------------------------------------------------------------
# Resolve endpoints: create drafts
# ---------------------------------------------------------------------------


def resolve_youtube_import(
    session: Session,
    runtime_settings: RuntimeSettings,
    source_url: str,
) -> ResolveYouTubeImportResponse:
    application_settings = get_or_create_settings(session, runtime_settings)
    processing = build_processing_from_request(None, application_settings)
    adapter = YtDlpAdapter(runtime_settings)
    resolved = adapter.resolve(source_url)
    duplicates = _build_duplicate_lookup(list_track_library(session))

    drafts: list[ImportDraft] = []
    for item in resolved.items:
        matches = _find_duplicates_by_source(duplicates, item.video_id, item.canonical_source_url)
        draft = ImportDraft(
            source_type=DraftSourceType.youtube.value,
            status=DraftStatus.pending.value,
            video_id=item.video_id,
            source_url=item.source_url,
            canonical_source_url=item.canonical_source_url,
            playlist_source_url=resolved.source_url,
            thumbnail_url=item.thumbnail_url,
            duration_seconds=item.duration_seconds,
            suggested_title=item.title or "Untitled Track",
            suggested_artist=item.artist,
            title=item.title or "Untitled Track",
            artist=item.artist,
            duplicate_action=_default_duplicate_action(matches),
            existing_track_id=matches[0].id if len(matches) == 1 else None,
            duplicate_track_ids=[track.id for track in matches],
            resolution_metadata_json={
                "source_kind": resolved.source_kind,
                "playlist_title": resolved.title,
            },
        )
        session.add(draft)
        drafts.append(draft)

    session.commit()
    for draft in drafts:
        session.refresh(draft)

    return ResolveYouTubeImportResponse(
        source_kind=resolved.source_kind,
        source_title=resolved.title,
        drafts=[serialize_draft(session, draft) for draft in drafts],
        stem_options=serialize_stem_options(),
        quality_options=serialize_quality_options(),
        default_processing=serialize_processing_config(processing),
    )


def resolve_local_import(
    runtime_settings: RuntimeSettings,
    session: Session,
    files: list[tuple[str, BinaryIO]],
) -> ResolveLocalImportResponse:
    if not files:
        raise ValueError("Select at least one file to import.")

    application_settings = get_or_create_settings(session, runtime_settings)
    storage_paths = resolve_storage_paths(runtime_settings, application_settings)
    processing = build_processing_from_request(None, application_settings)
    duplicates = _build_duplicate_lookup(list_track_library(session))

    session_id = uuid4().hex
    pending_dir = _session_dir(storage_paths.uploads_dir, session_id)
    pending_dir.mkdir(parents=True, exist_ok=True)

    drafts: list[ImportDraft] = []
    seen_content_hashes: dict[str, str] = {}
    try:
        for original_name, file_handle in files:
            extension = Path(original_name).suffix.lower()
            if extension not in SUPPORTED_IMPORT_EXTENSIONS:
                raise ValueError(
                    f"Unsupported file type '{extension or 'unknown'}' for '{original_name}'."
                )

            pending_id = f"{uuid4().hex}{extension}"
            pending_path = pending_dir / pending_id
            with pending_path.open("wb") as output_file:
                shutil.copyfileobj(file_handle, output_file)

            content_hash = compute_file_sha256(pending_path)
            first_name = seen_content_hashes.get(content_hash)
            if first_name is not None:
                raise ValueError(
                    f"'{original_name}' is the same audio file as '{first_name}'. "
                    "Remove duplicate files and try again."
                )
            seen_content_hashes[content_hash] = original_name
            matches = _find_duplicates_by_hash(duplicates, content_hash)
            title = _title_from_filename(original_name)

            draft = ImportDraft(
                source_type=DraftSourceType.local.value,
                status=DraftStatus.pending.value,
                session_id=session_id,
                pending_id=pending_id,
                original_filename=original_name,
                content_hash=content_hash,
                size_bytes=pending_path.stat().st_size,
                suggested_title=title,
                suggested_artist=None,
                title=title,
                artist=None,
                duplicate_action=_default_duplicate_action(matches),
                existing_track_id=matches[0].id if len(matches) == 1 else None,
                duplicate_track_ids=[track.id for track in matches],
                resolution_metadata_json={
                    "staged_uploads_directory": str(storage_paths.uploads_dir),
                },
            )
            session.add(draft)
            drafts.append(draft)
    except Exception:
        shutil.rmtree(pending_dir, ignore_errors=True)
        session.rollback()
        raise

    session.commit()
    for draft in drafts:
        session.refresh(draft)

    return ResolveLocalImportResponse(
        drafts=[serialize_draft(session, draft) for draft in drafts],
        stem_options=serialize_stem_options(),
        quality_options=serialize_quality_options(),
        default_processing=serialize_processing_config(processing),
    )


# ---------------------------------------------------------------------------
# Draft CRUD
# ---------------------------------------------------------------------------


def list_import_drafts(session: Session) -> list[ImportDraftResponse]:
    statement = (
        select(ImportDraft)
        .where(ImportDraft.status == DraftStatus.pending.value)
        .order_by(ImportDraft.created_at.asc())
    )
    drafts = list(session.scalars(statement))
    return [serialize_draft(session, draft) for draft in drafts]


def update_import_draft(
    session: Session,
    draft_id: str,
    payload: UpdateImportDraftRequest,
) -> ImportDraftResponse:
    draft = _get_pending_draft(session, draft_id)
    fields = payload.model_fields_set
    _apply_draft_patch(
        draft,
        title=payload.title if "title" in fields else _UNSET,
        artist=payload.artist if "artist" in fields else _UNSET,
        duplicate_action=payload.duplicate_action if "duplicate_action" in fields else _UNSET,
        existing_track_id=payload.existing_track_id if "existing_track_id" in fields else _UNSET,
    )
    session.commit()
    session.refresh(draft)
    return serialize_draft(session, draft)


def discard_import_draft(
    session: Session,
    runtime_settings: RuntimeSettings,
    draft_id: str,
) -> None:
    draft = _get_pending_draft(session, draft_id)
    _discard_draft(session, runtime_settings, draft)
    session.commit()


# ---------------------------------------------------------------------------
# Confirm
# ---------------------------------------------------------------------------


def confirm_import_drafts(
    session: Session,
    runtime_settings: RuntimeSettings,
    payload: ConfirmImportDraftsRequest,
) -> ConfirmImportDraftsResponse:
    drafts = _load_pending_drafts(session, payload.draft_ids)
    _validate_ready_for_confirm(drafts)

    queued_processing: ProcessingConfig | None = None
    if payload.processing is not None and not payload.queue:
        raise ValueError("Processing can only be set when queueing imports.")
    if payload.queue:
        application_settings = get_or_create_settings(session, runtime_settings)
        queued_processing = build_processing_from_request(payload.processing, application_settings)

    adapter = YtDlpAdapter(runtime_settings)

    affected_tracks: list[Track] = []
    created = 0
    reused = 0
    skipped = 0
    queued = 0
    side_effects = ConfirmSideEffects()

    try:
        for draft in drafts:
            action = draft.duplicate_action

            if action == DraftDuplicateAction.skip.value:
                _schedule_pending_file_cleanup(
                    side_effects,
                    session,
                    runtime_settings,
                    draft,
                )
                draft.status = DraftStatus.discarded.value
                skipped += 1
                continue

            if action == DraftDuplicateAction.reuse_existing.value:
                track = _resolve_reuse_target(session, draft)
                _schedule_pending_file_cleanup(
                    side_effects,
                    session,
                    runtime_settings,
                    draft,
                )
                reused += 1
            else:
                commit_result = _commit_draft_as_new_track(
                    session,
                    runtime_settings,
                    adapter,
                    draft,
                )
                track = commit_result.track
                side_effects.rollback_actions.extend(commit_result.rollback_actions)
                side_effects.post_commit_actions.extend(commit_result.post_commit_actions)
                created += 1

            if queued_processing is not None:
                run = create_run(track, queued_processing)
                if run.status == RunStatus.queued.value:
                    queued += 1

            draft.status = DraftStatus.confirmed.value
            affected_tracks.append(track)

        session.commit()
    except Exception:
        session.rollback()
        _run_cleanup_actions(side_effects.rollback_actions)
        raise

    _run_cleanup_actions(side_effects.post_commit_actions)

    affected_tracks = _unique_tracks(affected_tracks)

    for track in affected_tracks:
        session.refresh(track)

    return ConfirmImportDraftsResponse(
        tracks=[serialize_track_summary(track) for track in affected_tracks],
        created_track_count=created,
        reused_track_count=reused,
        skipped_draft_count=skipped,
        queued_run_count=queued,
    )


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _default_duplicate_action(matches: list[Track]) -> str | None:
    if not matches:
        return DraftDuplicateAction.create_new.value
    return None


def _apply_draft_patch(
    draft: ImportDraft,
    *,
    title: str | None | object,
    artist: str | None | object,
    duplicate_action: DraftDuplicateAction | None | object,
    existing_track_id: str | None | object,
) -> None:
    if title is not _UNSET:
        if title is None:
            raise ValueError("Title cannot be empty.")
        cleaned = title.strip()
        if not cleaned:
            raise ValueError("Title cannot be empty.")
        draft.title = cleaned
    if artist is not _UNSET:
        cleaned_artist = artist.strip() if artist is not None else ""
        draft.artist = cleaned_artist or None
    if duplicate_action is not _UNSET:
        if duplicate_action is None:
            draft.duplicate_action = None
            draft.existing_track_id = None
        else:
            if duplicate_action in (DraftDuplicateAction.reuse_existing, DraftDuplicateAction.skip):
                if not draft.duplicate_track_ids:
                    raise ValueError(
                        f"Draft '{draft.title}' has no duplicate matches; "
                        f"'{duplicate_action.value}' is not allowed."
                    )
            draft.duplicate_action = duplicate_action.value
            if (
                duplicate_action == DraftDuplicateAction.reuse_existing
                and len(draft.duplicate_track_ids or []) == 1
            ):
                draft.existing_track_id = draft.duplicate_track_ids[0]
            elif duplicate_action != DraftDuplicateAction.reuse_existing:
                draft.existing_track_id = None
    if existing_track_id is not _UNSET:
        if existing_track_id is None:
            draft.existing_track_id = None
            return
        if draft.duplicate_action != DraftDuplicateAction.reuse_existing.value:
            raise ValueError("Choose 'Use an existing song' before selecting a duplicate.")
        if existing_track_id not in (draft.duplicate_track_ids or []):
            raise ValueError("Chosen track is not among the detected duplicates.")
        draft.existing_track_id = existing_track_id


def _validate_ready_for_confirm(drafts: list[ImportDraft]) -> None:
    unresolved = [draft for draft in drafts if draft.duplicate_action is None]
    if unresolved:
        titles = ", ".join(f"'{draft.title}'" for draft in unresolved[:3])
        more = "" if len(unresolved) <= 3 else f" and {len(unresolved) - 3} more"
        raise ConfirmValidationError(
            f"Resolve duplicate handling for {titles}{more} before confirming."
        )
    for draft in drafts:
        if draft.duplicate_action == DraftDuplicateAction.reuse_existing.value:
            if not draft.existing_track_id:
                raise ConfirmValidationError(
                    f"Choose an existing track to reuse for '{draft.title}'."
                )


class ConfirmValidationError(ValueError):
    """Raised when the set of drafts is not ready to be confirmed."""


def _resolve_reuse_target(session: Session, draft: ImportDraft) -> Track:
    if not draft.existing_track_id:
        raise ValueError(f"Choose an existing track to reuse for '{draft.title}'.")
    track = session.get(Track, draft.existing_track_id)
    if track is None:
        raise ValueError(f"Existing track '{draft.existing_track_id}' no longer exists.")
    if track.id not in (draft.duplicate_track_ids or []):
        raise ValueError(
            f"Track '{track.title}' is not among the duplicates recorded for '{draft.title}'."
        )
    return track


def _commit_draft_as_new_track(
    session: Session,
    runtime_settings: RuntimeSettings,
    adapter: YtDlpAdapter,
    draft: ImportDraft,
) -> DraftCommitResult:
    if draft.source_type == DraftSourceType.youtube.value:
        downloaded = adapter.download(
            source_url=draft.source_url or "",
            destination_dir=resolve_storage_paths(
                runtime_settings,
                get_or_create_settings(session, runtime_settings),
            ).uploads_dir,
            filename_prefix=uuid4().hex,
        )
        rollback = lambda path=downloaded.source_path: path.unlink(missing_ok=True)
        try:
            track = create_track(
                session,
                source_path=downloaded.source_path,
                source_filename=downloaded.source_filename,
                title=draft.title,
                artist=draft.artist,
                source_metadata={
                    "source_type": "youtube",
                    "source_url": draft.canonical_source_url or "",
                    "video_id": draft.video_id or "",
                    "thumbnail_url": draft.thumbnail_url or "",
                    "source_playlist_url": draft.playlist_source_url or "",
                },
            )
        except Exception:
            rollback()
            raise
        return DraftCommitResult(
            track=track,
            rollback_actions=[rollback],
        )

    if draft.source_type == DraftSourceType.local.value:
        pending_path = _pending_path_for_draft(session, runtime_settings, draft)
        if not pending_path.is_file():
            raise ValueError(
                f"Staged file for '{draft.title}' is missing. Re-add the source."
            )
        settings = get_or_create_settings(session, runtime_settings)
        destination = resolve_storage_paths(runtime_settings, settings).uploads_dir / pending_path.name
        if destination.exists():
            raise ValueError(
                f"Prepared destination already exists for '{draft.title}'. Re-add the source."
            )
        shutil.move(str(pending_path), destination)
        rollback = lambda source=destination, target=pending_path: _restore_pending_file(source, target)
        try:
            track = create_track(
                session,
                source_path=destination,
                source_filename=draft.original_filename or pending_path.name,
                title=draft.title,
                artist=draft.artist,
                source_metadata={
                    "source_type": "file",
                    "content_hash": draft.content_hash or "",
                },
            )
        except Exception:
            rollback()
            raise
        return DraftCommitResult(
            track=track,
            rollback_actions=[rollback],
            post_commit_actions=[lambda path=pending_path: _cleanup_pending_path(path)],
        )

    raise ValueError(f"Unknown source type '{draft.source_type}'.")


def _discard_draft(
    session: Session,
    runtime_settings: RuntimeSettings,
    draft: ImportDraft,
) -> None:
    _cleanup_pending_file(session, runtime_settings, draft)
    draft.status = DraftStatus.discarded.value


def _cleanup_pending_file(
    session: Session,
    runtime_settings: RuntimeSettings,
    draft: ImportDraft,
) -> None:
    if draft.source_type != DraftSourceType.local.value:
        return
    try:
        pending_path = _pending_path_for_draft(session, runtime_settings, draft)
    except ValueError:
        return
    _cleanup_pending_path(pending_path)


def _cleanup_pending_path(pending_path: Path) -> None:
    pending_path.unlink(missing_ok=True)
    session_dir = pending_path.parent
    if session_dir.is_dir() and not any(session_dir.iterdir()):
        session_dir.rmdir()


def _restore_pending_file(source_path: Path, target_path: Path) -> None:
    if not source_path.exists():
        return
    target_path.parent.mkdir(parents=True, exist_ok=True)
    if target_path.exists():
        target_path.unlink()
    shutil.move(str(source_path), target_path)


def _schedule_pending_file_cleanup(
    side_effects: ConfirmSideEffects,
    session: Session,
    runtime_settings: RuntimeSettings,
    draft: ImportDraft,
) -> None:
    if draft.source_type != DraftSourceType.local.value:
        return
    try:
        pending_path = _pending_path_for_draft(session, runtime_settings, draft)
    except ValueError:
        return
    side_effects.post_commit_actions.append(
        lambda path=pending_path: _cleanup_pending_path(path)
    )


def _run_cleanup_actions(actions: list[Callable[[], None]]) -> None:
    for action in reversed(actions):
        try:
            action()
        except Exception:
            continue


def _pending_path_for_draft(
    session: Session,
    runtime_settings: RuntimeSettings,
    draft: ImportDraft,
) -> Path:
    if not draft.session_id or not draft.pending_id:
        raise ValueError("Draft has no staged file reference.")
    for uploads_dir in _candidate_upload_dirs(session, runtime_settings, draft):
        pending_dir = _session_dir(uploads_dir, draft.session_id)
        pending_path = _pending_file(pending_dir, draft.pending_id)
        if pending_path.exists():
            return pending_path
    settings = get_or_create_settings(session, runtime_settings)
    pending_dir = _session_dir(resolve_storage_paths(runtime_settings, settings).uploads_dir, draft.session_id)
    return _pending_file(pending_dir, draft.pending_id)


def _candidate_upload_dirs(
    session: Session,
    runtime_settings: RuntimeSettings,
    draft: ImportDraft,
) -> list[Path]:
    metadata = draft.resolution_metadata_json or {}
    candidates: list[Path] = []
    staged_directory = metadata.get("staged_uploads_directory")
    if isinstance(staged_directory, str) and staged_directory.strip():
        candidates.append(Path(staged_directory).expanduser().resolve())

    settings = get_or_create_settings(session, runtime_settings)
    candidates.append(resolve_storage_paths(runtime_settings, settings).uploads_dir)
    candidates.append(runtime_settings.uploads_dir.expanduser().resolve())

    unique: list[Path] = []
    seen: set[Path] = set()
    for path in candidates:
        if path in seen:
            continue
        unique.append(path)
        seen.add(path)
    return unique


def _session_dir(uploads_dir: Path, session_id: str) -> Path:
    if not _SESSION_ID_PATTERN.match(session_id):
        raise ValueError("Invalid import session.")
    return uploads_dir / "pending" / session_id


def _pending_file(pending_dir: Path, pending_id: str) -> Path:
    if not _PENDING_ID_PATTERN.match(pending_id):
        raise ValueError(f"Invalid staged file reference '{pending_id}'.")
    return pending_dir / pending_id


def _title_from_filename(filename: str) -> str:
    stem = Path(filename).stem.replace("_", " ").strip()
    return stem or "Untitled Track"


def _get_pending_draft(session: Session, draft_id: str) -> ImportDraft:
    draft = session.get(ImportDraft, draft_id)
    if draft is None:
        raise LookupError(f"Import draft '{draft_id}' does not exist.")
    if draft.status != DraftStatus.pending.value:
        raise ValueError(f"Import draft '{draft_id}' is no longer pending.")
    return draft


def _load_pending_drafts(session: Session, draft_ids: list[str]) -> list[ImportDraft]:
    if not draft_ids:
        return []
    statement = select(ImportDraft).where(ImportDraft.id.in_(draft_ids))
    loaded = {draft.id: draft for draft in session.scalars(statement)}

    missing = [draft_id for draft_id in draft_ids if draft_id not in loaded]
    if missing:
        raise LookupError(f"Import drafts not found: {', '.join(missing)}")

    not_pending = [
        draft.id for draft in loaded.values() if draft.status != DraftStatus.pending.value
    ]
    if not_pending:
        raise ValueError(f"Some drafts are no longer pending: {', '.join(not_pending)}")

    return [loaded[draft_id] for draft_id in draft_ids]


def serialize_draft(session: Session, draft: ImportDraft) -> ImportDraftResponse:
    duplicate_tracks: list[ExistingTrackDuplicateResponse] = []
    for track_id in draft.duplicate_track_ids or []:
        track = session.get(Track, track_id)
        if track is None:
            continue
        duplicate_tracks.append(
            ExistingTrackDuplicateResponse(
                id=track.id,
                title=track.title,
                artist=track.artist,
                source_filename=track.source_filename,
            )
        )

    return ImportDraftResponse(
        id=draft.id,
        source_type=draft.source_type,
        status=draft.status,
        created_at=draft.created_at,
        updated_at=draft.updated_at,
        title=draft.title,
        artist=draft.artist,
        suggested_title=draft.suggested_title,
        suggested_artist=draft.suggested_artist,
        video_id=draft.video_id,
        source_url=draft.source_url,
        canonical_source_url=draft.canonical_source_url,
        playlist_source_url=draft.playlist_source_url,
        thumbnail_url=draft.thumbnail_url,
        duration_seconds=draft.duration_seconds,
        original_filename=draft.original_filename,
        content_hash=draft.content_hash,
        size_bytes=draft.size_bytes,
        duplicate_action=draft.duplicate_action,
        existing_track_id=draft.existing_track_id,
        duplicate_tracks=duplicate_tracks,
    )


def _build_duplicate_lookup(tracks: list[Track]) -> DuplicateLookup:
    by_video_id: dict[str, list[Track]] = {}
    by_source_url: dict[str, list[Track]] = {}
    by_content_hash: dict[str, list[Track]] = {}

    for track in tracks:
        metadata = track.metadata_json or {}
        video_id = metadata.get("video_id")
        if isinstance(video_id, str) and video_id:
            by_video_id.setdefault(video_id, []).append(track)

        source_url = metadata.get("source_url")
        if isinstance(source_url, str) and source_url:
            by_source_url.setdefault(source_url, []).append(track)

        content_hash = metadata.get("content_hash")
        if isinstance(content_hash, str) and content_hash:
            by_content_hash.setdefault(content_hash, []).append(track)

    return DuplicateLookup(
        by_video_id=by_video_id,
        by_source_url=by_source_url,
        by_content_hash=by_content_hash,
    )


def _find_duplicates_by_source(
    lookup: DuplicateLookup,
    video_id: str,
    canonical_source_url: str,
) -> list[Track]:
    seen: dict[str, Track] = {}
    for track in lookup.by_video_id.get(video_id, []):
        seen[track.id] = track
    for track in lookup.by_source_url.get(canonical_source_url, []):
        seen[track.id] = track
    return list(seen.values())


def _find_duplicates_by_hash(lookup: DuplicateLookup, content_hash: str) -> list[Track]:
    return list(lookup.by_content_hash.get(content_hash, []))
