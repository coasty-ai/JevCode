/**
 * The guard's two threshold-free structural rejection rules (ranked change 5 of
 * docs/research/llm-jev/oos-analysis-2026-09-22.md, evidence in its Q6 table): a passing candidate
 * that adds an implicit-`None` exit to a function whose every other exit returns a value, or that
 * mutates a parameter the pre-patch code did not, is never committed. Both are computed from the
 * Python source of the patched file before and after the patch (src/synth/py/structure.ts) and
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

import { createGuardMemory } from '../../../../src/synth/search/bases.js';
import { ARGS_MUTATED_MARK, PROBE_OUTPUTS_PREFIX, PROBE_OUTPUT_SEP, decide, structuralRejection } from '../../../../src/synth/search/guard.js';
import { ladderOutputText } from '../../../../src/synth/search/perturb.js';
import { analyse, fallsOffEnd, mutatedParameters, qualifiedName } from '../../../../src/synth/py/index.js';
import { DETECT_CYCLE, DETECT_CYCLE_FAILURES, DETECT_CYCLE_GOLD, DETECT_CYCLE_LINE, REPO_ROOT, candidate, committedBase, failure, goal as goalOf, plausibleOutcome, siteAt, sourceFile, summary, throwingAsk } from './helpers.js';

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

describe('the two structural properties (src/synth/py/structure.ts)', () => {
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

  it('rejects the committed `values.remove(mid)` mutation: it mutates a parameter the pre-patch code did not (20260922-014311-65ul43qh; 5 plausible, 2 clusters, no genuine_fix request)', () => {
    expect(structuralRejection(plausibleOutcome(removeMid(), statsBase()).applied)).toBe('mutates_new_argument');
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

  it('the lone `values.remove(mid)` passer is refused the same way, and a probe signature carrying the harness\'s mutation mark refuses it too', async () => {
    const base = statsBase();
    const mem = createGuardMemory(base);
    const d = await decide([plausibleOutcome(removeMid(), base)], mem, goalOf([failure(STATS_TEST, 'ValueError', 'IndexError')], { suspectedFiles: [STATS.path] }), throwingAsk);
    expect(d.kind).toBe('continue');
    expect(d).toMatchObject({ requests: 0, structuralDrops: 1 });
    // the signature form the ladder replay writes (perturb.ts parseLadderReplay)
    const signature = `${PROBE_OUTPUTS_PREFIX}${['2.0', ladderOutputText('None', '([2],)', true)].join(PROBE_OUTPUT_SEP)}`;
    expect(signature).toContain(ARGS_MUTATED_MARK);
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
