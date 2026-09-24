from calc import clamp, mean, median, running_max


def test_mean():
    assert mean([1, 2, 3, 6]) == 3


def test_median_odd():
    assert median([5, 1, 3]) == 3


def test_median_even():
    assert median([1, 2, 3, 4]) == 2.5


def test_median_empty():
    try:
        median([])
    except ValueError:
        return
    assert False, "expected ValueError"


def test_clamp():
    assert clamp(5, 0, 3) == 3
    assert clamp(-1, 0, 3) == 0
    assert clamp(2, 0, 3) == 2


def test_running_max():
    print("noise on stdout must not corrupt the result")
    assert running_max([1, 3, 2, 5]) == [1, 3, 3, 5]


def test_boom():
    raise RuntimeError("boom")


class TestMedian:
    def test_single(self):
        assert median([7]) == 7
