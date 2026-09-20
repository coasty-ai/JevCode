#!/usr/bin/env python3
"""Judge 2 (reliability and cost): recompute the test-run / Jev-request totals the four designs
argue about, straight from the verified JSONL files. No Jev calls. Run:
    python3 experiments/judge2/recompute.py
"""
import json, statistics, os
R = os.path.join(os.path.dirname(__file__), '..', 'results')
def rows(f): return [json.loads(l) for l in open(os.path.join(R, f)) if l.strip()]

proto = rows('prototype-baseline.jsonl')
truth = rows('contrarian-exhaustive.truth.jsonl')
allr  = rows('contrarian-exhaustive.all.jsonl')
arb_t = rows('contrarian-arbitrate.truth.jsonl')
arb_a = rows('contrarian-arbitrate.all.jsonl')

print('prototype: programs', len(proto), 'testRuns', sum(r['testRuns'] for r in proto),
      'jevRequests', sum(r['jevRequests'] for r in proto), 'cost $%.4f' % sum(r['costUsd'] for r in proto),
      'wall sum s', round(sum(r['wallMs'] for r in proto)/1000, 1))
by = {r['name']: r for r in truth}
est = sum(r['testRuns'] * by[r['name']]['runMsMean'] / 1000 for r in proto if by[r['name']]['runMsMean'] > 0)
print('prototype: est. test CPU s (runs x contrarian per-program mean run ms)', round(est, 1))
for name, rs in (('contrarian truth-line', truth), ('contrarian brute-force', allr)):
    print(name, 'runs', sum(r['nRuns'] for r in rs), 'CPU s', sum(r['cpuSecondsEstimate'] for r in rs),
          'wall s', round(sum(r['wallMs'] for r in rs)/1000), 'median wall/program s',
          round(statistics.median(r['wallMs'] for r in rs)/1000, 1), 'max', round(max(r['wallMs'] for r in rs)/1000, 1),
          'goldPlausible', sum(r['goldPlausible'] for r in rs), '>=2 plausible', sum(r['nPlausible'] >= 2 for r in rs),
          '0 plausible', [r['name'] for r in rs if r['nPlausible'] == 0])
print('ratio truth-line CPU / prototype est CPU: %.1fx' % (sum(r['cpuSecondsEstimate'] for r in truth) / est))
print('ratio brute-force CPU / prototype est CPU: %.1fx' % (sum(r['cpuSecondsEstimate'] for r in allr) / est))
print('ratio truth-line runs / prototype runs: %.1fx' % (sum(r['nRuns'] for r in truth) / sum(r['testRuns'] for r in proto)))
print('\narbitration Nouls on the GOLD candidate (the "genuine fix" question class):')
for tag, rs in (('truth', arb_t), ('all', arb_a)):
    g = [(r['name'], r.get('noulGold')) for r in rs if r.get('noulGold') is not None]
    print(' ', tag, 'n', len(g), 'gold Noul < 0.7:', [(n, p) for n, p in g if p < 0.7], '| < 0.3:', [(n, p) for n, p in g if p < 0.3])
    print('   cost $%.4f' % sum(r['costUsd'] for r in rs), 'p50 ms', round(statistics.median(r['latencyMs'] for r in rs)))
