import pytest

from src.pattern import Pattern, captures, is_parameter, more_specific, parameter_name, rank, specificity


def test_is_parameter_wants_both_brackets_and_a_name():
    assert is_parameter("<id>") is True
    assert is_parameter("users") is False
    assert is_parameter("<id") is False
    assert is_parameter("id>") is False
    assert is_parameter("<>") is False


def test_parameter_name_is_what_is_inside():
    assert parameter_name("<slug>") == "slug"
    with pytest.raises(ValueError):
        parameter_name("users")


def test_a_pattern_knows_its_segments_and_width():
    assert Pattern("/users/<id>/posts").segments() == ["users", "<id>", "posts"]
    assert Pattern("/users/<id>/posts").width() == 3
    assert Pattern("/").width() == 0


def test_a_pattern_lists_its_placeholder_names_in_order():
    assert Pattern("/users/<id>/posts/<slug>").names() == ["id", "slug"]
    assert Pattern("/users").names() == []


def test_specificity_counts_the_segments_that_are_pinned_down():
    assert specificity(Pattern("/a/b/c")) == 3
    assert specificity(Pattern("/users/<id>/posts")) == 2
    assert specificity(Pattern("/<a>/<b>")) == 0


def test_specificity_of_a_pattern_with_no_segments():
    assert specificity(Pattern("/")) == 0


def test_specificity_drops_when_a_segment_becomes_a_placeholder():
    assert specificity(Pattern("/x/y")) == 2
    assert specificity(Pattern("/x/<a>")) == 1


def test_more_specific_compares_two_patterns():
    assert more_specific(Pattern("/users/me"), Pattern("/users/<id>")) is True
    assert more_specific(Pattern("/users/<id>"), Pattern("/users/me")) is False
    assert more_specific(Pattern("/users/me"), Pattern("/posts/all")) is False


def test_rank_puts_the_most_specific_first():
    loose, middling, tight = Pattern("/<a>/<b>"), Pattern("/users/<id>"), Pattern("/users/me")
    assert rank([loose, tight, middling]) == [tight, middling, loose]


def test_captures_reads_the_placeholders():
    assert captures(Pattern("/users/<id>/posts/<slug>"), "/users/7/posts/hi") == {"id": "7", "slug": "hi"}


def test_captures_of_a_wholly_static_pattern_is_empty():
    assert captures(Pattern("/users/me"), "/users/me") == {}


def test_captures_is_none_when_a_static_segment_differs():
    assert captures(Pattern("/users/me"), "/users/42") is None


def test_captures_is_none_when_the_widths_differ():
    assert captures(Pattern("/users/<id>"), "/users") is None
    assert captures(Pattern("/users/<id>"), "/users/7/posts") is None
