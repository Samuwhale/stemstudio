from __future__ import annotations

import hashlib
import json
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from backend.adapters.ffmpeg import FfmpegAdapter, FfmpegCommandError
from backend.core.config import RuntimeSettings
from backend.core.stems import export_stem_kind, stem_display_label
from backend.db.models import Run, RunArtifact, RunStatus
from backend.services.metrics import compute_artifact_metrics
from backend.services.tracks import (
    add_run_artifact,
    mixable_artifacts,
)


MIX_WAV_KIND = "export-mix-wav"
MIX_MP3_KIND = "export-mix-mp3"


@dataclass(frozen=True)
class _ResolvedStem:
    artifact: RunArtifact
    gain_db: float
    muted: bool
    mtime_ns: int


def _mix_entries(run: Run) -> dict[str, dict[str, float | bool]]:
    raw = run.mix_json or {}
    stems = raw.get("stems") if isinstance(raw, dict) else None
    if not isinstance(stems, list):
        return {}
    table: dict[str, dict[str, float | bool]] = {}
    for entry in stems:
        if not isinstance(entry, dict):
            continue
        artifact_id = entry.get("artifact_id")
        if not isinstance(artifact_id, str):
            continue
        try:
            gain_db = float(entry.get("gain_db") or 0.0)
        except (TypeError, ValueError):
            gain_db = 0.0
        table[artifact_id] = {
            "gain_db": gain_db,
            "muted": bool(entry.get("muted") or False),
        }
    return table


def resolve_mix(run: Run) -> list[_ResolvedStem]:
    entries = _mix_entries(run)
    resolved: list[_ResolvedStem] = []
    for artifact in mixable_artifacts(run):
        entry = entries.get(artifact.id, {"gain_db": 0.0, "muted": False})
        try:
            mtime_ns = Path(artifact.path).stat().st_mtime_ns
        except OSError:
            mtime_ns = 0
        resolved.append(
            _ResolvedStem(
                artifact=artifact,
                gain_db=float(entry["gain_db"]),
                muted=bool(entry["muted"]),
                mtime_ns=mtime_ns,
            )
        )
    resolved.sort(key=lambda stem: stem.artifact.id)
    return resolved


def mix_signature(run: Run, fmt: str, *, bitrate: str | None = None) -> str:
    """Signature that invalidates the cached mix when its inputs change.

    WAV renders depend only on stem files + per-stem gain/mute. MP3 also
    depends on the requested bitrate, so callers must pass it for "mp3".
    """
    payload: dict[str, object] = {
        "stems": [
            {
                "artifact_id": stem.artifact.id,
                "gain_db": round(stem.gain_db, 3),
                "muted": stem.muted,
                "mtime_ns": stem.mtime_ns,
            }
            for stem in resolve_mix(run)
        ],
    }
    if fmt == "mp3":
        if not bitrate:
            raise ValueError("bitrate is required when computing the mp3 mix signature.")
        payload["bitrate"] = bitrate
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _existing_mix_artifact(run: Run, kind: str) -> RunArtifact | None:
    return next((artifact for artifact in run.artifacts if artifact.kind == kind), None)


def _mix_label(fmt: str) -> str:
    return "Mixdown WAV" if fmt == "wav" else "Mixdown MP3"


def _mix_kind(fmt: str) -> str:
    return MIX_WAV_KIND if fmt == "wav" else MIX_MP3_KIND


def _positive_duration_seconds(value: Any, *, fallback: float = 0.0) -> float:
    try:
        duration = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(duration) or duration <= 0.0:
        return fallback
    return duration


def _run_ffmpeg_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError as error:
        label = Path(command[0]).name if command else "ffmpeg"
        raise FfmpegCommandError(f"Could not run {label}: {error}") from error


def _render_silence(ffmpeg_binary: str, duration_seconds: float, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    duration = max(0.1, _positive_duration_seconds(duration_seconds))
    completed = _run_ffmpeg_command(
        [
            ffmpeg_binary,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-t",
            f"{duration:.3f}",
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ],
    )
    if completed.returncode != 0:
        raise FfmpegCommandError(completed.stderr.strip() or completed.stdout.strip())


def _render_mix_wav(
    ffmpeg: FfmpegAdapter,
    active_stems: list[_ResolvedStem],
    output_path: Path,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    command: list[str] = [ffmpeg.ffmpeg_binary, "-y"]
    for stem in active_stems:
        command.extend(["-i", stem.artifact.path])

    filter_parts: list[str] = []
    for index, stem in enumerate(active_stems):
        filter_parts.append(f"[{index}:a]volume={stem.gain_db:.3f}dB[a{index}]")
    mix_inputs = "".join(f"[a{index}]" for index in range(len(active_stems)))
    filter_parts.append(
        f"{mix_inputs}amix=inputs={len(active_stems)}:normalize=0:duration=longest[out]"
    )
    filter_complex = ";".join(filter_parts)

    command.extend(
        [
            "-filter_complex",
            filter_complex,
            "-map",
            "[out]",
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ]
    )
    completed = _run_ffmpeg_command(command)
    if completed.returncode != 0:
        raise FfmpegCommandError(completed.stderr.strip() or completed.stdout.strip())


def _render_mix(
    ffmpeg: FfmpegAdapter,
    run: Run,
    stems: list[_ResolvedStem],
    wav_path: Path,
) -> None:
    active = [stem for stem in stems if not stem.muted]
    if not active:
        duration = 0.0
        for stem in stems:
            metrics = stem.artifact.metrics_json or {}
            candidate = metrics.get("duration_seconds") if isinstance(metrics, dict) else None
            duration = max(duration, _positive_duration_seconds(candidate))
        if duration <= 0.0 and run.track and run.track.duration_seconds:
            duration = _positive_duration_seconds(run.track.duration_seconds)
        _render_silence(ffmpeg.ffmpeg_binary, duration or 1.0, wav_path)
        return
    _render_mix_wav(ffmpeg, active, wav_path)


def _ensure_mix_wav_artifact(
    session: Session,
    runtime_settings: RuntimeSettings,
    run: Run,
) -> RunArtifact:
    if run.output_directory is None:
        raise ValueError("Run has no output directory; cannot render mix.")

    stems = resolve_mix(run)
    if not stems:
        raise ValueError("Run has no mixable stems.")

    wav_signature = mix_signature(run, "wav")
    existing_target = _existing_mix_artifact(run, MIX_WAV_KIND)
    if existing_target is not None:
        metrics = existing_target.metrics_json or {}
        if (
            isinstance(metrics, dict)
            and metrics.get("mix_signature") == wav_signature
            and Path(existing_target.path).is_file()
        ):
            return existing_target

    export_dir = Path(run.output_directory) / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    wav_path = export_dir / "mix.wav"

    ffmpeg = FfmpegAdapter(runtime_settings)
    _render_mix(ffmpeg, run, stems, wav_path)
    artifact = _upsert_mix_artifact(
        run,
        kind=MIX_WAV_KIND,
        label=_mix_label("wav"),
        format_name="WAV",
        path=wav_path,
        signature=wav_signature,
        ffmpeg=ffmpeg,
        existing=existing_target,
    )
    session.commit()
    return artifact


def ensure_worker_mix_wav(
    session: Session,
    runtime_settings: RuntimeSettings,
    run: Run,
) -> RunArtifact:
    """Internal worker helper for the canonical whole-run mix WAV.

    The processor writes this while the run is still in `exporting` so compare
    and preview surfaces have a stable whole-run artifact without reintroducing
    render-time MP3 work.
    """
    if run.status != RunStatus.exporting.value:
        raise ValueError("Worker mix WAV can only be rendered while the run is exporting.")
    return _ensure_mix_wav_artifact(session, runtime_settings, run)


def ensure_mix_render(
    session: Session,
    runtime_settings: RuntimeSettings,
    run: Run,
    fmt: str,
    *,
    bitrate: str | None = None,
) -> RunArtifact:
    if fmt not in {"wav", "mp3"}:
        raise ValueError(f"Unsupported mix format: {fmt}")
    if fmt == "mp3" and not bitrate:
        raise ValueError("bitrate is required when rendering an mp3 mix.")
    if run.status != RunStatus.completed.value:
        raise ValueError("Only completed runs can be mixed for export.")

    wav_artifact = _ensure_mix_wav_artifact(session, runtime_settings, run)
    if fmt == "wav":
        return wav_artifact

    assert bitrate is not None
    target_signature = mix_signature(run, "mp3", bitrate=bitrate)
    existing_target = _existing_mix_artifact(run, MIX_MP3_KIND)
    if existing_target is not None:
        metrics = existing_target.metrics_json or {}
        if (
            isinstance(metrics, dict)
            and metrics.get("mix_signature") == target_signature
            and Path(existing_target.path).is_file()
        ):
            return existing_target

    export_dir = Path(run.output_directory) / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    mp3_path = export_dir / "mix.mp3"
    wav_path = Path(wav_artifact.path)
    ffmpeg = FfmpegAdapter(runtime_settings)
    ffmpeg.convert_to_mp3(wav_path, mp3_path, bitrate)

    mp3_artifact = _upsert_mix_artifact(
        run,
        kind=MIX_MP3_KIND,
        label=_mix_label("mp3"),
        format_name="MP3",
        path=mp3_path,
        signature=target_signature,
        ffmpeg=ffmpeg,
        existing=existing_target,
    )
    session.commit()
    return mp3_artifact


def ensure_stem_mp3(
    session: Session,
    runtime_settings: RuntimeSettings,
    run: Run,
    stem_name: str,
    bitrate: str,
) -> RunArtifact:
    """Encode a stem MP3 from its rendered WAV on demand.

    Stem WAVs are produced at render time; MP3 encoding happens here so users
    can change bitrate without triggering a re-render. Re-encoding is cached by
    (stem, bitrate) via a signature stored in the artifact metrics.
    """
    if not bitrate:
        raise ValueError("bitrate is required to encode a stem mp3.")
    if run.status != RunStatus.completed.value:
        raise ValueError("Only completed runs can be exported.")
    if run.output_directory is None:
        raise ValueError("Run has no output directory; cannot encode stem.")

    wav_kind = export_stem_kind(stem_name, fmt="wav")
    mp3_kind = export_stem_kind(stem_name, fmt="mp3")

    wav_artifact = next((a for a in run.artifacts if a.kind == wav_kind), None)
    if wav_artifact is None:
        raise ValueError(f"Run has no {stem_name} stem to encode.")
    wav_path = Path(wav_artifact.path)
    if not wav_path.is_file():
        raise ValueError(f"Stem WAV missing on disk for '{stem_name}'.")

    try:
        mtime_ns = wav_path.stat().st_mtime_ns
    except OSError:
        mtime_ns = 0
    signature = hashlib.sha256(
        json.dumps(
            {"wav_path": str(wav_path), "mtime_ns": mtime_ns, "bitrate": bitrate},
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    existing = next((a for a in run.artifacts if a.kind == mp3_kind), None)
    if existing is not None:
        metrics = existing.metrics_json or {}
        if (
            isinstance(metrics, dict)
            and metrics.get("encode_signature") == signature
            and Path(existing.path).is_file()
        ):
            return existing

    export_dir = Path(run.output_directory) / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    mp3_path = export_dir / f"{stem_name}.mp3"

    ffmpeg = FfmpegAdapter(runtime_settings)
    ffmpeg.convert_to_mp3(wav_path, mp3_path, bitrate)

    artifact = existing
    if artifact is None:
        artifact = add_run_artifact(
            run,
            kind=mp3_kind,
            label=f"{stem_display_label(stem_name)} MP3 export",
            format_name="MP3",
            path=mp3_path,
        )
    else:
        artifact.path = str(mp3_path.resolve())
        artifact.label = f"{stem_display_label(stem_name)} MP3 export"
        artifact.format = "MP3"

    metrics = compute_artifact_metrics(ffmpeg, artifact) or {}
    metrics["encode_signature"] = signature
    artifact.metrics_json = metrics
    session.commit()
    return artifact


def _upsert_mix_artifact(
    run: Run,
    *,
    kind: str,
    label: str,
    format_name: str,
    path: Path,
    signature: str,
    ffmpeg: FfmpegAdapter,
    existing: RunArtifact | None,
) -> RunArtifact:
    artifact = existing
    if artifact is None:
        artifact = add_run_artifact(
            run,
            kind=kind,
            label=label,
            format_name=format_name,
            path=path,
        )
    else:
        artifact.path = str(path.resolve())
        artifact.label = label
        artifact.format = format_name

    metrics = compute_artifact_metrics(ffmpeg, artifact) or {}
    metrics["mix_signature"] = signature
    artifact.metrics_json = metrics
    return artifact
