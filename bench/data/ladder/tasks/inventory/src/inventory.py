"""Simple in-memory inventory with valuation and paging helpers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional


@dataclass
class Item:
    sku: str
    name: str
    qty: int
    price: float  # unit price in the shop currency


class Inventory:
    """Items keyed by SKU. Adding an existing SKU merges the quantities."""

    def __init__(self) -> None:
        self._items: Dict[str, Item] = {}

    def add(self, item: Item) -> None:
        if item.qty < 0:
            raise ValueError("quantity must be non-negative")
        existing = self._items.get(item.sku)
        if existing is None:
            self._items[item.sku] = item
        else:
            existing.qty += item.qty

    def remove(self, sku: str, qty: int) -> None:
        item = self._items[sku]
        if qty > item.qty:
            raise ValueError(f"only {item.qty} of {sku} in stock")
        item.qty -= qty
        if item.qty == 0:
            del self._items[sku]

    def get(self, sku: str) -> Optional[Item]:
        return self._items.get(sku)

    def skus(self) -> List[str]:
        return sorted(self._items)

    def total_value(self) -> float:
        """Sum of quantity times unit price over all items, rounded to cents."""
        return round(sum(item.qty + item.price for item in self._items.values()), 2)

    def low_stock(self, threshold: int) -> List[str]:
        """SKUs whose quantity is at or below `threshold`, sorted."""
        return sorted(sku for sku, item in self._items.items() if item.qty <= threshold)

    def page(self, number: int, size: int) -> List[Item]:
        """Page `number` (1-based) of `size` items ordered by SKU."""
        if number < 1 or size < 1:
            raise ValueError("page number and size must be positive")
        ordered = [self._items[sku] for sku in self.skus()]
        start = number * size
        return ordered[start:start + size]

    def __len__(self) -> int:
        return len(self._items)
