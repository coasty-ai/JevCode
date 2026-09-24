"""Render Markdown tables from out/*.json (used to assemble results/probe-token-synthesis.md)."""
import json, statistics as st
L = lambda f: json.load(open(f'out/{f}.json'))
tf, tp, b1, b3, b3g, eb = L('teacher-forced'), L('templates'), L('beam-w1'), L('beam-w3'), L('beam-w3-grammar'), L('edit-beam-w3')
corpus = json.load(open('out/corpus.json'))
names = [c['name'] for c in corpus]
def p50(xs): xs = sorted(xs); return xs[len(xs)//2] if xs else 0
Y = lambda b: 'Y' if b else '.'
out = []
# --- teacher forced by class
rows = tf['rows']
def acc(rs, k): return sum(1 for r in rs if 1 <= r['rank'] <= k)
def mrr(rs): return sum(1/r['rank'] for r in rs if r['rank']) / len(rs)
out.append('### T1. Teacher-forced next-token accuracy by token class (n = 426 positions, 40 lines)\n')
out.append('| Class | n | top-1 | top-3 | MRR | mean p(truth) | mean p(top) |\n| --- | --- | --- | --- | --- | --- | --- |')
for cls in ['identifier','punct','keyword','operator','number','literal','end']:
    rs = [r for r in rows if r['cls'] == cls]
    out.append(f"| {cls if cls!='end' else 'end_of_line'} | {len(rs)} | {acc(rs,1)} ({100*acc(rs,1)/len(rs):.0f}%) | {acc(rs,3)} ({100*acc(rs,3)/len(rs):.0f}%) | {mrr(rs):.2f} | {st.mean(r['p_truth'] for r in rs):.2f} | {st.mean(r['p_top'] for r in rs):.2f} |")
out.append(f"| **all** | {len(rows)} | {acc(rows,1)} ({100*acc(rows,1)/len(rows):.1f}%) | {acc(rows,3)} ({100*acc(rows,3)/len(rows):.1f}%) | {mrr(rows):.3f} | {st.mean(r['p_truth'] for r in rows):.2f} | {st.mean(r['p_top'] for r in rows):.2f} |")
out.append('\n### T2. Teacher-forced: calibration of p(top) against top-1 correctness\n')
out.append('| p(top) band | n | top-1 accuracy |\n| --- | --- | --- |')
bands = {}
for r in rows:
    b = min(9, int(r['p_top']*10))/10; bands.setdefault(b, []).append(r['rank']==1)
for b in sorted(bands): out.append(f"| {b:.1f}–{b+0.1:.1f} | {len(bands[b])} | {100*sum(bands[b])/len(bands[b]):.0f}% |")
# --- per line master table
out.append('\n### T3. Per-line results, all conditions (40 QuixBugs fix lines)\n')
out.append('Columns: `tok` = tokens in the fix line; `TF top1/top3` = teacher-forced positions correct out of tok+1 (incl. end_of_line); `W1`, `W3`, `W3g` = beam search width 1, 3, 3 with grammar filter: `E` exact token match, `P` passes tests (different tokens), `.` fail, `-` no completed beam; `W3 any`, `W3g any` = any of the top-3 completed beams passes tests; `Tpl cov` = correct template in the pool (source); `Tpl rk` = rank of the correct template; `Slot seq/par` = slot filling on the true template exact; `Tpl e2e` = top template then sequential slots; `Edit any` = edit-beam: any visited state passes tests (36 replace-kind lines only).\n')
out.append('| Program | kind | tok | TF top1 | TF top3 | W1 | W3 | W3 any | W3g | W3g any | Tpl cov | Tpl rk | Slot seq | Slot par | Tpl e2e | Edit any | Any method |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
def bm(r): return '-' if r['top_line'] is None else ('E' if r['top_exact'] else 'P' if r['top_pass'] else '.')
def bany(r): return 'E' if r['any_exact'] else 'P' if r['any_pass'] else '.'
union = 0
for c in corpus:
    n = c['name']; trs = [r for r in rows if r['name']==n]; r1 = next(r for r in b1['rows'] if r['name']==n); r3 = next(r for r in b3['rows'] if r['name']==n); r3g = next(r for r in b3g['rows'] if r['name']==n); t = next(r for r in tp['rows'] if r['name']==n); e = next((r for r in eb['rows'] if r['name']==n), None)
    solved = r3g['any_pass'] or r3['any_pass'] or r1['any_pass'] or t['e2e_pass'] or (e and e['any_state_pass'])
    union += bool(solved)
    out.append(f"| {n} | {c['kind']} | {r1['n_target']} | {acc(trs,1)}/{len(trs)} | {acc(trs,3)}/{len(trs)} | {bm(r1)} | {bm(r3)} | {bany(r3)} | {bm(r3g)} | {bany(r3g)} | {t['covered_by'] or 'no'} | {t['template_rank'] or ('none_of_these' if t['top_template']=='none_of_these' else 'n/a')} | {Y(t['tf_seq_exact'])} | {Y(t['tf_par_exact'])} | {'E' if t['e2e_exact'] else 'P' if t['e2e_pass'] else '.'} | {('E' if e['any_state_exact'] else 'P' if e['any_state_pass'] else '.') if e else 'n/a'} | {Y(solved)} |")
out.append(f"\nLines solved (tests pass) by at least one condition: **{union}/40**.\n")
# --- summary
out.append('### T4. Condition summary\n')
out.append('| Condition | n lines | top-scored exact | top-scored passes tests | any of top-3 passes tests | requests/line | cost/line | cost total | Jev p50 | wall p50/line |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for label, d in [('Beam W=1 (greedy)', b1), ('Beam W=3', b3), ('Beam W=3 + grammar filter', b3g)]:
    rs = d['rows']; u = d['usage']
    out.append(f"| {label} | {len(rs)} | {sum(r['top_exact'] for r in rs)} | {sum(r['top_pass'] for r in rs)} | {sum(r['any_pass'] for r in rs)} | {u['calls']/len(rs):.1f} | ${u['cost']/len(rs):.4f} | ${u['cost']:.4f} | {p50(u['lat']):.0f} ms | {p50([r['wall_ms'] for r in rs])/1000:.1f} s |")
rs = tp['rows']; u = tp['usage']
out.append(f"| Templates → sequential slots (e2e) | 40 | {sum(r['e2e_exact'] for r in rs)} | {sum(r['e2e_pass'] for r in rs)} | n/a | {u['calls']/40:.1f} | ${u['cost']/40:.4f} | ${u['cost']:.4f} | {p50(u['lat']):.0f} ms | {p50([r['wall_ms'] for r in rs])/1000:.1f} s |")
rs = eb['rows']; u = eb['usage']
out.append(f"| Edit-beam W=3 depth 3 (36 replace lines) | 36 | {sum(r['stop_top_exact'] for r in rs)} | {sum(r['stop_top_pass'] for r in rs)} | {sum(r['stop_any_pass'] for r in rs)} (stopped) / {sum(r['any_state_pass'] for r in rs)} (any visited state) | {u['calls']/36:.1f} | ${u['cost']/36:.4f} | ${u['cost']:.4f} | {p50(u['lat']):.0f} ms | {p50([r['wall_ms'] for r in rs])/1000:.1f} s |")
u = tf['usage']; out.append(f"| Teacher-forced (426 positions) | 40 | – | – | – | {u['calls']/40:.1f} | ${u['cost']/40:.4f} | ${u['cost']:.4f} | {p50(u['lat']):.0f} ms | – |")
tot = sum(L(f)['usage']['cost'] for f in ['teacher-forced','templates','beam-w1','beam-w3','beam-w3-grammar','edit-beam-w3']); calls = sum(L(f)['usage']['calls'] for f in ['teacher-forced','templates','beam-w1','beam-w3','beam-w3-grammar','edit-beam-w3'])
out.append(f"\nTotal live spend: **${tot:.4f}** over {calls} requests (all costs from `usage.costUsd`). Mean input tokens per request: teacher-forced {tf['usage']['inTok']//tf['usage']['calls']}, beam W=3 {b3['usage']['inTok']//b3['usage']['calls']}, beam W=3+grammar {b3g['usage']['inTok']//b3g['usage']['calls']}, templates {tp['usage']['inTok']//tp['usage']['calls']}, edit-beam {eb['usage']['inTok']//eb['usage']['calls']}.\n")
# --- templates summary
rs = tp['rows']
cov = [r for r in rs if r['covered']]
out.append('### T5. Template experiment summary\n')
out.append('| Measurement | Result |\n| --- | --- |')
out.append(f"| Pool size (buggy line + donor lines + mutants of the buggy line), mean / max | {st.mean(r['pool_size'] for r in rs):.1f} / {max(r['pool_size'] for r in rs)} |")
out.append(f"| Correct template in pool (coverage) | {len(cov)}/40 (from buggy line {sum(1 for r in cov if r['covered_by']=='buggy_line')}, mutant {sum(1 for r in cov if r['covered_by']=='mutant_of_buggy_line')}, donor line {sum(1 for r in cov if r['covered_by'].startswith('line_'))}) |")
out.append(f"| Template Choice top-1 / top-3 when covered | {sum(1 for r in cov if r['template_rank']==1)}/{len(cov)} / {sum(1 for r in cov if 1<=r['template_rank']<=3)}/{len(cov)} (mean p(truth) {st.mean(r['p_truth'] for r in cov):.2f}) |")
unc = [r for r in rs if not r['covered']]
out.append(f"| When not covered: picked `none_of_these` / picked the buggy line's template | {sum(1 for r in unc if r['top_template']=='none_of_these')}/{len(unc)} / {sum(1 for r in unc if r['top_template']!='none_of_these')}/{len(unc)} |")
out.append(f"| Slot filling on the true template, sequential (one Choice per slot, earlier slots filled) | {sum(r['tf_seq_exact'] for r in rs)}/40 exact |")
out.append(f"| Slot filling on the true template, parallel (all slots as independent Choices in one request) | {sum(r['tf_par_exact'] for r in rs)}/40 exact |")
out.append(f"| End to end (top-1 template, then sequential slots) exact / passes tests | {sum(r['e2e_exact'] for r in rs)}/40 / {sum(r['e2e_pass'] for r in rs)}/40 |")
out.append(f"| Slots per line, mean / max | {st.mean(r['n_slots'] for r in rs):.1f} / {max(r['n_slots'] for r in rs)} |")
open('out/tables.md','w').write('\n'.join(out)+'\n'); print('\n'.join(out))
