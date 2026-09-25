/** The head of a fresh run (docs/AGENT-LOOP-DESIGN.md §5.3, §7.6): the first user message, and the carry of an agent parent. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineSeed } from '../../../src/core/types.js';
import { buildHead, chatLines, firstUserMessage, testCommandLine } from '../../../src/agent/head.js';
import { scopeBuilderFor } from '../../../src/workspace/tests.js';
import { initialState } from '../../../src/agent/state.js';
import type { TranscriptRecord } from '../../../src/agent/transcript.js';
import { repoState } from '../loop/fakes.js';
import { createAgentContext, tempRunDir } from './helpers.js';

const at = '2026-09-23T10:00:00.000Z';

function writeParent(o: { transcriptSeq: number; systemHash: string; stopReason: string; records: TranscriptRecord[]; envelope?: boolean }): string {
  const dir = tempRunDir();
  const state = { runId: 'parent-run', stopReason: o.stopReason, agentState: { ...initialState(o.systemHash), transcriptSeq: o.transcriptSeq } };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(o.envelope === false ? state : { version: 1, checksum: 'x', state }));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ runId: 'parent-run', task: 'parent task' }));
  mkdirSync(join(dir, 'agent'), { recursive: true });
  writeFileSync(join(dir, 'agent', 'transcript.jsonl'), o.records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  return dir;
}

const parentRecords: TranscriptRecord[] = [
  { v: 1, seq: 1, at, kind: 'user', text: '# Task\nfirst task' },
  { v: 1, seq: 2, at, kind: 'assistant', text: 'Reading.', calls: [{ id: 'p1', name: 'read_file', input: { path: 'a.py' } }], providerState: { provider: 'openrouter', model: 'z-ai/glm-5.3-flash', data: { reasoning_details: [{ type: 'reasoning.text', text: 'hm' }] } }, stopReason: 'tool_calls', sys: 'H' },
  { v: 1, seq: 3, at, kind: 'result', toolUseId: 'p1', name: 'read_file', content: 'a.py (lines 1-1 of 1)', isError: false, summary: 'read_file a.py' },
  { v: 1, seq: 4, at, kind: 'assistant', text: 'Now edit.', calls: [{ id: 'p2', name: 'edit_file', input: { path: 'a.py', old_string: 'a', new_string: 'b' } }, { id: 'p3', name: 'bash', input: { command: 'pytest -q' } }], stopReason: 'tool_calls', sys: 'H' },
  { v: 1, seq: 5, at, kind: 'result', toolUseId: 'p2', name: 'edit_file', content: 'OK: edited a.py', isError: false, summary: 'edit_file a.py' },
  // past the parent checkpoint: never committed, so it is not carried
  { v: 1, seq: 6, at, kind: 'result', toolUseId: 'p3', name: 'bash', content: 'exit 0', isError: false, summary: 'bash pytest -q' },
];

describe('the first user message (no agent parent)', () => {
  it('carries the conversation so far, the task and a deterministic workspace block', async () => {
    const ctx = createAgentContext({
      task: 'ok fix it',
      files: { 'package.json': '{"name":"x","type":"module"}', 'src/math.js': '', 'test/all.test.js': '', 'README.md': '' },
      testCommand: { command: 'npm test', runner: 'npm' },
      gitState: repoState({ dirty: ['src/math.js'], untracked: ['notes.txt'] }),
      conversation: { chat: [{ role: 'you', text: 'the mean function divides by the wrong number, right?' }, { role: 'jevcode', text: 'Yes — it divides by len - 1.' }], parent: null },
    });
    const text = await firstUserMessage(ctx);
    expect(text).toBe(
      [
        '# Conversation so far',
        '[you] the mean function divides by the wrong number, right?',
        '[jevcode] Yes — it divides by len - 1.',
        '',
        '# Task',
        'ok fix it',
        '',
        '# Workspace',
        '- root: ws (your working directory: tool paths are relative to it, so `src/a.ts`, never `ws/src/a.ts`); git: main, 1 modified, 1 untracked',
        '- your uncommitted changes: src/math.js, notes.txt',
        '- detected: package.json (node, type module)',
        '- test command: `npm test` (the whole suite)',
        '- top level: src/ test/ README.md package.json',
      ].join('\n'),
    );
  });

  it('the test command line says it is the whole suite, and names its one-file form when the runner can scope (a targeted check is what the prompt asks for)', () => {
    expect(testCommandLine(null)).toBe('none detected');
    expect(testCommandLine({ command: 'npm test', runner: 'npm' })).toBe('`npm test` (the whole suite)');
    const scope = scopeBuilderFor('pytest', 'pytest -q');
    expect(scope).not.toBeNull();
    expect(testCommandLine({ command: 'pytest -q', runner: 'pytest', scope: scope! })).toBe(`\`pytest -q\` (the whole suite); one file: \`${scope!(['<file>'])}\``);
    expect(scope!(['<file>'])).toContain('<file>');
    // a package-manager `test` script names what it runs, and a single runner command takes a file at its end
    expect(testCommandLine({ command: 'npm test', runner: 'npm' }, 'node --test')).toBe('`npm test` (the whole suite; it runs `node --test`); one file: `npm test -- <file>`');
    expect(testCommandLine({ command: 'pnpm run test', runner: 'npm' }, '  vitest   run ')).toBe('`pnpm run test` (the whole suite; it runs `vitest run`); one file: `pnpm run test -- <file>`');
    expect(testCommandLine({ command: 'yarn test', runner: 'npm' }, 'jest')).toBe('`yarn test` (the whole suite; it runs `jest`); one file: `yarn test <file>`');
    // a chain would hand the file to its last part only: no one-file form
    expect(testCommandLine({ command: 'npm test', runner: 'npm' }, 'tsc && node --test')).toBe('`npm test` (the whole suite; it runs `tsc && node --test`)');
    expect(testCommandLine({ command: 'make test', runner: 'unknown' }, 'node --test')).toBe('`make test` (the whole suite)');
    expect(testCommandLine({ command: 'npm test', runner: 'npm' }, '')).toBe('`npm test` (the whole suite)');
  });

  it('the workspace block reads the test script from package.json', async () => {
    const ctx = createAgentContext({ files: { 'package.json': '{"name":"x","scripts":{"test":"vitest run"}}', 'src/a.ts': '' }, testCommand: { command: 'npm test', runner: 'npm' }, gitState: null });
    expect(await firstUserMessage(ctx)).toContain('- test command: `npm test` (the whole suite; it runs `vitest run`); one file: `npm test -- <file>`');
  });

  it('drops the "never <root>/…" example when the workspace has a top-level entry named like its root (a package named like its repo)', async () => {
    const ctx = createAgentContext({ files: { 'ws/__init__.py': '', 'setup.py': '' }, testCommand: null, gitState: null });
    const text = await firstUserMessage(ctx);
    expect(text).toContain('- root: ws (your working directory: tool paths are relative to it); git repository');
    expect(text).not.toContain('never `ws/');
  });

  it('omits the conversation and the uncommitted line when there is no signal, and says so outside git', async () => {
    const ctx = createAgentContext({ files: { 'a.py': '' }, testCommand: null, gitState: null });
    const text = await firstUserMessage(ctx);
    expect(text).not.toContain('# Conversation so far');
    expect(text).not.toContain('uncommitted');
    expect(text).toContain('- test command: none detected');
    expect(text).toContain('- detected: no known manifest');
  });

  it('keeps the newest 20 chat turns within 14,000 chars', () => {
    const many = Array.from({ length: 30 }, (_v, i) => ({ role: 'you' as const, text: `turn ${i}` }));
    const kept = chatLines(many);
    expect(kept).toHaveLength(20);
    expect(kept[0]).toBe('[you] turn 10');
    expect(kept[19]).toBe('[you] turn 29');
    const long = Array.from({ length: 5 }, (_v, i) => ({ role: 'jevcode' as const, text: `${i}${'x'.repeat(5_000)}` }));
    expect(chatLines(long)).toHaveLength(2);
  });

  it('adds the legacy parent block from the EngineSeed, and the pinned files', async () => {
    const seed: EngineSeed = {
      parentRunId: 'legacy-1',
      plan: { done: [{ text: 'found the bug', evidence: { step: 2, judged: -1 } }], remaining: ['fix it'], unverified: [], openProblems: [], harnessProblems: [] },
      window: [{ step: 3, intent: null, action: 'run pytest -q', outcome: 'executed', shownFiles: [], notes: [] }],
      createdThisRun: [],
      lastTestRun: { step: 3, command: 'pytest -q', passed: 2, failed: 1, errors: 0, allPassed: false },
      undoLog: [{ runId: 'legacy-1', step: 2, at, by: 'undo', restored: ['a.py'], skipped: [] }],
      pinnedFiles: ['src/a.py'],
    };
    const parentDir = tempRunDir();
    writeFileSync(join(parentDir, 'run.json'), JSON.stringify({ task: 'the legacy task' }));
    writeFileSync(join(parentDir, 'state.json'), JSON.stringify({ version: 1, checksum: 'x', state: { stopReason: 'generator_done' } }));
    const ctx = createAgentContext({ seed, conversation: { chat: [], parent: { runId: 'legacy-1', runDir: parentDir, mode: 'llm-jev' } } });
    const text = await firstUserMessage(ctx);
    expect(text).toContain(
      [
        '# Previous run in this session',
        '- task: the legacy task; stopped: generator_done',
        '- plan: found the bug / remaining: fix it',
        '- last steps: step 3: run pytest -q → executed',
        '- last test run: `pytest -q` 2/1/0 (step 3)',
        '- undone since: step 2 (undo: a.py)',
      ].join('\n'),
    );
    expect(text).toContain('# Pinned files\n### src/a.py\ndef f():\n    return 1\n');
  });
});

describe('the carry of an agent parent', () => {
  it('copies the records up to the checkpoint behind a carry record, answers the unrun call and appends the continuation', async () => {
    const dir = writeParent({ transcriptSeq: 5, systemHash: 'H', stopReason: 'human_pause', records: parentRecords });
    const ctx = createAgentContext({ task: 'now make capitalize handle empty input', conversation: { chat: [{ role: 'you', text: 'thanks' }, { role: 'jevcode', text: 'You are welcome.' }], parent: { runId: 'parent-run', runDir: dir, mode: 'agent' } } });
    const head = await buildHead(ctx, 'H');
    expect(head.carriedFrom).toBe('parent-run');
    expect(head.records.map((r) => [r.seq, r.kind])).toEqual([
      [1, 'carry'],
      [2, 'user'],
      [3, 'assistant'],
      [4, 'result'],
      [5, 'assistant'],
      [6, 'result'],
      [7, 'result'],
      [8, 'user'],
    ]);
    expect(head.records[0]).toMatchObject({ kind: 'carry', parentRunId: 'parent-run', parentSeq: 5 });
    expect(head.records[6]).toMatchObject({ kind: 'result', toolUseId: 'p3', isError: true, content: 'NOT EXECUTED: the previous run stopped (human_pause) before this call ran.' });
    const cont = head.records[7]!;
    expect(cont.kind === 'user' && cont.text).toBe(
      ['# Since the last run', '- it stopped: human_pause', '- conversation since the last run:', '[you] thanks', '[jevcode] You are welcome.', '', '# New task', 'now make capitalize handle empty input'].join('\n'),
    );
    // same system prompt, provider and model: the reasoning state is kept
    expect(head.records[2]!.kind === 'assistant' && head.records[2]!.providerState).toBeDefined();
  });

  it('strips providerState when the system prompt changed', async () => {
    const dir = writeParent({ transcriptSeq: 5, systemHash: 'OLD', stopReason: 'generator_done', records: parentRecords, envelope: false });
    const ctx = createAgentContext({ conversation: { chat: [], parent: { runId: 'parent-run', runDir: dir, mode: 'agent' } } });
    const head = await buildHead(ctx, 'NEW');
    expect(head.records.some((r) => r.kind === 'assistant' && r.providerState !== undefined)).toBe(false);
  });

  it('strips providerState when the model changed', async () => {
    const dir = writeParent({ transcriptSeq: 5, systemHash: 'H', stopReason: 'generator_done', records: parentRecords });
    const ctx = createAgentContext({ provider: { name: 'openrouter', model: 'z-ai/glm-6' }, conversation: { chat: [], parent: { runId: 'parent-run', runDir: dir, mode: 'agent' } } });
    const head = await buildHead(ctx, 'H');
    expect(head.records.some((r) => r.kind === 'assistant' && r.providerState !== undefined)).toBe(false);
  });

  it('copies from the parent\'s latest compaction on, keeping its first user record as the head', async () => {
    const records: TranscriptRecord[] = [
      ...parentRecords.slice(0, 5),
      { v: 1, seq: 6, at, kind: 'compaction', text: '# Task\nfirst task\n\n# Context summary\n…\n\nContinue with the task.', fromSeq: 1, toSeq: 5, by: 'code' },
      { v: 1, seq: 7, at, kind: 'assistant', text: 'Continuing.', calls: [{ id: 'p4', name: 'glob', input: { pattern: '*' } }], stopReason: 'tool_calls', sys: 'H' },
      { v: 1, seq: 8, at, kind: 'result', toolUseId: 'p4', name: 'glob', content: 'a.py', isError: false, summary: 'glob *' },
      { v: 1, seq: 9, at, kind: 'assistant', text: 'Done.', calls: [], stopReason: 'stop', sys: 'H' },
    ];
    const dir = writeParent({ transcriptSeq: 9, systemHash: 'H', stopReason: 'generator_done', records });
    const ctx = createAgentContext({ task: 'next', conversation: { chat: [], parent: { runId: 'parent-run', runDir: dir, mode: 'agent' } } });
    const head = await buildHead(ctx, 'H');
    expect(head.records.map((r) => r.kind)).toEqual(['carry', 'user', 'compaction', 'assistant', 'result', 'assistant', 'user']);
    expect(head.records[1]!.kind === 'user' && head.records[1]!.text).toBe('# Task\nfirst task');
    expect(head.records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('falls back to the first user message when the parent cannot be read', async () => {
    const ctx = createAgentContext({ task: 'x', conversation: { chat: [{ role: 'you', text: 'hello' }], parent: { runId: 'gone', runDir: '/nonexistent/run', mode: 'agent' } } });
    const head = await buildHead(ctx, 'H');
    expect(head.carriedFrom).toBeNull();
    expect(head.records).toHaveLength(1);
    expect(head.records[0]!.kind === 'user' && head.records[0]!.text.startsWith('# Conversation so far\n[you] hello\n\n# Task\nx')).toBe(true);
  });
});
