/**
 * F26, the engine's half — `CheckpointState.kept` finally has a writer (docs/COORDINATION-DESIGN.md §8.6).
 *
 * The extractor is pinned in `context-kept-extract.test.ts`; what is pinned here is the wiring:
 *   - a compaction writes `CheckpointState.kept` on the checkpoint that follows it, and nothing writes it before
 *     the first compaction (so a run that never compacts keeps HEAD's `state.json`);
 *   - a resume round-trips it, and the human `/keep` items inside it survive as human items;
 *   - under `context.kept: 'jev'` the ranking pass is asked EXACTLY ONCE per compaction, with those candidates;
 *   - under the default `'code'` nothing is asked at all — the compactor stays free and deterministic.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckpointState } from '../../../src/core/types.js';
import type { DeciderCall } from './fakes.js';
import type { Harness } from './fakes.js';
import { createFakeSandbox, execResult, failingTests, makeEngine, noulA, turn } from './fakes.js';
import { KEPT_CHOICE_ID, KEPT_MAX } from '../../../src/loop/context/compaction.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

type KeptRow = NonNullable<CheckpointState['kept']>[number];

function keptOf(state: CheckpointState | undefined): KeptRow[] {
  return state?.kept ?? [];
}

/** `steps` steps that each run a failing suite, with a compaction every `compactEvery` steps. */
async function run(steps: number, over: Parameters<typeof makeEngine>[0] = {}, compactEvery = 2): Promise<Harness> {
  let i = 0;
  const h = await makeEngine({
    turns: () => turn({ kind: 'run', command: `pytest -q # ${'abcdefghij'[i++ % 10]}` }, { remaining: ['make tests/test_a.py::test_f pass'], openProblems: ['the fixture writes into /tmp'] }),
    sandbox: createFakeSandbox(() => execResult({ exitCode: failingTests.exitCode, stdout: failingTests.stdout })),
    limits: { maxSteps: steps },
    ...over,
    engine: { contextPolicy: { compactEvery }, ...over.engine },
  });
  harnesses.push(h);
  return h;
}

describe('F26 — CheckpointState.kept is written at a compaction and restored on resume', () => {
  it('no compaction, no `kept`: a short run writes exactly the state.json it wrote before', async () => {
    const h = await run(1, {}, 0);
    await h.engine.run();
    expect(h.store.states.every((s) => s.kept === undefined)).toBe(true);
  });

  it('a compaction writes the extracted candidates onto the next checkpoint', async () => {
    const h = await run(4);
    const r = await h.engine.run();
    expect(r.steps).toBe(4);
    const kept = keptOf(h.store.last());
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThanOrEqual(KEPT_MAX);
    // the failing suite of the last run is carried, as a fact, at the step that produced it
    expect(kept.some((k) => k.kind === 'fact' && /pytest -q .* at step \d+: 1 passed, 1 failed, 0 errors/.test(k.text))).toBe(true);
    // the generator's open problem is carried too
    expect(kept.some((k) => k.text === 'open problem: the fixture writes into /tmp')).toBe(true);
    // and it survives the JSON round trip state.json really is
    expect((JSON.parse(JSON.stringify(h.store.last())) as CheckpointState).kept).toEqual(kept);
  });

  it('a resume round-trips `kept`, and a human `/keep` item inside it stays human and stays first', async () => {
    const first = await run(4);
    await first.engine.run();
    const before = keptOf(first.store.last());
    expect(before.length).toBeGreaterThan(0);

    // the human item a surface would have added, riding the checkpoint exactly as everything else does
    const human: KeptRow = { kind: 'fact', text: 'the acceptance criterion is the ladder suite', step: 1, by: 'human' };
    const seeded: CheckpointState = { ...first.store.last()!, kept: [human, ...before], stopReason: null };
    const store = first.store;
    store.seed(store.meta!, seeded);

    const second = await makeEngine({
      turns: [turn({ kind: 'done', summary: 'green' })],
      sandbox: createFakeSandbox(() => execResult({ exitCode: failingTests.exitCode, stdout: failingTests.stdout })),
      store,
      runsDir: first.runsDir,
      resume: { runId: first.engine.runId, force: false },
      limits: { maxSteps: 6 },
      engine: { contextPolicy: { compactEvery: 2 } },
    });
    harnesses.push(second);
    await second.engine.run();
    const after = keptOf(second.store.last());
    // the human's own words lead, unranked and unchanged
    expect(after[0]).toEqual(human);
    expect(after.filter((k) => k.by === 'human')).toEqual([human]);
  });
});

describe('F26 — the `context.kept` switch finally has something to rank', () => {
  it("the default 'code' asks nothing: no `most_needed` request anywhere in the run", async () => {
    const h = await run(4);
    await h.engine.run();
    expect(h.decider.calls.some((c) => KEPT_CHOICE_ID in c.questions)).toBe(false);
  });

  it("'jev': the ranking pass is asked exactly once per compaction, with the extracted candidates", async () => {
    const h = await run(7, {
      deciderOptions: {
        rules: [
          (c: DeciderCall) => {
            if (!(KEPT_CHOICE_ID in c.questions)) return undefined;
            const out: Record<string, ReturnType<typeof noulA>> = {};
            for (const id of Object.keys(c.questions)) if (id !== KEPT_CHOICE_ID) out[id] = noulA(0.9);
            return out;
          },
        ],
      },
      engine: { contextPolicy: { compactEvery: 2, kept: 'jev' } },
    });
    await h.engine.run();
    const asks = h.decider.calls.filter((c) => KEPT_CHOICE_ID in c.questions);
    // compactions at the commits of steps 4 and 6 (a fold needs something foldable past the newest two); each is
    // paid ONCE, at the next prompt build
    expect(h.of('context:compacted')).toHaveLength(2);
    expect(asks).toHaveLength(2);
    // the pass is owed by the COMPACTION, not by the step: seven steps, two requests
    expect(asks.map((c) => c.step)).toEqual([5, 7]);
    const last = asks.at(-1)!;
    const state = last.state as { candidates?: Record<string, { kind: string; text: string }> };
    const candidates = Object.values(state.candidates ?? {});
    expect(candidates.length).toBeGreaterThan(0);
    // the request carries the extractor's own candidates — the same texts that reach `CheckpointState.kept`
    const kept = keptOf(h.store.last()).map((k) => k.text);
    for (const c of candidates) expect(kept).toContain(c.text);
    // the keys are content-derived, never positional (REPORT §10)
    for (const key of Object.keys(state.candidates ?? {})) expect(key).toMatch(/^(?:fact|file)_[0-9a-f]{6,}$/);
    // §8.6: the state is plan + candidates and NEVER the transcript
    expect(JSON.stringify(last.state)).not.toContain('1 failed, 1 passed in 0.10s');
  });
});
