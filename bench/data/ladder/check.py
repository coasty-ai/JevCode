#!/usr/bin/env python3
"""Verify the ladder and print the pass/fail matrix.

For every task under tasks/: run pytest on the buggy tree, on the tree with gold/
copied over src/, and (for multi-hunk tasks) on the tree with each hunk applied alone.
Also checks that meta.hunks equals the number of `diff -U0` hunks between src/ and gold/,
that a task's `expected_failing` (required for tier "long") is exactly the buggy tree's failing
set, and that index.json matches the meta.json files and lists the "short" tier (the original
twelve, sorted by name) before the "long" tier (tasks 13-20, sorted by name). Runs in a
temporary copy, so the checked-in tree is never modified.

    python3 bench/data/ladder/check.py --python /tmp/ladder-venv/bin/python [task ...]

Exit status is 1 when any gold fails, any buggy passes, or any count disagrees.

Per-tier limits: "short" 4-10 tests and a gold run under 2 s; "long" 20-60 tests and under 3 s.
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent
TASKS = ROOT / "tasks"
TIERS = ("short", "long")
# tier -> (min tests, max tests, max gold seconds)
LIMITS = {"short": (4, 10, 2.0), "long": (20, 60, 3.0)}


def tier_of(meta: Dict[str, object]) -> str:
    return str(meta.get("tier", "short"))


def run_pytest(python: str, task_dir: Path) -> Dict[str, object]:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    t0 = time.perf_counter()
    proc = subprocess.run(
        [python, "-m", "pytest", "-p", "no:cacheprovider", "--no-header", "-rfE"],  # pytest.ini adds -q
        cwd=task_dir, capture_output=True, text=True, env=env,
    )
    seconds = time.perf_counter() - t0
    out = proc.stdout + proc.stderr

    def count(word: str) -> int:
        m = re.search(rf"(\d+) {word}", out)
        return int(m.group(1)) if m else 0

    failing = sorted(m.group(1) for m in re.finditer(r"^(?:FAILED|ERROR) (\S+)", out, re.M))
    return {"passed": count("passed"), "failed": count("failed"), "errors": count("error"),
            "rc": proc.returncode, "seconds": seconds, "out": out, "failing": failing}


def hunks_between(buggy: List[str], gold: List[str]) -> List[Tuple[int, int, int, int]]:
    """(i1, i2, j1, j2) for each non-equal difflib opcode, i.e. each contiguous change."""
    sm = difflib.SequenceMatcher(None, buggy, gold, autojunk=False)
    return [(i1, i2, j1, j2) for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag != "equal"]


def diff_u0_count(a: Path, b: Path) -> int:
    proc = subprocess.run(["diff", "-U0", str(a), str(b)], capture_output=True, text=True)
    return sum(1 for line in proc.stdout.splitlines() if line.startswith("@@"))


def apply_single_hunk(buggy: List[str], gold: List[str], hunk: Tuple[int, int, int, int]) -> List[str]:
    i1, i2, j1, j2 = hunk
    return buggy[:i1] + gold[j1:j2] + buggy[i2:]


def fmt(res: Dict[str, object]) -> str:
    total = int(res["passed"]) + int(res["failed"]) + int(res["errors"])  # type: ignore[arg-type]
    return f"{res['passed']}/{total}"


def check_task(python: str, task_dir: Path, tmp_root: Path, verbose: bool) -> Tuple[Dict[str, object], List[str]]:
    meta = json.loads((task_dir / "meta.json").read_text())
    problems: List[str] = []
    tier = tier_of(meta)
    if tier not in TIERS:
        problems.append(f"unknown tier {tier!r}")
        tier = "short"
    min_tests, max_tests, max_seconds = LIMITS[tier]
    work = tmp_root / task_dir.name
    shutil.copytree(task_dir, work)

    buggy = run_pytest(python, work)
    if buggy["failed"] == 0 and buggy["errors"] == 0:
        problems.append("buggy version passes every test")
    if buggy["passed"] == 0:
        problems.append("buggy version passes no test (no pass-to-pass regression guard)")
    expected = meta.get("expected_failing")
    if expected is None and tier == "long":
        problems.append("tier long requires expected_failing")
    if expected is not None and sorted(expected) != buggy["failing"]:
        problems.append("expected_failing differs from the buggy run: only in meta "
                        f"{sorted(set(expected) - set(buggy['failing']))}, only in run {sorted(set(buggy['failing']) - set(expected))}")

    # Hunks per file: difflib opcodes must agree with diff -U0, and their sum with meta.hunks.
    per_file: Dict[str, Tuple[List[str], List[str], List[Tuple[int, int, int, int]]]] = {}
    total_hunks = 0
    for rel in meta["files"]:
        src = task_dir / rel
        gold = task_dir / "gold" / Path(rel).name
        if not gold.exists():
            problems.append(f"missing gold for {rel}")
            continue
        b_lines, g_lines = src.read_text().splitlines(True), gold.read_text().splitlines(True)
        hunks = hunks_between(b_lines, g_lines)
        u0 = diff_u0_count(src, gold)
        if len(hunks) != u0:
            problems.append(f"{rel}: difflib sees {len(hunks)} hunks, diff -U0 sees {u0}")
        per_file[rel] = (b_lines, g_lines, hunks)
        total_hunks += u0
    if total_hunks != meta["hunks"]:
        problems.append(f"meta.hunks={meta['hunks']} but diff -U0 finds {total_hunks}")
    # Files that differ between src/ and gold/ but are not listed in meta.files.
    for gold in (task_dir / "gold").glob("*.py"):
        rel = f"src/{gold.name}"
        if rel not in meta["files"] and (task_dir / rel).read_text() != gold.read_text():
            problems.append(f"{rel} differs from gold but is not in meta.files")

    # Each hunk alone (only for multi-hunk tasks).
    single: List[str] = []
    if total_hunks > 1:
        n = 0
        for rel, (b_lines, g_lines, hunks) in per_file.items():
            for h in hunks:
                n += 1
                one = tmp_root / f"{task_dir.name}.h{n}"
                shutil.copytree(task_dir, one)
                (one / rel).write_text("".join(apply_single_hunk(b_lines, g_lines, h)))
                res = run_pytest(python, one)
                single.append(f"h{n}:{fmt(res)}")
                shutil.rmtree(one)

    # Gold over src.
    for gold in (task_dir / "gold").glob("*.py"):
        shutil.copy(gold, work / "src" / gold.name)
    goldres = run_pytest(python, work)
    if goldres["rc"] != 0 or goldres["failed"] or goldres["errors"]:
        problems.append("gold fails:\n" + str(goldres["out"]))
    if goldres["seconds"] > max_seconds:
        problems.append(f"gold run took {goldres['seconds']:.2f}s (> {max_seconds:g} s)")
    n_tests = int(goldres["passed"])
    if not min_tests <= n_tests <= max_tests:
        problems.append(f"{n_tests} tests (want {min_tests}-{max_tests} for tier {tier})")
    shutil.rmtree(work)

    if verbose and buggy["failed"] == 0:
        print(buggy["out"])
    row = {
        "task": meta["name"], "tier": tier, "hunks": meta["hunks"], "kinds": ",".join(meta["kinds"]),
        "difficulty": meta["difficulty"], "tests": n_tests, "buggy": fmt(buggy), "gold": fmt(goldres),
        "single": " ".join(single) or "-", "seconds": goldres["seconds"], "ok": not problems,
    }
    return row, problems


def check_index() -> List[str]:
    index_path = ROOT / "index.json"
    if not index_path.exists():
        return ["index.json missing"]
    index = json.loads(index_path.read_text())
    metas = {p.name: json.loads((p / "meta.json").read_text()) for p in sorted(TASKS.iterdir()) if p.is_dir()}
    problems = []
    want = [n for tier in TIERS for n in sorted(n for n, m in metas.items() if tier_of(m) == tier)]
    if [e["name"] for e in index] != want:
        problems.append("index.json task list differs from tasks/ directories or is not ordered short tier (by name) then long tier (by name)")
    for entry in index:
        meta = metas.get(entry["name"])
        if meta is None:
            continue
        if entry.get("path") != f"tasks/{entry['name']}":
            problems.append(f"index.json: bad path for {entry['name']}")
        if {k: v for k, v in entry.items() if k != "path"} != meta:
            problems.append(f"index.json entry for {entry['name']} differs from its meta.json")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--python", default=sys.executable, help="interpreter with pytest installed")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("tasks", nargs="*", help="task names (default: all)")
    args = ap.parse_args()

    names = args.tasks or sorted(p.name for p in TASKS.iterdir() if p.is_dir())
    rows, all_problems = [], []
    with tempfile.TemporaryDirectory(prefix="ladder-check-") as tmp:
        for name in names:
            row, problems = check_task(args.python, TASKS / name, Path(tmp), args.verbose)
            rows.append(row)
            all_problems.extend(f"{name}: {p}" for p in problems)
    if not args.tasks:
        all_problems.extend(check_index())

    header = f"{'task':<17} {'tier':<5} {'hunks':>5} {'dfclt':>5} {'tests':>5} {'buggy':>7} {'gold':>7}  {'each hunk alone (passed/total)':<52} {'gold s':>6}  ok"
    print(header)
    print("-" * len(header))
    for r in rows:
        print(f"{r['task']:<17} {r['tier']:<5} {r['hunks']:>5} {r['difficulty']:>5} {r['tests']:>5} {r['buggy']:>7} {r['gold']:>7}  {r['single']:<52} {r['seconds']:>6.2f}  {'yes' if r['ok'] else 'NO'}")
    total_tests = sum(r["tests"] for r in rows)
    print(f"\n{len(rows)} tasks, {total_tests} tests, {sum(r['hunks'] for r in rows)} hunks; "
          f"buggy column = tests passing before the fix, gold column = after.")
    if all_problems:
        print("\nPROBLEMS:")
        for p in all_problems:
            print(" -", p)
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
