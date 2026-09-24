"""Line items, totals and a plain-text rendering of an invoice."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

from .discount import apply_discount
from .fmt import CURRENCY_KEY, SYMBOL_KEY, currency_code, money, pad_left, pad_right, rule
from .tax import tax_for


@dataclass(frozen=True)
class LineItem:
    description: str
    quantity: int
    unit_price: float

    @property
    def amount(self) -> float:
        return round(self.quantity * self.unit_price, 2)


@dataclass
class Invoice:
    customer: str
    items: List[LineItem] = field(default_factory=list)
    currency: str = "$"
    code: str = "USD"
    discount_code: str = ""

    def subtotal(self) -> float:
        return round(sum(item.amount for item in self.items), 2)

    def discount(self) -> float:
        return round(self.subtotal() - apply_discount(self.subtotal(), self.discount_code), 2)

    def tax(self) -> float:
        return tax_for(self.subtotal() - self.discount())

    def total(self) -> float:
        return round(self.subtotal() - self.discount() + self.tax(), 2)


AMOUNT_WIDTH = 12


def render(invoice: Invoice, width: int = 40) -> str:
    """Customer line with the currency code, one line per item, a rule, then Subtotal / Discount / Tax / Total."""

    def cash(value: float) -> str:
        options = {CURRENCY_KEY: invoice.currency}
        return money(value, **options)

    code = currency_code(**{CURRENCY_KEY: invoice.code})
    lines = [f"Invoice for {invoice.customer} ({code})"]
    for item in invoice.items:
        left = pad_right(f"{item.quantity} x {item.description}", width - AMOUNT_WIDTH)
        lines.append(left + pad_left(cash(item.amount), AMOUNT_WIDTH))
    lines.append(rule(width))
    totals = (("Subtotal", invoice.subtotal()), ("Discount", -invoice.discount()), ("Tax", invoice.tax()), ("Total", invoice.total()))
    for label, value in totals:
        lines.append(pad_right(label, width - AMOUNT_WIDTH) + pad_left(cash(value), AMOUNT_WIDTH))
    return "\n".join(lines)
