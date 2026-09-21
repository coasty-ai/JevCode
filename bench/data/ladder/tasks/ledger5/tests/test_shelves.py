import pytest

from src.shelves import label, labels, section_for, slot


def test_section_for_boundaries():
    assert section_for(0) == "Computer science"
    assert section_for(99.9) == "Computer science"
    assert section_for(100) == "Philosophy"
    assert section_for(999) == "History"


def test_section_for_out_of_range():
    with pytest.raises(ValueError):
        section_for(1000)


def test_slot():
    assert slot(0) == (0, 0)
    assert slot(19) == (0, 19)
    assert slot(20) == (1, 0)
    assert slot(7, per_shelf=3) == (2, 1)


def test_slot_negative():
    with pytest.raises(ValueError):
        slot(-1)


def test_label():
    assert label(0, 0) == "A1"
    assert label(2, 19) == "C20"


def test_labels_sequence():
    assert labels(5, per_shelf=2) == ["A1", "A2", "B1", "B2", "C1"]
