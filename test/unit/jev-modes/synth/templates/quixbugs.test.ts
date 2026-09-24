/**
 * QuixBugs coverage of the template source: the four insertion bugs and the five
 * missing-condition bugs (experiments/results/lit-search-based-repair.md §7 rows) must have the
 * developer fix among the candidates that survive a Choice-sized cap. Sites are the ones the
 * localiser would hand over (probe-donor-and-templates item 4: the insertion point is found
 * 4/4 once the statement is known), so this measures the catalogue, not localisation.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTemplateSource } from '../../../../../src/jev-modes/synth/templates/index.js';
import type { Candidate } from '../../../../../src/jev-modes/synth/types.js';
import { QUIXBUGS, applyCandidate, compileFailures, insertSite, norm, options, replaceSite, sourceFile } from './helpers.js';

interface Case {
  name: string;
  kind: 'insert' | 'replace';
  line: number;
  indent?: number;
  fix: string;
}

const INSERTIONS: Case[] = [
  { name: 'depth_first_search', kind: 'insert', line: 10, indent: 12, fix: 'nodesvisited.add(node)' },
  { name: 'reverse_linked_list', kind: 'insert', line: 6, indent: 8, fix: 'prevnode = node' },
  { name: 'shunting_yard', kind: 'insert', line: 18, indent: 12, fix: 'opstack.append(token)' },
  { name: 'wrap', kind: 'insert', line: 10, indent: 4, fix: 'lines.append(text)' },
];

const CONDITIONS: Case[] = [
  { name: 'detect_cycle', kind: 'replace', line: 5, fix: 'if hare is None or hare.successor is None:' },
  { name: 'is_valid_parenthesization', kind: 'replace', line: 12, fix: 'return depth == 0' },
  { name: 'lis', kind: 'replace', line: 14, fix: 'longest = max(longest, length + 1)' },
  { name: 'max_sublist_sum', kind: 'replace', line: 7, fix: 'max_ending_here = max(0, max_ending_here + x)' },
  { name: 'possible_change', kind: 'replace', line: 5, fix: 'if total < 0 or not coins:' },
];

const source = createTemplateSource();

function enumerateCase(c: Case): Candidate[] {
  const file = sourceFile(`${c.name}.py`, join(QUIXBUGS, `${c.name}.py`));
  const site = c.kind === 'insert' ? insertSite(file, c.line, c.indent ?? 0) : replaceSite(file, c.line);
  return source.enumerate(site, options());
}

function rankOf(cands: Candidate[], fix: string): number {
  const k = cands.findIndex((c) => norm(c.text) === norm(fix));
  return k < 0 ? -1 : k + 1;
}

describe('template source on QuixBugs', () => {
  it('has the developer fix among the candidates for at least 7 of the 9 insertion and missing-condition bugs', () => {
    const misses: string[] = [];
    const ranks: string[] = [];
    for (const c of [...INSERTIONS, ...CONDITIONS]) {
      const rank = rankOf(enumerateCase(c), c.fix);
      if (rank < 0) misses.push(c.name);
      else ranks.push(`${c.name}=${rank}`);
    }
    // the misses are part of the assertion message so a regression names the program
    expect(misses, `misses: ${misses.join(', ') || 'none'}; ranks: ${ranks.join(' ')}`).toHaveLength(0);
    expect(9 - misses.length).toBeGreaterThanOrEqual(7);
  });

  it.each(INSERTIONS)('$name: the missing statement is enumerated at the insertion point with the site indent', (c) => {
    const cands = enumerateCase(c);
    const hit = cands.find((x) => norm(x.text) === c.fix);
    expect(hit).toBeDefined();
    expect(hit!.text).toBe(' '.repeat(c.indent ?? 0) + c.fix);
    expect(hit!.source).toBe('template');
    expect(hit!.op.startsWith('insert_')).toBe(true);
    expect(hit!.extraEdits).toBeUndefined();
  });

  it.each(CONDITIONS)('$name: the fixed line replaces the buggy line keeping its indentation', (c) => {
    const cands = enumerateCase(c);
    const hit = cands.find((x) => norm(x.text) === c.fix);
    expect(hit).toBeDefined();
    const indent = /^\s*/.exec(hit!.site.currentLine)![0];
    expect(hit!.text).toBe(indent + c.fix);
  });

  it('covers insertion bugs from a replace site too: after a `:` header and at the dedent level a block ends at', () => {
    const dfs = sourceFile('depth_first_search.py', join(QUIXBUGS, 'depth_first_search.py'));
    const afterElse = source.enumerate(replaceSite(dfs, 9), options());
    expect(afterElse.some((c) => c.text === '        else:\n            nodesvisited.add(node)')).toBe(true);
    const sy = sourceFile('shunting_yard.py', join(QUIXBUGS, 'shunting_yard.py'));
    const dedent = source.enumerate(replaceSite(sy, 17), options({ cap: 400 }));
    expect(dedent.some((c) => c.text === '                rpntokens.append(opstack.pop())\n            opstack.append(token)')).toBe(true);
    const rll = sourceFile('reverse_linked_list.py', join(QUIXBUGS, 'reverse_linked_list.py'));
    const before = source.enumerate(replaceSite(rll, 6), options());
    expect(before.some((c) => c.text === '        prevnode = node\n        node = nextnode')).toBe(true);
  });

  it('every candidate at the nine sites applies to a program that still compiles', () => {
    const items: { id: string; src: string }[] = [];
    for (const c of [...INSERTIONS, ...CONDITIONS]) {
      for (const cand of enumerateCase(c)) items.push({ id: `${c.name}:${cand.op}:${cand.id}`, src: applyCandidate(cand) });
    }
    expect(items.length).toBeGreaterThan(300);
    const failures = compileFailures(items);
    expect(failures, failures.map((f) => `${f.id}: ${f.error}`).join('\n')).toHaveLength(0);
  });

  it('is deterministic and ordered by prior with unique ids', () => {
    for (const c of [...INSERTIONS, ...CONDITIONS]) {
      const a = enumerateCase(c);
      const b = enumerateCase(c);
      expect(a.map((x) => [x.id, x.text, x.prior])).toEqual(b.map((x) => [x.id, x.text, x.prior]));
      expect(new Set(a.map((x) => x.id)).size).toBe(a.length);
      expect(a.length).toBeLessThanOrEqual(254);
      for (let k = 1; k < a.length; k++) expect(a[k - 1]!.prior ?? 0).toBeGreaterThanOrEqual(a[k]!.prior ?? 0);
      for (const x of a) {
        expect(x.prior).toBeGreaterThan(0);
        expect(x.prior).toBeLessThanOrEqual(1);
        expect(x.id.startsWith('tpl_')).toBe(true);
      }
    }
  });
});
