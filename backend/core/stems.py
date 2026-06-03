from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


STEM_KIND_PREFIX = "stem:"
EXPORT_STEM_WAV_PREFIX = "stem-wav:"
EXPORT_STEM_MP3_PREFIX = "stem-mp3:"

# Stem names must be safe filenames, URL-safe, and stable DB identifiers.
# Underscores allowed so compound roles like "lead_vocals" / "backing_vocals"
# survive in stored kinds (stem:lead_vocals) and on the filesystem.
STEM_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,32}$")


@dataclass(frozen=True)
class StemRole:
    name: str
    label: str
    aliases: tuple[str, ...]
    display_order: int


# Canonical roles: their `name` is what we store; `aliases` are tokens we'll
# accept when parsing whatever filename the separator produced. Order matters
# for display and also drives preview / scrubber priority: instrumental first
# so the default scrubber peaks still line up with what users expect today.
CANONICAL_STEMS: tuple[StemRole, ...] = (
    StemRole("instrumental", "Instrumental", ("instrumental", "accompaniment", "no_vocals", "no vocals", "novocals"), 0),
    StemRole("vocals", "Vocals", ("vocals", "vocal", "voice"), 1),
    # audio-separator's UVR-BVE model emits filenames containing "(Lead Vocals)"
    # and "(Backing Vocals)" — spaces are preserved, not underscored — so the
    # space-forms below are load-bearing for the vocal-detail route. The
    # longer aliases (with spaces) must beat plain "vocals" during filename
    # token matching.
    StemRole("lead_vocals", "Lead vocals", ("lead vocals", "lead_vocals", "lead-vocals", "main vocals", "main_vocals", "leadvocals"), 2),
    StemRole("backing_vocals", "Backing vocals", ("backing vocals", "backing_vocals", "backing-vocals", "backup vocals", "backup_vocals", "backingvocals"), 3),
    StemRole("drums", "Drums", ("drums", "drum"), 4),
    StemRole("bass", "Bass", ("bass",), 5),
    StemRole("other", "Other", ("other", "others"), 6),
    StemRole("piano", "Piano", ("piano", "keys"), 7),
    StemRole("guitar", "Guitar", ("guitar", "guitars"), 8),
)


_ROLE_BY_NAME: dict[str, StemRole] = {role.name: role for role in CANONICAL_STEMS}
_PARENTHETICAL_RE = re.compile(r"[\[(]([^\])]+)[\])]")
_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _normalize_alias(value: str) -> str:
    return " ".join(_TOKEN_RE.findall(value.lower()))


_ROLE_BY_ALIAS: dict[str, StemRole] = {
    _normalize_alias(alias): role
    for role in CANONICAL_STEMS
    for alias in role.aliases
}

_MAX_ALIAS_WORDS = max(len(alias.split()) for alias in _ROLE_BY_ALIAS)

def detect_stem_name(filename: str, *, fallback_index: int) -> str:
    """Pick a canonical stem name for a separator output file.

    Separator output names include the source title, the stem role, and often
    the model name. Match explicit role markers first, then scan filename
    tokens from right to left so source titles like "Instrumental Version" do
    not override a later "(Vocals)" output marker. Unknown stems fall back to a
    stable `stem-NN` slug so they still flow through.
    """
    stem = Path(filename).stem
    for marker in reversed(_PARENTHETICAL_RE.findall(stem)):
        role = _ROLE_BY_ALIAS.get(_normalize_alias(marker))
        if role is not None:
            return role.name

    tokens = _TOKEN_RE.findall(stem.lower())
    for end in range(len(tokens), 0, -1):
        min_start = max(0, end - _MAX_ALIAS_WORDS)
        for start in range(min_start, end):
            role = _ROLE_BY_ALIAS.get(" ".join(tokens[start:end]))
            if role is not None:
                return role.name

    return f"stem-{fallback_index:02d}"


def stem_kind(stem_name: str) -> str:
    return f"{STEM_KIND_PREFIX}{stem_name}"


def stem_name_from_kind(kind: str) -> str | None:
    if kind.startswith(STEM_KIND_PREFIX):
        return kind[len(STEM_KIND_PREFIX):]
    return None


def is_stem_kind(kind: str) -> bool:
    return kind.startswith(STEM_KIND_PREFIX)


def stem_display_label(stem_name: str) -> str:
    role = _ROLE_BY_NAME.get(stem_name)
    if role is not None:
        return role.label
    # Unknown / model-specific stems: turn "stem-03" or "my-stem" into a tidy
    # human-readable label.
    return stem_name.replace("-", " ").replace("_", " ").strip().title() or stem_name


def stem_display_order(stem_name: str) -> int:
    role = _ROLE_BY_NAME.get(stem_name)
    if role is not None:
        return role.display_order
    # Unknown stems sort after all canonical ones, but keep stable order via
    # a hash of the name so the UI doesn't flicker between polls.
    return 1000 + sum(ord(ch) for ch in stem_name) % 1000


def validate_stem_name(stem_name: str) -> str:
    if not STEM_NAME_PATTERN.match(stem_name):
        raise ValueError(f"Invalid stem name: {stem_name!r}")
    return stem_name


def export_stem_kind(stem_name: str, *, fmt: str) -> str:
    if fmt == "wav":
        return f"{EXPORT_STEM_WAV_PREFIX}{stem_name}"
    if fmt == "mp3":
        return f"{EXPORT_STEM_MP3_PREFIX}{stem_name}"
    raise ValueError(f"Unsupported stem export format: {fmt}")


def parse_export_stem_kind(value: str) -> tuple[str, str] | None:
    """Return (fmt, stem_name) for stem-wav/stem-mp3 values, else None."""
    if value.startswith(EXPORT_STEM_WAV_PREFIX):
        return "wav", value[len(EXPORT_STEM_WAV_PREFIX):]
    if value.startswith(EXPORT_STEM_MP3_PREFIX):
        return "mp3", value[len(EXPORT_STEM_MP3_PREFIX):]
    return None


__all__ = [
    "CANONICAL_STEMS",
    "EXPORT_STEM_MP3_PREFIX",
    "EXPORT_STEM_WAV_PREFIX",
    "STEM_KIND_PREFIX",
    "StemRole",
    "detect_stem_name",
    "export_stem_kind",
    "is_stem_kind",
    "parse_export_stem_kind",
    "stem_display_label",
    "stem_display_order",
    "stem_kind",
    "stem_name_from_kind",
    "validate_stem_name",
]
