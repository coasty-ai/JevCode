import pytest

from src.shipping import cheapest_method, describe, methods, quote, shipping_cost


def test_methods_cheapest_first():
    assert methods() == ["standard", "express", "overnight"]


def test_standard_under_threshold():
    assert shipping_cost(20.0, "standard") == 4.99


def test_free_at_threshold():
    assert shipping_cost(50.0, "standard") == 0.0


def test_free_over_threshold_any_method():
    assert shipping_cost(120.0, "express") == 0.0
    assert shipping_cost(75.5, "overnight") == 0.0


def test_unknown_method_raises():
    with pytest.raises(ValueError):
        shipping_cost(20.0, "drone")


def test_remote_surcharge():
    assert shipping_cost(20.0, "standard", "AK") == 12.49


def test_remote_surcharge_still_applies_when_free():
    assert shipping_cost(60.0, "standard", "hi") == 7.5


def test_quote_total():
    assert quote(20.0, "standard") == {"subtotal": 20.0, "shipping": 4.99, "total": 24.99}


def test_cheapest_method():
    assert cheapest_method(20.0) == "standard"


def test_describe():
    assert describe(20.0, "standard") == "Standard shipping: $4.99"
    assert describe(80.0, "express") == "Express shipping: free"
