/**
 * docs/AGENT-LOOP-DESIGN.md §10 Steer, through the REAL engine tail and the REAL driver (src/agent, loaded by the seam when no driver
 * is injected) over the fake tool provider: a message the user types while a turn with no tool call is streaming is queued for the
 * step in progress (`steer:queued`). The driver asks for steers again when that turn ends, the engine applies the queued directive to
 * the running step then (`steer:applied`, nothing left pending in `state.json`), and one more turn answers it — a reply-only run
 * still stops `answered`, a task run `generator_done`. A steer typed during a tool step is applied at the next step start and
 * absorbed at the top of the next `next()`, as before; one typed once finish() is in flight is refused as `finished` (§8.6), so the
 * controller keeps the text.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage, GenerateRequest, SteerResult } from '../../../src/core/types.js';
import type { FakeToolProvider, Harness, ToolTurn } from './fakes.js';
import { createFakeSandbox, createFakeToolProvider, makeEngine } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const NOTE = '[message from the user while you were working]\n';
/** the fakes' redactor replaces exactly this value (makeEngine) */
const SECRET = 'sk-or-v1-SECRETSECRETSECRETSECRET';

/** the real driver over the fake tool provider; `script` may steer through the harness while a turn is in flight */
async function realAgent(script: (h: Harness, index: number) => ToolTurn, o: Omit<Parameters<typeof makeEngine>[0] & object, 'mode' | 'provider'> = {}): Promise<Harness & { tools: FakeToolProvider }> {
  let h!: Harness;
  const tools = createFakeToolProvider((_req: GenerateRequest, index: number) => script(h, index));
  h = await makeEngine({ ...o, mode: 'agent', provider: tools, autonomyDefault: true });
  harnesses.push(h);
  return Object.assign(h, { tools });
}

/** every user text block of a request, in order */
function userNotes(req: GenerateRequest | undefined): string[] {
  return (req?.agent?.messages ?? []).flatMap((m: AgentMessage) => (m.role === 'user' ? m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])) : []));
}
function assistantTexts(req: GenerateRequest | undefined): string[] {
  return (req?.agent?.messages ?? []).flatMap((m: AgentMessage) => (m.role === 'assistant' ? m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])) : []));
}
function toolResults(req: GenerateRequest | undefined): string[] {
  return (req?.agent?.messages ?? []).flatMap((m: AgentMessage) => (m.role === 'user' ? m.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : [])) : []));
}

describe('a steer typed while a turn with no tool call streams is answered, never left pending (§10 Steer)', () => {
  it('a reply-only run: the steer queued during turn 1 is applied to step 1, turn 2 answers it (redacted), the run stops `answered` with nothing pending', async () => {
    const steered: SteerResult[] = [];
    const h = await realAgent((hh, i) => {
      if (i === 0) {
        steered.push(hh.engine.steer(`also say where f is defined ${SECRET}`));
        return { text: 'Hello! f() returns 1.' };
      }
      return { text: 'f() is defined in src/a.py.' };
    });
    const r = await h.engine.run();
    expect(steered).toEqual([{ ok: true, index: 0, queued: 1 }]);
    expect(r.stopReason).toBe('answered');
    expect(r.steps).toBe(1);
    expect(h.of('run:end')[0]!.exitCode).toBe(0);
    // two turns in the one finish step; turn 2's request carries turn 1's reply and then the steer, redacted
    expect(h.tools.requests).toHaveLength(2);
    expect(userNotes(h.tools.requests[0])).not.toContainEqual(expect.stringContaining(NOTE));
    expect(assistantTexts(h.tools.requests[1])).toEqual(['Hello! f() returns 1.']);
    expect(userNotes(h.tools.requests[1]).at(-1)).toBe(`${NOTE}also say where f is defined [REDACTED:test]`);
    expect(JSON.stringify(h.tools.requests)).not.toContain(SECRET);
    // queued for step 1, applied to step 1 while it ran — the TUI's queue clears on this event
    expect(h.of('steer:queued').map((e) => [e.step, e.index])).toEqual([[1, 0]]);
    expect(h.of('steer:applied')).toEqual([{ type: 'steer:applied', step: 1, count: 1, superseded: [] }]);
    const types = h.events.map((e) => e.type);
    expect(types.indexOf('steer:applied')).toBeLessThan(types.indexOf('step:end'));
    // nothing pending at run end: the final state.json has no queue, and the steer is a step-1 human problem of the plan
    const last = h.store.last()!;
    expect(last.stopReason).toBe('answered');
    expect(last.pendingDirectives).toBeUndefined();
    expect(last.plan.harnessProblems.filter((p) => p.kind === 'human').map((p) => p.step)).toEqual([1]);
    // the finish step's answer is turn 2's
    const rec = h.store.steps[0]!;
    expect(rec.agent).toMatchObject({ kind: 'finish', calls: [] });
    expect(rec.proposal?.action).toEqual({ kind: 'done', summary: 'f() is defined in src/a.py.' });
  });

  it('a task run: the final prose turn after an edit gets a steer while it streams → one more turn in the finish step, generator_done, nothing pending', async () => {
    const h = await realAgent((hh, i) => {
      if (i === 0) return { toolCalls: [{ name: 'edit_file', input: { path: 'src/a.py', old_string: 'return 1', new_string: 'return 2' } }] };
      if (i === 1) {
        hh.engine.steer('and name the test file');
        return { text: 'Changed f to return 2.' };
      }
      return { text: 'The test is tests/test_a.py.' };
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('generator_done');
    expect(h.store.steps.map((s) => s.agent?.kind)).toEqual(['act', 'finish']);
    expect(h.workspace.files.get('src/a.py')).toBe('def f():\n    return 2\n');
    expect(h.tools.requests).toHaveLength(3);
    expect(assistantTexts(h.tools.requests[2]).at(-1)).toBe('Changed f to return 2.');
    expect(userNotes(h.tools.requests[2]).at(-1)).toBe(`${NOTE}and name the test file`);
    expect(h.of('steer:queued').map((e) => e.step)).toEqual([2]);
    expect(h.of('steer:applied')).toEqual([{ type: 'steer:applied', step: 2, count: 1, superseded: [] }]);
    expect(h.store.last()!.pendingDirectives).toBeUndefined();
    expect(h.store.steps[1]!.proposal?.action).toEqual({ kind: 'done', summary: 'The test is tests/test_a.py.' });
  });

  it('a steer applied at the step start and one typed during its reply both reach the model; the later one supersedes nothing of the same step', async () => {
    const h = await realAgent(
      (hh, i) => {
        if (i === 0) {
          hh.engine.steer('second message');
          return { text: 'Noted: tabs.' };
        }
        return { text: 'Noted: and the second.' };
      },
      { engine: { humanDirective: 'use tabs, not spaces' } },
    );
    const r = await h.engine.run();
    expect(r.stopReason).toBe('answered');
    expect(h.tools.requests).toHaveLength(2);
    expect(userNotes(h.tools.requests[0]).filter((t) => t.startsWith(NOTE))).toEqual([`${NOTE}use tabs, not spaces`]);
    expect(userNotes(h.tools.requests[1]).filter((t) => t.startsWith(NOTE))).toEqual([`${NOTE}use tabs, not spaces`, `${NOTE}second message`]);
    expect(h.of('steer:applied')).toEqual([
      { type: 'steer:applied', step: 1, count: 1, superseded: [] },
      { type: 'steer:applied', step: 1, count: 1, superseded: [] },
    ]);
    expect(h.store.last()!.pendingDirectives).toBeUndefined();
    expect(h.store.last()!.plan.harnessProblems.filter((p) => p.kind === 'human' && p.step === 1).length).toBe(2);
  });
});

describe('pause now and resume are unchanged (§10 Pause)', () => {
  it('a pause-now during the steer’s turn discards the step with nothing pending; the resume re-arms the steer from the plan and the model gets it once', async () => {
    const first = await realAgent((hh, i) => {
      if (i === 0) {
        hh.engine.steer('and where is it defined?');
        return { text: 'f() returns 1.' };
      }
      return { text: 'never arrives', delayMs: 5_000 };
    });
    let starts = 0;
    first.engine.events.on('generator:start', () => {
      if (++starts === 2) first.engine.pause({ at: 'now' });
    });
    const r1 = await first.engine.run();
    expect(r1.stopReason).toBe('human_pause');
    expect(r1.steps).toBe(0);
    expect(first.of('steer:applied')).toEqual([{ type: 'steer:applied', step: 1, count: 1, superseded: [] }]);
    const saved = first.store.last()!;
    expect(saved.pendingDirectives).toBeUndefined();
    expect(saved.plan.harnessProblems.filter((p) => p.kind === 'human').map((p) => [p.step, p.text])).toEqual([[1, 'and where is it defined?']]);

    const second = await realAgent(() => ({ text: 'f() is defined in src/a.py.' }), { runsDir: first.runsDir, store: first.store, resume: { runId: first.engine.runId, force: false } });
    const r2 = await second.engine.run();
    expect(r2.stopReason).not.toBe('error');
    expect(second.of('run:end')[0]!.exitCode).toBe(0);
    // the discarded turn is gone (the transcript is truncated at the checkpoint); the steer reaches the resumed turn exactly once
    expect(second.tools.requests).toHaveLength(1);
    expect(assistantTexts(second.tools.requests[0])).toEqual([]);
    expect(userNotes(second.tools.requests[0]).filter((t) => t.startsWith(NOTE))).toEqual([`${NOTE}and where is it defined?`]);
    expect(second.store.last()!.pendingDirectives).toBeUndefined();
  });
});

describe('the tool-step paths are unchanged: a steer typed while a tool runs is absorbed at the next next() (§10 Steer)', () => {
  it('observe: a steer typed while a read resolves is applied at step 2 and reaches turn 2 beside the read’s result (nothing cancelled, no extra turn)', async () => {
    let steered = false;
    const h = await realAgent((_hh, i) => (i === 0 ? { toolCalls: [{ name: 'read_file', input: { path: 'src/a.py' } }] } : { text: 'f() returns 1.' }));
    const read = h.workspace.read.bind(h.workspace);
    h.workspace.read = async (path, maxBytes) => {
      if (path === 'src/a.py' && !steered && (h.provider as FakeToolProvider).requests.length === 1) {
        steered = true;
        expect(h.engine.steer('also check g').ok).toBe(true);
      }
      return read(path, maxBytes);
    };
    const r = await h.engine.run();
    expect(steered).toBe(true);
    expect(r.stopReason).toBe('generator_done');
    expect(h.store.steps.map((s) => s.agent?.kind)).toEqual(['observe', 'finish']);
    expect(h.tools.requests).toHaveLength(2);
    expect(toolResults(h.tools.requests[1])).toEqual([expect.stringContaining('return 1')]);
    expect(userNotes(h.tools.requests[1]).at(-1)).toBe(`${NOTE}also check g`);
    expect(h.of('steer:applied')).toEqual([{ type: 'steer:applied', step: 2, count: 1, superseded: [] }]);
    expect(h.store.last()!.pendingDirectives).toBeUndefined();
  });

  it('act: a steer typed while a command executes is applied at step 2 and reaches turn 2 after the command’s result', async () => {
    let h!: Harness & { tools: FakeToolProvider };
    const sandbox = createFakeSandbox((command) => {
      if (command === 'make') expect(h.engine.steer('then run the linter').ok).toBe(true);
      return { stdout: 'built\n' };
    });
    h = await realAgent((_hh, i) => (i === 0 ? { toolCalls: [{ name: 'bash', input: { command: 'make' } }] } : { text: 'Built.' }), { sandbox });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('generator_done');
    expect(h.store.steps.map((s) => s.agent?.kind)).toEqual(['act', 'finish']);
    expect(h.tools.requests).toHaveLength(2);
    expect(toolResults(h.tools.requests[1])).toEqual([expect.stringContaining('built')]);
    expect(userNotes(h.tools.requests[1]).at(-1)).toBe(`${NOTE}then run the linter`);
    expect(h.of('steer:applied')).toEqual([{ type: 'steer:applied', step: 2, count: 1, superseded: [] }]);
    expect(h.store.last()!.pendingDirectives).toBeUndefined();
  });
});

describe('finish() in flight is unchanged (§8.6)', () => {
  it('a steer typed once finish() started is refused as `finished` (the controller keeps the text) and never absorbed: one turn, no steer:applied', async () => {
    const h = await realAgent(() => ({ text: 'Hello!' }));
    let late: SteerResult | null = null;
    const realWrite = h.store.writeState.bind(h.store);
    h.store.writeState = async (state) => {
      // the FINAL write (the one with a stopReason): finish() is in flight, the snapshot is already built
      if (state.stopReason !== null && late === null) late = h.engine.steer('typed as the reply ended');
      return realWrite(state);
    };
    const r = await h.engine.run();
    expect(r.stopReason).toBe('answered');
    expect(late).toEqual({ ok: false, reason: 'finished', queued: 0 });
    expect(h.tools.requests).toHaveLength(1);
    expect(h.of('steer:queued')).toEqual([]);
    expect(h.of('steer:applied')).toEqual([]);
    expect(h.store.last()!.pendingDirectives).toBeUndefined();
  });
});
