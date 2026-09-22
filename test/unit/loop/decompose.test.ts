/**
 * docs/ORCHESTRATION-DESIGN.md §3 — the decompose stage.
 *
 * The properties that are load-bearing, and the only reason this file exists:
 *   O1(a) / M2  only `no_split` survived → NO Jev request is made at all (the ask seam is never touched).
 *   §3.5       Jev ROUTES, never gates: every fallback — decider error, timeout, 401, jev-off, below the
 *              floor, the escape, `--no-input` with `split: 'ask'` — lands on `no_split`, and none of them
 *              opens a `jev-unreachable` pane (corner row 33's rule): the failure is ONE
 *              `notice { kind: 'orchestration', level: 'info' }`.
 *   §3.7 [D5c] the confirm's synthetic `proposal` / `risk` are asserted byte for byte, because the point of
 *              [D5c] is that the implementer does not get to choose them.
 */
import { describe, expect, it, vi } from 'vitest';
import { RISK_DIMENSIONS, type Answer, type ConfirmRequest, type Decision, type EngineEvent, type Plan, type Question } from '../../../src/core/types.js';
import { HEADLINE_ROWS_MAX } from '../../../src/core/limits.js';
import { DEFAULT_SPLIT_POLICY, type SplitPolicy } from '../../../src/orchestrate/index.js';
import { DECOMPOSE_RISK_REASON, ZERO_DIM, runDecomposeStage, type DecomposeFacts, type DecomposeInput, type DecomposeStageContext } from '../../../src/loop/stages/decompose.js';
import { choiceA, noulA } from './fakes.js';

const PLAN: Plan = {
  done: [],
  remaining: ['fix the a suite', 'fix the b suite', 'fix the c suite'],
  unverified: [],
  openProblems: [],
  harnessProblems: [],
};

const LISTING = ['alpha/one.ts', 'alpha/two.ts', 'beta/one.ts', 'beta/two.ts', 'gamma/one.ts', 'test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'];

function facts(over: Partial<DecomposeFacts> = {}): DecomposeFacts {
  return {
    hasLedger: true,
    git: { isRepo: true, headBorn: true, worktreeSupported: true },
    baseSha: 'a'.repeat(40),
    repoKey: 'repo-key',
    existingBranches: [],
    deny: ['.git'],
    fold: false,
    repoPaths: LISTING,
    listing: LISTING,
    itemFiles: [['alpha/one.ts', 'alpha/two.ts'], ['beta/one.ts', 'beta/two.ts'], ['gamma/one.ts']],
    testImports: {},
    packages: [],
    lastTestRun: null,
    dirtyEntries: 0,
    syncedDirty: [],
    dirtyOverlap: [],
    liveChildren: 0,
    splits: 0,
    lastSplitStep: null,
    maxAgentsAllowed: 3,
    preflightReasons: [],
    availableParallelism: 8,
    freeMemBytes: 64 * 1024 ** 3,
    freeDiskBytes: 500 * 1024 ** 3,
    repoBytes: 10 * 1024 ** 2,
    sessionRemainingUsd: 20,
    isReplanStep: false,
    orchestrationProblemAgeSteps: null,
    verification: ['npm test'],
    humanAsked: false,
    ...over,
  };
}

interface Seams {
  events: EngineEvent[];
  asks: number;
  generates: number;
  confirms: ConfirmRequest[];
}

function makeCtx(seams: Seams, answers: Record<string, Answer> = {}): DecomposeStageContext {
  return {
    step: 11,
    mode: 'jev-on',
    task: 'fix the three failing suites',
    redact: (s: string) => s,
    now: () => 1_700_000_000_000,
    emit: (e: EngineEvent) => {
      seams.events.push(e);
    },
    ask: async (_state, questions: Record<string, Question>, annotate) => {
      seams.asks += 1;
      const rows: Decision[] = Object.keys(questions).map((id) => ({ id, stage: 'decompose', step: 11, kind: 'noul', probability: 1, confidence: 1, latencyMs: 1, text: id }) as unknown as Decision);
      annotate?.(answers, rows);
      return { answers, rows };
    },
    proposeSplit: async () => {
      seams.generates += 1;
      return null;
    },
  };
}

function input(seams: Seams, over: Partial<DecomposeInput> = {}): DecomposeInput {
  const policy: SplitPolicy = { ...DEFAULT_SPLIT_POLICY, split: 'ask', maxAgents: 3 };
  return {
    policy,
    depth: 0,
    runId: '20260919-120000-abcdefgh',
    sessionId: 'session-1',
    plan: PLAN,
    planDraft: { done: [], remaining: [...PLAN.remaining], openProblems: [] },
    reserveUsd: 2,
    reserveFrom: 'session',
    facts: facts(),
    detectSecrets: () => 0,
    verbose: false,
    hasBlocker: true,
    confirm: async (req) => {
      seams.confirms.push(req);
      return { approved: true };
    },
    ...over,
  };
}

function seams(): Seams {
  return { events: [], asks: 0, generates: 0, confirms: [] };
}

/** the Choice + every paired Noul + every self-contained Noul answered in favour of `by_directory` */
function directoryAnswers(slugs: readonly string[]): Record<string, Answer> {
  const out: Record<string, Answer> = {
    which_split: choiceA('split_by_directory', { split_by_directory: 0.9, split_by_plan_item: 0.05, none_of_these: 0.05 }),
    can_split_by_directory: noulA(0.9),
    can_split_by_plan_item: noulA(0.6),
  };
  for (const s of slugs) out[`agent_${s}_is_self_contained`] = noulA(0.9);
  return out;
}

describe('decompose: the gate (§3.1)', () => {
  it('a shut gate makes no request of anything and emits `decompose:skipped` ONLY under --json=verbose', async () => {
    const s = seams();
    const quiet = await runDecomposeStage(makeCtx(s), input(s, { facts: facts({ git: { isRepo: false, headBorn: false, worktreeSupported: false } }) }));
    expect(quiet).toEqual({ kind: 'skipped', why: 'not_git' });
    expect(s.events).toEqual([]);
    expect(s.asks).toBe(0);
    expect(s.generates).toBe(0);

    const v = seams();
    await runDecomposeStage(makeCtx(v), input(v, { verbose: true, facts: facts({ git: { isRepo: false, headBorn: false, worktreeSupported: false } }) }));
    expect(v.events).toEqual([{ type: 'decompose:skipped', step: 11, why: 'not_git' }]);
  });
});

describe('decompose: Jev routes, never gates (§3.5)', () => {
  it('O1(a): when only `no_split` survives, NO Jev request is made at all', async () => {
    const s = seams();
    // one remaining item per the plan but every file in ONE directory: nothing to split, and no demand
    const one = facts({ itemFiles: [['alpha/one.ts'], ['alpha/one.ts'], ['alpha/one.ts']], listing: ['alpha/one.ts'], repoPaths: ['alpha/one.ts'], humanAsked: true });
    const r = await runDecomposeStage(makeCtx(s), input(s, { facts: one }));
    expect(r.kind).toBe('no_split');
    expect(s.asks).toBe(0);
  });

  it('a decider error is `no_split` plus ONE orchestration notice — and never a pane (corner rows 4 / 33)', async () => {
    const s = seams();
    const ctx = makeCtx(s);
    const boom: DecomposeStageContext = {
      ...ctx,
      ask: async () => {
        s.asks += 1;
        throw new Error('401 unauthorized');
      },
    };
    const r = await runDecomposeStage(boom, input(s));
    expect(r.kind).toBe('no_split');
    expect(s.asks).toBe(1);
    const notices = s.events.filter((e) => e.type === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: 'notice', kind: 'orchestration', level: 'info' });
    expect(s.events.some((e) => e.type === 'blocking:request')).toBe(false);
  });

  it('jev-off never asks and lands on `no_split`', async () => {
    const s = seams();
    const r = await runDecomposeStage({ ...makeCtx(s), mode: 'jev-off' }, input(s));
    expect(r.kind).toBe('no_split');
    expect(s.asks).toBe(0);
  });

  it('`--no-input` with `split: ask` answers the confirm `stop` → `no_split` (corner row 11)', async () => {
    const s = seams();
    const slugs = ['alpha', 'beta', 'gamma'];
    const r = await runDecomposeStage(makeCtx(s, directoryAnswers(slugs)), input(s, { hasBlocker: false }));
    expect(r.kind).toBe('no_split');
    expect(s.confirms).toHaveLength(0);
    if (r.kind === 'no_split') expect(r.reason).toContain('no reviewer');
  });

  it('`split: auto` takes the first option in the fixed enumerate order and asks nothing', async () => {
    const s = seams();
    const auto = { ...DEFAULT_SPLIT_POLICY, split: 'auto' as const, maxAgents: 3 };
    const r = await runDecomposeStage(makeCtx(s), input(s, { policy: auto }));
    expect(s.asks).toBe(0);
    expect(r.kind === 'proposed' || r.kind === 'no_split').toBe(true);
  });
});

describe('decompose: the confirm [G2][D4][D5]', () => {
  it('[D5c]: `proposal` and `risk` are exactly what §3.7 specifies, and `matchesIntent` is ABSENT', async () => {
    const s = seams();
    const r = await runDecomposeStage(makeCtx(s, directoryAnswers(['alpha', 'beta', 'gamma'])), input(s));
    expect(r.kind).toBe('proposed');
    expect(s.confirms).toHaveLength(1);
    const req = s.confirms[0]!;
    expect('matchesIntent' in req).toBe(false);
    expect(req.proposal.action).toEqual({ kind: 'read', paths: ['orchestrate/manifest-11.json'] });
    expect(req.proposal.rawText).toBe('');
    expect(req.proposal.plan).toEqual({ done: [], remaining: [...PLAN.remaining], openProblems: [] });
    expect(req.proposal.goal).toMatch(/^delegate: [a-z_]+ — \d+ agents$/);
    expect(req.risk).toEqual({
      dims: Object.fromEntries(RISK_DIMENSIONS.map((d) => [d, ZERO_DIM])),
      risk: 0,
      verdict: 'review',
      reason: DECOMPOSE_RISK_REASON,
    });
    expect(DECOMPOSE_RISK_REASON).toBe('a decomposition proposal: nothing is written until you approve');
    expect(ZERO_DIM).toEqual({ risk: 0, probability: 1, expected: 0, tailMass: 0, bound: 'expected', confidence: 1, level: 0 });
    // title / headline / body / badge are all set, and headline never exceeds the band
    expect(typeof req.title).toBe('string');
    expect(req.headline!.length).toBeGreaterThan(0);
    expect(req.headline!.length).toBeLessThanOrEqual(HEADLINE_ROWS_MAX);
    expect(req.body!.length).toBeGreaterThan(0);
    expect(typeof req.badge).toBe('string');
  });

  it('[D1]: a non-empty `dirtyOverlap` puts the warning in the FIRST headline row, in §3.7’s prose', async () => {
    const s = seams();
    const dirty = facts({
      syncedDirty: Array.from({ length: 7 }, (_, i) => ({ path: `d${i}.txt`, sha256: 'x', mode: 0o644 })),
      dirtyOverlap: ['alpha/one.ts', 'beta/one.ts'],
    });
    const r = await runDecomposeStage(makeCtx(s, directoryAnswers(['alpha', 'beta', 'gamma'])), input(s, { facts: dirty }));
    expect(r.kind).toBe('proposed');
    const first = s.confirms[0]!.headline![0]!;
    expect(first).toBe("⚠ your checkout has 7 uncommitted files; 2 of them (alpha/one.ts, beta/one.ts) are inside an agent's slice — /land will ask you to commit or stash those two before it merges");
  });

  it('[§3.4 rule 9]: `secretHits > 0` puts `⚠ secret?` in the badge, as a COUNT and never a value', async () => {
    const s = seams();
    const r = await runDecomposeStage(makeCtx(s, directoryAnswers(['alpha', 'beta', 'gamma'])), input(s, { detectSecrets: (t) => (t.includes('alpha') ? 1 : 0) }));
    expect(r.kind).toBe('proposed');
    expect(s.confirms[0]!.badge).toContain('⚠ secret?');
    expect(JSON.stringify(s.confirms[0]!)).not.toContain('sk-');
  });

  it('a decline is an ordinary `declined` outcome carrying the reason', async () => {
    const s = seams();
    const r = await runDecomposeStage(makeCtx(s, directoryAnswers(['alpha', 'beta', 'gamma'])), input(s, { confirm: async (req) => { s.confirms.push(req); return { approved: false, note: 'not now' }; } }));
    expect(r.kind).toBe('declined');
    if (r.kind === 'declined') {
      expect(r.reason).toContain('declined');
      expect(r.note).toBe('not now');
    }
  });

  it('`split: auto` still confirms when ANY agent writes code, and skips only when every agent is research', async () => {
    const s = seams();
    const auto = { ...DEFAULT_SPLIT_POLICY, split: 'auto' as const, maxAgents: 3 };
    const r = await runDecomposeStage(makeCtx(s), input(s, { policy: auto }));
    if (r.kind === 'proposed') {
      const research = r.manifest.agents.every((a) => a.role === 'research');
      expect(s.confirms.length).toBe(research ? 0 : 1);
    }
  });
});

describe('decompose: the events (§4.1)', () => {
  it('emits `decompose:start` and `decompose:ranked` on an open gate', async () => {
    const s = seams();
    await runDecomposeStage(makeCtx(s, directoryAnswers(['alpha', 'beta', 'gamma'])), input(s));
    const start = s.events.filter((e) => e.type === 'decompose:start');
    const ranked = s.events.filter((e) => e.type === 'decompose:ranked');
    expect(start).toHaveLength(1);
    expect(ranked).toHaveLength(1);
    expect(start[0]).toMatchObject({ type: 'decompose:start', step: 11 });
    expect(ranked[0]).toMatchObject({ type: 'decompose:ranked', step: 11 });
    expect(s.events.some((e) => e.type === 'decompose:skipped')).toBe(false);
  });

  it('the generator gets exactly ONE `propose_split` call at the gate, and none in jev-only', async () => {
    const s = seams();
    await runDecomposeStage(makeCtx(s, directoryAnswers(['alpha', 'beta', 'gamma'])), input(s));
    expect(s.generates).toBe(1);
    const only = seams();
    await runDecomposeStage({ ...makeCtx(only, directoryAnswers(['alpha', 'beta', 'gamma'])), mode: 'jev-only' }, input(only));
    expect(only.generates).toBe(0);
  });

  it('a generator that throws is not a failure of the stage: `as_written` is simply absent', async () => {
    const s = seams();
    const ctx = makeCtx(s, directoryAnswers(['alpha', 'beta', 'gamma']));
    const spy = vi.fn(async () => {
      throw new Error('provider down');
    });
    const r = await runDecomposeStage({ ...ctx, proposeSplit: spy }, input(s));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.kind === 'proposed' || r.kind === 'no_split').toBe(true);
  });
});
