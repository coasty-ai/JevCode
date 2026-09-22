from src.job import Job
from src.report import clock, footer, header, line, render
from src.schedule import Slot, lay_out

JOBS = [Job("import", 1, 60, 30), Job("export", 2, 40, 200), Job("verify", 1, 30, 100), Job("sweep", 3, 50, 150)]
ROOMY = [Job("a", 1, 10, 100), Job("b", 2, 10, 200)]


def test_clock_reads_minutes_as_a_time_of_day():
    assert clock(0) == "00:00"
    assert clock(90) == "01:30"
    assert clock(605) == "10:05"


def test_header_counts_the_slots_and_spans_them():
    assert header(lay_out(JOBS)) == "4 jobs, 00:00-03:00"


def test_header_of_an_empty_schedule():
    assert header([]) == "nothing to do"


def test_line_of_a_slot_that_misses_its_deadline():
    assert line(Slot(Job("import", 1, 60, 30), 0, 60)) == "00:00-01:00  import     LATE +30"


def test_line_of_a_slot_with_room_to_spare():
    assert line(Slot(Job("verify", 1, 30, 100), 60, 90)) == "01:00-01:30  verify     10 to spare"


def test_footer_names_the_late_jobs_and_totals_them():
    assert footer(lay_out(JOBS)) == "late: import, sweep (+60 min)"


def test_footer_when_everything_lands_in_time():
    assert footer(lay_out(ROOMY)) == "all on time"
    assert footer([]) == "all on time"


def test_render_is_the_header_the_slots_and_the_footer():
    assert render(lay_out(ROOMY)) == [
        "2 jobs, 00:00-00:20",
        "00:00-00:10  a          90 to spare",
        "00:10-00:20  b          180 to spare",
        "all on time",
    ]


def test_render_of_an_empty_schedule():
    assert render([]) == ["nothing to do", "all on time"]
