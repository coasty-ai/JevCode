"""Paths and route patterns broken into segments."""

from __future__ import annotations

from typing import List, Sequence


def split(path: str) -> List[str]:
    """The segments of a path. Leading, trailing and repeated slashes are not segments."""
    return [part for part in path.split("/") if part != ""]


def join(segments: Sequence[str]) -> str:
    """The segments back as an absolute path."""
    return "/" + "/".join(segments)
