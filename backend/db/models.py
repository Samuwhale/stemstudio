from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import uuid4

from sqlalchemy import DateTime, Float, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.core.imports import DraftStatus
from backend.db.session import Base


def new_identifier() -> str:
    return uuid4().hex


class RunStatus(StrEnum):
    queued = "queued"
    preparing = "preparing"
    separating = "separating"
    exporting = "exporting"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


IN_PROGRESS_RUN_STATUSES: frozenset[str] = frozenset(
    {RunStatus.preparing.value, RunStatus.separating.value, RunStatus.exporting.value}
)

ACTIVE_RUN_STATUSES: frozenset[str] = frozenset(
    {RunStatus.queued.value, *IN_PROGRESS_RUN_STATUSES}
)

TERMINAL_RUN_STATUSES: frozenset[str] = frozenset(
    {RunStatus.completed.value, RunStatus.failed.value, RunStatus.cancelled.value}
)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False),
        default=datetime.utcnow,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=False),
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )


class AppSettings(TimestampMixin, Base):
    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    outputs_directory: Mapped[str] = mapped_column("output_directory", String(512))
    uploads_directory: Mapped[str | None] = mapped_column(String(512), nullable=True)
    exports_directory: Mapped[str | None] = mapped_column(String(512), nullable=True)
    temp_directory: Mapped[str | None] = mapped_column(String(512), nullable=True)
    model_cache_directory: Mapped[str] = mapped_column(String(512))
    temp_max_age_hours: Mapped[int | None] = mapped_column(Integer, nullable=True)
    export_bundle_max_age_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    default_stem_selection: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    export_mp3_bitrate: Mapped[str] = mapped_column(String(32), default="320k")


class Track(TimestampMixin, Base):
    __tablename__ = "tracks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_identifier)
    title: Mapped[str] = mapped_column(String(255))
    artist: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source_filename: Mapped[str] = mapped_column(String(255))
    source_path: Mapped[str] = mapped_column(String(512))
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    keeper_run_id: Mapped[str | None] = mapped_column(String(32), nullable=True)

    runs: Mapped[list[Run]] = relationship(
        back_populates="track",
        cascade="all, delete-orphan",
        order_by=lambda: Run.created_at.desc(),
        foreign_keys=lambda: [Run.track_id],
    )


class Run(TimestampMixin, Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_identifier)
    track_id: Mapped[str] = mapped_column(ForeignKey("tracks.id", ondelete="CASCADE"))
    pipeline_key: Mapped[str] = mapped_column("preset", String(128))
    status: Mapped[str] = mapped_column(String(32), default=RunStatus.queued.value)
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    status_message: Mapped[str] = mapped_column(String(255), default="")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    output_directory: Mapped[str | None] = mapped_column(String(512), nullable=True)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    last_active_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)
    mix_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    track: Mapped[Track] = relationship(back_populates="runs")
    artifacts: Mapped[list[RunArtifact]] = relationship(
        back_populates="run",
        cascade="all, delete-orphan",
        order_by=lambda: RunArtifact.created_at,
    )


class RunArtifact(Base):
    __tablename__ = "run_artifacts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_identifier)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(64))
    label: Mapped[str] = mapped_column(String(255))
    format: Mapped[str] = mapped_column(String(32))
    path: Mapped[str] = mapped_column(String(512))
    metrics_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), default=datetime.utcnow)

    run: Mapped[Run] = relationship(back_populates="artifacts")


class ImportDraft(TimestampMixin, Base):
    __tablename__ = "import_drafts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_identifier)
    source_type: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), default=DraftStatus.pending.value)

    # YouTube-specific
    video_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    canonical_source_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    playlist_source_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    thumbnail_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)

    # Local-specific
    session_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    pending_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    original_filename: Mapped[str | None] = mapped_column(String(512), nullable=True)
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Common editable fields
    suggested_title: Mapped[str] = mapped_column(String(255), default="Untitled Track")
    suggested_artist: Mapped[str | None] = mapped_column(String(255), nullable=True)
    title: Mapped[str] = mapped_column(String(255))
    artist: Mapped[str | None] = mapped_column(String(255), nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Duplicate handling — null means "unresolved" and must be disambiguated before confirm
    duplicate_action: Mapped[str | None] = mapped_column(String(32), nullable=True)
    existing_track_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    duplicate_track_ids: Mapped[list[str]] = mapped_column(JSON, default=list)

    resolution_metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
