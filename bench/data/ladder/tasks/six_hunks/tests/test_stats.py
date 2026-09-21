from src.model import Task
from src.stats import average_priority, completion_rate, count_by_tag


def test_completion_rate_empty_and_half():
    assert completion_rate([]) == 0
    assert completion_rate([Task("a", done=True), Task("b")]) == 50


def test_average_priority_integral():
    assert average_priority([]) == 0.0
    assert average_priority([Task("a", 1), Task("b", 3)]) == 2.0


def test_count_by_tag():
    tasks = [Task("a", tags=("home", "urgent")), Task("b", tags=("home",))]
    assert count_by_tag(tasks) == {"home": 2, "urgent": 1}
    assert count_by_tag([]) == {}
