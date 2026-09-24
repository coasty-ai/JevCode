"""Path and name normalisation for config files."""

from __future__ import annotations

import re
from typing import List


def slugify(name: str) -> str:
    """Lower-case; runs of characters other than a-z, 0-9, '.', '_' and '-' become one '-'."""
    return re.sub(r"[^a-z0-9._-]+", "-", name.strip().lower()).strip("-")


def split_path(path: str) -> List[str]:
    """Split on '/' or '\\' and drop empty and '.' segments."""
    return [part for part in re.split(r"[\\/]+", path) if part not in ("", ".")]


def join_path(parts: List[str]) -> str:
    return "/".join(parts)


def extension(path: str) -> str:
    """The lower-cased extension without its dot; '' when there is none."""
    parts = split_path(path)
    name = parts[-1] if parts else ""
    m = re.search(r"\.([A-Za-z0-9]+)$", name)
    return m.group(1).lower() if m else ""


def with_extension(path: str, ext: str) -> str:
    """`path` with its extension replaced by (or given) `ext`; unchanged when it already has it."""
    current = extension(path)
    if current == ext.lower():
        return path
    base = path[: -len(current) - 1] if current else path
    return f"{base}.{ext.lower()}"
