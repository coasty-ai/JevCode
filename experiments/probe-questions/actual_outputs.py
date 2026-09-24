"""Run the buggy QuixBugs programs on their first 3 JSON test cases and record the actual output
(repr), the exception, or TIMEOUT. Output: actual-outputs.json {program: [{input, expected, actual}]}.
Usage: python3 actual_outputs.py [quixbugs_root] [n_tests]"""
import json, subprocess, sys, os
ROOT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/quixbugs'
NT = int(sys.argv[2]) if len(sys.argv) > 2 else 3
PROGS = ['bitcount','bucketsort','find_first_in_sorted','find_in_sorted','flatten','gcd','get_factors','hanoi',
 'is_valid_parenthesization','kheapsort','knapsack','kth','lcs_length','levenshtein','lis','longest_common_subsequence',
 'max_sublist_sum','mergesort','next_palindrome','next_permutation']
RUNNER = r'''
import sys, json, types, copy
sys.setrecursionlimit(5000)
name, args = sys.argv[1], json.loads(sys.argv[2])
mod = __import__(name)
fn = getattr(mod, name)
try:
    out = fn(*copy.deepcopy(args))
    if isinstance(out, types.GeneratorType): out = list(out)
    print(json.dumps({"ok": True, "value": repr(out)}))
except BaseException as e:
    print(json.dumps({"ok": False, "value": f"raises {type(e).__name__}: {str(e)[:120]}"}))
'''
res = {}
for p in PROGS:
    cases = [json.loads(l) for l in open(f'{ROOT}/json_testcases/{p}.json') if l.strip()][:NT]
    rows = []
    for args, expected in cases:
        try:
            r = subprocess.run([sys.executable, '-c', RUNNER, p, json.dumps(args)], cwd=f'{ROOT}/python_programs',
                               capture_output=True, text=True, timeout=4)
            out = json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {"ok": False, "value": "no output: " + r.stderr[-200:]}
            actual = out["value"]
        except subprocess.TimeoutExpired:
            actual = "TIMEOUT (no result after 4 s; likely an infinite loop or unbounded recursion)"
        rows.append({"input": args, "expected": expected, "actual": actual})
    res[p] = rows
    print(p, [r["actual"][:50] for r in rows])
json.dump(res, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'actual-outputs.json'), 'w'), indent=1)
