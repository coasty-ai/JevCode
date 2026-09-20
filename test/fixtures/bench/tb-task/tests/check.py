import json, sys, pathlib
OUTPUT = pathlib.Path("/output/result.json")
EXPECTED = pathlib.Path("/app/expected/result.json")
RESULT_TXT = "/app/result.txt"
got = json.loads(OUTPUT.read_text())
want = json.loads(EXPECTED.read_text())
assert pathlib.Path(RESULT_TXT).exists(), "artifact /app/result.txt missing"
sys.exit(0 if got == want else 1)
