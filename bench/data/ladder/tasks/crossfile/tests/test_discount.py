from src.discount import apply_discount, best_code, is_valid_code


def test_is_valid_code_case_insensitive():
    assert is_valid_code("welcome10")
    assert not is_valid_code("NOPE")


def test_no_code_or_unknown_code_leaves_amount():
    assert apply_discount(50.0, "") == 50.0
    assert apply_discount(50.0, "NOPE") == 50.0


def test_percentage_codes():
    assert apply_discount(100.0, "WELCOME10") == 90.0
    assert apply_discount(30.0, "half") == 15.0


def test_flat_code():
    assert apply_discount(20.0, "FLAT5") == 15.0


def test_flat_code_never_negative():
    assert apply_discount(3.0, "FLAT5") == 0.0


def test_best_code():
    assert best_code(100.0, ["WELCOME10", "FLAT5"]) == "WELCOME10"
    assert best_code(8.0, ["WELCOME10", "FLAT5"]) == "FLAT5"
    assert best_code(8.0, ["NOPE"]) == ""
