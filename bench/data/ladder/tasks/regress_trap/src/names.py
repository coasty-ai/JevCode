"""Person names: comparison keys, initials, surnames and display form."""

from __future__ import annotations


def key(name: str) -> str:
    """Case-folded comparison key with collapsed whitespace; the name itself is never changed."""
    return " ".join(name.split()).casefold()


def initials(name: str) -> str:
    """One upper-case letter per word: 'Ada King Lovelace' -> 'AKL'."""
    return "".join(part[0].upper() for part in name.split())


def surname(name: str) -> str:
    """The last word of the name; '' for an empty name."""
    parts = name.split()
    return parts[0] if parts else ""


def display(name: str) -> str:
    """'ada  lovelace ' -> 'Ada Lovelace' (first letter of each word upper-cased, the rest kept)."""
    return " ".join(part[:1].upper() + part[1:] for part in name.split())
