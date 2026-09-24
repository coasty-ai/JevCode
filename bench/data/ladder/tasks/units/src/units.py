"""Parse and format human-friendly byte sizes and durations."""

from __future__ import annotations

from typing import Dict, List

# Sizes are binary (1 KB = 1024 B) and are returned in bytes.
SIZE_UNITS: Dict[str, int] = {"B": 1, "KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3, "TB": 1024 ** 4}
# Durations are returned in milliseconds.
DURATION_UNITS: Dict[str, int] = {"ms": 1, "s": 1000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}


def parse_size(text: str) -> int:
    """'10KB' -> 10240, '1.5 mb' -> 1572864, '512' -> 512. Case- and space-insensitive."""
    text = text.strip().upper().replace(" ", "")
    for unit in sorted(SIZE_UNITS, key=len, reverse=True):
        if text.endswith(unit):
            return int(float(text[: -len(unit)]) * SIZE_UNITS[unit])
    return int(text)


def parse_duration(text: str) -> int:
    """'250ms' -> 250, '1.5s' -> 1500, '2 H' -> 7200000, '90' -> 90. Case- and space-insensitive."""
    text = text.strip()
    number, unit = text[:-1], text[-1]
    return int(number) * DURATION_UNITS.get(unit, 1)


def format_size(n: int) -> str:
    """Largest unit that keeps the value >= 1, one decimal unless whole: 1536 -> '1.5 KB'."""
    if n < 0:
        raise ValueError("size must be non-negative")
    unit = "B"
    value = float(n)
    for name in ("KB", "MB", "GB", "TB"):
        if value < 1024:
            break
        value /= 1024
        unit = name
    return f"{int(value)} {unit}" if value == int(value) else f"{value:.1f} {unit}"


def format_duration(ms: int) -> str:
    """Largest whole units first: 90061001 -> '1d 1h 1m 1s 1ms'; 0 -> '0ms'."""
    if ms < 0:
        raise ValueError("duration must be non-negative")
    parts: List[str] = []
    for unit in ("d", "h", "m", "s", "ms"):
        size = DURATION_UNITS[unit]
        if ms >= size:
            parts.append(f"{ms // size}{unit}")
            ms %= size
    return " ".join(parts) or "0ms"


def total_size(texts: List[str]) -> int:
    return sum(parse_size(t) for t in texts)
