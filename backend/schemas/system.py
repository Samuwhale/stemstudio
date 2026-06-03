from enum import StrEnum

from pydantic import BaseModel


class BinaryStatusResponse(BaseModel):
    name: str
    required: bool
    available: bool
    path: str | None
    version: str | None


class DiagnosticsResponse(BaseModel):
    app_ready: bool
    separation_ready: bool
    acceleration: str
    free_disk_gb: float
    binaries: list[BinaryStatusResponse]
    issues: list[str]
    data_directories: dict[str, str]
    url_import_ready: bool


class RevealFolderKind(StrEnum):
    exports = "exports"
    outputs = "outputs"
    track_outputs = "track-outputs"
    bundle = "bundle"


class RevealFolderRequest(BaseModel):
    kind: RevealFolderKind
    track_id: str | None = None
    job_id: str | None = None


class RevealFolderResponse(BaseModel):
    path: str
