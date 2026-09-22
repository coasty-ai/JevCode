import pytest

from src.router import BadParameters, NoSuchRoute, Router

TABLE = [
    ("home", "/"),
    ("users", "/users"),
    ("user", "/users/<id>"),
    ("me", "/users/me"),
    ("user_posts", "/users/<id>/posts"),
    ("post", "/users/<id>/posts/<slug>"),
    ("anything", "/<a>/<b>"),
]
ROUTER = Router(TABLE)


def names_of(matches):
    return [match.route.name for match in matches]


def test_candidates_lists_every_match_in_table_order():
    assert names_of(ROUTER.candidates("/users/me")) == ["user", "me", "anything"]
    assert names_of(ROUTER.candidates("/users/42")) == ["user", "anything"]


def test_match_prefers_a_static_segment_over_a_placeholder():
    assert ROUTER.match("/users/me").route.name == "me"


def test_match_falls_back_to_the_placeholder_route():
    assert ROUTER.match("/users/42").route.name == "user"


def test_match_prefers_the_route_that_pins_down_the_most():
    assert ROUTER.match("/users/42/posts").route.name == "user_posts"
    assert ROUTER.match("/users").route.name == "users"


def test_match_captures_the_placeholder_values():
    assert ROUTER.match("/users/7/posts/hi").params == {"id": "7", "slug": "hi"}
    assert ROUTER.match("/users/me").params == {}


def test_match_of_the_root():
    assert ROUTER.match("/").route.name == "home"


def test_match_of_a_path_no_route_takes():
    assert ROUTER.match("/orders/9/lines/3/tax") is None


def test_match_breaks_a_tie_by_table_order():
    tied = Router([("left", "/<a>/b"), ("right", "/c/<d>")])
    assert tied.match("/c/b").route.name == "left"


def test_route_named_finds_a_route():
    assert ROUTER.route_named("post").pattern.text == "/users/<id>/posts/<slug>"


def test_route_named_refuses_an_unknown_name():
    with pytest.raises(NoSuchRoute):
        ROUTER.route_named("ghost")


def test_reverse_builds_a_path_from_the_placeholders():
    assert ROUTER.reverse("user", id="42") == "/users/42"
    assert ROUTER.reverse("post", id="7", slug="hi") == "/users/7/posts/hi"


def test_reverse_of_a_route_with_no_placeholders():
    assert ROUTER.reverse("users") == "/users"
    assert ROUTER.reverse("home") == "/"


def test_reverse_refuses_a_missing_parameter():
    with pytest.raises(BadParameters):
        ROUTER.reverse("post", id="7")


def test_reverse_refuses_an_unknown_parameter():
    with pytest.raises(BadParameters):
        ROUTER.reverse("user", id="42", page="2")


def test_reverse_refuses_a_parameter_on_a_route_that_takes_none():
    with pytest.raises(BadParameters):
        ROUTER.reverse("users", id="42")
