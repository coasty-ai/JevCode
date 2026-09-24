"""String formatting primitives shared by the table renderer and the CLI."""

from __future__ import annotations


def pad(text: str, width: int, fill: str = " ") -> str:
    """Left-align `text` in a field `width` wide, padding on the right with `fill`."""
    if len(text) >= width:
        return text
    return text + fill * (width - len(text))


def pad_left(text: str, width: int, fill: str = " ") -> str:
    """Right-align `text` in a field `width` wide, padding on the left with `fill`."""
    if len(text) >= width:
        return text
    return fill * (width - len(text)) + text


def center(text: str, width: int, fill: str = " ") -> str:
    """Centre `text`; when the padding is odd the extra character goes on the right."""
    if len(text) >= width:
        return text
    total = width - len(text)
    left = total // 2
    return fill * left + text + fill * (total - left)


def truncate(text: str, width: int) -> str:
    """Cut `text` to `width` characters, ending in '...' when anything was removed."""
    if len(text) <= width:
        return text
    if width <= 3:
        return text[:width]
    return text[: width - 3] + "..."


def human_bytes(n: int) -> str:
    """1536 -> '1.5 KiB'; whole values drop the decimals ('2 MiB')."""
    if n < 0:
        raise ValueError("size must be non-negative")
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    value = float(n)
    unit = units[0]
    for unit in units:
        if value < 1024 or unit == units[-1]:
            break
        value /= 1024
    if value == int(value):
        return f"{int(value)} {unit}"
    return f"{value:.1f} {unit}"


def plural(count: int, singular: str, plural_form: str = "") -> str:
    """'1 file', '2 files', '3 boxes' (pass the plural when it is not just +s)."""
    word = singular if count == 1 else (plural_form or singular + "s")
    return f"{count} {word}"
