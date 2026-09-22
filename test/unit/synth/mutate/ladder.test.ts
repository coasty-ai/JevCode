import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMutationSource, lineInfo, lineToks, looksSyntactic, tokenKey } from '../../../../src/synth/mutate/index.js';
import { QUIXBUGS, options, siteFor } from './helpers.js';

/**
 * Rung 2 of the ladder (bench/data/ladder): hand-made multi-hunk tasks. This suite derives the
 * single-line replace hunks by aligning src/ with gold/ line by line (tasks whose gold adds lines
 * are skipped: those hunks belong to the template and donor sources) and asks whether the mutation
 * source reaches each gold line. Reviewer measurement 2026-09-20: 13/17 hunks (the implementer's
 * table reached 6/17 before the review fixes). Misses, all outside what one-line mutation can
 * express: events `event.end_at` -> `ends_at` inside an f-string (one STRING token), table
 * `def pad(...)` gaining a parameter and its body using the new name, textstats
 * `sorted(..., reverse=True)` (a new keyword argument). The floor is set below the measurement so
 * operator tuning cannot regress it.
 */
const LADDER = join(QUIXBUGS, '../ladder/tasks');
const key = (line: string): string => tokenKey(lineToks(line));

interface Hunk {
  task: string;
  file: string;
  line: number;
  buggy: string;
  gold: string;
  src: string;
}

function singleLineHunks(): Hunk[] {
  const out: Hunk[] = [];
  // the short tier is the original twelve tasks these counts were measured on (the long tier, tasks
  // 13–20, and the long-2 tier, tasks 21–26, measure the horizon and coupled reach and are exercised
  // by test/unit/bench/ladder-long.test.ts)
  const index = JSON.parse(readFileSync(join(LADDER, '..', 'index.json'), 'utf8')) as { name: string; tier?: string }[];
  const shortTier = new Set(index.filter((t) => (t.tier ?? 'short') === 'short').map((t) => t.name));
  for (const task of readdirSync(LADDER).sort().filter((t) => shortTier.has(t))) {
    const goldDir = join(LADDER, task, 'gold');
    for (const file of readdirSync(goldDir).sort()) {
      const src = readFileSync(join(LADDER, task, 'src', file), 'utf8');
      const buggy = src.split('\n');
      const gold = readFileSync(join(goldDir, file), 'utf8').split('\n');
      if (buggy.length !== gold.length) continue;
      buggy.forEach((b, k) => {
        const g = gold[k]!;
        if (b !== g) out.push({ task, file, line: k + 1, buggy: b, gold: g, src });
      });
    }
  }
  return out;
}

describe('createMutationSource on the ladder single-line hunks (bench/data/ladder)', () => {
  const source = createMutationSource();
  const hunks = singleLineHunks();
  const results = hunks.map((h) => {
    const site = siteFor(h.src, h.line, 'replace', undefined, `${h.task}/${h.file}`);
    const cands = source.enumerate(site, options());
    const target = key(h.gold);
    return { h, site, cands, hit: cands.find((c) => key(c.text) === target) };
  });

  it('finds 17 single-line replace hunks across the tasks', () => {
    expect(hunks.length).toBe(17);
  });

  it('reaches the gold line for at least 12/17 hunks', () => {
    const hits = results.filter((x) => x.hit !== undefined);
    const misses = results.filter((x) => x.hit === undefined).map((x) => `${x.h.task}/${x.h.file}:${x.h.line}`);
    expect(misses).toEqual(['events/events.py:38', 'table/fmt.py:6', 'table/fmt.py:10', 'textstats/textstats.py:27']);
    expect(hits.length).toBeGreaterThanOrEqual(12);
  });

  it('covers the ladder bug kinds the operators are meant for', () => {
    const opFor = (suffix: string): string | undefined => results.find((x) => `${x.h.task}/${x.h.file}:${x.h.line}`.endsWith(suffix))?.hit?.op;
    expect(opFor('account/account.py:44')).toBe('argument_arity'); // enumerate(self.history) -> enumerate(self.history, 1)
    expect(opFor('account/account.py:53')).toBe('attribute_substitution'); // dst.withdraw -> dst.deposit
    expect(opFor('calendar_utils/calendar_utils.py:42')).toBe('argument_arity'); // split("-", 1) -> split("-")
    expect(opFor('grades/grades.py:28')).toBe('call_substitution'); // len(weights) -> sum(weights)
    expect(opFor('inventory/inventory.py:59')).toBe('off_by_one_atom'); // number * size -> (number - 1) * size
    expect(opFor('shipping/shipping.py:9')).toBe('constant_substitution'); // 500.0 -> 50.0
    expect(opFor('table/table.py:43')).toBe('argument_arity'); // pad(cell, width) -> pad(cell, width, fill)
  });

  it('keeps pools under 400, unique and shape-compatible, and leaves def signatures intact', () => {
    let defLines = 0;
    for (const { site, cands } of results) {
      expect(cands.length).toBeLessThan(400);
      expect(new Set(cands.map((c) => key(c.text))).size).toBe(cands.length);
      const base = lineToks(site.currentLine);
      const info = lineInfo(base);
      for (const c of cands) expect(looksSyntactic(lineToks(c.text), base)).toBe(true);
      if (info.head !== 'def') continue;
      defLines++;
      // on a `def` header the name, every parameter and every annotation survive verbatim: only defaults are values
      const protectedNames = [...info.protectedIdx].map((k) => base[k]!.text);
      for (const c of cands) {
        const names = new Set(lineToks(c.text).filter((t) => t.type === 'NAME').map((t) => t.text));
        for (const n of protectedNames) expect(names.has(n)).toBe(true);
      }
    }
    expect(defLines).toBeGreaterThan(0);
  });
});
