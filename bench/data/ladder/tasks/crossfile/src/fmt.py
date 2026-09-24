"""Formatting helpers for invoices."""

from __future__ import annotations

# option keys accepted by money() and currency_code()
SYMBOL_KEY = "symbol"
CURRENCY_KEY = "currency"


def money(value: float, **options: str) -> str:
    """'$1,234.50'; pass symbol='€' for another currency symbol; negative values get a leading '-'."""
    symbol = options.get(CURRENCY_KEY, "$")
    sign = "-" if value < 0 else ""
    return f"{sign}{symbol}{abs(value):,.2f}"


def currency_code(**options: str) -> str:
    """The ISO code passed as currency='eur', upper-cased; 'USD' when absent."""
    return options.get(CURRENCY_KEY, "USD").upper()


def percent(rate: float) -> str:
    """0.075 -> '7.5%'; whole percentages drop the decimals ('20%')."""
    pct = rate * 100
    return f"{pct:.0f}%" if pct == int(pct) else f"{pct:.1f}%"


def pad_right(text: str, width: int) -> str:
    return text if len(text) >= width else text + " " * (width - len(text))


def pad_left(text: str, width: int) -> str:
    return text if len(text) >= width else " " * (width - len(text)) + text


def rule(width: int, char: str = "-") -> str:
    return char * width
