/**
 * contract 1.9 (Fastlane) §3.5 — `--quick` (docs/LLM-LOOP-DESIGN.md §3.5: "`src/bench/cli.ts` gains
 * `--quick`. Global caps per HARNESS-NEXT-DESIGN.md §3 M16"; M16: "the five tasks of §5,
 * `--concurrency 3`, replay-by-default, `--spend-cap 0.05`"; §9.3 records the status as
 * "no `--quick` in `src/bench/cli.ts`").
 *
 * Why a preset at all. M16's own figure: "a full iteration cycle in ≈ 2 min and ≈ $0.01 instead of the
 * 26–36 min / $0.30 head-to-head". §5's task selection follows "Efficient Benchmarking of AI Agents"
 * (44–70 % task reduction at LOSO Spearman 0.92) — a mid-difficulty subset of tasks JevCode ALREADY
 * PASSES, so a red row is unambiguous rather than noise.
 *
 * The rule under test is that it is a set of DEFAULTS, never an override: a preset that silently
 * replaced an explicit `--task-id` would make a one-task debugging run quietly five tasks and $0.05.
 */
import { describe, expect, it } from 'vitest';

import { parseCliArgs } from '../../../src/cli/args.js';
import { QUICK_CONCURRENCY, QUICK_SPEND_CAP_USD, QUICK_TASK_IDS, withQuickPreset, type BenchFlags } from '../../../src/bench/cli.js';

const flags = (over: Partial<BenchFlags> = {}): BenchFlags => ({ ...over }) as BenchFlags;

describe('§3.5 / M16 the --quick preset', () => {
  it('is inert without the flag', () => {
    const given = flags({ suite: 'quixbugs' });
    expect(withQuickPreset(given)).toBe(given);
    expect(withQuickPreset(flags({ quick: false }))).toEqual({ quick: false });
  });

  it('fills the five §5 Ring-2 tasks, concurrency 3 and the $0.05 global cap', () => {
    const out = withQuickPreset(flags({ quick: true }));
    expect(QUICK_TASK_IDS).toEqual(['gcd', 'tagcloud', 'units', 'kth', 'mergesort']);
    expect(out.taskId).toBe('gcd,tagcloud,units,kth,mergesort');
    expect(out.concurrency).toBe(String(QUICK_CONCURRENCY));
    expect(QUICK_CONCURRENCY).toBe(3);
    expect(out.spendCap).toBe(String(QUICK_SPEND_CAP_USD));
    expect(QUICK_SPEND_CAP_USD).toBe(0.05);
    // replay by default: the preset never turns --live on, which is what makes it $0 and seconds
    expect(out.live).toBeUndefined();
  });

  it('never overrides what the caller stated: every filled key yields to an explicit flag', () => {
    const out = withQuickPreset(flags({ quick: true, taskId: 'mergesort', concurrency: '1', spendCap: '0.5', live: true }));
    expect(out.taskId).toBe('mergesort');
    expect(out.concurrency).toBe('1');
    expect(out.spendCap).toBe('0.5');
    expect(out.live).toBe(true);
  });

  it('gives --quick --live a cap, so M16’s preset cannot trip the "--live requires --spend-cap" guard', () => {
    expect(withQuickPreset(flags({ quick: true, live: true })).spendCap).toBe('0.05');
  });
});

/**
 * Review defect 6. The preset is reachable from `runBenchFromFlags` but NOT from a command line: `src/cli/args.ts`
 * owns the flag table (`BOOLEAN_FLAGS` + `FLAGS`) and carries `archiveRuns` but not `quick`, and `src/cli` is
 * outside this wave's writable set — exactly as the `BenchFlags` widening above says. This case states the gap
 * instead of leaving it silent: it is the failing half of §3.5's deliverable, and it goes RED (so it is deleted,
 * with this comment) the moment args.ts lands the `'quick'` row.
 */
describe('§3.5 the gap: `--quick` cannot be typed yet', () => {
  it('`jevcode bench --quick` parses as a boolean flag (src/cli/args.ts carries the row beside --archive-runs)', () => {
    expect(parseCliArgs(['bench', '--quick']).quick).toBe(true);
    expect(parseCliArgs(['bench']).quick).toBeUndefined();
    // the sibling boolean of the same wave IS in the table, so this is a missing row and not a parser limitation
    expect(parseCliArgs(['bench', '--archive-runs']).archiveRuns).toBe(true);
  });
});
