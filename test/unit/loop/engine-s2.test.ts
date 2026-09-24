/**
 * F25 — S2 on the `jev-on` propose path (contract 1.9 "Fastlane" §3.1–§3.4, docs/LLM-LOOP-DESIGN.md §3).
 *
 * All four S2 mechanisms lived in `src/jev-modes/synth/llm/source.ts`, which `jev-on` never enters: `PromptInput.prefixOrder`
 * was never set, `onFirstByte` was forwarded only on the synthesizer's sample path, and the hedge and the
 * provider-order rotation were the round's. So the `jev-on-next` arm's `mechanisms.s2: true` was false in fact
 * and the §8.3 S2 row (TTFB p50/p90, hedges, cache) was structurally empty for every jev-on arm.
 *
 * The switch is `JEVCODE_S2=on`, `jev-on` only, default OFF — §0.3's rule for a new mechanism, and what keeps
 * `router-golden.test.ts` and every `view: 'legacy'` prompt golden valid without a re-capture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateOptions, GenerateRequest, GenerateResult } from '../../../src/core/types.js';
import type { FakeProvider, Harness } from './fakes.js';
import { createFakeSandbox, createFakeWorkspace, execResult, makeEngine, repoState, turn } from './fakes.js';
import { HEDGE_TWIN_OFFSET, S2_ENV_FLAG, hedgeAfterMs, hedgeOriginOf, s2Mode } from '../../../src/jev-modes/synth/llm/hedge.js';
import { summariseStepRows } from '../../../src/bench/step-records.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  delete process.env[S2_ENV_FLAG];
  delete process.env['JEVCODE_HEDGE'];
});

async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

const PROPOSAL = (action: Parameters<typeof turn>[0]): GenerateResult['toolCalls'][number] => {
  const input = { goal: 'go', action, plan: { done: [], remaining: ['keep going'], openProblems: [] } };
  return { name: 'propose_action', input: input as never, rawJson: JSON.stringify(input) };
};

/** A provider that reports a first byte after `ttfbMs` of its own (no real wait) and answers at once. */
function ttfbProvider(ttfbMs: number): FakeProvider & { firstByteCalls: number } {
  const requests: GenerateRequest[] = [];
  let i = 0;
  const p: FakeProvider & { firstByteCalls: number } = {
    name: 'mock',
    model: 'z-ai/glm-5.3-flash',
    requests,
    firstByteCalls: 0,
    async generate(req: GenerateRequest, o: GenerateOptions): Promise<GenerateResult> {
      requests.push(req);
      if (o.onFirstByte !== undefined) {
        p.firstByteCalls += 1;
        o.onFirstByte(ttfbMs);
      }
      const action = i++ === 0 ? ({ kind: 'run', command: 'pytest -q' } as const) : ({ kind: 'done', summary: 'green' } as const);
      return { text: '', toolCalls: [PROPOSAL(action)], usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.004, calls: 1, cacheReadTokens: 640, cacheWriteTokens: 120 }, model: 'z-ai/glm-5.3-flash', stopReason: 'tool_use', latencyMs: 12 };
    },
  };
  return p;
}

/** The recorded shape the hedge exists for: an origin silent from the first byte to the deadline, a twin that answers at once. */
function silentOriginProvider(): FakeProvider {
  const requests: GenerateRequest[] = [];
  return {
    name: 'mock',
    model: 'z-ai/glm-5.3-flash',
    requests,
    async generate(req: GenerateRequest, o: GenerateOptions): Promise<GenerateResult> {
      requests.push(req);
      if (o.sample === undefined) {
        await new Promise<never>((_, reject) => {
          o.signal.addEventListener('abort', () => reject(o.signal.reason as Error));
        });
      }
      return { text: '', toolCalls: [PROPOSAL({ kind: 'done', summary: 'the twin answered' })], usage: { inputTokens: 900, outputTokens: 100, costUsd: 0.003, calls: 1 }, model: 'z-ai/glm-5.3-flash', stopReason: 'tool_use', latencyMs: 5 };
    },
  };
}

describe('F25 §3 — the switch', () => {
  it("is `jev-on` only, default off, and `JEVCODE_HEDGE=off` makes it 'partial'", () => {
    expect(s2Mode('jev-on', undefined, {})).toBe('off');
    expect(s2Mode('jev-on', undefined, { [S2_ENV_FLAG]: 'on' })).toBe('on');
    expect(s2Mode('jev-on', undefined, { [S2_ENV_FLAG]: 'ON ' })).toBe('on');
    expect(s2Mode('jev-on', undefined, { [S2_ENV_FLAG]: 'on', JEVCODE_HEDGE: 'off' })).toBe('partial');
    expect(s2Mode('jev-on', 'on', { JEVCODE_HEDGE: 'off' })).toBe('partial');
    for (const mode of ['llm-jev', 'jev-only', 'jev-off'] as const) expect(s2Mode(mode, undefined, { [S2_ENV_FLAG]: 'on' })).toBe('off');
  });

  it("EngineStatus.mechanisms reports what actually ran: 'on' under jev-on with the switch", async () => {
    process.env[S2_ENV_FLAG] = 'on';
    const on = await build({ mode: 'jev-on', turns: [turn({ kind: 'done', summary: 'x' })], limits: { maxSteps: 1 } });
    expect(on.engine.status().mechanisms).toEqual({ s2: 'on', routers: 'off', fastPath: 'auto' });
    delete process.env[S2_ENV_FLAG];
    const off = await build({ mode: 'jev-on', turns: [turn({ kind: 'done', summary: 'x' })], limits: { maxSteps: 1 } });
    expect(off.engine.status().mechanisms).toEqual({ s2: 'off', routers: 'off', fastPath: 'auto' });
  });

  /**
   * Review defect A8: the member was written UNCONDITIONALLY, which contradicts its own type doc ("Absent on an
   * engine that does not resolve them") and adds a member to every `--json=verbose` status line in every mode.
   * The adjacent `coordination` spread exists in exactly that shape to keep the stream byte-identical on a run
   * without a ledger; `mechanisms` now follows it — absent when the engine resolved every mechanism OFF, which
   * is every control arm of the §8 head-to-head.
   */
  it('is ABSENT on an engine that resolved every mechanism off, so the control arms\' status line is byte-identical (A8)', async () => {
    for (const mode of ['llm-jev', 'jev-only'] as const) {
      const h = await build({
        mode,
        turns: [turn({ kind: 'done', summary: 'x' })],
        limits: { maxSteps: 1 },
        synthesizer: { name: 'none', async synthesize() { return { goal: 'g', action: { kind: 'done', summary: 'x' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' }; } },
      });
      expect(h.engine.status().mechanisms).toBeUndefined();
      expect('mechanisms' in h.engine.status()).toBe(false);
    }
    const off = await build({ mode: 'jev-off', turns: [turn({ kind: 'done', summary: 'x' })], limits: { maxSteps: 1 } });
    expect(off.engine.status().mechanisms).toBeUndefined();
  });

  /**
   * F25's recorded gap, and review defect A5's other half: the bench could not PIN S2 per arm because there was
   * no option to pin — `s2Mode` read `JEVCODE_S2` and nothing else. It now reads the option FIRST, exactly as
   * `routersEnabled` and `resolveFastPathOption` do after the §7.5 seam inverted them, so an exported switch can
   * neither arm a control arm nor disarm a treatment arm.
   */
  it("EngineOptions.s2 beats JEVCODE_S2 in both directions, and the env only fills an ABSENT option", async () => {
    expect(s2Mode('jev-on', 'on', {})).toBe('on');
    expect(s2Mode('jev-on', 'off', { [S2_ENV_FLAG]: 'on' })).toBe('off');
    expect(s2Mode('jev-on', undefined, { [S2_ENV_FLAG]: 'on' })).toBe('on');
    expect(s2Mode('jev-on', undefined, {})).toBe('off');
    // the `jev-on` gate is still first: no option turns a control arm's generation path into the treatment's
    for (const mode of ['llm-jev', 'jev-only', 'jev-off'] as const) expect(s2Mode(mode, 'on', { [S2_ENV_FLAG]: 'on' })).toBe('off');

    process.env[S2_ENV_FLAG] = 'on';
    const pinnedOff = await build({ mode: 'jev-on', turns: [turn({ kind: 'done', summary: 'x' })], limits: { maxSteps: 1 }, engine: { s2: 'off' } });
    expect(pinnedOff.engine.status().mechanisms).toEqual({ s2: 'off', routers: 'off', fastPath: 'auto' });
    delete process.env[S2_ENV_FLAG];
    const pinnedOn = await build({ mode: 'jev-on', turns: [turn({ kind: 'done', summary: 'x' })], limits: { maxSteps: 1 }, engine: { s2: 'on' } });
    expect(pinnedOn.engine.status().mechanisms).toEqual({ s2: 'on', routers: 'off', fastPath: 'auto' });
  });

  /**
   * F25's other recorded sub-part: `state` did not carry `mechanisms`, only `EngineStatus` did — so an archived
   * run directory could be checked against `summary.json` only while the process was alive. It rides
   * `state.json` under the same absent-when-all-off rule as the status line.
   */
  it('CheckpointState.mechanisms records the same resolution, and is absent when every mechanism is off', async () => {
    process.env[S2_ENV_FLAG] = 'on';
    const on = await build({ mode: 'jev-on', turns: [turn({ kind: 'done', summary: 'x' })], limits: { maxSteps: 1 }, probeGitState: repoState() });
    await on.engine.run();
    expect(on.store.last()!.mechanisms).toEqual({ s2: 'on', routers: 'off', fastPath: 'auto' });
    delete process.env[S2_ENV_FLAG];
    const off = await build({
      mode: 'llm-jev',
      turns: [turn({ kind: 'done', summary: 'x' })],
      limits: { maxSteps: 1 },
      probeGitState: repoState(),
      synthesizer: { name: 'none', async synthesize() { return { goal: 'g', action: { kind: 'done', summary: 'x' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' }; } },
    });
    await off.engine.run();
    expect(off.store.last()!.mechanisms).toBeUndefined();
  });
});

describe('F25 §3.3 — the byte-stable prefix on the jev-on propose call', () => {
  it('the head repeats verbatim across two steps whose changed-file lists differ', async () => {
    process.env[S2_ENV_FLAG] = 'on';
    const ws = createFakeWorkspace({ files: { 'src/a.py': 'def f():\n    return 1\n', 'src/b.py': 'x = 1\n' }, gitState: repoState() });
    const h = await build({
      mode: 'jev-on',
      turns: [turn({ kind: 'write', path: 'src/a.py', content: 'y = 1\n' }, { remaining: ['keep going'] }), turn({ kind: 'write', path: 'src/b.py', content: 'z = 2\n' }, { remaining: ['keep going'] })],
      workspace: ws,
      probeGitState: repoState(),
      limits: { maxSteps: 2 },
    });
    await h.engine.run();
    const [one, two] = h.provider.requests.map((r) => r.messages[0]!.content);
    expect(one).toBeDefined();
    expect(two).toBeDefined();
    // §3.3: the message opens with the task, not with `# Step N` — the head is what repeats
    expect(one!.startsWith('## Task\n')).toBe(true);
    expect(two!.startsWith('## Task\n')).toBe(true);
    // and the two steps' heads are byte-identical although their changed-file lists are not
    const head = (t: string): string => t.slice(0, t.indexOf('# Step '));
    expect(head(two!)).toBe(head(one!));
    expect(head(one!).length).toBeGreaterThan(0);
    expect(two).toContain('src/b.py');
  });

  it('with the switch off the jev-on prompt is HEAD\'s: `# Step 1` first, no pinned head (I2)', async () => {
    const h = await build({ mode: 'jev-on', turns: [turn({ kind: 'done', summary: 'x' })], limits: { maxSteps: 1 }, probeGitState: repoState() });
    await h.engine.run();
    expect(h.provider.requests[0]!.messages[0]!.content.startsWith('# Step 1')).toBe(true);
  });
});

describe('F25 §3.1 / §3.4 — TTFB and the cache shares reach the record and the bench', () => {
  it('a jev-on step with a TTFB reading writes StepRecord.verify, and StepsSummary.s2.ttfbMs reads it back', async () => {
    process.env[S2_ENV_FLAG] = 'on';
    const provider = ttfbProvider(275);
    const h = await build({ mode: 'jev-on', provider, sandbox: createFakeSandbox(() => execResult({ exitCode: 0, stdout: '2 passed in 0.1s\n' })), limits: { maxSteps: 2 }, probeGitState: repoState() });
    await h.engine.run();
    expect(provider.firstByteCalls).toBeGreaterThan(0);
    const first = h.store.steps[0]!;
    expect(first.verify?.ttfbMs).toEqual([275]);
    expect(first.verify?.cacheRead).toBe(640);
    expect(first.verify?.cacheWrite).toBe(120);
    // §8.3 S2 row: the bench summariser folds it off `steps.jsonl` with no further wiring
    const rows = h.store.steps.map((s) => JSON.stringify(s)).join('\n');
    const summary = summariseStepRows(rows);
    expect(summary.s2.ttfbMs).toEqual([275, 275]);
    expect(summary.s2.cacheRead).toBe(1_280);
    expect(summary.s2.cacheWrite).toBe(240);
  });

  it('with the switch off no jev-on step writes a verify block at all (I2)', async () => {
    const provider = ttfbProvider(275);
    const h = await build({ mode: 'jev-on', provider, sandbox: createFakeSandbox(() => execResult({ exitCode: 0, stdout: '2 passed in 0.1s\n' })), limits: { maxSteps: 2 }, probeGitState: repoState() });
    await h.engine.run();
    expect(provider.firstByteCalls).toBe(0);
    expect(h.store.steps.every((s) => s.verify === undefined)).toBe(true);
  });
});

describe('F25 §3.2 — the hedge on the jev-on propose call', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a silent origin is hedged, the twin wins, the loser is cancelled and the counters reach the record', async () => {
    process.env[S2_ENV_FLAG] = 'on';
    const requests: GenerateRequest[] = [];
    const samples: (number | undefined)[] = [];
    let aborted = 0;
    const provider: FakeProvider = {
      name: 'mock',
      model: 'z-ai/glm-5.3-flash',
      requests,
      async generate(req: GenerateRequest, o: GenerateOptions): Promise<GenerateResult> {
        requests.push(req);
        samples.push(o.sample);
        // the ORIGIN never produces a first byte and never answers; the TWIN answers at once
        if (o.sample === undefined) {
          await new Promise<never>((_, reject) => {
            o.signal.addEventListener('abort', () => {
              aborted += 1;
              reject(o.signal.reason as Error);
            });
          });
        }
        return { text: '', toolCalls: [PROPOSAL({ kind: 'done', summary: 'the twin answered' })], usage: { inputTokens: 900, outputTokens: 100, costUsd: 0.003, calls: 1 }, model: 'z-ai/glm-5.3-flash', stopReason: 'tool_use', latencyMs: 5 };
      },
    };
    const h = await build({ mode: 'jev-on', provider, limits: { maxSteps: 1 }, probeGitState: repoState() });
    const running = h.engine.run();
    await vi.advanceTimersByTimeAsync(hedgeAfterMs(null) + 50);
    await vi.advanceTimersByTimeAsync(50);
    const r = await running;
    expect(r.steps).toBe(1);
    // the twin was sent under the twin's sample index, which is what `hedgeOriginOf` reads back
    expect(samples).toEqual([undefined, HEDGE_TWIN_OFFSET]);
    expect(aborted).toBe(1);
    const rec = h.store.steps[0]!;
    expect(rec.verify?.hedges).toBe(1);
    expect(rec.verify?.hedgeWins).toBe(1);
    // "a hedge makes a step faster, never free": the cancelled origin is booked, with its own generator.jsonl row
    const cancelled = h.store.generator.filter((g) => g.cancelled === true);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.stopReason).toBe('cancelled');
  });

  /**
   * Review defect **A2**. Only the WINNER's provider-reported latency reached `draft.timing.generatorMs`, so on a
   * twin-win step the whole hedge wait (`hedgeAfterMs`, 3–8 s) fell out of every named bucket and the residual
   * formula charged all of it to `harnessMs` — the harness-overhead metric the 50 ms p95 budget is measured
   * against. The race's WALL is the step's generator time, exactly as `noteSampleEnd` takes the batch wall for a
   * round; the loser's own `latencyMs` is booked on its own cancelled row and adds nothing here.
   */
  it('books the RACE wall as generatorMs, so a twin win does not leak hedgeAfterMs into harnessMs (A2)', async () => {
    process.env[S2_ENV_FLAG] = 'on';
    const h = await build({ mode: 'jev-on', provider: silentOriginProvider(), limits: { maxSteps: 1 }, probeGitState: repoState(), now: () => Date.now() });
    const running = h.engine.run();
    await vi.advanceTimersByTimeAsync(hedgeAfterMs(null) + 50);
    await vi.advanceTimersByTimeAsync(50);
    await running;
    const t = h.store.steps[0]!.timing;
    // the twin answered with `latencyMs: 5`; the race itself held the step for the whole hedge threshold
    expect(t.generatorMs).toBeGreaterThanOrEqual(hedgeAfterMs(null));
    expect(t.harnessMs).toBeLessThan(hedgeAfterMs(null));
    expect(t.generatorMs).toBeLessThanOrEqual(t.totalMs);
  });

  /**
   * Review defect **A3**. The success row's spread never consulted `leg.sample`, so a WINNING twin's
   * `generator.jsonl` row carried no `sample` member at all — `hedgeOriginOf` could not read it back — while the
   * LOSER (always written with one) was the only row `pushGeneratorRecord` counted. A jev-on step that succeeded
   * therefore reported `samples: 1, cancelled: 1`: one sample, all of it cancelled. And because
   * `src/bench/step-records.ts` sums those counters off any row with a `verify` object, a jev-on-next arm with S2
   * on reported a 100 % cancellation rate on an arm that has no synthesizer at all.
   */
  it('the WINNING twin\'s row carries its leg index, and one-shot legs are not counted as synthesizer samples (A3)', async () => {
    process.env[S2_ENV_FLAG] = 'on';
    const h = await build({ mode: 'jev-on', provider: silentOriginProvider(), limits: { maxSteps: 1 }, probeGitState: repoState() });
    const running = h.engine.run();
    await vi.advanceTimersByTimeAsync(hedgeAfterMs(null) + 50);
    await vi.advanceTimersByTimeAsync(50);
    await running;
    const rows = h.store.generator;
    const winner = rows.filter((g) => g.cancelled !== true);
    expect(winner).toHaveLength(1);
    expect(winner[0]!.sample).toBe(HEDGE_TWIN_OFFSET);
    expect(hedgeOriginOf(winner[0]!.sample!)).toBe(0);
    expect(winner[0]!.purpose).toBe('propose_fix');
    // both legs are still booked (a hedge is faster, never free) — the loser keeps its own cancelled row
    expect(rows.filter((g) => g.cancelled === true)).toHaveLength(1);
    // but NEITHER leg is a synthesizer sample, so the two verification counters stay 0 on a step that succeeded
    const rec = h.store.steps[0]!;
    expect(rec.verify?.samples).toBe(0);
    expect(rec.verify?.cancelled).toBe(0);
    expect(rec.verify?.hedges).toBe(1);
    // ...and the bench row says the same: no synthesizer, no samples, no 100 % cancellation rate
    const summary = summariseStepRows(h.store.steps.map((x) => JSON.stringify(x)).join('\n'));
    expect(summary.verify.samples).toBe(0);
    expect(summary.verify.cancelled).toBe(0);
    expect(summary.s2.hedges).toBe(1);
    expect(summary.s2.hedgeWins).toBe(1);
  });

  it('an origin that produces a first byte is never hedged', async () => {
    process.env[S2_ENV_FLAG] = 'on';
    const provider = ttfbProvider(120);
    const h = await build({ mode: 'jev-on', provider, limits: { maxSteps: 1 }, probeGitState: repoState() });
    const running = h.engine.run();
    await vi.advanceTimersByTimeAsync(hedgeAfterMs(null) * 2);
    await running;
    expect(provider.requests).toHaveLength(1);
    expect(h.store.steps[0]!.verify?.hedges).toBeUndefined();
  });
});
