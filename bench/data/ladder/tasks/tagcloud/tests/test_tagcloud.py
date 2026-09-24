import pytest

from src.tagcloud import Post, co_occurrence, normalise, post_tags, posts_with, tag_counts, top_tags, weights

POSTS = [
    Post("Intro", ["Python", "tutorial"]),
    Post("Types", ["python", " Type Hints ", "Python"]),
    Post("Async", ["python", "asyncio", "tutorial"]),
    Post("Untagged", []),
]


def test_normalise():
    assert normalise(" Machine  Learning ") == "machine-learning"


def test_post_tags_dedupes_and_sorts():
    assert post_tags(POSTS[1]) == ["python", "type-hints"]


def test_tag_counts():
    assert tag_counts(POSTS) == {"python": 3, "tutorial": 2, "type-hints": 1, "asyncio": 1}


def test_tag_counts_empty():
    assert tag_counts([]) == {}


def test_top_tags():
    assert top_tags(POSTS, 2) == [("python", 3), ("tutorial", 2)]


def test_weights():
    assert weights({"a": 1, "b": 3, "c": 5}, levels=5) == {"a": 1, "b": 3, "c": 5}
    assert weights({"a": 2, "b": 2}) == {"a": 5, "b": 5}
    assert weights({}) == {}


def test_weights_invalid_levels():
    with pytest.raises(ValueError):
        weights({"a": 1}, levels=0)


def test_co_occurrence():
    pairs = co_occurrence(POSTS)
    assert pairs[("python", "tutorial")] == 2
    assert pairs[("asyncio", "python")] == 1
    assert ("tutorial", "python") not in pairs


def test_posts_with():
    assert posts_with(POSTS, "Tutorial") == ["Intro", "Async"]
