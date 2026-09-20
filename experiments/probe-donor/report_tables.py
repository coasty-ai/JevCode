"""Emit the Markdown tables for probe-donor-and-templates.md from out/*.json (no Jev calls)."""
import json, os, collections
HERE = os.path.dirname(os.path.abspath(__file__)); O = os.path.join(HERE, 'out')
L = lambda m: json.load(open(os.path.join(O, m + '.json')))
def p(*a): print(*a)

# ---- (1) donor per item
d1, d2 = L('donor'), L('donor2'); rows = d1['rows'] + d2['rows']
p('### Per-program rows, donor selection (rank of the true fix line / P(true); "absent" column = what won when the fix line was removed from the pool)\n')
p('| program | own: n / rank / p | own+3: n / rank / p | all-254: rank / p | truth absent: winner | p(escape) absent |'); p('|---|---|---|---|---|---|')
for n in sorted(set(r['program'] for r in rows)):
    g = {r['variant']: r for r in rows if r['program'] == n}; a, b, c, e = g['own'], g['own_plus_3'], g['all_programs_254'], g['own_plus_3_truth_absent']
    etop = 'escape' if e['top_text'] == 'none_of_these' else ('buggy line' if e['top_is_buggy_line'] else 'other: `' + e['top_text'][:40] + '`')
    p(f"| {n} | {a['n_candidates']} / {a['truth_rank']} / {a['p_truth']:.2f} | {b['n_candidates']} / {b['truth_rank']} / {b['p_truth']:.2f} | {c['truth_rank']} / {c['p_truth']:.2f} | {etop} | {e['p_escape']:.2f} |")

# ---- (2) ident per program
di = L('ident'); ir = [r for r in di['rows'] if r.get('variant') != 'uncovered']
p('\n### Per-program rows, identifier adaptation (holes = identifier positions in the fix line; "changed" = identifier absent from the buggy line)\n')
p('| program | holes (changed) | in-scope options | with buggy line: top-1 all / changed | hole only: top-1 all / changed | misses (variant: template -> picked) |'); p('|---|---|---|---|---|---|')
for n in sorted(set(r['program'] for r in ir)):
    g = [r for r in ir if r['program'] == n]; w = [r for r in g if r['variant'] == 'with_buggy_line']; h = [r for r in g if r['variant'] == 'hole_only']
    ch = [r for r in w if r['changed']]; chh = [r for r in h if r['changed']]
    miss = '; '.join(f"{'B' if r['variant']=='with_buggy_line' else 'H'}: `{r['template'][:38]}` -> `{r['top']}`" for r in g if r['truth_rank'] != 1)
    p(f"| {n} | {len(w)} ({len(ch)}) | {w[0]['n_options']} | {sum(r['truth_rank']==1 for r in w)}/{len(w)} / {sum(r['truth_rank']==1 for r in ch)}/{len(ch)} | {sum(r['truth_rank']==1 for r in h)}/{len(h)} / {sum(r['truth_rank']==1 for r in chh)}/{len(chh)} | {miss} |")

# ---- (3) kind per item + confusion
dk = L('kind')
p('\n### Per-program rows, fix-kind classification (top pick and P(top); * = lenient match, X = miss)\n')
p('| program | truth (acceptable) | catalogue | + missing_statement | + faulty line |'); p('|---|---|---|---|---|')
for n in sorted(set(r['program'] for r in dk['rows'])):
    g = {r['variant']: r for r in dk['rows'] if r['program'] == n}
    def cell(r): return f"{r['top']} {r['p_top']:.2f}" + ('' if r['strict'] else ' *' if r['lenient'] else ' X')
    t = g['catalogue']; acc = [x for x in t['acceptable'] if x != t['truth']]
    p(f"| {n} | {t['truth']}{' (' + ', '.join(acc) + ')' if acc else ''} | {cell(g['catalogue'])} | {cell(g['catalogue_plus_missing_statement'])} | {cell(g['catalogue_with_faulty_line'])} |")
for v in ('catalogue', 'catalogue_with_faulty_line'):
    rs = [r for r in dk['rows'] if r['variant'] == v]
    cm = collections.Counter((r['truth'], r['top']) for r in rs)
    labels = ['operator_swap', 'off_by_one', 'argument_order', 'missing_condition_or_guard', 'wrong_variable', 'wrong_function_call', 'control_flow_change', 'wrong_constant', 'none_of_these']
    short = {'operator_swap': 'op_swap', 'off_by_one': 'off1', 'argument_order': 'arg_ord', 'missing_condition_or_guard': 'miss_cond', 'wrong_variable': 'wr_var', 'wrong_function_call': 'wr_call', 'control_flow_change': 'ctl_flow', 'wrong_constant': 'wr_const', 'none_of_these': 'none'}
    p(f"\n### Confusion matrix, variant `{v}` (rows = hand-labelled primary kind, columns = Jev top pick), n=40\n")
    p('| truth \\ pick | ' + ' | '.join(short[l] for l in labels) + ' | n |'); p('|---|' + '---|' * (len(labels) + 1))
    for t in labels:
        if not any(r['truth'] == t for r in rs): continue
        p(f"| {t} | " + ' | '.join(str(cm[(t, q)]) if cm[(t, q)] else '.' for q in labels) + f" | {sum(r['truth']==t for r in rs)} |")

# ---- (4) insert per item
dn = L('insert')
p('\n### Per-item rows, insertion point / condition line\n')
p('| program | question kind | variant | options | truth | rank | P(truth) | top |'); p('|---|---|---|---|---|---|---|---|')
for r in dn['rows']:
    p(f"| {r['program']} | {r['kind']} | {r['variant']} | {r['n_options']} | {r['truth']} | {r['truth_rank']} | {r['p_truth']:.2f} | {r['top']} |")

# ---- (5) swebench
ds = json.load(open(os.path.join(O, 'swebench_donor.json')))
p('\n### SWE-bench donor coverage per instance (hits / added lines; parentheses = excluding the patched file itself)\n')
p('| instance | difficulty | .py files | added lines | exact | identifier-normalised | Jaccard >= 0.7 |'); p('|---|---|---|---|---|---|---|')
for i in ds:
    a = i['agg']; p(f"| {i['instance_id']} | {i['difficulty']} | {i['py_files']} | {i['n_added']} | {a['exact']} ({a['exact_other_file']}) | {a['normalised']} ({a['normalised_other_file']}) | {a['jaccard_hit']} ({a['jaccard_other_hit']}) |")
tot = sum(i['n_added'] for i in ds)
a = {k: sum(i['agg'][k] for i in ds) for k in ds[0]['agg']}
p(f"| **total** | | | **{tot}** | **{a['exact']} ({a['exact_other_file']})** | **{a['normalised']} ({a['normalised_other_file']})** | **{a['jaccard_hit']} ({a['jaccard_other_hit']})** |")
rest = [i for i in ds if i['instance_id'] != 'django__django-16100']; tr = sum(i['n_added'] for i in rest); ar = {k: sum(i['agg'][k] for i in rest) for k in ds[0]['agg']}
p(f"| total excl. django-16100 | | | {tr} | {ar['exact']} ({ar['exact_other_file']}) | {ar['normalised']} ({ar['normalised_other_file']}) | {ar['jaccard_hit']} ({ar['jaccard_other_hit']}) |")
p('\n### SWE-bench per added line (ex / nm / jac: any file, then excluding the patched file)\n')
p('| instance | added line | exact | normalised | best Jaccard | best donor file |'); p('|---|---|---|---|---|---|')
for i in ds:
    for r in i['rows']:
        ln = r['line'][:80].replace('|', '&#124;')
        p(f"| {i['instance_id'].split('__')[1]} | `{ln}` | {int(r['exact'])} / {int(r['exact_other_file'])} | {int(r['normalised'])} / {int(r['normalised_other_file'])} | {r['jaccard_best']:.2f} / {r['jaccard_other_best']:.2f} | {r['jaccard_best_file']} |")

# ---- quixbugs donor coverage
dq = json.load(open(os.path.join(O, 'quixbugs_donor.json')))
p('\n### QuixBugs fix-line donor coverage, code only (n=40)\n')
p('| criterion | same program (minus the buggy line) | other 39 programs |'); p('|---|---|---|')
p(f"| exact | {sum(r['exact_own'] for r in dq)}/40 | {sum(r['exact_other'] for r in dq)}/40 |")
p(f"| identifier-normalised | {sum(r['norm_own'] for r in dq)}/40 | {sum(r['norm_other'] for r in dq)}/40 |")
p(f"| token-set Jaccard >= 0.7 | {sum(r['jac_own_hit'] for r in dq)}/40 | {sum(r['jac_other_hit'] for r in dq)}/40 |")
p(f"| any of the above (either source) | {sum(r['norm_own'] or r['norm_other'] or r['jac_own_hit'] or r['jac_other_hit'] for r in dq)}/40 | |")
rep = [r for r in dq if r['kind'] == 'replace']
p(f"| fix has the same normalised shape as the buggy line (identifier substitution alone reaches it) | {sum(r['same_shape_as_buggy'] for r in rep)}/36 replace bugs | |")
p(f"| Jaccard(fix, buggy line) >= 0.7 | {sum((r['jac_buggy'] or 0) >= 0.7 for r in rep)}/36 | |")
p(f"| Jaccard(fix, buggy line) >= 0.5 | {sum((r['jac_buggy'] or 0) >= 0.5 for r in rep)}/36 | |")
ins = [r for r in dq if r['kind'] == 'insert']
p(f"| inserted statements (4) with a normalised donor | {sum(r['norm_own'] for r in ins)}/4 | {sum(r['norm_other'] for r in ins)}/4 |")
