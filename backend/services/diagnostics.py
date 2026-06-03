from __future__ import annotations

import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

from sqlalchemy.orm import Session

from backend.adapters.ffmpeg import FfmpegAdapter
from backend.adapters.separator import AudioSeparatorAdapter
from backend.adapters.youtube import YtDlpAdapter
from backend.core.binaries import find_binary
from backend.core.config import RuntimeSettings
from backend.schemas.system import BinaryStatusResponse, DiagnosticsResponse
from backend.services.settings import get_or_create_settings
from backend.services.storage import configured_storage_paths, validate_storage_paths


def collect_diagnostics(session: Session, runtime_settings: RuntimeSettings) -> DiagnosticsResponse:
    application_settings = get_or_create_settings(session, runtime_settings)
    storage_paths = configured_storage_paths(runtime_settings, application_settings)
    storage_issues: list[str] = []
    storage_ready = True
    try:
        validate_storage_paths(storage_paths)
        storage_paths.ensure_directories()
    except (OSError, ValueError) as error:
        storage_ready = False
        storage_issues.append(f"Storage settings need attention: {error}")

    ffmpeg_adapter = FfmpegAdapter(runtime_settings)
    separator_adapter = AudioSeparatorAdapter(runtime_settings)
    yt_dlp_adapter = YtDlpAdapter(runtime_settings)

    binary_rows = [
        _build_binary_status(
            name="ffmpeg",
            binary=runtime_settings.ffmpeg_binary,
            required=True,
            version_provider=ffmpeg_adapter.version,
        ),
        _build_binary_status(
            name="ffprobe",
            binary=runtime_settings.ffprobe_binary,
            required=True,
            version_provider=ffmpeg_adapter.version,
        ),
        _build_binary_status(
            name="audio-separator",
            binary=runtime_settings.separator_binary,
            required=False,
            version_provider=lambda _path: separator_adapter.version(),
        ),
        _build_binary_status(
            name="yt-dlp",
            binary=runtime_settings.yt_dlp_binary,
            required=False,
            version_provider=lambda _path: yt_dlp_adapter.version(),
        ),
    ]

    available_by_name = {row.name: row.available for row in binary_rows}
    env_info = separator_adapter.env_info() if available_by_name["audio-separator"] else None
    acceleration = "cpu"
    if env_info:
        lowered = env_info.lower()
        if "cudaexecutionprovider" in lowered:
            acceleration = "cuda"
        elif "coremlexecutionprovider" in lowered:
            acceleration = "coreml"
        elif "cpuexecutionprovider" in lowered:
            acceleration = "cpu"

    required_names = {"ffmpeg", "ffprobe"}
    core_ready = all(available_by_name[name] for name in required_names)
    app_ready = core_ready and storage_ready
    separation_ready = app_ready and available_by_name["audio-separator"]
    url_import_ready = app_ready and available_by_name["yt-dlp"]

    issues = [
        f"Required binary missing or not runnable: {row.name}"
        for row in binary_rows
        if row.required and not row.available
    ]
    issues.extend(storage_issues)
    if core_ready and not available_by_name["audio-separator"]:
        issues.append("Stem creation unavailable: audio-separator is missing or not runnable.")
    if not storage_paths.outputs_dir.exists():
        issues.append("Configured output directory does not exist.")
    if not storage_paths.model_cache_dir.exists():
        issues.append("Configured processing cache directory does not exist.")

    disk_usage_path = _nearest_existing_path(storage_paths.outputs_dir)
    try:
        disk_usage = shutil.disk_usage(disk_usage_path)
        free_disk_gb = round(disk_usage.free / (1024**3), 2)
    except OSError:
        issues.append(f"Could not read free disk space for the output directory: {storage_paths.outputs_dir}")
        free_disk_gb = 0.0

    return DiagnosticsResponse(
        app_ready=app_ready,
        separation_ready=separation_ready,
        acceleration=acceleration,
        free_disk_gb=free_disk_gb,
        binaries=binary_rows,
        issues=issues,
        data_directories={
            "uploads": str(storage_paths.uploads_dir),
            "outputs": str(storage_paths.outputs_dir),
            "exports": str(storage_paths.exports_dir),
            "temp": str(storage_paths.temp_dir),
            "model_cache": str(storage_paths.model_cache_dir),
        },
        url_import_ready=url_import_ready,
    )


def _nearest_existing_path(path: Path) -> Path:
    current = path
    while not current.exists() and current.parent != current:
        current = current.parent
    return current


def _build_binary_status(
    name: str,
    binary: str,
    required: bool,
    version_provider: Callable[[str], str | None],
) -> BinaryStatusResponse:
    resolved_path = find_binary(binary)
    version = None
    if resolved_path is not None:
        try:
            version = version_provider(resolved_path)
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
            version = None
    return BinaryStatusResponse(
        name=name,
        required=required,
        available=version is not None,
        path=resolved_path,
        version=version,
    )
