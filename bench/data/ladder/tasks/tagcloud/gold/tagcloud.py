"""Tag statistics for a blog: counts, cloud weights and co-occurrence."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from itertools import combinations
from typing import Dict, Iterable, List, Tuple


@dataclass
class Post:
    title: str
    tags: List[str] = field(default_factory=list)


def normalise(tag: str) -> str:
    """Trim, lower-case and hyphenate a tag: ' Machine  Learning ' -> 'machine-learning'."""
    return "-".join(tag.strip().lower().split())


def post_tags(post: Post) -> List[str]:
    """Sorted, de-duplicated, normalised tags of one post."""
    return sorted({normalise(t) for t in post.tags if t.strip()})


def tag_counts(posts: Iterable[Post]) -> Dict[str, int]:
    """How many posts carry each tag (a tag counts once per post)."""
    counts: Counter = Counter()
    for post in posts:
        counts.update(post_tags(post))
    return dict(counts)


def top_tags(posts: Iterable[Post], n: int) -> List[Tuple[str, int]]:
    """The `n` most used tags with their counts, most used first."""
    return Counter(tag_counts(posts)).most_common(n)


def weights(counts: Dict[str, int], levels: int = 5) -> Dict[str, int]:
    """Scale counts linearly onto 1..levels for a tag cloud."""
    if levels < 1:
        raise ValueError("levels must be at least 1")
    if not counts:
        return {}
    lo, hi = min(counts.values()), max(counts.values())
    if hi == lo:
        return {tag: levels for tag in counts}
    span = hi - lo
    return {tag: 1 + round((c - lo) / span * (levels - 1)) for tag, c in counts.items()}


def co_occurrence(posts: Iterable[Post]) -> Dict[Tuple[str, str], int]:
    """How often each (alphabetical) pair of tags appears on the same post."""
    pairs: Counter = Counter()
    for post in posts:
        pairs.update(combinations(post_tags(post), 2))
    return dict(pairs)


def posts_with(posts: Iterable[Post], tag: str) -> List[str]:
    """Titles of the posts carrying `tag`, in the order given."""
    wanted = normalise(tag)
    return [p.title for p in posts if wanted in post_tags(p)]
