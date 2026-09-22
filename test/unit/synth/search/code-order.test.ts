/**
 * OOS iteration 4, item A — the replace-site order when there is no Jev ranking to cut with,
 * and the WIDENED gate that follows from it.
 *
 * The recorded failure. `--jev off` `kth`, run `20260922-155658-35hfmbqm`: nine sites, every one
 * an insert gap, `plausible 0` on every step, `replan_stop` at 11 — no SBFL anywhere in the run
 * (`grep -ic sbfl transcript.log` → 0). Iteration 3 fixed the localiser half (L12 is now a
 * replace site of `loc.sites`, `jev-off-fallback.test.ts`), and `buildGoalSites` threw it away
 * again: with no coverage every `ScoredReplace.sbflRank` is `+Infinity`, so the tail comparator
 * `a.sbflRank - b.sbflRank` is `Infinity - Infinity` = NaN, V8 reads NaN as "equal", the sort is
 * stable, and the six `REPLACE_SITES_MAX` keeps are the first six lines of the file. `kth`'s
 * gold is `return kth(above, k)` on L12 — the tenth code line of its only function counting the
 * `def` — so it is not one of them (review finding 12; the iteration-3 entry in docs/LLM-JEV.md
 * hands this to iteration 4 by name).
 *
 * Labels used below:
 *   - *failing-first by mechanism* — fails on `5ac0042` src with every symbol it names present,
 *     for the reason the fix names;
 *   - *regression pin* — passes on `5ac0042` and must keep passing;
 *   - *fixture property* — asserts what `bench/data` contains, not what the code does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { jevOffAnswer } from '../../../../src/jev/off.js';
import { createLocalizer } from '../../../../src/synth/localize/index.js';
import {
  GOLD_KIND_BASE_RATE,
  GOLD_STATEMENT_KIND_PRIOR,
  REPLACE_SITES_MAX,
  buildGoalSites,
  failingCallNames,
  failureVocabulary,
  orderByCodeEvidence,
  siteKey,
  statementKindPrior,
  vocabularyOverlap,
} from '../../../../src/synth/search/sites.js';
import { widenedReachable } from '../../../../src/synth/search/subgoal.js';
import type { GoalSiteContext, SbflEvidence } from '../../../../src/synth/search/sites.js';
import type { Answer } from '../../../../src/core/types.js';
import type { LocalizeResult, Site } from '../../../../src/synth/types.js';
import type { Goal } from '../../../../src/synth/search/types.js';
import type { RankedLine } from '../../../../src/synth/sbfl/types.js';
import { REPO_ROOT, goal, scriptedAsk, sf, siteAt, signal } from './sites-composite.helpers.js';

const QUIXBUGS = join(REPO_ROOT, 'bench/data/quixbugs');
const read = (p: string): string => readFileSync(p, 'utf8');

/** The decider `JEVCODE_JEV=off` installs, verbatim: every Choice on its escape, every Noul inert. */
function jevOffAsk(): ReturnType<typeof scriptedAsk> {
  return scriptedAsk((call) => {
    const out: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(call.questions)) out[id] = jevOffAnswer(q);
    return out;
  });
}

const lines = (sites: readonly { line: number }[]): number[] => sites.map((s) => s.line);

// ---------------------------------------------------------------------------------------
// The recorded `kth` run, end to end through the real localiser and `buildGoalSites`
// ---------------------------------------------------------------------------------------

/** Verbatim from `bench/data/quixbugs/programs/kth.py`; the gold replaces L12. */
const KTH_SRC = read(join(QUIXBUGS, 'programs/kth.py'));
/** Verbatim from the recorded run's `run.json`. */
const KTH_TASK = 'The function `kth` in `kth.py` has a bug that makes some tests in tests/ fail. Fix it without changing the tests.';
const KTH_FAILURE = { testId: 'tests/test_kth.py::test_kth', call: 'kth([1, 2, 3, 4, 5, 6, 7], 4)', expected: '5', actual: 'IndexError: list index out of range' };

describe('`kth` under --jev off: the gold line is among the six the first code-order pass reaches', () => {
  async function kthSites(sbfl?: SbflEvidence): Promise<{ replace: Site[]; localized: LocalizeResult }> {
    const file = sf('kth.py', KTH_SRC);
    const files = new Map([[file.path, file]]);
    const localized = await createLocalizer().localize({ ask: jevOffAsk().ask, task: KTH_TASK, files, failures: [KTH_FAILURE], signal: signal(), budget: { maxRequests: 20 } });
    const ctx: GoalSiteContext = { ask: jevOffAsk().ask, task: KTH_TASK, signal: signal(), files };
    const g = await buildGoalSites(ctx, goal({ id: 'g1', tests: [KTH_FAILURE.testId], failures: [KTH_FAILURE], suspectedFiles: ['kth.py'], planItem: 'fix kth' }), localized, sbfl);
    return { replace: g.replace, localized };
  }

  /** *failing-first by mechanism*: on 5ac0042 this is `[2, 3, 4, 6, 7, 9]` — file order, no L12. */
  it('the six replace sites hold L12, and every one of them came from the code order (no Jev probability anywhere)', async () => {
    const { replace, localized } = await kthSites();
    expect(localized.sites.every((s) => s.evidence.jevProbability === undefined)).toBe(true);
    expect(replace).toHaveLength(REPLACE_SITES_MAX);
    expect(lines(replace)).toContain(12);
    // the measured order: the two lines that name `kth` (the task's own backticked identifier)
    // lead, then the remaining `return`, then the `if`, then the assignments in line order
    expect(lines(replace)).toEqual([10, 12, 14, 9, 2, 3]);
    expect(replace.find((s) => s.line === 12)!.currentLine.trim()).toBe('return kth(above, k)');
  });

  /**
   * *regression pin*: coverage still decides where it exists. A spectrum row keeps its rank and
   * sorts ahead of every code-ordered site, exactly as on 5ac0042 — the code order only ever
   * sees the sites the spectrum said nothing about.
   */
  it('an SBFL ranking still leads, and the code order takes only the tail', async () => {
    const ranked: RankedLine[] = [[7, 1], [6, 0.9]].map(([line, score], i) => ({ rank: i + 1, file: 'kth.py', line: line!, ef: 1, ep: 0, score: score!, scores: { ochiai: score!, tarantula: score!, dstar: score! } }));
    const { replace } = await kthSites({ ranked });
    expect(lines(replace).slice(0, 2)).toEqual([7, 6]);
    expect(lines(replace)).toContain(12);
  });
});

// ---------------------------------------------------------------------------------------
// The pieces of the order, each on its own
// ---------------------------------------------------------------------------------------

describe('the code order is built from evidence already in reach', () => {
  const file = sf('kth.py', KTH_SRC);
  const files = new Map([[file.path, file]]);

  /** *failing-first by mechanism* (the symbol is new; the assertion is about the measured table). */
  it('the statement-kind prior is the measured one and ranks `return` over `assign` over `else`', () => {
    expect(statementKindPrior(file, 12)).toBe(GOLD_STATEMENT_KIND_PRIOR['return']);
    expect(statementKindPrior(file, 2)).toBe(GOLD_STATEMENT_KIND_PRIOR['assign']);
    expect(statementKindPrior(file, 9)).toBe(GOLD_STATEMENT_KIND_PRIOR['if']);
    expect(statementKindPrior(file, 11)).toBe(GOLD_STATEMENT_KIND_PRIOR['elif']);
    expect(statementKindPrior(file, 13)).toBe(GOLD_STATEMENT_KIND_PRIOR['else']);
    expect(GOLD_STATEMENT_KIND_PRIOR['return']!).toBeGreaterThan(GOLD_STATEMENT_KIND_PRIOR['assign']!);
    expect(GOLD_STATEMENT_KIND_PRIOR['assign']!).toBeGreaterThan(GOLD_STATEMENT_KIND_PRIOR['elif']!);
    expect(GOLD_STATEMENT_KIND_PRIOR['elif']!).toBeGreaterThan(GOLD_STATEMENT_KIND_PRIOR['else']!);
    // a kind the corpus never showed lands on the base rate, i.e. no opinion
    expect(GOLD_STATEMENT_KIND_PRIOR['with']).toBeUndefined();
    expect(statementKindPrior(sf('w.py', 'def f(p):\n    with open(p) as h:\n        pass\n'), 2)).toBe(1);
  });

  it('the failure vocabulary is the task identifiers, the test literals and the failure texts, without keywords or builtins', () => {
    const v = failureVocabulary(KTH_TASK, [KTH_FAILURE]);
    expect(v.has('kth')).toBe(true);
    expect(v.has('4')).toBe(true);
    // builtins and keywords are dropped: `IndexError`, `list` and `range` are all three in
    // `PY_BUILTINS`, they are on half the lines of any program and they localise nothing
    expect(v.has('IndexError')).toBe(false);
    expect(v.has('list')).toBe(false);
    expect(v.has('range')).toBe(false);
    expect(v.has('not')).toBe(false);
    expect(vocabularyOverlap(siteAt(file, 12), v)).toBe(1);
    expect(vocabularyOverlap(siteAt(file, 14), v)).toBe(0);
  });

  it('the failing call names its own function; a bare pytest node id names none', () => {
    expect([...failingCallNames([KTH_FAILURE])]).toEqual(['kth']);
    expect([...failingCallNames([{ testId: 't', call: 'tests/test_x.py::test_y', expected: '1', actual: '2' }])]).toEqual([]);
  });

  /**
   * *failing-first by mechanism*: the round-robin. Two functions, six sites each; on 5ac0042
   * the NaN comparator left file order, so the first function took all six.
   */
  it('round-robin across functions: one function cannot take all six', () => {
    const two = sf(
      'two.py',
      ['def alpha(xs):', '    a = 1', '    b = 2', '    c = 3', '    return a + b + c', '', 'def beta(ys):', '    d = 4', '    e = 5', '    f = 6', '    return d + e + f', ''].join('\n'),
    );
    const sites = [2, 3, 4, 5, 8, 9, 10, 11].map((l) => siteAt(two, l));
    const ordered = orderByCodeEvidence(sites, { task: 'Fix it.', failures: [{ testId: 't', call: 'alpha([1])', expected: '6', actual: '5' }], files: new Map([[two.path, two]]) });
    // `alpha` is the failing call's function, so its group leads the rotation; the vocabulary is
    // {alpha, 1, 6, 5}, so `a = 1` leads alpha and `e = 5` leads beta. Alternating from there,
    // `beta` has three of the first six instead of none.
    expect(lines(ordered)).toEqual([2, 9, 5, 10, 3, 11, 4, 8]);
    const firstSix = ordered.slice(0, REPLACE_SITES_MAX);
    expect(firstSix.filter((s) => s.block?.name === 'beta')).toHaveLength(3);
    expect(firstSix.filter((s) => s.block?.name === 'alpha')).toHaveLength(3);
  });

  it('is total and stable: the same input gives the same order, and every site comes back exactly once', () => {
    const sites = [2, 3, 4, 6, 7, 9, 10, 11, 12, 13, 14].map((l) => siteAt(file, l));
    const once = orderByCodeEvidence(sites, { task: KTH_TASK, failures: [KTH_FAILURE], files });
    const twice = orderByCodeEvidence([...sites].reverse(), { task: KTH_TASK, failures: [KTH_FAILURE], files });
    expect(lines(once)).toEqual(lines(twice));
    expect(new Set(lines(once)).size).toBe(sites.length);
    expect(lines(once)).toEqual([10, 12, 14, 9, 2, 3, 4, 6, 7, 11, 13]);
  });

  it('the base rate is what an unknown kind scores, so the prior never invents an opinion', () => {
    expect(GOLD_KIND_BASE_RATE).toBeCloseTo(0.0742, 4);
    expect(Object.values(GOLD_STATEMENT_KIND_PRIOR).every((p) => p > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// WIDENED after a code-ordered six
// ---------------------------------------------------------------------------------------

describe('the phase ladder reaches WIDENED once a code-ordered six is spent', () => {
  const file = sf('kth.py', KTH_SRC);
  const replaceSites = [10, 12, 14, 9, 2, 3].map((l) => siteAt(file, l));
  const gaps = [5, 8].map((l) => siteAt(file, l, 'insert'));
  const SEEDS = ['mutation', 'template', 'donor'] as const;

  function exhaust(sites: readonly Site[]): Goal['exhausted'] {
    const m: Goal['exhausted'] = new Map();
    for (const s of sites) m.set(siteKey(s), new Set(SEEDS));
    return m;
  }

  /** *failing-first by mechanism*: on 5ac0042 `sites.every(seedsExhaustedAt)` is false here, so WIDENED never runs. */
  it('every REPLACE site spent is enough when NOTHING in the list carries a Jev probability', () => {
    const all = [...replaceSites, ...gaps];
    const g = goal({ exhausted: exhaust(replaceSites) });
    expect(all.every((s) => g.exhausted.get(siteKey(s)) !== undefined)).toBe(false);
    expect(widenedReachable(g, all)).toBe(true);
  });

  it('with a Jev probability anywhere the measured gate stands: every site, gaps included', () => {
    const ranked: Site[] = replaceSites.map((s, i) => (i === 0 ? { ...s, evidence: { ...s.evidence, jevProbability: 0.8 } } : s));
    const all = [...ranked, ...gaps];
    expect(widenedReachable(goal({ exhausted: exhaust(ranked) }), all)).toBe(false);
    expect(widenedReachable(goal({ exhausted: exhaust(all) }), all)).toBe(true);
  });

  it('an unspent replace site still holds WIDENED back, and an empty list never reaches it', () => {
    const all = [...replaceSites, ...gaps];
    expect(widenedReachable(goal({ exhausted: exhaust(replaceSites.slice(1)) }), all)).toBe(false);
    expect(widenedReachable(goal(), [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// The prior is re-derived from bench/data, so the table cannot drift away from the corpus
// ---------------------------------------------------------------------------------------

describe('the statement-kind prior re-derived from the 198 gold patches', () => {
  /** *fixture property*: what `bench/data` contains, re-measured, not what the ranking does with it. */
  it('matches `GOLD_STATEMENT_KIND_PRIOR` to two decimals, for every kind in the table', async () => {
    const { analyse, statementAt } = await import('../../../../src/synth/py/index.js');
    const { allGoldPatches, dedent, removedLines } = await import('./gold-corpus.helpers.js');
    const gold = new Map<string, number>();
    const bg = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string): void => {
      m.set(k, (m.get(k) ?? 0) + 1);
    };
    for (const p of allGoldPatches()) {
      const before = dedent(p.before);
      let mod;
      try {
        mod = analyse(before);
      } catch {
        continue;
      }
      const isSite = (l: number): boolean => {
        const t = (mod!.lines[l - 1] ?? '').trim();
        return t !== '' && !t.startsWith('#') && !mod!.blocks.some((b) => l >= b.startLine && l <= b.headerEndLine);
      };
      const kindAt = (l: number): string => {
        const st = statementAt(mod!, l);
        return st === undefined ? 'other' : st.startLine === l ? st.kind : 'continuation';
      };
      for (const l of removedLines(before.split('\n'), dedent(p.after).split('\n'))) if (isSite(l)) bump(gold, kindAt(l));
      for (let l = 1; l <= mod.lines.length; l++) if (isSite(l)) bump(bg, kindAt(l));
    }
    const totalGold = [...gold.values()].reduce((a, b) => a + b, 0);
    const totalBg = [...bg.values()].reduce((a, b) => a + b, 0);
    const r0 = totalGold / totalBg;
    expect(r0).toBeCloseTo(GOLD_KIND_BASE_RATE, 4);
    const derived: Record<string, number> = {};
    for (const k of new Set([...gold.keys(), ...bg.keys()])) {
      derived[k] = Number(((((gold.get(k) ?? 0) + 1) / ((bg.get(k) ?? 0) + 1 / r0)) / r0).toFixed(2));
    }
    expect(derived).toEqual({ ...GOLD_STATEMENT_KIND_PRIOR });
  });
});
