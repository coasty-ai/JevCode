from src.paths import extension, join_path, slugify, split_path, with_extension


def test_slugify():
    assert slugify("  My Config File! ") == "my-config-file"
    assert slugify("a__b.c") == "a__b.c"


def test_split_path():
    assert split_path("etc/./app//config.toml") == ["etc", "app", "config.toml"]
    assert split_path("C:\\app\\x.ini") == ["C:", "app", "x.ini"]


def test_join_path():
    assert join_path(["etc", "app"]) == "etc/app"
    assert join_path([]) == ""


def test_extension():
    assert extension("etc/app/config.TOML") == "toml"
    assert extension("Makefile") == ""
    assert extension("") == ""


def test_with_extension():
    assert with_extension("config.yml", "yaml") == "config.yaml"
    assert with_extension("config", "toml") == "config.toml"
    assert with_extension("a.toml", "TOML") == "a.toml"
