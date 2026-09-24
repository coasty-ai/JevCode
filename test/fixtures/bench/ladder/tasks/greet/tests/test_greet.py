from src.greet import greet


def test_named():
    assert greet(" Ann ") == "Hello, Ann!"


def test_none():
    assert greet(None) == "Hello, world!"


def test_empty():
    assert greet("   ") == "Hello, world!"
