/**
 * docs/AGENT-LOOP-DESIGN.md §9.3 / §13.1 / §15 S4 items 7-9 — what the engine lends the driver:
 * - `generate()` with agent hooks still emits `generator:delta` (and hands each chunk to `onText`); `silent` suppresses it; a retried
 *   stream calls `onAttemptReset`; reasoning becomes throttled `generator:reasoning`; `generator:tool-delta` names the call being
 *   written; an agent turn's prompt hash covers its transcript;
 * - a quick ask (stage `loop`, one attempt) is never fatal: a drifting decider keeps the run going in one-shot and in session mode, and
 *   unpriced quick usage never stops the run; the absent decider means no ask at all;
 * - steers are handed over once, `/compact` is a request taken once, spilled outputs get `jevcode:` pointers, and the driver's meter
 *   rides `EngineStatus.context`.
 */
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AskOptions, ContextUsage } from '../../../src/core/types.js';
import { JevModelDriftError } from '../../../src/errors.js';
import { createAbsentDecider } from '../../../src/jev/absent.js';
import { AGENT_OUTPUT_PARTS_MAX_BYTES, createOutputPartLedger, writeOutputPart } from '../../../src/loop/stages/agent.js';
import type { AgentHarness, Harness } from './fakes.js';
import { FIXED_RUN_ID, createFakeDecider, makeAgentEngine, makeEngine, repoState, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function agent(...args: Parameters<typeof makeAgentEngine>): Promise<AgentHarness> {
  const h = await makeAgentEngine(...args);
  harnesses.push(h);
  return h;
}

describe('generate() with agent hooks (§9.3)', () => {
  it('generator:delta is the raw chunk stream exactly as before, and every chunk also reaches onText', async () => {
    const h = await agent([{ text: 'Line one\nLine two', chunks: ['Line ', 'one\n', 'Line two'] }]);
    await h.engine.run();
    expect(h.of('generator:delta').map((e) => e.text)).toEqual(['Line ', 'one\n', 'Line two']);
    expect(h.driver.texts).toEqual(['Line ', 'one\n', 'Line two']);
    expect(h.of('generator:delta').every((e) => !('sample' in e))).toBe(true);
  });

  it('`silent` (the compaction writer) emits no generator:delta; the text still reaches onText and the turn is still metered', async () => {
    const h = await agent([{ text: 'summary line\n' }], { driver: { silent: true } });
    await h.engine.run();
    expect(h.of('generator:delta')).toEqual([]);
    expect(h.driver.texts).toEqual(['summary line\n']);
    expect(h.of('generator:end')).toHaveLength(1);
    expect(h.store.generator).toHaveLength(1);
  });

  it('a retried stream calls onAttemptReset with the attempt that starts, beside the ordinary retry event', async () => {
    const h = await agent([{ preRetryText: 'Half a sen', retries: { count: 1, waitMs: 0, status: 503 }, text: 'A whole sentence.' }]);
    await h.engine.run();
    expect(h.driver.resets).toEqual([2]);
    expect(h.of('retry')).toHaveLength(1);
    expect(h.of('retry')[0]).toMatchObject({ side: 'generator', stage: 'propose' });
    // the raw stream still has both attempts' bytes — the shaper (S3) is what drops the first attempt's pending text
    expect(h.of('generator:delta').map((e) => e.text)).toEqual(['Half a sen', 'A whole sentence.']);
  });

  it('reasoning becomes generator:reasoning {turn, chars, tail}, at most one per 100 ms, the last progress flushed when the turn ends', async () => {
    const reasoning = 'First I read the test.\nThe test expects 2 but f returns 1, so the fix is in src/a.py.';
    const h = await agent([{ reasoning, reasoningChunk: 10, text: 'Fixing.' }], { now: () => 5_000 });
    await h.engine.run();
    const events = h.of('generator:reasoning');
    // a frozen clock: the first fragment emits, the rest fall inside the window, the flush reports the total once
    expect(events.map((e) => e.chars)).toEqual([10, reasoning.length]);
    expect(events.every((e) => e.turn === 1 && e.step === 1)).toBe(true);
    expect(events.at(-1)!.tail).toBe('The test expects 2 but f returns 1, so the fix is in src/a.py.');
  });

  it('generator:tool-delta carries the call being written and a target parsed from its partial arguments; onToolCall passes through', async () => {
    const input = { path: 'src/new_module.py', content: 'x = 1\n' };
    const h = await agent([{ toolCalls: [{ id: 'w1', name: 'write_file', input }] }, { text: 'Written.' }]);
    await h.engine.run();
    const deltas = h.of('generator:tool-delta');
    expect(deltas).toHaveLength(2);
    expect(deltas.every((d) => d.tool === 'write_file')).toBe(true);
    expect(deltas.at(-1)).toMatchObject({ chars: JSON.stringify(input).length, tool: 'write_file', target: 'src/new_module.py' });
    expect(h.driver.toolDeltas.map((d) => [d.index, d.id, d.name])).toEqual([
      [0, 'w1', 'write_file'],
      [0, undefined, undefined],
    ]);
    // legacy calls carry neither member
    const legacy = await makeEngine({ mode: 'jev-off', turns: [turn({ kind: 'done', summary: 'x' })] });
    harnesses.push(legacy);
    await legacy.engine.run();
    expect(legacy.of('generator:tool-delta').every((d) => !('tool' in d) && !('target' in d))).toBe(true);
  });

  it('an agent turn’s generator.jsonl prompt hash covers its transcript (messages: [] would give every turn one hash)', async () => {
    const h = await agent([{ toolCalls: [{ name: 'read_file', input: { path: 'src/a.py' } }] }, { text: 'Read it.' }]);
    await h.engine.run();
    const hashes = h.store.generator.map((g) => g.promptHash);
    expect(hashes).toHaveLength(2);
    expect(new Set(hashes).size).toBe(2);
    expect(h.store.generator.map((g) => g.attempt)).toEqual([1, 2]);
  });
});

describe('quick asks are never fatal (§13.1 rule 3)', () => {
  function recordingDecider(o: Parameters<typeof createFakeDecider>[0]): { decider: ReturnType<typeof createFakeDecider>; opts: AskOptions[] } {
    const decider = createFakeDecider(o);
    const opts: AskOptions[] = [];
    const ask = decider.ask.bind(decider);
    decider.ask = async (state, questions, options) => {
      opts.push(options);
      return ask(state, questions, options);
    };
    return { decider, opts };
  }

  for (const session of [false, true]) {
    it(`a drifting decider on the first quick ask: the warning and the drift meta, the error to the caller, the run goes on (${session ? 'session mode — no drift pane' : 'one-shot — no abort'})`, async () => {
      const { decider, opts } = recordingDecider({ model: 'other/jev-9-drifted' });
      const blocks: unknown[] = [];
      const h = await agent([{ text: 'Hello!' }], {
        decider,
        driver: { askJev: true },
        ...(session ? { engine: { blocker: async (req) => (blocks.push(req), 'stop') } } : {}),
      });
      const r = await h.engine.run();
      expect(r.stopReason).toBe('answered');
      expect(h.of('run:end')[0]!.exitCode).toBe(0);
      expect(h.driver.askErrors).toHaveLength(1);
      expect(h.driver.askErrors[0]).toBeInstanceOf(JevModelDriftError);
      expect(h.of('blocking:request')).toEqual([]);
      expect(blocks).toEqual([]);
      expect(h.of('error').filter((e) => e.fatal)).toEqual([]);
      expect(h.store.meta!.jevModelDrift).toEqual({ step: 1, served: 'other/jev-9-drifted' });
      expect(h.of('transcript').filter((t) => t.level === 'warn' && t.text.includes('other/jev-9-drifted'))).toHaveLength(1);
      // metered and recorded at stage `loop`, one attempt
      expect(h.of('jev:request').map((e) => e.record.stage)).toEqual(['loop']);
      expect(opts.map((o) => [o.stage, o.quick])).toEqual([['loop', true]]);
    });
  }

  it('unpriced usage on a quick ask is announced but never stops the run (a legacy ask would stop it with error)', async () => {
    const h = await agent([{ toolCalls: [{ name: 'read_file', input: { path: 'src/a.py' } }] }, { text: 'Done.' }], {
      deciderOptions: { usage: { costUsd: Number.NaN } },
      driver: { askJev: true },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('generator_done');
    expect(h.of('budget:unpriced').map((e) => e.side)).toEqual(['jev']);
    expect(h.of('jev:request')).toHaveLength(2);
    expect(r.error ?? null).toBeNull();
  });

  it('the absent decider (no Jev key): jevAvailable is false, so no placement asks and nothing is spent', async () => {
    const decider = createAbsentDecider();
    let asked = 0;
    const ask = decider.ask.bind(decider);
    decider.ask = async (s, q, o) => {
      asked += 1;
      return ask(s, q, o);
    };
    const h = await agent([{ text: 'Hi.' }], { decider: decider as ReturnType<typeof createFakeDecider>, driver: { askJev: true } });
    await h.engine.run();
    expect(h.driver.contexts[0]!.jevAvailable).toBe(false);
    expect(asked).toBe(0);
    expect(h.of('jev:request')).toEqual([]);
  });
});

describe('the rest of AgentContext (§15 S4 item 8)', () => {
  it('carries the run’s facts: provider, generation, window, compaction source, dirty set, conversation, route token, autonomy', async () => {
    const conversation = { chat: [{ role: 'you' as const, text: 'the mean is wrong, right?' }, { role: 'jevcode' as const, text: 'Yes — it divides by n - 1.' }], parent: null };
    const h = await agent([{ text: 'ok' }], {
      probeGitState: repoState({ dirty: ['src/a.py'], untracked: ['notes.txt'] }),
      conversation,
      configRecord: { 'context.compaction': { value: 'code', source: 'env' } },
      engine: { generatorPricing: { inputPerM: 0.1, outputPerM: 0.4, cacheReadPerM: 0.01, cacheWritePerM: 0.1, contextTokens: 1_000_000 }, instructions: { text: '  Use tabs.  ', files: [] }, memory: { index: '' } },
    });
    await h.engine.run();
    const ctx = h.driver.contexts[0]!;
    expect(ctx.provider).toEqual({ name: 'mock', model: 'z-ai/glm-5.3-flash' });
    expect(ctx.generation).toEqual({ temperature: null, maxTokens: 4096 });
    expect(ctx.windowTokens).toBe(1_000_000);
    expect(ctx.compaction).toEqual({ mode: 'code', explicit: true });
    expect([...ctx.dirtyAtStart].sort()).toEqual(['notes.txt', 'src/a.py']);
    expect(ctx.conversation).toEqual(conversation);
    expect(ctx.instructions).toBe('Use tabs.');
    expect(ctx.memoryIndex).toBeNull();
    expect(ctx.autonomy).toBe('full');
    expect(ctx.jevAvailable).toBe(true);
    expect(ctx.resumed).toBe(false);
    expect(ctx.state).toBeNull();
    expect(ctx.routeToken()).toMatchObject({ step: 1, valid: true });
    expect(ctx.sessionId).toBe(FIXED_RUN_ID);
    expect(ctx.runDir).toBe(join(h.runsDir, FIXED_RUN_ID));
    // the default compaction row is not the user's
    const d = await agent([{ text: 'ok' }], { configRecord: { 'context.compaction': { value: 'code', source: 'default' } } });
    await d.engine.run();
    expect(d.driver.contexts[0]!.compaction).toEqual({ mode: 'code', explicit: false });
  });

  it('a steer is handed to the driver once; `/compact` is a request taken once', async () => {
    const compactions: boolean[] = [];
    const h = await agent([{ toolCalls: [{ name: 'read_file', input: { path: 'src/a.py' } }] }, { text: 'ok' }], {
      engine: { humanDirective: 'use tabs, not spaces' },
      driver: { onNext: (ctx) => void compactions.push(ctx.takeCompactRequest()) },
    });
    h.engine.compact?.();
    await h.engine.run();
    expect(h.driver.steers).toEqual(['use tabs, not spaces']);
    expect(compactions).toEqual([true, false]);
    // the steer reached the next request as a user note
    const texts = h.tools.requests[0]!.agent!.messages.flatMap((m) => (m.role === 'user' ? m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])) : []));
    expect(texts.some((t) => t.includes('use tabs, not spaces'))).toBe(true);
  });

  it('writeOutput spills through the store (step-N.txt) or as a part (step-N-k.txt), and answers with the jevcode: pointer', async () => {
    const pointers: (string | null)[] = [];
    const h = await agent([{ text: 'ok' }], {
      driver: {
        onNext: async (ctx) => {
          pointers.push(await ctx.writeOutput('whole output of one command'));
          pointers.push(await ctx.writeOutput('second of several', 2));
        },
      },
    });
    await h.engine.run();
    expect(pointers).toEqual(['jevcode:outputs/step-1.txt', 'jevcode:outputs/step-1-2.txt']);
    expect(h.store.outputs.get(1)).toBe('whole output of one command');
    const part = join(h.runsDir, FIXED_RUN_ID, 'outputs', 'step-1-2.txt');
    expect(existsSync(part)).toBe(true);
    expect(readFileSync(part, 'utf8')).toBe('second of several');
  });

  it('spilled parts keep their own per-run byte bound: past it nothing is written, the pointer is null and one warning says so', async () => {
    const pointers: (string | null)[] = [];
    const h = await agent([{ text: 'ok' }], {
      driver: {
        onNext: async (ctx) => {
          pointers.push(await ctx.writeOutput('part one', 1));
          pointers.push(await ctx.writeOutput('part two', 2));
          // the store's own step-N.txt is a different ledger and still writes
          pointers.push(await ctx.writeOutput('whole output'));
        },
      },
    });
    // a resumed run's earlier parts count: one (sparse) part already fills the bound
    const outputs = join(h.runsDir, FIXED_RUN_ID, 'outputs');
    mkdirSync(outputs, { recursive: true });
    const fd = openSync(join(outputs, 'step-9-1.txt'), 'w');
    ftruncateSync(fd, AGENT_OUTPUT_PARTS_MAX_BYTES);
    closeSync(fd);
    await h.engine.run();
    expect(pointers).toEqual([null, null, 'jevcode:outputs/step-1.txt']);
    expect(existsSync(join(outputs, 'step-1-1.txt'))).toBe(false);
    expect(h.of('transcript').filter((t) => t.text.startsWith('outputs: spilled parts reached the run'))).toHaveLength(1);
  });

  it('writeOutputPart: the ledger reads the parts on disk once (never step-N.txt), a rewrite replaces its own size, and a part past the bound writes nothing', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'jevcode-agent-parts-'));
    try {
      const outputs = join(runDir, 'outputs');
      mkdirSync(outputs, { recursive: true });
      const fd = openSync(join(outputs, 'step-3.txt'), 'w');
      ftruncateSync(fd, AGENT_OUTPUT_PARTS_MAX_BYTES);
      closeSync(fd);
      const ledger = createOutputPartLedger();
      const id = (s: string): string => s;
      expect(await writeOutputPart(runDir, 3, 1, 'abc', id, ledger)).toBe('jevcode:outputs/step-3-1.txt');
      const sizes = await ledger.sizes!;
      expect([...sizes.entries()]).toEqual([['step-3-1.txt', 3]]);
      sizes.set('step-3-1.txt', AGENT_OUTPUT_PARTS_MAX_BYTES - 4);
      expect(await writeOutputPart(runDir, 3, 2, 'too long', id, ledger)).toBeNull();
      expect(existsSync(join(outputs, 'step-3-2.txt'))).toBe(false);
      expect(await writeOutputPart(runDir, 3, 2, 'fit', id, ledger)).toBe('jevcode:outputs/step-3-2.txt');
      // rewriting the big part does not count its own old size against itself
      expect(await writeOutputPart(runDir, 3, 1, 'small now', id, ledger)).toBe('jevcode:outputs/step-3-1.txt');
      expect(sizes.get('step-3-1.txt')).toBe(9);
      expect(readdirSync(outputs).sort()).toEqual(['step-3-1.txt', 'step-3-2.txt', 'step-3.txt']);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('an agent turn the pause cut mid-stream is booked: a cancelled generator.jsonl row whose estimated input is the transcript size, and the meter', async () => {
    const big = 'x'.repeat(40_000);
    const h = await agent([{ toolCalls: [{ name: 'read_file', input: { path: 'src/big.py' } }] }, { text: 'never arrives', delayMs: 5_000 }], { driver: { resolve: () => big } });
    h.engine.events.on('generator:start', (e) => {
      if (e.step === 2) h.engine.pause({ at: 'now' });
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(r.steps).toBe(1);
    const rows = h.store.generator.filter((g) => g.step === 2);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ cancelled: true, stopReason: 'cancelled', discarded: true });
    expect('sample' in row).toBe(false);
    expect(row.usage.estimated).toBe(true);
    // the prompt is `agent.messages` (the 40,000-char tool result and the rest), not the empty legacy `messages`
    expect(row.usage.inputTokens).toBeGreaterThanOrEqual(10_000);
    expect(row.usage.inputTokens).toBeLessThan(10_100);
    expect(row.usage.costUsd).toBeGreaterThan(0);
    const end = h.of('generator:end').filter((e) => e.step === 2);
    expect(end.map((e) => e.finishReason)).toEqual(['cancelled']);
    expect('sample' in end[0]!).toBe(false);
    // the served turn of step 1 and the cut one of step 2 both reach the meter (the spend cap sees what was billed)
    expect(h.meter.snapshot().generator.calls).toBe(2);
    expect(h.meter.snapshot().generator.inputTokens).toBe(1000 + row.usage.inputTokens);
  });

  it('reportContext feeds EngineStatus.context in agent mode (absent until the first report, as in the modes without a meter)', async () => {
    const usage: ContextUsage = {
      promptChars: 34_000, budgetChars: 680_000, pct: 5, files: 0, historyEntries: 3, summaryAt: null, lastCompactionStep: null, tokensInWindow: 10_000, budgetTokens: 200_000, windowTokens: 1_000_000, compactions: 0, lastCompactionAt: null, compaction: 'llm', budgetBoundBy: 'ceiling', usdPerStep: null, windowTooSmall: false,
      recentSteps: { chars: 0, allowanceChars: 0, whole: 0, clipped: 0, oneLine: 0, reads: 0 }, promptBuildMs: 1, refreshMs: 0,
    };
    let before: unknown = 'unset';
    const h = await agent([{ text: 'ok' }], {
      driver: {
        onNext: (ctx) => {
          if (before === 'unset') before = 'context' in h.engine.status();
          ctx.reportContext(usage);
        },
      },
    });
    await h.engine.run();
    expect(before).toBe(false);
    expect(h.engine.status().context).toEqual(usage);
    expect(h.of('status').some((e) => e.status.context?.tokensInWindow === 10_000)).toBe(true);
  });
});
