/** The append-only transcript (docs/AGENT-LOOP-DESIGN.md §7.6, §10): persistence, the queue, and the projection. */
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/errors.js';
import { AgentTranscriptMissingError, Transcript, elided, readTranscript, transcriptPath, withoutProviderState, type TranscriptRecord } from '../../../src/agent/transcript.js';
import { tempRunDir } from './helpers.js';

const project = { provider: 'openrouter' as const, model: 'z-ai/glm-5.3-flash', systemHash: 'sys1', replay: true };

async function fresh(): Promise<{ t: Transcript; path: string }> {
  const path = transcriptPath(tempRunDir());
  const t = new Transcript(path, () => Date.parse('2026-09-23T12:00:00Z'));
  await t.reset([]);
  return { t, path };
}

describe('persistence', () => {
  it('appends seq-addressed JSONL records, mode 0600, and reads them back', async () => {
    const { t, path } = await fresh();
    await t.append({ kind: 'user', text: '# Task\nfix it' });
    await t.append({ kind: 'assistant', turn: 1, text: 'Reading.', calls: [{ id: 'c1', name: 'read_file', input: { path: 'a.py' } }], stopReason: 'tool_calls', sys: 'sys1' });
    await t.append({ kind: 'result', turn: 1, toolUseId: 'c1', name: 'read_file', content: 'a.py (lines 1-1 of 1)', isError: false, summary: 'read_file a.py (lines 1-1)' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const back = (await readTranscript(path))!;
    expect(back.map((r) => [r.seq, r.kind])).toEqual([
      [1, 'user'],
      [2, 'assistant'],
      [3, 'result'],
    ]);
    expect(back[0]).toMatchObject({ v: 1, at: '2026-09-23T12:00:00.000Z' });
  });

  it('drops a torn last line and everything after it', async () => {
    const { t, path } = await fresh();
    await t.append({ kind: 'user', text: 'task' });
    appendFileSync(path, '{"v":1,"seq":2,"kind":"note","te');
    expect((await readTranscript(path))!.map((r) => r.seq)).toEqual([1]);
  });

  it('a missing file reads as null, and AgentTranscriptMissingError is a ConfigError naming the path', async () => {
    expect(await readTranscript('/nonexistent/agent/transcript.jsonl')).toBeNull();
    const e = new AgentTranscriptMissingError('/runs/x/agent/transcript.jsonl');
    expect(e).toBeInstanceOf(ConfigError);
    expect(e.exitCode).toBe(2);
    expect(e.message).toContain('/runs/x/agent/transcript.jsonl');
  });

  it('memory is updated before the disk append, and a failed append is rethrown', async () => {
    const t = new Transcript('/dev/null/not-a-dir/transcript.jsonl', () => 0);
    await expect(t.append({ kind: 'user', text: 'x' })).rejects.toThrow();
    expect(t.records.map((r) => r.kind)).toEqual(['user']);
  });

  it('reset rewrites the file (restore truncation)', async () => {
    const { t, path } = await fresh();
    for (let i = 0; i < 4; i += 1) await t.append({ kind: 'note', text: `n${i}`, tag: 'continue' });
    await t.reset(t.records.filter((r) => r.seq <= 2));
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    await t.append({ kind: 'note', text: 'after', tag: 'continue' });
    expect(t.records.map((r) => r.seq)).toEqual([1, 2, 3]);
  });
});

describe('the queue', () => {
  it('is the calls of the latest assistant record that have no result', async () => {
    const { t } = await fresh();
    await t.append({ kind: 'user', text: 'task' });
    await t.append({ kind: 'assistant', text: '', calls: [{ id: 'a', name: 'read_file', input: {} }, { id: 'b', name: 'bash', input: {} }, { id: 'c', name: 'glob', input: {} }], stopReason: 'tool_calls', sys: 's' });
    await t.append({ kind: 'result', toolUseId: 'b', name: 'bash', content: 'x', isError: false, summary: 's' });
    expect(t.unresolved().map((c) => c.id)).toEqual(['a', 'c']);
    expect(t.trailingReply()).toBeNull();
    expect([...t.usedIds()]).toEqual(['a', 'b', 'c']);
  });

  it('a trailing reply is an assistant record without calls at the end', async () => {
    const { t } = await fresh();
    await t.append({ kind: 'user', text: 'hi' });
    await t.append({ kind: 'assistant', text: 'Hello!', calls: [], stopReason: 'stop', sys: 's' });
    expect(t.trailingReply()?.text).toBe('Hello!');
    expect(t.unresolved()).toEqual([]);
  });
});

describe('the projection into request messages', () => {
  async function conversation(): Promise<Transcript> {
    const { t } = await fresh();
    await t.append({ kind: 'user', text: 'task' });
    await t.append({ kind: 'assistant', text: 'Two reads.', calls: [{ id: 'r1', name: 'read_file', input: { path: 'a' } }, { id: 'r2', name: 'read_file', input: { path: 'b' } }], providerState: { provider: 'openrouter', model: 'z-ai/glm-5.3-flash', data: { reasoning_details: [] } }, stopReason: 'tool_calls', sys: 'sys1' });
    await t.append({ kind: 'result', toolUseId: 'r2', name: 'read_file', content: 'B'.repeat(900), isError: false, summary: 'read_file b (lines 1-1)' });
    await t.append({ kind: 'note', text: '[message from the user while you were working]\nalso check c', tag: 'steer' });
    await t.append({ kind: 'result', toolUseId: 'r1', name: 'read_file', content: 'ERROR: a: no such file', isError: true, summary: 'read_file a (error)' });
    return t;
  }

  it('puts tool results first in call order, then the text blocks, in one user message', async () => {
    const t = await conversation();
    const msgs = t.messages(project);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Two reads.' }, { type: 'tool_use', id: 'r1' }, { type: 'tool_use', id: 'r2' }] });
    expect(msgs[2]!.content.map((b) => (b.type === 'tool_result' ? `result:${b.toolUseId}${b.isError === true ? '!' : ''}` : b.type))).toEqual(['result:r1!', 'result:r2', 'text']);
  });

  it('replays providerState only to the same provider, configured model and system prompt, and only when replay is on', async () => {
    const t = await conversation();
    expect(t.messages(project)[1]).toHaveProperty('providerState');
    expect(t.messages({ ...project, replay: false })[1]).not.toHaveProperty('providerState');
    expect(t.messages({ ...project, model: 'z-ai/glm-6' })[1]).not.toHaveProperty('providerState');
    expect(t.messages({ ...project, provider: 'anthropic' })[1]).not.toHaveProperty('providerState');
    expect(t.messages({ ...project, systemHash: 'sys2' })[1]).not.toHaveProperty('providerState');
  });

  it('elides masked results, keeping the call and a pointer', async () => {
    const t = await conversation();
    await t.append({ kind: 'mask', ids: ['r2'] });
    const r2 = t.messages(project)[2]!.content.find((b) => b.type === 'tool_result' && b.toolUseId === 'r2')!;
    expect(r2.type === 'tool_result' && r2.content).toBe('[elided: read_file b (lines 1-1) — 900 chars; call it again if you need it]');
  });

  it('a masked result whose output was spilled names its file', () => {
    const r: Parameters<typeof elided>[0] = { v: 1, seq: 3, at: 'x', kind: 'result', toolUseId: 'b1', name: 'bash', content: 'x'.repeat(900), isError: false, summary: 'bash cat big.log (exit 0)', pointer: 'jevcode:outputs/step-2.txt' };
    expect(elided(r)).toBe('[elided: bash cat big.log (exit 0) — 900 chars; full output: jevcode:outputs/step-2.txt]');
    expect(elided({ ...r, summary: 'invalid (rejected)', name: 'Frobnicate' })).toBe('[elided: Frobnicate invalid (rejected) — 900 chars; full output: jevcode:outputs/step-2.txt]');
  });

  it('a compaction replaces everything before it with one user message', async () => {
    const t = await conversation();
    await t.append({ kind: 'compaction', text: '# Context summary\n…\nContinue with the task.', fromSeq: 1, toSeq: 5, by: 'code' });
    const msgs = t.messages(project);
    expect(msgs).toEqual([{ role: 'user', content: [{ type: 'text', text: '# Context summary\n…\nContinue with the task.' }] }]);
    expect(t.latestAssistant()).toBeNull();
  });

  it('strips every providerState for a carry across a changed prefix', async () => {
    const t = await conversation();
    const stripped = withoutProviderState(t.records);
    expect(stripped.some((r: TranscriptRecord) => r.kind === 'assistant' && 'providerState' in r)).toBe(false);
    expect(t.records.some((r) => r.kind === 'assistant' && 'providerState' in r)).toBe(true);
  });
});
