#!/usr/bin/env python3
"""QuixBugs (Python, 40 programs): does a small catalogue of code-proposed mutation
operators and fix templates contain the developer fix, and where does spectrum-based
fault localisation (Ochiai / Tarantula / DStar) rank the buggy line?

No LLM and no Jev calls: this is the deterministic half of "code proposes, Jev decides".

Usage: python3 quixbugs_operator_coverage.py [/tmp/quixbugs] > out.json
Writes a JSON report to stdout and a Markdown table to stderr.
"""
import difflib, io, itertools, json, keyword, os, re, signal, subprocess, sys, tokenize

QB = sys.argv[1] if len(sys.argv) > 1 else "/tmp/quixbugs"
GRAPH = {"breadth_first_search", "depth_first_search", "detect_cycle", "minimum_spanning_tree",
         "reverse_linked_list", "shortest_path_length", "shortest_path_lengths", "shortest_paths",
         "topological_ordering"}

# ----------------------------------------------------------------------------- helpers
def strip_docstring(src: str) -> str:
    """Buggy and correct programs carry a trailing \"\"\" block after the code; drop it."""
    m = re.search(r'\n"""', src)
    return src[:m.start()] if m else src

def norm(line: str) -> str:
    line = re.sub(r"\s+#.*$", "", line.rstrip())  # trailing comments are not part of the fix
    if line.strip().startswith("#"):
        return ""
    return re.sub(r"\s+", " ", line.strip())

def code_lines(src: str):
    return [l.rstrip() for l in src.splitlines()]

def idents(src: str):
    out = set()
    try:
        for tok in tokenize.generate_tokens(io.StringIO(src).readline):
            if tok.type == tokenize.NAME and not keyword.iskeyword(tok.string):
                out.add(tok.string)
    except tokenize.TokenError:
        pass
    return out

# ----------------------------------------------------------------------------- operators
REL = ["<", "<=", ">", ">=", "==", "!="]
ARITH = ["+", "-", "*", "//", "/", "%", "**"]
BITWISE = ["&", "|", "^", "<<", ">>"]
AUG = ["+=", "-=", "*=", "//=", "&=", "|=", "^="]
BUILTINS = ["len", "list", "set", "tuple", "sorted", "reversed", "min", "max", "sum", "abs", "range",
            "str", "int", "float", "iter", "next", "enumerate", "zip", "any", "all", "flatten"]
METHODS = ["append", "pop", "popleft", "add", "extend", "insert", "remove", "get", "keys", "values",
           "items", "update", "union", "sort", "reverse", "appendleft"]
LITS = {"True": ["False"], "False": ["True"], "0": ["1", "-1"], "1": ["0", "2", "-1"], "2": ["1", "3"],
        "''": ["' '"], "' '": ["''"], "None": ["0", "[]", "''"], "[]": ["[[]]", "[0]", "{}"], "[[]]": ["[]"]}

def op_token_spans(line, ops):
    """yield (start, end, op) for operator occurrences, longest match first, not inside strings."""
    for m in re.finditer(r"'[^']*'|\"[^\"]*\"|<=|>=|==|!=|//|\*\*|[<>+\-*/%]", line):
        if m.group(0)[0] in "'\"":
            continue
        if m.group(0) in ops:
            yield m.start(), m.end(), m.group(0)

def gen_candidates(line, file_idents, ops_used):
    """Return {candidate_line: operator_name} for single-application edits of one line."""
    out = {}
    def add(c, name):
        c2 = c
        if norm(c2) != norm(line):
            out.setdefault(norm(c2), name)
    indent = line[: len(line) - len(line.lstrip())]
    body = line.strip()

    # 1 relational operator swap
    for s, e, op in op_token_spans(body, REL):
        for o in REL:
            if o != op:
                add(indent + body[:s] + o + body[e:], "rel_swap")
    # 2 arithmetic operator swap (skip unary minus heuristically: preceded by ( , = or start)
    for s, e, op in op_token_spans(body, ARITH):
        prev = body[:s].rstrip()
        if op == "-" and (not prev or prev[-1] in "(,=[:"):
            continue
        for o in ARITH:
            if o != op:
                add(indent + body[:s] + o + body[e:], "arith_swap")
    for m in re.finditer(r"(?<![&|^<>])(&|\||\^|<<|>>)(?![&|^<>=])", body):
        for o in BITWISE:
            if o != m.group(1):
                add(indent + body[:m.start()] + o + body[m.end():], "bitwise_swap")
    for m in re.finditer(r"(\+=|-=|\*=|//=|&=|\|=|\^=)", body):
        for o in AUG:
            if o != m.group(1):
                add(indent + body[:m.start()] + o + body[m.end():], "augassign_swap")
    # 3 logical operators, negation
    for a, b in (("and", "or"), ("or", "and")):
        for m in re.finditer(r"\b%s\b" % a, body):
            add(indent + body[:m.start()] + b + body[m.end():], "logic_swap")
    for m in re.finditer(r"\bnot\s+", body):
        add(indent + body[:m.start()] + body[m.end():], "negate")
    for m in re.finditer(r"\b(if|while|return|elif)\s+", body):
        add(indent + body[:m.end()] + "not " + body[m.end():], "negate")
    # 4 off-by-one: remove / add "+ 1" / "- 1" around identifiers, slices, calls; literal +-1
    for m in re.finditer(r"\s*[+-]\s*1\b", body):
        add(indent + body[:m.start()] + body[m.end():], "off_by_one")
    for pat in (r"(?<![\w.])[A-Za-z_]\w*(?![\w(\[])", r"\b[A-Za-z_]\w*(\[[^\[\]]*\]|\([^()]*\))"):
        for m in re.finditer(pat, body):
            if keyword.iskeyword(m.group(0)):
                continue
            for d in (" + 1", " - 1"):
                add(indent + body[:m.end()] + d + body[m.end():], "off_by_one")
    for m in re.finditer(r"\b1\s*\+\s*", body):  # drop a leading "1 + " term
        add(indent + body[:m.start()] + body[m.end():], "off_by_one")
    for m in re.finditer(r"(?<![\w.])(\d+)(?![\w.])", body):
        n = int(m.group(1))
        for v in (n + 1, n - 1):
            if v >= 0:
                add(indent + body[:m.start()] + str(v) + body[m.end():], "literal_pm1")
    for lit, alts in LITS.items():
        for m in re.finditer(r"(?<![\w'\"])" + re.escape(lit) + r"(?![\w'\"])", body):
            for alt in alts:
                add(indent + body[:m.start()] + alt + body[m.end():], "literal_swap")
    for m in re.finditer(r"(?<![\w'\"])(True|False|\[\])(?![\w'\"])", body):
        for y in sorted(file_idents):
            reps = [y, f"{y} == 0", f"{y} != 0", f"not {y}"] if m.group(1) != "[]" else [f"[{y}]"]
            for r in reps:
                add(indent + body[:m.start()] + r + body[m.end():], "literal_to_expr")
    # 5 identifier substitution with another identifier from the file (or a builtin / method)
    names = sorted(file_idents | set(BUILTINS))
    for m in re.finditer(r"(?<![\w.])([A-Za-z_]\w*)(?!\w)", body):
        w = m.group(1)
        if keyword.iskeyword(w):
            continue
        for n2 in names:
            if n2 != w:
                add(indent + body[:m.start()] + n2 + body[m.end():], "ident_subst")
    for m in re.finditer(r"\.([A-Za-z_]\w*)", body):
        for n2 in sorted(set(METHODS) | file_idents):
            if n2 != m.group(1):
                add(indent + body[:m.start() + 1] + n2 + body[m.end():], "attr_subst")
    # 6 argument swap inside the innermost call / index (adjacent pairs)
    for m in re.finditer(r"\(([^()]*)\)|\[([^\[\]]*)\]", body):
        inner = m.group(1) if m.group(1) is not None else m.group(2)
        args = [a for a in re.split(r",(?![^\[\]()]*[\])])", inner)]
        if len(args) >= 2:
            for i in range(len(args) - 1):
                a2 = args[:]; a2[i], a2[i + 1] = a2[i + 1].strip(), a2[i].strip()
                add(indent + body[:m.start() + 1] + ", ".join(x.strip() for x in a2) + body[m.end() - 1:], "arg_swap")
    # 7 operand swap around a binary operator: "a OP b" -> "b OP a" inside a parenthesised / simple expr
    for m in re.finditer(r"(\b[\w.\[\]()]+)\s*(//|\*\*|[+\-*/%<>]=?|==|!=)\s*(\b[\w.\[\]()]+)", body):
        add(indent + body[:m.start()] + f"{m.group(3)} {m.group(2)} {m.group(1)}" + body[m.end():], "operand_swap")
    # 8 wrap / unwrap a call: x -> f(x) ; f(x) -> x
    for m in re.finditer(r"\b([A-Za-z_]\w*)\(([^()]*)\)", body):
        add(indent + body[:m.start()] + m.group(2) + body[m.end():], "call_unwrap")
    for m in re.finditer(r"(?<![\w.])([A-Za-z_]\w*(\[[^\[\]]*\])?)(?![\w(\[])", body):
        if keyword.iskeyword(m.group(1)):
            continue
        for f in BUILTINS + sorted(file_idents):
            add(indent + body[:m.start()] + f"{f}({m.group(1)})" + body[m.end():], "call_wrap")
    # 8b identifier -> slice / binop with identifier or literal / power
    for m in re.finditer(r"(?<![\w.])([A-Za-z_]\w*)(?![\w(\[])", body):
        w = m.group(1)
        if keyword.iskeyword(w):
            continue
        for rep in ([f"{w}[1:]", f"{w}[:-1]", f"{w} ** 2", f"{w} * {w}", f"{w} * 2", f"{w} / 2", f"{w} // 2", f"{w}[0]", f"{w}[-1]"]
                    + [f"{w}[{y}:]" for y in sorted(file_idents) if y != w]
                    + [f"{w} {o} {y}" for y in sorted(file_idents) if y != w for o in ("+", "-", "*")]):
            add(indent + body[:m.start()] + rep + body[m.end():], "ident_extend")
    # 8c replace a call expression with an identifier
    for m in re.finditer(r"\b[A-Za-z_]\w*\([^()]*\)", body):
        for y in sorted(file_idents):
            add(indent + body[:m.start()] + y + body[m.end():], "call_to_ident")
    # 8d wrap an assignment / return RHS in max()/min() with a bound
    m = re.match(r"([\w\[\], .]+?)\s*=\s*(?![=])(.+)$", body) or re.match(r"(return)\s+(.+)$", body)
    if m and not body.startswith(("if", "while", "for", "elif")):
        lhs, rhs = m.group(1).strip(), m.group(2).strip()
        for f in ("max", "min"):
            for bound in ["0", "1"] + ([lhs] if lhs != "return" else []) + sorted(file_idents):
                if bound == rhs:
                    continue
                add(indent + (f"{lhs} = " if lhs != "return" else "return ") + f"{f}({bound}, {rhs})", "minmax_wrap")
        for y in sorted(file_idents):
            add(indent + (f"{lhs} = " if lhs != "return" else "return ") + f"{y} + {rhs}", "prepend_term")
    # 8e condition extension (TBar FP6.3) and None guard (FP2 in a condition)
    m = re.match(r"(if|elif|while)\s+(.+):$", body)
    if m:
        kw, cond = m.group(1), m.group(2)
        for y in sorted(file_idents):
            for rep in (f"{cond} or not {y}", f"{cond} or {y}", f"{cond} and {y}", f"{cond} and not {y}", f"{cond} or {y} is None", f"{y} is None or {cond}", f"{y} is not None and {cond}"):
                add(indent + f"{kw} {rep}:", "cond_extend")
        for m2 in re.finditer(r"([A-Za-z_]\w*)\.", cond):  # X.attr in condition -> guard X
            x = m2.group(1)
            add(indent + f"{kw} {x} is None or {cond}:", "none_guard")
            add(indent + f"{kw} {x} is not None and {cond}:", "none_guard")
        for a, b in (("== 0", "<= 1"), ("== 0", "< 1"), ("== 1", "<= 1"), ("<= 1", "== 0"), ("== 0", "<= 0"), ("< 1", "== 0")):
            if a in cond:
                add(indent + f"{kw} {cond.replace(a, b)}:", "boundary_rewrite")
    # 9 slice bound edits: [a:b] -> [a:], [:b], [a+1:b], [a:b-1] handled by off_by_one; add drop-bound variants
    for m in re.finditer(r"\[([^\[\]:]*):([^\[\]:]*)\]", body):
        a, b = m.group(1), m.group(2)
        for rep in (f"[{a}:]", f"[:{b}]", f"[{b}:{a}]" if a and b else None):
            if rep:
                add(indent + body[:m.start()] + rep + body[m.end():], "slice_edit")
    # 10 delete statement
    add("", "delete_stmt")
    for k in set(out.values()):
        ops_used.add(k)
    return out

TEMPLATES = [  # inserted-line templates, instantiated with identifiers/expressions from the file
    "return {x}", "{x} = {y}", "{x}.append({y})", "{x} += 1", "{x} -= 1", "{x} = {x} + 1",
    "if {x} is None: return", "if not {x}: return {y}", "{x} = {x}[1:]", "{x} = []", "{x} = 0",
    "{x}.add({y})", "{x}.remove({y})", "{x}.pop()", "{x}.popleft()", "{x}.append({y}[0])", "{x} = {y}.pop()", "return {x}[0]",
]

# ----------------------------------------------------------------------------- SBFL
RUNNER = r'''
import json, sys, signal, types, math, os
sys.path.insert(0, %(qb)r); sys.path.insert(0, os.path.join(%(qb)r, "python_programs"))
algo = %(algo)r
cov = {}
target = os.path.join(%(qb)r, "python_programs", algo + ".py")
def tracer(frame, event, arg):
    if event == "line" and frame.f_code.co_filename == target:
        cov[frame.f_lineno] = True
    return tracer
class TO(Exception): pass
def alarm(*a): raise TO()
signal.signal(signal.SIGALRM, alarm)
sys.setrecursionlimit(1200)
results = []
def compare(got, exp):
    if isinstance(got, types.GeneratorType): got = list(got)
    if isinstance(got, float) and isinstance(exp, (int, float)): return abs(got - exp) < 1e-6
    if isinstance(got, (set,)): return sorted(map(str, got)) == sorted(map(str, exp)) if isinstance(exp, list) else got == exp
    try:
        j = json.loads(json.dumps(got, default=list))
        return j == exp
    except Exception:
        return got == exp
mod = __import__("python_programs." + algo, fromlist=[algo])
fx = getattr(mod, algo)
if algo not in %(graph)r:
    for line in open(os.path.join(%(qb)r, "json_testcases", algo + ".json")):
        line = line.strip()
        if not line: continue
        args, exp = json.loads(line)
        cov = {}
        ok = False
        signal.setitimer(signal.ITIMER_REAL, 3.0)
        sys.settrace(tracer)
        try:
            got = fx(*args) if isinstance(args, list) else fx(args)
            if isinstance(got, types.GeneratorType): got = list(got)
            ok = compare(got, exp)
        except BaseException as e:
            ok = False
        finally:
            sys.settrace(None); signal.setitimer(signal.ITIMER_REAL, 0)
        results.append({"pass": bool(ok), "lines": sorted(cov)})
else:
    import pytest as _p
    _p.use_correct = False
    import importlib.util
    spec = importlib.util.spec_from_file_location("t", os.path.join(%(qb)r, "python_testcases", "test_" + algo + ".py"))
    t = importlib.util.module_from_spec(spec)
    sys.settrace(None)
    spec.loader.exec_module(t)
    for name in sorted(n for n in dir(t) if n.startswith("test")):
        cov = {}
        ok = False
        signal.setitimer(signal.ITIMER_REAL, 3.0)
        sys.settrace(tracer)
        try:
            getattr(t, name)(); ok = True
        except BaseException:
            ok = False
        finally:
            sys.settrace(None); signal.setitimer(signal.ITIMER_REAL, 0)
        results.append({"pass": bool(ok), "lines": sorted(cov)})
print(json.dumps(results))
'''

def run_tests(algo):
    code = RUNNER % {"qb": QB, "algo": algo, "graph": GRAPH}
    try:
        p = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120, cwd=QB)
        return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception as e:
        return {"error": str(e)}

def sbfl(results, executable_lines):
    tf = sum(1 for r in results if not r["pass"]); tp = len(results) - tf
    scores = {}
    for ln in executable_lines:
        ef = sum(1 for r in results if not r["pass"] and ln in r["lines"])
        ep = sum(1 for r in results if r["pass"] and ln in r["lines"])
        och = ef / ((tf * (ef + ep)) ** 0.5) if tf and (ef + ep) else 0.0
        tar = ((ef / tf) / ((ef / tf) + (ep / tp if tp else 0))) if tf and ef else 0.0
        dst = (ef ** 2) / ((ep + (tf - ef)) or 1e-9) if ef else 0.0
        scores[ln] = (och, tar, dst)
    return scores, tf, tp

def einspect_rank(scores, idx, buggy_lines):
    """Average rank of the best buggy line under ties (Zou et al. Einspect); also worst-case rank."""
    vals = sorted(((s[idx], ln) for ln, s in scores.items()), key=lambda t: -t[0])
    best = None
    for bl in buggy_lines:
        if bl not in scores:
            continue
        v = scores[bl][idx]
        higher = sum(1 for s, _ in vals if s > v)
        ties = sum(1 for s, _ in vals if s == v)
        r = higher + (ties + 1) / 2
        w = higher + ties
        if best is None or r < best[0]:
            best = (r, w, ties)
    return best

# ----------------------------------------------------------------------------- main
def main():
    programs = sorted(f[:-3] for f in os.listdir(f"{QB}/python_programs") if f.endswith(".py") and not f.endswith("_test.py") and f != "node.py")
    report = []
    ops_used = set()
    for algo in programs:
        buggy_src = strip_docstring(open(f"{QB}/python_programs/{algo}.py").read())
        fixed_src = strip_docstring(open(f"{QB}/correct_python_programs/{algo}.py").read())
        b, f = code_lines(buggy_src), code_lines(fixed_src)
        bn = [norm(x) for x in b]; fn = [norm(x) for x in f]
        sm = difflib.SequenceMatcher(a=bn, b=fn, autojunk=False)
        hunks = [(tag, i1, i2, j1, j2) for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag != "equal"]
        # drop hunks that are only blank-line churn
        hunks = [h for h in hunks if any(bn[i] for i in range(h[1], h[2])) or any(fn[j] for j in range(h[3], h[4]))]
        removed = [i for h in hunks for i in range(h[1], h[2]) if bn[i]]
        added = [j for h in hunks for j in range(h[3], h[4]) if fn[j]]
        if len(removed) == 1 and len(added) == 1:
            kind = "replace_1"
        elif not removed and added:
            kind = f"insert_{len(added)}"
        elif removed and not added:
            kind = f"delete_{len(removed)}"
        elif len(removed) == 1 and len(added) > 1:
            kind = f"replace_1_with_{len(added)}"
        else:
            kind = f"multi_{len(removed)}_{len(added)}"
        file_idents = idents(buggy_src)
        # buggy line(s) in 1-based numbering; for insertions use the line at the insertion point
        if removed:
            buggy_lines = [i + 1 for i in removed]
        else:
            buggy_lines = sorted({h[1] + 1 for h in hunks} | {h[1] for h in hunks if h[1] > 0})
        covered_by, cand_at_bug, total_cands = None, 0, 0
        cand_dump = {"buggy_line_candidates": {}, "file_candidates": []}
        for i, line in enumerate(b):
            if not bn[i] or bn[i].startswith("#"):
                continue
            cands = gen_candidates(line, file_idents, ops_used)
            total_cands += len(cands)
            cand_dump["file_candidates"].append({"line": i + 1, "n": len(cands)})
            if i in removed:
                cand_at_bug += len(cands)
                cand_dump["buggy_line_candidates"] = {"line": i + 1, "original": b[i].strip(), "candidates": cands}
                if kind == "replace_1":
                    tgt = fn[added[0]]
                    if tgt in cands:
                        covered_by = cands[tgt]
                elif kind.startswith("delete") and "" in cands:
                    covered_by = "delete_stmt"
        graft = None
        if kind.startswith("insert") or kind.startswith("replace_1_with"):
            ins = [fn[j] for j in added]
            in_file = [x for x in ins if x in set(bn)]
            graft = f"{len(in_file)}/{len(ins)} inserted lines exist verbatim elsewhere in the buggy file"
            # template check for single inserted lines
            if len(ins) == 1:
                names = sorted(file_idents)
                for t in TEMPLATES:
                    for x in names:
                        for y in names + ["0", "1", "[]", "None", "True", "False"]:
                            if norm(t.format(x=x, y=y)) == ins[0]:
                                covered_by = covered_by or f"template:{t}"
        # SBFL
        res = run_tests(algo)
        sb = {}
        if isinstance(res, list) and res:
            executable = sorted({ln for r in res for ln in r["lines"]})
            scores, tf, tp = sbfl(res, executable)
            for idx, name in enumerate(("ochiai", "tarantula", "dstar")):
                r = einspect_rank(scores, idx, buggy_lines)
                sb[name] = None if r is None else {"einspect": round(r[0], 1), "worst": r[1], "ties": r[2]}
            sb["tests"] = {"fail": tf, "pass": tp, "executed_lines": len(executable),
                           "buggy_executed": [bl for bl in buggy_lines if bl in scores]}
        else:
            sb["error"] = res
        report.append({
            "program": algo, "kind": kind, "buggy_lines": buggy_lines,
            "removed": [b[i].strip() for i in removed], "added": [f[j].strip() for j in added],
            "covered_by": covered_by, "candidates_at_buggy_line": cand_at_bug, "candidates_whole_file": total_cands,
            "graft": graft, "sbfl": sb, "cands": cand_dump,
        })
        print(f"{algo:28s} {kind:18s} {str(covered_by):22s} cand@bug={cand_at_bug:4d} file={total_cands:5d} "
              f"ochiai={sb.get('ochiai')} tests={sb.get('tests')}", file=sys.stderr)
    covered = sum(1 for r in report if r["covered_by"])
    one_line = sum(1 for r in report if r["kind"] == "replace_1")
    print(f"\ncovered {covered}/{len(report)}; one-line replacements {one_line}; operators used: {sorted(ops_used)}", file=sys.stderr)
    json.dump({"n": len(report), "covered": covered, "rows": report}, sys.stdout, indent=1)

if __name__ == "__main__":
    main()
