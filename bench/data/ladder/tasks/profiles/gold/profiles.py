"""Presentation helpers for user profiles."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class User:
    username: str
    full_name: str
    nickname: Optional[str] = None
    email: Optional[str] = None
    bio: Optional[str] = None


def display_name(user: User) -> str:
    """The nickname when the user set a non-blank one, otherwise the full name."""
    if user.nickname is None:
        return user.full_name
    nick = user.nickname.strip()
    return nick or user.full_name


def initials(user: User) -> str:
    """Upper-case first letters of the full name's parts: 'Ada Lovelace' -> 'AL'."""
    return "".join(part[0].upper() for part in user.full_name.split() if part)


def handle(user: User) -> str:
    return "@" + user.username.lower()


def mask_email(email: Optional[str]) -> str:
    """'ada@example.org' -> 'a***@example.org'; missing or malformed -> '(no email)'."""
    if email is None or "@" not in email:
        return "(no email)"
    local, domain = email.split("@", 1)
    return local[0] + "***@" + domain


def short_bio(user: User, limit: int = 40) -> str:
    """The bio with whitespace collapsed and cut to `limit` characters; '' when unset."""
    if user.bio is None:
        return ""
    bio = " ".join(user.bio.split())
    if len(bio) <= limit:
        return bio
    return bio[: limit - 3].rstrip() + "..."


def card(user: User) -> str:
    """Multi-line profile card used by the CLI."""
    lines = [f"{display_name(user)} ({handle(user)})", mask_email(user.email)]
    bio = short_bio(user)
    if bio:
        lines.append(bio)
    return "\n".join(lines)
