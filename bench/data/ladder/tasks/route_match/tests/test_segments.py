from src.segments import join, split


def test_split_drops_the_slashes():
    assert split("/users/42/posts") == ["users", "42", "posts"]


def test_split_of_the_root_is_empty():
    assert split("/") == []
    assert split("") == []


def test_split_ignores_repeated_and_trailing_slashes():
    assert split("/users//42/") == ["users", "42"]


def test_join_makes_an_absolute_path():
    assert join(["users", "42"]) == "/users/42"
    assert join([]) == "/"
