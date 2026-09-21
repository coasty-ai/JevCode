"""A roster of people: adding, finding, badges."""

from __future__ import annotations

from typing import List

from .names import display, initials, key


def has(roster: List[str], name: str) -> bool:
    wanted = key(name)
    return any(key(person) == wanted for person in roster)


def add(roster: List[str], name: str) -> List[str]:
    """Append `name` in display form unless someone with the same key is already listed."""
    if not has(roster, name):
        roster.append(display(name))
    return roster


def badge(name: str) -> str:
    """The first two initials: 'AL' for Ada Lovelace, 'AK' for Ada King Lovelace."""
    return initials(name)[:2]


def badges(roster: List[str]) -> List[str]:
    return [badge(person) for person in roster]
