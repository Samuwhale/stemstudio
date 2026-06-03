from __future__ import annotations

import sys

import uvicorn

from backend.api.main import app
from backend.core.config import get_runtime_settings
from backend.db.session import init_database


def _health_check() -> None:
    settings = get_runtime_settings()
    settings.ensure_directories()
    init_database()
    print(f"StemStudio API runtime ready at {settings.api_host}:{settings.api_port}")


def main() -> None:
    if "--health-check" in sys.argv:
        _health_check()
        return

    settings = get_runtime_settings()
    uvicorn.run(
        app,
        host=settings.api_host,
        port=settings.api_port,
        log_level="info",
        proxy_headers=False,
    )


if __name__ == "__main__":
    main()
