from src.search import highlight, rank, score, tokenize

TITLES = ["Programming Pearls", "Clean Code", "The Pragmatic Programmer", "The Art of Computer Programming"]


def test_tokenize_lowercases_and_splits():
    assert tokenize("Clean Code, 2nd ed.") == ["clean", "code", "2nd", "ed"]


def test_score_counts_distinct_query_words():
    assert score("Programming Pearls", "programming pearls pearls") == 2
    assert score("Clean Code", "programming") == 0


def test_rank_filters_zero_scores():
    assert rank(TITLES, "clean") == [("Clean Code", 1)]


def test_rank_best_first():
    # input order is Pearls, Pragmatic, Art: the best title must move to the front, the tie keeps its order
    assert rank(TITLES, "the art of programming") == [
        ("The Art of Computer Programming", 4),
        ("Programming Pearls", 1),
        ("The Pragmatic Programmer", 1),
    ]


def test_rank_two_levels():
    assert [t for t, _ in rank(["one", "three", "one two"], "one two")] == ["one two", "one"]


def test_rank_ties_keep_input_order():
    assert rank(["B is here", "A is here"], "here") == [("B is here", 1), ("A is here", 1)]


def test_highlight_marks_query_words_case_preserved():
    assert highlight("Clean Code", "code") == "Clean *Code*"
    assert highlight("Code, clean code", "code") == "*Code*, clean *code*"
