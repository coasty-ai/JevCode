"""A small bank-account ledger: deposits, withdrawals, transfers, statements."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, List


class InsufficientFunds(ValueError):
    """Raised when a withdrawal exceeds the available balance."""


@dataclass
class Entry:
    kind: str  # "deposit" or "withdraw"
    amount: float
    balance_after: float


@dataclass
class Account:
    owner: str
    balance: float = 0.0
    history: List[Entry] = field(default_factory=list)

    def deposit(self, amount: float) -> None:
        if amount <= 0:
            raise ValueError("deposit must be positive")
        self.balance += amount
        self.history.append(Entry("deposit", amount, self.balance))

    def withdraw(self, amount: float) -> None:
        """Withdraw any positive amount up to and including the full balance."""
        if amount <= 0:
            raise ValueError("withdrawal must be positive")
        if amount > self.balance:
            raise InsufficientFunds(f"{self.owner} has only {self.balance:.2f}")
        self.balance -= amount
        self.history.append(Entry("withdraw", amount, self.balance))

    def statement(self) -> List[str]:
        """One line per entry, oldest first, numbered from 1."""
        lines: List[str] = []
        for number, entry in enumerate(self.history, 1):
            sign = "+" if entry.kind == "deposit" else "-"
            lines.append(f"{number}. {sign}{entry.amount:.2f} -> {entry.balance_after:.2f}")
        return lines


def transfer(src: Account, dst: Account, amount: float) -> None:
    """Move `amount` from `src` to `dst`; neither account changes if `src` lacks funds."""
    src.withdraw(amount)
    dst.deposit(amount)


def total_balance(accounts: Iterable[Account]) -> float:
    return round(sum(a.balance for a in accounts), 2)


def richest(accounts: Iterable[Account]) -> Account:
    """The account with the highest balance; the first one on ties."""
    accounts = list(accounts)
    if not accounts:
        raise ValueError("no accounts")
    return max(accounts, key=lambda a: a.balance)
