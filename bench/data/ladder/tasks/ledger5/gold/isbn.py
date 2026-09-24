"""ISBN helpers: normalisation, check digits, validation and ISBN-10 -> ISBN-13."""

from __future__ import annotations


def normalize(raw: str) -> str:
    """Strip hyphens and spaces and upper-case the check character."""
    return "".join(ch for ch in raw if ch not in "- ").upper()


def isbn10_check_digit(body: str) -> str:
    """The check character for the first nine digits of an ISBN-10 ('X' stands for 10)."""
    if len(body) != 9 or not body.isdigit():
        raise ValueError("body must be nine digits")
    total = sum((10 - i) * int(d) for i, d in enumerate(body))
    check = (11 - total % 11) % 11
    return "X" if check == 10 else str(check)


def is_valid_isbn10(raw: str) -> bool:
    isbn = normalize(raw)
    if len(isbn) != 10 or not isbn[:9].isdigit():
        return False
    return isbn10_check_digit(isbn[:9]) == isbn[9]


def isbn13_check_digit(body: str) -> str:
    """The check digit for the first twelve digits of an ISBN-13."""
    if len(body) != 12 or not body.isdigit():
        raise ValueError("body must be twelve digits")
    total = sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(body))
    return str((10 - total % 10) % 10)


def is_valid_isbn13(raw: str) -> bool:
    isbn = normalize(raw)
    if len(isbn) != 13 or not isbn.isdigit():
        return False
    return isbn13_check_digit(isbn[:12]) == isbn[12]


def to_isbn13(isbn10: str) -> str:
    """Convert a valid ISBN-10 to its ISBN-13 form (prefix 978, recomputed check digit)."""
    isbn = normalize(isbn10)
    if not is_valid_isbn10(isbn):
        raise ValueError(f"not a valid ISBN-10: {isbn10}")
    body = "978" + isbn[:9]
    return body + isbn13_check_digit(body)
