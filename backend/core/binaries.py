import os
import shutil
from pathlib import Path


DESKTOP_RESOURCES_ENV = "STEMSTUDIO_DESKTOP_RESOURCES_DIR"


def _desktop_binary_dirs() -> tuple[Path, ...]:
    resources_dir = os.environ.get(DESKTOP_RESOURCES_ENV)
    if not resources_dir:
        return ()

    runtime_root = Path(resources_dir).expanduser()
    return (runtime_root / "bin",)


def _is_executable_file(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


def _iter_candidate_paths(binary_name: str) -> list[Path]:
    candidate_names = [binary_name]
    if os.name == "nt" and not binary_name.lower().endswith(".exe"):
        candidate_names.append(f"{binary_name}.exe")

    candidates: list[Path] = []
    seen: set[Path] = set()
    for directory in _desktop_binary_dirs():
        for candidate_name in candidate_names:
            candidate = (directory / candidate_name).expanduser()
            resolved_candidate = candidate.resolve()
            if resolved_candidate in seen or not _is_executable_file(resolved_candidate):
                continue
            seen.add(resolved_candidate)
            candidates.append(resolved_candidate)
    return candidates


def find_binary(binary_name: str) -> str | None:
    requested_path = Path(binary_name).expanduser()
    if requested_path.name != binary_name or requested_path.is_absolute():
        resolved_path = requested_path.resolve()
        return str(resolved_path) if _is_executable_file(resolved_path) else None

    for candidate in _iter_candidate_paths(binary_name):
        return str(candidate)

    resolved = shutil.which(binary_name)
    if resolved:
        return str(Path(resolved).resolve())

    return None


def resolve_binary(binary_name: str) -> str:
    return find_binary(binary_name) or binary_name
