#!/usr/bin/env python3
"""Hunk classification + vocabulary verdict for every SWE-bench Verified instance from the gold diff
alone, read from experiments/results/coverage-study.json (the earlier reach study's per-line analysis;
no Jev, no checkout needed). Prints a markdown table; the 9 oracle-valid instances are marked so the
report can join it with the live per-site study (reach-oracle-9.mts)."""
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ORACLE = {
    'sympy__sympy-15345': 'valid', 'sympy__sympy-17139': 'valid', 'sympy__sympy-19954': 'valid', 'sympy__sympy-11618': 'valid',
    'django__django-15315': 'valid', 'django__django-15128': 'valid', 'psf__requests-2931': 'valid',
    'sympy__sympy-12096': 'valid_weak', 'django__django-15563': 'valid_weak',
    'sympy__sympy-16792': 'fails_on_gold', 'sympy__sympy-20428': 'fails_on_gold', 'django__django-15375': 'fails_on_gold', 'pytest-dev__pytest-7324': 'fails_on_gold',
    'sympy__sympy-22080': 'passes_on_base', 'pylint-dev__pylint-4604': 'passes_on_base',
    'pytest-dev__pytest-10081': 'not_runnable', 'pytest-dev__pytest-7205': 'not_runnable', 'pytest-dev__pytest-10051': 'not_runnable',
    'sympy__sympy-13798': 'no_pick', 'django__django-14787': 'no_pick', 'django__django-15916': 'no_pick', 'pytest-dev__pytest-10356': 'no_pick', 'pylint-dev__pylint-6386': 'no_pick',
    'sympy__sympy-12489': 'no_blocks', 'django__django-15572': 'no_blocks', 'django__django-16100': 'no_blocks', 'django__django-14725': 'no_blocks', 'django__django-15103': 'no_blocks', 'pylint-dev__pylint-4970': 'no_blocks', 'psf__requests-1142': 'no_blocks',
}
KIND_SHORT = {'single_line_modification': '1-line', 'multi_line_modification': 'multi', 'pure_insertion': 'insert', 'deletion': 'delete', 'new_function': 'new def', 'non_code_only': 'non-code'}


def main() -> None:
    data = json.loads((ROOT / 'experiments/results/coverage-study.json').read_text())
    rows = []
    for inst in data['swebench']:
        hunks = [h for h in inst['hunks'] if h['kind'] != 'non_code_only']
        kinds = Counter(h['kind'] for h in hunks)
        kind_txt = ', '.join(f"{n}× {KIND_SHORT[k]}" for k, n in kinds.items())
        n_lines = sum(len(h['lines']) for h in hunks)
        ins = sum(1 for h in hunks for l in h['lines'] if l['buggy'] is None)
        single_ins_1 = sum(1 for h in hunks if h['kind'] == 'pure_insertion' and h['n_added'] - h.get('n_non_code_added', 0) == 1)
        vocab_file = all(h['reach']['vocab_file'] for h in hunks)
        vocab_tests = all(h['reach']['vocab_file_tests'] for h in hunks)
        union = all(h['reach']['union'] for h in hunks)
        union2 = all(h['reach']['union_two_sub'] for h in hunks)
        missing = Counter()
        for h in hunks:
            for l in h['lines']:
                for t in l['vocab']['missing_with_tests']:
                    missing[t] += 1
        miss_txt = ', '.join(f"`{t}`" for t, _ in missing.most_common(6)) + (' …' if len(missing) > 6 else '')
        rows.append({
            'id': inst['id'], 'oracle': ORACLE.get(inst['id'], '?'), 'hunks': len(hunks), 'kinds': kind_txt, 'lines': n_lines, 'inserted': ins,
            'vocab': f"{'Y' if vocab_file else 'n'}/{'Y' if vocab_tests else 'n'}", 'union': f"{'Y' if union else 'n'}/{'Y' if union2 else 'n'}", 'missing': miss_txt or '-',
        })
    order = ['valid', 'valid_weak', 'fails_on_gold', 'passes_on_base', 'not_runnable', 'no_pick', 'no_blocks']
    rows.sort(key=lambda r: (order.index(r['oracle']) if r['oracle'] in order else 99, r['id']))
    print('| instance | issue oracle | code hunks | classes | fixed code lines (inserted) | vocab file / +tests | coverage-study reach union / 2-sub | tokens outside file+tests (count of fixed lines needing them) |')
    print('| --- | --- | --- | --- | --- | --- | --- | --- |')
    for r in rows:
        print(f"| {r['id']} | {r['oracle']} | {r['hunks']} | {r['kinds']} | {r['lines']} ({r['inserted']}) | {r['vocab']} | {r['union']} | {r['missing']} |")
    non = [r for r in rows if r['oracle'] not in ('valid', 'valid_weak')]
    print(f"\n{len(non)} non-oracle instances: vocab file+tests ok on {sum(1 for r in non if r['vocab'].endswith('Y'))}; coverage-study union reach {sum(1 for r in non if r['union'].startswith('Y'))} (2-sub {sum(1 for r in non if r['union'].endswith('Y'))}); single-hunk {sum(1 for r in non if r['hunks'] == 1)}; multi-hunk {sum(1 for r in non if r['hunks'] >= 2)}", file=sys.stderr)


if __name__ == '__main__':
    main()
