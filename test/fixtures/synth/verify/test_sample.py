import pytest

def gcd(a, b):
    if b == 0:
        return a
    return gcd(a % b, b)

def test_pass_one():
    assert gcd(17, 0) == 17

def test_fail_eq():
    assert 1 + 1 == 3

def test_fail_str():
    got = "hello world"
    assert got == "hello there"

@pytest.mark.parametrize("a,b,exp", [(13, 13, 13), (20, 100, 20)])
def test_param(a, b, exp):
    assert gcd(a, b) == exp

@pytest.mark.skip(reason="not now")
def test_skipped():
    assert False

@pytest.mark.xfail(reason="known")
def test_xfail():
    assert False

@pytest.mark.xfail(reason="known")
def test_xpass():
    assert True

def test_error_fixture(missing_fixture):
    assert True

def test_raises():
    raise ValueError("boom 42")

def test_in_list():
    assert 3 in [1, 2]

def test_dict():
    assert {"a": 1, "b": [1, 2]} == {"a": 1, "b": [1, 3]}

def test_bench_style_message():
    actual = None
    assert actual == 13, "gcd(13, 13) -> None, expected 13"

def test_long_values():
    assert list(range(30)) == list(range(29)) + [99]

class TestGroup:
    def test_method(self):
        assert "x" * 3 == "xxx"
    def test_method_fail(self):
        assert [1, 2] == [1, 3]
