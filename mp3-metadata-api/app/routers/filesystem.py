"""Filesystem browsing endpoints."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from app.schemas import BrowseResponse
from app.services.fs_browser import list_directory

router = APIRouter(tags=["filesystem"])


@router.get(
    "/api/browse",
    response_model=BrowseResponse,
    summary="List folders and audio files in a directory",
)
def browse_folder(
    path: Optional[str] = Query(
        default=None,
        description="Absolute path of the folder to browse. When omitted, the user's home folder is listed.",
    ),
    recursive: bool = Query(
        default=False,
        description="When true, audio files from all sub-folders are included.",
    ),
):
    """Browse *path* and return its sub-folders (for navigation) and audio files."""
    try:
        return list_directory(path, recursive=recursive)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (NotADirectoryError, PermissionError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
