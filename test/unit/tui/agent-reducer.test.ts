/**
 * AGENT-LOOP-DESIGN §9.4, §A1, §A5 (slice S5a): the reducer over a fake agent event stream — the live buffer after
 * `assistant:text` keeps only the partial line, a reset drops it with the dim notice, the first tool call turns the run
 * chrome on and lands the held rows, a run that answered in prose hides its step row and stop line, the status word and
 * the mini indicator follow the activity, and no legacy run gets an agent view at all.
 */
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../../src/core/types.js';
import { AGENT_REPLY_RESTARTED, formatTranscriptItem, isRunHeaderItem } from '../../../src/tui/plain.js';
import { initialUiState, uiReducer, visibleItems, type UiAction, type UiState } from '../../../src/tui/useEngine.js';
import { statusView } from '../../../src/tui/StatusLine.js';
import { statusLineText } from '../../../src/tui/status/lines.js';
import { agentLastRunWasReply, agentLiveLines, agentReplyPhase, liveLines } from '../../../src/tui/App.js';
import { mkStatus } from '../../fixtures/tui/fixtures.js';
import { agentOpening, agentRunResult, agentStep, shapedTurn } from './agent-fixtures.js';

/** Drive the reducer the way useEngine's subscriber does: deltas go to the buffer and flush as `live`; the commit events carry the buffer. */
function drive(events: readonly EngineEvent[], s0: UiState = initialUiState('', null, { mode: 'session' })): UiState {
  let s = s0;
  let buffer = '';
  let agent = false;
  const act = (a: UiAction): void => {
    s = uiReducer(s, a);
  };
  for (const e of events) {
    if (e.type === 'run:start') agent = e.mode === 'agent';
    if (e.type === 'generator:delta') {
      buffer += e.text;
      act({ type: 'live', text: buffer, toolChars: 0 });
      continue;
    }
    if (agent && (e.type === 'assistant:text' || e.type === 'generator:start' || e.type === 'run:end')) {
      act({ type: 'event', event: e, live: buffer });
      if (e.type === 'assistant:text') buffer = s.live;
      else buffer = '';
      continue;
    }
    if (e.type === 'assistant:reset') buffer = '';
    act({ type: 'event', event: e });
  }
  return s;
}

/** What the interactive transcript shows: the compact-visible rows minus the run header rows (the App's own filter). */
const shown = (s: UiState): string[] => visibleItems(s.items).filter((i) => !isRunHeaderItem(i)).map((i) => formatTranscriptItem(i));

const finish = (step: number): EngineEvent[] => [
  { type: 'proposal', step, proposal: { goal: 'finish', action: { kind: 'done', summary: 'ok' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' } },
  { type: 'outcome', step, outcome: { status: 'noop', summary: 'done' } },
  { type: 'step:end', record: agentStep(step, { kind: 'finish', action: { kind: 'done', summary: 'ok' }, outcome: { status: 'noop', summary: 'done' } }), costUsd: { generator: 0.0001, jev: 0 } },
];

describe('agent reducer: the prose buffer and its commits', () => {
  it('after `assistant:text` only the partial line remains in `live` (not a clear); the committed lines are `[jevcode]` prose items', () => {
    const s = drive([...agentOpening('explain'), { type: 'generator:delta', step: 1, text: 'first line\nsecond li' }, { type: 'assistant:text', step: 1, turn: 1, attempt: 1, text: 'first line', final: false }]);
    expect(s.live).toBe('second li');
    const prose = s.items.filter((i) => i.prose !== undefined);
    expect(prose.map((i) => i.text)).toEqual(['first line']);
    expect(prose[0]!.label).toBe('[jevcode]');
    expect(formatTranscriptItem(prose[0]!)).toBe('[jevcode] first line');
  });

  it('the final remainder commits the rest; a turn with no deltas commits the event\'s own lines', () => {
    const s = drive([...agentOpening('x'), ...shapedTurn(1, 1, ['one\n', 'two'])]);
    expect(s.items.filter((i) => i.prose !== undefined).map((i) => i.text)).toEqual(['one', 'two']);
    expect(s.live).toBe('');
    const t = drive([...agentOpening('x'), { type: 'assistant:text', step: 1, turn: 1, attempt: 1, text: 'no deltas here\n\nat all', final: true }]);
    expect(t.items.filter((i) => i.prose !== undefined).map((i) => i.text)).toEqual(['no deltas here', '', 'at all']);
  });

  it('lines an overflow commit already moved are never committed twice — not even when the overflow used the whole buffer up', () => {
    let s = drive(agentOpening('x'));
    s = uiReducer(s, { type: 'reply:geometry', rows: 1, columns: 80 });
    s = drive([{ type: 'generator:delta', step: 1, text: 'line one\nline two\nline three\n' }, { type: 'assistant:text', step: 1, turn: 1, attempt: 1, text: 'line one\nline two\nline three', final: false }], s);
    expect(s.items.filter((i) => i.prose !== undefined).map((i) => i.text)).toEqual(['line one', 'line two', 'line three']);
    expect(s.live).toBe('');
  });

  it('`assistant:reset` drops the uncommitted text and leaves the dim notice `reply restarted after a dropped stream`', () => {
    const s = drive([...agentOpening('x'), { type: 'generator:delta', step: 1, text: 'half a sent' }, { type: 'assistant:reset', step: 1, turn: 1, attempt: 2 }]);
    expect(s.live).toBe('');
    const notice = s.items.find((i) => i.text === AGENT_REPLY_RESTARTED);
    expect(notice?.level).toBe('dim');
    expect((notice as { hidden?: boolean } | undefined)?.hidden).not.toBe(true);
  });

  it('a new turn commits what the last one left; the run end commits the rest of the buffer', () => {
    const s = drive([...agentOpening('x'), { type: 'generator:delta', step: 1, text: 'dangling' }, { type: 'generator:start', step: 2, attempt: 2 }]);
    expect(s.items.some((i) => i.prose !== undefined && i.text === 'dangling')).toBe(true);
    expect(s.live).toBe('');
  });
});

describe('agent reducer: a reply is a reply (§A1, §A5)', () => {
  it('a tool-less turn: the chat chrome while it streams, then no step row, no `[run] finished`, no run header in the visible rows', () => {
    let s = drive([...agentOpening('hi'), { type: 'generator:delta', step: 1, text: 'Hi!' }]);
    expect(agentReplyPhase(s)).toBe(true);
    s = drive([{ type: 'assistant:text', step: 1, turn: 1, attempt: 1, text: 'Hi!', final: true }, ...finish(1), { type: 'run:end', result: agentRunResult('answered'), exitCode: 0 }], s);
    const rows = shown(s);
    expect(rows).toEqual(['[jevcode] Hi!']);
    expect(s.items.some((i) => i.kind === 'run:end')).toBe(true);
    expect(s.items.some((i) => i.kind === 'step')).toBe(true);
    expect(agentReplyPhase(s)).toBe(false);
  });

  it('an Esc on a reply (human_abort before any tool call) ends it the way a chat reply ends — the partial prose stays, no stop line', () => {
    const s = drive([...agentOpening('write me a poem'), { type: 'generator:delta', step: 1, text: 'Roses are' }, { type: 'run:end', result: agentRunResult('human_abort', 0), exitCode: 130 }]);
    expect(shown(s)).toEqual(['[jevcode] Roses are']);
  });

  it('the first tool call turns the run chrome on and lands the held rows before the tool rows; the finish row stays out of the compact view', () => {
    const events: EngineEvent[] = [
      ...agentOpening('fix it'),
      { type: 'notice', step: null, kind: 'instructions', level: 'info', text: 'instructions: AGENTS.md (120 B)' },
      ...shapedTurn(1, 1, ["I'll read the parser.\n"]),
      { type: 'tool:call', step: 1, turn: 1, id: 'c1', name: 'read_file', summary: 'read_file calc/core.py', readOnly: true },
      { type: 'tool:result', step: 1, turn: 1, id: 'c1', name: 'read_file', ok: true, summary: 'read_file calc/core.py (lines 1-80)', ms: 3, chars: 900, readOnly: true },
      { type: 'proposal', step: 1, proposal: { goal: 'read_file calc/core.py', action: { kind: 'read', paths: ['calc/core.py'] }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' } },
      { type: 'outcome', step: 1, outcome: { status: 'executed', summary: 'read', changedFiles: [] } },
      { type: 'step:end', record: agentStep(1, { kind: 'observe', calls: [{ id: 'c1', name: 'read_file', summary: 'read_file calc/core.py (lines 1-80)', ok: true, ms: 3 }], action: { kind: 'read', paths: ['calc/core.py'] }, outcome: { status: 'executed', summary: 'read', changedFiles: [] } }), costUsd: { generator: 0.001, jev: 0 } },
      { type: 'step:start', step: 2, startedAt: '' },
      { type: 'generator:start', step: 2, attempt: 2 },
      ...shapedTurn(2, 2, ['Fixed the parser.']),
      ...finish(2),
      { type: 'run:end', result: agentRunResult('generator_done', 2), exitCode: 0 },
    ];
    const s = drive(events);
    const rows = shown(s);
    expect(rows[0]).toBe("[jevcode] I'll read the parser.");
    // the held `instructions:` row lands when the chrome turns on (after the first prose, before the tool rows)
    expect(rows[1]).toMatch(/^\[run\] instructions: AGENTS\.md \(120 B\)$/);
    expect(rows[2]).toMatch(/^\[step 1\] Read calc\/core\.py/);
    expect(rows).toContain('[jevcode] Fixed the parser.');
    expect(rows.some((r) => r.startsWith('[step 2] done'))).toBe(false);
    expect(rows.at(-1)).toMatch(/^\[run\] finished · generator_done · 2 steps/);
    // the read-only tool row is a full-view row (hidden in compact)
    expect(rows.some((r) => r.includes('tool · read_file'))).toBe(false);
    expect(s.items.some((i) => i.kind === 'tool')).toBe(true);
    expect(s.agent?.toolCalls).toBe(1);
  });
});

describe('agent reducer: the live view names what runs now (peer C)', () => {
  const at = (events: EngineEvent[]): UiState => drive([...agentOpening('go'), ...events]);

  it('thinking at a model turn · reading for a read-only batch · editing / running for the mutating call · testing for the harness run', () => {
    expect(at([]).agent?.activity).toBe('thinking');
    expect(at([{ type: 'tool:call', step: 1, turn: 1, id: 'a', name: 'grep', summary: 'grep "x" in src', readOnly: true }]).agent?.activity).toBe('reading');
    const edit = { type: 'proposal' as const, step: 2, proposal: { goal: 'edit_file a.ts', action: { kind: 'edit' as const, path: 'a.ts', old: 'a', new: 'b' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' } };
    expect(at([edit]).agent?.activity).toBe('editing');
    const bash = { type: 'proposal' as const, step: 2, proposal: { goal: 'bash npm test', action: { kind: 'run' as const, command: 'npm test' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' } };
    expect(at([bash]).agent?.activity).toBe('running');
    expect(at([bash]).agent?.running).toBe('Bash npm test');
    const verify = { type: 'proposal' as const, step: 3, proposal: { goal: 'verify npm test', action: { kind: 'run' as const, command: 'npm test' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' } };
    expect(at([verify]).agent?.activity).toBe('testing');
    expect(at([verify]).agent?.running).toBe('Verify npm test');
  });

  it('the final `done` proposal keeps the activity it follows (no stage verb leaks in while the run finishes)', () => {
    const s = at([{ type: 'proposal', step: 1, proposal: { goal: 'finish', action: { kind: 'done', summary: 'ok' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' } }]);
    expect(s.agent?.activity).toBe('thinking');
    expect(s.agent?.running).toBeNull();
  });

  it('the status row reads the activity word from t = 0 of the step — before any engine `status` event', () => {
    const s = at([{ type: 'tool:call', step: 1, turn: 1, id: 'a', name: 'read_file', summary: 'read_file a.ts', readOnly: true }]);
    const row = statusLineText(statusView(s), 76, { spinnerFrame: 0 });
    expect(row).toMatch(/^\S+ reading\s/);
    const t = at([{ type: 'step:start', step: 2, startedAt: '' }]);
    expect(t.stageStartedAt).not.toBeNull();
    expect(statusView({ ...t, agent: { ...t.agent!, tools: true } }).agentWord).toBe('thinking');
  });

  it('the live region: the running tool row over its output tail (a partial line is text), a batch in flight, the call being written, reasoning — never a counter', () => {
    const s = at([{ type: 'proposal', step: 2, proposal: { goal: 'bash pytest', action: { kind: 'run', command: 'python -m pytest -q' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' } }]);
    expect(agentLiveLines(s.agent!, 'collected 7 items\n....', false, 2, 80).lines).toEqual(['Bash python -m pytest -q', '....']);
    const b = at([
      { type: 'tool:call', step: 1, turn: 1, id: 'a', name: 'read_file', summary: 'read_file a.ts', readOnly: true },
      { type: 'tool:call', step: 1, turn: 1, id: 'b', name: 'grep', summary: 'grep "x" in src', readOnly: true },
    ]);
    expect(agentLiveLines(b.agent!, '', false, 2, 80).lines).toEqual(['Read a.ts · Grep "x" in src…']);
    const w = uiReducer(at([]), { type: 'live', text: '', toolChars: 1200, writing: { tool: 'edit_file', target: 'src/a.ts', chars: 1200 } });
    expect(agentLiveLines(w.agent!, '', false, 2, 80).lines).toEqual(['writing edit_file src/a.ts… 1.2k chars']);
    const r = at([{ type: 'generator:reasoning', step: 1, turn: 1, chars: 1500, tail: 'the tests import parse from calc' }]);
    expect(agentLiveLines(r.agent!, '', false, 2, 80)).toEqual({ lines: ['thinking… 1.5k chars · the tests import parse from calc'], dim: true });
    for (const x of [s, b, w, r]) expect(agentLiveLines(x.agent!, '', false, 2, 80).lines.join('')).not.toMatch(/streaming/);
  });
});

describe('legacy runs are untouched', () => {
  it('a jev-on run gets no agent view, and its deltas stay in the legacy live region', () => {
    const s = drive([
      { type: 'run:start', runId: 'r1', task: 't', mode: 'jev-on', resumedFromStep: null },
      { type: 'generator:start', step: 1, attempt: 1 },
      { type: 'generator:delta', step: 1, text: '{"x":1}' },
      { type: 'status', status: mkStatus(1, 'propose') },
    ]);
    expect(s.agent).toBeNull();
    expect(s.live).toBe('{"x":1}');
    expect(s.items.some((i) => i.prose !== undefined)).toBe(false);
  });
});

describe('the agent view is the view of a run in flight (review: stale `state.agent`)', () => {
  const ended = (): UiState => drive([...agentOpening('hi'), ...shapedTurn(1, 1, ['Hi!']), ...finish(1), { type: 'run:end', result: agentRunResult('answered'), exitCode: 0 }]);

  it('a later legacy chat reply (`/mode llm-jev`, then a long reply) is the legacy live region: no prose items, no reply bookkeeping', () => {
    let s = uiReducer(ended(), { type: 'reply:geometry', rows: 4, columns: 80 });
    const before = s.items.length;
    s = uiReducer(s, { type: 'run:starting' });
    const text = Array.from({ length: 8 }, (_, i) => `chat line ${i}`).join('\n');
    s = uiReducer(s, { type: 'live', text, at: 1 });
    expect(s.items.length).toBe(before);
    expect(s.items.some((i) => i.text.startsWith('chat line'))).toBe(false);
    expect(s.live).toBe(text);
    // a geometry change between runs commits nothing either
    s = uiReducer(s, { type: 'reply:geometry', rows: 2, columns: 60 });
    expect(s.items.length).toBe(before);
    // the App draws it with the legacy live rows (the agent view is null once the run is over)
    expect(liveLines(s.live, 4, 80)).toEqual(['chat line 4', 'chat line 5', 'chat line 6', 'chat line 7']);
    s = uiReducer(s, { type: 'live', text: '', at: 2 });
    expect(s.live).toBe('');
  });

  it('after a run that ended as a reply the idle rows read like chat; a Esc-stopped reply winds down with the chat chrome', () => {
    const s = ended();
    expect(agentLastRunWasReply(s)).toBe(true);
    expect(s.repliesEnded).toBe(1);
    expect(s.runsEnded).toBe(1);
    const live = drive([...agentOpening('write a poem'), { type: 'generator:delta', step: 1, text: 'Roses' }]);
    const aborting = uiReducer(live, { type: 'run:aborting' });
    expect(agentReplyPhase(aborting)).toBe(true);
    // a run that used a tool is not a reply, live or ended
    const tool = drive([...agentOpening('fix'), { type: 'tool:call', step: 1, turn: 1, id: 'c', name: 'read_file', summary: 'read_file a.ts', readOnly: true }]);
    expect(agentReplyPhase(uiReducer(tool, { type: 'run:aborting' }))).toBe(false);
    const toolEnded = drive([{ type: 'run:end', result: agentRunResult('human_abort', 1), exitCode: 130 }], tool);
    expect(agentLastRunWasReply(toolEnded)).toBe(false);
    expect(toolEnded.repliesEnded).toBe(0);
  });
});

describe('overflow commits: no jump when a paragraph first outgrows the block (review: commitOverflow k = 0)', () => {
  it('the spacer never goes alone: every overflow commit that takes the spacer takes a body row with it', () => {
    let s = drive(agentOpening('tell me'));
    s = uiReducer(s, { type: 'local', text: 'tell me', label: '[you]' });
    s = uiReducer(s, { type: 'reply:geometry', rows: 4, columns: 80 });
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    let buffer = '';
    for (let i = 0; i < words.length; i += 7) {
      buffer += words.slice(i, i + 7);
      s = uiReducer(s, { type: 'live', text: buffer, toolChars: 0 });
      // what the block would draw never exceeds its cap by the spacer alone
      const prose = s.items.filter((it) => it.prose !== undefined);
      if (prose.length > 0) expect(prose[0]!.prose!.to ?? 1).toBeGreaterThan(0);
    }
    const prose = s.items.filter((it) => it.prose !== undefined);
    expect(prose.length).toBeGreaterThan(0);
    // the head item (spacer + label) always carries at least one body row
    expect(prose[0]!.text.length).toBeGreaterThan(0);
  });
});
