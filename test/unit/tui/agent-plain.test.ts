/**
 * AGENT-LOOP-DESIGN §9.4, §A1 + the S5a amendment (slice S5a): the agent-mode items and the `--plain` renderer.
 *
 * - `--plain` prints the prose AS IT ARRIVES, every line under the `[jevcode]` label, and a two-paragraph turn exactly
 *   once (the `assistant:text` rows of a streamed turn are skipped; a turn with no deltas prints them);
 * - a tool-less turn prints only `[you] …` / `[jevcode] …` — no `[run] started · agent · hi` / `[run] finished` pair;
 * - a tool run lands its held rows at the first tool call, then its step rows and `[run] finished`;
 * - the step rows of every agent step kind, the read-only tool rows, the reply-restarted notice.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../../src/core/types.js';
import { AGENT_REPLY_RESTARTED, agentBatchText, agentCallText, agentStepText, createItemStreamState, createPlainRenderer, formatTranscriptItem, itemsFromEvent, proseLinesOf, stepSummaryText, testCountsText } from '../../../src/tui/plain.js';
import { agentStripSegments, AGENT_NO_DECISIONS, panelStrip, tabLines } from '../../../src/tui/pane/model.js';
import { fakeEngine } from '../../fixtures/tui/fixtures.js';
import { agentOpening, agentRunResult, agentStep, shapedTurn } from './agent-fixtures.js';

class Sink extends PassThrough {
  text = '';
  constructor() {
    super();
    this.setEncoding('utf8');
    this.on('data', (chunk: string) => {
      this.text += chunk;
    });
  }
}

async function plainRun(events: readonly EngineEvent[]): Promise<string[]> {
  const out = new Sink();
  const r = createPlainRenderer({ task: '', resumeId: null, mode: 'session', cwd: '/tmp/proj', onAbort: () => undefined, stdout: out as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream });
  await r.firstFrame();
  r.notify('hi there', { label: '[you]' });
  const fe = fakeEngine();
  r.attach(fe.engine);
  for (const e of events) fe.emit(e);
  await r.unmount();
  await new Promise((res) => setImmediate(res));
  // drop the session header line
  return out.text.replace(/\n$/, '').split('\n').slice(1);
}

const finish = (step: number, remaining: string[] = []): EngineEvent[] => [
  { type: 'proposal', step, proposal: { goal: 'finish', action: { kind: 'done', summary: 'ok' }, plan: { done: [], remaining, openProblems: [] }, rawText: '' } },
  { type: 'outcome', step, outcome: { status: 'noop', summary: 'done' } },
  { type: 'step:end', record: agentStep(step, { kind: 'finish', action: { kind: 'done', summary: 'ok' }, outcome: { status: 'noop', summary: 'done' }, remaining }), costUsd: { generator: 0.0001, jev: 0 } },
];

describe('--plain in agent mode', () => {
  it('a tool-less two-paragraph turn prints its prose once, line by line under [jevcode], and no [run] pair (§A1)', async () => {
    const text = 'Calc is a tiny expression parser.\n\nIt reads a line and prints the value.';
    const lines = await plainRun([...agentOpening('hi there'), ...shapedTurn(1, 1, ['Calc is a tiny ', 'expression parser.\n', '\nIt reads a line ', 'and prints the value.']), ...finish(1), { type: 'run:end', result: agentRunResult('answered'), exitCode: 0 }]);
    expect(lines).toEqual(['[you] hi there', '[jevcode] Calc is a tiny expression parser.', '[jevcode]', '[jevcode] It reads a line and prints the value.']);
    // the same rows transcript.log gets from the one item source
    expect(lines.slice(1)).toEqual(proseLinesOf(text).map((l) => formatTranscriptItem({ key: 'k', seq: 0, step: 1, kind: 'chat', level: 'info', text: l, label: '[jevcode]' })));
  });

  it('a turn with no deltas (a JSON transport) prints its assistant:text lines', async () => {
    const lines = await plainRun([...agentOpening('hi there'), { type: 'assistant:text', step: 1, turn: 1, attempt: 1, text: 'Hello.\nHow can I help?', final: true }, ...finish(1), { type: 'run:end', result: agentRunResult('answered'), exitCode: 0 }]);
    expect(lines).toEqual(['[you] hi there', '[jevcode] Hello.', '[jevcode] How can I help?']);
  });

  it('a provider retry after bytes streamed: the partial line ends, the dim notice, then the restarted reply', async () => {
    const lines = await plainRun([
      ...agentOpening('hi there'),
      { type: 'generator:delta', step: 1, text: 'Half a sen' },
      { type: 'assistant:reset', step: 1, turn: 1, attempt: 2 },
      ...shapedTurn(1, 1, ['Hello again.'], 2),
      ...finish(1),
      { type: 'run:end', result: agentRunResult('answered'), exitCode: 0 },
    ]);
    expect(lines).toEqual(['[you] hi there', '[jevcode] Half a sen', `[jevcode] ${AGENT_REPLY_RESTARTED}`, '[jevcode] Hello again.']);
  });

  it('a look-up (read-only tools, no command, no change) prints only its prose: the read rows, the header and [run] finished are dropped (§A1)', async () => {
    const lines = await plainRun([
      ...agentOpening('what does calc/core.py do?'),
      ...shapedTurn(1, 1, ["I'll look.\n"]),
      { type: 'tool:call', step: 1, turn: 1, id: 'c1', name: 'read_file', summary: 'read_file calc/core.py', readOnly: true },
      { type: 'tool:result', step: 1, turn: 1, id: 'c1', name: 'read_file', ok: true, summary: 'read_file calc/core.py (lines 1-80)', ms: 3, chars: 900, readOnly: true },
      { type: 'proposal', step: 1, proposal: { goal: 'read_file calc/core.py', action: { kind: 'read', paths: ['calc/core.py'] }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' } },
      { type: 'step:end', record: agentStep(1, { kind: 'observe', calls: [{ id: 'c1', name: 'read_file', summary: 'read_file calc/core.py (lines 1-80)', ok: true, ms: 3 }], action: { kind: 'read', paths: ['calc/core.py'] }, outcome: { status: 'executed', summary: 'read', changedFiles: [] } }), costUsd: { generator: 0.001, jev: 0 } },
      { type: 'generator:start', step: 2, attempt: 2 },
      ...shapedTurn(2, 2, ['It parses expressions.']),
      ...finish(2),
      { type: 'run:end', result: agentRunResult('generator_done', 2), exitCode: 0 },
    ]);
    expect(lines).toEqual(['[you] hi there', "[jevcode] I'll look.", '[jevcode] It parses expressions.']);
  });

  it('a task: the held rows (header, instructions, the look-up before it) land in order at the first change, then the step rows and [run] finished', async () => {
    const lines = await plainRun([
      ...agentOpening('fix it'),
      { type: 'notice', step: null, kind: 'instructions', level: 'info', text: 'instructions: AGENTS.md (120 B)' },
      ...shapedTurn(1, 1, ["I'll look.\n"]),
      { type: 'tool:call', step: 1, turn: 1, id: 'c1', name: 'read_file', summary: 'read_file calc/core.py', readOnly: true },
      { type: 'tool:result', step: 1, turn: 1, id: 'c1', name: 'read_file', ok: true, summary: 'read_file calc/core.py (lines 1-80)', ms: 3, chars: 900, readOnly: true },
      { type: 'step:end', record: agentStep(1, { kind: 'observe', calls: [{ id: 'c1', name: 'read_file', summary: 'read_file calc/core.py (lines 1-80)', ok: true, ms: 3 }], action: { kind: 'read', paths: ['calc/core.py'] }, outcome: { status: 'executed', summary: 'read', changedFiles: [] } }), costUsd: { generator: 0.001, jev: 0 } },
      { type: 'generator:start', step: 2, attempt: 2 },
      { type: 'tool:call', step: 2, turn: 2, id: 'c2', name: 'edit_file', summary: 'edit_file calc/core.py', readOnly: false },
      { type: 'step:end', record: agentStep(2, { kind: 'act', calls: [{ id: 'c2', name: 'edit_file', summary: 'edit_file calc/core.py', ok: true, ms: 3 }], action: { kind: 'edit', path: 'calc/core.py', old: 'a', new: 'b' }, outcome: { status: 'executed', summary: 'edited', changedFiles: ['calc/core.py'] } }), costUsd: { generator: 0.001, jev: 0 } },
      { type: 'generator:start', step: 3, attempt: 3 },
      ...shapedTurn(3, 3, ['Done.']),
      ...finish(3),
      { type: 'run:end', result: agentRunResult('generator_done', 3), exitCode: 0 },
    ]);
    expect(lines[0]).toBe('[you] hi there');
    expect(lines[1]).toBe("[jevcode] I'll look.");
    expect(lines[2]).toBe('[run] started · agent · fix it');
    expect(lines[3]).toBe('[run] instructions: AGENTS.md (120 B)');
    expect(lines[4]).toBe('[step 1] tool · read_file calc/core.py (lines 1-80) · 3 ms');
    expect(lines[5]).toMatch(/^\[step 1\] Read calc\/core\.py · 1\.2s · \$0\.001$/);
    expect(lines[6]).toMatch(/^\[step 2\] Edit calc\/core\.py/);
    expect(lines).toContain('[jevcode] Done.');
    expect(lines.at(-1)).toMatch(/^\[run\] finished · generator_done · 3 steps/);
    // §14.3: an agent run that used no Jev names none (`jev $0.000` goes), the generator split stays
    expect(lines.at(-1)).toMatch(/\(generator \$0\.00\d*\)/);
    expect(lines.at(-1)).not.toContain('jev $');
    // the finish step keeps its row in the line sinks (the compact TUI hides it)
    expect(lines.some((l) => /^\[step 3\] done · /.test(l))).toBe(true);
  });

  it('a failed model turn of a reply is held and dropped with it: no `propose:` row, no `(no proposal)`, no [run] pair — the session\'s one [ui] row says it (§A1)', async () => {
    // the step record of a model turn that failed: no agent summary, no proposal
    const { agent: _summary, ...base } = agentStep(1, { kind: 'finish', action: { kind: 'done', summary: '' }, outcome: { status: 'failed', error: 'propose: provider_http' } });
    const failedTurn = { ...base, proposal: null, proposer: 'agent' as const, error: { stage: 'propose' as const, code: 'provider_http', message: 'x' } };
    const failed: EngineEvent[] = [
      { type: 'error', step: 1, error: { name: 'ProviderHttpError', code: 'provider_http', message: "openai HTTP 404: The model 'x' does not exist", exitCode: 5 }, fatal: false },
      { type: 'outcome', step: 1, outcome: { status: 'failed', error: 'propose: provider_http' } },
      { type: 'step:end', record: failedTurn, costUsd: { generator: 0, jev: 0 } },
    ];
    const lines = await plainRun([...agentOpening('hi there'), ...failed, { type: 'run:end', result: agentRunResult('error', 1), exitCode: 5 }]);
    expect(lines).toEqual(['[you] hi there']);
    // once the run is a task, a failed turn's rows land in order — the step row says the model turn failed, in agent words
    const task = await plainRun([...agentOpening('fix it'), { type: 'tool:call', step: 1, turn: 1, id: 'c2', name: 'bash', summary: 'bash ls', readOnly: true }, ...failed.map((e) => (e.type === 'step:end' ? { ...e, record: { ...e.record, step: 2 } } : { ...e, step: 2 })), { type: 'run:end', result: agentRunResult('error', 2), exitCode: 5 }]);
    expect(task).toContain("[step 2] error provider_http: openai HTTP 404: The model 'x' does not exist");
    expect(task.some((l) => /^\[step 2\] model turn failed · provider_http · /.test(l))).toBe(true);
    expect(task.join('\n')).not.toMatch(/no proposal|propose: provider_http/);
    // a fatal error is never held
    const fatal = await plainRun([...agentOpening('hi there'), { type: 'error', step: 1, error: { name: 'ConfigError', code: 'config', message: 'transcript missing', exitCode: 2 }, fatal: true }]);
    expect(fatal).toEqual(['[you] hi there', '[step 1] error config: transcript missing (fatal)']);
  });
});

describe('agent items and step rows (all three sinks)', () => {
  it('an agent finish makes no proposal or noop-outcome item — they repeated the streamed answer (S6 live --plain printed it three times); a legacy done keeps both', () => {
    const agent = createItemStreamState();
    const texts = (events: readonly EngineEvent[], st: ReturnType<typeof createItemStreamState>): string[] => events.flatMap((e) => itemsFromEvent(e, 0, st)).map((i) => formatTranscriptItem(i));
    const answer = 'Fixed: `fib` had an off-by-one. All 3 tests pass.';
    const done: EngineEvent[] = [
      { type: 'proposal', step: 4, proposal: { goal: 'finish', action: { kind: 'done', summary: answer }, plan: { done: [], remaining: [], openProblems: [] }, rawText: answer } },
      { type: 'outcome', step: 4, outcome: { status: 'noop', summary: answer } },
    ];
    expect(texts([agentOpening('fix it', 'r-agent')[0]!, ...done], agent)).toEqual(['[run] started · agent · fix it']);
    // the step row still closes the step in every sink
    expect(stepSummaryText(agentStep(4, { kind: 'finish', action: { kind: 'done', summary: answer }, outcome: { status: 'noop', summary: answer } }), { generator: 0.0004, jev: 0 })).toBe('done · 1.2s · $0.0004');
    const legacy = createItemStreamState();
    const lines = texts([{ type: 'run:start', runId: 'r-legacy', task: 'fix it', mode: 'llm-jev', resumedFromStep: null }, ...done], legacy);
    expect(lines.slice(1)).toEqual([`[step 4] proposal · done ${answer} · "finish"`, `[step 4] done · ${answer}`]);
  });

  it('a read-only observe of commands names no empty target: `proposal · read · "bash cat a.txt"` (S6 live)', () => {
    const items = itemsFromEvent({ type: 'proposal', step: 2, proposal: { goal: 'bash cat hello.txt', action: { kind: 'read', paths: [] }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' } }, 0, createItemStreamState());
    expect(items.map((i) => formatTranscriptItem(i))).toEqual(['[step 2] proposal · read · "bash cat hello.txt"']);
  });

  it('assistant:text → one [jevcode] chat row per line, blank lines kept, no 600-char clip; one trailing newline is not an extra line', () => {
    const long = 'x'.repeat(900);
    const items = itemsFromEvent({ type: 'assistant:text', step: 2, turn: 1, attempt: 1, text: `a\n\n${long}\n`, final: false }, 10);
    expect(items.map((i) => formatTranscriptItem(i))).toEqual(['[jevcode] a', '[jevcode]', `[jevcode] ${long}`]);
    expect(items.map((i) => i.key)).toEqual(['2:chat:10', '2:chat:11', '2:chat:12']);
    expect(items.every((i) => i.kind === 'chat')).toBe(true);
  });

  it('tool:result → a full-view `tool · <summary> · <ms> ms` row for a read-only call; nothing for a mutating one or a tool:call', () => {
    expect(itemsFromEvent({ type: 'tool:result', step: 1, turn: 1, id: 'a', name: 'grep', ok: true, summary: 'grep "parseX" in src (12 matches)', ms: 4.4, chars: 300, readOnly: true }, 0).map((i) => [i.kind, formatTranscriptItem(i)])).toEqual([['tool', '[step 1] tool · grep "parseX" in src (12 matches) · 4 ms']]);
    expect(itemsFromEvent({ type: 'tool:result', step: 1, turn: 1, id: 'a', name: 'edit_file', ok: true, summary: 'edit_file a.ts', ms: 4, chars: 3, readOnly: false }, 0)).toEqual([]);
    expect(itemsFromEvent({ type: 'tool:call', step: 1, turn: 1, id: 'a', name: 'grep', summary: 'grep x', readOnly: true }, 0)).toEqual([]);
    expect(itemsFromEvent({ type: 'generator:reasoning', step: 1, turn: 1, chars: 10, tail: 'x' }, 0)).toEqual([]);
  });

  it('a step row per agent step kind: Read / Grep / Todo batches, Edit (+a −d), Write, Bash · N passed / exit N, Verify, done — no risk, no judge', () => {
    const observe = agentStep(1, {
      kind: 'observe',
      calls: [
        { id: '1', name: 'read_file', summary: 'read_file calc/core.py (lines 1-120)', ok: true, ms: 2 },
        { id: '2', name: 'read_file', summary: 'read_file tests/test_core.py', ok: true, ms: 2 },
        { id: '3', name: 'grep', summary: 'grep "parse" in calc (3 matches)', ok: true, ms: 5 },
        { id: '4', name: 'todo_write', summary: 'todo_write (1/3 done)', ok: true, ms: 0 },
        { id: '5', name: 'read_file', summary: 'read_file missing.py', ok: false, ms: 1 },
      ],
    });
    expect(stepSummaryText(observe, { generator: 0.0021, jev: 0 })).toBe('Read calc/core.py, tests/test_core.py · Grep "parse" in calc (3 matches) · Todo (1/3 done) · Read missing.py (failed) · 1.2s · $0.002');
    const edit = agentStep(2, { kind: 'act', action: { kind: 'edit', path: 'calc/core.py', old: 'a\nb\n', new: 'c\nd\n' }, outcome: { status: 'executed', summary: 'edited', changedFiles: ['calc/core.py'] }, turn: null });
    expect(stepSummaryText(edit, { generator: 0, jev: 0 })).toBe('Edit calc/core.py (+2 −2) · 1.2s');
    const write = agentStep(3, { kind: 'act', action: { kind: 'write', path: 'notes.md', content: 'one\ntwo\n' }, outcome: { status: 'executed', summary: 'wrote', changedFiles: ['notes.md'] }, turn: 2 });
    expect(stepSummaryText(write, { generator: 0.0005, jev: 0 })).toMatch(/^Write notes\.md \(\+2 −0\) · 1\.2s · \$0\.0005$/);
    const bash = agentStep(4, { kind: 'act', action: { kind: 'run', command: 'python -m pytest -q' }, outcome: { status: 'executed', summary: 'ran', changedFiles: [] }, tests: { source: 'parsed', allPassed: true, passed: 7, failed: 0, errors: 0 }, turn: null });
    expect(stepSummaryText(bash)).toMatch(/^Bash python -m pytest -q · 7 passed · 1\.2s/);
    const failing = agentStep(5, { kind: 'act', action: { kind: 'run', command: 'npm test' }, outcome: { status: 'executed', summary: 'ran', changedFiles: [], exec: { ok: false, exitCode: 1, signal: null, stdout: '', stderr: '', truncated: false, bytesSeen: 0, killedBy: null } as never }, turn: null });
    expect(stepSummaryText(failing, { generator: 0, jev: 0 })).toBe('Bash npm test · exit 1 · 1.2s');
    const verify = agentStep(6, { kind: 'verify', action: { kind: 'run', command: 'npm test' }, outcome: { status: 'executed', summary: 'ran', changedFiles: [] }, tests: { source: 'parsed', allPassed: false, passed: 10, failed: 2, errors: 0 }, turn: null });
    expect(stepSummaryText(verify, { generator: 0, jev: 0 })).toBe('Verify npm test · 10 passed, 2 failed · 1.2s');
    const done = agentStep(7, { kind: 'finish', action: { kind: 'done', summary: 'ok' }, outcome: { status: 'noop', summary: 'done' }, remaining: ['write docs'] });
    expect(stepSummaryText(done, { generator: 0.0001, jev: 0 })).toBe('done · 1 todo left · 1.2s · $0.0001');
    const blocked = agentStep(8, { kind: 'act', action: { kind: 'run', command: 'rm -rf /' }, outcome: { status: 'blocked', reason: 'rule rm_outside' }, turn: null });
    expect(stepSummaryText(blocked, { generator: 0, jev: 0 })).toBe('Bash rm -rf / · blocked · 1.2s');
    for (const r of [observe, edit, write, bash, verify, done]) expect(stepSummaryText(r)).not.toMatch(/risk|judge/);
  });

  it('the pieces: call text, batch folding past three names, test counts', () => {
    expect(agentCallText({ name: 'bash', summary: 'bash git diff (exit 0)', ok: true })).toBe('Bash git diff (exit 0)');
    expect(agentCallText({ name: 'glob', summary: 'glob src/**/*.test.ts (40 files)', ok: true })).toBe('Glob src/**/*.test.ts (40 files)');
    expect(agentBatchText(['a', 'b', 'c', 'd', 'e'].map((f) => ({ name: 'read_file', summary: `read_file ${f}.ts`, ok: true })))).toBe('Read a.ts, b.ts, c.ts (+2)');
    expect(testCountsText({ passed: 3, failed: 0, errors: 1 })).toBe('3 passed, 1 error');
    expect(agentStepText(agentStep(1, { kind: 'observe', calls: [] , action: { kind: 'read', paths: ['a.ts'] } }))).toMatch(/^a\.ts · /);
  });
});

describe('the agent strip and the decisions tab (§14.3, peer G)', () => {
  const base = { tab: 'd' as const, step: 4, rows: [], plan: null, timeline: [], synth: null, mode: 'agent' as const };

  it('▸ s<N> · plan d/t · <k> tool calls — no jev, no decisions, no risk', () => {
    expect(agentStripSegments({ ...base, toolCalls: 9 })).toEqual(['▸ s4', '9 tool calls']);
    expect(agentStripSegments({ ...base, toolCalls: 1 })).toEqual(['▸ s4', '1 tool call']);
    const strip = panelStrip({ ...base, toolCalls: 9, latencies: [120, 130] }, 100);
    expect(strip).toMatch(/^─── ▸ s4 · 9 tool calls ─+$/);
    expect(strip).not.toMatch(/jev|decision|risk/);
  });

  it('the decisions tab of an agent run with no Jev decision says so', () => {
    expect(tabLines({ ...base }, 'd', 6, 80)).toEqual([AGENT_NO_DECISIONS]);
    expect(AGENT_NO_DECISIONS).toBe('a normal agent run makes no Jev decisions');
  });
});
