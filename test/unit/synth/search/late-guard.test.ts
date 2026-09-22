/**
 * OOS iteration 3, item 1 — the LATE-GUARD rule, and the gold sweep that bounds it.
 *
 * Two of the three correctness losses of iteration 1 are the same shape, and it is a shape a
 * thresholdless code rule can see because each one's own gold is THE SAME GUARD at the top of the
 * block (experiments/results/llm-jev-iter1.md §4.2 `token_bucket` "committed as a strong overfit",
 * §5 `stats` "a weak overfit again"):
 *
 *   - `stats` (in-sample ladder, run 20260922-123643-rcnailmj) inserted
 *     `if not ordered: raise ValueError("median of empty sequence")` BEFORE line 22 of
 *     `src/stats.py` — behind `ordered = sorted(values)`, `mid = len(ordered) // 2` and
 *     `if len(ordered) % 2: return float(ordered[mid])`, all of which already read `ordered`, so
 *     the odd-length path never reaches the guard. `bench/data/ladder/tasks/stats/gold/stats.py`
 *     inserts `if not values: raise ValueError(...)` as the FIRST statement of `median`.
 *   - `token_bucket` (fresh ladder long-2, run 20260922-115943-acykmmph) rewrote
 *     `if self.refill_per_second <= 0.0:` into `if cost > self.capacity or self.refill_per_second
 *     <= 0.0:` — behind `self.sync(now)` and `if self.tokens >= cost: return 0.0`, which reads
 *     `cost`. `bench/data/ladder/tasks/token_bucket/gold/bucket.py` inserts
 *     `if cost > self.capacity: return None` at the top of `wait_for`.
 *
 * The rule is `py/structure.ts isLateGuard` over `guardClauses`, differenced by
 * `guard.ts newlyLateGuards`, and it is a SUSPICION SIGNAL (`late_guard`) that Q15/Q16 arbitrates —
 * never a hard rejection. The sweep at the bottom is the bound: over all 41 QuixBugs gold patches
 * and every ladder gold file (26 tasks) it fires ZERO times and refuses nothing.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createGuardMemory } from '../../../../src/synth/search/bases.js';
import { decide, mutationRefused, newlyLateGuards, structuralRejection, suspicionSignals } from '../../../../src/synth/search/guard.js';
import { analyse, guardClauses, isLateGuard } from '../../../../src/synth/py/index.js';
import type { Answer, Json, Question } from '../../../../src/core/types.js';
import type { VerifyOutcome } from '../../../../src/synth/search/types.js';
import { REPO_ROOT, candidate, committedBase, failure, goal as goalOf, plausibleOutcome, scriptedAsk, siteAt, sourceFile, summary, throwingAsk } from './helpers.js';

const LADDER = join(REPO_ROOT, 'bench/data/ladder/tasks');
const QUIXBUGS = join(REPO_ROOT, 'bench/data/quixbugs');
const read = (p: string): string => readFileSync(p, 'utf8');

/** A one-file patch as `newlyLateGuards` reads it. */
function lateGuardsOf(path: string, before: string, after: string): string[] {
  return newlyLateGuards({ files: [{ path, before, after }] }).map((x) => `${x.fn}:${x.guard.test}`);
}

// ---------------------------------------------------------------------------------------
// The rule on the two records and their golds
// ---------------------------------------------------------------------------------------

const STATS_SRC = read(join(LADDER, 'stats/src/stats.py'));
const STATS_GOLD = read(join(LADDER, 'stats/gold/stats.py'));
/** `20260922-123643-rcnailmj` cand_02, the committed one: the gold's guard three statements too late. */
const STATS_OVERFIT = STATS_SRC.replace('    return (ordered[mid - 1] + ordered[mid]) / 2', '    if not ordered:\n        raise ValueError("median of empty sequence")\n    return (ordered[mid - 1] + ordered[mid]) / 2');

const BUCKET_SRC = read(join(LADDER, 'token_bucket/src/bucket.py'));
const BUCKET_GOLD = read(join(LADDER, 'token_bucket/gold/bucket.py'));
/** `20260922-115943-acykmmph`: the new disjunct behind the statement that already reads `cost`. */
const BUCKET_OVERFIT = BUCKET_SRC.replace('        if self.refill_per_second <= 0.0:', '        if cost > self.capacity or self.refill_per_second <= 0.0:');

describe('guardClauses / isLateGuard read the placement, not the condition', () => {
  it('a guard clause is an `if` with no elif/else whose body leaves the suite; `while` and an ordinary branch are not', () => {
    const mod = analyse(['def f(xs, k):', '    """doc"""', '    if not xs:', '        return None', '    total = 0', '    while k > 0:', '        k -= 1', '    if k == 0:', '        total += 1', '    else:', '        total -= 1', '    return total', ''].join('\n'));
    const fn = mod.blocks[0]!;
    const clauses = guardClauses(mod, fn);
    // only `if not xs: return None`: the `while` is a loop and the `if/else` is a branch
    expect(clauses.map((g) => g.test)).toEqual(['not xs']);
    // the docstring is not a position, so the guard is at the top of the block and never late
    expect(clauses[0]).toMatchObject({ position: 0, operands: ['xs'], roots: ['xs'] });
    expect(isLateGuard(clauses[0]!)).toBe(false);
  });

  it('`x = compute()` followed by `if x is None: return` is NOT late — the operand is produced by the statement in front of it', () => {
    const mod = analyse(['def f(a):', '    x = compute(a)', '    if x is None:', '        return 0', '    return x', ''].join('\n'));
    const g = guardClauses(mod, mod.blocks[0]!)[0]!;
    expect(g).toMatchObject({ position: 1, readsBefore: 0, bindsBefore: 1 });
    expect(isLateGuard(g)).toBe(false);
  });

  /**
   * The one false positive the rule had over iteration 1's 46 applied committed patches, and the
   * reason it is not one: `hunk_merge`'s LLM patch (`20260922-115414-emklxk3j`, a PASS and one of
   * the four long-2 wins) defines a local `within()` helper and then guards on `left` / `right`.
   * A declaration runs nothing where it stands, so the guard is at the top of its block.
   */
  it('a nested `def` in front of a guard is a declaration, not a position: the guard still counts as the top of its block', () => {
    const withHelper = ['def merge(left, right):', '    """doc"""', '    def within(side):', '        return [a for a in side]', '', '    if conflicts(left, right) or within(left) or within(right):', '        raise Conflict("clash")', '    return list(left) + list(right)', ''].join('\n');
    const mod = analyse(withHelper);
    const g = guardClauses(mod, mod.blocks.find((b) => b.name === 'merge')!)[0]!;
    expect(g).toMatchObject({ position: 0 });
    expect(isLateGuard(g)).toBe(false);
    const before = withHelper.replace(['    def within(side):', '        return [a for a in side]', '', '    if conflicts(left, right) or within(left) or within(right):'].join('\n'), '    if conflicts(left, right):');
    expect(lateGuardsOf('src/merge.py', before, withHelper)).toEqual([]);
  });

  it('a condition over nothing but builtins and literals has no operand to be placed relative to, so its position says nothing', () => {
    const mod = analyse(['def f(a):', '    a = a + 1', '    if True:', '        return 0', '    return a', ''].join('\n'));
    const g = guardClauses(mod, mod.blocks[0]!)[0]!;
    expect(g).toMatchObject({ position: 1, operands: [], roots: [] });
    expect(isLateGuard(g)).toBe(false);
  });

  it('stats: the committed guard sits behind two statements that read `ordered`; the gold guard is the first statement of `median`', () => {
    const after = analyse(STATS_OVERFIT);
    const median = after.blocks.find((b) => b.name === 'median')!;
    const g = guardClauses(after, median).find((c) => c.test === 'not ordered')!;
    expect(g).toMatchObject({ position: 3, readsBefore: 2, operands: ['ordered'] });
    expect(isLateGuard(g)).toBe(true);
    const gold = analyse(STATS_GOLD);
    const goldGuard = guardClauses(gold, gold.blocks.find((b) => b.name === 'median')!).find((c) => c.test === 'not values')!;
    expect(goldGuard).toMatchObject({ position: 0 });
    expect(isLateGuard(goldGuard)).toBe(false);
    // and as a DIFFERENCE: the overfit adds a late guard, the gold adds none
    expect(lateGuardsOf('src/stats.py', STATS_SRC, STATS_OVERFIT)).toEqual(['median:not ordered']);
    expect(lateGuardsOf('src/stats.py', STATS_SRC, STATS_GOLD)).toEqual([]);
  });

  it('token_bucket: a condition REWRITE is late only through the operand roots it adds — `cost`, read by `if self.tokens >= cost` in front of it', () => {
    expect(lateGuardsOf('src/bucket.py', BUCKET_SRC, BUCKET_OVERFIT)).toEqual(['TokenBucket.wait_for:cost > self.capacity or self.refill_per_second <= 0.0']);
    expect(lateGuardsOf('src/bucket.py', BUCKET_SRC, BUCKET_GOLD)).toEqual([]);
    // the rewrite arm never offers the hoistable shape, so a gold that only swaps an operator or
    // adds a disjunct nothing in front of it reads is silent: `possible_change`'s `not coins`,
    // `account`'s `amount > self.balance`, `csv_schema`'s `len(row) != len(schema.columns)`
    for (const [t, f] of [
      ['account', 'account.py'],
      ['csv_schema', 'schema.py'],
    ] as const) {
      expect(lateGuardsOf(f, read(join(LADDER, t, 'src', f)), read(join(LADDER, t, 'gold', f)))).toEqual([]);
    }
    expect(lateGuardsOf('possible_change.py', read(join(QUIXBUGS, 'programs/possible_change.py')), read(join(QUIXBUGS, 'correct/possible_change.py')))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// The signal, and the decision the records made
// ---------------------------------------------------------------------------------------

const STATS_FILE = sourceFile('src/stats.py', STATS_SRC);
/** `    return (ordered[mid - 1] + ordered[mid]) / 2` — the line the four recorded candidates insert before */
const STATS_GAP = 22;
const STATS_TESTS = ['tests/test_stats.py::test_median_of_empty_raises'];
const STATS_BASE = committedBase(STATS_FILE, summary({ passed: 12, failing: STATS_TESTS, failures: [{ testId: STATS_TESTS[0]!, call: STATS_TESTS[0]!, expected: 'ValueError', actual: 'IndexError' }] }));
const STATS_GOAL = goalOf([failure(STATS_TESTS[0]!, 'ValueError', 'IndexError')], { suspectedFiles: ['src/stats.py'] });

/** The four options of the recorded `genuine_fix` request, in the recorded cand_01..cand_04 order. */
const STATS_CANDIDATES: readonly [string, string][] = [
  ['cand_01', '    if not values:\n        raise ValueError("median of empty sequence")'],
  ['cand_02', '    if not ordered:\n        raise ValueError("median of empty sequence")'],
  ['cand_03', '    if not ordered:\n        raise ValueError("ordered must not be empty")'],
  ['cand_04', '    if not ordered:\n        raise ValueError("p must be between 0 and 100")'],
];
/** The recorded answers: choice cand_02 0.81 / escape 0.15, nouls 0.39 / 0.49 / 0.49 / 0.21. */
const STATS_NOULS: Record<string, number> = { cand_01: 0.39, cand_02: 0.49, cand_03: 0.49, cand_04: 0.21 };
const STATS_CHOICE: Record<string, number> = { cand_01: 0.04, cand_02: 0.81, cand_03: 0, cand_04: 0, none_of_these: 0.15 };

function statsPassers(): VerifyOutcome[] {
  return STATS_CANDIDATES.map(([id, text]) => plausibleOutcome(candidate(siteAt(STATS_FILE, STATS_GAP, 'insert'), text, { id, source: 'mutation', op: 'statement_insert' }), STATS_BASE));
}

/** Answers keyed by the option KEY (the recorded rows are cand_01..cand_04, and two options share their text). */
function byKey(choiceP: Record<string, number>, nouls: Record<string, number>): ReturnType<typeof scriptedAsk> {
  return scriptedAsk((questions) => {
    const out: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === 'choice') {
        const keys = Object.keys(q.criteria);
        const probabilities: Record<string, number> = {};
        for (const k of keys) probabilities[k] = choiceP[k] ?? 0;
        const best = keys.reduce((a, b) => ((probabilities[b] ?? 0) > (probabilities[a] ?? 0) ? b : a), keys[0] ?? '');
        out[id] = { type: 'choice', choice: best, probabilities, confidence: 0.7 };
      } else if (q.type === 'noul') {
        out[id] = { type: 'noul', noul: nouls[id.replace(/^general_/, '')] ?? 0 };
      } else {
        throw new Error(`unexpected question ${id}`);
      }
    }
    return out;
  });
}

describe('stats (20260922-123643-rcnailmj): four late guards, no clean candidate in the pool', () => {
  it('`late_guard` fires on every one of the four recorded candidates, the gold-shaped `if not values` included — it is placed late too', () => {
    for (const o of statsPassers()) expect(suspicionSignals(o, STATS_GOAL)).toContain('late_guard');
  });

  it('the batch is arbitrated with the signals in the state and NOT committed: the pick answered general 0.49, below the two-signal vouch bound', async () => {
    const mem = createGuardMemory(STATS_BASE);
    const notes: string[] = [];
    const ask = byKey(STATS_CHOICE, STATS_NOULS);
    const d = await decide(statsPassers(), mem, STATS_GOAL, ask, { note: (n) => notes.push(n) });
    expect(d).toMatchObject({ kind: 'continue', arbitrated: true, requests: 1, dropped: 4 });
    expect(ask.calls).toHaveLength(1);
    // the state named the placement on every option, which is what the record's Q16 could not see
    const state = ask.calls[0]!.state as { signals?: Record<string, string[]>; signals_note?: string };
    expect(Object.keys(state.signals ?? {})).toEqual(['cand_01', 'cand_02', 'cand_03', 'cand_04']);
    expect(state.signals_note).toContain('computed from the source alone');
    expect(notes.some((n) => n.includes('gold-free pool'))).toBe(true);
    expect(notes.some((n) => n.includes('general 0.49') && n.includes('dropping the 4 passers'))).toBe(true);
  });
});

describe('token_bucket (20260922-115943-acykmmph): the committed three-file LLM patch', () => {
  const policy = sourceFile('src/policy.py', read(join(LADDER, 'token_bucket/src/policy.py')));
  const bucket = sourceFile('src/bucket.py', BUCKET_SRC);
  const limiter = sourceFile('src/limiter.py', read(join(LADDER, 'token_bucket/src/limiter.py')));
  const tests = ['tests/test_bucket.py::test_wait_for_above_the_capacity_never_ends'];
  const base = committedBase(policy, summary({ passed: 26, failing: tests, failures: [{ testId: tests[0]!, call: tests[0]!, expected: 'None', actual: '0.0' }] }), [bucket, limiter]);
  const g = goalOf([failure(tests[0]!, 'None', '0.0')], { suspectedFiles: ['src/policy.py', 'src/bucket.py'] });
  const POLICY_FIX = '    return TokenBucket(capacity=policy.burst, refill_per_second=policy.refill_rate, tokens=policy.burst, updated_at=now)';

  /** An LLM sample that fixes policy.py and limiter.py correctly and puts the capacity guard late in bucket.py. */
  const sample = (id: string, bucketLine: string): VerifyOutcome =>
    plausibleOutcome(
      candidate(siteAt(policy, 35), POLICY_FIX, {
        id,
        source: 'llm',
        op: `sample_0_${id.slice(-1)}`,
        prior: 1,
        extraEdits: [
          { path: 'src/bucket.py', line: 40, kind: 'replace', text: bucketLine },
          { path: 'src/limiter.py', line: 31, kind: 'replace', text: '        if wait == 0.0:' },
        ],
      }),
      base,
    );

  it('the late guard is found in an EXTRA EDIT of another file, not at the candidate\'s own site', () => {
    const o = sample('tb_01', '        if cost > self.capacity or self.refill_per_second <= 0.0:');
    expect(newlyLateGuards(o.applied).map((x) => `${x.path} ${x.fn}`)).toEqual(['src/bucket.py TokenBucket.wait_for']);
    expect(suspicionSignals(o, g)).toContain('late_guard');
    // the gold's own three hunks carry no late guard at all
    const gold = sample('tb_gold', '        if self.refill_per_second <= 0.0:');
    expect(newlyLateGuards(gold.applied)).toEqual([]);
    expect(suspicionSignals(gold, g)).not.toContain('late_guard');
  });

  it('two late-guard samples in one behaviour cluster are arbitrated and refused at the recorded nouls 0.39 / 0.33', async () => {
    const mem = createGuardMemory(base);
    const passers = [sample('tb_01', '        if cost > self.capacity or self.refill_per_second <= 0.0:'), sample('tb_02', '        if self.refill_per_second <= 0.0 or cost > self.capacity:')];
    const ask = byKey({ cand_01: 0.58, cand_02: 0.25, none_of_these: 0.17 }, { cand_01: 0.39, cand_02: 0.33 });
    const notes: string[] = [];
    const d = await decide(passers, mem, g, ask, { note: (n) => notes.push(n) });
    expect(d).toMatchObject({ kind: 'continue', arbitrated: true, requests: 1, dropped: 2 });
    expect(notes.some((n) => n.includes('general 0.39') && n.includes('dropping the 2 passers'))).toBe(true);
  });

  it('a sole passer whose only fault is the late guard is never dropped — it is put to Q16 and committed when Jev keeps it', async () => {
    const mem = createGuardMemory(base);
    const ask = byKey({}, { cand_01: 0.9 });
    const d = await decide([sample('tb_01', '        if cost > self.capacity or self.refill_per_second <= 0.0:')], mem, g, ask);
    expect(d.kind).toBe('commit');
    expect(d.signals).toContain('late_guard');
    expect(d.requests).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------
// The sweep: no gold patch anywhere in the bench data adds a late guard, and none is refused
// ---------------------------------------------------------------------------------------

interface GoldPatch {
  name: string;
  path: string;
  before: string;
  after: string;
}

function quixbugsGolds(): GoldPatch[] {
  const out: GoldPatch[] = [];
  for (const f of readdirSync(join(QUIXBUGS, 'programs')).filter((x) => x.endsWith('.py'))) {
    const after = join(QUIXBUGS, 'correct', f);
    if (!existsSync(after)) continue;
    out.push({ name: `quixbugs/${f}`, path: f, before: read(join(QUIXBUGS, 'programs', f)), after: read(after) });
  }
  return out;
}

function ladderGolds(): GoldPatch[] {
  const out: GoldPatch[] = [];
  const walk = (dir: string, rel = ''): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), `${rel}${e.name}/`) : e.name.endsWith('.py') ? [`${rel}${e.name}`] : []));
  for (const task of readdirSync(LADDER)) {
    const goldDir = join(LADDER, task, 'gold');
    const srcDir = join(LADDER, task, 'src');
    if (!existsSync(goldDir) || !existsSync(srcDir)) continue;
    for (const f of walk(goldDir)) {
      const before = join(srcDir, f);
      if (!existsSync(before)) continue;
      out.push({ name: `ladder/${task}/${f}`, path: `src/${f}`, before: read(before), after: read(join(goldDir, f)) });
    }
  }
  return out;
}

describe('gold sweep: every gold patch of the bench data', () => {
  const golds = [...quixbugsGolds(), ...ladderGolds()];

  it('covers the 41 QuixBugs programs and every ladder task (the 20 short rungs, the 6 long-2 tier and the long/repository rungs beside them)', () => {
    expect(quixbugsGolds()).toHaveLength(41);
    const tasks = new Set(ladderGolds().map((p) => p.name.split('/')[1]));
    expect(tasks.size).toBeGreaterThanOrEqual(26);
    for (const t of ['token_bucket', 'stats', 'deadline_queue', 'dep_order', 'hunk_merge', 'route_match', 'csv_schema']) expect(tasks.has(t)).toBe(true);
  });

  it('adds ZERO late guards', () => {
    const firing = golds.filter((p) => lateGuardsOf(p.path, p.before, p.after).length > 0).map((p) => `${p.name}: ${lateGuardsOf(p.path, p.before, p.after).join(', ')}`);
    expect(firing).toEqual([]);
  });

  it('and is refused by no structural rule (the none-exit rejection and the `raises`-goal mutation rule stay silent too)', () => {
    const raisesEverything = goalOf([failure('t', 'ValueError raised', 'ValueError not raised')]);
    const refused = golds.filter((p) => {
      const applied = { files: [{ path: p.path, before: p.before, after: p.after }] };
      return structuralRejection(applied) !== null || mutationRefused(applied, raisesEverything);
    });
    expect(refused.map((p) => p.name)).toEqual([]);
  });

  it('and the sweep is a code-only property: nothing above asks Jev', async () => {
    // `throwingAsk` proves it for the decision path too, on a gold with no signal at all
    const wrapGoldFile = sourceFile('src/stats.py', STATS_SRC);
    const mem = createGuardMemory(STATS_BASE);
    const clean = plausibleOutcome(candidate(siteAt(wrapGoldFile, 19), '    mid = len(ordered) // 2', { id: 'noop_clean' }), STATS_BASE);
    await expect(decide([clean], mem, STATS_GOAL, throwingAsk)).resolves.toMatchObject({ kind: 'commit', signals: [] });
  });
});

/** The state a Q15 request carries is JSON, so a `signals` block must serialise. */
it('the signals block is plain JSON', () => {
  const state: Json = { signals: { cand_01: ['adds a guard behind statements that already use the value it guards, where the same guard could have stood at the top of the block'] } };
  expect(JSON.parse(JSON.stringify(state))).toEqual(state);
});

/** Type-only guard so the fixture list above cannot silently drift from the question shape. */
const _q: Question | null = null;
void _q;
