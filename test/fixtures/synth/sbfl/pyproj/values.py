"""Return-shape fixtures for call mode: generator, float, tuples, bool."""


def evens(n):
    for i in range(n):
        if i % 2 == 0:
            yield i


def half(x):
    return x / 2


def pairs(n):
    return [(i, i * i) for i in range(n)]


def is_positive(x):
    return x > 0
