#!/usr/bin/env python3
"""Turn results.json into Markdown tables (printed to stdout) for probe-swebench-understanding.md."""
import json, statistics, sys
from collections import Counter, defaultdict

DIR = '/Users/prateekjannu/Documents/vscode/JevCode/experiments/probe-swebench-understand'
res = json.load(open(sys.argv[1] if len(sys.argv) > 1 else f'{DIR}/results.json'))
rows = res['rows']
labels = json.load(open(f'{DIR}/labels.json'))
prep = {p['instance_id']: p for p in json.load(open(f'{DIR}/prepared.json'))}
order = [p['instance_id'] for p in json.load(open(f'{DIR}/prepared.json'))]
short = lambda iid: iid.replace('sympy__sympy-', 'sympy-').replace('django__django-', 'django-').replace('pytest-dev__pytest-', 'pytest-').replace('pylint-dev__pylint-', 'pylint-').replace('psf__requests-', 'requests-')
by = defaultdict(list)
for r in rows: by[(r['q'], r['variant'])].append(r)
def p50(xs): xs = sorted(xs); return xs[len(xs) // 2] if xs else None
def pct(a, b): return f'{a}/{b} ({100 * a / b:.0f}%)' if b else '-'
def mrr(ranks): return sum(1 / r for r in ranks if r) / len(ranks) if ranks else 0

print('## Run summary\n')
print(f"| Requests | Cost (USD) | Jev latency p50 / p90 (ms) | Max input tokens in one request | Errors |\n| --- | --- | --- | --- | --- |")
print(f"| {res['requests']} | {res['cost_usd']:.4f} | {res['latency_p50_ms']:.0f} / {res['latency_p90_ms']:.0f} | {res['max_input_tokens']:,} | {len(res['errors'])} |\n")
print('Per question: requests, tokens per request (p50 / max), cost, latency p50.\n')
print('| Question | Variant | n | input tokens p50 | input tokens max | cost (USD) | latency p50 (ms) |\n| --- | --- | --- | --- | --- | --- | --- |')
for (q, v), rs in sorted(by.items()):
    print(f"| {q} | {v} | {len(rs)} | {p50([r['input_tokens'] for r in rs]):,} | {max(r['input_tokens'] for r in rs):,} | {sum(r['cost_usd'] for r in rs):.4f} | {p50([r['latency_ms'] for r in rs]):.0f} |")

# ------------------------------------------------------------------ Q1
print('\n## Q1 change kind\n')
for v in ('ps', 'ps_hints'):
    rs = by[('Q1', v)]
    if not rs: continue
    strict = sum(r['metrics']['strict_hit'] for r in rs); lenient = sum(r['metrics']['lenient_hit'] for r in rs)
    top2 = sum(1 for r in rs if r['metrics']['rank_primary'] in (1, 2))
    noul_hit = sum(1 for r in rs if (r['metrics']['noul_primary'] or 0) > 0.5)
    noul_any_ok = sum(1 for r in rs if any(k in set([labels[r['instance_id']]['primary']] + labels[r['instance_id']]['also_ok']) for k in r['metrics']['nouls_over_0_5']))
    mean_over = statistics.mean(len(r['metrics']['nouls_over_0_5']) for r in rs)
    print(f"| Variant `{v}` | n | Choice top-1 = primary label | Choice top-1 in {{primary, also_ok}} | primary in Choice top-2 | MRR (primary) | Noul(primary) > 0.5 | any Noul > 0.5 is an accepted label | mean kinds with Noul > 0.5 |")
    print('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    print(f"| | {len(rs)} | {pct(strict, len(rs))} | {pct(lenient, len(rs))} | {pct(top2, len(rs))} | {mrr([r['metrics']['rank_primary'] for r in rs]):.2f} | {pct(noul_hit, len(rs))} | {pct(noul_any_ok, len(rs))} | {mean_over:.1f} |\n")
rs = by[('Q1', 'ps')]
print('Confusion (rows: my primary label, columns: Jev top-1, variant `ps`):\n')
conf = Counter((labels[r['instance_id']]['primary'], r['metrics']['top1']) for r in rs)
kinds = ['fix_wrong_value', 'add_guard_or_check', 'add_branch_or_case', 'change_call_or_arguments', 'add_new_function_or_method', 'change_signature', 'change_message_or_formatting', 'config_or_metadata', 'refactor_without_behaviour_change', 'none_of_these']
ab = {k: ''.join(w[0] for w in k.split('_'))[:4] for k in kinds}
print('| label \\ jev | ' + ' | '.join(ab[k] for k in kinds) + ' |'); print('| --- |' + ' --- |' * len(kinds))
for a in kinds:
    if not any(conf[(a, b)] for b in kinds): continue
    print(f'| {a} | ' + ' | '.join(str(conf[(a, b)] or '') for b in kinds) + ' |')
print('\nAbbreviations: ' + ', '.join(f'{ab[k]} = {k}' for k in kinds) + '.\n')
print('Per instance (variant `ps`; `+h` column is the top-1 with hints):\n')
print('| Instance | My label (also ok) | Jev top-1 (p) | p(label) | Noul(label) | Nouls > 0.5 | top-1 +h |\n| --- | --- | --- | --- | --- | --- | --- |')
h = {r['instance_id']: r for r in by[('Q1', 'ps_hints')]}
for r in sorted(rs, key=lambda r: order.index(r['instance_id'])):
    m = r['metrics']; L = labels[r['instance_id']]
    mark = '' if m['strict_hit'] else (' ~' if m['lenient_hit'] else ' x')
    hh = h.get(r['instance_id']); ht = hh['metrics']['top1'] if hh else '-'
    print(f"| {short(r['instance_id'])} | {L['primary']} ({', '.join(L['also_ok']) or '-'}) | {m['top1']} ({m['p_top1']:.2f}){mark} | {m['p_primary']:.2f} | {(m['noul_primary'] if m['noul_primary'] is not None else float('nan')):.2f} | {', '.join(m['nouls_over_0_5']) or '-'} | {ht}{'' if not hh or hh['metrics']['strict_hit'] else (' ~' if hh['metrics']['lenient_hit'] else ' x')} |")

# ------------------------------------------------------------------ Q2
print('\n## Q2 function-level localisation in the gold file\n')
for v in ('ps', 'ps_hints'):
    rs = by[('Q2', v)]
    if not rs: continue
    t1 = sum(r['metrics']['top1_hit'] for r in rs); t5 = sum(r['metrics']['top5_hit'] for r in rs)
    pr1 = sum(1 for r in rs if r['metrics']['rank_primary'] == 1)
    print(f"| Variant `{v}` | n (gold files) | top-1 (any touched fn) | top-5 | MRR | top-1 = primary touched fn | median options | escape mass max |\n| --- | --- | --- | --- | --- | --- | --- | --- |")
    print(f"| | {len(rs)} | {pct(t1, len(rs))} | {pct(t5, len(rs))} | {mrr([r['metrics']['rank'] for r in rs]):.2f} | {pct(pr1, len(rs))} | {p50([r['metrics']['n_options'] for r in rs])} | {max(r['metrics']['p_escape'] for r in rs):.2f} |\n")
rs = by[('Q2', 'ps')]; h = {(r['instance_id'], r['file']): r for r in by[('Q2', 'ps_hints')]}
print('Per gold file (variant `ps`):\n')
print('| Instance | File | options | touched (truth) | Jev top-1 (p) | rank | p(primary) | rank +h |\n| --- | --- | --- | --- | --- | --- | --- | --- |')
for r in sorted(rs, key=lambda r: (order.index(r['instance_id']), r['file'])):
    m = r['metrics']; hh = h.get((r['instance_id'], r['file']))
    truth = r['truth']['touched']; tshow = ', '.join(truth[:3]) + (f' (+{len(truth) - 3})' if len(truth) > 3 else '')
    print(f"| {short(r['instance_id'])} | {r['file']} | {m['n_options']} | {tshow} | {m['top1']} ({m['p_top1']:.2f}) | {m['rank'] or '>all'} | {m['p_primary']:.2f} | {hh['metrics']['rank'] if hh else '-'} |")

# ------------------------------------------------------------------ Q3
print('\n## Q3 file-level Nouls over the package\n')
for v in ('outline', 'paths'):
    rs = by[('Q3', v)]
    if not rs: continue
    def agg(t):
        tp = sum(r['metrics'][t]['tp'] for r in rs); sel = sum(r['metrics'][t]['selected'] for r in rs); gold = sum(r['metrics']['n_gold'] for r in rs)
        return f"P {tp}/{sel} = {tp / sel if sel else 0:.2f}, R {tp}/{gold} = {tp / gold if gold else 0:.2f}"
    r1 = sum(1 for r in rs if r['metrics']['rank_first_gold'] == 1)
    perfect5 = sum(1 for r in rs if r['metrics']['at_0_5']['tp'] == r['metrics']['n_gold'] and r['metrics']['at_0_5']['selected'] == r['metrics']['n_gold'])
    print(f"| Variant `{v}` | n (packages) | files p50 | micro P/R at 0.5 | micro P/R at 0.7 | gold ranked first | exact set at 0.5 | MRR (first gold) |\n| --- | --- | --- | --- | --- | --- | --- | --- |")
    print(f"| | {len(rs)} | {p50([r['metrics']['n_files'] for r in rs])} | {agg('at_0_5')} | {agg('at_0_7')} | {pct(r1, len(rs))} | {pct(perfect5, len(rs))} | {mrr([r['metrics']['rank_first_gold'] for r in rs]):.2f} |\n")
rs = by[('Q3', 'outline')]; h = {(r['instance_id'], r['file']): r for r in by[('Q3', 'paths')]}
print('Per package (variant `outline`; `paths` gives the same measures without symbol outlines):\n')
print('| Instance | Package | files | gold files: p | selected at 0.5 (tp) | at 0.7 (tp) | rank of first gold | max p non-gold | paths: rank / sel at 0.5 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for r in sorted(rs, key=lambda r: (order.index(r['instance_id']), r['file'])):
    m = r['metrics']; hh = h.get((r['instance_id'], r['file']))
    pg = ', '.join(f"{k.split('/')[-1]} {v:.2f}" for k, v in m['p_gold'].items())
    print(f"| {short(r['instance_id'])} | {r['file']} | {m['n_files']} | {pg} | {m['at_0_5']['selected']} ({m['at_0_5']['tp']}) | {m['at_0_7']['selected']} ({m['at_0_7']['tp']}) | {m['rank_first_gold'] or '-'} | {m['max_nongold']:.2f} | {hh['metrics']['rank_first_gold'] if hh else '-'} / {hh['metrics']['at_0_5']['selected'] if hh else '-'} |")

# ------------------------------------------------------------------ Q4
print('\n## Q4 line-level localisation inside the gold function\n')
for v in ('names', 'names_testcode'):
    rs = by[('Q4', v)]
    if not rs: continue
    t1 = sum(r['metrics']['top1_tol3'] for r in rs); t5 = sum(r['metrics']['top5_tol3'] for r in rs); ex = sum(r['metrics']['top1_exact'] for r in rs)
    insts = {r['instance_id'] for r in rs}
    # per-instance primary function = the touched function with most changed lines
    prim = []
    for iid in insts:
        cand = [r for r in rs if r['instance_id'] == iid]
        best = max(cand, key=lambda r: len(r['truth']['targets']))
        prim.append(best)
    p1 = sum(r['metrics']['top1_tol3'] for r in prim); p5 = sum(r['metrics']['top5_tol3'] for r in prim)
    print(f"| Variant `{v}` | n (functions) | top-1 within +-3 | top-5 within +-3 | top-1 exact | MRR (+-3) | median lines | n (instances, primary fn) | top-1 +-3 | top-5 +-3 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    print(f"| | {len(rs)} | {pct(t1, len(rs))} | {pct(t5, len(rs))} | {pct(ex, len(rs))} | {mrr([r['metrics']['rank_tol3'] for r in rs]):.2f} | {p50([r['metrics']['n_lines'] for r in rs])} | {len(prim)} | {pct(p1, len(prim))} | {pct(p5, len(prim))} |\n")
rs = by[('Q4', 'names')]; h = {(r['instance_id'], r['fn']): r for r in by[('Q4', 'names_testcode')]}
print('Per touched function (variant `names`; last column: rank within +-3 when the added test code is in the state):\n')
print('| Instance | Function | lines | truth lines | Jev top-1 (p) | rank +-3 | rank exact | +testcode rank +-3 |\n| --- | --- | --- | --- | --- | --- | --- | --- |')
for r in sorted(rs, key=lambda r: (order.index(r['instance_id']), r['fn'])):
    m = r['metrics']; hh = h.get((r['instance_id'], r['fn'])); t = r['truth']['targets']
    print(f"| {short(r['instance_id'])} | {r['fn']} | {m['n_lines']} | {', '.join(map(str, t[:4]))}{' ...' if len(t) > 4 else ''} | {m['top1'][5:]} ({m['p_top1']:.2f}) | {m['rank_tol3'] or '>all'} | {m['rank_exact'] or '>all'} | {hh['metrics']['rank_tol3'] if hh else '-'} |")

# ------------------------------------------------------------------ Q4 per instance (primary function)
print('\n### Q4 per instance, primary touched function (most changed lines)\n')
print('| Instance | Primary function | lines | truth lines | names: top-1 (p) | rank +-3 | rank exact | +testcode: rank +-3 |\n| --- | --- | --- | --- | --- | --- | --- | --- |')
rs = by[('Q4', 'names')]; h = {(r['instance_id'], r['fn']): r for r in by[('Q4', 'names_testcode')]}
for iid in order:
    cand = [r for r in rs if r['instance_id'] == iid]
    if not cand: print(f'| {short(iid)} | (module-level change only) | | | | | | |'); continue
    r = max(cand, key=lambda r: len(r['truth']['targets'])); m = r['metrics']; hh = h.get((iid, r['fn'])); t = r['truth']['targets']
    print(f"| {short(iid)} | {r['fn']} | {m['n_lines']} | {', '.join(map(str, t[:4]))}{' ...' if len(t) > 4 else ''} | {m['top1'][5:]} ({m['p_top1']:.2f}) | {m['rank_tol3'] or '>all'} | {m['rank_exact'] or '>all'} | {hh['metrics']['rank_tol3'] if hh else '-'} |")

# ------------------------------------------------------------------ Q5 / Q6 (repo scale)
try:
    rep = json.load(open(f'{DIR}/results-repo.json'))
except FileNotFoundError:
    rep = None
if rep:
    q5 = [r for r in rep['rows'] if r['q'] == 'Q5']; q6 = [r for r in rep['rows'] if r['q'] == 'Q6']
    print('\n## Q5 directory-level Choice over the whole repository\n')
    print(f"| n | dirs p50 (min-max) | top-1 | top-5 | MRR | escape mass max | input tokens p50 / max | cost (USD) | latency p50 (ms) |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    nd = [r['n_options'] - 1 for r in q5]
    print(f"| {len(q5)} | {p50(nd)} ({min(nd)}-{max(nd)}) | {pct(sum(r['metrics']['top1_hit'] for r in q5), len(q5))} | {pct(sum(r['metrics']['top5_hit'] for r in q5), len(q5))} | {mrr([r['metrics']['rank'] for r in q5]):.2f} | {max(r['metrics']['p_escape'] for r in q5):.2f} | {p50([r['input_tokens'] for r in q5]):,} / {max(r['input_tokens'] for r in q5):,} | {sum(r['cost_usd'] for r in q5):.4f} | {p50([r['latency_ms'] for r in q5]):.0f} |\n")
    print('| Instance | dirs | gold dir: p | Jev top-1 (p) | rank |\n| --- | --- | --- | --- | --- |')
    for r in sorted(q5, key=lambda r: order.index(r['instance_id'])):
        m = r['metrics']; pg = ', '.join('%s %.2f' % (k, v) for k, v in m['p_gold'].items())
        print('| %s | %d | %s | %s (%.2f) | %s |' % (short(r['instance_id']), r['n_options'] - 1, pg, m['top1'], m['p_top1'], m['rank'] or '>all'))
    print('\n## Q6 repo-wide file Nouls (every source .py file, paths only)\n')
    n = len(q6)
    def agg(t):
        tp = sum(r['metrics'][t]['tp'] for r in q6); sel = sum(r['metrics'][t]['selected'] for r in q6); g = sum(len(r['truth']) for r in q6)
        return 'P %d/%d = %.2f, R %d/%d = %.2f' % (tp, sel, tp / sel if sel else 0, tp, g, tp / g)
    rk = [r['metrics']['rank_first_gold'] for r in q6]
    print(f"| n | files p50 (min-max) | requests per instance | gold ranked 1 | <= 5 | <= 10 | MRR | micro P/R at 0.5 | at 0.7 | at 0.9 | files selected at 0.5 p50 / max | tokens per instance p50 | cost (USD) |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    nf = [r['metrics']['n_files'] for r in q6]
    print(f"| {n} | {p50(nf)} ({min(nf)}-{max(nf)}) | {min(r['metrics']['requests'] for r in q6)}-{max(r['metrics']['requests'] for r in q6)} | {pct(sum(1 for x in rk if x == 1), n)} | {pct(sum(1 for x in rk if 1 <= x <= 5), n)} | {pct(sum(1 for x in rk if 1 <= x <= 10), n)} | {mrr(rk):.2f} | {agg('at_0_5')} | {agg('at_0_7')} | {agg('at_0_9')} | {p50([r['metrics']['at_0_5']['selected'] for r in q6])} / {max(r['metrics']['at_0_5']['selected'] for r in q6)} | {p50([r['input_tokens'] for r in q6]):,} | {sum(r['cost_usd'] for r in q6):.4f} |\n")
    print('| Instance | files | gold file: p (rank among all files) | selected at 0.5 (tp) | at 0.7 (tp) | strongest non-gold file (p) |\n| --- | --- | --- | --- | --- | --- |')
    for r in sorted(q6, key=lambda r: order.index(r['instance_id'])):
        m = r['metrics']; gold = set(r['truth']); ng = [(k, v) for k, v in m['top3'] if k not in gold][:1]
        pg = ', '.join('%s %.2f (#%d)' % (k.split('/')[-1], m['p_gold'][k], m['ranks_gold'][k]) for k in m['p_gold'])
        print('| %s | %d | %s | %d (%d) | %d (%d) | %s %.2f |' % (short(r['instance_id']), m['n_files'], pg, m['at_0_5']['selected'], m['at_0_5']['tp'], m['at_0_7']['selected'], m['at_0_7']['tp'], ng[0][0] if ng else '-', ng[0][1] if ng else 0))

    # ------------------------------------------------------------------ chained pipeline per instance
    print('\n## Chained view per instance (each stage given the previous stage\'s gold input)\n')
    print('Q6 file = gold file (primary) ranked first among all repo files; Q2 fn = a touched function in top-5 of the gold file (`ps`); Q4 line = a target line within +-3 in top-5 of the primary function (`names`). "all top-1" tightens every stage to top-1.\n')
    print('| Instance | Q5 dir top-1 | Q6 file rank | Q2 fn rank | Q4 line rank (+-3) | file#1 & fn<=5 & line<=5 | all top-1 |\n| --- | --- | --- | --- | --- | --- | --- |')
    c5 = c1 = nn = 0
    q6by = {r['instance_id']: r for r in q6}; q5by = {r['instance_id']: r for r in q5}
    for iid in order:
        p = prep[iid]; gf = max(p['gold_files'], key=lambda g: (sum(len(t['changed_lines']) for t in g['touched'] if t['qualname'] != '<module>'), sum(len(t['changed_lines']) for t in g['touched'])))
        r6 = q6by[iid]; frank = r6['metrics']['ranks_gold'].get(gf['path'], 0)
        r2 = [r for r in by[('Q2', 'ps')] if r['instance_id'] == iid and r['file'] == gf['path']][0]
        c4 = [r for r in by[('Q4', 'names')] if r['instance_id'] == iid and r['file'] == gf['path']]
        r4 = max(c4, key=lambda r: len(r['truth']['targets'])) if c4 else None
        lrank = r4['metrics']['rank_tol3'] if r4 else None
        ok5 = frank == 1 and 1 <= r2['metrics']['rank'] <= 5 and (lrank is None or 1 <= lrank <= 5)
        ok1 = frank == 1 and r2['metrics']['rank'] == 1 and (lrank is None or lrank == 1)
        nn += 1; c5 += ok5; c1 += ok1
        print(f"| {short(iid)} | {'yes' if q5by[iid]['metrics']['top1_hit'] else 'no (#%d)' % q5by[iid]['metrics']['rank']} | {frank or '>all'} | {r2['metrics']['rank'] or '>all'} | {lrank if lrank is not None else 'n/a (module-level)'} | {'yes' if ok5 else 'no'} | {'yes' if ok1 else 'no'} |")
    print(f'\nChained: {c5}/{nn} instances pass file top-1, function top-5 and line top-5; {c1}/{nn} pass every stage at top-1.')
