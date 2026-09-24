from src.settings import Settings


def make() -> Settings:
    s = Settings({"name": " demo ", "port": "8080", "debug": "no"})
    s.set("debug", "yes")
    s.set("port", " 9090 ")
    return s


def test_raw_prefers_override():
    s = make()
    assert s.raw("port") == " 9090 "
    assert s.raw("name") == " demo "
    assert s.raw("missing") is None


def test_get_strips():
    assert make().get("name") == "demo"
    assert make().get("port") == "9090"


def test_get_missing_returns_default():
    assert make().get("missing") == ""
    assert make().get("missing", "fallback") == "fallback"


def test_get_missing_default_is_returned_as_given():
    assert make().get("missing", " keep ") == " keep "


def test_get_int():
    s = make()
    assert s.get_int("port") == 9090
    assert s.get_int("missing", 5) == 5


def test_get_bool():
    s = make()
    assert s.get_bool("debug") is True
    assert s.get_bool("missing") is False
    assert Settings({"x": "OFF"}).get_bool("x") is False


def test_keys():
    assert make().keys() == ["debug", "name", "port"]
