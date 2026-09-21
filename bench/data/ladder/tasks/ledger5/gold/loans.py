"""Loan periods, overdue checks, fines and renewals."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

LOAN_DAYS = 14
FINE_PER_DAY = 0.25
FINE_CAP = 10.0


@dataclass
class Loan:
    title: str
    borrowed: date
    renewals: int = 0

    @property
    def due(self) -> date:
        return due_date(self.borrowed, self.renewals)


def due_date(borrowed: date, renewals: int = 0) -> date:
    """Each renewal extends the loan by another full period."""
    return borrowed + timedelta(days=LOAN_DAYS * (renewals + 1))


def is_overdue(due: date, today: date) -> bool:
    """A loan is overdue only after its due date; on the due date it is still fine."""
    return today > due


def days_late(due: date, returned: date) -> int:
    return max(0, (returned - due).days)


def fine(due: date, returned: date) -> float:
    """FINE_PER_DAY for every late day, capped at FINE_CAP."""
    return round(min(days_late(due, returned) * FINE_PER_DAY, FINE_CAP), 2)


def can_renew(loan: Loan, today: date, max_renewals: int = 2) -> bool:
    """Renewable while the loan is not overdue and under the renewal limit."""
    return loan.renewals < max_renewals and not is_overdue(loan.due, today)
