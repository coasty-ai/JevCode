from src.invoice import Invoice, LineItem, render

ITEMS = [LineItem("Widget", 2, 10.0), LineItem("Gadget", 1, 5.0)]


def test_line_item_amount():
    assert LineItem("Widget", 3, 2.5).amount == 7.5


def test_subtotal():
    assert Invoice("Ann", ITEMS).subtotal() == 25.0


def test_tax_and_total():
    inv = Invoice("Ann", ITEMS)
    assert inv.discount() == 0.0
    assert inv.tax() == 2.0
    assert inv.total() == 27.0


def test_render_uses_invoice_currency():
    symbol = "€"
    lines = render(Invoice("Ann", ITEMS, currency=symbol, code="eur"), width=30).splitlines()
    assert lines[0] == "Invoice for Ann (EUR)"
    assert lines[1] == "2 x Widget" + " " * 14 + "€20.00"
    assert lines[-1] == "Total" + " " * 19 + "€27.00"


def test_render_default_currency_and_rule():
    lines = render(Invoice("Bob", [LineItem("Pen", 1, 1.5)]), width=30).splitlines()
    assert lines[0] == "Invoice for Bob (USD)"
    assert lines[1] == "1 x Pen" + " " * 18 + "$1.50"
    assert lines[2] == "-" * 30


def test_render_discount_line_uses_currency():
    symbol = "€"
    lines = render(Invoice("Cy", ITEMS, currency=symbol), width=30).splitlines()
    assert [line for line in lines if line.startswith("Discount")] == ["Discount" + " " * 17 + "€0.00"]
