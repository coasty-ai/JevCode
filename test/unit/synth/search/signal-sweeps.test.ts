/**
 * OOS iteration 4, items B and C — the gold sweeps that decide which suspicion signals may make
 * a pool "gold-free".
 *
 * The ruling this file executes (docs/DECISIONS.md, 2026-09-22 "Iteration 3 lands unmeasured",
 * ruling 1): a `SuspicionSignal` may join `POOL_SUSPECT_SIGNALS` only once a sweep of every gold
 * patch in `bench/data` — QuixBugs 41, ladder 65 files, SWE-bench Verified 92 Python hunks, 198
 * in all — shows zero fires. Iteration 3 swept `mutates_new_argument` and `late_guard`; it never
 * swept `duplicates_block`, `guards_other_variable` or `dead_guard`, which were in the type from
 * the start. Item C sweeps those three. Item B adds `guards_derived_local` and sweeps it, plus
 * the second half of the bar iteration 3 set for a pool signal: it must also FIRE on the
 * recorded overfits, or it is evidence about nothing.
 *
 * Labels: *fixture property* for a sweep (what `bench/data` contains), *failing-first by
 * mechanism* for the replay cases (the signal does not exist on 5ac0042, and the shape it names
 * is the recorded patch).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GENERAL_PREFIX, POOL_SUSPECT_SIGNALS, STRONG_SIGNALS_MIN, commitSuspect, decide, newlyDerivedLocalGuards, suspicionSignals } from '../../../../src/synth/search/guard.js';
import type { SuspicionSignal } from '../../../../src/synth/search/guard.js';
import { createGuardMemory } from '../../../../src/synth/search/bases.js';
import { analyse, guardClauses, guardsDerivedLocal, parameterDerivedLocals } from '../../../../src/synth/py/index.js';
import { LADDER_TASKS, QUIXBUGS_DIR, dedent, goldCorpora } from './gold-corpus.helpers.js';
import type { GoldPatch } from './gold-corpus.helpers.js';
import { candidate, committedBase, failure, goal as goalOf, oracle, plausibleOutcome, scriptedAsk, siteAt, sourceFile, summary } from './helpers.js';
import type { HoldBudget } from '../../../../src/synth/search/guard.js';
import type { VerifyOutcome } from '../../../../src/synth/search/types.js';

const ampleHold: HoldBudget = { exhausted: () => false, testWallLeftMs: 600_000, testRunsLeft: 5000, jevRequestsLeft: 8 };

const read = (p: string): string => readFileSync(p, 'utf8');

/**
 * Every signal a gold patch carries, computed the way `decide` computes them on a passer: the
 * whole-file before/after image as the applied candidate, an insert site at the first changed
 * line so `specialCaseScore` and the guard-subject rules see the added text, and a goal whose
 * failure is a None dereference (the shape `guards_other_variable` and `dead_guard` need to be
 * able to fire at all — with no None failure `noneDereference` returns null and the sweep would
 * be vacuous).
 */
function signalsOfGold(p: GoldPatch, failures: ReturnType<typeof failure>[], outputTail: string): SuspicionSignal[] | null {
  // a SWE-bench hunk image starts at the hunk's own indentation; the ones that still do not
  // tokenize after dedenting cannot be analysed at all and are reported as skipped, not as clean
  const before = dedent(p.before);
  const after = dedent(p.after);
  let file: ReturnType<typeof sourceFile>;
  try {
    file = sourceFile(p.path, before);
  } catch {
    return null;
  }
  const beforeLines = new Set(before.split('\n'));
  const added = after
    .split('\n')
    .filter((l) => !beforeLines.has(l) && l.trim() !== '')
    .join('\n');
  const line = Math.min(Math.max(1, firstChangedLine(before, after)), Math.max(1, file.mod.lines.length));
  const base = committedBase(file, summary({ passed: 1, failing: ['t'], failures, outputTail }));
  const o = plausibleOutcome(candidate(siteAt(file, line, 'insert'), added === '' ? (after.split('\n')[0] ?? '') : added, { id: `gold:${p.name}`, source: 'template' }), base);
  // the applied image is the real patch, so the guard-clause differ reads the gold itself
  const applied: VerifyOutcome['applied'] = { ...o.applied, files: [{ path: p.path, before, after }] };
  return suspicionSignals({ ...o, applied }, goalOf(failures));
}

function firstChangedLine(before: string, after: string): number {
  const b = before.split('\n');
  const a = after.split('\n');
  for (let i = 0; i < Math.max(b.length, a.length); i++) if (b[i] !== a[i]) return i + 1;
  return 1;
}

/** The three unswept signals of item C, plus item B's new one. */
const SWEPT_HERE: readonly SuspicionSignal[] = ['duplicates_block', 'guards_other_variable', 'dead_guard', 'guards_derived_local'];

const NONE_FAILURE = [failure('t', 'a value', "AttributeError: 'NoneType' object has no attribute 'successor'")];
const NONE_TAIL = 'Traceback (most recent call last):\n  File "x.py", line 1, in t\nAttributeError';

describe('item C + item B: the gold sweeps, per corpus', () => {
  /** *fixture property*: the corpus is the 198 the ruling names. */
  it('sweeps 41 QuixBugs programs, 65 ladder gold files and 92 SWE-bench Verified Python hunks — 198 patches', () => {
    const [q, l, s] = goldCorpora();
    expect(q![1]).toHaveLength(41);
    expect(l![1]).toHaveLength(65);
    expect(s![1]).toHaveLength(92);
    expect(goldCorpora().reduce((n, [, g]) => n + g.length, 0)).toBe(198);
  });

  /** Hunk images that do not tokenize even after dedenting: reported, never counted as clean. */
  const SKIPPED: Readonly<Record<string, number>> = { quixbugs: 0, ladder: 0, 'swebench-verified-30': 43 };

  for (const [corpus, golds] of goldCorpora()) {
    it(`${corpus}: none of duplicates_block / guards_other_variable / dead_guard / guards_derived_local fires on a gold`, () => {
      const firing: string[] = [];
      let skipped = 0;
      for (const p of golds) {
        const signals = signalsOfGold(p, NONE_FAILURE, NONE_TAIL);
        if (signals === null) {
          skipped += 1;
          continue;
        }
        const found = signals.filter((s) => SWEPT_HERE.includes(s));
        if (found.length > 0) firing.push(`${p.name}: ${found.join(', ')}`);
      }
      expect({ corpus, firing, skipped }).toEqual({ corpus, firing: [], skipped: SKIPPED[corpus] });
    });
  }

  /**
   * *fixture property*, and the reason the sweep is not vacuous: `guards_derived_local` is
   * computed from the patch image alone, so it can fire on a gold whatever the failure is; the
   * other three need the None-dereference failure the fixture supplies.
   */
  it('the sweep is not vacuous: the same harness fires on a synthetic derived-local guard', () => {
    // `first = ordered[0]` is the DEREFERENCE in front — `mid = len(ordered) // 2` on its own is
    // not one, and after the fix pass it is not evidence either (see the read-clause cases below)
    const before = 'def median(values):\n    ordered = sorted(values)\n    first = ordered[0]\n    return ordered[-1] - first\n';
    const after = 'def median(values):\n    ordered = sorted(values)\n    first = ordered[0]\n    if not ordered:\n        raise ValueError("empty")\n    return ordered[-1] - first\n';
    expect(newlyDerivedLocalGuards({ files: [{ path: 'm.py', before, after }] }).map((x) => `${x.fn}:${x.guard.test}`)).toEqual(['median:not ordered']);
  });
});

// ---------------------------------------------------------------------------------------
// Item B: the iteration-1 replay — which of the three recorded overfits does it fire on?
// ---------------------------------------------------------------------------------------

describe('item B: `guards_derived_local` on the three recorded iteration-1 overfits', () => {
  const STATS_SRC = read(join(LADDER_TASKS, 'stats/src/stats.py'));
  const STATS_OVERFIT = STATS_SRC.replace('    return (ordered[mid - 1] + ordered[mid]) / 2', '    if not ordered:\n        raise ValueError("median of empty sequence")\n    return (ordered[mid - 1] + ordered[mid]) / 2');
  const STATS_GOLD = read(join(LADDER_TASKS, 'stats/gold/stats.py'));
  const BUCKET_SRC = read(join(LADDER_TASKS, 'token_bucket/src/bucket.py'));
  const BUCKET_OVERFIT = BUCKET_SRC.replace('        if self.refill_per_second <= 0.0:', '        if cost > self.capacity or self.refill_per_second <= 0.0:');
  const BUCKET_GOLD = read(join(LADDER_TASKS, 'token_bucket/gold/bucket.py'));
  const DC_SRC = read(join(QUIXBUGS_DIR, 'programs/detect_cycle.py'));
  const DC_OVERFIT = DC_SRC.replace('        hare = hare.successor.successor', '        if not hare.successor.successor:\n            break\n        hare = hare.successor.successor');
  const DC_GOLD = read(join(QUIXBUGS_DIR, 'correct/detect_cycle.py'));

  const fires = (path: string, before: string, after: string): string[] => newlyDerivedLocalGuards({ files: [{ path, before, after }] }).map((x) => `${x.fn}:${x.guard.test}`);

  /** *failing-first by mechanism*: on 5ac0042 the symbol does not exist; the shape is `20260922-…` ladder `stats`. */
  it('`stats` FIRES: `ordered = sorted(values)` is derived from the parameter and `mid = len(ordered)` read it first', () => {
    expect(fires('src/stats.py', STATS_SRC, STATS_OVERFIT)).toEqual(['median:not ordered']);
    const mod = analyse(STATS_OVERFIT);
    const median = mod.blocks.find((b) => b.name === 'median')!;
    expect([...parameterDerivedLocals(mod, median)].sort()).toEqual(['mid', 'ordered']);
    // and the GOLD, which guards the parameter at the top of the same function, is silent
    expect(fires('src/stats.py', STATS_SRC, STATS_GOLD)).toEqual([]);
  });

  /** *failing-first by mechanism*: `20260922-013715-nlsygcax`'s shape, and the one iteration 3 could not separate. */
  it('`detect_cycle` FIRES: `hare = tortoise = node` is derived and `if hare.successor is None` read it first; the gold, at the top of the `while` body, is silent', () => {
    expect(fires('detect_cycle.py', DC_SRC, DC_OVERFIT)).toEqual(['detect_cycle:not hare.successor.successor']);
    expect(fires('detect_cycle.py', DC_SRC, DC_GOLD)).toEqual([]);
    // the gold adds `hare` to the clause at position 0 of the `while` body: derived, but nothing
    // in front of it has read `hare` yet, so the placement half of the rule is what keeps it silent
    const mod = analyse(DC_GOLD);
    const block = mod.blocks[0]!;
    expect([...parameterDerivedLocals(mod, block)].sort()).toEqual(['hare', 'tortoise']);
    const clause = guardClauses(mod, block).find((c) => c.test.startsWith('hare is None'))!;
    expect(guardsDerivedLocal(mod, block, clause, { operands: ['hare'] })).toBe(false);
  });

  /** *failing-first by mechanism*, and the honest negative: the overfit and the gold guard the SAME values. */
  it('`token_bucket` does NOT fire: both the overfit and the gold guard `cost` and `self.capacity`, which are parameters', () => {
    expect(fires('src/bucket.py', BUCKET_SRC, BUCKET_OVERFIT)).toEqual([]);
    expect(fires('src/bucket.py', BUCKET_SRC, BUCKET_GOLD)).toEqual([]);
    const mod = analyse(BUCKET_OVERFIT);
    const waitFor = mod.blocks.find((b) => b.name === 'wait_for')!;
    // nothing `wait_for` guards is a derived local — `cost`, `now` and `self` are its parameters
    expect(parameterDerivedLocals(mod, waitFor).has('cost')).toBe(false);
    expect(parameterDerivedLocals(mod, waitFor).has('self')).toBe(false);
  });

  /**
   * The bar (docs/DECISIONS.md 2026-09-22 ruling 1, as iteration 3 applied it to `late_guard`):
   * a clean 198-gold sweep AND a replay record where the signal separates an overfit from its
   * gold. `guards_derived_local` has both. Item C's three have the sweep and no replay record,
   * so they stay lone-passer-only — the sweep alone is NOT the bar, and admitting them on it was
   * the mistake this fix pass corrects.
   */
  it('so it clears both halves of the bar and joins POOL_SUSPECT_SIGNALS — alone', () => {
    expect([...POOL_SUSPECT_SIGNALS].sort()).toEqual(['guards_derived_local', 'mutates_new_argument']);
    for (const s of ['late_guard', 'adds_special_case', 'deletes_statement', 'guards_other_variable', 'dead_guard', 'duplicates_block'] as const) {
      expect(POOL_SUSPECT_SIGNALS.has(s)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------
// The fix pass: the READ clause of `guardsDerivedLocal` is a DEREFERENCE
// ---------------------------------------------------------------------------------------

/**
 * OOS iteration 4 fix pass. The first version of `guardsDerivedLocal` required "a statement
 * strictly before the clause READS R", and that is the very mistake iteration 3's review killed
 * in `late_guard` (finding 1): a bare occurrence cannot fail on the value the guard rejects, so
 * it is no evidence that the guard sits behind anything. The clause is now a DEREFERENCE of R —
 * `R.attr`, `R[…]`, `R.method(…)`.
 *
 * On the ROOT, not the exact dotted path, and the records pick that: `stats`' operand is
 * `ordered` and `return float(ordered[mid])` stands in front, so either rule keeps it; but
 * `detect_cycle`'s operand is `hare.successor.successor` and what stands in front is
 * `if hare.successor is None:` — a dereference of `hare` and of nothing longer. An exact-path
 * rule loses the record the signal was built for. The `self`-collapse that forced `late_guard`
 * onto the exact path cannot recur here because R must be a `parameterDerivedLocals` name, and
 * that set excludes every parameter of the block, `self` and `cls` among them.
 */
describe('the read clause is a dereference: a use that cannot fail is not evidence', () => {
  const fires = (before: string, after: string): string[] => newlyDerivedLocalGuards({ files: [{ path: 'm.py', before, after }] }).map((x) => `${x.fn}:${x.guard.test}`);

  /** *failing-first by mechanism*: every one of these fired at 822be5b. */
  const NOT_EVIDENCE: readonly { name: string; before: string; after: string }[] = [
    {
      name: 'passing the local to a call — `log(result)` cannot fail on None (the coordinator`s case)',
      before: 'def f(x):\n    result = compute(x)\n    log(result)\n    return result.value\n',
      after: 'def f(x):\n    result = compute(x)\n    log(result)\n    if result is None:\n        return None\n    return result.value\n',
    },
    {
      name: '`len(ys)` cannot fail on empty, which is what the guard rejects',
      before: 'def f(xs):\n    ys = sorted(xs)\n    n = len(ys)\n    return n\n',
      after: 'def f(xs):\n    ys = sorted(xs)\n    n = len(ys)\n    if not ys:\n        return None\n    return n\n',
    },
    {
      name: '`isinstance(v2, dict)` is a type test, not a use',
      before: 'def f(v):\n    v2 = norm(v)\n    ok = isinstance(v2, dict)\n    return ok\n',
      after: 'def f(v):\n    v2 = norm(v)\n    ok = isinstance(v2, dict)\n    if v2 is None:\n        return None\n    return ok\n',
    },
    {
      name: 'iterating the local cannot fail on empty',
      before: 'def f(rows):\n    rows2 = list(rows)\n    for r in rows2:\n        see(r)\n    return rows2\n',
      after: 'def f(rows):\n    rows2 = list(rows)\n    for r in rows2:\n        see(r)\n    if not rows2:\n        return None\n    return rows2\n',
    },
  ];

  for (const c of NOT_EVIDENCE) {
    it(c.name, () => {
      expect({ case: c.name, fires: fires(c.before, c.after) }).toEqual({ case: c.name, fires: [] });
    });
  }

  it('a real dereference in front is still evidence', () => {
    expect(fires('def f(x):\n    o = build(x)\n    o.run()\n    return o\n', 'def f(x):\n    o = build(x)\n    o.run()\n    if o is None:\n        return None\n    return o\n')).toEqual(['f:o is None']);
    expect(fires('def f(x):\n    o = build(x)\n    v = o["k"]\n    return v\n', 'def f(x):\n    o = build(x)\n    v = o["k"]\n    if o is None:\n        return None\n    return v\n')).toEqual(['f:o is None']);
  });

  /** The measurement behind "the ROOT, not the exact dotted path". */
  it('the root is what the records need: `detect_cycle` has no dereference of `hare.successor.successor` in front, only of `hare`', () => {
    const mod = analyse(read(join(QUIXBUGS_DIR, 'programs/detect_cycle.py')).replace('        hare = hare.successor.successor', '        if not hare.successor.successor:\n            break\n        hare = hare.successor.successor'));
    const block = mod.blocks[0]!;
    const g = guardClauses(mod, block).find((c) => c.test === 'not hare.successor.successor')!;
    expect(g.operands).toEqual(['hare.successor.successor']);
    // nothing in front dereferences the exact path — that is iteration 3's own finding, and why
    // `late_guard` is silent here; `hare` itself IS dereferenced, by `if hare.successor is None:`
    expect(g.perOperand['hare.successor.successor']?.derefs).toBe(0);
    expect(guardsDerivedLocal(mod, block, g)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// The shapes the rule must stay silent on
// ---------------------------------------------------------------------------------------

describe('`guards_derived_local` is silent on the correct shapes', () => {
  const fires = (before: string, after: string): string[] => newlyDerivedLocalGuards({ files: [{ path: 'm.py', before, after }] }).map((x) => `${x.fn}:${x.guard.test}`);

  const CORRECT: readonly { name: string; before: string; after: string }[] = [
    {
      name: 'a guard on a PARAMETER, wherever it stands',
      before: 'def f(xs, k):\n    n = len(xs)\n    return xs[k] + n\n',
      after: 'def f(xs, k):\n    n = len(xs)\n    if not xs:\n        return None\n    return xs[k] + n\n',
    },
    {
      name: 'a guard on a derived local BEFORE anything reads it',
      before: 'def f(xs):\n    ys = sorted(xs)\n    return ys[0]\n',
      after: 'def f(xs):\n    ys = sorted(xs)\n    if not ys:\n        return None\n    return ys[0]\n',
    },
    {
      name: 'a guard on a local that is NOT derived from a parameter',
      before: 'def f(xs):\n    cache = load()\n    hit = cache.get("k")\n    return hit\n',
      after: 'def f(xs):\n    cache = load()\n    hit = cache.get("k")\n    if cache is None:\n        return None\n    return hit\n',
    },
    {
      name: 'a guard on `self.<attr>` (the receiver is a parameter, not a derived local)',
      before: 'class C:\n    def f(self, k):\n        v = self.store[k]\n        return v\n',
      after: 'class C:\n    def f(self, k):\n        v = self.store[k]\n        if self.store is None:\n            return None\n        return v\n',
    },
    {
      name: 'a guard whose condition reads nothing but builtins and literals',
      before: 'def f(xs):\n    ys = list(xs)\n    n = len(ys)\n    return n\n',
      after: 'def f(xs):\n    ys = list(xs)\n    n = len(ys)\n    if True:\n        return 0\n    return n\n',
    },
    {
      name: 'a condition rewrite that adds no operand',
      before: 'def f(xs):\n    ys = list(xs)\n    n = len(ys)\n    if ys == []:\n        return 0\n    return n\n',
      after: 'def f(xs):\n    ys = list(xs)\n    n = len(ys)\n    if not ys:\n        return 0\n    return n\n',
    },
  ];

  for (const c of CORRECT) {
    it(c.name, () => {
      expect({ case: c.name, fires: fires(c.before, c.after) }).toEqual({ case: c.name, fires: [] });
    });
  }

  it('but a chain through two locals still fires (the derivation is transitive)', () => {
    const before = 'def f(p):\n    a = normalise(p)\n    b = index(a)\n    return b.value\n';
    const after = 'def f(p):\n    a = normalise(p)\n    b = index(a)\n    if b is None:\n        return None\n    return b.value\n';
    expect(fires(before, after)).toEqual([]); // nothing in front has DEREFERENCED `b` yet
    const later = 'def f(p):\n    a = normalise(p)\n    b = index(a)\n    tag = b.tag\n    if b is None:\n        return None\n    return b.value\n';
    expect(fires(before, later)).toEqual(['f:b is None']);
  });
});

// ---------------------------------------------------------------------------------------
// Item D: the lone path counts EVERY signal, the pool path only the swept ones — and stays that way
// ---------------------------------------------------------------------------------------

/**
 * OOS iteration 4, item D (the iteration-3 author's disagreement 2). The asymmetry is real:
 * `decide`'s lone branch takes `signals.length >= STRONG_SIGNALS_MIN`, the pool branch takes
 * `pickSignals.filter(POOL_SUSPECT_SIGNALS.has).length >= STRONG_SIGNALS_MIN`. Since
 * `adds_special_case` rides on every inserted guard, one more signal of any kind forces the 0.7
 * bound on the lone path.
 *
 * The replay decides whether that is a loss, and it is not. Over the iteration-1 `bench/results`
 * records and the OOS `~/.jevcode/runs` records written before iteration 4 started (run ids
 * `20260922-00…` to `20260922-18…`; 591 records readable): 142 recorded lone-passer decisions,
 * 28 of them at bound 0.7, **all 28 put there by UNSWEPT signals alone** as
 * `POOL_SUSPECT_SIGNALS` stood at 5ac0042 — 24 of the 28 are
 * `deletes_statement + adds_special_case`. Of those 28, 27 are holds and 1 committed straight
 * away with the reserve spent. Of the 27 holds:
 *
 *   - none had `general < 0.3`, so none was `unreleasable`: the 0.7 bound HOLDS a passer in the
 *     [0.3, 0.7) band, and step-end `commitSuspect` then commits it as "possible overfit";
 *   - the held site's file is in the run's final patch in **27 of 27**;
 *   - the most frequent one (13 runs) is ladder `units`, `composite/donor_body_unit:parse_size:3stmt`
 *     at `src/units.py:24` at general 0.50, and the patch those runs finish with is the `units`
 *     GOLD algorithm (`for unit in sorted(DURATION_UNITS, key=len, reverse=True): …`, the loop
 *     variable named `number`). So the one gold-equivalent lone passer the 0.7 bound ever caught
 *     was held for the rest of the step and then committed.
 *
 * The bound therefore DELAYED a correct patch and never refused one. Item D's condition for
 * changing the lone path ("only if the records show it refused a correct patch") is not met, so
 * the lone path is left counting every signal and this test pins that, with the mechanism.
 */
describe('item D: the lone bound counts every signal, and the records say that costs nothing', () => {
  const SRC = ['def parse_duration(text):', '    text = text.strip()', '    number, unit = text[:-1], text[-1]', '    return int(number) * UNITS.get(unit, 1)', ''].join('\n');
  const FILE = sourceFile('src/units.py', SRC);
  const TEST = 'tests/test_units.py::test_parse_duration';
  const FAILURES = [failure(TEST, '1500', '1')];
  const BASE = committedBase(FILE, summary({ passed: 4, failing: [TEST], failures: FAILURES }));
  const GOAL = goalOf(FAILURES, { suspectedFiles: ['src/units.py'] });
  /** The recorded `units` passer: a rewrite that deletes two statements and adds a loop. */
  const rewrite = (): VerifyOutcome =>
    plausibleOutcome(
      candidate(siteAt(FILE, 3), '    for unit in sorted(UNITS, key=len, reverse=True):\n        if text.endswith(unit):\n            return int(float(text[: -len(unit)]) * UNITS[unit])', {
        id: 'composite/donor_body_unit:parse_size:3stmt',
        source: 'composite',
        extraEdits: [{ path: FILE.path, line: 4, kind: 'delete' }],
      }),
      BASE,
    );

  /** *failing-first by mechanism* only for the disposition claim; the signal list is a *regression pin*. */
  it('two UNSWEPT signals still force the 0.7 bound on a lone passer (the asymmetry, unchanged)', () => {
    const signals = suspicionSignals(rewrite(), GOAL);
    expect(signals).toEqual(['deletes_statement', 'adds_special_case']);
    expect(signals.filter((s) => POOL_SUSPECT_SIGNALS.has(s))).toEqual([]);
    expect(signals.length).toBeGreaterThanOrEqual(STRONG_SIGNALS_MIN);
  });

  it('and the recorded 0.50 is HELD, not refused: step-end `commitSuspect` releases it as a possible overfit', async () => {
    const mem = createGuardMemory(BASE);
    const g = goalOf(FAILURES, { suspectedFiles: ['src/units.py'] });
    const ask = scriptedAsk(() => ({ [`${GENERAL_PREFIX}cand_01`]: { type: 'noul' as const, noul: 0.5 } }));
    const d = await decide([rewrite()], mem, g, ask, { oracle: oracle(), budget: ampleHold });
    expect(d).toMatchObject({ kind: 'continue', held: 'suspect', requests: 1 });
    const released = commitSuspect(mem, g);
    expect(released).toMatchObject({ kind: 'commit', note: 'possible overfit' });
    if (released?.kind === 'commit') expect(released.outcome?.applied.candidate.id).toBe('composite/donor_body_unit:parse_size:3stmt');
  });

  it('below 0.3 the hold is unreleasable — but the records hold no such lone passer at the 0.7 bound', async () => {
    const mem = createGuardMemory(BASE);
    const g = goalOf(FAILURES, { suspectedFiles: ['src/units.py'] });
    const ask = scriptedAsk(() => ({ [`${GENERAL_PREFIX}cand_01`]: { type: 'noul' as const, noul: 0.12 } }));
    await decide([rewrite()], mem, g, ask, { oracle: oracle(), budget: ampleHold });
    expect(commitSuspect(mem, g)).toBeNull();
  });
});
