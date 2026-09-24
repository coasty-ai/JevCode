#!/usr/bin/env python3
"""Turn /tmp/jevonly/full.json (output of coverage_study.py) into the Markdown tables of coverage-study.md.
Usage: python3 make_report.py /tmp/jevonly/full.json > tables.md"""
import json, sys, statistics
from collections import Counter, defaultdict

POST_HOC = {'qualify_name', 'drop_qualifier', 'drop_element', 'add_first_param', 'drop_first_param', 'comp_filter'}
data = json.load(open(sys.argv[1]))

# hand annotations of the 30 gold patches (read by the author of this study; the reachability columns are computed)
NOTES = {
 'sympy__sympy-12096': 'replace `*self.args` by `*[i.evalf(prec) for i in self.args]`: needs a new comprehension',
 'sympy__sympy-15345': 'two dict entries copying a neighbour with new keys `Max`/`Min` (names in the issue), plus alias `_print_MinMaxBase = _print_Function`',
 'sympy__sympy-17139': 'guard `if not rv.exp.is_real: return rv` copying the `return rv` two lines above',
 'sympy__sympy-19954': 'rewrite of a filter loop with a new mask variable; three list comprehensions',
 'sympy__sympy-11618': '14 new lines: dimension-padding branch with new arithmetic',
 'sympy__sympy-13798': 'wrap two assignments in try/except KeyError with new fallback bodies (7 new lines)',
 'sympy__sympy-16792': 'extract helper `dimensions()`, inline it twice, new isinstance branch (refactor)',
 'sympy__sympy-20428': '`return f.ex != 0` -> `return not f.ex.is_zero` (idiom change: comparison -> property)',
 'sympy__sympy-22080': 'extend an import, new if/else branch with a new expression, one dict entry copying a neighbour (`"Mod"` from the issue)',
 'sympy__sympy-12489': '42-line staticmethod->classmethod refactor: 30+ near-identical `_af_new(` -> `self._af_new(`/`cls._af_new(` edits, `Perm` -> `cls`, decorator swaps',
 'django__django-14787': 'wrap value: `partial(...)` -> `wraps(method)(partial(...))` (`wraps` already imported)',
 'django__django-15315': 'replace a 5-line tuple hash by `return hash(self.creation_counter)` (keep first element)',
 'django__django-15572': 'add a truthiness filter to two comprehensions (`if dir`, `directory and ...`)',
 'django__django-16100': 'wrap an 8-line loop in `with transaction.atomic(using=router.db_for_write(self.model)):` (line exists twice in the file) + black re-wrap of one call',
 'django__django-14725': 'feature: thread a new `edit_only=False` parameter through two factories, a class attribute, a kwargs dict, and an if/else around the return',
 'django__django-15103': '`element_id=None` default in two signatures + if/else choosing between two template strings (one new literal)',
 'django__django-15375': 'extract call to a variable, set `coalesce.is_summary = c.is_summary`, return it (3 lines)',
 'django__django-15563': '20 new lines of MTI logic in compiler.py; one-line `self.related_ids` -> `self.related_ids[model]` in subqueries.py',
 'django__django-15916': 'delete a 7-line lookup, add `self.formfield_callback = getattr(options, "formfield_callback", None)` (copy of the line above with two substitutions), qualify `formfield_callback` with `opts.`, drop a dict entry',
 'django__django-15128': 'two new statements, rename a parameter and add `exclude=None`, `if exclude is None: exclude = {}` guard, comprehension filter, docstring edits',
 'pytest-dev__pytest-10081': 'assert + new local `skipped = _is_skipped(self.obj) or _is_skipped(self.parent.obj)` + use it in the condition',
 'pytest-dev__pytest-7205': 'missing import (line exists verbatim in two other files) + wrap an argument in `saferepr(x, maxsize=42)`',
 'pytest-dev__pytest-10051': 'new 3-line method `clear()` (bodies copy neighbours) + call-target change `reset` -> `clear`; one blank line removed',
 'pytest-dev__pytest-7324': 'new module constant `IDENT_PREFIX = "$"`, prefix an expression with it, slice by `len(IDENT_PREFIX):`',
 'pytest-dev__pytest-10356': '30-line rewrite of `get_unpacked_marks` with a new keyword-only parameter; one call site gains `consider_mro=False`',
 'pylint-dev__pylint-4970': 'guard insertion `if self.min_lines == 0: return`',
 'pylint-dev__pylint-4604': '3-line isinstance branch copying the structure of the branch above (Attribute instead of Name) + unrelated `import platform` / `IS_PYPY` constant',
 'pylint-dev__pylint-6386': 'thread a new `metavar` parameter through 4 files: each added line copies a neighbouring line with 1-2 substitutions; one literal change `"--"` -> `"-"`',
 'psf__requests-1142': 'move `self.headers[\'Content-Length\'] = \'0\'` from the top of the function into a new `elif self.method not in (\'GET\', \'HEAD\'):` branch',
 'psf__requests-2931': '`return to_native_string(data)` -> `return data` (unwrap call) + 2-line guard converting `params` with the same call',
}

def posthoc_only(ops):
    """True if every operator path producing the fix uses a post-hoc operator (depth-1: all ops post-hoc; depth-2: first-step ops all post-hoc or second step post-hoc)."""
    if not ops: return False
    if '>' in ops:
        k = ops.index('>'); first = set(ops[:k]); second = ops[k + 1:]
        return all(o in POST_HOC for o in first) or any(o in POST_HOC for o in second)
    return all(o in POST_HOC for o in ops)

for ds in data.values():
    for item in ds:
        for h in item['hunks']:
            if h['kind'] in ('non_code_only', 'deletion') or not h['lines']: continue
            h['reach']['mutation_no_posthoc'] = all(l['mutation']['hit_depth'] is not None and not posthoc_only(l['mutation']['ops']) for l in h['lines'])

def pct(a, b): return f'{a}/{b} ({100.0 * a / b:.0f}%)' if b else '-'

def hunks_of(ds): return [(item, h) for item in ds for h in item['hunks']]

SOURCES = [('mutation_d1', '(a) mutation, depth 1'), ('mutation_d2', '(a) mutation, depth <= 2'), ('mutation_no_posthoc', '(a) mutation, depth <= 2, without post-hoc ops'),
           ('donor_verbatim_repo', '(b) donor verbatim, whole repo'), ('donor_one_sub', '(b) donor + <= 1 substitution'), ('donor_two_sub', '(b) donor + <= 2 substitutions'),
           ('donor_shape_repo', '(b) donor shape only (upper bound, identifiers still to fill)'),
           ('template', '(d) fix template (generative)'), ('union', 'union (a) d<=2 + (b) <= 1 sub + (d)'), ('union_two_sub', 'union with (b) <= 2 subs'),
           ('vocab_file', '(c) vocabulary: file only (necessary condition)'), ('vocab_file_tests', '(c) vocabulary: file + tests')]

def coverage_table(ds, name):
    hs = [h for _, h in hunks_of(ds) if h['kind'] != 'non_code_only']
    n_items = len(ds)
    out = [f'### {name}: coverage by source', '', f'Hunks = contiguous runs of changed code lines (non-code-only runs excluded); n_hunks = {len(hs)}, n_fixes = {n_items}.', '',
           '| Source | Hunks reachable | Fixes fully reachable (every hunk) | Fixes with >= 1 hunk reachable |', '| --- | --- | --- | --- |']
    for key, label in SOURCES:
        hk = sum(1 for h in hs if h['reach'][key])
        full = sum(1 for item in ds if all(h['reach'][key] for h in item['hunks'] if h['kind'] != 'non_code_only') and any(h['kind'] != 'non_code_only' for h in item['hunks']))
        part = sum(1 for item in ds if any(h['reach'][key] for h in item['hunks'] if h['kind'] != 'non_code_only'))
        out.append(f'| {label} | {pct(hk, len(hs))} | {pct(full, n_items)} | {pct(part, n_items)} |')
    return '\n'.join(out)

def kind_table(ds, name):
    hs = [h for _, h in hunks_of(ds)]
    c = Counter(h['kind'] for h in hs)
    out = [f'### {name}: hunk classification', '', '| Kind | Hunks | Reachable by union (a+b1+d) | by union with 2-sub donors |', '| --- | --- | --- | --- |']
    for k in ['single_line_modification', 'multi_line_modification', 'pure_insertion', 'deletion', 'new_function', 'non_code_only']:
        sub = [h for h in hs if h['kind'] == k]
        if not sub: continue
        out.append(f"| {k} | {len(sub)} | {pct(sum(1 for h in sub if h['reach']['union']), len(sub))} | {pct(sum(1 for h in sub if h['reach']['union_two_sub']), len(sub))} |")
    out.append(f'| total | {len(hs)} | {pct(sum(1 for h in hs if h["reach"]["union"]), len(hs))} | {pct(sum(1 for h in hs if h["reach"]["union_two_sub"]), len(hs))} |')
    return '\n'.join(out)

def line_table(ds, name):
    """line-level coverage (paired fixed code lines), the unit the mutation library and donors actually operate on."""
    rows = [(h, l) for _, h in hunks_of(ds) for l in h['lines']]
    mod = [(h, l) for h, l in rows if l['buggy'] is not None]; ins = [(h, l) for h, l in rows if l['buggy'] is None]
    def cnt(rs, f): return sum(1 for h, l in rs if f(l))
    out = [f'### {name}: line-level coverage (fixed code lines)', '', f'{len(rows)} fixed code lines: {len(mod)} paired with a buggy line (modifications), {len(ins)} insertions (no buggy line to mutate).', '',
           '| Source | Modified lines | Inserted lines | All lines |', '| --- | --- | --- | --- |']
    fs = [('mutation depth 1', lambda l: l['mutation']['hit_depth'] == 1), ('mutation depth <= 2', lambda l: l['mutation']['hit_depth'] is not None),
          ('mutation depth <= 2, no post-hoc ops', lambda l: l['mutation']['hit_depth'] is not None and not posthoc_only(l['mutation']['ops'])),
          ('baseline 20-regex library (anchor probe)', lambda l: l['mutation'].get('baseline_hit', False)),
          ('donor verbatim, same file', lambda l: l['donor']['verbatim_file']), ('donor verbatim, same package', lambda l: l['donor']['verbatim_package']),
          ('donor verbatim, whole repo', lambda l: l['donor']['verbatim_repo']), ('donor + <= 1 substitution (repo)', lambda l: l['donor']['one_sub_repo']),
          ('donor + <= 2 substitutions (repo)', lambda l: l['donor']['two_sub_repo']), ('donor shape (identifiers blanked), same file', lambda l: l['donor']['shape_file']),
          ('donor shape, whole repo', lambda l: l['donor']['shape_repo']), ('alpha-renamed shape, whole repo', lambda l: l['donor']['alpha_repo']),
          ('union: mutation d<=2 or donor <= 1 sub', lambda l: l['mutation']['hit_depth'] is not None or l['donor']['one_sub_repo']),
          ('union: mutation d<=2 or donor <= 2 subs', lambda l: l['mutation']['hit_depth'] is not None or l['donor']['two_sub_repo']),
          ('vocabulary: all tokens in file', lambda l: l['vocab']['all_in_file']), ('vocabulary: all tokens in file + tests', lambda l: l['vocab']['all_in_file_plus_tests'])]
    for label, f in fs:
        out.append(f'| {label} | {pct(cnt(mod, f), len(mod))} | {pct(cnt(ins, f), len(ins))} | {pct(cnt(rows, f), len(rows))} |')
    return '\n'.join(out)

def mutant_counts(ds, name):
    ns = [l['mutation']['n_depth1'] for _, h in hunks_of(ds) for l in h['lines'] if l['buggy'] is not None]
    n2 = [l['mutation']['n_depth2'] for _, h in hunks_of(ds) for l in h['lines'] if l['buggy'] is not None and l['mutation']['n_depth2'] is not None]
    scopes = [h['n_scope'] for _, h in hunks_of(ds) if h['kind'] != 'non_code_only']
    if not ns: return ''
    ns_s = sorted(ns)
    return '\n'.join([f'### {name}: candidate-set sizes', '',
        f'- depth-1 mutants per buggy line: median {int(statistics.median(ns))}, p90 {ns_s[int(0.9 * (len(ns_s) - 1))]}, max {max(ns)}; lines with <= 255 mutants: {pct(sum(1 for n in ns if n <= 255), len(ns))}',
        f'- depth-2 mutants explored (lines where depth 1 missed): median {int(statistics.median(n2)) if n2 else "-"}, max {max(n2) if n2 else "-"}, n = {len(n2)}',
        f'- in-scope identifiers per hunk (enclosing function + module-level names + capitalised file names): median {int(statistics.median(scopes))}, max {max(scopes)}'])

def op_ranking(ds, name):
    """marginal coverage: greedy set cover over modified lines hit at depth 1 (each line credited to the operators that produce the fix)."""
    lines = [l for _, h in hunks_of(ds) for l in h['lines'] if l['buggy'] is not None]
    hit = [set(l['mutation']['ops']) for l in lines if l['mutation']['hit_depth'] == 1]
    hit2 = [l['mutation']['ops'] for l in lines if l['mutation']['hit_depth'] == 2]
    total = Counter(op for s in hit for op in s)
    sole = Counter(next(iter(s)) for s in hit if len(s) == 1)
    remaining = list(range(len(hit))); order = []
    while remaining:
        best = None
        for op in total:
            gain = sum(1 for i in remaining if op in hit[i])
            if gain and (best is None or gain > best[1] or (gain == best[1] and op < best[0])): best = (op, gain)
        if not best: break
        order.append(best); remaining = [i for i in remaining if best[0] not in hit[i]]
    out = [f'### {name}: operators ranked by marginal coverage (depth-1 hits, greedy set cover over {len(hit)} lines)', '',
           '| Rank | Operator | Marginal lines | Total lines it produces | Lines only it produces | Post-hoc? |', '| --- | --- | --- | --- | --- | --- |']
    for i, (op, g) in enumerate(order, 1):
        out.append(f'| {i} | `{op}` | {g} | {total[op]} | {sole.get(op, 0)} | {"yes" if op in POST_HOC else ""} |')
    if hit2:
        out += ['', 'Depth-2 compositions that hit: ' + '; '.join('`' + ' '.join(o) + '`' for o in hit2)]
    return '\n'.join(out)

def template_ranking(ds, name):
    hs = [h for _, h in hunks_of(ds) if h['kind'] != 'non_code_only']
    c = Counter(t for h in hs for t in h['templates'])
    gen = Counter(t for h in hs if h['reach']['template'] for t in h['templates'])
    only = Counter()
    for h in hs:
        if h['reach']['template'] and not (h['reach']['mutation_d2'] or h['reach']['donor_one_sub']):
            for t in h['templates']: only[t] += 1
    out = [f'### {name}: templates (recognisers) by hunks matched', '', '| Template | Hunks matched | of which counted generative | Hunks only templates reach (not mutation/donor) |', '| --- | --- | --- | --- |']
    for t, n in c.most_common():
        out.append(f'| `{t}` | {n} | {gen.get(t, 0)} | {only.get(t, 0)} |')
    return '\n'.join(out)

def qb_rows(ds):
    out = ['| Program | Kind | Buggy -> fixed line | Mutation (depth, ops) | n mutants d1 | Baseline 20-regex | Donor (file/pkg/repo verbatim; 1-sub; shape) | Vocab in file | Templates | Union |',
           '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    for item in ds:
        for h in item['hunks']:
            if h['kind'] == 'non_code_only': continue
            L = h['lines']
            if not L:
                out.append(f"| {item['id']} | {h['kind']} | removed: `{'; '.join(x.strip() for x in [])}` | - | - | - | - | - | {', '.join(h['templates'])} | {'Y' if h['reach']['union'] else 'n'} |"); continue
            l = L[0]; m = l['mutation']; d = l['donor']
            b = (l['buggy'] or '(insertion)').replace('|', '\\|'); f = l['fixed'].replace('|', '\\|')
            mut = f"d{m['hit_depth']} {' '.join(m['ops'])}" if m['hit_depth'] else '-'
            don = f"{'Y' if d['verbatim_file'] else 'n'}/{'Y' if d['verbatim_package'] else 'n'}/{'Y' if d['verbatim_repo'] else 'n'}; {'Y' if d['one_sub_repo'] else 'n'}; {'Y' if d['shape_repo'] else 'n'}"
            out.append(f"| {item['id']} | {h['kind']} | `{b}` -> `{f}` | {mut} | {m['n_depth1']} | {'Y' if m.get('baseline_hit') else 'n'} | {don} | {'Y' if l['vocab']['all_in_file'] else 'n ' + ','.join(l['vocab']['missing_file'])} | {', '.join(h['templates']) or '-'} | {'Y' if h['reach']['union'] else 'n'} |")
    return '\n'.join(out)

def swe_rows(ds):
    out = ['| Instance | Hunks (code) | Kinds | Fixed code lines (mod / ins) | Reach: mut d<=2 | donor <=1 sub | donor <=2 sub | template | union | union (2-sub) | vocab file / +tests | What the fix is |',
           '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    for item in ds:
        hs = [h for h in item['hunks'] if h['kind'] != 'non_code_only']
        kinds = Counter(h['kind'] for h in hs)
        ks = ', '.join(f'{v} {k.replace("_modification", "").replace("_", " ")}' for k, v in kinds.items())
        lines = [l for h in hs for l in h['lines']]
        mod = sum(1 for l in lines if l['buggy'] is not None); ins = len(lines) - mod
        def r(key): return f"{sum(1 for h in hs if h['reach'][key])}/{len(hs)}"
        out.append(f"| {item['id']} | {len(hs)} | {ks} | {mod} / {ins} | {r('mutation_d2')} | {r('donor_one_sub')} | {r('donor_two_sub')} | {r('template')} | {r('union')} | {r('union_two_sub')} | {r('vocab_file')} / {r('vocab_file_tests')} | {NOTES.get(item['id'], '')} |")
    return '\n'.join(out)

def swe_hunk_rows(ds):
    out = ['| Instance | File:line | Kind | -/+ code lines | Mutation | Donor min subs (per line) | Templates | Union | Sample fixed line |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    for item in ds:
        for h in item['hunks']:
            if h['kind'] == 'non_code_only': continue
            L = h['lines']
            mut = ','.join(('d%d' % l['mutation']['hit_depth']) if l['mutation']['hit_depth'] else '-' for l in L) or '-'
            subs = ','.join(str(l['donor']['min_subs']) if l['donor']['min_subs'] is not None else '-' for l in L) or '-'
            sample = (L[0]['fixed'] if L else (h['file'] and ''))[:70].replace('|', '\\|')
            out.append(f"| {item['id']} | {h['file'].split('/')[-1]}:{h['old_start']} | {h['kind']} | {h['n_removed']}/{h['n_added']} | {mut} | {subs} | {', '.join(h['templates']) or '-'} | {'Y' if h['reach']['union'] else ('2sub' if h['reach']['union_two_sub'] else 'n')} | `{sample}` |")
    return '\n'.join(out)

qb, swe = data['quixbugs'], data['swebench']
print('## Tables (generated by `experiments/coverage-study/make_report.py`)\n')
for ds, name in ((qb, 'QuixBugs (40 programs)'), (swe, 'SWE-bench Verified (30 instances)')):
    print(kind_table(ds, name)); print(); print(coverage_table(ds, name)); print(); print(line_table(ds, name)); print(); print(mutant_counts(ds, name)); print()
    print(op_ranking(ds, name)); print(); print(template_ranking(ds, name)); print()
print('### QuixBugs: per-program rows\n'); print(qb_rows(qb)); print()
print('### SWE-bench: per-instance rows\n'); print(swe_rows(swe)); print()
print('### SWE-bench: per-hunk rows\n'); print(swe_hunk_rows(swe)); print()
