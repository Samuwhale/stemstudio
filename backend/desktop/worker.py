from __future__ import annotations

import sys

from backend.core.config import get_runtime_settings
from backend.db.session import init_database
from backend.workers.runner import main as run_worker


def _health_check() -> None:
    settings = get_runtime_settings()
    settings.ensure_directories()
    init_database()
    print("StemStudio worker runtime ready")


def main() -> None:
    if "--health-check" in sys.argv:
        _health_check()
        return

    run_worker()


if __name__ == "__main__":
    main()
