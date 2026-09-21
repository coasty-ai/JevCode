from datetime import date, timedelta

import pytest

from src.filters import attention
from src.model import Task
from src.render import board
from src.stats import summary

TODAY = date(2026, 5, 10)


def day(offset: int) -> date:
    return TODAY + timedelta(days=offset)


LONG = "A very long task title that will not fit"

ATTENTION_CASES = {
    "a_only": ([Task("Today", due=day(0)), Task("Yesterday", due=day(-1))], ["Yesterday", "Today"]),
    "b_only": ([Task("Week", due=day(7)), Task("Later", due=day(8))], ["Week"]),
    "both": ([Task("Today", due=day(0)), Task("Yesterday", due=day(-1)), Task("Week", due=day(7)), Task("Done", due=day(-3), done=True)], ["Yesterday", "Today", "Week"]),
}

BOARD_CASES = {
    "c_only": ([Task("Undated"), Task("Soon", due=day(1)), Task("Later", due=day(2))], ["[ ] Soon (medium)", "[ ] Later (medium)", "[ ] Undated (medium)"]),
    "d_only": ([Task(LONG, 1, due=day(1))], ["[ ] A very long task titl... (high)"]),
    "both": ([Task("Undated"), Task(LONG, 1, due=day(1))], ["[ ] A very long task titl... (high)", "[ ] Undated (medium)"]),
}

SUMMARY_CASES = {
    "e_only": ([Task("a", 2, done=True), Task("b", 2, done=True), Task("c", 2)], {"completion": 67, "avg_priority": 2.0, "count": 3}),
    "f_only": ([Task("a", 1, done=True), Task("b", 2)], {"completion": 50, "avg_priority": 1.5, "count": 2}),
    "both": ([Task("a", 1, done=True), Task("b", 2, done=True), Task("c", 2)], {"completion": 67, "avg_priority": 1.7, "count": 3}),
}


@pytest.mark.parametrize("case", sorted(ATTENTION_CASES))
def test_attention(case):
    tasks, expected = ATTENTION_CASES[case]
    assert attention(tasks, TODAY) == expected


@pytest.mark.parametrize("case", sorted(BOARD_CASES))
def test_board(case):
    tasks, expected = BOARD_CASES[case]
    assert board(tasks, width=24) == expected


@pytest.mark.parametrize("case", sorted(SUMMARY_CASES))
def test_summary(case):
    tasks, expected = SUMMARY_CASES[case]
    assert summary(tasks) == expected


def test_attention_empty():
    assert attention([], TODAY) == []


def test_board_and_summary_empty():
    assert board([]) == []
    assert summary([]) == {"completion": 0, "avg_priority": 0.0, "count": 0}
