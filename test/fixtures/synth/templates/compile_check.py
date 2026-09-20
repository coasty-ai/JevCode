"""Compile-check a batch of Python sources: stdin JSON [{"id": ..., "src": ...}], stdout JSON of failures."""
import json
import sys

items = json.load(sys.stdin)
failures = []
for item in items:
    try:
        compile(item["src"], item["id"], "exec")
    except SyntaxError as exc:  # noqa: PERF203 - one entry per failure is the point
        failures.append({"id": item["id"], "error": f"{exc.msg} (line {exc.lineno})"})
json.dump(failures, sys.stdout)
