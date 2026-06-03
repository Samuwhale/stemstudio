from pathlib import Path
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.core.config import RuntimeSettings
from backend.db.models import AppSettings
from backend.db.session import rollback_session
from backend.schemas.settings import (
    RetentionSettingsResponse,
    SettingsResponse,
    SettingsUpdateRequest,
    StorageSettingsResponse,
)
from backend.services.processing import (
    build_processing_config,
    default_stem_selection_metadata,
    normalize_export_bitrate,
    serialize_processing_config,
    serialize_quality_options,
    serialize_stem_options,
    settings_default_selection,
)
from backend.services.storage import resolve_storage_paths, storage_path_from_setting

DEFAULT_TEMP_MAX_AGE_HOURS = 24
DEFAULT_EXPORT_BUNDLE_MAX_AGE_DAYS = 7


def _positive_int_or_default(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return number if number >= 1 else default


def _resolve_storage_directory(raw_value: str) -> str:
    cleaned = raw_value.strip()
    if not cleaned:
        raise ValueError("Storage directories cannot be empty.")
    return str(Path(cleaned).expanduser().resolve())


def _storage_directory_or_default(value: Any, default: Path) -> str:
    return str(storage_path_from_setting(value, default))


def get_or_create_settings(session: Session, runtime_settings: RuntimeSettings) -> AppSettings:
    settings = session.get(AppSettings, 1)
    if settings is None:
        settings = AppSettings(
            id=1,
            outputs_directory=str(runtime_settings.output_dir.resolve()),
            uploads_directory=str(runtime_settings.uploads_dir.resolve()),
            exports_directory=str(runtime_settings.exports_dir.resolve()),
            temp_directory=str(runtime_settings.temp_dir.resolve()),
            model_cache_directory=str(runtime_settings.model_cache_dir.resolve()),
            temp_max_age_hours=DEFAULT_TEMP_MAX_AGE_HOURS,
            export_bundle_max_age_days=DEFAULT_EXPORT_BUNDLE_MAX_AGE_DAYS,
            default_stem_selection=default_stem_selection_metadata(),
            export_mp3_bitrate="320k",
        )
        session.add(settings)
        try:
            session.commit()
        except IntegrityError:
            rollback_session(session)
            settings = session.get(AppSettings, 1)
            if settings is None:
                raise
        else:
            session.refresh(settings)
    if _backfill_settings(settings, runtime_settings):
        session.add(settings)
        session.commit()
        session.refresh(settings)
    return settings


def _backfill_settings(settings: AppSettings, runtime_settings: RuntimeSettings) -> bool:
    changed = False
    defaults = {
        "uploads_directory": runtime_settings.uploads_dir,
        "outputs_directory": runtime_settings.output_dir,
        "exports_directory": runtime_settings.exports_dir,
        "temp_directory": runtime_settings.temp_dir,
        "model_cache_directory": runtime_settings.model_cache_dir,
        "temp_max_age_hours": DEFAULT_TEMP_MAX_AGE_HOURS,
        "export_bundle_max_age_days": DEFAULT_EXPORT_BUNDLE_MAX_AGE_DAYS,
    }
    for field_name, value in defaults.items():
        if field_name.endswith("_directory"):
            normalized = _storage_directory_or_default(getattr(settings, field_name), value)
            if getattr(settings, field_name) == normalized:
                continue
            setattr(settings, field_name, normalized)
            changed = True
        elif getattr(settings, field_name) is None:
            setattr(settings, field_name, value)
            changed = True
    if not isinstance(settings.default_stem_selection, dict):
        settings.default_stem_selection = default_stem_selection_metadata()
        changed = True
    temp_max_age_hours = _positive_int_or_default(settings.temp_max_age_hours, DEFAULT_TEMP_MAX_AGE_HOURS)
    if settings.temp_max_age_hours != temp_max_age_hours:
        settings.temp_max_age_hours = temp_max_age_hours
        changed = True
    export_bundle_max_age_days = _positive_int_or_default(
        settings.export_bundle_max_age_days,
        DEFAULT_EXPORT_BUNDLE_MAX_AGE_DAYS,
    )
    if settings.export_bundle_max_age_days != export_bundle_max_age_days:
        settings.export_bundle_max_age_days = export_bundle_max_age_days
        changed = True
    normalized_bitrate = normalize_export_bitrate(settings.export_mp3_bitrate)
    if settings.export_mp3_bitrate != normalized_bitrate:
        settings.export_mp3_bitrate = normalized_bitrate
        changed = True
    return changed


def serialize_settings(settings: AppSettings, runtime_settings: RuntimeSettings) -> SettingsResponse:
    default_selection = settings_default_selection(settings)
    storage = StorageSettingsResponse(
        database_path=str(runtime_settings.database_path.expanduser().resolve()),
        uploads_directory=_storage_directory_or_default(settings.uploads_directory, runtime_settings.uploads_dir),
        outputs_directory=_storage_directory_or_default(settings.outputs_directory, runtime_settings.output_dir),
        exports_directory=_storage_directory_or_default(settings.exports_directory, runtime_settings.exports_dir),
        temp_directory=_storage_directory_or_default(settings.temp_directory, runtime_settings.temp_dir),
        model_cache_directory=_storage_directory_or_default(
            settings.model_cache_directory,
            runtime_settings.model_cache_dir,
        ),
    )
    return SettingsResponse(
        storage=storage,
        retention=RetentionSettingsResponse(
            temp_max_age_hours=_positive_int_or_default(
                settings.temp_max_age_hours,
                DEFAULT_TEMP_MAX_AGE_HOURS,
            ),
            export_bundle_max_age_days=_positive_int_or_default(
                settings.export_bundle_max_age_days,
                DEFAULT_EXPORT_BUNDLE_MAX_AGE_DAYS,
            ),
        ),
        default_stem_selection=serialize_processing_config(
            build_processing_config(
                tuple(default_selection["stems"]),
                default_selection["quality"],
            )
        ),
        export_mp3_bitrate=normalize_export_bitrate(settings.export_mp3_bitrate),
        stem_options=serialize_stem_options(),
        quality_options=serialize_quality_options(),
    )


def update_settings(
    session: Session,
    runtime_settings: RuntimeSettings,
    payload: SettingsUpdateRequest,
) -> SettingsResponse:
    if payload.retention.temp_max_age_hours < 1:
        raise ValueError("Temp retention must be at least 1 hour.")
    if payload.retention.export_bundle_max_age_days < 1:
        raise ValueError("Export bundle retention must be at least 1 day.")

    uploads_directory = _resolve_storage_directory(payload.storage.uploads_directory)
    outputs_directory = _resolve_storage_directory(payload.storage.outputs_directory)
    exports_directory = _resolve_storage_directory(payload.storage.exports_directory)
    temp_directory = _resolve_storage_directory(payload.storage.temp_directory)
    model_cache_directory = _resolve_storage_directory(payload.storage.model_cache_directory)
    selection = build_processing_config(tuple(payload.default_stem_selection.stems), payload.default_stem_selection.quality)
    default_stem_selection = {
        "stems": list(selection.visible_stems),
        "quality": selection.quality,
    }
    export_mp3_bitrate = normalize_export_bitrate(payload.export_mp3_bitrate)

    candidate = AppSettings(
        id=1,
        uploads_directory=uploads_directory,
        outputs_directory=outputs_directory,
        exports_directory=exports_directory,
        temp_directory=temp_directory,
        model_cache_directory=model_cache_directory,
        temp_max_age_hours=payload.retention.temp_max_age_hours,
        export_bundle_max_age_days=payload.retention.export_bundle_max_age_days,
        default_stem_selection=default_stem_selection,
        export_mp3_bitrate=export_mp3_bitrate,
    )
    resolve_storage_paths(runtime_settings, candidate)

    settings = get_or_create_settings(session, runtime_settings)
    settings.uploads_directory = uploads_directory
    settings.outputs_directory = outputs_directory
    settings.exports_directory = exports_directory
    settings.temp_directory = temp_directory
    settings.model_cache_directory = model_cache_directory
    settings.temp_max_age_hours = payload.retention.temp_max_age_hours
    settings.export_bundle_max_age_days = payload.retention.export_bundle_max_age_days
    settings.default_stem_selection = default_stem_selection
    settings.export_mp3_bitrate = export_mp3_bitrate
    session.add(settings)
    session.commit()
    session.refresh(settings)
    return serialize_settings(settings, runtime_settings)
