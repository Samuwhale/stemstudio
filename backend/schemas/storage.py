from enum import StrEnum

from pydantic import BaseModel


class StorageBucketKey(StrEnum):
    database = "database"
    uploads = "uploads"
    outputs = "outputs"
    export_bundles = "export_bundles"
    temp = "temp"
    model_cache = "model_cache"


class StorageBucketResponse(BaseModel):
    key: StorageBucketKey
    label: str
    path: str
    total_bytes: int
    reclaimable_bytes: int


class StorageOverviewResponse(BaseModel):
    items: list[StorageBucketResponse]
    total_bytes: int


class TempCleanupResponse(BaseModel):
    deleted_entry_count: int
    bytes_reclaimed: int


class ExportBundleCleanupResponse(BaseModel):
    deleted_bundle_count: int
    bytes_reclaimed: int


class NonKeeperCleanupResponse(BaseModel):
    purged_track_count: int
    skipped_track_count: int
    deleted_run_count: int
    bytes_reclaimed: int


class LibraryResetResponse(BaseModel):
    deleted_track_count: int
    deleted_draft_count: int
    bytes_reclaimed: int
