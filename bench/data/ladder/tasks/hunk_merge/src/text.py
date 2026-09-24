"""Text into lines and back."""

from __future__ import annotations

from typing import List, Sequence, Tuple


def to_lines(text: str) -> List[str]:
    """The text as a list of lines, with no trailing empty line for a final newline."""
    if text == "":
        return []
    body = text[:-1] if text.endswith("\n") else text
    return body.split("\n")


def to_text(lines: Sequence[str]) -> str:
    """The lines back as text; a non-empty file ends in a newline."""
    if not lines:
        return ""
    return "\n".join(lines) + "\n"


def numbered(lines: Sequence[str]) -> List[Tuple[int, str]]:
    """(1-based line number, line) for every line."""
    return list(enumerate(lines, start=1))
