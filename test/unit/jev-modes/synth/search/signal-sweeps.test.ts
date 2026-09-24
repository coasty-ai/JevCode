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

import { GENERAL_PREFIX, POOL_SUSPECT_SIGNALS, STRONG_SIGNALS_MIN, commitSuspect, decide, newlyDerivedLocalGuards, suspicionSignals } from '../../../../../src/jev-modes/synth/search/guard.js';
import type { SuspicionSignal } from '../../../../../src/jev-modes/synth/search/guard.js';
import { createGuardMemory } from '../../../../../src/jev-modes/synth/search/bases.js';
import { analyse, guardClauses, guardsDerivedLocal, parameterDerivedLocals } from '../../../../../src/jev-modes/synth/py/index.js';
import { LADDER_TASKS, QUIXBUGS_DIR, analysableImage, goldCorpora } from './gold-corpus.helpers.js';
import type { GoldPatch } from './gold-corpus.helpers.js';
import { candidate, committedBase, failure, goal as goalOf, oracle, plausibleOutcome, scriptedAsk, siteAt, sourceFile, summary } from './helpers.js';
import type { HoldBudget } from '../../../../../src/jev-modes/synth/search/guard.js';
import type { VerifyOutcome } from '../../../../../src/jev-modes/synth/search/types.js';

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
  // review defects 2 and 7: a SWE-bench hunk image is a window cut out of a file, so a plain
  // dedent leaves 43 of the 92 untokenizable. `analysableImage` repairs them, and the sweep now
  // covers all 198 rather than 155.
  const bi = analysableImage(p.before, analyse);
  const ai = analysableImage(p.after, analyse);
  if (bi === null || ai === null) return null;
  const before = bi.text;
  const after = ai.text;
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
  /**
   * *fixture property*, and review defect 13: the count is DERIVED from the corpus, not pinned,
   * so adding a ladder task is not a src change. What is pinned is the shape of the corpus —
   * the three named suites, all 41 QuixBugs programs, and every SWE-bench instance.
   */
  it('sweeps every gold patch in bench/data: QuixBugs, the ladder tasks and the SWE-bench Verified hunks', () => {
    const [q, l, s] = goldCorpora();
    expect(q![1]).toHaveLength(41);
    expect(l![1].length).toBeGreaterThanOrEqual(65);
    expect(s![1]).toHaveLength(92);
    expect(new Set(l![1].map((p) => p.name.split('/')[1])).size).toBeGreaterThanOrEqual(26);
    expect(goldCorpora().reduce((n, [, g]) => n + g.length, 0)).toBe(q![1].length + l![1].length + s![1].length);
  });

  /**
   * Review defects 2 and 7: every patch is analysable now (`analysableImage` recovers the 43
   * SWE-bench hunk fragments), and the sweep reports POWER — how many patches could have fired
   * at all — beside the fires, because "0 fires on 198 golds" over a corpus where the rule can
   * never return true is not evidence. The powers are asserted as lower bounds so the corpus can
   * grow.
   */
  it('every patch is analysable: the 43 unparsed SWE-bench hunk fragments are recovered, 0 skipped', () => {
    let skipped = 0;
    let recovered = 0;
    for (const [, golds] of goldCorpora()) {
      for (const p of golds) {
        const img = analysableImage(p.before, analyse);
        if (img === null) skipped += 1;
        else if (img.offset > 0) recovered += 1;
      }
    }
    expect(skipped).toBe(0);
    expect(recovered).toBeGreaterThanOrEqual(43);
  });

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
      expect({ corpus, firing, skipped }).toEqual({ corpus, firing: [], skipped: 0 });
    });
  }

  /**
   * The POWER of the `guards_derived_local` sweep, stated rather than implied: a patch can only
   * fire if it adds a guard clause whose operand root is a `parameterDerivedLocals` name of the
   * function it lands in. Measured: QuixBugs 2, ladder 4, SWE-bench Verified 0 — **6 of 198**.
   * That is thin, and it is half of why the signal is lone-passer-only.
   */
  it('reports the sweep POWER of `guards_derived_local`: 6 of 198 patches could fire', () => {
    const power: Record<string, number> = {};
    for (const [corpus, golds] of goldCorpora()) {
      let n = 0;
      for (const p of golds) {
        const bi = analysableImage(p.before, analyse);
        const ai = analysableImage(p.after, analyse);
        if (bi === null || ai === null) continue;
        const bm = analyse(bi.text);
        const am = analyse(ai.text);
        const was = new Set(bm.blocks.filter((b) => b.kind === 'def').flatMap((b) => guardClauses(bm, b).map((c) => c.test)));
        const can = am.blocks
          .filter((b) => b.kind === 'def')
          .some((b) => guardClauses(am, b).some((c) => !was.has(c.test) && c.operands.some((o) => parameterDerivedLocals(am, b).has(o.split('.')[0] ?? o))));
        if (can) n += 1;
      }
      power[corpus] = n;
    }
    expect(power).toEqual({ quixbugs: 2, ladder: 4, 'swebench-verified-30': 0 });
    expect(Object.values(power).reduce((a, b) => a + b, 0)).toBe(6);
  });

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

  /**
   * OOS iteration 4's review, defects 1a and 1b, overturned this. `stats` fired because
   * `return float(ordered[mid])` counted as a use in front of the guard — but it sits inside
   * the `if len(ordered) % 2:` branch, which an EMPTY input never takes, so on the failing path
   * nothing had touched `ordered` before the guard at all. With `preceding` restricted to what
   * is unconditionally reached, that use is gone, and the only candidates left
   * (`mid = len(ordered) // 2`, `if len(ordered) % 2:`) cannot fail on an empty list.
   */
  it('`stats` does NOT fire: the only use in front of the guard is inside a branch the failing input never takes', () => {
    expect(fires('src/stats.py', STATS_SRC, STATS_OVERFIT)).toEqual([]);
    const mod = analyse(STATS_OVERFIT);
    const median = mod.blocks.find((b) => b.name === 'median')!;
    expect([...parameterDerivedLocals(mod, median)].sort()).toEqual(['mid', 'ordered']);
    // the data-flow half still holds — `ordered` IS derived from the parameter `values` — and
    // the clause is an emptiness test, so what it needs is a use an empty list would break
    const clause = guardClauses(mod, median).find((c) => c.test === 'not ordered')!;
    expect(clause.tests['ordered']).toBe('empty');
    expect(clause.preceding.map((st) => st.text.trim())).toEqual(['ordered = sorted(values)', 'mid = len(ordered) // 2', 'if len(ordered) % 2:']);
    // and the GOLD, which guards the parameter at the top of the same function, is silent too
    expect(fires('src/stats.py', STATS_SRC, STATS_GOLD)).toEqual([]);
  });

  /**
   * `detect_cycle` fired on a ROOT dereference: `if hare.successor is None:` touches `hare`. But
   * the clause tests `hare.successor.successor` for truthiness, and a falsy
   * `hare.successor.successor` would not have broken `hare.successor` — so by the rule's own
   * justification that use was never evidence.
   */
  it('`detect_cycle` does NOT fire: `hare.successor` in front is not a use a falsy `hare.successor.successor` would break', () => {
    expect(fires('detect_cycle.py', DC_SRC, DC_OVERFIT)).toEqual([]);
    expect(fires('detect_cycle.py', DC_SRC, DC_GOLD)).toEqual([]);
    const mod = analyse(DC_OVERFIT);
    const block = mod.blocks[0]!;
    const clause = guardClauses(mod, block).find((c) => c.test === 'not hare.successor.successor')!;
    expect(clause.tests['hare.successor.successor']).toBe('empty');
    // `preceding` is right here — the prior guard IS in front of it, at the same suite level
    expect(clause.preceding.map((st) => st.text.trim())).toEqual(['hare = tortoise = node', 'while True:', 'if hare.successor is None:', 'tortoise = tortoise.successor']);
    // and the gold, at the top of the `while` body, has nothing in front of it either way
    const gm = analyse(DC_GOLD);
    const gb = gm.blocks[0]!;
    expect([...parameterDerivedLocals(gm, gb)].sort()).toEqual(['hare', 'tortoise']);
    const gold = guardClauses(gm, gb).find((c) => c.test.startsWith('hare is None'))!;
    expect(guardsDerivedLocal(gm, gb, gold, { operands: ['hare'] })).toBe(false);
  });

  /** Unchanged, and the honest negative it always was: the overfit and the gold guard the SAME values. */
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
   * The bar, as the review sharpened it: a clean sweep **with stated power** AND a replay record
   * where the signal separates an overfit from its gold. `guards_derived_local` has the clean
   * sweep, its power is 6 of 198, and after the correction it fires on **0 of the 3** records.
   * That is exactly `late_guard`'s position in iteration 3, and it gets the same answer:
   * LONE-PASSER ONLY. `POOL_SUSPECT_SIGNALS` is `{mutates_new_argument}` — iteration 3's set —
   * so iteration 4 adds no pool signal, and `detect_cycle`'s class A-prime pools are NOT
   * gold-free (`guard.test.ts` pins that they commit by `probe_majority` with no Jev request,
   * which is the hole `20260922-013715-nlsygcax` showed and which stays open).
   */
  it('so it does NOT clear the bar: 0 of 3 replay fires, and the pool set is `{mutates_new_argument}`', () => {
    expect([...POOL_SUSPECT_SIGNALS]).toEqual(['mutates_new_argument']);
    for (const s of ['late_guard', 'adds_special_case', 'deletes_statement', 'guards_other_variable', 'dead_guard', 'duplicates_block', 'guards_derived_local'] as const) {
      expect(POOL_SUSPECT_SIGNALS.has(s)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------
// Review defect 1: every shape both reviews list must stay silent
// ---------------------------------------------------------------------------------------

describe('`guards_derived_local` is silent on the correct shapes', () => {
  const fires = (before: string, after: string): string[] => newlyDerivedLocalGuards({ files: [{ path: 'm.py', before, after }] }).map((x) => `${x.fn}:${x.guard.test}`);

  const CORRECT: readonly { name: string; before: string; after: string }[] = [
    // --- the six the second review measured still firing at b3c28a0 (defect 1a and 1b) ---
    {
      name: 'defect 1a: `items.sort()` succeeds on an empty list, so it is not a use an emptiness guard should have protected',
      before: 'def f(xs):\n    items = list(xs)\n    items.sort()\n    return items[0]\n',
      after: 'def f(xs):\n    items = list(xs)\n    items.sort()\n    if not items:\n        return None\n    return items[0]\n',
    },
    {
      name: 'defect 1a: `s.lower()` succeeds on an empty string',
      before: 'def f(text):\n    s = text.strip()\n    t = s.lower()\n    return t[0]\n',
      after: 'def f(text):\n    s = text.strip()\n    t = s.lower()\n    if not s:\n        return ""\n    return t[0]\n',
    },
    {
      name: 'defect 1a: `cfg.get("k")` succeeds on an empty dict',
      before: 'def f(opts):\n    cfg = dict(opts)\n    v = cfg.get("k")\n    return v\n',
      after: 'def f(opts):\n    cfg = dict(opts)\n    v = cfg.get("k")\n    if not cfg:\n        raise ValueError("e")\n    return v\n',
    },
    {
      name: 'defect 1a: `rows.append(1)` succeeds on an empty list',
      before: 'def f(src):\n    rows = list(src)\n    rows.append(1)\n    return rows\n',
      after: 'def f(src):\n    rows = list(src)\n    rows.append(1)\n    if not rows:\n        raise ValueError("e")\n    return rows\n',
    },
    {
      name: 'defect 1b: the use is inside an `if` branch the guard`s path does not take',
      before: 'def f(xs):\n    ys = sorted(xs)\n    if xs:\n        first = ys[0]\n    else:\n        first = None\n    return first\n',
      after: 'def f(xs):\n    ys = sorted(xs)\n    if xs:\n        first = ys[0]\n    else:\n        first = None\n    if not ys:\n        return None\n    return first\n',
    },
    {
      name: 'defect 1b: the use is inside a `try` whose `except` already handles the empty case',
      before: 'def f(xs):\n    ys = list(xs)\n    try:\n        first = ys[0]\n    except IndexError:\n        first = None\n    return first\n',
      after: 'def f(xs):\n    ys = list(xs)\n    try:\n        first = ys[0]\n    except IndexError:\n        first = None\n    if not ys:\n        return None\n    return first\n',
    },
    // --- the eight the first review measured, which must stay silent ---
    {
      name: 'a guard on a PARAMETER, wherever it stands',
      before: 'def f(xs, k):\n    n = len(xs)\n    return xs[k] + n\n',
      after: 'def f(xs, k):\n    n = len(xs)\n    if not xs:\n        return None\n    return xs[k] + n\n',
    },
    {
      name: 'passing the local to a call — `log(result)` cannot fail on None',
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
    {
      name: '`visited.add(node)` cannot fail on an empty set',
      before: 'def f(nodes):\n    visited = set(nodes)\n    visited.add(1)\n    return visited\n',
      after: 'def f(nodes):\n    visited = set(nodes)\n    visited.add(1)\n    if not visited:\n        return None\n    return visited\n',
    },
    {
      name: 'a comprehension over the local cannot fail on empty',
      before: 'def f(rows):\n    rows2 = list(rows)\n    names = [r.name for r in rows2]\n    return names\n',
      after: 'def f(rows):\n    rows2 = list(rows)\n    names = [r.name for r in rows2]\n    if not rows2:\n        return []\n    return names\n',
    },
    {
      name: 'a nested `def` that uses the local runs when it is CALLED, not where it stands',
      before: 'def f(xs):\n    ys = sorted(xs)\n    def g():\n        return ys[0]\n    return g\n',
      after: 'def f(xs):\n    ys = sorted(xs)\n    def g():\n        return ys[0]\n    if not ys:\n        return None\n    return g\n',
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

  /**
   * The rule is not vacuous after the two narrowings. A `X is None` clause still takes any
   * dereference; an emptiness clause takes the uses an empty value actually breaks, and only
   * those. Without these three the whole signal could be `return false` and every test above
   * would still pass.
   */
  it('a NONE clause behind any dereference still fires', () => {
    expect(fires('def f(x):\n    o = build(x)\n    o.run()\n    return o\n', 'def f(x):\n    o = build(x)\n    o.run()\n    if o is None:\n        return None\n    return o\n')).toEqual(['f:o is None']);
  });

  it('an EMPTINESS clause behind an indexing still fires', () => {
    expect(fires('def f(xs):\n    ys = sorted(xs)\n    a = ys[0]\n    return a\n', 'def f(xs):\n    ys = sorted(xs)\n    a = ys[0]\n    if not ys:\n        return None\n    return a\n')).toEqual(['f:not ys']);
  });

  it('an EMPTINESS clause behind `min()` / `.pop()` / unpacking still fires', () => {
    expect(fires('def f(xs):\n    ys = list(xs)\n    a = min(ys)\n    return a\n', 'def f(xs):\n    ys = list(xs)\n    a = min(ys)\n    if not ys:\n        return None\n    return a\n')).toEqual(['f:not ys']);
    expect(fires('def f(xs):\n    ys = list(xs)\n    a = ys.pop()\n    return a\n', 'def f(xs):\n    ys = list(xs)\n    a = ys.pop()\n    if not ys:\n        return None\n    return a\n')).toEqual(['f:not ys']);
    expect(fires('def f(xs):\n    ys = list(xs)\n    a, b = ys\n    return a\n', 'def f(xs):\n    ys = list(xs)\n    a, b = ys\n    if not ys:\n        return None\n    return a\n')).toEqual(['f:not ys']);
  });

  /** The clause-kind split itself, on one fixture: the same prior use, two different clauses. */
  it('the same prior use is evidence for a NONE clause and not for an EMPTINESS clause', () => {
    const before = 'def f(x):\n    o = build(x)\n    v = o.attr\n    return v\n';
    expect(fires(before, 'def f(x):\n    o = build(x)\n    v = o.attr\n    if o is None:\n        return None\n    return v\n')).toEqual(['f:o is None']);
    expect(fires(before, 'def f(x):\n    o = build(x)\n    v = o.attr\n    if not o:\n        return None\n    return v\n')).toEqual([]);
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

  it('below 0.3 the hold outlasts the reserve and commits flagged at step end — and the records hold no such lone passer at the 0.7 bound', async () => {
    const mem = createGuardMemory(BASE);
    const g = goalOf(FAILURES, { suspectedFiles: ['src/units.py'] });
    const ask = scriptedAsk(() => ({ [`${GENERAL_PREFIX}cand_01`]: { type: 'noul' as const, noul: 0.12 } }));
    await decide([rewrite()], mem, g, ask, { oracle: oracle(), budget: ampleHold });
    expect(commitSuspect(mem, g)).toMatchObject({ kind: 'commit', note: 'possible overfit' });
  });
});
