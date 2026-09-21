from src.names import display, initials, key, surname


def test_key_collapses_whitespace_and_case():
    assert key("  Ada   Lovelace ") == "ada lovelace"
    assert key("ADA LOVELACE") == key("ada lovelace")


def test_initials():
    assert initials("Ada King Lovelace") == "AKL"
    assert initials("ada lovelace") == "AL"


def test_surname():
    assert surname("Ada King Lovelace") == "Lovelace"
    assert surname("Plato") == "Plato"
    assert surname("") == ""


def test_display():
    assert display("ada  lovelace ") == "Ada Lovelace"
    assert display("ALAN turing") == "ALAN Turing"


def test_key_is_stable_under_display():
    assert key(display("ada   LOVELACE")) == key("ada lovelace")
