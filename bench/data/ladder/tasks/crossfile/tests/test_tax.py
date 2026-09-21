from src.tax import TAX_FREE_BELOW, TAX_RATE, rate_for, tax_for, with_tax


def test_small_orders_are_tax_free():
    assert tax_for(9.99) == 0.0
    assert tax_for(0) == 0.0


def test_threshold_is_taxed():
    assert tax_for(TAX_FREE_BELOW) == 0.8


def test_tax_rounds_to_cents():
    assert tax_for(33.33) == 2.67


def test_with_tax():
    assert with_tax(10.0) == 10.8
    assert with_tax(5.0) == 5.0


def test_rate_for():
    assert rate_for("or") == 0.0
    assert rate_for("CA") == 0.0725
    assert rate_for("TX") == TAX_RATE
