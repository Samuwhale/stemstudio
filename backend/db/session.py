import json
import logging
import shutil
from pathlib import Path

from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from backend.core.config import get_runtime_settings


class Base(DeclarativeBase):
    """Base class for SQLAlchemy models."""


runtime_settings = get_runtime_settings()
logger = logging.getLogger(__name__)
engine = create_engine(
    runtime_settings.database_url,
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
_PENDING_PATH_CLEANUPS_KEY = "pending_path_cleanups"
_DEFAULT_STEM_SELECTION = {"stems": ["instrumental", "vocals"], "quality": "balanced"}


_COLUMN_ADDITIONS: tuple[tuple[str, str, str], ...] = (
    ("tracks", "keeper_run_id", "VARCHAR(32) NULL"),
    ("run_artifacts", "metrics_json", "JSON NULL"),
    ("runs", "last_active_status", "VARCHAR(32) NULL"),
    ("runs", "dismissed_at", "DATETIME NULL"),
    ("runs", "mix_json", "JSON NULL"),
    ("app_settings", "uploads_directory", "VARCHAR(512) NULL"),
    ("app_settings", "exports_directory", "VARCHAR(512) NULL"),
    ("app_settings", "temp_directory", "VARCHAR(512) NULL"),
    ("app_settings", "temp_max_age_hours", "INTEGER NULL"),
    ("app_settings", "export_bundle_max_age_days", "INTEGER NULL"),
    ("app_settings", "default_stem_selection", "JSON NULL"),
    ("app_settings", "export_mp3_bitrate", "VARCHAR(32) NOT NULL DEFAULT '320k'"),
)


def _existing_columns(connection, table: str) -> set[str]:
    rows = connection.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
    return {row[1] for row in rows}


def _apply_schema_migrations(engine: Engine) -> None:
    with engine.begin() as connection:
        for table, column, definition in _COLUMN_ADDITIONS:
            if column in _existing_columns(connection, table):
                continue
            connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {definition}"))


def _seed_default_stem_selection(engine: Engine) -> None:
    with engine.begin() as connection:
        default_selection = json.dumps(_DEFAULT_STEM_SELECTION)
        connection.execute(
            text("UPDATE app_settings SET default_stem_selection = :selection WHERE default_stem_selection IS NULL"),
            {"selection": default_selection},
        )


def schedule_path_cleanup(session: Session, *paths: Path | None) -> None:
    pending = session.info.setdefault(_PENDING_PATH_CLEANUPS_KEY, set())
    for path in paths:
        if path is None:
            continue
        pending.add(path.absolute())


def _clear_scheduled_path_cleanups(session: Session) -> None:
    session.info.pop(_PENDING_PATH_CLEANUPS_KEY, None)


def rollback_session(session: Session) -> None:
    session.rollback()
    _clear_scheduled_path_cleanups(session)


@event.listens_for(SessionLocal, "after_commit")
def _delete_scheduled_paths(session: Session) -> None:
    pending: set[Path] = session.info.pop(_PENDING_PATH_CLEANUPS_KEY, set())
    for path in pending:
        try:
            if path.is_symlink() or path.is_file():
                path.unlink(missing_ok=True)
            elif path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink(missing_ok=True)
        except OSError as error:
            logger.warning("Could not clean up path after database commit: %s: %s", path, error)


@event.listens_for(SessionLocal, "after_rollback")
def _clear_path_cleanups_after_rollback(session: Session) -> None:
    _clear_scheduled_path_cleanups(session)


@event.listens_for(SessionLocal, "after_soft_rollback")
def _clear_path_cleanups_after_soft_rollback(
    session: Session,
    _previous_transaction: object,
) -> None:
    _clear_scheduled_path_cleanups(session)


def init_database() -> None:
    from backend.db import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _apply_schema_migrations(engine)
    _seed_default_stem_selection(engine)
