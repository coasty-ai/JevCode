/**
 * Persistence, resume and session continuity through the driver (docs/AGENT-LOOP-DESIGN.md §3.1 step 1, §7.6, §10): the
 * state the checkpoint carries, restore with truncation after `transcriptSeq`, a missing transcript refused, and a
 * follow-up run that carries its parent's transcript.
 */
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Json } from '../../../src/core/types.js';
import { AgentTranscriptMissingError, createAgentDriver } from '../../../src/agent/index.js';
import { parseState } from '../../../src/agent/state.js';
import { readTranscript, transcriptPath } from '../../../src/agent/transcript.js';
import { call, createAgentContext, messagesOf, runUntilFinish, step, tempRunDir } from './helpers.js';

describe('the checkpoint state', () => {
  it('every step hands the engine a state whose transcriptSeq covers the records on disk', async () => {
    const ctx = createAgentContext({ testCommand: null, turns: [{ toolCalls: [call('glob', { pattern: '*' }), call('bash', { command: 'npm install' })] }, { text: 'ok' }] });
    const d = createAgentDriver();
    for (let i = 0; i < 3; i += 1) {
      await step(d, ctx);
      const s = parseState(ctx.state)!;
      const onDisk = (await readTranscript(transcriptPath(ctx.runDir)))!;
      expect(s.transcriptSeq).toBe(onDisk.at(-1)!.seq);
    }
    expect(parseState(ctx.state)).toMatchObject({ v: 1, turns: 2, verifyRuns: 0, continueNudges: 0, jevDisabled: false, replayDisabled: false, carriedFrom: null });
  });
});

describe('resume', () => {
  it('restores the transcript and continues where the checkpoint left off', async () => {
    const runDir = tempRunDir();
    const first = createAgentContext({ runDir, testCommand: null, turns: [{ toolCalls: [call('read_file', { path: 'src/a.py' })] }] });
    await step(createAgentDriver(), first);
    const saved: Json | null = first.state;
    const resumed = createAgentContext({ runDir, resumed: true, state: saved, testCommand: null, turns: [{ text: 'Resumed and done.' }] });
    const steps = await runUntilFinish(createAgentDriver(), resumed);
    expect(steps.map((s) => s.next.kind)).toEqual(['finish']);
    const msgs = messagesOf(resumed, 0);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2]!.content[0]!.type).toBe('tool_result');
    expect(parseState(resumed.state)!.turns).toBe(2);
  });

  it('truncates records past the checkpoint; a call whose result was never committed is issued again', async () => {
    const runDir = tempRunDir();
    const first = createAgentContext({ runDir, testCommand: null, turns: [{ toolCalls: [call('bash', { command: 'npm install' }, 'tc_1')] }] });
    const d = createAgentDriver();
    await d.next(first);
    const checkpoint = first.state;
    // the act ran and its result was appended, then the process died before the step committed
    await d.observe(first, { step: 1, outcome: { status: 'executed', summary: 'exit 0', changedFiles: [] }, output: '', changedFiles: [], tests: null, error: null });
    appendFileSync(transcriptPath(runDir), '{"v":1,"seq":99,"kind":"note","at":"x","text":"stray","tag":"continue"}\n');
    const resumed = createAgentContext({ runDir, resumed: true, state: checkpoint, testCommand: null, turns: [] });
    const next = await createAgentDriver().next(resumed);
    expect(next.kind === 'act' && next.callId).toBe('tc_1');
    const onDisk = readFileSync(transcriptPath(runDir), 'utf8').trim().split('\n');
    expect(onDisk).toHaveLength(parseState(checkpoint)!.transcriptSeq);
    expect(resumed.sent).toHaveLength(0);
  });

  it('a pending call whose recorded arguments were redacted is not run with the markers after a resume: the model sends it again', async () => {
    const runDir = tempRunDir();
    const write = call('write_file', { path: 'fixture.txt', content: 'token=sk-secret-abc123\n' });
    const first = createAgentContext({ runDir, testCommand: null, turns: [{ toolCalls: [write] }] });
    const paused = await createAgentDriver().next(first);
    expect(paused.kind).toBe('act');
    // Esc during the act step: the checkpoint holds the call, the process goes away with the model's own copy
    const resumed = createAgentContext({ runDir, resumed: true, state: first.state, testCommand: null, turns: [{ toolCalls: [write] }, { text: 'ok' }] });
    const d = createAgentDriver();
    const s1 = await step(d, resumed);
    expect(s1.next.kind).toBe('observe');
    expect(resumed.fs.files.has('fixture.txt')).toBe(false);
    const s2 = await step(d, resumed);
    expect(s2.next.kind === 'act' && s2.next.proposal.action).toEqual({ kind: 'write', path: 'fixture.txt', content: 'token=sk-secret-abc123\n' });
    expect(resumed.fs.files.get('fixture.txt')).toBe('token=sk-secret-abc123\n');
    const result = messagesOf(resumed, 0).at(-1)!.content[0]!;
    expect(result.type === 'tool_result' && result.content).toBe("NOT EXECUTED: this call's arguments were redacted when the run was checkpointed; send it again with the full text.");
  });

  it('a pending call with nothing redacted in its record runs as recorded after a resume', async () => {
    const runDir = tempRunDir();
    const first = createAgentContext({ runDir, testCommand: null, turns: [{ toolCalls: [call('write_file', { path: 'plain.txt', content: 'hello\n' })] }] });
    await createAgentDriver().next(first);
    const resumed = createAgentContext({ runDir, resumed: true, state: first.state, testCommand: null, turns: [{ text: 'ok' }] });
    const s = await step(createAgentDriver(), resumed);
    expect(s.next.kind === 'act' && s.next.proposal.action).toEqual({ kind: 'write', path: 'plain.txt', content: 'hello\n' });
    expect(resumed.sent).toHaveLength(0);
  });

  it('a resumed run whose transcript is gone is refused, never restarted silently', async () => {
    const runDir = tempRunDir();
    const first = createAgentContext({ runDir, turns: [{ toolCalls: [call('glob', { pattern: '*' })] }] });
    await step(createAgentDriver(), first);
    rmSync(transcriptPath(runDir));
    const resumed = createAgentContext({ runDir, resumed: true, state: first.state });
    await expect(createAgentDriver().next(resumed)).rejects.toBeInstanceOf(AgentTranscriptMissingError);
  });

  it('a resume with no agent state yet (paused before the first commit) starts fresh', async () => {
    const runDir = tempRunDir();
    const resumed = createAgentContext({ runDir, resumed: true, state: null, turns: [{ text: 'fresh' }] });
    expect((await createAgentDriver().next(resumed)).kind).toBe('finish');
  });
});

describe('session continuity', () => {
  it('without an agent parent the first user record carries the conversation so far', async () => {
    const ctx = createAgentContext({ task: 'ok fix it', conversation: { chat: [{ role: 'you', text: 'the mean function is wrong, right?' }, { role: 'jevcode', text: 'Yes.' }], parent: null }, turns: [{ text: 'done' }], testCommand: null });
    await step(createAgentDriver(), ctx);
    const first = (await readTranscript(transcriptPath(ctx.runDir)))![0]!;
    expect(first.kind === 'user' && first.text.startsWith('# Conversation so far\n[you] the mean function is wrong, right?\n[jevcode] Yes.\n\n# Task\nok fix it')).toBe(true);
  });

  it('a follow-up run starts with a carry record naming its parent and replays the parent conversation', async () => {
    const parentDir = tempRunDir();
    const parent = createAgentContext({ runDir: parentDir, task: 'first task', testCommand: null, turns: [{ toolCalls: [call('read_file', { path: 'src/a.py' })] }, { text: 'First run done.' }] });
    await runUntilFinish(createAgentDriver(), parent);
    writeFileSync(join(parentDir, 'state.json'), JSON.stringify({ version: 1, checksum: 'x', state: { stopReason: 'generator_done', agentState: parent.state } }));

    const child = createAgentContext({ task: 'second task', testCommand: null, conversation: { chat: [{ role: 'you', text: 'thanks!' }], parent: { runId: 'run-parent', runDir: parentDir, mode: 'agent' } }, turns: [{ text: 'Second run done.' }] });
    await runUntilFinish(createAgentDriver(), child);
    const records = (await readTranscript(transcriptPath(child.runDir)))!;
    expect(records[0]).toMatchObject({ kind: 'carry', parentRunId: 'run-parent' });
    expect(parseState(child.state)!.carriedFrom).toBe('run-parent');
    const msgs = messagesOf(child, 0);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    const last = msgs.at(-1)!.content[0]!;
    expect(last.type === 'text' && last.text).toBe('# Since the last run\n- it stopped: generator_done\n- conversation since the last run:\n[you] thanks!\n\n# New task\nsecond task');
    // the same session, provider and model: the cache key is stable across the runs
    expect(child.sent[0]!.agent!.cacheKey).toBe(parent.sent[0]!.agent!.cacheKey);
  });
});
