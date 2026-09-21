from src.fmt import currency_code, money, pad_left, pad_right, percent, rule


def test_money_default_symbol():
    assert money(1234.5) == "$1,234.50"
    assert money(0) == "$0.00"


def test_money_custom_symbol():
    assert money(2, symbol="€") == "€2.00"


def test_money_negative_with_symbol():
    assert money(-3.5, symbol="£") == "-£3.50"


def test_money_ignores_currency_option():
    # `currency` is the ISO-code option of currency_code(), never a symbol
    assert money(2, currency="€") == "$2.00"
    assert money(2, currency="EUR", symbol="€") == "€2.00"


def test_percent():
    assert percent(0.2) == "20%"
    assert percent(0.075) == "7.5%"


def test_pad():
    assert pad_right("ab", 4) == "ab  "
    assert pad_left("ab", 4) == "  ab"
    assert pad_left("abcde", 4) == "abcde"


def test_rule():
    assert rule(3) == "---"
    assert rule(2, "=") == "=="


def test_currency_code():
    assert currency_code(currency="eur") == "EUR"
    assert currency_code() == "USD"
