from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from backend.api.dependencies import get_db_session, get_settings_dependency
from backend.core.config import RuntimeSettings
from backend.schemas.imports import (
    ConfirmImportDraftsRequest,
    ConfirmImportDraftsResponse,
    ImportDraftResponse,
    ResolveLocalImportResponse,
    ResolveYouTubeImportRequest,
    ResolveYouTubeImportResponse,
    UpdateImportDraftRequest,
)
from backend.services.imports import (
    ConfirmValidationError,
    WorkerUnavailableError,
    confirm_import_drafts,
    discard_import_draft,
    list_import_drafts,
    resolve_local_import,
    resolve_youtube_import,
    update_import_draft,
)

router = APIRouter(tags=["imports"])


def _import_file_error(error: OSError) -> HTTPException:
    return HTTPException(
        status_code=400,
        detail=f"Import failed while updating local files: {error}",
    )


@router.post("/imports/youtube/resolve", response_model=ResolveYouTubeImportResponse)
def resolve_youtube_import_endpoint(
    payload: ResolveYouTubeImportRequest,
    session: Session = Depends(get_db_session),
    runtime_settings: RuntimeSettings = Depends(get_settings_dependency),
) -> ResolveYouTubeImportResponse:
    try:
        return resolve_youtube_import(session, runtime_settings, payload.source_url)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except OSError as error:
        raise _import_file_error(error) from error


@router.post("/imports/local/resolve", response_model=ResolveLocalImportResponse)
def resolve_local_import_endpoint(
    files: list[UploadFile] = File(...),
    session: Session = Depends(get_db_session),
    runtime_settings: RuntimeSettings = Depends(get_settings_dependency),
) -> ResolveLocalImportResponse:
    prepared = [(upload.filename or "untitled", upload.file) for upload in files]
    try:
        return resolve_local_import(runtime_settings, session, prepared)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except OSError as error:
        raise _import_file_error(error) from error


@router.get("/imports/drafts", response_model=list[ImportDraftResponse])
def list_drafts_endpoint(
    session: Session = Depends(get_db_session),
) -> list[ImportDraftResponse]:
    return list_import_drafts(session)


@router.patch("/imports/drafts/{draft_id}", response_model=ImportDraftResponse)
def update_draft_endpoint(
    draft_id: str,
    payload: UpdateImportDraftRequest,
    session: Session = Depends(get_db_session),
) -> ImportDraftResponse:
    try:
        return update_import_draft(session, draft_id, payload)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.delete("/imports/drafts/{draft_id}")
def discard_draft_endpoint(
    draft_id: str,
    session: Session = Depends(get_db_session),
    runtime_settings: RuntimeSettings = Depends(get_settings_dependency),
) -> dict[str, bool]:
    try:
        discard_import_draft(session, runtime_settings, draft_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except OSError as error:
        raise _import_file_error(error) from error
    return {"ok": True}


@router.post("/imports/drafts/confirm", response_model=ConfirmImportDraftsResponse)
def confirm_drafts_endpoint(
    payload: ConfirmImportDraftsRequest,
    session: Session = Depends(get_db_session),
    runtime_settings: RuntimeSettings = Depends(get_settings_dependency),
) -> ConfirmImportDraftsResponse:
    try:
        return confirm_import_drafts(session, runtime_settings, payload)
    except WorkerUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ConfirmValidationError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except OSError as error:
        raise _import_file_error(error) from error
