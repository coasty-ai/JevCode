from src.slots import can_book, free_minutes, is_busy, minutes, slot

BUSY = [slot("09:00", "10:00"), slot("13:30", "14:00")]


def test_minutes_and_slot():
    assert minutes("09:05") == 545
    assert slot("09:00", "10:00") == (540, 600)


def test_is_busy_inside():
    assert is_busy(BUSY, 540)
    assert is_busy(BUSY, 599)


def test_end_minute_is_free():
    assert not is_busy(BUSY, 600)
    assert not is_busy(BUSY, 840)


def test_free_minutes():
    assert free_minutes(BUSY) == 1440 - 90
    assert free_minutes(BUSY, day=(540, 1080)) == 450


def test_can_book_touching_slot():
    assert can_book(BUSY, (600, 660))
    assert not can_book(BUSY, (590, 660))
