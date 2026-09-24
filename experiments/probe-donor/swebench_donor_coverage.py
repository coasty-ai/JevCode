"""(5) Donor coverage for SWE-bench gold patches, computed in code (no Jev).
For each added line of the gold patch (non-blank, non-comment, not a bare bracket/keyword), search
every .py file of the repo at base_commit (clones under /tmp/jevonly/repos/<instance_id>) for:
  exact      : identical after whitespace strip
  normalised : identical after replacing every non-keyword NAME with ID, numbers with NUM, strings with STR
  jaccard    : token-set Jaccard (python tokenize, NAME/NUMBER/STRING/OP tokens) >= 0.7 with some repo line
Deleted lines from the same hunk exist at base_commit and are legitimate donors (the plastic surgery
hypothesis counts them), but we ALSO report the hit rate when the patched file itself is excluded.
Usage: python3 swebench_donor_coverage.py [instance_id ...]  -> out/swebench_donor.json + stdout table
"""
import json, os, re, sys, io, tokenize, keyword, collections

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(ROOT, 'bench', 'data', 'swebench-verified-30.json')
GOLD = os.path.join(ROOT, 'bench', 'data', 'swebench-verified-30.gold.json')
REPOS = '/tmp/jevonly/repos'
DEFAULT = ['sympy__sympy-12096', 'sympy__sympy-15345', 'sympy__sympy-19954', 'django__django-14787', 'django__django-15315',
           'django__django-16100', 'pytest-dev__pytest-10081', 'pytest-dev__pytest-7205', 'pylint-dev__pylint-4970', 'psf__requests-1142']
KW = set(keyword.kwlist) | {'self', 'cls'}
TRIVIAL = re.compile(r'^(\)|\]|\}|\),|\],|\},|else:|try:|finally:|pass|return|break|continue|\)\)|\]\)|"""|\'\'\')$')

def toks(line):
    out = []
    try:
        for t in tokenize.generate_tokens(io.StringIO(line).readline):
            if t.type in (tokenize.NAME, tokenize.NUMBER, tokenize.STRING, tokenize.OP):
                out.append((t.type, t.string))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        for m in re.finditer(r'[A-Za-z_]\w*|\d+|\S', line):
            s = m.group(0)
            out.append((tokenize.NAME if re.match(r'[A-Za-z_]', s) else tokenize.NUMBER if s[0].isdigit() else tokenize.OP, s))
    return out

def normalise(line):
    parts = []
    for ty, s in toks(line):
        if ty == tokenize.NAME and s not in KW: parts.append('ID')
        elif ty == tokenize.NUMBER: parts.append('NUM')
        elif ty == tokenize.STRING: parts.append('STR')
        else: parts.append(s)
    return ' '.join(parts)

def tokset(line):
    return frozenset(s for ty, s in toks(line))

def jaccard(a, b):
    if not a or not b: return 0.0
    return len(a & b) / len(a | b)

def added_lines(patch):
    out, path = [], None
    for l in patch.split('\n'):
        if l.startswith('+++ '): path = l[4:].strip(); path = path[2:] if path.startswith('b/') else path; continue
        if l.startswith('--- ') or l.startswith('diff ') or l.startswith('@@') or l.startswith('index '): continue
        if l.startswith('+') and path and path.endswith('.py'):
            s = l[1:].strip()
            if not s or s.startswith('#') or TRIVIAL.match(s): continue
            out.append((path, s))
    return out

def repo_index(root):
    exact = collections.defaultdict(set); norm = collections.defaultdict(set); sets = []
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d not in ('.git', 'node_modules', '__pycache__')]
        for f in fn:
            if not f.endswith('.py'): continue
            p = os.path.join(dp, f); rel = os.path.relpath(p, root)
            try: text = open(p, encoding='utf8', errors='replace').read()
            except OSError: continue
            for line in text.split('\n'):
                s = line.strip()
                if not s or s.startswith('#'): continue
                exact[s].add(rel)
                norm[normalise(s)].add(rel)
                sets.append((rel, tokset(s)))
    return exact, norm, sets

def main(ids):
    inst = {i['instance_id']: i for i in json.load(open(DATA))}
    gold = json.load(open(GOLD))
    results = []
    for iid in ids:
        root = os.path.join(REPOS, iid)
        if not os.path.isdir(root): print('missing clone', iid); continue
        exact, norm, sets = repo_index(root)
        lines = added_lines(gold[iid])
        rows = []
        for path, s in lines:
            n = normalise(s); ts = tokset(s)
            ex_files = exact.get(s, set()); nm_files = norm.get(n, set())
            best, best_file = 0.0, None; best_other, best_other_file = 0.0, None
            for rel, st in sets:
                j = jaccard(ts, st)
                if j > best: best, best_file = j, rel
                if rel != path and j > best_other: best_other, best_other_file = j, rel
            rows.append({'file': path, 'line': s, 'n_tokens': len(ts),
                         'exact': bool(ex_files), 'exact_other_file': bool(ex_files - {path}),
                         'normalised': bool(nm_files), 'normalised_other_file': bool(nm_files - {path}),
                         'jaccard_best': round(best, 3), 'jaccard_best_file': best_file, 'jaccard_hit': best >= 0.7,
                         'jaccard_other_best': round(best_other, 3), 'jaccard_other_hit': best_other >= 0.7,
                         'normalised_form': n})
        n = len(rows)
        agg = {k: sum(r[k] for r in rows) for k in ('exact', 'exact_other_file', 'normalised', 'normalised_other_file', 'jaccard_hit', 'jaccard_other_hit')}
        results.append({'instance_id': iid, 'repo': inst[iid]['repo'], 'difficulty': inst[iid]['difficulty'], 'n_added': n, 'py_files': len({r for r, _ in sets}), 'agg': agg, 'rows': rows})
        print(f"{iid:28s} added={n:3d} exact={agg['exact']:3d} ({agg['exact_other_file']}) norm={agg['normalised']:3d} ({agg['normalised_other_file']}) jac>=0.7={agg['jaccard_hit']:3d} ({agg['jaccard_other_hit']})   [() = excluding the patched file]")
    os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
    json.dump(results, open(os.path.join(HERE, 'out', 'swebench_donor.json'), 'w'), indent=1)
    tot = sum(r['n_added'] for r in results)
    for k in ('exact', 'exact_other_file', 'normalised', 'normalised_other_file', 'jaccard_hit', 'jaccard_other_hit'):
        v = sum(r['agg'][k] for r in results); print(f"TOTAL {k:24s} {v}/{tot} = {v/tot:.2f}")

main(sys.argv[1:] or DEFAULT)
