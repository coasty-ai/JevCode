"""Test oracle over candidate replacements: for every program in candidates.json, substitute each
candidate for the buggy line and run the JSON test cases the gold program solves within 2 s each.
Source is exec'd (never imported) so Python's __pycache__ cannot serve a stale .pyc for a same-length
candidate written in the same second (this bit the first version). Writes candidate-pass.json
{program: [bool per candidate]} and candidate-pass-meta.json. Usage: python3 eval_candidates.py [quixbugs_root]"""
import json, subprocess, sys, os, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/quixbugs'
cands = json.load(open(os.path.join(HERE, 'candidates.json')))
RUNNER = r'''
import sys, json, types, copy, signal
sys.setrecursionlimit(5000)
name, src_path, tests_path = sys.argv[1], sys.argv[2], sys.argv[3]
tests = json.load(open(tests_path))
ns = {}
try:
    exec(compile(open(src_path).read(), name, 'exec'), ns)
    fn = ns[name]
except BaseException as e:
    print(json.dumps(["LOADFAIL"] * len(tests))); sys.exit(0)
def handler(*a): raise TimeoutError()
signal.signal(signal.SIGALRM, handler)
res = []
for args, expected in tests:
    signal.alarm(2)
    try:
        out = fn(*copy.deepcopy(args))
        if isinstance(out, types.GeneratorType): out = list(out)
        if isinstance(out, tuple): out = list(out)
        if isinstance(out, list): out = [list(x) if isinstance(x, tuple) else x for x in out]
        res.append("PASS" if out == expected else "FAIL")
    except TimeoutError:
        res.append("TIMEOUT")
    except BaseException as e:
        res.append("EXC")
    finally:
        signal.alarm(0)
print(json.dumps(res))
'''
ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
def run(name, src, tests, d):
    open(f'{d}/src.py', 'w').write(src)
    try:
        r = subprocess.run([sys.executable, '-c', RUNNER, name, f'{d}/src.py', f'{d}/tests.json'], cwd=d, capture_output=True, text=True, timeout=2 * len(tests) + 5, env=ENV)
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (subprocess.TimeoutExpired, IndexError, json.JSONDecodeError):
        return ["TIMEOUT"] * len(tests)
result, meta = {}, {}
for name, info in cands.items():
    src = open(f'{ROOT}/python_programs/{name}.py').read()
    i = src.find('\n"""'); code = src[:i] if i > 0 else src
    assert info['buggyLine'] in code.split('\n'), name
    gold = '\n'.join(info['fixedLine'] if l == info['buggyLine'] else l for l in code.split('\n'))
    all_tests = [json.loads(l) for l in open(f'{ROOT}/json_testcases/{name}.json') if l.strip()]
    with tempfile.TemporaryDirectory() as d:
        json.dump(all_tests, open(f'{d}/tests.json', 'w'))
        gold_res = run(name, gold, all_tests, d)
        tests = [t for t, r in zip(all_tests, gold_res) if r == "PASS"]
        json.dump(tests, open(f'{d}/tests.json', 'w'))
        flags = []
        for c in info['cands']:
            patched = '\n'.join(c if l == info['buggyLine'] else l for l in code.split('\n'))
            flags.append(all(r == "PASS" for r in run(name, patched, tests, d)))
    result[name] = flags
    meta[name] = {"tests_total": len(all_tests), "tests_used": len(tests), "gold_results": gold_res, "passing": [info['cands'][k] for k, f in enumerate(flags) if f]}
    print(f"{name:28s} cands={len(flags):3d} tests={len(tests)}/{len(all_tests)} passing={sum(flags)} gold_passes={flags[info['cands'].index(info['fixedLine'])]} passing_texts={[t.strip() for t in meta[name]['passing']]}")
json.dump(result, open(os.path.join(HERE, 'candidate-pass.json'), 'w'))
json.dump(meta, open(os.path.join(HERE, 'candidate-pass-meta.json'), 'w'), indent=1)
