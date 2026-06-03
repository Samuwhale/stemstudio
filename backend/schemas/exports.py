from enum import StrEnum

from pydantic import BaseModel, Field, field_validator

from backend.core.stems import (
    EXPORT_STEM_MP3_PREFIX,
    EXPORT_STEM_WAV_PREFIX,
    STEM_NAME_PATTERN,
)
from backend.schemas.validation import normalize_mp3_bitrate, normalize_string_mapping, normalize_unique_string_list


STATIC_ARTIFACT_KINDS: frozenset[str] = frozenset({
    "source",
    "metadata",
    "mix-wav",
    "mix-mp3",
})


def validate_export_artifact_kind(value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("Artifact kinds cannot be blank.")
    if cleaned in STATIC_ARTIFACT_KINDS:
        return cleaned
    for prefix in (EXPORT_STEM_WAV_PREFIX, EXPORT_STEM_MP3_PREFIX):
        if cleaned.startswith(prefix):
            stem_name = cleaned[len(prefix):]
            if not STEM_NAME_PATTERN.match(stem_name):
                raise ValueError(f"Invalid stem name in export artifact kind: {cleaned!r}")
            return cleaned
    raise ValueError(f"Unsupported export artifact kind: {cleaned!r}")


class ExportPackagingMode(StrEnum):
    auto = "auto"
    flat = "flat"
    per_song_folders = "per-song-folders"


class ExportDeliveryKind(StrEnum):
    direct_file = "direct-file"
    flat_zip = "flat-zip"
    folder_zip = "folder-zip"


class ExportRequestBase(BaseModel):
    track_ids: list[str] = Field(min_length=1)
    run_ids: dict[str, str] = Field(default_factory=dict)
    artifacts: list[str] = Field(min_length=1)
    packaging: ExportPackagingMode = ExportPackagingMode.auto
    bitrate: str = "320k"

    @field_validator("artifacts")
    @classmethod
    def _validate_artifacts(cls, value: list[str]) -> list[str]:
        validated = [validate_export_artifact_kind(item) for item in value]
        return normalize_unique_string_list(validated, label="Artifact kinds")

    @field_validator("track_ids")
    @classmethod
    def _validate_track_ids(cls, value: list[str]) -> list[str]:
        return normalize_unique_string_list(value, label="Track ids")

    @field_validator("run_ids")
    @classmethod
    def _validate_run_ids(cls, value: dict[str, str]) -> dict[str, str]:
        return normalize_string_mapping(
            value,
            key_label="Run override track ids",
            value_label="Run ids",
        )

    @field_validator("bitrate")
    @classmethod
    def _validate_bitrate_field(cls, value: str) -> str:
        return normalize_mp3_bitrate(value, label="bitrate")


class ExportBundleRequest(ExportRequestBase):
    """Request body for creating an export download."""


class ExportBundleSkip(BaseModel):
    track_id: str
    track_title: str
    reason: str


class ExportBundleResponse(BaseModel):
    job_id: str
    download_url: str
    filename: str
    delivery: ExportDeliveryKind
    byte_count: int
    included_track_count: int
    skipped: list[ExportBundleSkip] = Field(default_factory=list)


class ExportPlanRequest(ExportRequestBase):
    """Request body for previewing an export download."""


class ExportPlanArtifact(BaseModel):
    kind: str
    present: bool
    size_bytes: int | None = None
    missing_reason: str | None = None


class ExportPlanTrack(BaseModel):
    track_id: str
    track_title: str
    run_id: str | None
    output_label: str | None = None
    artifacts: list[ExportPlanArtifact]
    skip_reason: str | None = None


class ExportPlanResponse(BaseModel):
    tracks: list[ExportPlanTrack]
    delivery: ExportDeliveryKind | None = None
    filename: str | None = None
    included_track_count: int
    total_bytes: int
    skipped_track_count: int


class ExportStemsRequest(BaseModel):
    track_ids: list[str] = Field(min_length=1)
    run_ids: dict[str, str] = Field(default_factory=dict)

    @field_validator("track_ids")
    @classmethod
    def _validate_track_ids(cls, value: list[str]) -> list[str]:
        return normalize_unique_string_list(value, label="Track ids")

    @field_validator("run_ids")
    @classmethod
    def _validate_run_ids(cls, value: dict[str, str]) -> dict[str, str]:
        return normalize_string_mapping(
            value,
            key_label="Run override track ids",
            value_label="Run ids",
        )


class ExportStemOption(BaseModel):
    name: str
    label: str
    track_count: int


class ExportStemsResponse(BaseModel):
    stems: list[ExportStemOption]
