"""Parse `LEVEL message took 12ms` log lines into entries."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List


@dataclass(frozen=True)
class Entry:
    level: str
    msg: str
    ms: int


def parse_line(line: str) -> Entry:
    """'INFO start 12ms' -> Entry('INFO', 'start', 12); a line without a duration gets ms 0."""
    level, rest = line.strip().split(" ", 1)
    msg, _, took = rest.rpartition(" ")
    if took.endswith("ms") and took[:-2].isdigit():
        return Entry(level, msg, int(took[:-1]))
    return Entry(level, rest, 0)


def parse_lines(text: str) -> List[Entry]:
    """One Entry per non-blank line of `text`."""
    return [parse_line(line) for line in text.splitlines() if line.strip()]


def only(entries: List[Entry], level: str) -> List[Entry]:
    return [e for e in entries if e.level == level]
