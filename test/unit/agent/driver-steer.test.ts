/**
 * docs/AGENT-LOOP-DESIGN.md §3.1 step 8 / §10 Steer — a message the user sends while a turn with no tool call streams. The driver
 * absorbs steers at the top of `next()` and again when a turn ends with no tool call, BEFORE the stop rules: a steer absorbed there
 * is answered by one more turn (its text reaches the model as every steer does, redacted) instead of the run finishing past it.
 * The continuation and verify rules apply to the turn that follows as to any other; each absorbed steer is one more turn.
 */
import { describe, expect, it } from 'vitest';
import { createAgentDriver } from '../../../src/agent/index.js';
import { isReplyOnlyRun } from '../../../src/core/agent-run.js';
import type { AgentNext } from '../../../src/core/types.js';
import { call, createAgentContext, messagesOf, runUntilFinish, step, userText, type FakeAgentContext, type ScriptedTurn } from './helpers.js';

const NOTE = '[message from the user while you were working]\n';

function kinds(steps: { next: AgentNext }[]): string[] {
  return steps.map((s) => s.next.kind);
}

/** the assistant prose of the n-th request's transcript, in order */
function assistantTexts(ctx: FakeAgentContext, n: number): string[] {
  return messagesOf(ctx, n)
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])));
}

describe('a steer sent while a turn with no tool call streams (§10 Steer)', () => {
  it('a reply-only run: turn 1 is prose, the steer lands while it streams → turn 2 carries the steer (redacted) and answers it; the run is still a reply', async () => {
    let ctx!: FakeAgentContext;
    ctx = createAgentContext({
      testCommand: null,
      turns: (_req, i): ScriptedTurn => {
        if (i === 0) {
          ctx.steerQueue.push('also say where f is defined, key sk-secret-abc123');
          return { text: 'Hello! f() returns 1.' };
        }
        return { text: 'f() is defined in src/a.py.' };
      },
    });
    const s = await step(createAgentDriver(), ctx);
    // one step, two turns: the steer was not dropped by the finish of turn 1
    expect(s.next.kind).toBe('finish');
    expect(ctx.sent).toHaveLength(2);
    expect(ctx.steerQueue).toEqual([]);
    expect(userText(ctx, 0)).not.toContain(NOTE);
    // turn 2's request carries turn 1's reply, then the steer as the user's note — redacted, exactly as a step-start steer
    expect(assistantTexts(ctx, 1)).toEqual(['Hello! f() returns 1.']);
    const tail = messagesOf(ctx, 1).at(-1)!;
    expect(tail.role).toBe('user');
    expect(tail.content.map((b) => (b.type === 'text' ? b.text : b.type))).toEqual([`${NOTE}also say where f is defined, key [REDACTED]`]);
    expect(JSON.stringify(ctx.sent[1])).not.toContain('sk-secret-abc123');
    // the finish carries the answer to the steer; no call anywhere, so the engine stops it `answered`
    if (s.next.kind !== 'finish') throw new Error('expected a finish');
    expect(s.next.proposal.action).toEqual({ kind: 'done', summary: 'f() is defined in src/a.py.' });
    expect(s.next.summary).toMatchObject({ kind: 'finish', turn: 2, calls: [] });
    expect(isReplyOnlyRun([{ agent: s.next.summary }])).toBe(true);
    // the steer's turn spent no continuation nudge
    expect((ctx.state as { continueNudges: number; turns: number }).continueNudges).toBe(0);
    expect((ctx.state as { turns: number }).turns).toBe(2);
  });

  it('a task run: the final prose turn after an edit gets a steer while it streams → one more turn, and that turn finishes', async () => {
    let ctx!: FakeAgentContext;
    ctx = createAgentContext({
      testCommand: null,
      turns: (_req, i): ScriptedTurn => {
        if (i === 0) return { toolCalls: [call('edit_file', { path: 'src/a.py', old_string: 'return 1', new_string: 'return 2' })] };
        if (i === 1) {
          ctx.steerQueue.push('and mention the test file');
          return { text: 'Changed f to return 2.' };
        }
        return { text: 'The test is tests/test_a.py.' };
      },
    });
    const steps = await runUntilFinish(createAgentDriver(), ctx);
    expect(kinds(steps)).toEqual(['act', 'finish']);
    expect(ctx.sent).toHaveLength(3);
    expect(ctx.fs.files.get('src/a.py')).toBe('def f():\n    return 2\n');
    expect(assistantTexts(ctx, 2)).toEqual(['Changed f to return 2.']);
    expect(userText(ctx, 2).endsWith(`${NOTE}and mention the test file`)).toBe(true);
    const fin = steps[1]!.next;
    expect(fin.proposal.action).toEqual({ kind: 'done', summary: 'The test is tests/test_a.py.' });
    expect(isReplyOnlyRun(steps.map((x) => ({ agent: x.next.summary })))).toBe(false);
  });

  it('the continuation rule still applies to the turn after the steer, and the steer spends none of its two nudges', async () => {
    let ctx!: FakeAgentContext;
    ctx = createAgentContext({
      testCommand: null,
      turns: (_req, i): ScriptedTurn => {
        if (i === 0) {
          ctx.steerQueue.push('check the tests too');
          return { text: 'f() returns 1.' };
        }
        if (i === 1) return { text: 'Let me check the tests:' };
        return { text: 'tests/test_a.py expects 2.' };
      },
    });
    const s = await step(createAgentDriver(), ctx);
    expect(s.next.kind).toBe('finish');
    expect(ctx.sent).toHaveLength(3);
    expect(userText(ctx, 1).endsWith(`${NOTE}check the tests too`)).toBe(true);
    expect(userText(ctx, 2)).toContain('Continue');
    expect((ctx.state as { continueNudges: number }).continueNudges).toBe(1);
  });

  it('under agent.verify tests the verify rule still applies after the steer’s turn: edit, reply + steer, one more turn, then the harness verifies', async () => {
    let ctx!: FakeAgentContext;
    ctx = createAgentContext({
      verify: 'tests',
      sandbox: () => ({ exitCode: 0, stdout: '2 passed in 0.01s\n' }),
      turns: (_req, i): ScriptedTurn => {
        if (i === 0) return { toolCalls: [call('edit_file', { path: 'src/a.py', old_string: 'return 1', new_string: 'return 2' })] };
        if (i === 1) {
          ctx.steerQueue.push('keep the old name');
          return { text: 'Changed f to return 2.' };
        }
        if (i === 2) return { text: 'The name is unchanged.' };
        return { text: 'Verified: the tests pass.' };
      },
    });
    const steps = await runUntilFinish(createAgentDriver(), ctx);
    expect(kinds(steps)).toEqual(['act', 'verify', 'finish']);
    expect(ctx.sent).toHaveLength(4);
    expect(userText(ctx, 2).endsWith(`${NOTE}keep the old name`)).toBe(true);
    expect(userText(ctx, 3)).toContain('The harness ran `pytest -q`');
  });

  it('each absorbed steer is one more turn: two messages typed during two replies give three turns, then the run finishes', async () => {
    let ctx!: FakeAgentContext;
    ctx = createAgentContext({
      testCommand: null,
      turns: (_req, i): ScriptedTurn => {
        if (i === 0) ctx.steerQueue.push('first follow-up');
        if (i === 1) ctx.steerQueue.push('second follow-up');
        return { text: `reply ${i + 1}` };
      },
    });
    const s = await step(createAgentDriver(), ctx);
    expect(s.next.kind).toBe('finish');
    expect(ctx.sent).toHaveLength(3);
    expect(userText(ctx, 1).endsWith(`${NOTE}first follow-up`)).toBe(true);
    expect(userText(ctx, 2).endsWith(`${NOTE}second follow-up`)).toBe(true);
    expect(assistantTexts(ctx, 2)).toEqual(['reply 1', 'reply 2']);
    expect(s.next.proposal.action).toEqual({ kind: 'done', summary: 'reply 3' });
  });

  it('with no steer the turn finishes exactly as before: one turn, one request', async () => {
    const ctx = createAgentContext({ testCommand: null, turns: [{ text: 'Hello!' }] });
    const s = await step(createAgentDriver(), ctx);
    expect(s.next.kind).toBe('finish');
    expect(ctx.sent).toHaveLength(1);
  });
});
