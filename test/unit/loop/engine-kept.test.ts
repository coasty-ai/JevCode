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

/**
 * Review defect **A4**. `this.kept` was REBUILT from scratch at every compaction out of the 12-entry history
 * window (`HISTORY_STEPS`, `src/core/limits.ts`), so a fact left `CheckpointState.kept` at exactly the moment it
 * left the prompt — `kept` held nothing the prompt did not already carry, which is the one thing §8.6's "do not
 * re-derive" exists to do. The probe below is the review's, verbatim: 18 steps, `compactEvery: 2`, a loop trip at
 * step 4 whose `[replan, step 4]` line is on checkpoint 3 and gone by checkpoint 7, replaced by the step-16 copy.
 */
describe('F26 / A4 — `kept` ACCUMULATES: a fact survives its own step leaving the window', () => {
  const REPLAN_4 = /^\[replan, step 4\] /;

  /** 18 steps repeating one failing command: the loop detector trips, so each trip writes a `[replan, step N]` problem. */
  async function longRun(): Promise<Harness> {
    const h = await makeEngine({
      turns: () => turn({ kind: 'run', command: 'pytest -q' }, { remaining: ['make tests/test_a.py::test_f pass'], openProblems: ['the fixture writes into /tmp'] }),
      sandbox: createFakeSandbox(() => execResult({ exitCode: failingTests.exitCode, stdout: failingTests.stdout })),
      limits: { maxSteps: 18 },
      engine: { contextPolicy: { compactEvery: 2 } },
    });
    harnesses.push(h);
    return h;
  }

  it('the step-4 replan line is still kept at step 18, after eight more compactions rebuilt the list', async () => {
    const h = await longRun();
    await h.engine.run();
    const atFirst = keptOf(h.store.states[3]).filter((k) => REPLAN_4.test(k.text));
    // the review's input: the fact IS derived at the first compaction that sees it
    expect(atFirst).toHaveLength(1);
    const atLast = keptOf(h.store.last());
    expect(atLast.filter((k) => REPLAN_4.test(k.text))).toEqual(atFirst);
    // and so is the failing-suite fact of the step that produced it, which the newer copies never overwrote
    expect(atLast.some((k) => k.text === 'pytest -q at step 4: 1 passed, 1 failed, 0 errors')).toBe(true);
    expect(atLast.some((k) => k.text === 'pytest -q at step 18: 1 passed, 1 failed, 0 errors')).toBe(true);
  });

  it('accumulation is BOUNDED and ordered by recency: never past KEPT_MAX, newest step first', async () => {
    const h = await longRun();
    await h.engine.run();
    for (const st of h.store.states) expect(keptOf(st).length).toBeLessThanOrEqual(KEPT_MAX);
    const last = keptOf(h.store.last());
    expect(last.length).toBeGreaterThan(3);
    const steps = last.map((k) => k.step);
    expect([...steps].sort((a, b) => b - a)).toEqual(steps);
  });

  it('a fact re-derived at a newer step REFRESHES rather than duplicating it', async () => {
    const h = await longRun();
    await h.engine.run();
    const last = keptOf(h.store.last());
    const texts = last.map((k) => `${k.kind}\u0000${k.text}`);
    expect(new Set(texts).size).toBe(texts.length);
    // `open problem: …` is re-derived at every compaction and stays ONE item
    expect(last.filter((k) => k.text === 'open problem: the fixture writes into /tmp')).toHaveLength(1);
  });
});

/**
 * F26's last recorded sub-part: **nothing filled `PromptContextView.kept`**, so `## Kept (do not re-derive)`
 * (`keptSection`, `src/provider/prompts.ts`) rendered for nobody and the whole mechanism — extractor, ranking
 * switch, checkpoint member — was inert end to end. It costs no golden: the section is part of the RELAXED view
 * only (`Engine.contextEnabled`), and it elides while the list is empty, so every `view: 'legacy'` prompt and
 * every relaxed prompt before the run's first compaction is byte-identical to what it was.
 */
describe('F26 — the section finally has a writer: `## Kept (do not re-derive)` in the relaxed prompt', () => {
  async function relaxed(steps: number): Promise<Harness> {
    const h = await makeEngine({
      turns: () => turn({ kind: 'run', command: 'pytest -q' }, { remaining: ['make tests/test_a.py::test_f pass'], openProblems: ['the fixture writes into /tmp'] }),
      sandbox: createFakeSandbox(() => execResult({ exitCode: failingTests.exitCode, stdout: failingTests.stdout })),
      limits: { maxSteps: steps },
      engine: { contextPolicy: { view: 'relaxed', compactEvery: 2 } },
    });
    harnesses.push(h);
    return h;
  }

  it('renders the extracted items once a compaction has produced some, and not before', async () => {
    const h = await relaxed(6);
    await h.engine.run();
    const prompts = h.provider.requests.map((r) => r.messages[0]!.content);
    expect(prompts.length).toBeGreaterThanOrEqual(5);
    // nothing has been extracted yet, so the section elides exactly as it did before this change
    expect(prompts[0]).not.toContain('## Kept (do not re-derive)');
    const last = prompts.at(-1)!;
    expect(last).toContain('## Kept (do not re-derive)');
    // the lines are the extractor's own items, in its order, with kind / step / provenance
    expect(last).toMatch(/\n- \[fact, step \d+, code\] pytest -q at step \d+: 1 passed, 1 failed, 0 errors/);
    expect(last).toContain('open problem: the fixture writes into /tmp');
    // ...and they are items the checkpoint persisted: the prompt of step N is built from the extraction of the
    // compaction at step N-1, so the state written two steps back is the one it must agree with
    const persisted = keptOf(h.store.states.at(-3));
    expect(persisted.length).toBeGreaterThan(0);
    for (const k of persisted) expect(last).toContain(k.text);
  });

  it('a `view: \'legacy\'` run extracts nothing and renders no section at all (I2)', async () => {
    const legacy = await run(6, { engine: { contextPolicy: { view: 'legacy' } } });
    await legacy.engine.run();
    // the legacy view runs no compaction, so there is nothing to persist and nothing to render — the pin the
    // frozen bench arms rest on (`buildEngineOptions` sets `view: 'legacy'` for every one of them)
    expect(keptOf(legacy.store.last())).toEqual([]);
    for (const r of legacy.provider.requests) expect(r.messages[0]!.content).not.toContain('## Kept (do not re-derive)');

    // and the relaxed run that DOES extract is the contrast: same turns, same steps, one section more
    const relaxedRun = await relaxed(6);
    await relaxedRun.engine.run();
    expect(keptOf(relaxedRun.store.last()).length).toBeGreaterThan(0);
    expect(relaxedRun.provider.requests.at(-1)!.messages[0]!.content).toContain('## Kept (do not re-derive)');
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
