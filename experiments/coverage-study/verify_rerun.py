#!/usr/bin/env python3
"""Verification re-run (2026-09-20): recompute QuixBugs and a sample of SWE-bench instances with coverage_study.py
and compare per-hunk reach flags / per-line mutation hits against experiments/results/coverage-study.json.
Usage: python3 verify_rerun.py [instance_id ...]   (no args: QuixBugs only)"""
import json, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import coverage_study as cs

ROOT = cs.ROOT
saved = json.load(open(f'{ROOT}/experiments/results/coverage-study.json'))

def summarise(items):
    out = {}
    for it in items:
        for h in it['hunks']:
            key = (it['id'], h['file'], h['old_start'])
            out[key] = (h['kind'], tuple(sorted(h['reach'].items())), tuple((l['fixed'], l['mutation']['hit_depth'], l['mutation'].get('n_depth1'), l['donor'].get('min_subs')) for l in h['lines']), tuple(h['templates']))
    return out

def compare(name, new, old):
    a, b = summarise(new), summarise(old)
    missing = set(a) ^ set(b)
    diffs = [k for k in a if k in b and a[k] != b[k]]
    print(f'{name}: {len(a)} hunks recomputed, {len(b)} saved; key mismatches {len(missing)}, value mismatches {len(diffs)}')
    for k in list(missing)[:10]: print('  key only on one side:', k)
    for k in diffs[:10]: print('  differs:', k, '\n    new', a[k], '\n    old', b[k])
    return not missing and not diffs

t0 = time.time()
ok = compare('QuixBugs', cs.quixbugs(), saved['quixbugs'])
print(f'QuixBugs re-run {time.time() - t0:.1f}s ok={ok}')
ids = sys.argv[1:]
if ids:
    gold_all = json.load(open(f'{ROOT}/bench/data/swebench-verified-30.gold.json'))
    sub = {k: v for k, v in gold_all.items() if k in ids}
    orig_load = json.load
    def patched(fp, *a, **kw):
        d = orig_load(fp, *a, **kw)
        return sub if isinstance(d, dict) and set(gold_all) == set(d) else d
    json.load = patched
    t0 = time.time()
    res = cs.swebench()
    json.load = orig_load
    ok2 = compare('SWE-bench sample ' + ','.join(ids), res, [x for x in saved['swebench'] if x['id'] in ids])
    print(f'SWE sample re-run {time.time() - t0:.1f}s ok={ok2}')
