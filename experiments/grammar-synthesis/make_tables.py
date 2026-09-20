"""Render the sketch-probe tables (per-item rows and totals) from out/sketch-*.json."""
import json, statistics, sys
from pathlib import Path
HERE = Path(__file__).parent
runs = {tag: json.load(open(HERE / 'out' / f'sketch-{tag}.json')) for tag in ['live-run1', 'live-run2', 'live-nouls-run1']}
r1, r2, r3 = (runs[k] for k in ['live-run1', 'live-run2', 'live-nouls-run1'])
rows1 = {r['name']: r for r in r1['rows']}; rows2 = {r['name']: r for r in r2['rows']}; rows3 = {r['name']: r for r in r3['rows']}
def rk(r): return '-' if r.get('rank') in (None, 0) else str(r['rank'])
def nrk(r): return '-' if r.get('noulRank') in (None, 0) else str(r['noulRank'])
def hit(r): return 'Y' if r.get('editRank') == 1 else 'n'
print('| program | kind | edit class (code) | pool | covered (matching sketches) | best instantiating sketch | Choice rank r1 / r2 / r3 | P(sketch) r1 | P(top) r1 | P(escape) r1 | Noul rank r3 (max Noul) | edit-class top-1 r1 / r2 / r3 |')
print('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for name in sorted(rows1):
    a, b, c = rows1[name], rows2[name], rows3[name]
    print(f"| {name} | {a['kind']} | {a['editClass']} | {a['poolSize']} | {'Y' if a['covered'] else 'n'} ({a['matching']}) | `{a['gold']}` | {rk(a)} / {rk(b)} / {rk(c)} | {a['pGold'] if a['pGold'] is not None else '-'} | {a['pTop']:.2f} | {a['pEscape']:.2f} | {nrk(c)} ({c.get('noulMax', 0):.2f}) | {hit(a)} / {hit(b)} / {hit(c)} |")
print()
for tag, d in runs.items():
    s = d['summary']
    print(f"| {tag} | {s['n']} | {s['covered']}/40 | {s['poolMedian']} / {s['poolMax']} | {s['top1']}/40 | {s['top3']}/40 | {s['top5']}/40 | {s['mrr']:.2f} | {s['escapeArgmax']} | {s.get('noulTop1','-')} / {s.get('noulTop3','-')} / {s.get('noulTop5','-')} | {s['editTop1']}/40 | {s['editTop2']}/40 | ${s['costUsd']:.4f} | {s['latencyP50']:.0f} ms | {s['inputTokensMean']} |")
# stability
names = sorted(rows1)
same = sum(1 for n in names if rk(rows1[n]) == rk(rows2[n]))
top3all = sum(1 for n in names if all(rows[n].get('rank') and rows[n]['rank'] <= 3 for rows in (rows1, rows2, rows3)))
top3any = sum(1 for n in names if any(rows[n].get('rank') and rows[n]['rank'] <= 3 for rows in (rows1, rows2, rows3)))
hard = [n for n in names if all((rows[n].get('rank') or 99) >= 6 for rows in (rows1, rows2, rows3))]
print(f"\nsame rank r1 vs r2: {same}/40; top-3 in all three runs: {top3all}; in at least one: {top3any}; rank>=6 in every run: {hard}")
lowconf = [n for n in names if rows1[n]['pTop'] < 0.5]
print(f"P(top) < 0.5 in r1: {len(lowconf)} -> {lowconf}; of these the sketch was top-3: {sum(1 for n in lowconf if rows1[n].get('rank') and rows1[n]['rank']<=3)}")
hi = [n for n in names if rows1[n]['pTop'] >= 0.5]
print(f"P(top) >= 0.5 in r1: {len(hi)}, top-1 correct: {sum(1 for n in hi if rows1[n].get('rank')==1)}, top-3: {sum(1 for n in hi if rows1[n].get('rank') and rows1[n]['rank']<=3)}")
by_class = {}
for n in names:
    c = rows1[n]['editClass']; by_class.setdefault(c, []).append(rows1[n].get('rank') or 99)
for c, rs in sorted(by_class.items()): print(f"class {c}: n={len(rs)} top1={sum(1 for r in rs if r==1)} top3={sum(1 for r in rs if r<=3)}")
