import { describe, expect, it } from 'vitest';
import type { PlanSnapshot } from '../../../src/core/types.js';
import { SEED_MAX_NOTES, buildSeed, carriedSteers, lastActivityMs, seedFramingText, seedNoticeText, seedSource, type SeedParent } from '../../../src/session/seed.js';
import { makeMeta, makeState, runId, windowEntry } from './helpers.js';

const R1 = runId(1);
const R2 = runId(2);
const R3 = runId(3);

function parent(patch: Partial<SeedParent['meta']> = {}, state: Partial<NonNullable<SeedParent['state']>> = {}): SeedParent {
  return {
    meta: makeMeta({ runId: R1, ...patch }),
    state: makeState({
      runId: R1,
      step: 9,
      stopReason: 'complete',
      plan: {
        done: [{ text: 'parsed tz offsets', evidence: { step: 3, judged: 0.9 } }],
        remaining: ['update docs', 'add tests'],
        unverified: [{ text: 'handles DST', step: 7, judged: 0.5 }],
        openProblems: ['generator thought'],
        harnessProblems: [{ kind: 'replan', text: 'old replan', step: 5 }],
      },
      window: [windowEntry(5), windowEntry(6), windowEntry(7), windowEntry(8), windowEntry(9)],
      createdThisRun: ['src/tz.py', 'tests/test_tz.py'],
      lastTestRun: { step: 9, command: 'pytest -q', passed: 12, failed: 0, errors: 0, allPassed: true },
      undoLog: [{ runId: R1, step: 7, at: 't', by: 'undo', restored: ['a'], skipped: [] }],
      ...state,
    }),
  };
}

describe('buildSeed (TUI-DESIGN §8.3)', () => {
  it('carries plan done/remaining/unverified, empties openProblems, frames with a step-0 human problem, keeps the last 4 window entries', () => {
    const p = parent();
    const seed = buildSeed(p, { humanNotes: [], pinnedFiles: [] });
    expect(seed.parentRunId).toBe(R1);
    expect(seed.plan.done).toEqual(p.state!.plan.done);
    expect(seed.plan.remaining).toEqual(['update docs', 'add tests']);
    expect(seed.plan.unverified).toEqual(p.state!.plan.unverified);
    expect(seed.plan.openProblems).toEqual([]);
    expect(seed.plan.harnessProblems).toEqual([{ kind: 'human', step: 0, text: `Follow-up to run ${R1} (stopped: complete) whose task was "fix parse_date tz handling"; the task above is the human's next instruction` }]);
    expect(seed.window.map((e) => e.step)).toEqual([6, 7, 8, 9]);
    for (const e of seed.window) expect(e.notes).toEqual([`note ${e.step}`, `from run ${R1}`]);
    expect(seed.createdThisRun).toEqual(['src/tz.py', 'tests/test_tz.py']);
    expect(seed.lastTestRun).toEqual({ step: 9, command: 'pytest -q', passed: 12, failed: 0, errors: 0, allPassed: true });
    expect(seed.undoLog).toEqual(p.state!.undoLog);
    expect(seed.pinnedFiles).toEqual([]);
  });

  it('is pure and copies: mutating the seed never touches the parent state', () => {
    const p = parent();
    const seed = buildSeed(p, { humanNotes: [], pinnedFiles: ['src/a.py'] });
    seed.plan.remaining.push('x');
    seed.plan.done[0]!.text = 'changed';
    seed.window[0]!.notes.push('y');
    seed.createdThisRun.push('z');
    seed.pinnedFiles!.push('q');
    seed.undoLog!.push({ runId: R2, step: 1, at: 't', by: 'rewind', restored: [], skipped: [] });
    expect(p.state!.plan.remaining).toEqual(['update docs', 'add tests']);
    expect(p.state!.plan.done[0]!.text).toBe('parsed tz offsets');
    expect(p.state!.window[1]!.notes).toEqual(['note 6']);
    expect(p.state!.createdThisRun).toHaveLength(2);
    expect(p.state!.undoLog).toHaveLength(1);
    expect(buildSeed(p, { humanNotes: [], pinnedFiles: [] })).toEqual(buildSeed(p, { humanNotes: [], pinnedFiles: [] }));
  });

  it('appends human notes then the parent pending steers as step-0 problems, clipped at 600, blanks dropped', () => {
    const p = parent({}, { pendingDirectives: [{ text: 'keep CHANGELOG format', at: 't', index: 1 }, { text: '   ', at: 't', index: 2 }, { text: 'x'.repeat(700), at: 't', index: 3 }] });
    const seed = buildSeed(p, { humanNotes: ['human reverted step 7: restored 3 files', '', 'y'.repeat(650)], pinnedFiles: [] });
    const texts = seed.plan.harnessProblems.map((h) => h.text);
    expect(seed.plan.harnessProblems.every((h) => h.kind === 'human' && h.step === 0)).toBe(true);
    expect(texts).toHaveLength(5);
    expect(texts[1]).toBe('human reverted step 7: restored 3 files');
    expect(texts[2]).toHaveLength(600);
    expect(texts[2]!.endsWith('…')).toBe(true);
    expect(texts[3]).toBe('keep CHANGELOG format');
    expect(texts[4]).toHaveLength(600);
    expect(carriedSteers(p)).toBe(2);
  });

  it('clips the parent task at 200 chars in the framing and names an in-progress stop', () => {
    const p = parent({ task: 't'.repeat(300) }, { stopReason: null });
    expect(seedFramingText(p)).toBe(`Follow-up to run ${R1} (stopped: in progress) whose task was "${'t'.repeat(199)}…"; the task above is the human's next instruction`);
  });

  it('rewind: plan from planAfter, window up to the step, then the last 4', () => {
    const planAfter: PlanSnapshot = { done: [], remaining: ['only this'], unverified: [], harnessProblems: [{ kind: 'human', text: 'ignored', step: 0 }] };
    const p = parent({}, { window: [1, 2, 3, 4, 5, 6, 7].map((n) => windowEntry(n)) });
    const seed = buildSeed(p, { humanNotes: ['/rewind plan+window to step 5'], pinnedFiles: [], rewind: { step: 5, planAfter } });
    expect(seed.plan.remaining).toEqual(['only this']);
    expect(seed.plan.done).toEqual([]);
    expect(seed.plan.harnessProblems.map((h) => h.text)).toEqual([seedFramingText(p), '/rewind plan+window to step 5']);
    expect(seed.window.map((e) => e.step)).toEqual([2, 3, 4, 5]);
    // rewind without a planAfter falls back to the parent's plan
    const seed2 = buildSeed(p, { humanNotes: [], pinnedFiles: [], rewind: { step: 2, planAfter: null } });
    expect(seed2.plan.remaining).toEqual(['update docs', 'add tests']);
    expect(seed2.window.map((e) => e.step)).toEqual([1, 2]);
  });

  it('caps the notes of a carried window entry at 12 (the `from run` note included)', () => {
    const noisy = { ...windowEntry(9), notes: Array.from({ length: 20 }, (_, i) => `n${i}`) };
    const seed = buildSeed(parent({}, { window: [noisy] }), { humanNotes: [], pinnedFiles: [] });
    expect(seed.window[0]!.notes).toHaveLength(SEED_MAX_NOTES);
    expect(seed.window[0]!.notes.includes(`from run ${R1}`)).toBe(false);
    const short = { ...windowEntry(9), notes: Array.from({ length: 11 }, (_, i) => `n${i}`) };
    expect(buildSeed(parent({}, { window: [short] }), { humanNotes: [], pinnedFiles: [] }).window[0]!.notes.at(-1)).toBe(`from run ${R1}`);
  });

  it('a step-0 parent without a checkpoint contributes nothing but is still the parentRunId', () => {
    const p: SeedParent = { meta: makeMeta({ runId: R2, task: 'rerun the suite' }), state: null };
    const seed = buildSeed(p, { humanNotes: [], pinnedFiles: ['src/x.py'] });
    expect(seed).toEqual({
      parentRunId: R2,
      plan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [{ kind: 'human', step: 0, text: `Follow-up to run ${R2} (stopped: in progress) whose task was "rerun the suite"; the task above is the human's next instruction` }] },
      window: [],
      createdThisRun: [],
      lastTestRun: null,
      undoLog: [],
      pinnedFiles: ['src/x.py'],
    });
    expect(carriedSteers(p)).toBe(0);
  });
});

describe('seedSource (sessions graft rule)', () => {
  const at = (n: number): string => `2026-09-20T14:0${n}:00.000Z`;
  it('the most recent run with step > 0 wins over a newer step-0 run', () => {
    const r6: SeedParent = { meta: makeMeta({ runId: R1, createdAt: at(1) }), state: makeState({ runId: R1, step: 13 }) };
    const r7: SeedParent = { meta: makeMeta({ runId: R2, createdAt: at(2) }), state: makeState({ runId: R2, step: 0, stopReason: 'error' }) };
    expect(seedSource([r6, r7])).toBe(r6);
    expect(seedSource([r7, r6])).toBe(r6);
  });
  it('the most recent run when every run stopped at step 0 (or has no state); null for none', () => {
    const a: SeedParent = { meta: makeMeta({ runId: R1, createdAt: at(1) }), state: makeState({ runId: R1, step: 0, updatedAt: at(1) }) };
    const b: SeedParent = { meta: makeMeta({ runId: R2, createdAt: at(2) }), state: null };
    expect(seedSource([a, b])).toBe(b);
    expect(seedSource([b, a])).toBe(b);
    expect(seedSource([])).toBeNull();
  });
  it('recency is the last activity; equal timestamps fall back to array order (later wins)', () => {
    const a: SeedParent = { meta: makeMeta({ runId: R1, createdAt: at(1) }), state: makeState({ runId: R1, step: 3, updatedAt: at(1) }) };
    const b: SeedParent = { meta: makeMeta({ runId: R2, createdAt: at(1) }), state: makeState({ runId: R2, step: 5, updatedAt: at(1) }) };
    const c: SeedParent = { meta: makeMeta({ runId: R3, createdAt: at(3) }), state: makeState({ runId: R3, step: 2, updatedAt: at(3) }) };
    expect(seedSource([a, b])).toBe(b);
    expect(seedSource([b, a])).toBe(a);
    expect(seedSource([a, b, c])).toBe(c);
  });
  it('an older run that was resumed and finished last is the most recent one (recency = last activity, like the picker\'s "by updated")', () => {
    const older: SeedParent = {
      meta: makeMeta({ runId: R1, createdAt: at(1), resumes: [{ resumedAt: at(6), previousStopReason: 'human_pause' }] }),
      state: makeState({ runId: R1, step: 9, stopReason: 'complete', updatedAt: at(8) }),
    };
    const newer: SeedParent = { meta: makeMeta({ runId: R2, createdAt: at(3) }), state: makeState({ runId: R2, step: 4, stopReason: 'complete', updatedAt: at(4) }) };
    expect(seedSource([older, newer])).toBe(older);
    expect(seedSource([newer, older])).toBe(older);
    expect(lastActivityMs(older)).toBe(Date.parse(at(8)));
    expect(lastActivityMs(newer)).toBe(Date.parse(at(4)));
    // a resume stamp alone (no checkpoint yet) counts; unparsable stamps are ignored; nothing parseable → -Infinity
    const resumedNoState: SeedParent = { meta: makeMeta({ runId: R3, createdAt: at(2), resumes: [{ resumedAt: at(9), previousStopReason: null }] }), state: null };
    expect(lastActivityMs(resumedNoState)).toBe(Date.parse(at(9)));
    expect(seedSource([older, resumedNoState])).toBe(older); // step > 0 wins over a newer step-0 run
    expect(lastActivityMs({ meta: makeMeta({ runId: R3, createdAt: 'junk', resumes: [{ resumedAt: 'junk', previousStopReason: null }] }), state: null })).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('seedNoticeText (§24)', () => {
  it('renders the seeded line with counts and the optional carried-steer suffix', () => {
    const seed = buildSeed(parent(), { humanNotes: [], pinnedFiles: [] });
    seed.plan.done = [1, 2, 3, 4].map((n) => ({ text: `d${n}`, evidence: { step: n, judged: 1 } }));
    seed.plan.remaining = ['a', 'b'];
    seed.plan.unverified = [{ text: 'u', step: 1, judged: 0.5 }];
    seed.createdThisRun = ['a', 'b', 'c'];
    expect(seedNoticeText(seed, 0)).toBe(`seeded from run ${R1}: plan done=4 remaining=2 unverified=1 · window 4 entries · 3 created files`);
    expect(seedNoticeText(seed, 1)).toBe(`seeded from run ${R1}: plan done=4 remaining=2 unverified=1 · window 4 entries · 3 created files · 1 pending steer carried`);
    // N = 1 renders the §24 template verbatim (no pluralisation), so every twin agrees
    seed.window = seed.window.slice(0, 1);
    seed.createdThisRun = ['a'];
    expect(seedNoticeText(seed, 2)).toBe(`seeded from run ${R1}: plan done=4 remaining=2 unverified=1 · window 1 entries · 1 created files · 2 pending steer carried`);
    seed.window = [];
    seed.createdThisRun = [];
    expect(seedNoticeText(seed, 0)).toBe(`seeded from run ${R1}: plan done=4 remaining=2 unverified=1 · window 0 entries · 0 created files`);
    expect(seedNoticeText(seed, Number.NaN)).toBe(seedNoticeText(seed, 0));
    expect(seedNoticeText(seed, -1)).toBe(seedNoticeText(seed, 0));
  });
});
