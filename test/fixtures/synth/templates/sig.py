def helper(a):
    return a + scale


def caller(v):
    return helper(v) * 2


def other(v):
    total = helper(v, 2)
    return total
