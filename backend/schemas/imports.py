from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from backend.core.imports import DraftDuplicateAction, DraftSourceType, DraftStatus
from backend.schemas.tracks import (
    QualityOptionResponse,
    RunProcessingConfigRequest,
    RunProcessingConfigResponse,
    StemOptionResponse,
    TrackSummaryResponse,
)
from backend.schemas.validation import normalize_unique_string_list


class ExistingTrackDuplicateResponse(BaseModel):
    id: str
    title: str
    artist: str | None
    source_filename: str


class ImportDraftResponse(BaseModel):
    id: str
    source_type: DraftSourceType
    status: DraftStatus
    created_at: datetime
    updated_at: datetime

    title: str
    artist: str | None
    suggested_title: str
    suggested_artist: str | None

    video_id: str | None = None
    source_url: str | None = None
    canonical_source_url: str | None = None
    playlist_source_url: str | None = None
    thumbnail_url: str | None = None
    duration_seconds: float | None = None

    original_filename: str | None = None
    content_hash: str | None = None
    size_bytes: int | None = None

    duplicate_action: DraftDuplicateAction | None = None
    existing_track_id: str | None = None
    duplicate_tracks: list[ExistingTrackDuplicateResponse] = Field(default_factory=list)


class ResolveYouTubeImportRequest(BaseModel):
    source_url: str

    @field_validator("source_url")
    @classmethod
    def validate_source_url(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Source URL cannot be blank.")
        return cleaned


class ResolveYouTubeImportResponse(BaseModel):
    source_kind: str
    source_title: str
    drafts: list[ImportDraftResponse]
    stem_options: list[StemOptionResponse]
    quality_options: list[QualityOptionResponse]
    default_processing: RunProcessingConfigResponse


class ResolveLocalImportResponse(BaseModel):
    drafts: list[ImportDraftResponse]
    stem_options: list[StemOptionResponse]
    quality_options: list[QualityOptionResponse]
    default_processing: RunProcessingConfigResponse


class UpdateImportDraftRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    artist: str | None = None
    duplicate_action: DraftDuplicateAction | None = None
    existing_track_id: str | None = None

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Title cannot be empty.")
        return cleaned

    @field_validator("artist")
    @classmethod
    def normalize_artist(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("existing_track_id")
    @classmethod
    def normalize_existing_track_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class ConfirmImportDraftsRequest(BaseModel):
    draft_ids: list[str] = Field(min_length=1)
    queue: bool = False
    processing: RunProcessingConfigRequest | None = None

    @field_validator("draft_ids")
    @classmethod
    def validate_draft_ids(cls, value: list[str]) -> list[str]:
        return normalize_unique_string_list(value, label="Draft ids")


class ConfirmImportDraftsResponse(BaseModel):
    tracks: list[TrackSummaryResponse]
    created_track_count: int
    reused_track_count: int
    skipped_draft_count: int
    queued_run_count: int
