"""Build corpus.json: for each of the 40 QuixBugs Python programs, the buggy program with the fix
position marked, the buggy line (or null for insertions), the fix line, and 3 tests.
Usage: python3 build_corpus.py /tmp/quixbugs out/corpus.json
"""
import difflib, json, os, re, sys

root, out = sys.argv[1], sys.argv[2]
MARK = "<<<FIX THIS LINE>>>"

def code(p, d):
    s = open(f"{root}/{d}/{p}.py").read()
    i = s.find('\n"""')
    return (s[:i] if i > 0 else s).rstrip().split("\n")

def strip_comment(l):
    return re.sub(r"\s*#.*$", "", l).rstrip()

def json_tests(p):
    f = f"{root}/json_testcases/{p}.json"
    if not os.path.exists(f): return None
    rows = [json.loads(l) for l in open(f) if l.strip()]
    return [{"input": r[0], "expected": r[1]} for r in rows[:3]]

def py_tests(p):
    src = open(f"{root}/python_testcases/test_{p}.py").read()
    funcs = re.split(r"\n(?=def test)", src)[1:]
    return [f.strip() for f in funcs[:3]]

corpus = []
names = sorted(f[:-3] for f in os.listdir(f"{root}/python_programs") if f.endswith(".py") and not f.endswith("_test.py") and f != "node.py")
for p in names:
    b, f = code(p, "python_programs"), code(p, "correct_python_programs")
    sm = difflib.SequenceMatcher(None, b, f, autojunk=False)
    ops = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal": continue
        fl = [f[j] for j in range(j1, j2) if f[j].strip()]
        bl = [b[i] for i in range(i1, i2)]
        if not fl: continue  # blank-only insert / comment removal
        if tag == "replace" and len(bl) == 1 and len(fl) == 1 and strip_comment(bl[0]) == strip_comment(fl[0]): continue
        ops.append((tag, i1, i2, fl, bl))
    assert len(ops) == 1, (p, ops)
    tag, i1, i2, fl, bl = ops[0]
    assert len(fl) == 1, (p, fl)
    fix_line = fl[0]
    indent = fix_line[: len(fix_line) - len(fix_line.lstrip())]
    if tag == "replace":
        # the buggy line is the non-blank buggy line in the op (there is exactly one)
        real_bl = [l for l in bl if l.strip()]
        assert len(real_bl) == 1, (p, bl)
        buggy_line = real_bl[0]
        bidx = b.index(buggy_line, i1)
        marked = b[:bidx] + [indent + MARK] + b[bidx + 1 :]
    else:
        buggy_line = None
        marked = b[:i1] + [indent + MARK] + b[i1:]
    jt = json_tests(p)
    corpus.append({
        "name": p, "kind": tag, "indent": indent,
        "buggy_line": strip_comment(buggy_line).strip() if buggy_line else None,
        "fix_line": strip_comment(fix_line).strip(),
        "marked_program": "\n".join(marked),
        "buggy_program": "\n".join(b),
        "tests": jt if jt is not None else py_tests(p),
        "tests_kind": "json" if jt is not None else "pytest_source",
    })
json.dump(corpus, open(out, "w"), indent=1)
print(f"{len(corpus)} programs; kinds:", {k: sum(1 for c in corpus if c['kind']==k) for k in ('replace','insert')})
for c in corpus: print(f"{c['name']:28s} {c['kind']:8s} | {c['buggy_line']!s:60s} -> {c['fix_line']}")
