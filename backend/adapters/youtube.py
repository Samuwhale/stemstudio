from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.core.binaries import resolve_binary
from backend.core.config import RuntimeSettings


class YouTubeImportError(RuntimeError):
    """Raised when yt-dlp cannot resolve or download a YouTube source."""


_VERSION_TIMEOUT_SECONDS = 5


@dataclass(frozen=True)
class ResolvedYouTubeItem:
    video_id: str
    source_url: str
    canonical_source_url: str
    title: str
    artist: str | None
    thumbnail_url: str | None
    duration_seconds: float | None


@dataclass(frozen=True)
class ResolvedYouTubeSource:
    source_kind: str
    source_url: str
    title: str
    items: tuple[ResolvedYouTubeItem, ...]


@dataclass(frozen=True)
class DownloadedYouTubeSource:
    source_path: Path
    source_filename: str


class YtDlpAdapter:
    def __init__(self, runtime_settings: RuntimeSettings):
        self.binary = resolve_binary(runtime_settings.yt_dlp_binary)
        self.cookies_file = (
            runtime_settings.yt_dlp_cookies_file.expanduser()
            if runtime_settings.yt_dlp_cookies_file
            else None
        )
        self.cookies_from_browser = (
            runtime_settings.yt_dlp_cookies_from_browser.strip()
            if runtime_settings.yt_dlp_cookies_from_browser
            else None
        )

    def resolve(self, source_url: str) -> ResolvedYouTubeSource:
        payload = self._run_json(
            [
                self.binary,
                "--dump-single-json",
                "--no-warnings",
                "--skip-download",
                *self._auth_args(),
                source_url,
            ]
        )

        source_kind = "playlist" if payload.get("_type") == "playlist" else "video"
        if source_kind == "playlist":
            entries = payload.get("entries") or []
            items = tuple(self._resolve_item(entry) for entry in entries if entry)
            if not items:
                raise YouTubeImportError("The playlist did not contain any importable YouTube videos.")
            title = str(payload.get("title") or "YouTube playlist")
        else:
            items = (self._resolve_item(payload),)
            title = items[0].title

        return ResolvedYouTubeSource(
            source_kind=source_kind,
            source_url=source_url.strip(),
            title=title,
            items=items,
        )

    def download(
        self,
        source_url: str,
        destination_dir: Path,
        filename_prefix: str,
    ) -> DownloadedYouTubeSource:
        destination_dir.mkdir(parents=True, exist_ok=True)
        output_template = destination_dir / (
            f"{filename_prefix}-%(id)s-%(title).80B.%(ext)s"
        )
        completed = self._run(
            [
                self.binary,
                "--no-warnings",
                "--no-playlist",
                "--restrict-filenames",
                "-f",
                "bestaudio/best",
                "-o",
                str(output_template),
                "--print",
                "after_move:filepath",
                *self._auth_args(),
                source_url,
            ]
        )
        resolved_path = self._extract_download_path(completed.stdout)
        if resolved_path is None or not resolved_path.exists():
            raise YouTubeImportError(
                "yt-dlp reported success but did not produce a downloadable source file."
            )

        return DownloadedYouTubeSource(
            source_path=resolved_path,
            source_filename=resolved_path.name,
        )

    def version(self) -> str | None:
        try:
            completed = subprocess.run(
                [self.binary, "--version"],
                capture_output=True,
                text=True,
                check=False,
                timeout=_VERSION_TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        if completed.returncode != 0:
            return None
        return next((line for line in completed.stdout.splitlines() if line.strip()), None)

    def _run_json(self, command: list[str]) -> dict[str, Any]:
        completed = self._run(command)
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise YouTubeImportError("yt-dlp returned unreadable metadata for the provided URL.") from error
        if not isinstance(payload, dict):
            raise YouTubeImportError("yt-dlp returned metadata in an unexpected format.")
        return payload

    def _run(self, command: list[str]) -> subprocess.CompletedProcess[str]:
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=False,
            )
        except FileNotFoundError as error:
            raise YouTubeImportError(f"Missing downloader binary '{self.binary}' on PATH.") from error
        except OSError as error:
            raise YouTubeImportError(f"Could not run downloader binary '{self.binary}': {error}") from error

        if completed.returncode != 0:
            raise YouTubeImportError(self._failure_message(completed.stderr, completed.stdout))
        return completed

    def _auth_args(self) -> list[str]:
        if self.cookies_file and self.cookies_from_browser:
            raise YouTubeImportError(
                "Configure either STEMSTUDIO_YT_DLP_COOKIES_FILE or "
                "STEMSTUDIO_YT_DLP_COOKIES_FROM_BROWSER, not both."
            )
        if self.cookies_file:
            resolved_cookies_file = self.cookies_file.resolve()
            if not resolved_cookies_file.is_file():
                raise YouTubeImportError(
                    f"Configured YouTube cookies file does not exist: {resolved_cookies_file}"
                )
            return ["--cookies", str(resolved_cookies_file)]
        if self.cookies_from_browser:
            return ["--cookies-from-browser", self.cookies_from_browser]
        return []

    def _failure_message(self, stderr: str, stdout: str) -> str:
        raw_message = stderr.strip() or stdout.strip() or "yt-dlp failed."
        lowered = raw_message.lower()
        auth_required = (
            "private video" in lowered
            or "sign in if you've been granted access" in lowered
            or "use --cookies-from-browser or --cookies" in lowered
        )
        if not auth_required:
            return raw_message
        if self.cookies_file or self.cookies_from_browser:
            return (
                "YouTube rejected the configured cookies. Refresh the browser login "
                "or cookies file, then try the import again."
            )
        return (
            "YouTube says this video or playlist needs a signed-in account. Configure "
            "STEMSTUDIO_YT_DLP_COOKIES_FROM_BROWSER with a browser name, or "
            "STEMSTUDIO_YT_DLP_COOKIES_FILE with a cookies.txt file, then try the import again."
        )

    @staticmethod
    def _canonical_video_url(video_id: str) -> str:
        return f"https://www.youtube.com/watch?v={video_id}"

    def _resolve_item(self, payload: dict[str, Any]) -> ResolvedYouTubeItem:
        video_id = str(payload.get("id") or "").strip()
        title = str(payload.get("title") or "").strip()
        if not video_id or not title:
            raise YouTubeImportError("yt-dlp returned a playlist entry without a stable video id or title.")

        canonical_source_url = str(payload.get("webpage_url") or self._canonical_video_url(video_id)).strip()
        source_url = canonical_source_url
        artist = payload.get("artist") or payload.get("uploader")
        duration_raw = payload.get("duration")
        try:
            duration_seconds = float(duration_raw) if duration_raw else None
        except (TypeError, ValueError):
            duration_seconds = None

        return ResolvedYouTubeItem(
            video_id=video_id,
            source_url=source_url,
            canonical_source_url=canonical_source_url,
            title=title,
            artist=str(artist).strip() if artist else None,
            thumbnail_url=payload.get("thumbnail"),
            duration_seconds=duration_seconds,
        )

    @staticmethod
    def _extract_download_path(stdout: str) -> Path | None:
        lines = [line.strip() for line in stdout.splitlines() if line.strip()]
        if not lines:
            return None
        return Path(lines[-1]).expanduser().resolve()
