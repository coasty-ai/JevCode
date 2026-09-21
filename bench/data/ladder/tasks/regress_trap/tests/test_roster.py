from src.roster import add, badge, badges, has


def test_add_uses_display_form():
    assert add([], "ada  lovelace") == ["Ada Lovelace"]


def test_add_skips_duplicates_by_key():
    assert add(["Ada Lovelace"], "ADA LOVELACE") == ["Ada Lovelace"]


def test_has():
    assert has(["Ada Lovelace"], "ada lovelace")
    assert not has(["Ada Lovelace"], "Alan Turing")


def test_badge_two_initials():
    assert badge("Ada Lovelace") == "AL"
    assert badge("Ada King Lovelace") == "AK"


def test_badges():
    assert badges(["Ada Lovelace", "Alan Turing"]) == ["AL", "AT"]


def test_badge_single_name():
    assert badge("Plato") == "P"
