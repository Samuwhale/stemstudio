import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.api.dependencies import get_db_session, get_settings_dependency
from backend.api.file_errors import local_file_http_error
from backend.core.config import RuntimeSettings
from backend.schemas.system import (
    DiagnosticsResponse,
    RevealFolderKind,
    RevealFolderRequest,
    RevealFolderResponse,
)
from backend.services.diagnostics import collect_diagnostics
from backend.services.exports import export_job_path
from backend.services.settings import get_or_create_settings
from backend.services.storage import resolve_storage_paths
from backend.services.tracks import get_track, track_output_root

router = APIRouter(tags=["system"])


def _command_error_detail(stderr: str, fallback: str) -> str:
    detail = " ".join(line.strip() for line in stderr.splitlines() if line.strip())
    if not detail:
        return fallback
    if len(detail) <= 240:
        return detail
    return f"{detail[:237]}..."


@router.get("/health")
def healthcheck() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/diagnostics", response_model=DiagnosticsResponse)
def diagnostics(
    session: Session = Depends(get_db_session),
    runtime_settings: RuntimeSettings = Depends(get_settings_dependency),
) -> DiagnosticsResponse:
    try:
        return collect_diagnostics(session, runtime_settings)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except OSError as error:
        raise local_file_http_error("Diagnostics", error) from error


def _resolve_reveal_target(
    payload: RevealFolderRequest,
    session: Session,
    runtime_settings: RuntimeSettings,
) -> tuple[Path, bool]:
    """Resolve the filesystem target to reveal. Returns (path, is_file)."""
    settings = get_or_create_settings(session, runtime_settings)
    storage_paths = resolve_storage_paths(runtime_settings, settings)
    if payload.kind == RevealFolderKind.exports:
        return storage_paths.exports_dir, False
    if payload.kind == RevealFolderKind.outputs:
        return storage_paths.outputs_dir, False
    if payload.kind == RevealFolderKind.bundle:
        if not payload.job_id:
            raise HTTPException(status_code=400, detail="job_id is required to reveal an export download.")
        try:
            return export_job_path(session, runtime_settings, payload.job_id), True
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    if not payload.track_id:
        raise HTTPException(status_code=400, detail="track_id is required for this folder kind.")
    track = get_track(session, payload.track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found.")
    return track_output_root(track, storage_paths.outputs_dir), False


def _open_path(path: Path, is_file: bool) -> None:
    if sys.platform == "darwin":
        # `open -R` selects the item in Finder when the target is a file.
        args = ["open", "-R", str(path)] if is_file else ["open", str(path)]
    elif sys.platform.startswith("linux"):
        target = path.parent if is_file else path
        args = ["xdg-open", str(target)]
    else:
        raise HTTPException(
            status_code=501,
            detail="Opening folders is supported on macOS and Linux for this local tool.",
        )

    try:
        completed = subprocess.run(
            args,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=501,
            detail=f"Could not find the folder opener command: {args[0]}",
        ) from error
    except OSError as error:
        raise HTTPException(
            status_code=502,
            detail=f"Could not run the folder opener command: {error}",
        ) from error
    if completed.returncode != 0:
        detail = _command_error_detail(completed.stderr, f"{args[0]} exited with code {completed.returncode}.")
        raise HTTPException(status_code=502, detail=f"Could not open the folder: {detail}")


@router.post("/system/reveal", response_model=RevealFolderResponse)
def reveal_folder(
    payload: RevealFolderRequest,
    session: Session = Depends(get_db_session),
    runtime_settings: RuntimeSettings = Depends(get_settings_dependency),
) -> RevealFolderResponse:
    try:
        path, is_file = _resolve_reveal_target(payload, session, runtime_settings)
        path = path.resolve()
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"Path does not exist yet: {path}")
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except OSError as error:
        raise local_file_http_error("Reveal folder", error) from error

    _open_path(path, is_file)
    return RevealFolderResponse(path=str(path))
