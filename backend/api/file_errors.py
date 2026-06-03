from __future__ import annotations

from fastapi import HTTPException


def local_file_http_error(action: str, error: OSError) -> HTTPException:
    return HTTPException(
        status_code=400,
        detail=f"{action} failed while reading local files: {error}",
    )
