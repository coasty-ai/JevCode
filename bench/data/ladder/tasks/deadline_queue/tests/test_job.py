from src.job import Job


def test_a_job_carries_its_fields():
    job = Job("backup", 2, 30, 120)
    assert (job.name, job.priority, job.minutes, job.due_at) == ("backup", 2, 30, 120)


def test_the_key_leads_with_the_priority():
    assert Job("a", 1, 10, 500).key() < Job("b", 2, 10, 10).key()


def test_the_key_breaks_a_priority_tie_by_deadline():
    assert Job("z", 1, 10, 30).key() < Job("a", 1, 10, 60).key()


def test_the_key_breaks_a_deadline_tie_by_name():
    assert Job("ann", 1, 10, 30).key() < Job("bob", 1, 10, 30).key()


def test_jobs_sort_by_their_key():
    jobs = [Job("c", 2, 5, 10), Job("a", 1, 5, 99), Job("b", 1, 5, 10)]
    assert [job.name for job in sorted(jobs, key=lambda job: job.key())] == ["b", "a", "c"]
