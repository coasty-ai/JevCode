/**
 * The driver on its own, end to end (docs/AGENT-LOOP-DESIGN.md §2.3, §3): `createAgentDriver()` driven through a scripted
 * multi-turn conversation with a fake provider and no engine — parallel reads in one observe step, an edit, a failing
 * and then a passing test run with a fix in between, and a final answer — with every tool result threaded back by id.
 */
import { describe, expect, it } from 'vitest';
import { createAgentDriver } from '../../../src/agent/index.js';
import { readTranscript, transcriptPath } from '../../../src/agent/transcript.js';
import { call, createAgentContext, messagesOf, runUntilFinish } from './helpers.js';

const BUGGY = 'def mean(xs):\n    return sum(xs) / (len(xs) - 1)\n\n\ndef capitalize(s):\n    return s[0].lower() + s[1:]\n';
const TESTS = 'from src.stats import mean, capitalize\n\n\ndef test_mean():\n    assert mean([2, 4]) == 3\n\n\ndef test_capitalize():\n    assert capitalize("abc") == "Abc"\n';

describe('the agent driver, end to end without the engine', () => {
  it('reads in parallel, edits, fails a test run, fixes, passes, and answers', async () => {
    let pytestRuns = 0;
    const ctx = createAgentContext({
      files: { 'src/stats.py': BUGGY, 'tests/test_stats.py': TESTS },
      testCommand: { command: 'pytest -q', runner: 'pytest' },
      sandbox: (command) => {
        if (command === 'pytest -q') {
          pytestRuns += 1;
          return pytestRuns === 1
            ? { exitCode: 1, stdout: 'F.\nFAILED tests/test_stats.py::test_capitalize - AssertionError\n1 failed, 1 passed in 0.02s\n' }
            : { exitCode: 0, stdout: '..\n2 passed in 0.02s\n' };
        }
        return { stdout: '' };
      },
      turns: [
        {
          text: "I'll read the module and its tests first.\n",
          chunks: ["I'll read the module ", 'and its tests first.\n'],
          toolCalls: [call('read_file', { path: 'src/stats.py' }, 'tc_1'), call('read_file', { path: 'tests/test_stats.py' }, 'tc_2'), call('grep', { pattern: 'def ', path: 'src' }, 'tc_3')],
        },
        { text: 'mean divides by the wrong length.', toolCalls: [call('edit_file', { path: 'src/stats.py', old_string: 'sum(xs) / (len(xs) - 1)', new_string: 'sum(xs) / len(xs)' }, 'tc_4')] },
        { toolCalls: [call('bash', { command: 'pytest -q', description: 'run the tests' }, 'tc_5')] },
        { text: 'capitalize lowercases the first letter.', toolCalls: [call('edit_file', { path: 'src/stats.py', old_string: 's[0].lower()', new_string: 's[0].upper()' }, 'tc_6')] },
        { toolCalls: [call('bash', { command: 'pytest -q' }, 'tc_7')] },
        { text: 'Fixed `mean` (it divided by len - 1) and `capitalize` (it lowercased). Both tests pass.' },
      ],
    });
    const driver = createAgentDriver();
    const steps = await runUntilFinish(driver, ctx);

    expect(steps.map((s) => s.next.kind)).toEqual(['observe', 'act', 'act', 'act', 'act', 'finish']);

    // step 1: one observe step with the three read-only calls, every tool:call of the batch before any tool:result
    const observe = steps[0]!.next;
    if (observe.kind !== 'observe') throw new Error('expected observe');
    expect(observe.summary.calls.map((c) => c.id)).toEqual(['tc_1', 'tc_2', 'tc_3']);
    expect(observe.proposal.action).toEqual({ kind: 'read', paths: ['src/stats.py', 'tests/test_stats.py'] });
    const order = ctx.events.filter((e) => e.type === 'tool:call' || e.type === 'tool:result').slice(0, 6).map((e) => e.type);
    expect(order).toEqual(['tool:call', 'tool:call', 'tool:call', 'tool:result', 'tool:result', 'tool:result']);

    // the prose streamed as committed lines with the turn and attempt
    expect(ctx.eventsOf('assistant:text')[0]).toMatchObject({ turn: 1, attempt: 1, text: "I'll read the module and its tests first.", final: false });

    // the edits landed and the second run passed; no harness verify was needed after the model's green run
    expect(ctx.fs.files.get('src/stats.py')).toBe('def mean(xs):\n    return sum(xs) / len(xs)\n\n\ndef capitalize(s):\n    return s[0].upper() + s[1:]\n');
    expect(pytestRuns).toBe(2);
    const finish = steps[5]!.next;
    expect(finish.kind === 'finish' && finish.proposal.action).toEqual({ kind: 'done', summary: 'Fixed `mean` (it divided by len - 1) and `capitalize` (it lowercased). Both tests pass.' });

    // every request pairs each tool_use of the previous assistant turn with a tool_result of the same id
    expect(ctx.sent).toHaveLength(6);
    for (let n = 1; n < ctx.sent.length; n += 1) {
      const msgs = messagesOf(ctx, n);
      const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')!;
      const ids = lastAssistant.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []));
      const tail = msgs[msgs.length - 1]!;
      expect(tail.role).toBe('user');
      expect(tail.content.flatMap((b) => (b.type === 'tool_result' ? [b.toolUseId] : []))).toEqual(ids);
    }
    // the failing run went back to the model as an error result with the counts, the passing one as a success
    const third = messagesOf(ctx, 3);
    const failed = third[third.length - 1]!.content[0]!;
    expect(failed.type === 'tool_result' && failed.isError === true && failed.content.startsWith('exit 1 · ')).toBe(true);
    expect(failed.type === 'tool_result' && failed.content).toContain('tests: 1 passed, 1 failed, 0 errors');
    const fifth = messagesOf(ctx, 5);
    const passed = fifth[fifth.length - 1]!.content[0]!;
    expect(passed.type === 'tool_result' && passed.isError !== true && passed.content.startsWith('exit 0 · ')).toBe(true);

    // no Jev without a key, and the transcript on disk holds every result under a preceding tool_use id
    expect(ctx.asks).toHaveLength(0);
    const records = (await readTranscript(transcriptPath(ctx.runDir)))!;
    const seen = new Set<string>();
    for (const r of records) {
      if (r.kind === 'assistant') for (const c of r.calls) seen.add(c.id);
      if (r.kind === 'result') expect(seen.has(r.toolUseId)).toBe(true);
    }
    expect(records.map((r) => r.seq)).toEqual(records.map((_r, i) => i + 1));
    // the checkpoint state covers the whole transcript
    expect((ctx.state as { transcriptSeq: number }).transcriptSeq).toBe(records.length);
  });
});
