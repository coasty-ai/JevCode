import pytest

from src.account import Account, InsufficientFunds, richest, total_balance, transfer


def test_deposit_increases_balance():
    acct = Account("ann")
    acct.deposit(100)
    assert acct.balance == 100
    assert acct.history[-1].kind == "deposit"


def test_deposit_non_positive_raises():
    with pytest.raises(ValueError):
        Account("ann").deposit(0)


def test_withdraw_partial():
    acct = Account("ann", 100)
    acct.withdraw(30)
    assert acct.balance == 70


def test_withdraw_exact_balance_is_allowed():
    acct = Account("ann", 50)
    acct.withdraw(50)
    assert acct.balance == 0


def test_withdraw_over_balance_raises():
    acct = Account("ann", 50)
    with pytest.raises(InsufficientFunds):
        acct.withdraw(60)
    assert acct.balance == 50


def test_transfer_moves_money():
    a, b = Account("ann", 100), Account("bob", 10)
    transfer(a, b, 40)
    assert (a.balance, b.balance) == (60, 50)


def test_transfer_insufficient_leaves_both_unchanged():
    a, b = Account("ann", 10), Account("bob", 0)
    with pytest.raises(InsufficientFunds):
        transfer(a, b, 20)
    assert (a.balance, b.balance) == (10, 0)


def test_statement_numbering_starts_at_one():
    acct = Account("ann")
    acct.deposit(100)
    acct.withdraw(25)
    assert acct.statement() == ["1. +100.00 -> 100.00", "2. -25.00 -> 75.00"]


def test_statement_empty():
    assert Account("ann").statement() == []


def test_total_balance_and_richest():
    accounts = [Account("ann", 10.5), Account("bob", 20.25), Account("cid", 5)]
    assert total_balance(accounts) == 35.75
    assert richest(accounts).owner == "bob"
