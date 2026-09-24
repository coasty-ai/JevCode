import pytest

from src.textstats import (
    average_word_length,
    most_common,
    ngrams,
    sentence_count,
    summary,
    truncate,
    word_frequencies,
    words,
)


def test_words_lowercases_and_strips_punctuation():
    assert words("Hello, hello! It's me.") == ["hello", "hello", "it's", "me"]


def test_word_frequencies():
    assert word_frequencies("a b a c a b") == {"a": 3, "b": 2, "c": 1}


def test_most_common_orders_by_count():
    assert most_common({"a": 3, "b": 1, "c": 2}, 2) == [("a", 3), ("c", 2)]


def test_most_common_k_larger_than_vocabulary():
    assert most_common({"x": 2, "y": 1}, 5) == [("x", 2), ("y", 1)]


def test_ngrams_bigrams():
    assert ngrams(["a", "b", "c"], 2) == [("a", "b"), ("b", "c")]


def test_ngrams_n_equals_length_or_too_short():
    assert ngrams(["a", "b"], 2) == [("a", "b")]
    assert ngrams(["a"], 2) == []


def test_ngrams_invalid_n_raises():
    with pytest.raises(ValueError):
        ngrams(["a"], 0)


def test_sentence_count():
    assert sentence_count("One. Two! Three? ") == 3


def test_average_word_length_and_truncate():
    assert average_word_length("") == 0.0
    assert average_word_length("ab abcd") == 3.0
    assert truncate("hello world", 8) == "hello..."
    assert truncate("hi", 8) == "hi"


def test_summary():
    assert summary("Go. Go now!") == {"words": 3, "sentences": 2, "unique": 2, "avg_word_length": 2.33}
