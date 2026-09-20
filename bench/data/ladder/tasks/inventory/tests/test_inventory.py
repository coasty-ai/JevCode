import pytest

from src.inventory import Inventory, Item


def stocked() -> Inventory:
    inv = Inventory()
    inv.add(Item("A1", "bolt", 2, 1.50))
    inv.add(Item("B2", "nut", 3, 2.00))
    inv.add(Item("C3", "washer", 10, 0.10))
    inv.add(Item("D4", "screw", 1, 0.75))
    inv.add(Item("E5", "hinge", 1, 5.00))
    return inv


def test_add_and_get():
    inv = Inventory()
    inv.add(Item("A1", "bolt", 2, 1.50))
    assert inv.get("A1").qty == 2
    assert inv.get("ZZ") is None
    assert len(inv) == 1


def test_add_merges_quantity():
    inv = Inventory()
    inv.add(Item("A1", "bolt", 2, 1.50))
    inv.add(Item("A1", "bolt", 5, 1.50))
    assert inv.get("A1").qty == 7
    assert len(inv) == 1


def test_remove_deletes_when_empty():
    inv = Inventory()
    inv.add(Item("A1", "bolt", 2, 1.50))
    inv.remove("A1", 2)
    assert inv.get("A1") is None


def test_remove_too_many_raises():
    inv = Inventory()
    inv.add(Item("A1", "bolt", 2, 1.50))
    with pytest.raises(ValueError):
        inv.remove("A1", 3)


def test_total_value():
    inv = Inventory()
    inv.add(Item("A1", "bolt", 2, 1.50))
    inv.add(Item("B2", "nut", 3, 2.00))
    assert inv.total_value() == 9.0


def test_total_value_single_item():
    inv = Inventory()
    inv.add(Item("C3", "washer", 4, 0.25))
    assert inv.total_value() == 1.0


def test_low_stock():
    assert stocked().low_stock(2) == ["A1", "D4", "E5"]


def test_page_first():
    assert [i.sku for i in stocked().page(1, 2)] == ["A1", "B2"]


def test_page_last_partial():
    assert [i.sku for i in stocked().page(3, 2)] == ["E5"]


def test_page_invalid_raises():
    with pytest.raises(ValueError):
        stocked().page(0, 2)
