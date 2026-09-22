from src.job import Job
from src.schedule import Slot, finish_time, late_jobs, lateness_of, lay_out, total_lateness

JOBS = [Job("import", 1, 60, 30), Job("export", 2, 40, 200), Job("verify", 1, 30, 100), Job("sweep", 3, 50, 150)]
WITH_ZERO = JOBS + [Job("ping", 1, 0, 50)]
ROOMY = [Job("a", 1, 10, 100), Job("b", 2, 10, 200)]

LAID_OUT = [("import", 0, 60), ("verify", 60, 90), ("export", 90, 130), ("sweep", 130, 180)]


def as_tuples(slots):
    return [(slot.job.name, slot.start, slot.finish) for slot in slots]


def test_slots_are_laid_end_to_end_in_ranking_order():
    assert as_tuples(lay_out(JOBS)) == LAID_OUT


def test_slots_start_where_they_are_told():
    assert as_tuples(lay_out(ROOMY, start_at=540)) == [("a", 540, 550), ("b", 550, 560)]


def test_a_job_of_no_length_gets_no_slot():
    assert as_tuples(lay_out(WITH_ZERO)) == LAID_OUT


def test_finish_time_is_the_end_of_the_last_slot():
    assert finish_time(JOBS) == 180
    assert finish_time(ROOMY, start_at=540) == 560


def test_finish_time_of_nothing_is_the_start():
    assert finish_time([]) == 0
    assert finish_time([], start_at=540) == 540


def test_lateness_of_a_slot_that_lands_late():
    slot = Slot(Job("import", 1, 60, 30), 0, 60)
    assert lateness_of(slot) == 30


def test_lateness_of_a_slot_that_lands_early():
    slot = Slot(Job("verify", 1, 30, 100), 60, 90)
    assert lateness_of(slot) == -10


def test_late_jobs_are_named_in_schedule_order():
    assert late_jobs(lay_out(JOBS)) == ["import", "sweep"]


def test_nothing_is_late_when_there_is_room():
    assert late_jobs(lay_out(ROOMY)) == []
    assert total_lateness(lay_out(ROOMY)) == 0


def test_total_lateness_counts_only_the_late_jobs():
    assert total_lateness(lay_out(JOBS)) == 60


def test_the_schedule_of_nothing():
    assert lay_out([]) == []
    assert late_jobs([]) == []
    assert total_lateness([]) == 0
