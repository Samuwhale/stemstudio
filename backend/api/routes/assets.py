from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.api.dependencies import get_db_session
from backend.api.file_errors import local_file_http_error
from backend.db.models import RunArtifact

router = APIRouter(tags=["artifacts"])


@router.get("/artifacts/{artifact_id}")
def download_artifact(artifact_id: str, session: Session = Depends(get_db_session)) -> FileResponse:
    artifact = session.scalars(select(RunArtifact).where(RunArtifact.id == artifact_id)).first()
    if artifact is None:
        raise HTTPException(status_code=404, detail="Artifact not found.")

    artifact_path = Path(artifact.path)
    try:
        if not artifact_path.is_file():
            raise HTTPException(status_code=404, detail="Artifact file is missing on disk.")
    except OSError as error:
        raise local_file_http_error("Artifact download", error) from error

    return FileResponse(
        path=artifact_path,
        filename=artifact_path.name,
        content_disposition_type="attachment",
    )
