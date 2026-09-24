"""Build the Markdown tables for experiments/results/probe-localization.md from the row files."""
import json, os, statistics, glob
HERE = os.path.dirname(os.path.abspath(__file__))
VAR = ['A_choice_3tests', 'B_choice_0tests', 'C_noul_per_line', 'D_choice_actual_output', 'E_hierarchical']
SHORT = {'A_choice_3tests': 'A', 'B_choice_0tests': 'B', 'C_noul_per_line': 'C', 'D_choice_actual_output': 'D', 'E_hierarchical': 'E'}

def load(path):
    return json.load(open(path))

def rank(r):
    return r['rank'] if r['rank'] is not None else float('inf')

def summary(rows, label):
    out = [f'| Variant ({label}) | n | top-1 | top-3 | MRR | cost | Jev p50 | input tokens |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
    for v in VAR:
        rs = [r for r in rows if r['variant'] == v]
        if not rs: continue
        t1 = sum(1 for r in rs if rank(r) == 1); t3 = sum(1 for r in rs if rank(r) <= 3)
        mrr = sum(1 / rank(r) for r in rs if rank(r) != float('inf')) / len(rs)
        lat = sorted(r['latencyMs'] for r in rs if r['requests'] > 0)
        p50 = f'{statistics.median(lat):.0f} ms' if lat else 'n/a'
        cost = sum(r['costUsd'] for r in rs); tok = sum(r['inputTokens'] for r in rs)
        out.append(f'| {SHORT[v]} {v[2:]} | {len(rs)} | {t1}/{len(rs)} ({100*t1/len(rs):.0f} %) | {t3}/{len(rs)} ({100*t3/len(rs):.0f} %) | {mrr:.3f} | ${cost:.4f} | {p50} | {tok:,} |')
    return '\n'.join(out)

def per_program(rows):
    progs = sorted({r['program'] for r in rows})
    out = ['| Program | lines | truth (L#) | kind | A | B | C | D | E |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    for p in progs:
        rs = {r['variant']: r for r in rows if r['program'] == p}
        a = rs['A_choice_3tests']
        cells = []
        for v in VAR:
            r = rs.get(v)
            if not r: cells.append('-'); continue
            rk = rank(r); cells.append(('**1**' if rk == 1 else f'{int(rk) if rk != float("inf") else "-"}') + f' ({r["pTruth"]:.2f})')
        out.append(f'| {p} | {a["nLines"]} | {"/".join(map(str, a["truth"]))} | {a["truthKind"]} | ' + ' | '.join(cells) + ' |')
    return '\n'.join(out)

def calibration(rows, variants, label):
    bins = [(0, 0.3), (0.3, 0.5), (0.5, 0.7), (0.7, 0.9), (0.9, 1.01)]
    out = [f'| P(top-1) bin ({label}) | n | top-1 correct | accuracy | mean P |', '| --- | --- | --- | --- | --- |']
    for lo, hi in bins:
        rs = [r for r in rows if r['variant'] in variants and lo <= r.get('pTop', 0) < hi]
        if not rs: out.append(f'| [{lo:.1f}, {min(hi,1):.1f}) | 0 | - | - | - |'); continue
        c = sum(1 for r in rs if rank(r) == 1)
        out.append(f'| [{lo:.1f}, {min(hi,1):.1f}) | {len(rs)} | {c} | {c/len(rs):.2f} | {statistics.mean(r["pTop"] for r in rs):.2f} |')
    rs = [r for r in rows if r['variant'] in variants]
    brier = statistics.mean((r.get('pTop', 0) - (1 if rank(r) == 1 else 0)) ** 2 for r in rs)
    out.append(f'\nBrier score of P(top-1) against top-1 correctness: {brier:.3f} (n={len(rs)}).')
    return '\n'.join(out)

def repeats(runs):
    # runs: list of row lists; agreement of top-1 across runs per variant
    out = ['| Variant | top-1 per run | programs with same top-1 in all runs | programs correct in all runs | correct in some runs only |', '| --- | --- | --- | --- | --- |']
    for v in VAR:
        per = [{r['program']: r for r in rows if r['variant'] == v} for rows in runs]
        progs = sorted(set.intersection(*[set(d.keys()) for d in per]))
        t1s = [sum(1 for p in progs if rank(d[p]) == 1) for d in per]
        same = sum(1 for p in progs if len({d[p]['top1'] for d in per}) == 1)
        allc = sum(1 for p in progs if all(rank(d[p]) == 1 for d in per))
        somec = sum(1 for p in progs if any(rank(d[p]) == 1 for d in per) and not all(rank(d[p]) == 1 for d in per))
        out.append(f'| {SHORT[v]} | {" / ".join(map(str, t1s))} | {same}/{len(progs)} | {allc} | {somec} |')
    return '\n'.join(out)

def swe(data):
    rows, calib = data['rows'], data['calib']
    out = []
    for v, label in [('choice_files', 'Choice over candidate files'), ('noul_per_file_60', 'Noul per file, 60 files')]:
        rs = [r for r in rows if r['variant'] == v]
        t1 = sum(1 for r in rs if rank(r) == 1); t5 = sum(1 for r in rs if rank(r) <= 5)
        mrr = sum(1 / rank(r) for r in rs if rank(r) != float('inf')) / len(rs)
        lat = sorted(r['latencyMs'] for r in rs)
        out.append(f'| {label} | {len(rs)} | {t1}/{len(rs)} ({100*t1/len(rs):.0f} %) | {t5}/{len(rs)} ({100*t5/len(rs):.0f} %) | {mrr:.3f} | ${sum(r["costUsd"] for r in rs):.4f} | {statistics.median(lat):.0f} ms | {sum(r["inputTokens"] for r in rs):,} | {statistics.mean(r["nCandidates"] for r in rs):.0f} |')
    head = ['| Variant | n | top-1 | top-5 | MRR | cost | Jev p50 | input tokens | mean candidates |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'[:-6]]
    tbl = '\n'.join(head + out)
    per = ['| Instance | candidates (same-dir) | gold file(s) | Choice rank | P(top) | P(gold) | Choice top-1 | Noul-60 rank | P(gold) | files p>=0.5 | Noul top-1 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    ch = {r['instance']: r for r in rows if r['variant'] == 'choice_files'}
    no = {r['instance']: r for r in rows if r['variant'] == 'noul_per_file_60'}
    for i in sorted(ch):
        c, n = ch[i], no[i]
        fr = lambda r: '**1**' if rank(r) == 1 else (str(int(rank(r))) if rank(r) != float('inf') else '-')
        per.append(f'| {i} | {c["nCandidates"]} ({c["dirPool"]}) | {", ".join(g.split("/")[-1] for g in c["gold"])} | {fr(c)} | {c["pTop"]:.2f} | {c["pGold"]:.2f} | `{c["top1"]}` | {fr(n)} | {n["pGold"]:.2f} | {n["nAbove05"]} | `{n["top1"]}` |')
    bins = [(0, 0.1), (0.1, 0.3), (0.3, 0.5), (0.5, 0.7), (0.7, 0.9), (0.9, 1.01)]
    cal = ['| Noul p bin | files | gold files | fraction gold | mean p |', '| --- | --- | --- | --- | --- |']
    for lo, hi in bins:
        cs = [c for c in calib if lo <= c['p'] < hi]
        if not cs: cal.append(f'| [{lo:.1f}, {min(hi,1):.1f}) | 0 | - | - | - |'); continue
        g = sum(1 for c in cs if c['isGold'])
        cal.append(f'| [{lo:.1f}, {min(hi,1):.1f}) | {len(cs)} | {g} | {g/len(cs):.3f} | {statistics.mean(c["p"] for c in cs):.3f} |')
    ng = sum(1 for c in calib if c['isGold']); nn = len(calib) - ng
    cal.append(f'\nBase rate of gold among the {len(calib)} Noul-judged files: {ng}/{len(calib)} = {ng/len(calib):.3f}. Brier of Noul p against is-gold: {statistics.mean((c["p"] - (1 if c["isGold"] else 0))**2 for c in calib):.3f}; a constant prediction at the base rate scores {(ng/len(calib))*(1-ng/len(calib)):.3f}.')
    return tbl, '\n'.join(per), '\n'.join(cal)

if __name__ == '__main__':
    run1 = load(os.path.join(HERE, 'quixbugs-localize.rows.json'))
    reps = [run1] + [load(p) for p in sorted(glob.glob(os.path.join(HERE, 'quixbugs-localize.rows.rep*.json')))]
    print('## QUIXBUGS SUMMARY (run 1)\n'); print(summary(run1, 'run 1'))
    pooled = [r for rows in reps for r in rows]
    print('\n## QUIXBUGS SUMMARY (pooled over %d runs)\n' % len(reps)); print(summary(pooled, f'{len(reps)} runs pooled'))
    print('\n## PER PROGRAM (run 1)\n'); print(per_program(run1))
    print('\n## CALIBRATION choice variants A,B,D (pooled)\n'); print(calibration(pooled, ['A_choice_3tests', 'B_choice_0tests', 'D_choice_actual_output'], 'Choice A/B/D'))
    print('\n## CALIBRATION C (pooled)\n'); print(calibration(pooled, ['C_noul_per_line'], 'Noul max-p, C'))
    if len(reps) > 1:
        print('\n## REPEATS\n'); print(repeats(reps))
    swep = os.path.join(HERE, 'swebench-files.rows.json')
    if os.path.exists(swep):
        t, p, c = swe(load(swep)); print('\n## SWE SUMMARY\n'); print(t); print('\n## SWE PER INSTANCE\n'); print(p); print('\n## SWE NOUL CALIBRATION\n'); print(c)
