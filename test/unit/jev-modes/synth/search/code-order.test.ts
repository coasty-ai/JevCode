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

import { jevOffAnswer } from '../../../../../src/jev/off.js';
import { createLocalizer } from '../../../../../src/jev-modes/synth/localize/index.js';
import {
  GOLD_KIND_BASE_RATE,
  GOLD_STATEMENT_KIND_PRIOR,
  REPLACE_SITES_MAX,
  buildGoalSites,
  failingCallNames,
  failureVocabulary,
  isContinuationLine,
  jevRankedSites,
  orderByCodeEvidence,
  siteKey,
  statementKindPrior,
  vocabularyOverlap,
} from '../../../../../src/jev-modes/synth/search/sites.js';
import { widenedReachable } from '../../../../../src/jev-modes/synth/search/subgoal.js';
import type { GoalSiteContext, SbflEvidence } from '../../../../../src/jev-modes/synth/search/sites.js';
import type { Answer } from '../../../../../src/core/types.js';
import type { LocalizeResult, Site } from '../../../../../src/jev-modes/synth/types.js';
import type { Goal } from '../../../../../src/jev-modes/synth/search/types.js';
import type { RankedLine } from '../../../../../src/jev-modes/synth/sbfl/types.js';
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
    expect(lines(replace)).toEqual([10, 12, 14, 2, 3, 4]);
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
  it('the statement-kind prior is the measured one and ranks `return` over `assign` over `elif` over `else`', () => {
    expect(statementKindPrior(file, 12)).toBe(GOLD_STATEMENT_KIND_PRIOR['return']);
    expect(statementKindPrior(file, 2)).toBe(GOLD_STATEMENT_KIND_PRIOR['assign']);
    expect(statementKindPrior(file, 9)).toBe(GOLD_STATEMENT_KIND_PRIOR['if']);
    expect(statementKindPrior(file, 11)).toBe(GOLD_STATEMENT_KIND_PRIOR['elif']);
    expect(statementKindPrior(file, 13)).toBe(GOLD_STATEMENT_KIND_PRIOR['else']);
    expect(GOLD_STATEMENT_KIND_PRIOR['return']!).toBeGreaterThan(GOLD_STATEMENT_KIND_PRIOR['assign']!);
    expect(GOLD_STATEMENT_KIND_PRIOR['assign']!).toBeGreaterThan(GOLD_STATEMENT_KIND_PRIOR['if']!);
    expect(GOLD_STATEMENT_KIND_PRIOR['if']!).toBeGreaterThan(GOLD_STATEMENT_KIND_PRIOR['elif']!);
    expect(GOLD_STATEMENT_KIND_PRIOR['elif']!).toBeGreaterThan(GOLD_STATEMENT_KIND_PRIOR['else']!);
    // a kind the corpus never showed lands on the base rate, i.e. no opinion
    expect(GOLD_STATEMENT_KIND_PRIOR['with']).toBeUndefined();
    expect(statementKindPrior(sf('w.py', 'def f(p):\n    with open(p) as h:\n        pass\n'), 2)).toBe(1);
    // review defect 6: `continuation` is gone from the table — a rewritten multi-line statement
    // is counted ONCE, at its first line, so the kind no longer exists as a measurement
    expect(GOLD_STATEMENT_KIND_PRIOR['continuation']).toBeUndefined();
  });

  /**
   * *failing-first by mechanism* (review defect 6). At b3c28a0 `continuation` scored 1.71, above
   * `return` 1.68, so this returned `3,4,2` — it offered `* rate`, one physical line of a
   * multi-line statement, as a replace site ahead of the `return (` that owns it. Replacing one
   * line of a multi-line statement with a generated line is a syntax error in almost every case,
   * and the statement-span site at the first line is what covers the statement.
   */
  it('a continuation physical line is ranked LAST, never ahead of the statement that owns it', () => {
    const multi = sf('t.py', ['def total(rows, rate):', '    return (', '        sum(r.amount for r in rows)', '        * rate', '    )', ''].join('\n'));
    const sites = [2, 3, 4].map((l) => siteAt(multi, l));
    const ordered = orderByCodeEvidence(sites, { task: 'Fix total.', failures: [{ testId: 't', call: 'total(rows, 2)', expected: '6', actual: '3' }], files: new Map([[multi.path, multi]]) });
    expect(ordered[0]!.line).toBe(2);
    expect(lines(ordered)).toEqual([2, 3, 4]);
    expect(isContinuationLine(multi, 3)).toBe(true);
    expect(isContinuationLine(multi, 2)).toBe(false);
  });

  /**
   * *failing-first by mechanism* (review defect 11). The identifier loop over the failure text
   * had no cap while `testLiterals` is capped at 40 and `taskIdentifiers` at 60; one ordinary
   * five-frame traceback yielded 55 entries, most of them path components and frame furniture.
   */
  it('the failure vocabulary is bounded and drops traceback frame furniture', () => {
    const frames = Array.from({ length: 8 }, (_, i) => `  File "/home/user/project/src/pkg/util${i}.py", line ${i + 3}, in helper_${i}\n    value = helper_${i}(arg_${i})`).join('\n');
    const actual = `Traceback (most recent call last):\n${frames}\nValueError: boom`;
    const v = failureVocabulary('Fix it.', [{ testId: 't', call: 'run()', expected: '1', actual }]);
    expect(v.size).toBeLessThanOrEqual(60 + 40);
    for (const noise of ['Traceback', 'most', 'recent', 'last', 'File', 'line', 'home', 'user', 'project']) expect(v.has(noise)).toBe(false);
    // and a bounded, ordinary failure keeps the identifiers that matter
    const small = failureVocabulary(KTH_TASK, [KTH_FAILURE]);
    expect(small.has('kth')).toBe(true);
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
    expect(lines(once)).toEqual([10, 12, 14, 2, 3, 4, 6, 7, 9, 11, 13]);
  });

  it('the base rate is what an unknown kind scores, so the prior never invents an opinion', () => {
    expect(GOLD_KIND_BASE_RATE).toBeCloseTo(0.0835, 4);
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

describe('the statement-kind prior re-derived from every gold patch in bench/data', () => {
  /**
   * *fixture property*, re-measured from the corpus rather than pinned against it.
   *
   * Review defect 13: this used to be exact 2-dp equality against a table in `src/`, so adding
   * one ladder task broke the build until someone edited a src constant. It now checks the two
   * things that matter and are stable under a corpus that grows: the RANK ORDER of the kinds the
   * table names, and each prior to a tolerance. If the corpus moves enough to break either, the
   * failure names the kind and the two numbers.
   *
   * Review defects 2 and 7: the derivation reads all 198 patches (`analysableImage` recovers the
   * 43 SWE-bench hunk fragments), and counts a rewritten multi-line statement ONCE at its first
   * line on both sides — which is what removed `continuation` from the table (defect 6).
   */
  it('reproduces the table: the same rank order, and every prior within 0.15', async () => {
    const { analyse, statementAt } = await import('../../../../../src/jev-modes/synth/py/index.js');
    const { allGoldPatches, analysableImage, removedLines } = await import('./gold-corpus.helpers.js');
    const gold = new Map<string, number>();
    const bg = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string): void => {
      m.set(k, (m.get(k) ?? 0) + 1);
    };
    let analysed = 0;
    for (const p of allGoldPatches()) {
      const bi = analysableImage(p.before, analyse);
      const ai = analysableImage(p.after, analyse);
      if (bi === null || ai === null) continue;
      analysed += 1;
      const mod = analyse(bi.text);
      const isSite = (l: number): boolean => {
        const t = (mod.lines[l - 1] ?? '').trim();
        return t !== '' && !t.startsWith('#') && !mod.blocks.some((b) => l >= b.startLine && l <= b.headerEndLine);
      };
      // gold: each removed line mapped to its STATEMENT's first line, deduped
      const hit = new Set<number>();
      for (const l of removedLines(bi.text.split('\n'), ai.text.split('\n'))) {
        if (!isSite(l)) continue;
        const st = statementAt(mod, l);
        hit.add(st === undefined ? l : st.startLine);
      }
      for (const l of hit) bump(gold, statementAt(mod, l)?.kind ?? 'other');
      // background: each STATEMENT once, at its first line
      const seen = new Set<number>();
      for (let l = 1; l <= mod.lines.length; l++) {
        if (!isSite(l)) continue;
        const st = statementAt(mod, l);
        const first = st === undefined ? l : st.startLine;
        if (seen.has(first) || !isSite(first)) continue;
        seen.add(first);
        bump(bg, st?.kind ?? 'other');
      }
    }
    expect(analysed).toBe(allGoldPatches().length);
    const totalGold = [...gold.values()].reduce((a, b) => a + b, 0);
    const totalBg = [...bg.values()].reduce((a, b) => a + b, 0);
    const r0 = totalGold / totalBg;
    expect(r0).toBeCloseTo(GOLD_KIND_BASE_RATE, 2);
    const derived = (k: string): number => (((gold.get(k) ?? 0) + 1) / ((bg.get(k) ?? 0) + 1 / r0)) / r0;
    // every kind the table names is within tolerance of its re-derivation
    const drift: Record<string, [number, number]> = {};
    for (const [k, v] of Object.entries(GOLD_STATEMENT_KIND_PRIOR)) {
      if (Math.abs(derived(k) - v) > 0.15) drift[k] = [v, Number(derived(k).toFixed(2))];
    }
    expect(drift).toEqual({});
    // and the RANK ORDER of the table is the rank order of the corpus
    const byTable = Object.keys(GOLD_STATEMENT_KIND_PRIOR).sort((a, b) => (GOLD_STATEMENT_KIND_PRIOR[b] ?? 0) - (GOLD_STATEMENT_KIND_PRIOR[a] ?? 0));
    const byCorpus = [...byTable].sort((a, b) => derived(b) - derived(a));
    expect(byCorpus).toEqual(byTable);
  });
});

// ---------------------------------------------------------------------------------------
// Review defect 3: the scope of the tail change, pinned rather than denied
// ---------------------------------------------------------------------------------------

/**
 * The branch claimed "a Jev-ON trajectory with a real ranking is byte-identical". It is not, and
 * this is the reviewer's own probe, pinned as a deliberate behaviour change.
 *
 * `Infinity - Infinity` is NOT only the no-Jev case: two tail sites share `+Infinity` whenever
 * the spectrum ranked neither, which is routine with full coverage and a full Jev answer because
 * `statementSiteFor` spans start at a statement's first line and that line usually has no
 * spectrum row of its own. Here Jev answers a real Q5 Choice (mass on L9), a real non-flat Q5n,
 * and the spectrum ranks two continuation lines.
 *
 * *regression pin, labelled as a behaviour change*: 5ac0042 gives `9,10,8,3,6,2,5` and this gives
 * `9,10,8,3,6,5,2` — at `REPLACE_SITES_MAX = 6` the kept SET differs (main keeps L2, this keeps
 * L5). The claim the code now makes is the narrower true one: only the relative order of tail
 * sites the spectrum did not rank changes, in every run.
 */
describe('defect 3: a Jev-ON mixed finite/infinite tail DOES re-order, and that is pinned', () => {
  const SRC = ['def solve(xs, k):', '    total = sum(', '        v for v in xs', '    )', '    limit = max(', '        k, 1', '    )', '    if total > limit:', '        return total - limit', '    return limit - total', ''].join('\n');
  const FAILURE = { testId: 'tests/test_solve.py::test_solve', call: 'solve([1, 2], 5)', expected: '3', actual: '4' };

  it('the kept six are the code order of the unranked tail, with a real Jev ranking present', async () => {
    const file = sf('solve.py', SRC);
    const files = new Map([[file.path, file]]);
    // a real Q5 Choice favouring L9, and a real non-flat Q5n
    const ranked = scriptedAsk((call) => {
      const out: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(call.questions)) {
        if (q.type === 'choice') {
          const keys = Object.keys(q.criteria).filter((k) => k !== 'none_of_these');
          const probabilities: Record<string, number> = { none_of_these: 0.02 };
          for (const k of keys) probabilities[k] = k === 'line_9' ? 0.8 : 0.18 / Math.max(1, keys.length - 1);
          out[id] = { type: 'choice', choice: keys.includes('line_9') ? 'line_9' : (keys[0] ?? 'none_of_these'), probabilities, confidence: 0.8 };
        } else out[id] = { type: 'noul', noul: id === 'line_9' ? 0.8 : id === 'line_8' ? 0.4 : 0 };
      }
      return out;
    });
    const localized = await createLocalizer().localize({ ask: ranked.ask, task: 'Fix solve.', files, failures: [FAILURE], signal: signal(), budget: { maxRequests: 20 } });
    expect(localized.sites.some((s) => s.evidence.jevProbability !== undefined)).toBe(true);
    const ctx: GoalSiteContext = { ask: ranked.ask, task: 'Fix solve.', signal: signal(), files };
    const sbfl: SbflEvidence = { ranked: [[3, 1], [6, 0.9]].map(([line, score], i) => ({ rank: i + 1, file: 'solve.py', line: line!, ef: 1, ep: 0, score: score!, scores: { ochiai: score!, tarantula: score!, dstar: score! } })) };
    const g = await buildGoalSites(ctx, goal({ id: 'g1', tests: [FAILURE.testId], failures: [FAILURE], suspectedFiles: ['solve.py'], planItem: 'fix solve' }), localized, sbfl);
    // the Jev-ranked head is untouched; the tail the spectrum did not rank is in code order
    // the Jev-ranked head is untouched, and the two spectrum rows keep their ranks
    expect(lines(g.replace).slice(0, 4)).toEqual([9, 8, 3, 6]);
    expect(lines(g.replace)).toHaveLength(REPLACE_SITES_MAX);
    // THE POINT: L2 and L5 are the statement SPANS of the two ranked continuation lines. The
    // spectrum has no row at a span's own first line, so both carry `sbflRank = +Infinity` and
    // they are the NaN pair. On 5ac0042 they keep file order — `2, 5`; here the code order puts
    // **5 before 2**, because the span text `limit = max( k, 1 )` shares the test literal `1`
    // with the failure and `total = sum( v for v in xs )` shares nothing. A Jev-ON run with a
    // full spectrum reaches this comparator, which is exactly what the byte-identity claim
    // denied.
    expect(lines(g.replace)).toEqual([9, 8, 3, 6, 5, 2]);
    // both spans carry the spectrum evidence of the LINE they came from, but the rank the
    // comparator reads is looked up at the span's own first line, where there is no row
    expect(g.replace.filter((x) => x.endLine !== undefined).map((x) => x.line)).toEqual([5, 2]);

  });
});

// ---------------------------------------------------------------------------------------
// Review defects 4 and 5: the Q5n evidence the old code could not see
// ---------------------------------------------------------------------------------------

describe('defect 5: a one-line function`s Q5n answer is an answer, not a flat one', () => {
  /** *failing-first by mechanism*: on b3c28a0 `shortCircuit` is null and no note is written. */
  it('a single code line at 0.95 still short-circuits', async () => {
    const file = sf('s.py', 'def scale(v, k):\n    return v * k\n');
    const files = new Map([[file.path, file]]);
    const ask = scriptedAsk((call) => {
      const out: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(call.questions)) out[id] = q.type === 'noul' ? { type: 'noul', noul: 0.95 } : jevOffAnswer(q);
      return out;
    });
    const localized = await createLocalizer().localize({ ask: ask.ask, task: 'Fix scale.', files, failures: [{ testId: 't', call: 'scale(2, 3)', expected: '6', actual: '5' }], signal: signal(), budget: { maxRequests: 20 } });
    const g = await buildGoalSites({ ask: ask.ask, task: 'Fix scale.', signal: signal(), files }, goal({ id: 'g1', tests: ['t'], failures: [{ testId: 't', call: 'scale(2, 3)', expected: '6', actual: '5' }], suspectedFiles: ['s.py'], planItem: 'fix scale' }), localized);
    expect(g.shortCircuit?.line).toBe(2);
    expect(g.notes).toContain('q5n short-circuit on L2');
    expect(g.notes.some((n) => n.startsWith('q5n ignored'))).toBe(false);
  });

  /** *regression pin*: the `--jev off` inert 0.5 over many lines is still ignored, with its note. */
  it('one value over many lines is still no ranking', async () => {
    const file = sf('m.py', 'def f(a, b):\n    x = a + b\n    y = x * 2\n    z = y - a\n    return z\n');
    const files = new Map([[file.path, file]]);
    const localized = await createLocalizer().localize({ ask: jevOffAsk().ask, task: 'Fix f.', files, failures: [{ testId: 't', call: 'f(1, 2)', expected: '4', actual: '3' }], signal: signal(), budget: { maxRequests: 20 } });
    const g = await buildGoalSites({ ask: jevOffAsk().ask, task: 'Fix f.', signal: signal(), files }, goal({ id: 'g1', tests: ['t'], failures: [{ testId: 't', call: 'f(1, 2)', expected: '4', actual: '3' }], suspectedFiles: ['m.py'], planItem: 'fix f' }), localized);
    expect(g.shortCircuit).toBeNull();
    expect(g.notes.some((n) => n.startsWith('q5n ignored: one value (0.50)'))).toBe(true);
  });
});

describe('defect 4: `widenedReachable` reads the Q5n ranking, not just Q5 anchors', () => {
  const SEEDS = ['mutation', 'template', 'donor'] as const;
  const exhaust = (sites: readonly Site[]): Goal['exhausted'] => {
    const m: Goal['exhausted'] = new Map();
    for (const s of sites) m.set(siteKey(s), new Set(SEEDS));
    return m;
  };

  /**
   * *failing-first by mechanism*: the reviewer's probe. Every line Choice escapes, so no site
   * carries a `jevProbability` — but the Q5n answers 0.90 on one line and SHORT-CIRCUITS, which
   * is Jev being as confident as it ever gets. On b3c28a0 the gate returned true and WIDENED
   * opened with the insert gaps still unspent.
   */
  it('a Q5n short-circuit is a Jev ranking: the gate stays shut', async () => {
    const file = sf('s.py', 'def f(a, b):\n    x = a + b\n    y = x * 2\n    z = y - a\n    return z\n');
    const files = new Map([[file.path, file]]);
    const ask = scriptedAsk((call) => {
      const out: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(call.questions)) out[id] = q.type === 'noul' ? { type: 'noul', noul: id === 'line_5' ? 0.9 : 0.12 } : jevOffAnswer(q);
      return out;
    });
    const F = { testId: 't', call: 'f(1, 2)', expected: '4', actual: '3' };
    const localized = await createLocalizer().localize({ ask: ask.ask, task: 'Fix f.', files, failures: [F], signal: signal(), budget: { maxRequests: 20 } });
    const g = await buildGoalSites({ ask: ask.ask, task: 'Fix f.', signal: signal(), files }, goal({ id: 'g1', tests: ['t'], failures: [F], suspectedFiles: ['s.py'], planItem: 'fix f' }), localized);
    expect(g.ordered.some((s) => s.evidence.jevProbability !== undefined)).toBe(false);
    expect(g.shortCircuit?.line).toBe(5);
    expect(jevRankedSites(g.ordered)).toBe(true);
    // the replace sites are spent, the gaps are not: the measured gate is what applies
    expect(widenedReachable(goal({ exhausted: exhaust(g.replace) }), g.ordered)).toBe(false);
    expect(widenedReachable(goal({ exhausted: exhaust(g.ordered) }), g.ordered)).toBe(true);
  });

  /** *regression pin*: with a flat Q5n (the `--jev off` inert 0.5) nothing ranked, so the gate opens. */
  it('a flat Q5n leaves no ranking, so a spent code-ordered six is enough', async () => {
    const file = sf('s.py', 'def f(a, b):\n    x = a + b\n    y = x * 2\n    z = y - a\n    return z\n');
    const files = new Map([[file.path, file]]);
    const F = { testId: 't', call: 'f(1, 2)', expected: '4', actual: '3' };
    const localized = await createLocalizer().localize({ ask: jevOffAsk().ask, task: 'Fix f.', files, failures: [F], signal: signal(), budget: { maxRequests: 20 } });
    const g = await buildGoalSites({ ask: jevOffAsk().ask, task: 'Fix f.', signal: signal(), files }, goal({ id: 'g1', tests: ['t'], failures: [F], suspectedFiles: ['s.py'], planItem: 'fix f' }), localized);
    expect(jevRankedSites(g.ordered)).toBe(false);
    expect(g.ordered.some((s) => s.kind === 'insert')).toBe(true);
    expect(widenedReachable(goal({ exhausted: exhaust(g.replace) }), g.ordered)).toBe(true);
  });
});
