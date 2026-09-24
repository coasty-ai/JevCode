import os
from typing import List, Optional as Opt
from . import sibling
from ..pkg.mod import *
import a.b.c as abc, d.e


CONST = 0x_FF + 0b1010 + 0o17 + 1_000_000 + 3.14e-2 + .5 + 1. + 2j + 1.5J
WEIRD = 1if CONST else 2


@decorator
@ns.deco(arg=1, *args, **kw)
def decorated(x, /, y=2, *rest, z: int = 3, **opts) -> "Opt[int]":
    """Docstring with ''' triple quotes''' inside
    and a second line."""
    total = x + y \
        + z
    items = [a for a in rest if a
             if a % 2 == 0]  # comment inside brackets
    squares = {n: n ** 2 for n in range(10)}
    uniq = {n for n in items}
    if (m := len(items)) > 0 and 0 < m <= 10 < 100:
        total **= 2
        total //= 3
        total -= 1
    fn = lambda a, b=1: a + b
    s = f"{x!r:>{y}} {total:.2f} {{literal}} {fn(1, 2)} {'inner'} {f'{z}'}"
    raw = r"\d+\." + rb"\x00" + b"bytes" + u"unicode" + Rb"\n" + FR"{x}\n"
    multi = """line one
    line "two" with quotes
    ''' not the end
    """
    cont = "abc\
def"
    print(s, raw, multi, cont, sep=", ")
    return total if total is not None else ...


class Thing(Base, metaclass=Meta):
    count: int = 0
    _cache = {}

    def __init__(self, name, value=None):
        self.name = name
        self.value = value or []
        Thing.count += 1

    @property
    def size(self):
        return len(self.value)

    async def fetch(self, url):
        async with session.get(url) as resp:
            data = await resp.json()
        async for chunk in resp:
            yield chunk


def tabbed(seq):
	for λ in seq:
		if λ: continue
		else:
			break
	naïve = 1; other = 2
	return naïve, other


def control(x):
    global CONST
    try:
        pass
    except (ValueError, TypeError) as err:
        raise RuntimeError("bad") from err
    except Exception:
        raise
    else:
        del x
    finally:
        assert x is not None, "x must be set"
    with open("f") as fh, open("g") as gh:
        nonlocal_dummy = fh.read() + gh.read()
    while True:
        if not x: break
        x = x[1:] if x[0] == "a" else x[:-1]
    def inner():
        nonlocal x
        x = ~x @ x | x & x ^ x << 1 >> 2
    return inner
