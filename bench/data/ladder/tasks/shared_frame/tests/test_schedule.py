from src.schedule import Show, by_start, clashes, format_time, parse_time


def test_parse_and_format_time():
    assert parse_time("09:05") == 545
    assert format_time(545) == "09:05"
    assert format_time(parse_time("23:59")) == "23:59"


def test_show_end():
    assert Show("Hamlet", 600, 150).end == 750


def test_clashes_overlap():
    assert clashes(Show("a", 600, 60), Show("b", 630, 60))


def test_no_clash_when_touching():
    assert not clashes(Show("a", 600, 60), Show("b", 660, 60))


def test_by_start_orders_by_time_then_name():
    shows = [Show("b", 660, 30), Show("a", 600, 30), Show("c", 600, 30)]
    assert [s.name for s in by_start(shows)] == ["a", "c", "b"]
