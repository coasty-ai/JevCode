#!/usr/bin/env python3
"""Coverage study: what fraction of real fixes are reachable by each candidate source?

Pure code, no Jev calls. Datasets:
  (1) QuixBugs Python (40 one-line bugs) at /tmp/quixbugs
  (2) 30 SWE-bench Verified gold patches; repos checked out at base_commit under /tmp/jevonly/repos/<iid>

Sources tested per changed hunk:
  (a) mutation operators applied to the buggy line (depth 1, depth 2)
  (b) donor lines (verbatim in file/package/repo; identifier-normalised shape; donor + one identifier substitution)
  (c) token vocabulary (all tokens of the fixed line available from file identifiers, keywords, operators, literals in file/tests)
  (d) fix templates
Usage: python3 coverage_study.py [--quick] > results.json
"""
import ast, builtins, difflib, io, json, keyword, os, re, sys, time, tokenize
from collections import Counter, defaultdict

ROOT = '/Users/prateekjannu/Documents/vscode/JevCode'
QB = '/tmp/quixbugs'
REPOS = '/tmp/jevonly/repos'
BUILTINS = set(dir(builtins)) | {m for T in (list, dict, set, str, tuple, int, float, bytes, frozenset) for m in dir(T) if not m.startswith('_')} | {'self', 'cls'}
KEYWORDS = set(keyword.kwlist)
DEPTH2_CAP = 400_000

# ----------------------------------------------------------------------------- tokens

def toks(line):
    """Tokenize a single (possibly bracket-unbalanced) line. Returns list of (type, string, start_col, end_col)."""
    s = line.strip()
    out = []
    try:
        for t in tokenize.generate_tokens(io.StringIO(s + '\n').readline):
            if t.type in (tokenize.NEWLINE, tokenize.NL, tokenize.ENDMARKER, tokenize.INDENT, tokenize.DEDENT, tokenize.COMMENT):
                continue
            if t.type == tokenize.ERRORTOKEN and t.string.strip() == '':
                continue
            out.append((t.type, t.string, t.start[1], t.end[1]))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        pass
    return out

def norm(line):
    """Whitespace/indent-insensitive normal form of a code line."""
    t = toks(line)
    if not t:
        return line.strip()
    return ' '.join(x[1] for x in t)

def strip_comment(line):
    t = toks(line)
    if not t:
        return '' if line.strip().startswith('#') else line.rstrip()
    # tokens exclude comments; rebuild from source up to last token end
    s = line.strip()
    return line[: len(line) - len(line.lstrip())] + s[: t[-1][3]]

def is_name(t):
    return t[0] == tokenize.NAME and t[1] not in KEYWORDS

def shape(line):
    """Identifier-normalised shape: every non-keyword NAME -> '_' (literals kept)."""
    t = toks(line)
    return ' '.join('_' if is_name(x) else x[1] for x in t)

def alpha_shape(line):
    """Alpha-renamed shape: identifiers -> v0, v1 ... by first occurrence."""
    t = toks(line); m = {}
    out = []
    for x in t:
        if is_name(x):
            out.append(m.setdefault(x[1], 'v%d' % len(m)))
        else:
            out.append(x[1])
    return ' '.join(out)

# ----------------------------------------------------------------------------- scope

def file_identifiers(src):
    ids = set(); attrs = set(); lits = set()
    try:
        for t in tokenize.generate_tokens(io.StringIO(src).readline):
            if t.type == tokenize.NAME and t.string not in KEYWORDS:
                ids.add(t.string)
            elif t.type in (tokenize.NUMBER, tokenize.STRING):
                lits.add(t.string)
    except (tokenize.TokenError, IndentationError, SyntaxError):
        for m in re.finditer(r'[A-Za-z_][A-Za-z0-9_]*', src):
            if m.group() not in KEYWORDS: ids.add(m.group())
        for m in re.finditer(r'\b\d+\b|"[^"\n]*"|\'[^\'\n]*\'', src):
            lits.add(m.group())
    for m in re.finditer(r'\.\s*([A-Za-z_][A-Za-z0-9_]*)', src):
        attrs.add(m.group(1))
    return ids, attrs, lits

def enclosing_function_scope(src, lineno):
    """Names visible around line `lineno` (1-based): names used in the innermost enclosing def
    + module-level defs/classes/imports/assignments + names in the enclosing class. Falls back to file ids."""
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None, None
    names = set(); params = set(); func_lines = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for a in node.names: names.add((a.asname or a.name).split('.')[0])
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                for n in ast.walk(t):
                    if isinstance(n, ast.Name): names.add(n.id)
    best = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            end = getattr(node, 'end_lineno', None) or node.lineno
            if node.lineno <= lineno <= end and (best is None or node.lineno >= best.lineno):
                best = node
    if best is not None:
        func_lines = (best.lineno, best.end_lineno)
        for n in ast.walk(best):
            if isinstance(n, ast.Name): names.add(n.id)
            elif isinstance(n, ast.Attribute): names.add(n.attr)
            elif isinstance(n, ast.arg): names.add(n.arg); params.add(n.arg)
            elif isinstance(n, ast.keyword) and n.arg: names.add(n.arg)
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            end = getattr(node, 'end_lineno', None) or node.lineno
            if node.lineno <= lineno <= end:
                for n in node.body:
                    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)): names.add(n.name)
                    elif isinstance(n, ast.Assign):
                        for t in n.targets:
                            for m in ast.walk(t):
                                if isinstance(m, ast.Name): names.add(m.id)
    return names, params

# ----------------------------------------------------------------------------- mutation operators

REL = ['<', '<=', '>', '>=', '==', '!=']
ARITH = ['+', '-', '*', '/', '//', '%', '**']
BITW = ['&', '|', '^', '<<', '>>']
AUG = ['+=', '-=', '*=', '/=', '//=', '%=', '&=', '|=', '^=']
BUILTIN_SWAP = {'any': ['all'], 'all': ['any'], 'min': ['max'], 'max': ['min'], 'append': ['extend', 'insert', 'add'], 'extend': ['append'],
                'add': ['append', 'update', 'remove', 'discard'], 'update': ['add'], 'sorted': ['reversed', 'list'], 'reversed': ['sorted'],
                'list': ['set', 'tuple', 'sorted'], 'set': ['list', 'frozenset'], 'tuple': ['list'], 'str': ['repr'], 'repr': ['str'],
                'issuperset': ['issubset'], 'issubset': ['issuperset'], 'keys': ['values', 'items'], 'values': ['keys', 'items'],
                'items': ['keys', 'values'], 'pop': ['popleft', 'remove'], 'popleft': ['pop'], 'startswith': ['endswith'], 'endswith': ['startswith'],
                'isinstance': ['issubclass'], 'issubclass': ['isinstance'], 'floor': ['ceil'], 'ceil': ['floor'], 'lower': ['upper'], 'upper': ['lower'],
                'get': ['pop'], 'ValueError': ['TypeError', 'KeyError'], 'TypeError': ['ValueError'], 'KeyError': ['ValueError', 'AttributeError'],
                'AttributeError': ['KeyError', 'TypeError'], 'len': ['sum'], 'sum': ['len'], 'range': ['enumerate'], 'True': ['False'], 'False': ['True']}

def _replace(s, a, b, new):
    return s[:a] + new + s[b:]

def _match_close(t, i):
    """index of token closing the bracket opened at t[i]"""
    depth = 0
    for j in range(i, len(t)):
        if t[j][1] in '([{': depth += 1
        elif t[j][1] in ')]}':
            depth -= 1
            if depth == 0: return j
    return None

def _atom_span(t, i):
    """span (start_tok, end_tok_inclusive) of the primary starting at NAME/NUMBER token i (follows .attr, [..], (..))."""
    j = i
    while j + 1 < len(t):
        nxt = t[j + 1][1]
        if nxt == '.' and j + 2 < len(t) and t[j + 2][0] == tokenize.NAME:
            j += 2
        elif nxt in '([':
            c = _match_close(t, j + 1)
            if c is None: break
            j = c
        else:
            break
    return i, j

def _prev_is_dot(t, i):
    return i > 0 and t[i - 1][1] == '.'

def _is_callee(t, i):
    return i + 1 < len(t) and t[i + 1][1] == '('

def _depth_at(t):
    d = []; cur = 0
    for x in t:
        d.append(cur)
        if x[1] in '([{': cur += 1
        elif x[1] in ')]}': cur = max(0, cur - 1)
    return d

def _split_top(t, lo, hi, seps=(',',)):
    """split token index range [lo,hi) on top-level separators; returns list of (start,end) index ranges."""
    parts = []; depth = 0; start = lo
    for j in range(lo, hi):
        if t[j][1] in '([{': depth += 1
        elif t[j][1] in ')]}': depth -= 1
        elif depth == 0 and t[j][1] in seps:
            parts.append((start, j)); start = j + 1
    parts.append((start, hi))
    return parts

def _seg_text(s, t, a, b):
    """source text of tokens a..b-1"""
    if a >= b: return ''
    return s[t[a][2]:t[b - 1][3]]

def _operand_bounds(t, i):
    """for a binary operator at token i, find operand spans (left_start, i) and (i+1, right_end) at the same depth,
    delimited by ',', '=', ':', 'return', 'if', 'while', 'in', 'yield', brackets, or line ends."""
    delim = {',', '=', ':', 'return', 'if', 'elif', 'while', 'in', 'yield', 'and', 'or', 'not', 'for', 'else', 'lambda', 'assert'} | set(AUG)
    if t[i][1] in ('and', 'or'):
        delim -= {'and', 'or', 'not'}
    depth = 0; a = i
    while a - 1 >= 0:
        x = t[a - 1][1]
        if x in ')]}': depth += 1
        elif x in '([{':
            if depth == 0: break
            depth -= 1
        elif depth == 0 and x in delim: break
        a -= 1
    depth = 0; b = i + 1
    while b < len(t):
        x = t[b][1]
        if x in '([{': depth += 1
        elif x in ')]}':
            if depth == 0: break
            depth -= 1
        elif depth == 0 and x in delim: break
        b += 1
    return a, b

def mutants(line, scope, literals, attrs, params=()):
    """Yield (op_name, mutant_line) for one code line. `scope`: in-scope identifiers, `literals`: literal pool,
    `attrs`: attribute names seen in file, `params`: enclosing function parameters."""
    indent = line[: len(line) - len(line.lstrip())]
    s = line.strip()
    t = toks(s)
    out = []
    def emit(op, m):
        if m.strip() and m.strip() != s:
            out.append((op, indent + m))
    if not t:
        return out
    names_in_line = [x[1] for x in t if is_name(x)]
    scope_l = sorted(scope)
    lit_l = sorted(literals)

    # 1 relational swap
    for i, x in enumerate(t):
        if x[1] in REL:
            for r in REL:
                if r != x[1]: emit('rel_swap', _replace(s, x[2], x[3], r))
    # 2 arithmetic swap (incl. augmented, bitwise)
    for i, x in enumerate(t):
        if x[1] in ARITH:
            for r in ARITH:
                if r != x[1]: emit('arith_swap', _replace(s, x[2], x[3], r))
        if x[1] in BITW:
            for r in BITW:
                if r != x[1]: emit('bitwise_swap', _replace(s, x[2], x[3], r))
        if x[1] in AUG:
            for r in AUG:
                if r != x[1]: emit('augassign_swap', _replace(s, x[2], x[3], r))
    # 3 boolean swap
    for x in t:
        if x[1] == 'and': emit('bool_swap', _replace(s, x[2], x[3], 'or'))
        if x[1] == 'or': emit('bool_swap', _replace(s, x[2], x[3], 'and'))
    # 4 off-by-one: atoms ±1, numbers ±1, drop existing ±1
    for i, x in enumerate(t):
        if x[0] == tokenize.NUMBER and re.fullmatch(r'\d+', x[1]):
            n = int(x[1])
            emit('off_by_one', _replace(s, x[2], x[3], str(n + 1)))
            if n >= 1: emit('off_by_one', _replace(s, x[2], x[3], str(n - 1)))
            if n >= 2: emit('off_by_one', _replace(s, x[2], x[3], str(-n)))
        if is_name(x) and not _prev_is_dot(t, i) and not (i + 1 < len(t) and t[i + 1][1] == '='):
            a, b = _atom_span(t, i)
            if a == i:
                emit('off_by_one', _replace(s, t[b][3], t[b][3], ' + 1'))
                emit('off_by_one', _replace(s, t[b][3], t[b][3], ' - 1'))
        if x[1] in ('+', '-') and i + 1 < len(t) and t[i + 1][1] == '1' and i > 0 and (i + 2 >= len(t) or t[i + 2][1] in ',)]:'):
            emit('off_by_one', _replace(s, t[i - 1][3], t[i + 1][3], ''))
    # 4b arithmetic with in-scope identifier: atom -> atom ± ident
    for i, x in enumerate(t):
        if is_name(x) and not _prev_is_dot(t, i) and not _is_callee(t, i) and not (i + 1 < len(t) and t[i + 1][1] in '=.'):
            a, b = _atom_span(t, i)
            if a == i:
                for nm in scope_l:
                    if nm != x[1]:
                        emit('arith_ident', _replace(s, t[b][3], t[b][3], ' - ' + nm))
                        emit('arith_ident', _replace(s, t[b][3], t[b][3], ' + ' + nm))
    # 5 index flips and slices
    for i, x in enumerate(t):
        if x[1] == '[':
            c = _match_close(t, i)
            if c is None: continue
            inner = _seg_text(s, t, i + 1, c)
            if inner == '0': emit('index_flip', _replace(s, t[i][2], t[c][3], '[-1]'))
            if inner == '-1': emit('index_flip', _replace(s, t[i][2], t[c][3], '[0]'))
            if inner == '1:': emit('index_flip', _replace(s, t[i][2], t[c][3], '[:-1]'))
            if inner == ':-1': emit('index_flip', _replace(s, t[i][2], t[c][3], '[1:]'))
            parts = _split_top(t, i + 1, c)
            if len(parts) == 2:
                p0 = _seg_text(s, t, *parts[0]); p1 = _seg_text(s, t, *parts[1])
                emit('index_flip', _replace(s, t[i][2], t[c][3], '[%s, %s]' % (p1, p0)))
                emit('index_flip', _replace(s, t[i][2], t[c][3], '[%s]' % p0))
                emit('index_flip', _replace(s, t[i][2], t[c][3], '[%s]' % p1))
            sl = _split_top(t, i + 1, c, seps=(':',))
            if len(sl) == 2:
                p0 = _seg_text(s, t, *sl[0]); p1 = _seg_text(s, t, *sl[1])
                emit('index_flip', _replace(s, t[i][2], t[c][3], '[%s:%s]' % (p1, p0)))
        if is_name(x) and not _prev_is_dot(t, i) and not _is_callee(t, i) and not (i + 1 < len(t) and t[i + 1][1] in '=.[('):
            emit('add_slice', _replace(s, x[3], x[3], '[1:]'))
            emit('add_slice', _replace(s, x[3], x[3], '[:-1]'))
            emit('add_slice', _replace(s, x[3], x[3], '[0]'))
            emit('add_slice', _replace(s, x[3], x[3], '[-1]'))
            for nm in sorted(set(names_in_line) | set(params) | set(scope_l)):
                if nm != x[1]:
                    emit('add_slice', _replace(s, x[3], x[3], '[%s:]' % nm))
                    emit('add_slice', _replace(s, x[3], x[3], '[:%s]' % nm))
                    emit('add_slice', _replace(s, x[3], x[3], '[%s]' % nm))
    # 6 argument / element swap in calls, tuples, subscripts
    for i, x in enumerate(t):
        if x[1] in '([':
            c = _match_close(t, i)
            if c is None: continue
            parts = _split_top(t, i + 1, c)
            if len(parts) >= 2:
                segs = [_seg_text(s, t, a, b).strip() for a, b in parts]
                if all(segs):
                    for p in range(len(segs)):
                        for q in range(p + 1, len(segs)):
                            sw = list(segs); sw[p], sw[q] = sw[q], sw[p]
                            emit('arg_swap', _replace(s, t[i + 1][2], t[c - 1][3], ', '.join(sw)))
    # 7 operand swap for binary operators
    for i, x in enumerate(t):
        if x[1] in REL + ['+', '-', '*', 'and', 'or', '%']:
            a, b = _operand_bounds(t, i)
            if a < i and i + 1 < b:
                L = _seg_text(s, t, a, i).strip(); R = _seg_text(s, t, i + 1, b).strip()
                if L and R and L != R:
                    emit('operand_swap', _replace(s, t[a][2], t[b - 1][3], '%s %s %s' % (R, x[1], L)))
    # 8 negation: add/remove not; is/is not; in/not in; invert condition
    for i, x in enumerate(t):
        if x[1] == 'not':
            end = t[i + 1][2] if i + 1 < len(t) else x[3]
            emit('remove_not', _replace(s, x[2], end, ''))
        if x[1] in ('if', 'elif', 'while', 'return', 'assert', '=', 'and', 'or', '(', ',', 'yield') and i + 1 < len(t) and t[i + 1][1] != 'not':
            emit('add_not', _replace(s, t[i + 1][2], t[i + 1][2], 'not '))
        if x[1] == 'is' and i + 1 < len(t) and t[i + 1][1] == 'not':
            emit('remove_not', _replace(s, x[2], t[i + 1][3], 'is'))
        elif x[1] == 'is':
            emit('add_not', _replace(s, x[2], x[3], 'is not'))
        if x[1] == 'in' and not (i > 0 and t[i - 1][1] == 'not') and not any(y[1] == 'for' for y in t[:i]):
            emit('add_not', _replace(s, x[2], x[3], 'not in'))
        if x[1] == 'in' and i > 0 and t[i - 1][1] == 'not':
            emit('remove_not', _replace(s, t[i - 1][2], x[3], 'in'))
    # 9 is/== swap
    for i, x in enumerate(t):
        if x[1] == 'is' and i + 1 < len(t) and t[i + 1][1] == 'not': emit('is_eq_swap', _replace(s, x[2], t[i + 1][3], '!='))
        elif x[1] == 'is': emit('is_eq_swap', _replace(s, x[2], x[3], '=='))
        if x[1] == '==': emit('is_eq_swap', _replace(s, x[2], x[3], 'is'))
        if x[1] == '!=': emit('is_eq_swap', _replace(s, x[2], x[3], 'is not'))
    # 10 constant substitution (literal -> other literal from pool; literal -> in-scope identifier)
    for i, x in enumerate(t):
        if x[0] in (tokenize.NUMBER, tokenize.STRING) or x[1] in ('True', 'False', 'None'):
            for l in lit_l + ['True', 'False', 'None', '0', '1', '-1', '""', '[]', '{}', '()']:
                if l != x[1]: emit('const_sub', _replace(s, x[2], x[3], l))
            for nm in scope_l:
                emit('const_to_ident', _replace(s, x[2], x[3], nm))
        if x[1] == '[' and i + 1 < len(t) and t[i + 1][1] == ']':
            emit('const_sub', _replace(s, x[2], t[i + 1][3], '[[]]'))
            emit('const_sub', _replace(s, x[2], t[i + 1][3], 'None'))
            for nm in scope_l: emit('const_to_ident', _replace(s, x[2], t[i + 1][3], '[%s]' % nm))
    # 11 identifier substitution (in-scope names) and attribute substitution
    for i, x in enumerate(t):
        if is_name(x) and not _prev_is_dot(t, i):
            for nm in scope_l:
                if nm != x[1]: emit('ident_sub', _replace(s, x[2], x[3], nm))
            for l in ['True', 'False', 'None', '0', '1', '[]']:
                emit('ident_to_const', _replace(s, x[2], x[3], l))
        if is_name(x) and _prev_is_dot(t, i):
            for nm in sorted(attrs):
                if nm != x[1]: emit('attr_sub', _replace(s, x[2], x[3], nm))
        if is_name(x) and x[1] in BUILTIN_SWAP:
            for nm in BUILTIN_SWAP[x[1]]: emit('builtin_swap', _replace(s, x[2], x[3], nm))
    # 12 return-value tweaks
    if t[0][1] == 'return':
        rest = s[t[1][2]:] if len(t) > 1 else ''
        for l in ['True', 'False', 'None', '0', '1', '-1', '[]', '[[]]', '{}', '""', 'not ' + rest if rest else '', '[%s]' % rest if rest else '',
                  'len(%s)' % rest if rest else '', 'list(%s)' % rest if rest else '', '%s == 0' % rest if rest else '']:
            if l: emit('return_tweak', 'return ' + l)
        for nm in scope_l:
            emit('return_tweak', 'return %s' % nm)
            emit('return_tweak', 'return %s == 0' % nm)
            emit('return_tweak', 'return not %s' % nm)
            if rest and nm not in rest:
                emit('return_tweak', 'return %s + %s' % (nm, rest))
                emit('return_tweak', 'return %s + %s' % (rest, nm))
    # 13 range bounds
    for i, x in enumerate(t):
        if x[1] == 'range' and _is_callee(t, i):
            c = _match_close(t, i + 1)
            if c is None: continue
            parts = [_seg_text(s, t, a, b).strip() for a, b in _split_top(t, i + 2, c)]
            cands = []
            if len(parts) == 1:
                b_ = parts[0]; cands += ['%s + 1' % b_, '%s - 1' % b_, '1, %s' % b_, '1, %s + 1' % b_]
            elif len(parts) == 2:
                a_, b_ = parts; cands += ['%s, %s + 1' % (a_, b_), '%s, %s - 1' % (a_, b_), '%s + 1, %s' % (a_, b_), '%s - 1, %s' % (a_, b_), b_, a_, '%s, %s' % (b_, a_)]
            elif len(parts) == 3:
                a_, b_, st = parts; cands += ['%s, %s + 1, %s' % (a_, b_, st), '%s, %s - 1, %s' % (a_, b_, st), '%s, %s' % (a_, b_), '%s, %s, -%s' % (b_, a_, st)]
            for cnd in cands: emit('range_bounds', _replace(s, t[i + 2][2], t[c - 1][3] if c - 1 >= i + 2 else t[i + 1][3], cnd))
    # 14 unwrap single-argument call  f(x) -> x ; drop additive term  A + B -> A / B
    for i, x in enumerate(t):
        if is_name(x) and _is_callee(t, i):
            c = _match_close(t, i + 1)
            if c is None: continue
            parts = _split_top(t, i + 2, c)
            if len(parts) == 1 and c > i + 2:
                start = t[i][2]
                k = i
                while k - 2 >= 0 and t[k - 1][1] == '.' and t[k - 2][0] == tokenize.NAME:
                    k -= 2; start = t[k][2]
                emit('unwrap_call', _replace(s, start, t[c][3], _seg_text(s, t, i + 2, c)))
        if x[1] in ('+', '-', '*', 'and', 'or'):
            a, b = _operand_bounds(t, i)
            if a < i and i + 1 < b:
                emit('drop_term', _replace(s, t[a][2], t[b - 1][3], _seg_text(s, t, a, i).strip()))
                emit('drop_term', _replace(s, t[a][2], t[b - 1][3], _seg_text(s, t, i + 1, b).strip()))
    # 15 wrap RHS / return expr in max()/min()/abs()/list()/sorted()/len()
    rhs_start = None
    for i, x in enumerate(t):
        if x[1] == '=' and i + 1 < len(t):
            rhs_start = i + 1; break
    if t[0][1] in ('return', 'yield') and len(t) > 1: rhs_start = 1
    if rhs_start is not None:
        rhs = s[t[rhs_start][2]:]
        lhs_names = [x[1] for x in t[:rhs_start] if is_name(x)]
        for fn in ('max', 'min'):
            for arg in ['0', '1'] + lhs_names + names_in_line:
                if arg not in rhs or arg in lhs_names:
                    emit('wrap_minmax', _replace(s, t[rhs_start][2], len(s), '%s(%s, %s)' % (fn, arg, rhs)))
        for fn in ('abs', 'list', 'sorted', 'len', 'str', 'int', 'tuple', 'set', 'bool', 'reversed', 'not'):
            emit('wrap_call', _replace(s, t[rhs_start][2], len(s), '%s(%s)' % (fn, rhs) if fn != 'not' else 'not (%s)' % rhs))
        for nm in scope_l:
            emit('prepend_term', _replace(s, t[rhs_start][2], len(s), '%s + %s' % (nm, rhs)))
            emit('prepend_term', _replace(s, t[rhs_start][2], len(s), '%s + %s' % (rhs, nm)))
    # 16 add guard condition to if/while/elif
    if t[0][1] in ('if', 'while', 'elif') and t[-1][1] == ':' and len(t) > 2:
        cond = s[t[1][2]:t[-2][3]]
        for nm in sorted(set(names_in_line) | set(params)):
            for g in ['%s is None or %s' % (nm, cond), '%s is not None and %s' % (nm, cond), '%s or not %s' % (cond, nm), '%s and %s' % (cond, nm),
                      'not %s or %s' % (nm, cond), '%s and not %s' % (cond, nm), '%s or %s' % (cond, nm), '%s and %s' % (nm, cond)]:
                emit('add_guard_cond', '%s %s:' % (t[0][1], g))
    # 17 exponent / power tweak
    for i, x in enumerate(t):
        if is_name(x) and not _prev_is_dot(t, i) and not _is_callee(t, i) and not (i + 1 < len(t) and t[i + 1][1] in '=.[('):
            emit('exponent', _replace(s, x[3], x[3], ' ** 2'))
    # 18 expression -> identifier (replace a call or subscript primary by an in-scope name)
    for i, x in enumerate(t):
        if is_name(x) and not _prev_is_dot(t, i) and i + 1 < len(t) and t[i + 1][1] in '([':
            a, b = _atom_span(t, i)
            if b > i:
                for nm in scope_l:
                    if nm != x[1]: emit('expr_to_ident', _replace(s, t[a][2], t[b][3], nm))
    # 19 method call -> assignment  a.update(b) -> a = b ; a.f(b) -> a = b
    m = re.fullmatch(r'([A-Za-z_][\w\.\[\], ]*)\.(\w+)\((.*)\)', s)
    if m and m.group(2) not in ('append',):
        emit('call_to_assign', '%s = %s' % (m.group(1), m.group(3)))
    m = re.fullmatch(r'([A-Za-z_][\w\.\[\], ]*?)\s*=\s*(.+)', s)
    if m and not s.startswith(('if', 'return')):
        for meth in ('update', 'append', 'extend', 'add'):
            emit('assign_to_call', '%s.%s(%s)' % (m.group(1), meth, m.group(2)))
    # 20 keyword swap: while/if True -> while <name> ; break<->continue ; return<->yield ; ==0 <-> !=0 etc.
    if t[0][1] in ('while', 'if') and len(t) == 3 and t[1][1] in ('True', '1'):
        for nm in scope_l: emit('const_to_ident', '%s %s:' % (t[0][1], nm))
    for i, x in enumerate(t):
        if x[1] == 'break': emit('keyword_swap', _replace(s, x[2], x[3], 'continue'))
        if x[1] == 'continue': emit('keyword_swap', _replace(s, x[2], x[3], 'break'))
        if x[1] == 'return' and i == 0: emit('keyword_swap', _replace(s, x[2], x[3], 'yield'))
        if x[1] == 'yield' and i == 0: emit('keyword_swap', _replace(s, x[2], x[3], 'return'))
        if x[1] == 'elif': emit('keyword_swap', _replace(s, x[2], x[3], 'if'))
        if x[1] == 'if' and i == 0 and t[-1][1] == ':': emit('keyword_swap', _replace(s, x[2], x[3], 'elif')); emit('keyword_swap', _replace(s, x[2], x[3], 'while'))
        if x[1] == 'while' and i == 0: emit('keyword_swap', _replace(s, x[2], x[3], 'if'))
    # --- operators added after reading the SWE-bench patches (post-hoc; flagged in the report) ---
    # 21 qualify a bare name with self./cls./<scope name>. ; or drop such a qualifier
    for i, x in enumerate(t):
        if is_name(x) and not _prev_is_dot(t, i) and not (i + 1 < len(t) and t[i + 1][1] == '=' and (i == 0)):
            for q in ('self', 'cls') + tuple(n for n in scope_l if n != x[1] and (n in params or n[:1].islower())):
                if q != x[1]: emit('qualify_name', _replace(s, x[2], x[2], q + '.'))
        if is_name(x) and _prev_is_dot(t, i) and i >= 2 and t[i - 2][0] == tokenize.NAME and not _prev_is_dot(t, i - 2):
            emit('drop_qualifier', _replace(s, t[i - 2][2], x[2], ''))
    # 22 drop one comma-separated element of a call / tuple / list / dict display
    for i, x in enumerate(t):
        if x[1] in '([{':
            c = _match_close(t, i)
            if c is None: continue
            parts = _split_top(t, i + 1, c)
            if len(parts) >= 2:
                segs = [_seg_text(s, t, a, b).strip() for a, b in parts]
                for p in range(len(segs)):
                    keep = [sg for q, sg in enumerate(segs) if q != p and sg]
                    emit('drop_element', _replace(s, t[i + 1][2], t[c - 1][3], ', '.join(keep)))
    # 23 add a first parameter (cls/self) to a def, or drop the first parameter
    if t[0][1] == 'def' and len(t) > 3 and t[2][1] == '(':
        c = _match_close(t, 2)
        if c is not None:
            inner = _seg_text(s, t, 3, c).strip()
            for q in ('cls', 'self'):
                emit('add_first_param', _replace(s, t[2][3], t[c][2], q + (', ' + inner if inner else '')))
            parts = _split_top(t, 3, c)
            if len(parts) >= 2:
                emit('drop_first_param', _replace(s, t[2][3], t[c][2], ', '.join(_seg_text(s, t, a, b).strip() for a, b in parts[1:])))
            if len(parts) >= 1 and inner and not inner.startswith(('cls', 'self')):
                emit('add_first_param', _replace(s, t[2][3], t[c][2], 'cls, ' + inner))
    # 24 comprehension filter: `for x in y` fragment (no colon) -> `for x in y if x` ; `if C` fragment -> `if X and C`
    if t[-1][1] != ':' and any(y[1] == 'for' for y in t) and not any(y[1] == 'if' for y in t):
        fi = [i for i, y in enumerate(t) if y[1] == 'for'][-1]
        depth = 0; ins = len(s)
        for j in range(fi, len(t)):
            if t[j][1] in '([{': depth += 1
            elif t[j][1] in ')]}':
                if depth == 0: ins = t[j][2]; break
                depth -= 1
        for nm in names_in_line:
            emit('comp_filter', _replace(s, ins, ins, ' if ' + nm))
            emit('comp_filter', _replace(s, ins, ins, ' if not ' + nm))
            emit('comp_filter', _replace(s, ins, ins, ' if ' + nm + ' is not None'))
    if t[0][1] == 'if' and t[-1][1] != ':' and len(t) > 1:
        cond = s[t[1][2]:]
        for nm in sorted(set(names_in_line) | set(params)):
            for g in ['%s and %s' % (nm, cond), '%s is not None and %s' % (nm, cond), '%s or %s' % (cond, nm), 'not %s and %s' % (nm, cond)]:
                emit('add_guard_cond', 'if ' + g)
    return out

BASELINE_REGEX = [(r'<=', '<'), (r'>=', '>'), (r'(?<![<>=!])<(?!=)', '<='), (r'(?<![<>=!])>(?!=)', '>='), (r'==', '!='), (r'!=', '=='),
    (r'\+ 1\b', '- 1'), (r'- 1\b', '+ 1'), (r'\band\b', 'or'), (r'\bor\b', 'and'), (r'\+', '-'), (r'(?<!\*)\*(?!\*)', '/'),
    (r'\bTrue\b', 'False'), (r'\bFalse\b', 'True'), (r'\bnot ', ''), (r'\[0\]', '[-1]'), (r'\[-1\]', '[0]'), (r'//', '/'), (r'(?<!/)/(?!/)', '//')]

def baseline_mutants(line):
    out = set()
    for pat, rep in BASELINE_REGEX:
        m = re.sub(pat, rep, line)
        if m != line: out.add(m)
    sw = re.sub(r'\(([^(),]+), ([^(),]+)\)', r'(\2, \1)', line, count=1)
    if sw != line: out.add(sw)
    return out

STRUCTURAL_OPS = {'rel_swap', 'arith_swap', 'bitwise_swap', 'augassign_swap', 'bool_swap', 'off_by_one', 'index_flip', 'add_slice', 'arg_swap',
                  'operand_swap', 'remove_not', 'add_not', 'is_eq_swap', 'builtin_swap', 'range_bounds', 'unwrap_call', 'drop_term', 'wrap_minmax',
                  'wrap_call', 'exponent', 'call_to_assign', 'assign_to_call', 'keyword_swap', 'drop_qualifier', 'drop_element', 'add_first_param', 'drop_first_param', 'comp_filter'}
POST_HOC_OPS = {'qualify_name', 'drop_qualifier', 'drop_element', 'add_first_param', 'drop_first_param', 'comp_filter'}

def mutation_reach(buggy, fixed, scope, literals, attrs, params, depth2=True):
    """Is norm(fixed) among mutants of buggy? Returns dict with hit_depth (1,2 or None), ops, counts."""
    target = norm(fixed)
    first = mutants(buggy, scope, literals, attrs, params)
    seen = {}
    for op, m in first:
        seen.setdefault(norm(m), set()).add(op)
    res = {'n_depth1': len(seen), 'hit_depth': None, 'ops': [], 'n_depth2': None, 'depth2_capped': False,
           'baseline_hit': target in {norm(m) for m in baseline_mutants(buggy)}}
    if target in seen:
        res['hit_depth'] = 1; res['ops'] = sorted(seen[target]); return res
    if not depth2:
        return res
    # depth 2: structural∘any ∪ any∘structural (skip substitution∘substitution to bound the blow-up)
    seen2 = set(); capped = False
    small_scope = set(scope); small_lits = set(literals)
    for m1, ops1 in seen.items():
        struct1 = bool(ops1 & STRUCTURAL_OPS)
        for op2, m2 in mutants(m1, small_scope if struct1 else set(), small_lits if struct1 else set(), attrs if struct1 else set(), params):
            if not struct1 and op2 not in STRUCTURAL_OPS: continue
            n2 = norm(m2)
            if n2 == target:
                res['hit_depth'] = 2; res['ops'] = sorted(ops1) + ['>', op2]
                res['n_depth2'] = len(seen2); return res
            seen2.add(n2)
            if len(seen2) > DEPTH2_CAP: capped = True; break
        if capped: break
    res['n_depth2'] = len(seen2); res['depth2_capped'] = capped
    return res

# ----------------------------------------------------------------------------- donors

class DonorIndex:
    def __init__(self):
        self.verbatim = {'file': set(), 'package': set(), 'repo': set()}
        self.shape_repo = defaultdict(list)   # shape -> [norm lines]
        self.skel_repo = defaultdict(list)    # names+literals blanked -> [norm lines]
        self.shape_file = set()
        self.alpha_repo = set(); self.alpha_file = set()
    def add(self, src, level_flags):
        by_line = defaultdict(list)
        try:
            for t in tokenize.generate_tokens(io.StringIO(src).readline):
                if t.type in (tokenize.NEWLINE, tokenize.NL, tokenize.ENDMARKER, tokenize.INDENT, tokenize.DEDENT, tokenize.COMMENT, tokenize.ENCODING):
                    continue
                if t.type == tokenize.ERRORTOKEN and not t.string.strip(): continue
                by_line[t.start[0]].append((t.type, t.string))
        except (tokenize.TokenError, IndentationError, SyntaxError):
            pass
        for ln, tt in by_line.items():
            n = ' '.join(x[1] for x in tt)
            for lvl in level_flags: self.verbatim[lvl].add(n)
            sh = ' '.join('_' if (x[0] == tokenize.NAME and x[1] not in KEYWORDS) else x[1] for x in tt)
            m = {}; al = ' '.join(m.setdefault(x[1], 'v%d' % len(m)) if (x[0] == tokenize.NAME and x[1] not in KEYWORDS) else x[1] for x in tt)
            if 'repo' in level_flags:
                b = self.shape_repo[sh]
                if len(b) < 200 and n not in b: b.append(n)
                sk = ' '.join('_' if (x[0] in (tokenize.NUMBER, tokenize.STRING) or (x[0] == tokenize.NAME and x[1] not in KEYWORDS)) else x[1] for x in tt)
                b2 = self.skel_repo[sk]
                if len(b2) < 400 and n not in b2: b2.append(n)
                self.alpha_repo.add(al)
            if 'file' in level_flags:
                self.shape_file.add(sh); self.alpha_file.add(al)

def donor_reach(fixed, idx, scope, lit_pool=frozenset()):
    n = norm(fixed); sh = shape(fixed)
    ft = toks(fixed); ftoks = [x[1] for x in ft]
    sk = ' '.join('_' if (x[0] in (tokenize.NUMBER, tokenize.STRING) or is_name(x)) else x[1] for x in ft)
    r = {'verbatim_file': n in idx.verbatim['file'], 'verbatim_package': n in idx.verbatim['package'], 'verbatim_repo': n in idx.verbatim['repo'],
         'shape_file': sh in idx.shape_file, 'shape_repo': sh in idx.shape_repo, 'alpha_file': alpha_shape(fixed) in idx.alpha_file,
         'alpha_repo': alpha_shape(fixed) in idx.alpha_repo, 'one_sub_repo': False, 'one_sub_donor': None, 'two_sub_repo': False, 'two_sub_donor': None,
         'min_subs': None}
    if r['verbatim_repo']:
        r['one_sub_repo'] = r['two_sub_repo'] = True; r['min_subs'] = 0; return r
    best = None
    for donor in idx.skel_repo.get(sk, []):
        dt = donor.split(' ')
        if len(dt) != len(ftoks): continue
        diff = [i for i in range(len(dt)) if dt[i] != ftoks[i]]
        ok = all((is_name(ft[i]) and ftoks[i] in scope) or (ft[i][0] in (tokenize.NUMBER, tokenize.STRING) and ftoks[i] in lit_pool) for i in diff)
        if not ok or not diff: continue
        if best is None or len(diff) < best[0]: best = (len(diff), donor)
    if best:
        r['min_subs'] = best[0]
        if best[0] <= 1: r['one_sub_repo'] = True; r['one_sub_donor'] = best[1]
        if best[0] <= 2: r['two_sub_repo'] = True; r['two_sub_donor'] = best[1]
    return r

# ----------------------------------------------------------------------------- vocabulary

def vocab_reach(fixed, file_ids, file_lits, test_ids, test_lits):
    t = toks(fixed)
    missing_file = []; missing_with_tests = []
    for x in t:
        if x[0] == tokenize.NAME:
            if x[1] in KEYWORDS or x[1] in BUILTINS: continue
            if x[1] not in file_ids:
                missing_file.append(x[1])
                if x[1] not in test_ids: missing_with_tests.append(x[1])
        elif x[0] in (tokenize.NUMBER, tokenize.STRING):
            if x[1] in ('0', '1', '2', '-1', '""', "''", '"\\n"'): continue
            if x[1] not in file_lits:
                missing_file.append(x[1])
                if x[1] not in test_lits: missing_with_tests.append(x[1])
    return {'all_in_file': not missing_file, 'all_in_file_plus_tests': not missing_with_tests, 'missing_file': missing_file, 'missing_with_tests': missing_with_tests}

# ----------------------------------------------------------------------------- templates

def _dedent_block(lines):
    ls = [l for l in lines if l.strip()]
    if not ls: return []
    ind = min(len(l) - len(l.lstrip()) for l in ls)
    return [l[ind:] for l in ls]

def template_reach(removed, added, file_src, func_lines, scope, params):
    """Return list of template names that produce the added lines from the removed lines (+ file context)."""
    hits = []
    A = [l for l in added if l.strip()]; R = [l for l in removed if l.strip()]
    An = [norm(l) for l in A]; Rn = [norm(l) for l in R]
    file_lines = [norm(l) for l in file_src.split('\n') if l.strip()]
    file_set = set(file_lines)
    func_set = set(file_lines)
    if func_lines:
        func_set = set(norm(l) for l in file_src.split('\n')[func_lines[0] - 1: func_lines[1]] if l.strip())
    # guard insertion: pure insertion of `if <cond>:` + return/raise/continue/pass body (1-3 lines) ; or `if`/`while` with cond extended
    if not R and A and re.match(r'(if|elif) .*:$', A[0].strip()) and 1 <= len(A) <= 4 and all(re.match(r'(return|raise|continue|break|pass|yield)\b', l.strip()) or re.match(r'\w[\w\.\[\]]* = ', l.strip()) for l in A[1:]):
        hits.append('guard_insertion')
    if not R and A and re.match(r'if .*:$', A[0].strip()) and len(A) == 1:
        hits.append('guard_insertion')
    if len(R) == 1 and len(A) == 1 and re.match(r'(if|elif|while) ', Rn[0]) and re.match(r'(if|elif|while) ', An[0]):
        rc = Rn[0].split(' ', 1)[1][:-1].strip(); ac = An[0].split(' ', 1)[1][:-1].strip()
        if rc and rc in ac and ac != rc and (ac.startswith(rc) or ac.endswith(rc)):
            hits.append('guard_extend_condition')
    # missing import
    if not R and all(re.match(r'(from \S+ )?import ', l.strip()) for l in A):
        hits.append('missing_import')
    if R and len(R) == len(A) and all(re.match(r'(from \S+ )?import ', l.strip()) for l in A + R):
        hits.append('import_change')
    # attribute change / call-target change / single identifier change (same shape)
    if len(R) == 1 and len(A) == 1:
        rt = [x[1] for x in toks(R[0])]; at = [x[1] for x in toks(A[0])]
        if len(rt) == len(at):
            diff = [i for i in range(len(rt)) if rt[i] != at[i]]
            if len(diff) == 1:
                i = diff[0]
                prev_dot = i > 0 and at[i - 1] == '.'
                callee = i + 1 < len(at) and at[i + 1] == '('
                if prev_dot and callee: hits.append('call_target_change')
                elif prev_dot: hits.append('attribute_change')
                elif callee: hits.append('call_target_change')
                elif re.fullmatch(r'[A-Za-z_]\w*', at[i]) and at[i] not in KEYWORDS: hits.append('identifier_change')
                elif re.fullmatch(r'\d+|"[^"]*"|\'[^\']*\'', at[i]): hits.append('literal_change')
                else: hits.append('operator_change')
    # add parameter with default (def line) / add keyword argument at call site
    if len(R) == 1 and len(A) == 1 and R[0].strip().startswith('def ') and A[0].strip().startswith('def '):
        if re.search(r'\w+=[^,)]+', A[0]) and len(A[0]) > len(R[0]): hits.append('add_parameter_default')
        else: hits.append('signature_change')
    if len(R) == 1 and len(A) == 1 and not A[0].strip().startswith('def ') and An[0] != Rn[0]:
        rs = Rn[0]; as_ = An[0]
        m = re.fullmatch(re.escape(rs[:-1]) + r'(, )?(\w+ = [^,]+)(, .*)?\)' if rs.endswith(')') else 'x^', as_)
        if m: hits.append('add_keyword_argument')
    # wrap in try/except
    if A and any(l.strip() == 'try:' for l in A) and any(l.strip().startswith('except') for l in A):
        body = [norm(l) for l in A if l.strip() != 'try:' and not l.strip().startswith('except') and not re.match(r'(pass|raise|return|continue|break)\b', l.strip())]
        old = set(Rn)
        # generative only if every non-header body line is one of the old lines (the template re-indents old code, it does not write fallbacks)
        if all(b in old for b in body): hits.append('wrap_try_except')
        else: hits.append('wrap_try_except_new_body')
    # add elif/else branch copying an existing branch (body lines all exist in function/file)
    if A and re.match(r'(elif .*|else)\s*:$', A[0].strip()) and len(A) >= 2:
        if all(norm(l) in func_set or norm(l) in file_set for l in A[1:]): hits.append('add_branch_copy')
        elif all(shape(l) in set(shape(x) for x in file_src.split('\n')) for l in A[1:]): hits.append('add_branch_shape')
    # missing statement copied from same function/file (pure insertion, every added line exists elsewhere)
    if not R and A and all(n in func_set for n in An): hits.append('insert_copy_from_function')
    elif not R and A and all(n in file_set for n in An): hits.append('insert_copy_from_file')
    # insert `x.append(y)` / `x.add(y)` / `y = x` with in-scope names
    if not R and len(A) == 1:
        m = re.fullmatch(r'(\w+)\.(append|add|extend|remove|pop)\((\w+)\)', An[0].replace(' ', ''))
        if m and m.group(1) in scope and m.group(3) in scope: hits.append('insert_method_call_scope')
        m = re.fullmatch(r'(\w+) = (\w+)', An[0])
        if m and m.group(1) in scope and m.group(2) in scope: hits.append('insert_assign_scope')
        m = re.fullmatch(r'(return|raise|continue|break|pass)( \w+)?', An[0])
        if m and (not m.group(2) or m.group(2).strip() in scope): hits.append('insert_return_or_flow')
        if re.fullmatch(r'return .*', An[0]): hits.append('insert_return_expr')
    # missing return: `f(x)` -> `return f(x)`
    if len(R) == 1 and len(A) == 1 and An[0] == 'return ' + Rn[0]: hits.append('add_return')
    # decorator / docstring / comment-only
    if not R and A and all(l.strip().startswith('@') for l in A): hits.append('add_decorator')
    if A and all(l.strip().startswith(('#', '"""', "'''")) or not l.strip() for l in A) and not R: hits.append('comment_or_doc_only')
    # deletion
    if R and not A: hits.append('delete_lines')
    # new function/method or class
    if not R and A and re.match(r'(async )?def |class ', A[0].strip()): hits.append('new_function')
    # wrap value: `x = e` -> `x = f(e)`
    if len(R) == 1 and len(A) == 1:
        m1 = re.fullmatch(r'(.*?)= (.*)', Rn[0]); m2 = re.fullmatch(r'(.*?)= (.*)', An[0])
        if m1 and m2 and m1.group(1) == m2.group(1) and re.fullmatch(r'[\w\.]+ \( ' + re.escape(m1.group(2)) + r' (, .*)?\)', m2.group(2)): hits.append('wrap_value_in_call')
        if m1 and m2 and m1.group(1) == m2.group(1) and m2.group(2).endswith(m1.group(2)) and m2.group(2) != m1.group(2): hits.append('prefix_value')
    # extend a call with extra argument: f(a) -> f(a, b)
    if len(R) == 1 and len(A) == 1 and Rn[0].endswith(')') and An[0].endswith(')') and An[0].startswith(Rn[0][:-1]) and An[0][len(Rn[0]) - 1:].startswith(','):
        hits.append('add_call_argument')
    # multi-line: all added lines exist in the function/file (block move/copy)
    if R and A and len(A) > 1 and all(n in file_set for n in An): hits.append('replace_with_copied_lines')
    return sorted(set(hits))

# ----------------------------------------------------------------------------- code vs prose lines

def code_line_numbers(src):
    """Set of 1-based line numbers that carry at least one non-string, non-comment token
    (i.e. real code; lines inside docstrings or consisting only of a string literal are excluded)."""
    code = set()
    try:
        for t in tokenize.generate_tokens(io.StringIO(src).readline):
            if t.type in (tokenize.NEWLINE, tokenize.NL, tokenize.ENDMARKER, tokenize.INDENT, tokenize.DEDENT, tokenize.COMMENT, tokenize.ENCODING, tokenize.STRING):
                continue
            if t.type == tokenize.ERRORTOKEN and not t.string.strip(): continue
            code.add(t.start[0])
    except (tokenize.TokenError, IndentationError, SyntaxError):
        for i, l in enumerate(src.split('\n'), 1):
            if l.strip() and not l.strip().startswith(('#', '"""', "'''")): code.add(i)
    return code

# ----------------------------------------------------------------------------- hunks

def classify(removed, added):
    R = [l for l in removed if l.strip()]; A = [l for l in added if l.strip()]
    if not A and R: return 'deletion'
    if not R and A:
        if re.match(r'\s*(async )?def |\s*class ', A[0]) or (len(A) >= 2 and re.match(r'\s*@', A[0]) and any(re.match(r'\s*(async )?def ', l) for l in A[:3])):
            return 'new_function'
        return 'pure_insertion'
    if len(R) == 1 and len(A) == 1: return 'single_line_modification'
    return 'multi_line_modification'

def pair_lines(removed, added):
    """Align removed and added lines (difflib on normalised tokens); return list of (buggy or None, fixed or None) for fixed lines,
    plus list of removed lines with no counterpart."""
    R = [l for l in removed if l.strip()]; A = [l for l in added if l.strip()]
    Rn = [shape(l) for l in R]; An = [shape(l) for l in A]
    sm = difflib.SequenceMatcher(a=Rn, b=An, autojunk=False)
    pairs = []; unpaired_removed = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            for k in range(i2 - i1):
                if norm(R[i1 + k]) != norm(A[j1 + k]): pairs.append((R[i1 + k], A[j1 + k]))
        elif tag == 'replace':
            n = min(i2 - i1, j2 - j1)
            for k in range(n): pairs.append((R[i1 + k], A[j1 + k]))
            for k in range(n, j2 - j1): pairs.append((None, A[j1 + k]))
            for k in range(n, i2 - i1): unpaired_removed.append(R[i1 + k])
        elif tag == 'insert':
            for k in range(j1, j2): pairs.append((None, A[k]))
        elif tag == 'delete':
            for k in range(i1, i2): unpaired_removed.append(R[k])
    # if difflib paired nothing but counts match, pair positionally
    if len(R) == len(A) and all(p[0] is None for p in pairs):
        pairs = list(zip(R, A)); unpaired_removed = []
    return pairs, unpaired_removed

def parse_patch(patch):
    """Return list of change groups: dict(file, old_start, removed[], added[], context_before[])"""
    groups = []; cur_file = None; old_ln = None; new_ln = None
    lines = patch.split('\n'); i = 0
    while i < len(lines):
        l = lines[i]
        if l.startswith('+++ '):
            cur_file = l[6:] if l.startswith('+++ b/') else l[4:]
        elif l.startswith('@@'):
            m = re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', l)
            old_ln = int(m.group(1)); new_ln = int(m.group(3))
        elif cur_file and old_ln is not None and (l.startswith('-') or l.startswith('+')) and not l.startswith('---') and not l.startswith('+++'):
            removed = []; added = []; start = old_ln; new_start = new_ln; removed_ln = []; added_ln = []
            while i < len(lines) and (lines[i].startswith('-') or lines[i].startswith('+')) and not lines[i].startswith('---') and not lines[i].startswith('+++'):
                if lines[i].startswith('-'): removed.append(lines[i][1:]); removed_ln.append(old_ln); old_ln += 1
                else: added.append(lines[i][1:]); added_ln.append(new_ln); new_ln += 1
                i += 1
            groups.append({'file': cur_file, 'old_start': start, 'new_start': new_start, 'removed': removed, 'added': added, 'removed_ln': removed_ln, 'added_ln': added_ln})
            continue
        elif cur_file and old_ln is not None and (l.startswith(' ') or l == ''):
            if not (l == '' and (i + 1 >= len(lines) or lines[i + 1].startswith('diff'))): old_ln += 1; new_ln += 1
        i += 1
    return groups

def _find_seq(lines, seq, near, window=400):
    """1-based start of the occurrence of `seq` (list of exact lines) in `lines` closest to `near`, or None."""
    if not seq: return None
    best = None
    for i in range(max(0, near - 1 - window), min(len(lines) - len(seq) + 1, near - 1 + window)):
        if lines[i:i + len(seq)] == seq:
            if best is None or abs(i + 1 - near) < abs(best - near): best = i + 1
    return best

def relocate(h, old_src, new_src):
    """Correct the hunk's old/new line numbers when the patch header is off (git apply tolerates offsets)."""
    if h['removed']:
        st = _find_seq(old_src.split('\n'), h['removed'], h['old_start'])
        if st is not None and st != h['old_start']:
            h['old_start'] = st; h['removed_ln'] = list(range(st, st + len(h['removed'])))
    if h['added'] and new_src is not None:
        st = _find_seq(new_src.split('\n'), h['added'], h.get('new_start', h['old_start']))
        if st is not None and st != h.get('new_start'):
            h['new_start'] = st; h['added_ln'] = list(range(st, st + len(h['added'])))
    return h

# ----------------------------------------------------------------------------- analysis per hunk

def analyse_hunk(h, file_src, idx, test_ids, test_lits, depth2=True, fixed_src=None):
    R, A = h['removed'], h['added']
    n_added_raw = len([l for l in A if l.strip()]); n_removed_raw = len([l for l in R if l.strip()])
    if fixed_src is not None and 'added_ln' in h:
        old_code = code_line_numbers(file_src); new_code = code_line_numbers(fixed_src)
        R = [l for l, ln in zip(R, h['removed_ln']) if ln in old_code]
        A = [l for l, ln in zip(A, h['added_ln']) if ln in new_code]
    else:
        R = [l for l in R if l.strip() and not l.strip().startswith('#')]
        A = [l for l in A if l.strip() and not l.strip().startswith('#')]
    if not R and not A:
        return {'file': h['file'], 'old_start': h['old_start'], 'kind': 'non_code_only', 'n_removed': n_removed_raw, 'n_added': n_added_raw,
                'n_paired_lines': 0, 'n_scope': 0, 'lines': [], 'templates': [],
                'reach': {k: True for k in ('mutation_d1', 'mutation_d2', 'mutation_no_posthoc', 'donor_verbatim_repo', 'donor_shape_repo', 'donor_one_sub', 'donor_two_sub', 'vocab_file', 'vocab_file_tests', 'template', 'union', 'union_two_sub')}}
    kind = classify(R, A)
    file_ids, attrs, file_lits = file_identifiers(file_src)
    scope, params = enclosing_function_scope(file_src, h['old_start'])
    if scope is None: scope, params = set(file_ids), set()
    scope = set(scope) | {n for n in file_ids if n[:1].isupper()}  # classes/constants are visible anywhere
    func_lines = None
    try:
        tree = ast.parse(file_src)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.lineno <= h['old_start'] <= (node.end_lineno or node.lineno):
                if func_lines is None or node.lineno >= func_lines[0]: func_lines = (node.lineno, node.end_lineno)
    except SyntaxError:
        pass
    pairs, unpaired_removed = pair_lines(R, A)
    lines_out = []
    for buggy, fixed in pairs:
        row = {'buggy': buggy.strip() if buggy else None, 'fixed': fixed.strip()}
        if buggy is not None:
            row['mutation'] = mutation_reach(buggy, fixed, scope, file_lits | test_lits, attrs, params, depth2=depth2)
        else:
            row['mutation'] = {'hit_depth': None, 'n_depth1': 0, 'ops': [], 'n_depth2': None}
        row['donor'] = donor_reach(fixed, idx, scope | file_ids | test_ids, file_lits | test_lits)
        row['vocab'] = vocab_reach(fixed, file_ids, file_lits, test_ids, test_lits)
        lines_out.append(row)
    templates = template_reach(R, A, file_src, func_lines, scope | file_ids, params)
    # generative check for the recognisers that need a name from scope
    if len(R) == 1 and len(A) == 1 and any(t in templates for t in ('identifier_change', 'attribute_change', 'call_target_change')):
        rt = [x[1] for x in toks(R[0])]; at = [x[1] for x in toks(A[0])]
        i = [k for k in range(len(rt)) if rt[k] != at[k]][0]
        if 'attribute_change' in templates and at[i] in attrs: templates.append('attribute_change_in_scope')
        if 'call_target_change' in templates and (at[i] in scope or at[i] in file_ids or at[i] in attrs): templates.append('call_target_change_in_scope')
        if 'identifier_change' in templates and at[i] in scope: templates.append('identifier_change_in_scope')
    n_lines = len(lines_out)
    mut_ok = n_lines > 0 and all(r['mutation']['hit_depth'] is not None for r in lines_out)
    mut1_ok = n_lines > 0 and all(r['mutation']['hit_depth'] == 1 for r in lines_out)
    donor_v = n_lines > 0 and all(r['donor']['verbatim_repo'] for r in lines_out)
    donor_1 = n_lines > 0 and all(r['donor']['one_sub_repo'] for r in lines_out)
    donor_2 = n_lines > 0 and all(r['donor']['two_sub_repo'] for r in lines_out)
    mut_nonposthoc = n_lines > 0 and all(r['mutation']['hit_depth'] is not None and not (set(r['mutation']['ops']) & POST_HOC_OPS) for r in lines_out)
    donor_shape = n_lines > 0 and all(r['donor']['shape_repo'] for r in lines_out)
    vocab_ok = n_lines > 0 and all(r['vocab']['all_in_file'] for r in lines_out)
    vocab_t_ok = n_lines > 0 and all(r['vocab']['all_in_file_plus_tests'] for r in lines_out)
    if kind == 'deletion':
        mut_ok = mut1_ok = donor_v = donor_1 = donor_2 = donor_shape = vocab_ok = vocab_t_ok = mut_nonposthoc = True
    per_line_union = [ (r['mutation']['hit_depth'] is not None) or r['donor']['one_sub_repo'] for r in lines_out]
    per_line_union2 = [ (r['mutation']['hit_depth'] is not None) or r['donor']['two_sub_repo'] for r in lines_out]
    generative_templates = [t for t in templates if t not in ('identifier_change', 'attribute_change', 'call_target_change', 'literal_change', 'operator_change', 'signature_change', 'prefix_value', 'insert_return_expr', 'add_branch_shape', 'comment_or_doc_only', 'new_function', 'delete_lines', 'wrap_try_except_new_body')]
    # a template only generates the hunk if every slot can be filled from the vocabulary (file identifiers/literals + test patch)
    if generative_templates and not vocab_t_ok:
        templates.append('template_slots_not_in_vocabulary'); generative_templates = []
    union = kind == 'deletion' or (n_lines > 0 and all(per_line_union)) or bool(generative_templates)
    union2 = kind == 'deletion' or (n_lines > 0 and all(per_line_union2)) or bool(generative_templates)
    return {'file': h['file'], 'old_start': h['old_start'], 'kind': kind, 'n_removed': len(R), 'n_added': len(A), 'n_non_code_added': n_added_raw - len(A),
            'n_paired_lines': n_lines, 'n_scope': len(scope), 'lines': lines_out, 'templates': templates,
            'reach': {'mutation_d1': mut1_ok, 'mutation_d2': mut_ok, 'mutation_no_posthoc': mut_nonposthoc, 'donor_verbatim_repo': donor_v, 'donor_shape_repo': donor_shape, 'donor_one_sub': donor_1,
                      'donor_two_sub': donor_2, 'vocab_file': vocab_ok, 'vocab_file_tests': vocab_t_ok, 'template': bool(generative_templates), 'union': union, 'union_two_sub': union2}}

# ----------------------------------------------------------------------------- datasets

def code_lines_quixbugs(path):
    s = open(path).read()
    i = s.find('\n"""')
    body = s[:i] if i > 0 else s
    return [strip_comment(l) for l in body.split('\n')]

def quixbugs():
    names = sorted(f[:-3] for f in os.listdir(f'{QB}/python_programs') if f.endswith('.py') and not f.endswith('_test.py') and f != 'node.py')
    # donor index: file = the program; package = python_programs/ (all buggy programs + node.py); repo = package + test files (never correct_*)
    pkg_srcs = {n: '\n'.join(code_lines_quixbugs(f'{QB}/python_programs/{n}.py')) for n in names}
    pkg_srcs['node'] = open(f'{QB}/python_programs/node.py').read()
    test_srcs = [open(f'{QB}/python_programs/{f}').read() for f in os.listdir(f'{QB}/python_programs') if f.endswith('_test.py')]
    results = []
    for n in names:
        b = code_lines_quixbugs(f'{QB}/python_programs/{n}.py'); f = code_lines_quixbugs(f'{QB}/correct_python_programs/{n}.py')
        bn = [l for l in b if l.strip()]; fn_ = [l for l in f if l.strip()]
        sm = difflib.SequenceMatcher(a=[norm(l) for l in bn], b=[norm(l) for l in fn_], autojunk=False)
        hunks = []
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == 'equal': continue
            # old_start: 1-based line in original buggy file
            orig_idx = [i for i, l in enumerate(b) if l.strip()]
            start = orig_idx[i1] + 1 if i1 < len(orig_idx) else len(b)
            hunks.append({'file': f'python_programs/{n}.py', 'old_start': start, 'removed': bn[i1:i2], 'added': fn_[j1:j2]})
        idx = DonorIndex()
        for m, src in pkg_srcs.items():
            idx.add(src, ['file', 'package', 'repo'] if m == n else ['package', 'repo'])
        for src in test_srcs: idx.add(src, ['repo'])
        test_ids = set(); test_lits = set()
        tp = f'{QB}/json_testcases/{n}.json'
        if os.path.exists(tp):
            tj = open(tp).read()
            for m in re.finditer(r'-?\d+(?:\.\d+)?|"[^"]*"', tj): test_lits.add(m.group())
        file_src = '\n'.join(b)
        hres = [analyse_hunk(h, file_src, idx, test_ids, test_lits) for h in hunks]
        results.append({'id': n, 'hunks': hres})
        sys.stderr.write(f'QB {n}: {len(hunks)} hunk(s) ' + ' '.join(h['kind'] + ('/' + ('d%d' % h['lines'][0]['mutation']['hit_depth'] if h['lines'] and h['lines'][0]['mutation']['hit_depth'] else '-')) for h in hres) + '\n')
    return results

def swebench(quick=False):
    gold = json.load(open(f'{ROOT}/bench/data/swebench-verified-30.gold.json'))
    inst = {x['instance_id']: x for x in json.load(open(f'{ROOT}/bench/data/swebench-verified-30.json'))}
    results = []
    for iid, patch in gold.items():
        repo = f'{REPOS}/{iid}'
        groups = parse_patch(patch)
        tp = inst[iid]['test_patch']
        test_ids, _, test_lits = file_identifiers('\n'.join(l[1:] for l in tp.split('\n') if l.startswith('+') and not l.startswith('+++')))
        # repo-wide donor index (python files only), built once per instance
        idx = DonorIndex(); files_by_dir = defaultdict(list)
        t0 = time.time()
        py_files = []
        for dp, dn, fns in os.walk(repo):
            dn[:] = [d for d in dn if d not in ('.git', 'node_modules', '__pycache__', 'build', 'dist')]
            for fn in fns:
                if fn.endswith('.py'): py_files.append(os.path.join(dp, fn))
        touched = {g['file'] for g in groups}
        touched_dirs = {os.path.dirname(f) for f in touched}
        srcs = {}
        for p in py_files:
            rel = os.path.relpath(p, repo)
            try: src = open(p, encoding='utf-8', errors='replace').read()
            except OSError: continue
            if rel in touched: srcs[rel] = src
            flags = ['repo']
            if os.path.dirname(rel) in touched_dirs: flags.append('package')
            if rel in touched: flags.append('file')
            idx.add(src, flags)
        # fixed sources: apply the gold patch in the worktree, read, restore
        fixed = {}
        pf = f'/tmp/jevonly/{iid}.gold.patch'; open(pf, 'w').write(patch)
        if os.system(f'git -C {repo} apply {pf} >/dev/null 2>&1') == 0:
            for f in touched:
                try: fixed[f] = open(os.path.join(repo, f), encoding='utf-8', errors='replace').read()
                except OSError: pass
            os.system(f'git -C {repo} checkout -q -- . >/dev/null 2>&1')
        else:
            sys.stderr.write(f'  WARN: gold patch did not apply for {iid}\n')
        hres = []
        for g in groups:
            src = srcs.get(g['file'])
            if src is None:
                try: src = open(os.path.join(repo, g['file']), encoding='utf-8', errors='replace').read()
                except OSError: src = ''
            relocate(g, src, fixed.get(g['file']))
            hres.append(analyse_hunk(g, src, idx, test_ids, test_lits, depth2=not quick, fixed_src=fixed.get(g['file'])))
        results.append({'id': iid, 'hunks': hres, 'n_py_files': len(py_files), 'index_lines': len(idx.verbatim['repo'])})
        sys.stderr.write(f'SWE {iid}: {len(groups)} hunk(s) in {time.time() - t0:.1f}s; kinds ' + ','.join(h['kind'] for h in hres) + '\n')
    return results

if __name__ == '__main__':
    quick = '--quick' in sys.argv
    out = {'quixbugs': quixbugs(), 'swebench': swebench(quick)}
    json.dump(out, sys.stdout, indent=1)
