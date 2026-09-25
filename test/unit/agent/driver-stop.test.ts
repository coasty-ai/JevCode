/**
 * The driver's stop rules, replies and request settings (docs/AGENT-LOOP-DESIGN.md §3.3, §6.3, §6.5, §A1, §A4): the
 * narrow continuation, no harness verification by default (the model checks its own work), the opt-in bounded
 * verification of `agent.verify tests` with the failed-test nudge and the timeout note, a reply that needs no tools, the
 * rejected-replay retry, the empty reply, loop nudges and the RA0 effort hint on the first turn.
 */
import { describe, expect, it } from 'vitest';
import type { Answer } from '../../../src/core/types.js';
import { GeneratorResponseError, ProviderHttpError } from '../../../src/errors.js';
import { createAgentDriver } from '../../../src/agent/index.js';
import { announcesAction, isDocsOnlyChange } from '../../../src/agent/stop.js';
import { call, createAgentContext, messagesOf, runUntilFinish, step, userText, type ScriptedTurn } from './helpers.js';

describe('continuation', () => {
  it.each([
    "Let me know if you'd like any other changes.",
    'All 3 tests pass now. Let me know if anything else is needed!',
    "I'll leave the refactor for a follow-up.",
    'I will not change the public API.',
    "Now I'm confident the fix is complete.",
    'Here is what changed:',
    'Let me know if you want me to continue:',
    'Next, I recommend adding more tests.',
  ])('a final answer finishes: %s', async (line) => {
    expect(announcesAction(`Fixed the bug.\n${line}`)).toBe(false);
    const ctx = createAgentContext({ turns: [{ text: `Fixed the bug.\n${line}` }], testCommand: null });
    expect(kinds(await runUntilFinish(createAgentDriver(), ctx))).toEqual(['finish']);
    expect(ctx.sent).toHaveLength(1);
  });

  it.each(['Let me check the tests:', "Now I'll run the tests…", 'Next I will update the docs...', 'I’ll read the file:'])('an announced step continues: %s', async (line) => {
    const ctx = createAgentContext({ turns: [{ text: `Found it.\n${line}` }, { text: 'All done.' }], testCommand: null });
    const steps = await runUntilFinish(createAgentDriver(), ctx);
    expect(kinds(steps)).toEqual(['finish']);
    expect(ctx.sent).toHaveLength(2);
    expect(userText(ctx, 1).endsWith('Continue: carry out the step you just described, using the tools.')).toBe(true);
  });

  it('a reply cut off at the output limit continues with the cut note', async () => {
    const ctx = createAgentContext({ turns: [{ text: 'The plan is to', stopReason: 'max_tokens' }, { text: 'change the parser.' }], testCommand: null });
    await runUntilFinish(createAgentDriver(), ctx);
    expect(userText(ctx, 1).endsWith('Your reply was cut off at the output limit. Continue from where it stopped.')).toBe(true);
  });

  it('continues at most twice per run', async () => {
    const ctx = createAgentContext({ turns: () => ({ text: 'Let me check the tests:' }), testCommand: null });
    const steps = await runUntilFinish(createAgentDriver(), ctx);
    expect(kinds(steps)).toEqual(['finish']);
    expect(ctx.sent).toHaveLength(3);
    expect((ctx.state as { continueNudges: number }).continueNudges).toBe(2);
  });
});

describe('verification is the model\'s by default (agent.verify off)', () => {
  const edit = (): ScriptedTurn => ({ toolCalls: [call('edit_file', { path: 'src/a.py', old_string: 'return 1', new_string: 'return 2' })] });

  it('an edit then a reply is act, finish: the harness never runs the test command and sends no verify note', async () => {
    const ctx = createAgentContext({ turns: [edit(), { text: 'Changed f to return 2.' }], sandbox: () => ({ exitCode: 0, stdout: '1 passed in 0.01s\n' }) });
    const steps = await runUntilFinish(createAgentDriver(), ctx);
    expect(kinds(steps)).toEqual(['act', 'finish']);
    // (the edit's own syntax check runs through the sandbox; the test command never does)
    expect(ctx.sb.commands.filter((c) => c.startsWith('pytest'))).toEqual([]);
    expect(ctx.sent).toHaveLength(2);
    expect(ctx.sent.map((_r, i) => userText(ctx, i)).join('\n')).not.toContain('The harness ran');
    // the counters are still kept, so a resume under `tests` knows a change is unverified
    expect((ctx.state as { changedSinceVerify: boolean }).changedSinceVerify).toBe(true);
  });

  it("the model's own failing run of the test command draws no nudge: its explanation finishes", async () => {
    const ctx = createAgentContext({
      turns: [edit(), { toolCalls: [call('bash', { command: 'pytest -q' })] }, { text: 'test_f fails for a reason unrelated to this change.' }],
      sandbox: () => ({ exitCode: 1, stdout: 'F\n1 failed, 2 passed in 0.02s\n' }),
    });
    const steps = await runUntilFinish(createAgentDriver(), ctx);
    expect(kinds(steps)).toEqual(['act', 'act', 'finish']);
    expect(ctx.sent).toHaveLength(3);
    expect(ctx.sb.commands.filter((c) => c.startsWith('pytest'))).toEqual(['pytest -q']);
    expect(ctx.sent.map((_r, i) => userText(ctx, i)).join('\n')).not.toContain('The last run of');
    expect((ctx.state as { failedTest: unknown }).failedTest).toEqual({ passed: 2, failed: 1, errors: 0, parsed: true, exitCode: 1 });
  });
});

describe('verification under agent.verify tests (the opt-in)', () => {
  const edit = (): ScriptedTurn => ({ toolCalls: [call('edit_file', { path: 'src/a.py', old_string: 'return 1', new_string: 'return 2' })] });

  it('after a change with no passing run, the harness verifies with the detected command; a green verify finishes', async () => {
    const ctx = createAgentContext({ verify: 'tests', turns: [edit(), { text: 'Changed f.' }, { text: 'Verified.' }], sandbox: () => ({ exitCode: 0, stdout: '1 passed in 0.01s\n' }) });
    const steps = await runUntilFinish(createAgentDriver(), ctx);
    expect(kinds(steps)).toEqual(['act', 'verify', 'finish']);
    const verify = steps[1]!.next;
    expect(verify.proposal.action).toEqual({ kind: 'run', command: 'pytest -q', timeoutMs: 600_000 });
    expect(userText(ctx, 2)).toContain('The harness ran `pytest -q` to check your change: exit 0 · ');
    expect(userText(ctx, 2)).toContain('tests: 1 passed, 0 failed, 0 errors');
    expect(userText(ctx, 2)).toContain('If it passed, reply with one short sentence that says the tests passed.');
    expect((ctx.state as { changedSinceVerify: boolean }).changedSinceVerify).toBe(false);
  });

  it('verifies at most twice per run', async () => {
    const edit2 = (): ScriptedTurn => ({ toolCalls: [call('edit_file', { path: 'src/a.py', old_string: 'return 2', new_string: 'return 3' })] });
    const ctx = createAgentContext({ verify: 'tests', turns: [edit(), { text: 'Done?' }, edit2(), { text: 'Still done?' }, { text: 'Giving up.' }], sandbox: () => ({ exitCode: 1, stdout: '1 failed in 0.01s\n' }) });
    const steps = await runUntilFinish(createAgentDriver(), ctx);
    expect(kinds(steps)).toEqual(['act', 'verify', 'act', 'verify', 'finish']);
    expect((ctx.state as { verifyRuns: number }).verifyRuns).toBe(2);
  });

  it('after a failed harness verify the explaining reply finishes and the suite ran exactly once', async () => {
    const ctx = createAgentContext({ verify: 'tests', turns: [edit(), { text: 'Done.' }, { text: 'Those failures were there before this change.' }, { text: 'Final.' }], sandbox: () => ({ exitCode: 1, stdout: '1 failed, 4 passed in 0.01s\n' }) });
    const steps = await runUntilFinish(createAgentDriver(), ctx);
    expect(kinds(steps)).toEqual(['act', 'verify', 'finish']);
    expect(ctx.sb.commands.filter((c) => c === 'pytest -q')).toHaveLength(1);
    expect(ctx.sent).toHaveLength(3);
    expect(userText(ctx, 2)).toContain('The harness ran `pytest -q` to check your change: exit 1');
    expect(userText(ctx, 2)).toContain('If it failed for another reason (the environment, a missing tool, failures that were there before), say so in one sentence and do not try to repair the environment.');
    const done = steps[2]!.next.proposal.action;
    expect(done.kind === 'done' && done.summary).toBe('Those failures were there before this change.');
    expect(ctx.sent.map((_r, i) => userText(ctx, i)).join('\n')).not.toContain('The last run of');
  });

  it("the model's own failing unscoped run gets the failed-test nudge once, then the harness verifies", async () => {
    const ctx = createAgentContext({
      verify: 'tests',
      turns: [edit(), { toolCalls: [call('bash', { command: 'pytest -q' })] }, { text: 'Done.' }, { text: 'Still done.' }, { text: 'Bye.' }],
      sandbox: () => ({ exitCode: 1, stdout: 'F\n1 failed, 2 passed in 0.02s\n' }),
    });
    const steps = await runUntilFinish(createAgentDriver(), ctx);
    expect(kinds(steps)).toEqual(['act', 'act', 'verify', 'finish']);
    expect(userText(ctx, 3)).toContain('The last run of `pytest -q` after your change failed (2 passed, 1 failed, 0 errors). Fix it, or explain why the failures are unrelated, before you finish.');
  });

  it('a failing run whose output no parser reads is reported by its exit code, not as zero counts', async () => {
    const ctx = createAgentContext({
      verify: 'tests',
      testCommand: { command: 'npm test', runner: 'npm' },
      turns: [edit(), { toolCalls: [call('bash', { command: 'npm test' })] }, { text: 'Done.' }, { text: 'Still done.' }, { text: 'Bye.' }],
      sandbox: () => ({ exitCode: 1, stdout: "Error: EPERM: operation not permitted, mkdir 'node_modules/.vite-temp'\n" }),
    });
    const steps = await runUntilFinish(createAgentDriver(), ctx);
    expect(kinds(steps)).toEqual(['act', 'act', 'verify', 'finish']);
    expect(userText(ctx, 3)).toContain('The last run of `npm test` after your change failed (exit 1).');
    expect(userText(ctx, 3)).not.toContain('0 passed, 0 failed, 0 errors');
  });

  it("a scoped run doesn't count as verification, a green unscoped run does", async () => {
    const scoped = createAgentContext({ verify: 'tests', turns: [edit(), { toolCalls: [call('bash', { command: 'pytest -q tests/test_a.py' })] }, { text: 'Done.' }, { text: 'ok' }], sandbox: () => ({ exitCode: 0, stdout: '1 passed in 0.01s\n' }) });
    expect(kinds(await runUntilFinish(createAgentDriver(), scoped))).toEqual(['act', 'act', 'verify', 'finish']);
    const unscoped = createAgentContext({ verify: 'tests', turns: [edit(), { toolCalls: [call('bash', { command: 'pytest -q' })] }, { text: 'Done.' }], sandbox: () => ({ exitCode: 0, stdout: '1 passed in 0.01s\n' }) });
    expect(kinds(await runUntilFinish(createAgentDriver(), unscoped))).toEqual(['act', 'act', 'finish']);
    const inWorkdir = createAgentContext({ verify: 'tests', turns: [edit(), { toolCalls: [call('bash', { command: 'pytest -q', workdir: 'tests' })] }, { text: 'Done.' }, { text: 'ok' }], sandbox: () => ({ exitCode: 0, stdout: '1 passed in 0.01s\n' }) });
    expect(kinds(await runUntilFinish(createAgentDriver(), inWorkdir))).toEqual(['act', 'act', 'verify', 'finish']);
  });

  it('a command that changed files needs verification; the test command itself does not count as a change', async () => {
    const ctx = createAgentContext({ verify: 'tests', turns: [{ toolCalls: [call('bash', { command: 'sed -i s/1/2/ src/a.py' })] }, { text: 'Done.' }, { text: 'ok' }], sandbox: () => ({ exitCode: 0, stdout: '1 passed\n' }) });
    const steps = await runUntilFinish(createAgentDriver(), ctx, { changedFiles: (c) => (c.startsWith('sed') ? ['src/a.py'] : []) });
    expect(kinds(steps)).toEqual(['act', 'verify', 'finish']);
    const noChange = createAgentContext({ verify: 'tests', turns: [{ toolCalls: [call('bash', { command: 'npm install' })] }, { text: 'Done.' }] });
    expect(kinds(await runUntilFinish(createAgentDriver(), noChange))).toEqual(['act', 'finish']);
  });

  it('a change to docs alone (README.md, a LICENSE, an image) arms no verification; a docs change beside code does', async () => {
    const docs = createAgentContext({
      verify: 'tests',
      turns: [{ toolCalls: [call('write_file', { path: 'README.md', content: '# a\n' })] }, { toolCalls: [call('bash', { command: 'cp README.md LICENSE' })] }, { text: 'Updated the docs.' }],
    });
    const steps = await runUntilFinish(createAgentDriver(), docs, { changedFiles: (c) => (c.startsWith('cp') ? ['LICENSE'] : []) });
    expect(kinds(steps)).toEqual(['act', 'act', 'finish']);
    expect(docs.sb.commands).toEqual(['cp README.md LICENSE']);
    const mixed = createAgentContext({ verify: 'tests', turns: [{ toolCalls: [call('bash', { command: 'touch README.md src/b.py' })] }, { text: 'Done.' }, { text: 'ok' }], sandbox: () => ({ exitCode: 0, stdout: '1 passed\n' }) });
    expect(kinds(await runUntilFinish(createAgentDriver(), mixed, { changedFiles: () => ['README.md', 'src/b.py'] }))).toEqual(['act', 'verify', 'finish']);
  });

  it('a verify that times out goes back as "not verified", never as a failure to fix', async () => {
    const ctx = createAgentContext({ verify: 'tests', turns: [edit(), { text: 'Done.' }, { text: 'Not verified, sorry.' }], sandbox: (cmd) => (cmd === 'pytest -q' ? { exitCode: null, killedBy: 'timeout', durationMs: 600_000 } : { stdout: '' }) });
    const steps = await runUntilFinish(createAgentDriver(), ctx);
    expect(kinds(steps)).toEqual(['act', 'verify', 'finish']);
    expect(userText(ctx, 2)).toContain('The harness ran `pytest -q` to verify your change, but it did not finish within 600s, so the change is not verified.');
  });

  it('with no test command there is nothing to verify', async () => {
    const ctx = createAgentContext({ verify: 'tests', turns: [edit(), { text: 'Done.' }], testCommand: null });
    expect(kinds(await runUntilFinish(createAgentDriver(), ctx))).toEqual(['act', 'finish']);
  });

  it('a discarded verify or finish is re-derived by the stop rules', async () => {
    const ctx = createAgentContext({ verify: 'tests', turns: [edit(), { text: 'Done.' }] });
    const d = createAgentDriver();
    await step(d, ctx);
    const v1 = await d.next(ctx);
    const v2 = await d.next(ctx);
    expect([v1.kind, v2.kind]).toEqual(['verify', 'verify']);
    expect(ctx.sent).toHaveLength(2);
  });
});

describe('isDocsOnlyChange', () => {
  it.each([
    [['README.md'], true],
    [['docs/guide.rst', 'docs/img/flow.SVG', 'notes.txt', 'a.adoc', 'b.org', 'c.mdx', 'd.markdown', 'e.asciidoc'], true],
    [['LICENSE', 'COPYING', 'NOTICE', 'AUTHORS', 'CHANGELOG', 'README', 'LICENSE-MIT', 'pkg/readme'], true],
    [['assets/logo.png', 'a.jpg', 'b.jpeg', 'c.gif', 'd.webp', 'favicon.ico'], true],
    [[], false],
    [['src/a.py'], false],
    [['README.md', 'src/a.py'], false],
    [['README.py', 'LICENSE.sh'], false],
    [['Makefile'], false],
    [['package.json'], false],
  ] as const)('%j → %s', (paths, want) => {
    expect(isDocsOnlyChange(paths)).toBe(want);
  });
});

describe('replies (§A1)', () => {
  it('"hi" is one turn, prose only, and a finish', async () => {
    const ctx = createAgentContext({ task: 'hi', turns: [{ text: 'Hi! What can I help you with in this workspace?' }] });
    const steps = await runUntilFinish(createAgentDriver(), ctx);
    expect(kinds(steps)).toEqual(['finish']);
    expect(steps[0]!.next.proposal.action).toEqual({ kind: 'done', summary: 'Hi! What can I help you with in this workspace?' });
    expect(ctx.eventsOf('tool:call')).toEqual([]);
    expect(ctx.sb.commands).toEqual([]);
    expect(ctx.sent).toHaveLength(1);
    expect(messagesOf(ctx, 0)[0]!.content[0]!.type === 'text' && (messagesOf(ctx, 0)[0]!.content[0] as { text: string }).text.startsWith('# Task\nhi\n\n# Workspace')).toBe(true);
  });

  it('"who made you?" is answered from the identity the system prompt leads with', async () => {
    const ctx = createAgentContext({ task: 'who made you?', turns: (req) => ({ text: req.system.includes('built by coasty-ai') ? 'I am JevCode, built by coasty-ai, running on z-ai/glm-5.3-flash via OpenRouter.' : 'I am GLM.' }) });
    const steps = await runUntilFinish(createAgentDriver(), ctx);
    expect(kinds(steps)).toEqual(['finish']);
    const done = steps[0]!.next.proposal.action;
    expect(done.kind === 'done' && done.summary).toMatch(/JevCode.*coasty-ai/);
    expect(ctx.sent[0]!.system.startsWith('# Who you are\nYou are JevCode, a coding agent for the terminal, built by coasty-ai. You run on the code model z-ai/glm-5.3-flash through OpenRouter')).toBe(true);
  });

  it('a task uses tools', async () => {
    const ctx = createAgentContext({ task: 'fix the failing test', turns: [{ toolCalls: [call('read_file', { path: 'src/a.py' })] }, { text: 'It returns 1.' }], testCommand: null });
    expect(kinds(await runUntilFinish(createAgentDriver(), ctx))).toEqual(['observe', 'finish']);
  });

  it('an empty reply is a malformed response (a stage failure), and nothing is recorded', async () => {
    const ctx = createAgentContext({ turns: [{ text: '' }, { text: 'Recovered.' }] });
    const d = createAgentDriver();
    await expect(d.next(ctx)).rejects.toBeInstanceOf(GeneratorResponseError);
    const s = await step(d, ctx);
    expect(s.next.kind).toBe('finish');
    expect(messagesOf(ctx, 1).map((m) => m.role)).toEqual(['user']);
  });
});

describe('the request', () => {
  it('carries the agent settings of §6.3', async () => {
    const ctx = createAgentContext({ turns: [{ text: 'ok' }], maxTokens: 4096, sessionId: 'sess-9' });
    await step(createAgentDriver(), ctx);
    const req = ctx.sent[0]!;
    expect(req).toMatchObject({ messages: [], maxTokens: 16384, temperature: 0.2, toolChoice: 'auto', reasoning: { effort: 'low' } });
    expect(req.tools!.map((t) => t.name)).toEqual(['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'todo_write']);
    expect(req.agent).toMatchObject({ parallelToolCalls: true, cacheKey: 'sess-9', replayReasoning: true });
    expect(req.agent).not.toHaveProperty('clearToolResults');
    expect(ctx.hooks[0]).toMatchObject({ turn: 1 });
    expect(ctx.usages).toHaveLength(1);
  });

  it('Anthropic: effort high, no temperature, and the constant server-side clearing request', async () => {
    const ctx = createAgentContext({ provider: { name: 'anthropic', model: 'claude-sonnet-5' }, turns: [{ text: 'ok' }], windowTokens: 1_000_000 });
    await step(createAgentDriver(), ctx);
    expect(ctx.sent[0]).toMatchObject({ temperature: null, reasoning: { effort: 'high' }, agent: { clearToolResults: { triggerTokens: 100_000, keep: 6, clearAtLeastTokens: 5_000 } } });
  });

  it('a 400 naming the thinking signature is retried once without reasoning state, and replay stays off', async () => {
    const ctx = createAgentContext({
      provider: { name: 'anthropic', model: 'claude-sonnet-5' },
      testCommand: null,
      turns: [
        { toolCalls: [call('glob', { pattern: '*' })], providerState: { blocks: ['thinking-sig'] } },
        { error: new ProviderHttpError('Anthropic HTTP 400: invalid thinking block signature', { status: 400, retryable: false }) },
        { toolCalls: [call('glob', { pattern: '*.py' })], providerState: { blocks: ['second'] } },
        { text: 'done' },
      ],
    });
    const steps = await runUntilFinish(createAgentDriver(), ctx);
    expect(kinds(steps)).toEqual(['observe', 'observe', 'finish']);
    expect(ctx.sent[1]!.agent!.replayReasoning).toBe(true);
    expect(ctx.sent[1]!.agent!.messages[1]).toHaveProperty('providerState');
    expect(ctx.sent[2]!.agent!.replayReasoning).toBe(false);
    expect(ctx.sent[2]!.agent!.messages.some((m) => 'providerState' in m)).toBe(false);
    expect(ctx.sent[3]!.agent!.replayReasoning).toBe(false);
    expect(ctx.sent[3]!.agent!.messages.some((m) => 'providerState' in m)).toBe(false);
    expect(ctx.eventsOf('transcript').map((e) => e.text)).toContain('the provider rejected replayed reasoning; continuing without it');
    expect((ctx.state as { replayDisabled: boolean }).replayDisabled).toBe(true);
  });

  it('a second rejection, or an unrelated 400, is an ordinary failure', async () => {
    const reject = (): ScriptedTurn => ({ error: new ProviderHttpError('HTTP 400: tool_use ids must be unique', { status: 400, retryable: false }) });
    const ctx = createAgentContext({ turns: [reject(), reject()] });
    await expect(createAgentDriver().next(ctx)).rejects.toBeInstanceOf(ProviderHttpError);
    expect(ctx.sent).toHaveLength(2);
    const other = createAgentContext({ turns: [{ error: new ProviderHttpError('HTTP 400: max_tokens too large', { status: 400, retryable: false }) }] });
    await expect(createAgentDriver().next(other)).rejects.toBeInstanceOf(ProviderHttpError);
    expect(other.sent).toHaveLength(1);
  });
});

describe('loop nudges', () => {
  it('a trip in an observe step is reported on the step and nudges the next turn (change_approach without Jev)', async () => {
    const ctx = createAgentContext({ turns: [{ toolCalls: [call('bash', { command: 'cat x' }), call('bash', { command: 'cat x' }), call('bash', { command: 'cat x' })] }, { text: 'ok' }], sandbox: () => ({ exitCode: 0, stdout: 'same\n' }), testCommand: null });
    const d = createAgentDriver();
    const s = await step(d, ctx);
    expect(s.next.kind === 'observe' && s.next.summary.loopTrip).toMatchObject({ rule: 'repeat', count: 3, tool: 'bash' });
    await step(d, ctx);
    expect(userText(ctx, 1).endsWith('You have called bash with the same arguments 3 times in a row and got the same result. Stop and try a different approach.')).toBe(true);
    expect(ctx.asks).toHaveLength(0);
  });

  it('three identical failing test runs trip through observe(), and RA1 words the nudge when Jev answers in time', async () => {
    const run = (): ScriptedTurn => ({ toolCalls: [call('bash', { command: 'npm test' })] });
    const ctx = createAgentContext({
      testCommand: { command: 'npm test', runner: 'npm' },
      jevAvailable: true,
      ask: async (): Promise<Record<string, Answer>> => ({ loop_nudge: { type: 'choice', choice: 'fix_environment', probabilities: { fix_environment: 0.9 }, confidence: 0.8 } }),
      turns: [run(), run(), run(), { text: 'ok' }, { text: 'ok' }],
      sandbox: () => ({ exitCode: 1, stdout: 'not ok 1 - adds\n# pass 2\n# fail 1\n1 failed, 2 passed\n' }),
    });
    const d = createAgentDriver();
    const s1 = await step(d, ctx);
    const s2 = await step(d, ctx);
    const s3 = await step(d, ctx);
    expect([s1.observed?.loopTrip, s2.observed?.loopTrip]).toEqual([null, null]);
    expect(s3.observed?.loopTrip).toMatchObject({ rule: 'repeat', count: 3, tool: 'bash' });
    await step(d, ctx);
    expect(userText(ctx, 3)).toContain('You have run `npm test` 3 times with the same failing tests. The failure may be in the environment');
    expect(ctx.asks).toHaveLength(1);
  });
});

describe('the RA0 effort hint (§A4)', () => {
  const conversational = (p: number) => async (): Promise<Record<string, Answer>> => ({ conversational: { type: 'noul', noul: p } });

  it('absent Jev: the default effort and no ask', async () => {
    const ctx = createAgentContext({ provider: { name: 'anthropic', model: 'claude-sonnet-5' }, turns: [{ text: 'hello' }] });
    await step(createAgentDriver(), ctx);
    expect(ctx.sent[0]!.reasoning).toEqual({ effort: 'high' });
    expect(ctx.asks).toHaveLength(0);
  });

  it('a slow Jev (over 300 ms): the default effort', async () => {
    const ctx = createAgentContext({
      provider: { name: 'anthropic', model: 'claude-sonnet-5' },
      jevAvailable: true,
      ask: async (_c, signal) => {
        await new Promise((r, j) => {
          const t = setTimeout(r, 1_000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            j(signal.reason);
          });
        });
        return { conversational: { type: 'noul', noul: 1 } };
      },
      turns: [{ text: 'hello' }],
    });
    const t0 = Date.now();
    await step(createAgentDriver(), ctx);
    expect(Date.now() - t0).toBeLessThan(900);
    expect(ctx.sent[0]!.reasoning).toEqual({ effort: 'high' });
  });

  it('p = 0.9: the first turn goes at low effort and the second does not', async () => {
    const ctx = createAgentContext({ provider: { name: 'anthropic', model: 'claude-sonnet-5' }, jevAvailable: true, ask: conversational(0.9), turns: [{ toolCalls: [call('glob', { pattern: '*' })] }, { text: 'ok' }], testCommand: null });
    await runUntilFinish(createAgentDriver(), ctx);
    expect(ctx.sent.map((r) => r.reasoning)).toEqual([{ effort: 'low' }, { effort: 'high' }]);
    expect(ctx.asks).toHaveLength(1);
  });

  it('is not asked where low effort is already the default (OpenRouter)', async () => {
    const ctx = createAgentContext({ jevAvailable: true, ask: conversational(0.9), turns: [{ text: 'hello' }] });
    await step(createAgentDriver(), ctx);
    expect(ctx.asks).toHaveLength(0);
    expect(ctx.sent[0]!.reasoning).toEqual({ effort: 'low' });
  });
});

function kinds(steps: { next: { kind: string } }[]): string[] {
  return steps.map((s) => s.next.kind);
}
