from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from backend.core.constants import (
    DEFAULT_QUALITY,
    DEFAULT_STEMS,
    PUBLIC_STEMS,
    QUALITY_OPTIONS,
    STEM_OPTIONS,
    STEM_QUALITY_KEYS,
    build_pipeline_definition,
)
from backend.core.stems import stem_display_label
from backend.db.models import AppSettings, Run
from backend.schemas.tracks import (
    QualityOptionResponse,
    RunProcessingConfigRequest,
    RunProcessingConfigResponse,
    StemOptionResponse,
)
from backend.schemas.validation import normalize_mp3_bitrate

DEFAULT_MP3_BITRATE = "320k"


@dataclass(frozen=True)
class ProcessingStepConfig:
    key: str
    model_filename: str
    output_stems: tuple[str, ...]
    required_stems: tuple[str, ...]
    source_stem: str | None = None


@dataclass(frozen=True)
class ProcessingConfig:
    requested_stems: tuple[str, ...]
    visible_stems: tuple[str, ...]
    generated_stems: tuple[str, ...]
    quality: str
    label: str
    pipeline_key: str
    steps: tuple[ProcessingStepConfig, ...]

    def to_metadata(self) -> dict[str, Any]:
        return {
            "requested_stems": list(self.requested_stems),
            "visible_stems": list(self.visible_stems),
            "generated_stems": list(self.generated_stems),
            "quality": self.quality,
            "pipeline_key": self.pipeline_key,
            "steps": [
                {
                    "key": step.key,
                    "model_filename": step.model_filename,
                    "output_stems": list(step.output_stems),
                    "required_stems": list(step.required_stems),
                    "source_stem": step.source_stem,
                }
                for step in self.steps
            ],
        }


def normalize_export_bitrate(value: str | None, fallback: str = DEFAULT_MP3_BITRATE) -> str:
    try:
        return normalize_mp3_bitrate(value)
    except ValueError:
        return fallback


def normalize_stem_selection(stems: list[str] | tuple[str, ...] | None) -> tuple[str, ...]:
    allowed = set(PUBLIC_STEMS)
    seen: set[str] = set()
    normalized: list[str] = []
    for stem in stems or DEFAULT_STEMS:
        cleaned = stem.strip() if isinstance(stem, str) else ""
        if not cleaned:
            continue
        if cleaned not in allowed:
            raise ValueError(f"Unknown stem '{cleaned}'.")
        if cleaned in seen:
            continue
        seen.add(cleaned)
        normalized.append(cleaned)
    if not normalized:
        raise ValueError("Choose at least one stem.")
    return tuple(stem for stem in PUBLIC_STEMS if stem in seen)


def normalize_quality(quality: str | None) -> str:
    cleaned = (quality or DEFAULT_QUALITY).strip().lower()
    if cleaned not in STEM_QUALITY_KEYS:
        raise ValueError(f"Unknown quality '{cleaned}'.")
    return cleaned


def default_stem_selection_metadata() -> dict[str, Any]:
    return {"stems": list(DEFAULT_STEMS), "quality": DEFAULT_QUALITY}


def settings_default_selection(settings: AppSettings) -> dict[str, Any]:
    raw = settings.default_stem_selection
    if isinstance(raw, dict):
        try:
            stems = list(normalize_stem_selection(raw.get("stems")))
            quality = normalize_quality(str(raw.get("quality") or DEFAULT_QUALITY))
            return {"stems": stems, "quality": quality}
        except ValueError:
            return default_stem_selection_metadata()
    return default_stem_selection_metadata()


def selection_label(stems: tuple[str, ...]) -> str:
    return " + ".join(stem_display_label(stem) for stem in stems)


def build_processing_config(stems: tuple[str, ...], quality: str) -> ProcessingConfig:
    normalized_stems = normalize_stem_selection(stems)
    normalized_quality = normalize_quality(quality)
    pipeline = build_pipeline_definition(
        requested_stems=normalized_stems,
        quality=normalized_quality,
    )
    return ProcessingConfig(
        requested_stems=normalized_stems,
        visible_stems=normalized_stems,
        generated_stems=pipeline.generated_stems,
        quality=pipeline.quality,
        label=selection_label(normalized_stems),
        pipeline_key=pipeline.key,
        steps=tuple(
            ProcessingStepConfig(
                key=step.key,
                model_filename=step.model_filename,
                output_stems=step.output_stems,
                required_stems=step.required_stems,
                source_stem=step.source_stem,
            )
            for step in pipeline.steps
        ),
    )


def build_processing_from_request(
    request: RunProcessingConfigRequest | None,
    settings: AppSettings,
) -> ProcessingConfig:
    if request is None:
        selection = settings_default_selection(settings)
        return build_processing_config(tuple(selection["stems"]), selection["quality"])
    return build_processing_config(tuple(request.stems), request.quality)


def resolve_run_processing(run: Run) -> ProcessingConfig:
    metadata = run.metadata_json if isinstance(run.metadata_json, dict) else {}
    processing = metadata.get("processing")
    if isinstance(processing, dict):
        try:
            config = build_processing_config(
                tuple(processing.get("visible_stems") or processing.get("requested_stems") or DEFAULT_STEMS),
                str(processing.get("quality") or DEFAULT_QUALITY),
            )
        except ValueError:
            config = build_processing_config(DEFAULT_STEMS, DEFAULT_QUALITY)
        generated = processing.get("generated_stems")
        if isinstance(generated, list):
            generated_stems = tuple(
                stem for stem in PUBLIC_STEMS if stem in {item for item in generated if isinstance(item, str)}
            )
            return ProcessingConfig(
                requested_stems=config.requested_stems,
                visible_stems=config.visible_stems,
                generated_stems=generated_stems or config.generated_stems,
                quality=config.quality,
                label=config.label,
                pipeline_key=str(processing.get("pipeline_key") or config.pipeline_key),
                steps=config.steps,
            )
        return config

    return build_processing_config(DEFAULT_STEMS, DEFAULT_QUALITY)


def serialize_processing_config(config: ProcessingConfig) -> RunProcessingConfigResponse:
    return RunProcessingConfigResponse(
        stems=list(config.visible_stems),
        quality=config.quality,
        label=config.label,
    )


def serialize_stem_options() -> list[StemOptionResponse]:
    return [
        StemOptionResponse(name=option.name, label=option.label)
        for option in STEM_OPTIONS
    ]


def serialize_quality_options() -> list[QualityOptionResponse]:
    return [
        QualityOptionResponse(key=option.key, label=option.label)
        for option in QUALITY_OPTIONS
    ]


def update_visible_stems(run: Run, stems: tuple[str, ...]) -> None:
    metadata = dict(run.metadata_json if isinstance(run.metadata_json, dict) else {})
    processing_raw = metadata.get("processing")
    processing = dict(processing_raw if isinstance(processing_raw, dict) else {})
    visible = normalize_stem_selection(stems)
    generated = processing.get("generated_stems")
    if isinstance(generated, list):
        generated_set = {item for item in generated if isinstance(item, str)}
        missing = [stem for stem in visible if stem not in generated_set]
        if missing:
            raise ValueError(f"Run has not produced: {', '.join(missing)}.")
    processing["requested_stems"] = list(visible)
    processing["visible_stems"] = list(visible)
    metadata["processing"] = processing
    run.metadata_json = metadata
