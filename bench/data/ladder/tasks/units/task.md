parse_duration only handles single-letter units and whole numbers. Make it behave like parse_size does for sizes (see both docstrings) so tests/test_units.py passes; do not edit the tests.
