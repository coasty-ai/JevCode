/**
 * The driver's segmenting of a turn (docs/AGENT-LOOP-DESIGN.md §3.1, §3.2): maximal runs of resolvable calls as observe
 * steps (in batches of 8), one mutating call per act step, the queue re-derived from the transcript (so a discarded
 * step's call is simply issued again), steers, and the act mappings of edit_file, write_file and bash.
 */
import { describe, expect, it } from 'vitest';
import type { AgentNext, ExecResult, SandboxRunOptions } from '../../../src/core/types.js';
import { createAgentDriver } from '../../../src/agent/index.js';
import { call, createAgentContext, messagesOf, step, userText } from './helpers.js';

function kinds(steps: { next: AgentNext }[]): string[] {
  return steps.map((s) => s.next.kind);
}

describe('segmenting', () => {
  it('reads, then an edit, then reads → observe, act, observe, in call order', async () => {
    const ctx = createAgentContext({
      turns: [
        { text: 'Looking around.', toolCalls: [call('read_file', { path: 'src/a.py' }), call('glob', { pattern: '**/*.py' }), call('edit_file', { path: 'src/a.py', old_string: 'return 1', new_string: 'return 2' }), call('read_file', { path: 'src/a.py' }), call('grep', { pattern: 'return' })] },
        { text: 'Done.' },
      ],
      testCommand: null,
    });
    const d = createAgentDriver();
    const steps = [await step(d, ctx), await step(d, ctx), await step(d, ctx), await step(d, ctx)];
    expect(kinds(steps)).toEqual(['observe', 'act', 'observe', 'finish']);
    const [s1, s2, s3] = steps.map((s) => s.next);
    expect(s1!.kind === 'observe' && s1!.summary.calls.map((c) => c.name)).toEqual(['read_file', 'glob']);
    expect(s1!.summary.turn).toBe(1);
    expect(s2!.kind === 'act' && s2!.proposal.action).toEqual({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' });
    expect(s2!.summary.turn).toBeNull();
    expect(s3!.kind === 'observe' && s3!.summary.calls.map((c) => c.name)).toEqual(['read_file', 'grep']);
    // the re-read sees the edit
    expect(userText(ctx, 1)).toContain('     2\t    return 2');
    // one request for the whole turn, and its first call's proposal carries the prose
    expect(ctx.sent).toHaveLength(2);
    expect(s1!.proposal.rawText.startsWith('Looking around.\nread_file {"path":"src/a.py"}')).toBe(true);
  });

  it('a batch of 10 read-only calls runs 8 then 2 concurrently, each batch announced before it starts', async () => {
    const ctx = createAgentContext({ turns: [{ toolCalls: Array.from({ length: 10 }, (_v, i) => call('bash', { command: `cat f${i}.txt` })) }, { text: 'ok' }], testCommand: null });
    let inFlight = 0;
    const peaks: number[] = [];
    const run = ctx.sb.run.bind(ctx.sb);
    ctx.sb.run = async (command: string, o: SandboxRunOptions): Promise<ExecResult> => {
      inFlight += 1;
      peaks.push(inFlight);
      await new Promise((r) => setTimeout(r, 15));
      const res = await run(command, o);
      inFlight -= 1;
      return res;
    };
    const s = await step(createAgentDriver(), ctx);
    expect(s.next.kind).toBe('observe');
    expect(Math.max(...peaks)).toBe(8);
    const order = ctx.events.filter((e) => e.type === 'tool:call' || e.type === 'tool:result').map((e) => (e.type === 'tool:call' ? 'C' : 'R')).join('');
    expect(order).toBe('CCCCCCCCRRRRRRRRCCRR');
    // several commands in one step spill into step-N-<k>.txt
    expect(s.next.kind === 'observe' && s.next.summary.calls).toHaveLength(10);
  });

  it('ten read_file calls resolve in one observe step, announced 8 then 2, results in call order', async () => {
    const files = Object.fromEntries(Array.from({ length: 10 }, (_v, i) => [`f${i}.txt`, `content ${i}\n`]));
    const ctx = createAgentContext({ files, turns: [{ toolCalls: Array.from({ length: 10 }, (_v, i) => call('read_file', { path: `f${i}.txt` })) }, { text: 'ok' }], testCommand: null });
    const d = createAgentDriver();
    const s = await step(d, ctx);
    expect(s.next.kind === 'observe' && s.next.proposal.action).toEqual({ kind: 'read', paths: Array.from({ length: 10 }, (_v, i) => `f${i}.txt`) });
    const order = ctx.events.filter((e) => e.type === 'tool:call' || e.type === 'tool:result').map((e) => (e.type === 'tool:call' ? 'C' : 'R')).join('');
    expect(order).toBe('CCCCCCCCRRRRRRRRCCRR');
    await step(d, ctx);
    const results = messagesOf(ctx, 1).at(-1)!.content.map((b) => (b.type === 'tool_result' ? b.content.split('\n')[1] : ''));
    expect(results).toEqual(Array.from({ length: 10 }, (_v, i) => `     1\tcontent ${i}`));
  });

  it('`git diff` and `ls` join the observe batch; `npm install` is an act step', async () => {
    const ctx = createAgentContext({ turns: [{ toolCalls: [call('bash', { command: 'git diff' }), call('bash', { command: 'ls -la' }), call('bash', { command: 'npm install' })] }, { text: 'ok' }], testCommand: null });
    const d = createAgentDriver();
    const s1 = await step(d, ctx);
    const s2 = await step(d, ctx);
    expect(s1.next.kind === 'observe' && s1.next.summary.calls.map((c) => c.summary)).toEqual(['bash git diff (exit 0)', 'bash ls -la (exit 0)']);
    expect(s1.next.proposal.action).toEqual({ kind: 'read', paths: [] });
    expect(s2.next.kind === 'act' && s2.next.proposal.action).toEqual({ kind: 'run', command: 'npm install', timeoutMs: 120_000 });
    expect(ctx.sb.commands).toEqual(['git diff', 'ls -la', 'npm install']);
  });

  it('invalid calls become error results in an observe step, and the loop goes on', async () => {
    const ctx = createAgentContext({ turns: [{ toolCalls: [call('browse', { url: 'x' }), call('read_file', {}), call('edit_file', { path: 'src/a.py', old_string: 'nope', new_string: 'x' })] }, { text: 'ok' }], testCommand: null });
    const d = createAgentDriver();
    const s1 = await step(d, ctx);
    expect(s1.next.kind === 'observe' && s1.next.summary.calls.map((c) => [c.name, c.ok])).toEqual([
      ['invalid', false],
      ['read_file', false],
      ['edit_file', false],
    ]);
    expect((await step(d, ctx)).next.kind).toBe('finish');
    const results = messagesOf(ctx, 1).at(-1)!.content.map((b) => (b.type === 'tool_result' ? b.content : ''));
    expect(results[0]).toMatch(/^UNKNOWN TOOL browse\./);
    expect(results[1]).toMatch(/^INVALID ARGUMENTS for read_file: path is required\./);
    expect(results[2]).toMatch(/^ERROR: old_string not found in src\/a\.py\./);
  });

  it('a tool that throws unexpectedly (while preparing or running) is an error result, not a failed step', async () => {
    const ctx = createAgentContext({ turns: [{ toolCalls: [call('read_file', { path: 'locked.txt' }), call('edit_file', { path: 'locked.txt', old_string: 'a', new_string: 'b' })] }, { text: 'ok' }], testCommand: null });
    const read = ctx.fs.read.bind(ctx.fs);
    ctx.fs.read = async (path, max) => {
      if (path === 'locked.txt') throw new Error('EACCES: permission denied, open locked.txt');
      return read(path, max);
    };
    const d = createAgentDriver();
    const s = await step(d, ctx);
    expect(s.next.kind === 'observe' && s.next.summary.calls.map((c) => [c.name, c.ok])).toEqual([
      ['read_file', false],
      ['edit_file', false],
    ]);
    await step(d, ctx);
    const results = messagesOf(ctx, 1).at(-1)!.content.map((b) => (b.type === 'tool_result' ? b.content : ''));
    expect(results).toEqual(['ERROR: EACCES: permission denied, open locked.txt', 'ERROR: EACCES: permission denied, open locked.txt']);
  });

  it('keeps 32 calls of a reply and answers the rest NOT_EXECUTED_TOO_MANY', async () => {
    const ctx = createAgentContext({ turns: [{ toolCalls: Array.from({ length: 34 }, (_v, i) => call('glob', { pattern: `*.x${i}` })) }, { text: 'ok' }], testCommand: null });
    const d = createAgentDriver();
    const s = await step(d, ctx);
    expect(s.next.kind === 'observe' && s.next.summary.calls).toHaveLength(32);
    await step(d, ctx);
    const results = messagesOf(ctx, 1).at(-1)?.content ?? [];
    expect(results.filter((b) => b.type === 'tool_result' && b.content.startsWith('NOT EXECUTED: more than 32 tool calls'))).toHaveLength(2);
  });

  it('calls the model wrote as GLM XML are run and replayed as native tool_use blocks', async () => {
    const ctx = createAgentContext({ turns: [{ text: 'Checking.\n<tool_call>read_file<arg_key>path</arg_key><arg_value>src/a.py</arg_value></tool_call>' }, { text: 'ok' }], testCommand: null });
    const d = createAgentDriver();
    const s = await step(d, ctx);
    expect(s.next.kind).toBe('observe');
    await step(d, ctx);
    const assistant = messagesOf(ctx, 1)[1]!;
    expect(assistant).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'call_1_0', name: 'read_file', input: { path: 'src/a.py' } }] });
  });
});

describe('discards and steers', () => {
  it('an act step with no observe() is issued again by the next next()', async () => {
    const ctx = createAgentContext({ turns: [{ toolCalls: [call('bash', { command: 'npm install' }, 'tc_9')] }], testCommand: null });
    const d = createAgentDriver();
    const first = await d.next(ctx);
    const again = await d.next(ctx);
    if (first.kind !== 'act' || again.kind !== 'act') throw new Error('expected two act steps');
    expect(again.callId).toBe(first.callId);
    expect(again.proposal).toEqual(first.proposal);
    expect(ctx.sent).toHaveLength(1);
  });

  it('a steer answers every unresolved call and reaches the model as a note', async () => {
    const ctx = createAgentContext({ turns: [{ toolCalls: [call('read_file', { path: 'src/a.py' }), call('bash', { command: 'npm install' }), call('glob', { pattern: '*' })] }, { text: 'Understood.' }], testCommand: null });
    const d = createAgentDriver();
    expect((await step(d, ctx)).next.kind).toBe('observe');
    ctx.steerQueue.push('stop, use pnpm instead');
    const s = await step(d, ctx);
    expect(s.next.kind).toBe('finish');
    const tail = messagesOf(ctx, 1).at(-1)!;
    expect(tail.content.map((b) => (b.type === 'tool_result' ? `${b.toolUseId}:${b.content}` : b.type === 'text' ? `text:${b.text}` : b.type))).toEqual([
      'call_1_0:src/a.py (lines 1-2 of 2)\n     1\tdef f():\n     2\t    return 1',
      'call_1_1:NOT EXECUTED: the user sent new instructions before this call ran.',
      'call_1_2:NOT EXECUTED: the user sent new instructions before this call ran.',
      'text:[message from the user while you were working]\nstop, use pnpm instead',
    ]);
    expect(ctx.sb.commands).not.toContain('npm install');
  });
});

describe('act mappings', () => {
  it('edit_file maps to the matched span with new_string re-indented; replace_all to a write; write_file to a write; bash to run with cwd', async () => {
    const ctx = createAgentContext({
      files: { 'pkg/m.py': 'def f():\n    if x:\n        return 1\n', 'r.txt': 'a a a\n' },
      turns: [
        { toolCalls: [call('edit_file', { path: 'pkg/m.py', old_string: 'if x:\n    return 1', new_string: 'if x:\n    return 2' })] },
        { toolCalls: [call('edit_file', { path: 'r.txt', old_string: 'a', new_string: 'b', replace_all: true })] },
        { toolCalls: [call('write_file', { path: 'new/n.txt', content: 'hello\n' })] },
        { toolCalls: [call('bash', { command: 'make', workdir: 'pkg', timeout_ms: 30_000 })] },
        { text: 'ok' },
      ],
      testCommand: null,
    });
    const d = createAgentDriver();
    const acts = [await step(d, ctx), await step(d, ctx), await step(d, ctx), await step(d, ctx)].map((s) => s.next.proposal.action);
    expect((await step(d, ctx)).next.kind).toBe('finish');
    expect(acts).toEqual([
      { kind: 'edit', path: 'pkg/m.py', old: '    if x:\n        return 1', new: '    if x:\n        return 2' },
      { kind: 'write', path: 'r.txt', content: 'b b b\n' },
      { kind: 'write', path: 'new/n.txt', content: 'hello\n' },
      { kind: 'run', command: 'make', timeoutMs: 30_000, cwd: 'pkg' },
    ]);
    // the results the model reads
    const text = userText(ctx, 4);
    expect(text).toContain('OK: edited pkg/m.py (1 replacement, lines 2-3) (matched after normalising indentation; new_string re-indented by 4)');
    expect(text).toContain('OK: edited r.txt (3 replacements)');
    expect(text).toContain('OK: created new/n.txt (1 lines)');
    expect(text).toMatch(/exit 0 · \d+(\.\d)?s · in pkg/);
  });

  it('write_file into .git, a placeholder, and an edit of a missing file are rejected before anything runs', async () => {
    const ctx = createAgentContext({ turns: [{ toolCalls: [call('write_file', { path: '.git/config', content: 'x' }), call('write_file', { path: 'a.ts', content: 'x\n// ... rest of the file unchanged\n' }), call('edit_file', { path: 'gone.py', old_string: 'a', new_string: 'b' })] }, { text: 'ok' }], testCommand: null });
    const d = createAgentDriver();
    const s = await step(d, ctx);
    expect(s.next.kind).toBe('observe');
    await step(d, ctx);
    const results = messagesOf(ctx, 1).at(-1)!.content.map((b) => (b.type === 'tool_result' ? b.content : ''));
    expect(results).toEqual([
      'ERROR: .git/config is inside .git; the harness never writes there (rule git_internals)',
      'ERROR: content contains a placeholder ("// ... rest of the file unchanged"); write the complete file',
      'ERROR: gone.py: no such file (use write_file to create it)',
    ]);
  });

  it('notes a stale read, and appends new syntax errors to an edit result', async () => {
    const ctx = createAgentContext({
      files: { 'c.json': '{"a": 1}\n' },
      turns: [
        { toolCalls: [call('read_file', { path: 'c.json' })] },
        { toolCalls: [call('edit_file', { path: 'c.json', old_string: '"a": 1', new_string: '"a": ' })] },
        { text: 'ok' },
      ],
      testCommand: null,
    });
    const d = createAgentDriver();
    await step(d, ctx);
    ctx.fs.files.set('c.json', '{"a": 1, "b": 2}\n');
    await step(d, ctx);
    await step(d, ctx);
    const result = messagesOf(ctx, 2).at(-1)!.content[0]!;
    expect(result.type === 'tool_result' && result.content.split('\n')[0]).toBe('OK: edited c.json (1 replacement, lines 1-1) (note: c.json changed since you last read it)');
    expect(result.type === 'tool_result' && result.content).toContain('\nsyntax check:\n');
  });

  it("the agent's own edit is not a stale read: a second edit of the same file carries no note", async () => {
    const ctx = createAgentContext({
      files: { 'a.txt': 'one\ntwo\n' },
      turns: [
        { toolCalls: [call('read_file', { path: 'a.txt' })] },
        { toolCalls: [call('edit_file', { path: 'a.txt', old_string: 'one', new_string: 'ONE' })] },
        { toolCalls: [call('edit_file', { path: 'a.txt', old_string: 'two', new_string: 'TWO' })] },
        { text: 'ok' },
      ],
      testCommand: null,
    });
    const d = createAgentDriver();
    for (let i = 0; i < 4; i += 1) await step(d, ctx);
    expect(userText(ctx, 3)).not.toContain('changed since you last read it');
    expect(ctx.fs.files.get('a.txt')).toBe('ONE\nTWO\n');
  });

  it('a call runs with the text the model sent, while the transcript records it redacted', async () => {
    const ctx = createAgentContext({ turns: [{ toolCalls: [call('write_file', { path: 'fixture.txt', content: 'token=sk-secret-abc123\n' })] }, { text: 'ok' }], testCommand: null });
    const d = createAgentDriver();
    await step(d, ctx);
    await step(d, ctx);
    expect(ctx.fs.files.get('fixture.txt')).toBe('token=sk-secret-abc123\n');
    const assistant = messagesOf(ctx, 1)[1]!;
    const use = assistant.content.find((b) => b.type === 'tool_use')!;
    expect(use.type === 'tool_use' && use.input).toEqual({ path: 'fixture.txt', content: 'token=[REDACTED]\n' });
  });

  it('a write or a command cut off at the output limit is TRUNCATED_CALL, never run with the repaired prefix', async () => {
    const cut = [
      { name: 'write_file', input: null, rawJson: '{"path":"big.py","content":"def f():\\n    return 1\\n\\ndef g():\\n    ret' },
      { name: 'bash', input: null, rawJson: '{"command": "rm -rf build/tmp/cache && echo do' },
    ];
    for (const [i, c] of cut.entries()) {
      const ctx = createAgentContext({ turns: [{ text: 'Writing it.', toolCalls: [c], stopReason: i === 0 ? 'length' : 'max_tokens' }, { text: 'ok' }], testCommand: null, maxTokens: 16384 });
      const d = createAgentDriver();
      const s = await step(d, ctx);
      expect(s.next.kind).toBe('observe');
      expect(s.next.proposal.action.kind).toBe('read');
      await step(d, ctx);
      const results = messagesOf(ctx, 1).at(-1)!.content.map((b) => (b.type === 'tool_result' ? b.content : ''));
      expect(results).toEqual(['Your reply was cut off at the output limit (16384 tokens) while writing this call. Split large changes into several smaller edit_file calls, or write a large file in parts.']);
      expect(ctx.fs.files.has('big.py')).toBe(false);
      expect(ctx.sb.commands.some((x) => x.includes('rm -rf'))).toBe(false);
      // the replayed tool_use carries no truncated arguments
      const use = messagesOf(ctx, 1)[1]!.content.find((b) => b.type === 'tool_use')!;
      expect(use.type === 'tool_use' && use.input).toEqual({});
    }
  });

  it('edit_file never rewrites a whole file from its redacted view; a single exact edit still applies to the real file', async () => {
    const secret = 'KEY = "sk-secret-abc123"\n';
    const ctx = createAgentContext({
      files: { 'cfg.py': `${secret}name = "foo"\nother = "foo"\n`, 'm.py': `${secret}foo()\nxfoo()\n` },
      turns: [
        { toolCalls: [call('edit_file', { path: 'cfg.py', old_string: 'foo', new_string: 'bar', replace_all: true }), call('edit_file', { path: 'm.py', old_string: '  foo()', new_string: 'bar()' })] },
        { toolCalls: [call('edit_file', { path: 'cfg.py', old_string: 'name = "foo"', new_string: 'name = "bar"' })] },
        { text: 'ok' },
      ],
      testCommand: null,
    });
    // the real Workspace.read redacts what it returns (src/workspace/files.ts)
    const read = ctx.fs.read.bind(ctx.fs);
    ctx.fs.read = async (path, max) => {
      const v = await read(path, max);
      return { ...v, content: ctx.redact(v.content) };
    };
    const d = createAgentDriver();
    const steps = [await step(d, ctx), await step(d, ctx), await step(d, ctx)];
    expect(steps.map((x) => x.next.kind)).toEqual(['observe', 'act', 'finish']);
    const rejected = messagesOf(ctx, 1).at(-1)!.content.map((b) => (b.type === 'tool_result' ? b.content : ''));
    expect(rejected).toEqual([
      'ERROR: cfg.py contains text the harness redacts, so edit_file cannot rewrite the whole file safely; edit each occurrence with its own edit_file call and a unique old_string',
      'ERROR: m.py contains text the harness redacts, so edit_file cannot rewrite the whole file safely; edit each occurrence with its own edit_file call and a unique old_string',
    ]);
    for (const x of steps) expect(JSON.stringify(x.next.proposal.action)).not.toContain('[REDACTED');
    expect(steps[1]!.next.proposal.action).toEqual({ kind: 'edit', path: 'cfg.py', old: 'name = "foo"', new: 'name = "bar"' });
    expect(ctx.fs.files.get('cfg.py')).toBe(`${secret}name = "bar"\nother = "foo"\n`);
    expect(ctx.fs.files.get('m.py')).toBe(`${secret}foo()\nxfoo()\n`);
  });

  it('proposals carry the todo list as the plan', async () => {
    const ctx = createAgentContext({ turns: [{ toolCalls: [call('todo_write', { todos: [{ content: 'read', status: 'completed' }, { content: 'fix', status: 'in_progress' }] }), call('bash', { command: 'npm install' })] }, { text: 'ok' }], testCommand: null });
    const d = createAgentDriver();
    const s1 = await step(d, ctx);
    const s2 = await step(d, ctx);
    expect(s1.next.proposal.plan).toEqual({ done: ['read'], remaining: ['fix'], openProblems: [] });
    expect(s2.next.proposal.plan).toEqual({ done: ['read'], remaining: ['fix'], openProblems: [] });
  });

  it('a command declined in review mode goes back to the model as DECLINED and counts as a block', async () => {
    const results: string[] = [];
    const ctx = createAgentContext({ turns: [{ toolCalls: [call('bash', { command: 'npm install' })] }, { text: 'ok' }], testCommand: null, autonomy: 'review' });
    const d = createAgentDriver();
    const s = await step(d, ctx);
    expect(s.outcome).toEqual({ status: 'declined', reason: 'declined (no reviewer)' });
    await step(d, ctx);
    results.push(...(messagesOf(ctx, 1).at(-1)!.content.map((b) => (b.type === 'tool_result' ? b.content : ''))));
    expect(results).toEqual(['DECLINED by the human: declined (no reviewer)']);
    expect((ctx.state as { blocks: number }).blocks).toBe(1);
  });
});
