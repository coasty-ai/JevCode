import pytest

from src.stats import mean, median, mode, percentile, stdev, summary, variance, zscores


def test_mean():
    assert mean([2, 4, 6]) == 4


def test_mean_empty_raises():
    with pytest.raises(ValueError):
        mean([])


def test_median_odd_and_even():
    assert median([3, 1, 2]) == 2
    assert median([4, 1, 3, 2]) == 2.5


def test_median_empty_raises():
    with pytest.raises(ValueError):
        median([])


def test_mode_smallest_on_tie():
    assert mode([3, 1, 3, 1, 2]) == 1


def test_variance_and_stdev():
    assert variance([2, 4, 4, 4, 5, 5, 7, 9]) == 4.0
    assert stdev([2, 4, 4, 4, 5, 5, 7, 9]) == 2.0


def test_percentile():
    assert percentile([1, 2, 3, 4], 50) == 2.5
    assert percentile([1, 2, 3, 4], 0) == 1
    assert percentile([1, 2, 3, 4], 100) == 4


def test_zscores_constant_input():
    assert zscores([5, 5, 5]) == [0.0, 0.0, 0.0]


def test_summary():
    assert summary([1, 2, 3]) == {"median": 2, "mean": 2, "min": 1, "max": 3, "stdev": pytest.approx(0.8165, abs=1e-4)}


def test_summary_empty_raises():
    with pytest.raises(ValueError):
        summary([])
