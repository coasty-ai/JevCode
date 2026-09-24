"""Build experiments/probe-donor/quixbugs.json: per QuixBugs program, the code-only buggy/fixed
lines, the diff (replace or insert), in-scope identifiers, tests, and hand-labelled fix kinds.
Usage: python3 build_dataset.py  (QuixBugs at /tmp/quixbugs)
"""
import json, os, re, ast, difflib, keyword, builtins

ROOT = '/tmp/quixbugs'
OUT = os.path.join(os.path.dirname(__file__), 'quixbugs.json')

# Hand labels against the brief's catalogue. primary = strict truth; acceptable = also counted
# under the lenient reading. Derived by reading the buggy-vs-correct diff (see diff.txt).
KINDS = {
 'bitcount': ('operator_swap', []),
 'breadth_first_search': ('missing_condition_or_guard', ['control_flow_change']),
 'bucketsort': ('wrong_variable', []),
 'depth_first_search': ('none_of_these', ['missing_statement']),  # missing statement
 'detect_cycle': ('missing_condition_or_guard', []),
 'find_first_in_sorted': ('operator_swap', ['off_by_one']),
 'find_in_sorted': ('off_by_one', []),
 'flatten': ('wrong_function_call', []),
 'gcd': ('argument_order', []),
 'get_factors': ('wrong_constant', []),
 'hanoi': ('wrong_variable', []),
 'is_valid_parenthesization': ('missing_condition_or_guard', ['wrong_constant']),
 'kheapsort': ('wrong_variable', ['off_by_one']),
 'knapsack': ('operator_swap', ['off_by_one']),
 'kth': ('wrong_variable', ['none_of_these', 'off_by_one']),
 'lcs_length': ('off_by_one', ['wrong_variable']),
 'levenshtein': ('off_by_one', ['wrong_constant']),
 'lis': ('wrong_function_call', ['missing_condition_or_guard']),
 'longest_common_subsequence': ('wrong_variable', ['off_by_one']),
 'max_sublist_sum': ('wrong_function_call', ['missing_condition_or_guard']),
 'mergesort': ('operator_swap', ['off_by_one']),
 'minimum_spanning_tree': ('wrong_function_call', ['operator_swap']),
 'next_palindrome': ('off_by_one', []),
 'next_permutation': ('argument_order', ['operator_swap']),
 'pascal': ('off_by_one', []),
 'possible_change': ('missing_condition_or_guard', []),
 'powerset': ('none_of_these', ['wrong_variable']),
 'quicksort': ('operator_swap', ['off_by_one']),
 'reverse_linked_list': ('none_of_these', ['missing_statement']),
 'rpn_eval': ('argument_order', []),
 'shortest_path_length': ('wrong_variable', ['wrong_function_call']),
 'shortest_path_lengths': ('argument_order', ['wrong_variable']),
 'shortest_paths': ('wrong_variable', []),
 'shunting_yard': ('none_of_these', ['missing_statement']),
 'sieve': ('wrong_function_call', []),
 'sqrt': ('wrong_variable', ['none_of_these']),
 'subsequences': ('wrong_constant', []),
 'to_base': ('argument_order', []),
 'topological_ordering': ('wrong_variable', []),
 'wrap': ('none_of_these', ['missing_statement']),
}

def code_only(src):
    i = src.find('\n"""')
    s = src[:i] if i > 0 else src
    lines = [l.rstrip() for l in s.rstrip().split('\n')]
    # drop blank lines and pure comment lines (QuixBugs buggy/correct differ in these)
    out = []
    for l in lines:
        if l.strip() == '' or l.strip().startswith('#'):
            continue
        out.append(re.sub(r'\s+#.*$', '', l) if '#' in l and not re.search(r'["\'].*#.*["\']', l) else l)
    return out

def identifiers(lines, name):
    src = '\n'.join(lines)
    try:
        tree = ast.parse(src)
    except SyntaxError:
        tree = None
    ids, attrs = set(), set()
    if tree is not None:
        for node in ast.walk(tree):
            if isinstance(node, ast.Name): ids.add(node.id)
            elif isinstance(node, ast.arg): ids.add(node.arg)
            elif isinstance(node, ast.FunctionDef): ids.add(node.name)
            elif isinstance(node, ast.Attribute): attrs.add(node.attr)
            elif isinstance(node, ast.alias): ids.add((node.asname or node.name).split('.')[0])
    return sorted(ids), sorted(attrs)

def load_tests(name):
    p = os.path.join(ROOT, 'json_testcases', name + '.json')
    if os.path.exists(p):
        rows = [json.loads(l) for l in open(p) if l.strip()]
        return {'kind': 'json', 'cases': [{'input': r[0], 'expected': r[1]} for r in rows[:4]]}
    t = open(os.path.join(ROOT, 'python_testcases', f'test_{name}.py')).read()
    # keep only the test functions (drop import preamble)
    i = t.find('def test')
    return {'kind': 'pytest_source', 'source': t[i:].strip()[:2500]}

data = []
for f in sorted(os.listdir(os.path.join(ROOT, 'python_programs'))):
    if not f.endswith('.py') or f.endswith('_test.py') or f == 'node.py':
        continue
    name = f[:-3]
    buggy = code_only(open(os.path.join(ROOT, 'python_programs', f)).read())
    fixed = code_only(open(os.path.join(ROOT, 'correct_python_programs', f)).read())
    sm = difflib.SequenceMatcher(a=buggy, b=fixed, autojunk=False)
    ops = [o for o in sm.get_opcodes() if o[0] != 'equal']
    assert len(ops) == 1, (name, ops)
    tag, i1, i2, j1, j2 = ops[0]
    if tag == 'replace':
        assert i2 - i1 == 1 and j2 - j1 == 1, (name, ops)
        diff = {'kind': 'replace', 'line_index': i1, 'buggy_line': buggy[i1], 'fix_line': fixed[j1]}
    elif tag == 'insert':
        assert j2 - j1 == 1, (name, ops)
        # inserted after buggy[i1-1] (0-based), i.e. becomes line i1 in the fixed program
        diff = {'kind': 'insert', 'insert_after_index': i1 - 1, 'fix_line': fixed[j1]}
    else:
        raise SystemExit((name, ops))
    ids, attrs = identifiers(buggy, name)
    primary, acceptable = KINDS[name]
    data.append({'name': name, 'buggy': buggy, 'fixed': fixed, 'diff': diff,
                 'identifiers': ids, 'attributes': attrs, 'tests': load_tests(name),
                 'kind_primary': primary, 'kind_acceptable': [primary] + acceptable})
json.dump(data, open(OUT, 'w'), indent=1)
print(len(data), 'programs;', sum(d['diff']['kind'] == 'insert' for d in data), 'inserts')
for d in data:
    print(f"{d['name']:28s} {d['diff']['kind']:8s} {d['kind_primary']:28s} lines={len(d['buggy'])} ids={len(d['identifiers'])}")
