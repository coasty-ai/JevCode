from datetime import date

from src.loans import FINE_CAP, Loan, can_renew, days_late, due_date, fine, is_overdue

D = date(2026, 3, 1)
DUE = date(2026, 3, 15)


def test_due_date_default_period():
    assert due_date(D) == DUE


def test_due_date_with_renewals():
    assert due_date(D, 2) == date(2026, 4, 12)
    assert Loan("Dune", D, 1).due == date(2026, 3, 29)


def test_overdue_after_due_date():
    assert is_overdue(DUE, date(2026, 3, 16))
    assert not is_overdue(DUE, date(2026, 3, 10))


def test_not_overdue_on_due_date():
    assert not is_overdue(DUE, DUE)


def test_days_late_never_negative():
    assert days_late(DUE, date(2026, 3, 10)) == 0
    assert days_late(DUE, date(2026, 3, 18)) == 3


def test_fine_zero_when_on_time():
    assert fine(DUE, DUE) == 0.0


def test_fine_per_day():
    assert fine(DUE, date(2026, 3, 19)) == 1.0


def test_fine_capped():
    assert fine(DUE, date(2026, 6, 1)) == FINE_CAP


def test_can_renew_limits():
    assert not can_renew(Loan("Dune", D, renewals=2), date(2026, 3, 2))
    assert can_renew(Loan("Dune", D), date(2026, 3, 2))
    assert not can_renew(Loan("Dune", D), date(2026, 3, 20))


def test_can_renew_on_due_date():
    assert can_renew(Loan("Dune", D), DUE)
