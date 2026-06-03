from pydantic import BaseModel, field_validator

from backend.schemas.tracks import QualityOptionResponse, RunProcessingConfigRequest, RunProcessingConfigResponse, StemOptionResponse
from backend.schemas.validation import normalize_mp3_bitrate


def _require_non_empty_path(value: str, *, field_label: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"{field_label} cannot be empty.")
    return cleaned


class StorageSettingsResponse(BaseModel):
    database_path: str
    uploads_directory: str
    outputs_directory: str
    exports_directory: str
    temp_directory: str
    model_cache_directory: str


class StorageSettingsUpdateRequest(BaseModel):
    uploads_directory: str
    outputs_directory: str
    exports_directory: str
    temp_directory: str
    model_cache_directory: str

    @field_validator(
        "uploads_directory",
        "outputs_directory",
        "exports_directory",
        "temp_directory",
        "model_cache_directory",
        mode="after",
    )
    @classmethod
    def validate_directory(cls, value: str, info) -> str:
        field_label = info.field_name.replace("_", " ")
        return _require_non_empty_path(value, field_label=field_label.capitalize())


class RetentionSettingsResponse(BaseModel):
    temp_max_age_hours: int
    export_bundle_max_age_days: int


class RetentionSettingsUpdateRequest(BaseModel):
    temp_max_age_hours: int
    export_bundle_max_age_days: int


class SettingsResponse(BaseModel):
    storage: StorageSettingsResponse
    retention: RetentionSettingsResponse
    default_stem_selection: RunProcessingConfigResponse
    export_mp3_bitrate: str
    stem_options: list[StemOptionResponse]
    quality_options: list[QualityOptionResponse]


class SettingsUpdateRequest(BaseModel):
    storage: StorageSettingsUpdateRequest
    retention: RetentionSettingsUpdateRequest
    default_stem_selection: RunProcessingConfigRequest
    export_mp3_bitrate: str

    @field_validator("export_mp3_bitrate", mode="after")
    @classmethod
    def validate_export_mp3_bitrate(cls, value: str) -> str:
        return normalize_mp3_bitrate(value, label="Export MP3 bitrate")
