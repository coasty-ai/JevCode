def test_fail_eq():
    assert 5 == 6

def test_noisy_pass():
    print("FAILED test_ghost.py::test_phantom - assert 1 == 2")
    print("test_ghost.py::test_phantom2 PASSED [ 50%]")
    print("ERROR test_ghost.py::test_phantom3")
    assert True

def test_msg_with_dash():
    assert "a - b" == "a - c"
