from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class RuntimeSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="STEMSTUDIO_",
        case_sensitive=False,
    )

    api_host: str = "127.0.0.1"
    api_port: int = 8000
    frontend_origin: str = "http://127.0.0.1:5173"
    data_root: Path = Field(default=Path("data"))
    database_path: Path = Field(default=Path("data/app.db"))
    uploads_dir: Path = Field(default=Path("data/uploads"))
    output_dir: Path = Field(default=Path("data/outputs"))
    exports_dir: Path = Field(default=Path("data/exports"))
    temp_dir: Path = Field(default=Path("data/tmp"))
    logs_dir: Path = Field(default=Path("data/logs"))
    model_cache_dir: Path = Field(default=Path("data/cache/models"))
    worker_poll_interval_seconds: int = 3
    ffmpeg_binary: str = "ffmpeg"
    ffprobe_binary: str = "ffprobe"
    separator_binary: str = "audio-separator"
    yt_dlp_binary: str = "yt-dlp"

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
