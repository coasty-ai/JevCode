from src.job import Job
from src.ranking import by_deadline, most_urgent, order

JOBS = [Job("import", 1, 60, 30), Job("export", 2, 40, 200), Job("verify", 1, 30, 100), Job("sweep", 3, 50, 150)]
WITH_ZERO = JOBS + [Job("ping", 1, 0, 50)]


def test_order_puts_the_most_urgent_first():
    assert [job.name for job in order(JOBS)] == ["import", "verify", "export", "sweep"]


def test_order_keeps_every_job_including_one_of_no_length():
    # ranking never drops a job; whether a job is worth a slot is the scheduler's call
    assert [job.name for job in order(WITH_ZERO)] == ["import", "ping", "verify", "export", "sweep"]


def test_order_of_nothing():
    assert order([]) == []


def test_by_deadline_ignores_the_priority():
    assert [job.name for job in by_deadline(JOBS)] == ["import", "verify", "sweep", "export"]


def test_most_urgent_is_the_head_of_the_order():
    assert most_urgent(JOBS).name == "import"
    assert most_urgent(WITH_ZERO).name == "import"


def test_most_urgent_of_nothing():
    assert most_urgent([]) is None
