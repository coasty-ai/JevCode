"""Grade-book helpers: letter grades, weighted averages and rankings."""

from __future__ import annotations

from typing import Dict, List, Sequence, Tuple

# (minimum score, letter); a score equal to the minimum earns that letter.
LETTER_BOUNDARIES: Sequence[Tuple[float, str]] = ((90, "A"), (80, "B"), (70, "C"), (60, "D"))


def letter_grade(score: float) -> str:
    """Map a 0-100 score to a letter; exactly 90 is an A and exactly 60 is a D."""
    if not 0 <= score <= 100:
        raise ValueError(f"score out of range: {score}")
    for minimum, letter in LETTER_BOUNDARIES:
        if score >= minimum:
            return letter
    return "F"


def weighted_average(scores: Sequence[float], weights: Sequence[float]) -> float:
    """Average of `scores` weighted by `weights`; the weights need not sum to 1."""
    if len(scores) != len(weights):
        raise ValueError("scores and weights must have the same length")
    if not weights or sum(weights) == 0:
        raise ValueError("weights must be non-empty and must not sum to zero")
    total = sum(s * w for s, w in zip(scores, weights))
    return total / sum(weights)


def student_average(scores: Sequence[float]) -> float:
    if not scores:
        raise ValueError("no scores")
    return sum(scores) / len(scores)


def class_average(gradebook: Dict[str, Sequence[float]]) -> float:
    """Mean of every student's average."""
    if not gradebook:
        raise ValueError("empty gradebook")
    return sum(student_average(s) for s in gradebook.values()) / len(gradebook)


def rank(gradebook: Dict[str, Sequence[float]]) -> List[Tuple[str, float]]:
    """(name, average) pairs, best first; ties broken by name."""
    pairs = [(name, student_average(s)) for name, s in gradebook.items()]
    return sorted(pairs, key=lambda p: (-p[1], p[0]))


def top_students(gradebook: Dict[str, Sequence[float]], n: int) -> List[str]:
    return [name for name, _ in rank(gradebook)[:n]]


def passing(gradebook: Dict[str, Sequence[float]], threshold: float = 60.0) -> List[str]:
    """Names of students whose average meets `threshold`, alphabetically."""
    return sorted(name for name, s in gradebook.items() if student_average(s) >= threshold)


def report(gradebook: Dict[str, Sequence[float]]) -> Dict[str, str]:
    """Letter grade per student."""
    return {name: letter_grade(student_average(s)) for name, s in gradebook.items()}
