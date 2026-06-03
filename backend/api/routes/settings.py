from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.api.dependencies import get_db_session, get_settings_dependency
from backend.api.file_errors import local_file_http_error
from backend.core.config import RuntimeSettings
from backend.schemas.settings import SettingsResponse, SettingsUpdateRequest
from backend.services.settings import get_or_create_settings, serialize_settings, update_settings

router = APIRouter(tags=["settings"])


@router.get("/settings", response_model=SettingsResponse)
def get_settings(
    session: Session = Depends(get_db_session),
    runtime_settings: RuntimeSettings = Depends(get_settings_dependency),
) -> SettingsResponse:
    try:
        settings = get_or_create_settings(session, runtime_settings)
        return serialize_settings(settings, runtime_settings)
    except OSError as error:
        raise local_file_http_error("Settings", error) from error


@router.put("/settings", response_model=SettingsResponse)
def put_settings(
    payload: SettingsUpdateRequest,
    session: Session = Depends(get_db_session),
    runtime_settings: RuntimeSettings = Depends(get_settings_dependency),
) -> SettingsResponse:
    try:
        return update_settings(session, runtime_settings, payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except OSError as error:
        raise local_file_http_error("Settings update", error) from error
