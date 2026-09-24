#!/usr/bin/env python3
"""Build 6 candidate patches per QuixBugs program and run the tests on each.

Candidates: the fix (correct program), the buggy original (a no-op edit), one partial mutant
(passes more tests than the buggy original but not all) when one exists within the budget, and
wrong mutants to fill 6. Mutants are single-line edits of the buggy program produced by
mutation operators (comparison flips, +/-1, and/or, +/-, True/False, not-removal, index flips,
// vs /, argument swap, range bounds). Tests the correct program fails at the 2 s timeout are
excluded for that program (listed in the output).

Output: candidates.json  {program: {before, excluded, candidates:[{id, kind, line_no, old_line,
new_line, code, after, labels}]}}
"""
import json
import os
import random
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

QB = "/tmp/quixbugs"
HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, "run_tests.py")
BUDGET = int(os.environ.get("MUTANT_BUDGET", "24"))
random.seed(7)

MUTATIONS = [
    (r"<=", "<"), (r">=", ">"), (r"(?<![<>=!])<(?!=)", "<="), (r"(?<![<>=!])>(?!=)", ">="), (r"==", "!="), (r"!=", "=="),
    (r"\+ 1\b", "- 1"), (r"- 1\b", "+ 1"), (r"\band\b", "or"), (r"\bor\b", "and"), (r"(?<!\+)\+(?![+=])", "-"), (r"(?<![-*])-(?![-=>])", "+"),
    (r"(?<!\*)\*(?![*=])", "/"), (r"\bTrue\b", "False"), (r"\bFalse\b", "True"), (r"\bnot ", ""), (r"\[0\]", "[-1]"), (r"\[-1\]", "[0]"),
    (r"//", "/"), (r"(?<!/)/(?!/)", "//"), (r"\+= 1\b", "-= 1"), (r"-= 1\b", "+= 1"), (r"range\(1, ", "range(0, "), (r"range\(0, ", "range(1, "),
    (r"\)\s*$", " - 1)"), (r"\bis None\b", "is not None"), (r"\bis not None\b", "is None"), (r"\bmax\(", "min("), (r"\bmin\(", "max("),
    (r"\[1:\]", "[:-1]"), (r"\[:-1\]", "[1:]"), (r"\bappend\(", "insert(0, "), (r"\bpop\(\)", "pop(0)"), (r"\bpop\(0\)", "pop()"),
    (r"\^=", "&="), (r"\^=", "|="), (r"&=", "^="), (r"&=", "|="), (r"\|=", "&="), (r" - 1\b", ""), (r" \+ 1\b", ""), (r"\b0\b", "1"), (r"\b1\b", "0"), (r"\b1\b", "2"), (r"\b2\b", "1"),
    (r"\bwhile (?!not )", "while not "), (r"\bif (?!not )", "if not "), (r"\belif (?!not )", "elif not "), (r"\byield (\w+)\((\w+)\)", r"yield \2"), (r"\breturn (\w+)\((\w+)\)", r"return \2"),
    (r"\[(\w+)\]", r"[\1 + 1]"), (r"\[(\w+)\]", r"[\1 - 1]"), (r"\bin (\w+):", r"in \1[1:]:"), (r"\breturn (\w+)\s*$", r"return \1 - 1"), (r"\breturn (\w+)\s*$", r"return \1 + 1"),
    (r"\bnot (\w+)", r"\1"), (r"(\w+)\.(\w+)\(", r"\1.\2(0, "), (r"<", ">"), (r">", "<"), (r"\*\*", "*"), (r"%", "//"),
]


def code_only(src):
    i = src.find('\n"""')
    return (src[:i] if i > 0 else src).strip("\n").rstrip() + "\n"


KEYWORDS = set("def return if else elif for while in not and or is None True False yield import from as lambda break continue pass range len list dict set tuple int str float abs max min sum sorted reversed enumerate zip isinstance print self heapq string deque Queue defaultdict Counter append pop insert extend keys values items add remove get join split strip lower upper".split())


def identifiers(code):
    ids = set(re.findall(r"\b[A-Za-z_][A-Za-z_0-9]*\b", code))
    return sorted(i for i in ids if i not in KEYWORDS and not i.startswith("__"))


def mutants_of_line(line, ids=()):
    out = []
    for pat, rep in MUTATIONS:
        for mt in re.finditer(pat, line):
            m = line[:mt.start()] + mt.expand(rep) + line[mt.end():]
            if m != line and m.strip():
                out.append(m)
    # identifier substitution: one occurrence of an identifier replaced by another in-program identifier
    body = line.split("#")[0]
    for mt in re.finditer(r"\b[A-Za-z_][A-Za-z_0-9]*\b", body):
        name = mt.group(0)
        if name in KEYWORDS or line[mt.end():mt.end() + 1] == "(" and name not in ids:
            continue
        for other in ids:
            if other != name and name in ids:
                out.append(line[:mt.start()] + other + line[mt.end():])
    sw = re.sub(r"\(([^(),]+), ([^(),]+)\)", r"(\2, \1)", line, count=1)
    if sw != line:
        out.append(sw)
    seen, uniq = set(), []
    for m in out:
        if m not in seen:
            seen.add(m); uniq.append(m)
    return uniq


def run(code, program, excluded):
    with tempfile.NamedTemporaryFile("w", suffix=".py", prefix=f"{program}-", dir="/tmp/jevonly", delete=False) as f:
        f.write(code); path = f.name
    try:
        r = subprocess.run([sys.executable, RUNNER, path, program], capture_output=True, text=True, timeout=120)
        d = json.loads(r.stdout)
    finally:
        os.unlink(path)
    tests = [t for t in d["tests"] if t["id"] not in excluded]
    passed = sum(1 for t in tests if t["status"] == "pass")
    return {"total": len(tests), "passed": passed, "failed": len(tests) - passed, "tests": tests}


def first_diff(buggy_lines, fixed_lines):
    for i in range(max(len(buggy_lines), len(fixed_lines))):
        b = buggy_lines[i] if i < len(buggy_lines) else ""
        f = fixed_lines[i] if i < len(fixed_lines) else ""
        if b != f:
            return i
    return None


def labels(before, after):
    bs = {t["id"]: t["status"] == "pass" for t in before["tests"]}
    as_ = {t["id"]: t["status"] == "pass" for t in after["tests"]}
    newly_pass = [i for i in bs if not bs[i] and as_.get(i)]
    newly_fail = [i for i in bs if bs[i] and not as_.get(i)]
    correct = after["passed"] == after["total"]
    progress = after["passed"] > before["passed"]
    broke = len(newly_fail) > 0
    if correct:
        kind = "fix"
    elif progress and not broke:
        kind = "partial"
    elif progress and broke:
        kind = "partial_mixed"
    elif after["passed"] < before["passed"]:
        kind = "regression"
    elif broke:
        kind = "lateral"
    else:
        kind = "no_change"
    return {"correct": correct, "progress": progress, "broke": broke, "kind": kind, "newly_passing": newly_pass, "newly_failing": newly_fail}


def build(program):
    buggy = code_only(open(f"{QB}/python_programs/{program}.py").read())
    fixed = code_only(open(f"{QB}/correct_python_programs/{program}.py").read())
    fixed_run = run(fixed, program, set())
    excluded = {t["id"] for t in fixed_run["tests"] if t["status"] != "pass"}
    fixed_run = run(fixed, program, excluded) if excluded else fixed_run
    before = run(buggy, program, excluded)
    blines = buggy.split("\n"); flines = fixed.split("\n")
    bug_idx = first_diff(blines, flines)
    cands = []
    cands.append({"id": "fix", "line_no": (bug_idx or 0) + 1, "old_line": blines[bug_idx] if bug_idx is not None else "", "new_line": flines[bug_idx] if bug_idx is not None else "", "code": fixed, "after": fixed_run})
    cands.append({"id": "buggy_noop", "line_no": (bug_idx or 0) + 1, "old_line": blines[bug_idx] if bug_idx is not None else "", "new_line": blines[bug_idx] if bug_idx is not None else "", "code": buggy, "after": before})
    # mutant pool: buggy line first, then other non-blank lines in random order
    order = [bug_idx] if bug_idx is not None else []
    others = [i for i, l in enumerate(blines) if l.strip() and i != bug_idx and not l.strip().startswith(("def ", "import", "from ", "#"))]
    random.shuffle(others); order += others
    ids = identifiers(buggy)
    pool, seen = [], set()
    for rank, i in enumerate(order):
        ms = mutants_of_line(blines[i], ids)
        if rank > 0:
            random.shuffle(ms); ms = ms[:4]  # a few mutants per other line
        else:
            random.shuffle(ms); ms = ms[:BUDGET // 2]  # half the budget at the buggy line
        for m in ms:
            if (i == bug_idx and m == (flines[i] if i < len(flines) else None)) or (i, m) in seen or m == blines[i]:
                continue
            seen.add((i, m)); pool.append((i, m))
    pool = pool[:BUDGET]

    def evaluate(im):
        i, m = im
        code = "\n".join(blines[:i] + [m] + blines[i + 1:])
        try:
            after = run(code, program, excluded)
        except Exception as e:  # noqa: BLE001
            return None
        return {"id": None, "line_no": i + 1, "old_line": blines[i], "new_line": m, "code": code, "after": after}

    with ThreadPoolExecutor(max_workers=4) as ex:
        evaluated = [c for c in ex.map(evaluate, pool) if c]
    for c in evaluated:
        c["labels"] = labels(before, c["after"])
    for c in cands:
        c["labels"] = labels(before, c["after"])
    by_kind = {}
    for c in evaluated:
        by_kind.setdefault(c["labels"]["kind"], []).append(c)
    chosen = []
    if by_kind.get("partial"):
        chosen.append(("partial", by_kind["partial"][0]))
    elif by_kind.get("partial_mixed"):
        chosen.append(("partial_mixed", by_kind["partial_mixed"][0]))
    # wrong mutants: prefer one regression, one no_change at the buggy line, one lateral/other
    wrong_pref = ["regression", "no_change", "lateral", "regression", "no_change", "lateral"]
    used = {id(c) for _, c in chosen}
    for k in wrong_pref:
        if len(chosen) >= 4:
            break
        for c in by_kind.get(k, []):
            if id(c) not in used:
                chosen.append((k, c)); used.add(id(c)); break
    for c in evaluated:  # fill from anything wrong
        if len(chosen) >= 4:
            break
        if id(c) not in used and c["labels"]["kind"] != "fix":
            chosen.append((c["labels"]["kind"], c)); used.add(id(c))
    for n, (k, c) in enumerate(chosen):
        c["id"] = f"mutant_{n + 1}_{k}"
        cands.append(c)
    equiv = sum(1 for c in evaluated if c["labels"]["kind"] == "fix")
    return {"program": program, "bug_line_no": (bug_idx or 0) + 1, "excluded_tests": sorted(excluded), "before": before, "mutants_evaluated": len(evaluated), "fix_equivalent_mutants": equiv, "candidates": cands}


if __name__ == "__main__":
    programs = sorted(p[:-3] for p in os.listdir(f"{QB}/python_programs") if p.endswith(".py") and not p.endswith("_test.py") and p != "node.py")
    if len(sys.argv) > 1:
        programs = sys.argv[1:]
    out = {}
    with ThreadPoolExecutor(max_workers=3) as ex:
        for res in ex.map(build, programs):
            out[res["program"]] = res
            kinds = [c["labels"]["kind"] for c in res["candidates"]]
            print(f"{res['program']:28s} before={res['before']['passed']}/{res['before']['total']} excl={res['excluded_tests']} mutants={res['mutants_evaluated']} equiv={res['fix_equivalent_mutants']} kinds={kinds}", flush=True)
    json.dump(out, open(os.path.join(HERE, "candidates.json"), "w"), indent=1)
