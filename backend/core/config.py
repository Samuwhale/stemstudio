from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_desktop_data_root() -> Path:
    return Path.home() / "Library" / "Application Support" / "StemStudio"


class RuntimeSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="STEMSTUDIO_",
        case_sensitive=False,
    )

    api_host: str = "127.0.0.1"
    api_port: int = 8000
    desktop_resources_dir: Path | None = None
    desktop_user_data_dir: Path | None = None
    desktop_api_token: str | None = None
    data_root: Path = Field(default_factory=_default_desktop_data_root)
    database_path: Path = Field(default_factory=lambda: _default_desktop_data_root() / "app.db")
    uploads_dir: Path = Field(default_factory=lambda: _default_desktop_data_root() / "uploads")
    output_dir: Path = Field(default_factory=lambda: _default_desktop_data_root() / "outputs")
    exports_dir: Path = Field(default_factory=lambda: _default_desktop_data_root() / "exports")
    temp_dir: Path = Field(default_factory=lambda: _default_desktop_data_root() / "tmp")
    logs_dir: Path = Field(default_factory=lambda: _default_desktop_data_root() / "logs")
    model_cache_dir: Path = Field(default_factory=lambda: _default_desktop_data_root() / "cache" / "models")
    worker_poll_interval_seconds: int = 3
    ffmpeg_binary: str = "ffmpeg"
    ffprobe_binary: str = "ffprobe"
    separator_binary: str = "audio-separator"
    yt_dlp_binary: str = "yt-dlp"
    yt_dlp_cookies_file: Path | None = None
    yt_dlp_cookies_from_browser: str | None = None

    @model_validator(mode="after")
    def apply_desktop_data_root(self) -> "RuntimeSettings":
        data_root = (self.desktop_user_data_dir or self.data_root).expanduser()
        self.data_root = data_root
        self.database_path = data_root / "app.db"
        self.uploads_dir = data_root / "uploads"
        self.output_dir = data_root / "outputs"
        self.exports_dir = data_root / "exports"
        self.temp_dir = data_root / "tmp"
        self.logs_dir = data_root / "logs"
        self.model_cache_dir = data_root / "cache" / "models"
        return self

    @property
    def cors_allow_origins(self) -> list[str]:
        return ["null"]

    def ensure_directories(self) -> None:
        for directory in (
            self.data_root,
            self.database_path.parent,
            self.uploads_dir,
            self.output_dir,
            self.exports_dir,
            self.temp_dir,
            self.logs_dir,
            self.model_cache_dir,
        ):
            directory.expanduser().mkdir(parents=True, exist_ok=True)

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.database_path.expanduser().resolve()}"


@lru_cache
def get_runtime_settings() -> RuntimeSettings:
    settings = RuntimeSettings()
    settings.ensure_directories()
    return settings
