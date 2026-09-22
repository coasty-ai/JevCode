from src.slack import headroom, is_late, lateness


def test_lateness_when_a_job_lands_after_its_deadline():
    assert lateness(70, 60) == 10
    assert lateness(180, 150) == 30


def test_lateness_when_a_job_lands_early():
    assert lateness(40, 60) == -20


def test_lateness_on_the_deadline_is_zero():
    assert lateness(60, 60) == 0


def test_is_late_reads_the_sign_of_the_lateness():
    assert is_late(70, 60) is True
    assert is_late(40, 60) is False
    assert is_late(60, 60) is False


def test_headroom_is_the_time_to_spare():
    assert headroom(40, 60) == 20
    assert headroom(60, 60) == 0


def test_headroom_of_a_late_job_is_zero():
    assert headroom(70, 60) == 0
