"""Small text statistics used by the report generator."""

from __future__ import annotations

import re
from typing import Dict, List, Sequence, Tuple

_WORD = re.compile(r"[A-Za-z']+")
_SENTENCE_END = re.compile(r"[.!?]+")


def words(text: str) -> List[str]:
    """Lower-cased alphabetic tokens in order of appearance."""
    return [w.lower() for w in _WORD.findall(text)]


def word_frequencies(text: str) -> Dict[str, int]:
    """Map each word to the number of times it occurs."""
    freqs: Dict[str, int] = {}
    for w in words(text):
        freqs[w] = freqs.get(w, 0) + 1
    return freqs


def most_common(freqs: Dict[str, int], k: int) -> List[Tuple[str, int]]:
    """The `k` most frequent (word, count) pairs, highest count first."""
    ranked = sorted(freqs.items(), key=lambda kv: kv[1])
    return ranked[:k]


def ngrams(tokens: Sequence[str], n: int) -> List[Tuple[str, ...]]:
    """Every contiguous run of `n` tokens, in order; empty if there are fewer than `n`."""
    if n < 1:
        raise ValueError("n must be at least 1")
    return [tuple(tokens[i:i + n]) for i in range(len(tokens) - n)]


def sentence_count(text: str) -> int:
    """Number of non-empty sentences separated by '.', '!' or '?'."""
    return len([p for p in _SENTENCE_END.split(text) if p.strip()])


def average_word_length(text: str) -> float:
    ws = words(text)
    if not ws:
        return 0.0
    return sum(len(w) for w in ws) / len(ws)


def truncate(text: str, limit: int, ellipsis: str = "...") -> str:
    """Cut `text` to at most `limit` characters, ending with `ellipsis` if it was cut."""
    if len(text) <= limit:
        return text
    return text[: max(0, limit - len(ellipsis))] + ellipsis


def summary(text: str) -> Dict[str, float]:
    """Headline numbers for a document."""
    return {
        "words": len(words(text)),
        "sentences": sentence_count(text),
        "unique": len(word_frequencies(text)),
        "avg_word_length": round(average_word_length(text), 2),
    }
