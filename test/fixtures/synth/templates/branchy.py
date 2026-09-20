SIZE = {"kb": 1024, "mb": 1024 ** 2}
TIME = {"s": 1, "m": 60}


def scale(value, size_unit, time_unit):
    if size_unit in SIZE:
        factor = SIZE[size_unit]
        return value * factor
    return None
