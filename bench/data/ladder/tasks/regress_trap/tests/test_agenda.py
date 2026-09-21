from src.agenda import Item, clashing, on_day, total_days

ITEMS = [Item("Sprint", 1, 3), Item("Review", 3, 5), Item("Offsite", 8, 8)]


def test_on_day_first_day():
    assert on_day(ITEMS, 1) == ["Sprint"]


def test_on_day_includes_last_day():
    assert on_day(ITEMS, 3) == ["Sprint", "Review"]
    assert on_day(ITEMS, 5) == ["Review"]


def test_single_day_item_is_on_its_day():
    assert on_day(ITEMS, 8) == ["Offsite"]


def test_on_day_outside():
    assert on_day(ITEMS, 6) == []


def test_clashing_when_sharing_a_day():
    assert clashing(ITEMS) == [("Sprint", "Review")]


def test_total_days():
    assert total_days(ITEMS) == 3 + 3 + 1
