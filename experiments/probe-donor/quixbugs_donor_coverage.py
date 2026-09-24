"""Code-only: does each QuixBugs fix line have a donor elsewhere (same program minus the buggy line,
or any of the other 39 programs) under exact / identifier-normalised / token-Jaccard>=0.7 matching?
Also: is the fix reachable from the buggy line by identifier substitution alone (same normalised form)?
Usage: python3 quixbugs_donor_coverage.py -> stdout table + out/quixbugs_donor.json
"""
import json, os, io, tokenize, keyword, re
HERE = os.path.dirname(os.path.abspath(__file__))
KW = set(keyword.kwlist)
def toks(line):
    out = []
    try:
        for t in tokenize.generate_tokens(io.StringIO(line.strip()).readline):
            if t.type in (tokenize.NAME, tokenize.NUMBER, tokenize.STRING, tokenize.OP): out.append((t.type, t.string))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        for m in re.finditer(r'[A-Za-z_]\w*|\d+|\S', line):
            s = m.group(0); out.append((tokenize.NAME if re.match(r'[A-Za-z_]', s) else tokenize.NUMBER if s[0].isdigit() else tokenize.OP, s))
    return out
def norm(line): return ' '.join('ID' if ty == tokenize.NAME and s not in KW else 'NUM' if ty == tokenize.NUMBER else 'STR' if ty == tokenize.STRING else s for ty, s in toks(line))
def tset(line): return frozenset(s for _, s in toks(line))
def jac(a, b): return len(a & b) / len(a | b) if a and b else 0.0
progs = json.load(open(os.path.join(HERE, 'quixbugs.json')))
rows = []
for p in progs:
    fix = p['diff']['fix_line'].strip(); bug = p['diff'].get('buggy_line', '').strip()
    own = [l.strip() for i, l in enumerate(p['buggy']) if l.strip() and not (p['diff']['kind'] == 'replace' and i == p['diff']['line_index'])]
    others = [l.strip() for q in progs if q['name'] != p['name'] for l in q['buggy'] if l.strip()]
    fs, fn = tset(fix), norm(fix)
    r = {'program': p['name'], 'fix_line': fix, 'kind': p['diff']['kind'],
         'exact_own': fix in own, 'exact_other': fix in others,
         'norm_own': any(norm(l) == fn for l in own), 'norm_other': any(norm(l) == fn for l in others),
         'jac_own': max([jac(fs, tset(l)) for l in own] or [0]), 'jac_other': max([jac(fs, tset(l)) for l in others] or [0]),
         'same_shape_as_buggy': bool(bug) and norm(bug) == fn, 'jac_buggy': jac(fs, tset(bug)) if bug else None}
    r['jac_own_hit'] = r['jac_own'] >= 0.7; r['jac_other_hit'] = r['jac_other'] >= 0.7
    rows.append(r)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
json.dump(rows, open(os.path.join(HERE, 'out', 'quixbugs_donor.json'), 'w'), indent=1)
n = len(rows)
for k in ('exact_own', 'exact_other', 'norm_own', 'norm_other', 'jac_own_hit', 'jac_other_hit', 'same_shape_as_buggy'):
    print(f"{k:22s} {sum(bool(r[k]) for r in rows):2d}/{n}")
print(f"{'any_donor(norm|jac)':22s} {sum(r['norm_own'] or r['norm_other'] or r['jac_own_hit'] or r['jac_other_hit'] for r in rows):2d}/{n}")
print(f"{'donor_or_same_shape':22s} {sum(r['norm_own'] or r['norm_other'] or r['jac_own_hit'] or r['jac_other_hit'] or r['same_shape_as_buggy'] for r in rows):2d}/{n}")
for r in rows: print(f"{r['program']:28s} {r['kind']:7s} normOwn={int(r['norm_own'])} normOth={int(r['norm_other'])} jacOwn={r['jac_own']:.2f} jacOth={r['jac_other']:.2f} shape=buggy:{int(r['same_shape_as_buggy'])} jacBuggy={r['jac_buggy'] if r['jac_buggy'] is None else round(r['jac_buggy'],2)}")
