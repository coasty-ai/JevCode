#!/usr/bin/env python3
"""Prepare per-instance data for the SWE-bench understanding probe (no Jev calls here).

Reads bench/data/swebench-verified-30{,.gold}.json and the worktrees under /tmp/jevonly/repos/<instance_id>
(checked out at base_commit). Writes experiments/probe-swebench-understand/prepared.json with, per instance:
  gold files + hunks (old-file line numbers), top-level functions/methods of each gold file (qualname,
  first line, span), the functions the gold patch touches, the .py files of the gold file's package with a
  symbol outline, the failing test names and the test code added by test_patch.
"""
import ast, json, os, re, sys

ROOT = '/Users/prateekjannu/Documents/vscode/JevCode'
REPOS = '/tmp/jevonly/repos'
OUT = os.path.join(ROOT, 'experiments/probe-swebench-understand/prepared.json')

data = json.load(open(os.path.join(ROOT, 'bench/data/swebench-verified-30.json')))
gold = json.load(open(os.path.join(ROOT, 'bench/data/swebench-verified-30.gold.json')))


def parse_patch(patch):
    """-> {path: [hunk]} ; hunk = {old_start, old_lines:[(old_lineno or None, tag, text)], anchor_old}."""
    files, cur, hunk, old = {}, None, None, 0
    for line in patch.split('\n'):
        if line.startswith('diff --git'):
            m = re.match(r'diff --git a/(\S+) b/(\S+)', line); cur = m.group(2); files[cur] = []; hunk = None
        elif line.startswith('@@'):
            m = re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', line)
            old = int(m.group(1)); hunk = {'old_start': old, 'lines': []}; files[cur].append(hunk)
        elif hunk is not None and cur is not None:
            if line.startswith('+++') or line.startswith('---'):
                continue
            if line.startswith('-'):
                hunk['lines'].append((old, '-', line[1:])); old += 1
            elif line.startswith('+'):
                hunk['lines'].append((None, '+', line[1:]))
            elif line.startswith(' ') or line == '':
                hunk['lines'].append((old, ' ', line[1:])); old += 1
            elif line.startswith('\\'):
                pass
    return files


def changed_old_lines(hunk):
    """Old-file line numbers the hunk changes: '-' lines, plus for a '+' run the old line just before it
    (the anchor: 'insert after this line'). Returns (set_of_changed, list_of_anchor_lines_per_edit_run)."""
    changed, anchors, prev_old, in_run = set(), [], None, False
    for old, tag, _ in hunk['lines']:
        if tag == '-':
            changed.add(old); prev_old = old
            if not in_run: anchors.append(old); in_run = True
        elif tag == '+':
            if not in_run:
                anchors.append(prev_old if prev_old is not None else hunk['old_start']); in_run = True
            if prev_old is not None: changed.add(prev_old)
        else:
            prev_old = old; in_run = False
    return changed, anchors


def functions_of(src):
    """Top-level functions and class methods (one level deep) with qualname, span, first line."""
    tree = ast.parse(src)
    out = []
    def add(node, qual):
        first = src.split('\n')[node.lineno - 1].strip()
        out.append({'qualname': qual, 'lineno': node.lineno, 'end_lineno': node.end_lineno, 'first_line': first,
                    'kind': 'function' if qual.count('.') == 0 else 'method'})
    def walk(body, prefix):
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                add(node, prefix + node.name)
            elif isinstance(node, ast.ClassDef):
                walk(node.body, prefix + node.name + '.')
    walk(tree.body, '')
    return out


def outline_of(path, cap=40):
    try:
        tree = ast.parse(open(path, encoding='utf-8', errors='replace').read())
    except Exception:
        return []
    names = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)): names.append(node.name + '()')
        elif isinstance(node, ast.ClassDef): names.append('class ' + node.name)
    return names[:cap] + ([f'... {len(names) - cap} more'] if len(names) > cap else [])


def test_source_from(test_patch, cap=160):
    lines = [l[1:] for l in test_patch.split('\n') if l.startswith('+') and not l.startswith('+++')]
    return lines[:cap]


prepared = []
for inst in data:
    iid = inst['instance_id']; wt = os.path.join(REPOS, iid)
    patch_files = parse_patch(gold[iid])
    f2p = inst['fail_to_pass'] if isinstance(inst['fail_to_pass'], list) else json.loads(inst['fail_to_pass'])
    gold_files = []
    for path, hunks in patch_files.items():
        full = os.path.join(wt, path)
        src = open(full, encoding='utf-8').read()
        src_lines = src.split('\n')
        funcs = functions_of(src)
        changed_all, anchors_all = set(), []
        for h in hunks:
            c, a = changed_old_lines(h); changed_all |= c; anchors_all += a
        def owner(line):
            best = None
            for f in funcs:
                if f['lineno'] <= line <= f['end_lineno'] and (best is None or f['lineno'] > best['lineno']): best = f
            return best
        touched = {}
        for ln in sorted(changed_all):
            f = owner(ln)
            key = f['qualname'] if f else '<module>'
            touched.setdefault(key, {'qualname': key, 'changed_lines': [], 'anchors': []})['changed_lines'].append(ln)
        adjacent = []
        for a in anchors_all:
            f = owner(a); key = f['qualname'] if f else '<module>'
            touched.setdefault(key, {'qualname': key, 'changed_lines': [], 'anchors': []})['anchors'].append(a)
            if f is None:
                prev = max((g for g in funcs if g['end_lineno'] < a and a - g['end_lineno'] <= 3), key=lambda g: g['end_lineno'], default=None)
                if prev: adjacent.append(prev['qualname'])
        pkg_dir = os.path.dirname(path)
        pkg_files = sorted(f for f in os.listdir(os.path.join(wt, pkg_dir)) if f.endswith('.py'))
        gold_files.append({
            'path': path, 'n_lines': len(src_lines), 'n_functions': len(funcs), 'functions': funcs,
            'touched': list(touched.values()), 'adjacent_functions': sorted(set(adjacent)), 'package_dir': pkg_dir,
            'package_files': [{'path': f'{pkg_dir}/{f}', 'outline': outline_of(os.path.join(wt, pkg_dir, f)),
                               'is_gold': f'{pkg_dir}/{f}' in patch_files} for f in pkg_files],
            'source_lines': src_lines,
        })
    prepared.append({
        'instance_id': iid, 'repo': inst['repo'], 'difficulty': inst['difficulty'],
        'problem_statement': inst['problem_statement'], 'hints_text': inst['hints_text'],
        'fail_to_pass': f2p, 'test_source': test_source_from(inst['test_patch']),
        'gold_files': gold_files,
    })

json.dump(prepared, open(OUT, 'w'))
# summary to stdout
for p in prepared:
    for g in p['gold_files']:
        t = [(x['qualname'], len(x['changed_lines'])) for x in g['touched']]
        biggest = max((f for f in g['functions'] if f['qualname'] in [x['qualname'] for x in g['touched']]),
                      key=lambda f: f['end_lineno'] - f['lineno'], default=None)
        span = (biggest['end_lineno'] - biggest['lineno'] + 1) if biggest else 0
        print(f"{p['instance_id']:28} {g['path']:45} funcs={g['n_functions']:4} pkg_files={len(g['package_files']):3} lines={g['n_lines']:5} touched={t} max_fn_span={span}")
