/**
 * The guard's two threshold-free structural rejection rules (ranked change 5 of
 * docs/research/llm-jev/oos-analysis-2026-09-22.md, evidence in its Q6 table): a passing candidate
 * that adds an implicit-`None` exit to a function whose every other exit returns a value, or that
 * mutates a parameter the pre-patch code did not, is never committed. Both are computed from the
 * Python source of the patched file before and after the patch (src/jev-modes/synth/py/structure.ts) and
 * cost ZERO Jev requests — every `decide` below runs on `throwingAsk`.
 *
 * The two fixtures are the two committed patches of the Q6 table, rebuilt from the bench sources:
 *   - `20260922-013715-nlsygcax` (not in the OOS run archive; the patch text is quoted in Q6):
 *     template `guard_empty_break` — `if not hare.successor.successor: break` inside `while True:`.
 *     The guard saw 5 plausible / 3 clusters / arbitrated / `general_cand_01` noul 0.44, ABOVE
 *     `SUSPECT_NOUL_MAX` 0.3, so the all-overfit drop never fired.
 *   - `20260922-014311-65ul43qh`: mutation `values.remove(mid)`. 5 plausible, 2 clusters,
 *     arbitrated, no `genuine_fix` request — decided by `probeMajorityCluster`/majority.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createGuardMemory } from '../../../../../src/jev-modes/synth/search/bases.js';
import { ARGS_MUTATED_MARK, PROBE_OUTPUTS_PREFIX, PROBE_OUTPUT_SEP, decide, mutationRefused, newlyMutatedParameters, raisesGoal, structuralRejection, suspicionSignals } from '../../../../../src/jev-modes/synth/search/guard.js';
import { ladderOutputText } from '../../../../../src/jev-modes/synth/search/perturb.js';
import { analyse, fallsOffEnd, mutatedParameterDetails, mutatedParameters, qualifiedName } from '../../../../../src/jev-modes/synth/py/index.js';
import { DETECT_CYCLE, DETECT_CYCLE_FAILURES, DETECT_CYCLE_GOLD, DETECT_CYCLE_LINE, REPO_ROOT, candidate, committedBase, failure, goal as goalOf, noulAnswer, plausibleOutcome, scriptedAsk, siteAt, sourceFile, summary, throwingAsk } from './helpers.js';

const STATS = sourceFile('stats.py', readFileSync(join(REPO_ROOT, 'bench/data/ladder/tasks/stats/src/stats.py'), 'utf8'));
/** `    if len(ordered) % 2:` — the gap the committed mutation was inserted before, inside `median` */
const STATS_MEDIAN_GAP = 20;
const STATS_TEST = 'tests/test_stats.py::test_median_of_empty_raises';
const DETECT_CYCLE_TEST = DETECT_CYCLE_FAILURES[0]!.testId;

/** The committed `detect_cycle` patch of the Q6 table: `guard_empty_break` before `hare = hare.successor.successor`. */
function guardEmptyBreak(): ReturnType<typeof candidate> {
  return candidate(siteAt(DETECT_CYCLE, 9, 'insert'), '        if not hare.successor.successor: break', { id: 'dc_guard_empty_break', source: 'template', op: 'guard_empty_break' });
}

/** The committed `stats` patch of the Q6 table: `values.remove(mid)` inside `median`. */
function removeMid(): ReturnType<typeof candidate> {
  return candidate(siteAt(STATS, STATS_MEDIAN_GAP, 'insert'), '    values.remove(mid)', { id: 'stats_remove_mid', source: 'mutation', op: 'statement_insert' });
}

describe('the two structural properties (src/jev-modes/synth/py/structure.ts)', () => {
  it('`fallsOffEnd` reads the implicit-None exit a `break` opens in a `while True:` (detect_cycle, run 20260922-013715-nlsygcax)', () => {
    const before = analyse(DETECT_CYCLE.src);
    const fn = before.blocks.find((b) => b.name === 'detect_cycle')!;
    // the shipped program cannot reach the end of its body: `while True:` has no `break`
    expect(fallsOffEnd(before, fn)).toBe(false);
    expect(qualifiedName(before, fn)).toBe('detect_cycle');
    const after = analyse(guardEmptyBreak().site.file.src.replace('        hare = hare.successor.successor', '        if not hare.successor.successor: break\n        hare = hare.successor.successor'));
    expect(fallsOffEnd(after, after.blocks.find((b) => b.name === 'detect_cycle')!)).toBe(true);
  });

  it('`mutatedParameters` names the parameter `values.remove(mid)` mutates and nothing the pre-patch `median` does (stats, run 20260922-014311-65ul43qh)', () => {
    const before = analyse(STATS.src);
    const median = before.blocks.find((b) => b.name === 'median')!;
    expect(mutatedParameters(before, median)).toEqual([]);
    const after = analyse(STATS.src.replace('    if len(ordered) % 2:', '    values.remove(mid)\n    if len(ordered) % 2:'));
    expect(mutatedParameters(after, after.blocks.find((b) => b.name === 'median')!)).toEqual(['values']);
    // a parameter the body rebinds is not the caller's object any more, so it is never reported
    const rebound = analyse('def f(values):\n    values = list(values)\n    values.remove(1)\n    return values\n');
    expect(mutatedParameters(rebound, rebound.blocks[0]!)).toEqual([]);
  });
});

describe('structuralRejection (ranked change 5, Q6)', () => {
  it('rejects the committed `guard_empty_break` patch: it adds an implicit-None exit to a function whose every other exit returns a value (20260922-013715-nlsygcax; noul 0.44 > SUSPECT_NOUL_MAX 0.3, so the all-overfit drop never fired)', () => {
    expect(structuralRejection(plausibleOutcome(guardEmptyBreak(), dcBase()).applied)).toBe('adds_implicit_none_exit');
  });

  /**
   * Review finding 2: argument mutation is no longer a refusal by itself — `structuralRejection`
   * is the none-exit rule only, and the mutation is decided by `mutationRefused(applied, goal)`.
   * The `stats` shape still fails it: `remove` on a parameter `median` never returns, for a goal
   * whose tests expect a raise.
   */
  it('the committed `values.remove(mid)` mutation is still refused, now through mutationRefused: the parameter is never returned and the goal expects a raise (20260922-014311-65ul43qh)', () => {
    const applied = plausibleOutcome(removeMid(), statsBase()).applied;
    const statsGoal = goalOf([failure(STATS_TEST, 'ValueError', 'IndexError')], { suspectedFiles: [STATS.path] });
    expect(structuralRejection(applied)).toBeNull(); // the none-exit rule says nothing about it
    expect(raisesGoal(statsGoal)).toBe(true);
    expect(mutationRefused(applied, statsGoal)).toBe(true);
    // ... and on a goal with no raise in its evidence the very same patch is only a suspicion
    const plainGoal = goalOf([failure(STATS_TEST, '2.0', '3.0')], { suspectedFiles: [STATS.path] });
    expect(raisesGoal(plainGoal)).toBe(false);
    expect(mutationRefused(applied, plainGoal)).toBe(false);
    expect(newlyMutatedParameters(applied).flatMap((m) => m.names)).toEqual(['values']);
  });

  /**
   * Review finding 1: the "unmodelled constructs cancel in the difference" argument only holds
   * when the construct is in BOTH revisions. Wrapping exiting code in `try/except` — a large
   * fraction of real repository fixes — used to flip `fallsOffEnd` false→true and refuse the sole
   * passer to `holdBestPartial`.
   */
  it('does NOT reject a patch that wraps exiting code in try/except: a newly introduced suite shape skips the rule (review finding 1)', () => {
    const before = 'def pick(x):\n    if x:\n        return 1\n    else:\n        return 2\n';
    const after = 'def pick(x):\n    try:\n        if x:\n            return 1\n        else:\n            return 2\n    except TypeError:\n        pass\n';
    expect(structuralRejection({ files: [{ path: 'm.py', before, after }] })).toBeNull();
    // the same for a newly introduced `for` and a newly introduced `with`
    const loop = 'def pick(xs):\n    for x in xs:\n        return x\n';
    expect(structuralRejection({ files: [{ path: 'm.py', before: 'def pick(xs):\n    return xs[0]\n', after: loop }] })).toBeNull();
  });

  it('still rejects the detect_cycle shape: a `break` is a leaf inside a suite the analysis already walks, not a new shape (review finding 1)', () => {
    expect(structuralRejection(plausibleOutcome(guardEmptyBreak(), dcBase()).applied)).toBe('adds_implicit_none_exit');
  });

  it('models `try` and loop-`else` in the exit analysis, so a try/except that DOES exit on every path is not a None exit (review finding 1)', () => {
    const exits = (src: string): boolean => {
      const mod = analyse(src);
      return fallsOffEnd(mod, mod.blocks[0]!);
    };
    // try-suite exits and every except exits -> the function exits
    expect(exits('def f(x):\n    try:\n        return g(x)\n    except ValueError:\n        raise\n')).toBe(false);
    // an except that falls through leaves a None exit
    expect(exits('def f(x):\n    try:\n        return g(x)\n    except ValueError:\n        pass\n')).toBe(true);
    // a `finally` that exits wins whatever the body did
    expect(exits('def f(x):\n    try:\n        g(x)\n    finally:\n        return 1\n')).toBe(false);
    // a bare try with no except and no exiting finally can still propagate
    expect(exits('def f(x):\n    try:\n        g(x)\n    finally:\n        h()\n')).toBe(true);
    // for/else: the else runs when the loop finished without break, so it is a guaranteed exit
    expect(exits('def f(xs):\n    for x in xs:\n        pass\n    else:\n        return 1\n')).toBe(false);
    // ... unless the loop can break out of it
    expect(exits('def f(xs):\n    for x in xs:\n        break\n    else:\n        return 1\n')).toBe(true);
  });

  it('exempts the two intended in-place idioms: memoisation and sort/reverse on a returned parameter (review finding 2)', () => {
    const params = (src: string): string[] => {
      const mod = analyse(src);
      return mutatedParameters(mod, mod.blocks[0]!);
    };
    // memoisation: the body writes a subscript of the parameter and reads one of the same parameter
    expect(params('def f(d, k):\n    if k not in d:\n        d[k] = 0\n    return d[k]\n')).toEqual([]);
    // an item write with no read of the parameter is still a mutation the caller did not ask for
    expect(params('def f(d, k):\n    d[k] = 0\n    return 1\n')).toEqual(['d']);
    // sort/reverse on a parameter the function hands back is an ordinary in-place API
    expect(params('def f(values):\n    values.sort()\n    return values[-1]\n')).toEqual([]);
    expect(params('def f(values):\n    values.reverse()\n    return values\n')).toEqual([]);
    // ... but sorting a parameter the function never hands back is not
    expect(params('def f(values):\n    values.sort()\n    return len(values)\n')).toEqual(['values']);
    // and `remove` is never an ordering idiom, returned or not
    expect(params('def f(values):\n    values.remove(1)\n    return values\n')).toEqual(['values']);
    // the detail view keeps the exempted ones, labelled
    const mod = analyse('def f(d, k):\n    if k not in d:\n        d[k] = 0\n    return d[k]\n');
    expect(mutatedParameterDetails(mod, mod.blocks[0]!)).toEqual([{ name: 'd', via: 'subscript', exempt: 'memoisation' }]);
  });

  it('accepts the gold of both records: neither adds a None exit nor mutates an argument', () => {
    const gold = candidate(siteAt(DETECT_CYCLE, DETECT_CYCLE_LINE), DETECT_CYCLE_GOLD, { id: 'dc_gold', source: 'mutation', op: 'guard_widen' });
    expect(structuralRejection(plausibleOutcome(gold, dcBase()).applied)).toBeNull();
    const statsGold = candidate(siteAt(STATS, 18, 'insert'), '    if not values:', {
      id: 'stats_gold',
      source: 'template',
      op: 'guard_empty_raise',
      extraEdits: [{ path: STATS.path, line: 18, kind: 'insert', text: '        raise ValueError("median of empty sequence")' }],
    });
    expect(structuralRejection(plausibleOutcome(statsGold, statsBase()).applied)).toBeNull();
  });

  it('the runtime half reuses the replay harness\'s own post-call argument diff (perturb.ts `ladderOutputText`)', () => {
    expect(ladderOutputText('None', '([1, 2],)', true)).toContain(ARGS_MUTATED_MARK);
    expect(ladderOutputText('None', '([1, 2],)', false)).not.toContain(ARGS_MUTATED_MARK);
  });
});

describe('decide refuses a rejected passer with no Jev request', () => {
  it('the lone `guard_empty_break` passer is refused, not committed, and the step searches on (throwingAsk: zero Jev requests)', async () => {
    const base = dcBase();
    const mem = createGuardMemory(base);
    const notes: string[] = [];
    const d = await decide([plausibleOutcome(guardEmptyBreak(), base)], mem, goalOf(DETECT_CYCLE_FAILURES, { suspectedFiles: [DETECT_CYCLE.path] }), throwingAsk, { note: (t) => notes.push(t) });
    expect(d.kind).toBe('continue');
    expect(d).toMatchObject({ requests: 0, arbitrated: false, structuralDrops: 1 });
    expect(notes.some((n) => n.includes('implicit'))).toBe(true);
  });

  it('the lone `values.remove(mid)` passer is refused the same way \u2014 the narrow raises-goal shape \u2014 and a probe signature carrying the harness\'s mutation mark refuses it too', async () => {
    const base = statsBase();
    const mem = createGuardMemory(base);
    const d = await decide([plausibleOutcome(removeMid(), base)], mem, goalOf([failure(STATS_TEST, 'ValueError', 'IndexError')], { suspectedFiles: [STATS.path] }), throwingAsk);
    expect(d.kind).toBe('continue');
    expect(d).toMatchObject({ requests: 0, structuralDrops: 1 });
    // the signature form the ladder replay writes (perturb.ts parseLadderReplay)
    const signature = `${PROBE_OUTPUTS_PREFIX}${['2.0', ladderOutputText('None', '([2],)', true)].join(PROBE_OUTPUT_SEP)}`;
    expect(signature).toContain(ARGS_MUTATED_MARK);
  });

  it('review finding 2: a SOLE passer that mutates an argument is never dropped \u2014 it carries the signal into the lone-passer question instead', async () => {
    const base = statsBase();
    const mem = createGuardMemory(base);
    // the same patch, on a goal whose tests expect a value rather than a raise
    const plainGoal = goalOf([failure(STATS_TEST, '2.0', '3.0')], { suspectedFiles: [STATS.path] });
    const o = plausibleOutcome(removeMid(), base);
    expect(suspicionSignals(o, plainGoal)).toContain('mutates_new_argument');
    const notes: string[] = [];
    // the signal routes the passer to the lone-passer question (rule (b)) instead of dropping it;
    // Jev vouches for it here, and it is COMMITTED — the old code discarded it with no question
    const ask = scriptedAsk(() => ({ general_cand_01: noulAnswer(0.9) }));
    const d = await decide([o], mem, plainGoal, ask, { note: (t) => notes.push(t) });
    expect(d.structuralDrops).toBe(0); // nothing was refused
    expect(d.signals).toContain('mutates_new_argument');
    expect(d.kind).toBe('commit');
    expect(ask.calls).toHaveLength(1);
  });
});

/** The committed base of the `detect_cycle` record: the shipped program with its failing test. */
function dcBase(): ReturnType<typeof committedBase> {
  return committedBase(DETECT_CYCLE, summary({ failing: [DETECT_CYCLE_TEST], passing: ['tests/detect_cycle_test.py::test1'] }));
}

/** The committed base of the `stats` record. */
function statsBase(): ReturnType<typeof committedBase> {
  return committedBase(STATS, summary({ failing: [STATS_TEST], passing: ['tests/test_stats.py::test_median'] }));
}
