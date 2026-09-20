#!/usr/bin/env python3
"""Tables for the contrarian design from contrarian-exhaustive.*.jsonl and contrarian-arbitrate.*.jsonl (no Jev)."""
import json, sys, statistics as st
from pathlib import Path
R = Path(__file__).resolve().parents[1] / 'results'

def load(p):
    return [json.loads(l) for l in open(p) if l.strip()] if p.exists() else []

def med(xs): return st.median(xs) if xs else 0

def table(rows, scope):
    print(f"\n### Exhaustive verification, scope = {scope} (n = {len(rows)} programs)\n")
    print("| program | kind | lines tried | candidates | runs | plausible (lines) | gold | partial | timeouts | wall s | run ms p50 / mean / max |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        gold = 'absent (insert)' if r['truthKind'] != 'replace' else ('PASS' if r['goldPlausible'] else ('in set, FAILS' if r['goldInSet'] else 'not enumerated'))
        print(f"| {r['name']} | {r['truthKind']} | {r['linesTried']} | {r['nCandidates']} | {r['nRuns']} | {r['nPlausible']} ({r['plausibleLines']}) | {gold} | {r['nPartial']} | {r['nTimeout']} | {r['wallMs']/1000:.1f} | {r['runMsP50']} / {r['runMsMean']} / {r['runMsMax']} |")
    rep = [r for r in rows if r['truthKind'] == 'replace']
    print(f"\nTotals ({scope}): candidates {sum(r['nCandidates'] for r in rows)}, test runs {sum(r['nRuns'] for r in rows)}, wall {sum(r['wallMs'] for r in rows)/1000:.0f} s "
          f"(per program median {med([r['wallMs'] for r in rows])/1000:.1f} s, max {max(r['wallMs'] for r in rows)/1000:.1f} s), "
          f"CPU-seconds (sum of run durations) {sum(r['cpuSecondsEstimate'] for r in rows)}, concurrency {rows[0]['concurrency']}, per-test timeout {rows[0]['timeoutS']} s, cap {rows[0]['cap']}.")
    print(f"Replacement bugs: {len(rep)}; gold enumerated {sum(r['goldInSet'] for r in rep)}/{len(rep)}; gold passes all tests {sum(r['goldPlausible'] for r in rep)}/{len(rep)}.")
    print(f"Programs with >= 1 plausible: {sum(r['nPlausible']>=1 for r in rows)}/{len(rows)}; exactly 1: {sum(r['nPlausible']==1 for r in rows)}; >= 2: {sum(r['nPlausible']>=2 for r in rows)}; "
          f"plausible per program median {med([r['nPlausible'] for r in rows])}, max {max(r['nPlausible'] for r in rows)}; distinct lines with a plausible candidate median {med([r['plausibleLines'] for r in rows])}, max {max(r['plausibleLines'] for r in rows)}.")
    print(f"Candidates per program median {med([r['nCandidates'] for r in rows])}; run duration p50 over programs median {med([r['runMsP50'] for r in rows])} ms; programs whose run p50 > 1 s (timeout-dominated): {sum(r['runMsP50']>1000 for r in rows)}; partial (more tests pass) candidates total {sum(r['nPartial'] for r in rows)}.")
    # only-gold plausible at truth line
    if scope == 'truth':
        only = sum(1 for r in rep if r['nPlausible'] == 1 and r['goldPlausible'])
        print(f"Replacement bugs where the ONLY test-passing candidate is the gold line: {only}/{len(rep)} (no arbitration needed).")

def arb(rows_all, scope):
    if not rows_all: return
    rows = [r for r in rows_all if r.get('hasGold', True)]
    nogold = [r for r in rows_all if not r.get('hasGold', True)]
    print(f"\n### Jev arbitration among test-passing candidates, scope = {scope} (n = {len(rows)})\n")
    print("| program | plausible | Choice top = gold | P(gold) / P(top) / P(escape) | Noul top = gold | Noul(gold) / Noul(top) | min-edit baseline | cost | ms |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        print(f"| {r['name']} | {r['n']} | {'Y' if r['choiceHit'] else 'n'} | {r['pChoiceGold']:.2f} / {r['pChoiceTop']:.2f} / {r['pEscape']:.2f} | {'Y' if r['noulHit'] else 'n'} | {r['noulGold']:.2f} / {r['noulTopP']:.2f} | {'Y' if r['minEditHit'] else ('tie' if r['minEditTie'] else 'n')} | ${r['costUsd']:.4f} | {round(r['latencyMs'])} |")
    print(f"\nChoice top-1 {sum(r['choiceHit'] for r in rows)}/{len(rows)}, Noul top-1 {sum(r['noulHit'] for r in rows)}/{len(rows)}, min-edit {sum(r['minEditHit'] for r in rows)}/{len(rows)}; cost ${sum(r['costUsd'] for r in rows):.4f}; p50 {round(med([r['latencyMs'] for r in rows]))} ms")
    if nogold:
        print(f"\nPlausible sets with NO gold (every candidate overfits; insertion bugs or wrong lines), scope = {scope} (n = {len(nogold)}): escape argmax {sum(r['escapeArgmax'] for r in nogold)}/{len(nogold)}, max Noul < 0.5 on {sum(r['noulTopP'] < 0.5 for r in nogold)}/{len(nogold)}\n")
        print("| program | plausible | P(escape) | P(top) | max Noul | escape is argmax |")
        print("| --- | --- | --- | --- | --- | --- |")
        for r in nogold:
            print(f"| {r['name']} | {r['n']} | {r['pEscape']:.2f} | {r['pChoiceTop']:.2f} | {r['noulTopP']:.2f} | {'Y' if r['escapeArgmax'] else 'n'} |")
    print("\nCandidates per program (gold marked *):\n")
    for r in rows_all:
        print(f"- `{r['name']}`: " + '; '.join(f"{'*' if c['isGold'] else ''}L{c['line']} `{c['text']}` (choice {c['pChoice']:.2f}, noul {c['noul']:.2f})" for c in r['candidates']))

for scope in sys.argv[1:] or ['truth', 'all']:
    rows = load(R / f'contrarian-exhaustive.{scope}.jsonl')
    if rows: table(rows, scope)
    arb(load(R / f'contrarian-arbitrate.{scope}.jsonl'), scope)
