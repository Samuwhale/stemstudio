from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from backend.api.dependencies import get_db_session, get_settings_dependency
from backend.core.config import RuntimeSettings
from backend.core.worker_health import is_worker_alive
from backend.db.models import ACTIVE_RUN_STATUSES, Run, RunStatus, Track
from backend.schemas.tracks import (
    ActiveRunsResponse,
    BackfillMetricsResponse,
    BatchDeleteResponse,
    BatchTrackIdsRequest,
    CreateRunRequest,
    QueueRunResponse,
    RunDetailResponse,
    RunMixInput,
    RunMutationResponse,
    SetKeeperRequest,
    TrackDetailResponse,
    TrackSummaryResponse,
    UpdateTrackRequest,
)
from backend.services.metrics import backfill_artifact_metrics
from backend.services.processing import build_processing_from_request
from backend.services.settings import get_or_create_settings
from backend.services.tracks import (
    batch_delete_tracks as batch_delete_tracks_service,
    create_run,
    delete_run,
    dismiss_run,
    get_track,
    list_tracks,
    request_run_cancellation,
    retry_run,
    serialize_run_detail,
    serialize_run_summary,
    serialize_track_detail,
    serialize_track_summary,
    set_keeper_run,
    set_run_mix,
    track_source_path,
    update_track,
)

router = APIRouter(tags=["tracks"])


@router.get("/tracks", response_model=list[TrackSummaryResponse])
def get_tracks(session: Session = Depends(get_db_session)) -> list[TrackSummaryResponse]:
    return [serialize_track_summary(track) for track in list_tracks(session)]


@router.get("/tracks/{track_id}", response_model=TrackDetailResponse)
def get_track_detail(track_id: str, session: Session = Depends(get_db_session)) -> TrackDetailResponse:
    track = get_track(session, track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found.")
    return serialize_track_detail(track)


@router.put("/tracks/{track_id}", response_model=TrackDetailResponse)
def update_track_endpoint(
    track_id: str,
    payload: UpdateTrackRequest,
    session: Session = Depends(get_db_session),
) -> TrackDetailResponse:
    update_fields: dict[str, str | None] = {"title": payload.title}
    if "artist" in payload.model_fields_set:
        update_fields["artist"] = payload.artist
    try:
        track = update_track(session, track_id, **update_fields)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return serialize_track_detail(track)


@router.get("/tracks/{track_id}/source")
def download_track_source(track_id: str, session: Session = Depends(get_db_session)) -> FileResponse:
    track = get_track(session, track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found.")
    source_path = track_source_path(track)
    if not source_path.is_file():
        raise HTTPException(status_code=404, detail="Source file is missing on disk.")
    return FileResponse(
        path=source_path,
        filename=track.source_filename,
        content_disposition_type="attachment",
    )


@router.post("/tracks/{track_id}/runs", response_model=RunMutationResponse)
def create_track_run(
    track_id: str,
    payload: CreateRunRequest,
    session: Session = Depends(get_db_session),
    runtime_settings: RuntimeSettings = Depends(get_settings_dependency),
) -> RunMutationResponse:
    track = get_track(session, track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found.")

    try:
        processing = build_processing_from_request(
            payload.processing,
            get_or_create_settings(session, runtime_settings),
        )
        run = create_run(track, processing)
        session.commit()
    except ValueError as error:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(error)) from error

    session.refresh(run)
    return RunMutationResponse(run=serialize_run_summary(run))


@router.post("/runs/{run_id}/cancel", response_model=RunMutationResponse)
def cancel_run_endpoint(run_id: str, session: Session = Depends(get_db_session)) -> RunMutationResponse:
    try:
        run = request_run_cancellation(session, run_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return RunMutationResponse(run=serialize_run_summary(run))


@router.delete("/runs/{run_id}")
def delete_run_endpoint(run_id: str, session: Session = Depends(get_db_session)) -> dict[str, bool]:
    try:
        delete_run(session, run_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return {"ok": True}


@router.post("/runs/{run_id}/retry", response_model=RunMutationResponse)
def retry_run_endpoint(run_id: str, session: Session = Depends(get_db_session)) -> RunMutationResponse:
    try:
        run = retry_run(session, run_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return RunMutationResponse(run=serialize_run_summary(run))


@router.post("/runs/{run_id}/dismiss", response_model=RunMutationResponse)
def dismiss_run_endpoint(run_id: str, session: Session = Depends(get_db_session)) -> RunMutationResponse:
    try:
        run = dismiss_run(session, run_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return RunMutationResponse(run=serialize_run_summary(run))


@router.put(
    "/tracks/{track_id}/runs/{run_id}/mix",
    response_model=RunDetailResponse,
)
def set_run_mix_endpoint(
    track_id: str,
    run_id: str,
    payload: RunMixInput,
    session: Session = Depends(get_db_session),
) -> RunDetailResponse:
    try:
        run = set_run_mix(session, track_id, run_id, payload)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return serialize_run_detail(run)


@router.put("/tracks/{track_id}/keeper", response_model=TrackDetailResponse)
def set_track_keeper(
    track_id: str,
    payload: SetKeeperRequest,
    session: Session = Depends(get_db_session),
) -> TrackDetailResponse:
    try:
        track = set_keeper_run(session, track_id, payload.run_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return serialize_track_detail(track)


@router.get("/runs/active", response_model=ActiveRunsResponse)
def list_active_runs(
    session: Session = Depends(get_db_session),
    settings: RuntimeSettings = Depends(get_settings_dependency),
) -> ActiveRunsResponse:
    terminal_statuses = [RunStatus.failed.value, RunStatus.cancelled.value]

    active_statement = (
        select(Run)
        .options(selectinload(Run.track))
        .where(Run.status.in_(ACTIVE_RUN_STATUSES))
        .order_by(Run.created_at.asc())
    )
    # Recently-terminal runs stay visible until the user dismisses them so
    # failures don't silently vanish from the queue.
    terminal_statement = (
        select(Run)
        .options(selectinload(Run.track))
        .where(Run.status.in_(terminal_statuses))
        .where(Run.dismissed_at.is_(None))
        .order_by(Run.updated_at.desc())
    )

    entries: list[QueueRunResponse] = []
    for run in list(session.scalars(active_statement)) + list(session.scalars(terminal_statement)):
        track: Track | None = run.track
        entries.append(
            QueueRunResponse(
                run=serialize_run_summary(run),
                track_id=run.track_id,
                track_title=track.title if track else "(deleted)",
                track_artist=track.artist if track else None,
            )
        )
    return ActiveRunsResponse(runs=entries, worker_online=is_worker_alive(settings))


@router.post("/tracks/batch/delete", response_model=BatchDeleteResponse)
def batch_delete_tracks(
    payload: BatchTrackIdsRequest,
    session: Session = Depends(get_db_session),
) -> BatchDeleteResponse:
    deleted, blocked, missing = batch_delete_tracks_service(session, payload.track_ids)
    return BatchDeleteResponse(
        deleted_track_count=deleted,
        blocked_track_ids=blocked,
        missing_track_ids=missing,
    )


@router.post("/admin/backfill-metrics", response_model=BackfillMetricsResponse)
def backfill_metrics_endpoint(
    session: Session = Depends(get_db_session),
    runtime_settings: RuntimeSettings = Depends(get_settings_dependency),
) -> BackfillMetricsResponse:
    updated = backfill_artifact_metrics(session, runtime_settings)
    return BackfillMetricsResponse(updated_artifact_count=updated)
