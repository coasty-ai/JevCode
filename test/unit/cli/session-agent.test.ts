/**
 * The session controller in `agent` mode (AGENT-LOOP-DESIGN §A1, §A5, §7.6, §14.2) over the scripted engine factory — never a real
 * agent run (the agent factory in this base is a stub). Jev is optional: with no Jev key both engine sites (a run start and a
 * resume) build the absent decider and nothing opens a wizard for it. Every message is one agent run carrying the session
 * conversation; a reply (`answered`) prints no epilogue and never names the session; Esc before the first tool call is "reply
 * stopped"; a transient provider failure retries once; the spend cap clamps silently with a sparse note.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent, EngineOptions, SerializedError } from '../../../src/core/types.js';
import { ABSENT_DECIDER_MODEL } from '../../../src/jev/absent.js';
import { AGENT_CHAT_CARRY_CHARS, AGENT_CHAT_CARRY_TURNS, DO_IT_OFFER, ONE_SHOT_REPLY_REFUSAL, ON_IT_LINE, REPLY_STOPPED_TOAST, chatCarry, isTransientProviderError, runCapClampedNote, sessionEndedText } from '../../../src/cli/session.js';
import { AGENT_NO_DECISIONS_TEXT } from '../../../src/chat/facts.js';
import { MOCK_CHAT_REPLY } from '../../../src/provider/mock.js';
import { readIndex } from '../../../src/session/index.js';
import { newestWorkRun } from '../../../src/session/picker-lines.js';
import { harnessDecider, loadedRun, makeController, scriptedRunId, tick, waitFor, type Harness, type RunScript } from './helpers.js';

/** the `<JEVCODE_EXTRA_ENV_FILE>` fallback must never find this machine's sibling checkout in a `mock: false` test */
const NO_EXTRA_ENV = '/nonexistent/extra.env';
/** agent mode, a mocked generator, and NO Jev key anywhere (`--mock` would stand in for Jev; `--mock-generator` does not) */
const NO_JEV = { flags: { mode: 'agent', mock: false, mockGenerator: true }, env: { JEVCODE_EXTRA_ENV_FILE: NO_EXTRA_ENV } } as const;

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeController>): Promise<Harness> {
  const h = await makeController(...args);
  harnesses.push(h);
  return h;
}

describe('Jev optional (§14.2): the absent decider at both engine sites', () => {
  it('run start: an agent run with no Jev key gets the absent decider; no wizard, no missing-key error', async () => {
    const asked: string[] = [];
    const h = await build({ ...NO_JEV, mode: 'one-shot', task: 'fix the failing test', prompts: { wizard: async () => (asked.push('wizard'), { kind: 'cancelled' }) } });
    const code = await h.controller.run();
    expect(code).toBe(0);
    expect(asked).toEqual([]);
    expect(h.factory.calls).toHaveLength(1);
    const opts = h.factory.calls[0]!;
    expect(opts.mode).toBe('agent');
    expect(opts.decider.model).toBe(ABSENT_DECIDER_MODEL);
    expect(opts.deciderModel).toEqual({ configured: ABSENT_DECIDER_MODEL, pinned: false });
    expect(h.stderr.join('')).not.toContain('decider.apiKey');
  });

  it('resume: /resume of an agent run with no Jev key builds the absent decider too', async () => {
    const id = scriptedRunId(7001);
    const h = await build({
      ...NO_JEV,
      deps: {
        loadForResume: async (_dir, runId) => {
          const l = loadedRun({ runId, workspace: h.workspace, task: 'fix the failing test', stop: 'human_pause', step: 4 });
          return { meta: { ...l.meta, mode: 'agent' }, state: { ...l.state!, mode: 'agent' }, previousStopReason: 'human_pause', warnings: [] };
        },
      },
    });
    void h.controller.run();
    await h.ready();
    await h.command(`/resume ${id}`);
    expect(h.factory.calls, h.renderer.notes.map((n) => n.text).join(' | ')).toHaveLength(1);
    const opts = h.factory.calls[0]!;
    expect(opts.resume).toEqual({ runId: id, force: false });
    expect(opts.mode).toBe('agent');
    expect(opts.decider.model).toBe(ABSENT_DECIDER_MODEL);
    expect(opts.deciderModel.configured).toBe(ABSENT_DECIDER_MODEL);
  });

  it('a legacy mode still requires the Jev key: the same keyless start under llm-jev fails (the pipe names the missing key)', async () => {
    const h = await build({ flags: { mode: 'llm-jev', mock: false, mockGenerator: true }, env: { JEVCODE_EXTRA_ENV_FILE: NO_EXTRA_ENV }, mode: 'one-shot', task: 'fix the failing test', interactive: false });
    const code = await h.controller.run();
    expect(code).not.toBe(0);
    expect(h.factory.calls).toHaveLength(0);
    expect(h.stderr.join('')).toContain('decider.apiKey');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// §A1: every message is an agent run — no intake, no canned assistant text, the conversation carried
// ---------------------------------------------------------------------------------------------------------------

const AGENT = { flags: { mode: 'agent' } } as const;
const bubbles = (h: Harness, label: '[you]' | '[jevcode]'): string[] => h.renderer.notes.filter((n) => n.label === label).map((n) => n.text);
const epilogues = (h: Harness): string[] => h.renderer.notes.filter((n) => n.text.startsWith('stopped —')).map((n) => n.text);
const toasts = (h: Harness): string[] => h.renderer.dispatched.filter((a) => a.type === 'toast').map((a) => (a as { text: string }).text);
const submitOpts = (h: Harness): { kind: 'prompt' | 'follow-up'; secretSpans: string[]; pinnedFiles: string[] } => ({ kind: h.host.ranBefore() ? 'follow-up' : 'prompt', secretSpans: [], pinnedFiles: [] });
/** an agent turn that made one tool call (a task run) */
const toolCall = (id: string): EngineEvent => ({ type: 'tool:call', step: 1, turn: 1, id, name: 'read_file', summary: 'read_file README.md', readOnly: true });
/** the script of an agent session: a greeting / question is a reply (`answered`), anything else a task with one tool call */
const agentScript = (opts: EngineOptions): RunScript => (/^(hi|hello|thanks|who|what)\b/i.test(opts.task) ? { stop: 'answered', steps: 1, cost: { generator: 0.001, jev: 0 } } : { events: [toolCall('c1')], stop: 'complete', steps: 4, cost: { generator: 0.02, jev: 0 } });
const PROVIDER_503: SerializedError = { name: 'ProviderHttpError', code: 'provider_http', message: 'openrouter HTTP 503: upstream overloaded', exitCode: 5 };

describe('§A1: every chat message becomes one agent run', () => {
  it('`hi` → one agent run, the [you] bubble, prose only: no intake, no Jev call, no ON_IT / DO_IT / catalogue text, no epilogue, no title', async () => {
    const h = await build({ ...AGENT, script: agentScript });
    void h.controller.run();
    await h.ready();
    const outcome = await h.host.submit('hi', submitOpts(h));
    expect(outcome).toEqual({ became: 'run' });
    await h.host.awaitRunEnd();
    await tick(0);
    expect(h.factory.calls).toHaveLength(1);
    const opts = h.factory.calls[0]!;
    expect(opts.mode).toBe('agent');
    expect(opts.task).toBe('hi');
    expect(opts.session?.intake).toBeUndefined();
    // §7.6: the first run of a session carries no chat turn and no parent
    expect(opts.conversation).toEqual({ chat: [], parent: null });
    expect(bubbles(h, '[you]')).toEqual(['hi']);
    // the assistant's reply is the run's streamed prose (the renderer's); the controller adds no line of its own
    expect(bubbles(h, '[jevcode]')).toEqual([]);
    for (const n of h.renderer.notes) {
      expect(n.text).not.toBe(ON_IT_LINE);
      expect(n.text).not.toBe(DO_IT_OFFER);
      expect(n.text).not.toBe(MOCK_CHAT_REPLY);
    }
    // no intake: the decider is never asked, and no `thinking` phase is dispatched
    expect(h.decider.calls).toHaveLength(0);
    expect(h.renderer.dispatched.filter((a) => a.type === 'thinking')).toEqual([]);
    // §A5 amendment: a reply has no epilogue item in the interactive session; the run line is still indexed (a reply, exit 0)
    expect(epilogues(h)).toEqual([]);
    expect(h.index().find((l) => l.kind === 'run:end')).toMatchObject({ stopReason: 'answered', exitCode: 0 });
    // §A5: the reply does not name the session
    expect((await readIndex(h.indexPath)).sessions[0]?.title).toBe('');
  });

  it('a task → tool rows, the session title from it; the next message carries the previous run as its parent (§7.6)', async () => {
    const h = await build({ ...AGENT, script: agentScript });
    void h.controller.run();
    await h.ready();
    await h.submit('hi');
    await h.submit('fix the failing test');
    await h.submit('thanks');
    expect(h.factory.calls.map((c) => c.task)).toEqual(['hi', 'fix the failing test', 'thanks']);
    const [first, second, third] = h.factory.engines;
    expect(h.factory.calls[1]!.conversation).toEqual({ chat: [], parent: { runId: first!.runId, runDir: join(h.factory.calls[0]!.runsDir, first!.runId), mode: 'agent' } });
    expect(h.factory.calls[2]!.conversation?.parent?.runId).toBe(second!.runId);
    // the seed comes from that one parent (its undo log, pinned files and, for a legacy parent, the "Previous run" block)
    expect(h.factory.calls[1]!.seed?.parentRunId).toBe(first!.runId);
    expect(h.factory.calls[1]!.session?.parentRunId).toBe(first!.runId);
    // the task run is a run: its epilogue item stays; the two replies print none
    expect(epilogues(h)).toEqual(['stopped — complete (exit 0)']);
    // the renderer saw the tool row event of the task run
    expect(h.renderer.events.filter((e) => e.type === 'tool:call')).toHaveLength(1);
    const folded = (await readIndex(h.indexPath)).sessions[0]!;
    expect(folded.title).toBe('fix the failing test');
    expect(folded.runs.map((r) => r.stopReason)).toEqual(['answered', 'complete', 'answered']);
    expect(third!.runId).not.toBe(second!.runId);
  });

  it('the [you] bubble lands synchronously with the submission (the Enter frame), before the run exists', async () => {
    const h = await build({ ...AGENT, script: agentScript });
    void h.controller.run();
    await h.ready();
    await tick(10);
    const p = h.host.submit('hi', submitOpts(h));
    // nothing awaited yet: the bubble is already committed
    expect(bubbles(h, '[you]')).toEqual(['hi']);
    await p;
    await h.host.awaitRunEnd();
  });

  it('provider error → one `[ui]` error row and ONE automatic retry of the same message with the same carry; never an assistant line', async () => {
    const h = await build({ ...AGENT, script: (_o, n) => (n === 1 ? { stop: 'error', error: PROVIDER_503, steps: 0 } : { stop: 'answered', steps: 1 }) });
    void h.controller.run();
    await h.ready();
    await h.host.submit('hi', submitOpts(h));
    await waitFor(() => h.factory.calls.length === 2 && h.host.phase() === 'none', 4000, 'the retry');
    await tick(0);
    expect(h.factory.calls.map((c) => c.task)).toEqual(['hi', 'hi']);
    expect(h.factory.calls[1]!.conversation).toEqual(h.factory.calls[0]!.conversation);
    const errors = h.renderer.notes.filter((n) => n.label === '[ui]' && n.level === 'error').map((n) => n.text);
    expect(errors).toEqual(['error: provider_http: openrouter HTTP 503: upstream overloaded — retrying once']);
    expect(bubbles(h, '[you]')).toEqual(['hi']);
    expect(bubbles(h, '[jevcode]')).toEqual([]);
    expect(epilogues(h)).toEqual([]);
  });

  it('a second transient failure, or a non-transient one, is not retried: the epilogue item is the [ui] error row', async () => {
    const h = await build({ ...AGENT, script: () => ({ stop: 'error', error: PROVIDER_503, steps: 0 }) });
    void h.controller.run();
    await h.ready();
    await h.host.submit('hi', submitOpts(h));
    await waitFor(() => h.factory.calls.length === 2 && h.host.phase() === 'none', 4000, 'the retry');
    await tick(20);
    expect(h.factory.calls).toHaveLength(2);
    expect(epilogues(h)).toEqual(['stopped — provider_http: openrouter HTTP 503: upstream overloaded (exit 5)']);
    const h2 = await build({ ...AGENT, script: () => ({ stop: 'error', error: { name: 'ProviderHttpError', code: 'provider_http', message: 'openrouter HTTP 401: invalid key', exitCode: 2 }, steps: 0 }) });
    void h2.controller.run();
    await h2.ready();
    await h2.submit('hi');
    await tick(20);
    expect(h2.factory.calls).toHaveLength(1);
    expect(epilogues(h2)).toEqual(['stopped — provider_http: openrouter HTTP 401: invalid key (exit 2)']);
  });

  it('Esc / Ctrl-C mid-reply (before any tool call) is "reply stopped": abort not pause, a toast, no epilogue, the session keeps going', async () => {
    const h = await build({ ...AGENT, script: (o) => (o.task === 'hi' ? { hold: true, stop: 'answered' } : { stop: 'answered' }) });
    void h.controller.run();
    await h.ready();
    const live = h.factory.nextLive();
    await h.host.submit('hi', submitOpts(h));
    const eng = await live;
    // the App's Esc before the first tool call: even a pause request stops the reply
    h.host.pause();
    await h.host.awaitRunEnd();
    await tick(0);
    expect(eng.aborts).toEqual([{ reason: 'human_abort' }]);
    expect(eng.pausing).toBe(false);
    expect(epilogues(h)).toEqual([]);
    expect(h.renderer.notes.some((n) => n.text.startsWith('paused after step'))).toBe(false);
    expect(toasts(h)).toEqual([REPLY_STOPPED_TOAST]);
    expect(h.controller.view.runs[0]?.stopReason).toBe('human_abort');
    // the session stays open: the next message is a run whose parent is the stopped one
    await h.submit('hello');
    expect(h.factory.calls).toHaveLength(2);
    expect(h.factory.calls[1]!.conversation?.parent?.runId).toBe(eng.runId);
    expect(h.exits).toEqual([]);
  });

  it('after the first tool call the run is a run: Ctrl-C aborts with today\'s epilogue item', async () => {
    const h = await build({ ...AGENT, script: () => ({ hold: true, events: [toolCall('c1')], stop: 'complete' }) });
    void h.controller.run();
    await h.ready();
    const live = h.factory.nextLive();
    await h.host.submit('fix the failing test', submitOpts(h));
    await live;
    h.host.abort('human_abort');
    await h.host.awaitRunEnd();
    await tick(0);
    expect(epilogues(h)).toEqual(['stopped — human_abort (exit 130)']);
    expect(toasts(h)).toEqual([]);
  });
});

describe('§7.6: the conversation carry', () => {
  it('chatCarry keeps the newest 20 turns within 14,000 chars, oldest first; an oversized newest turn is cut', () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 === 0 ? 'you' : 'jevcode') as 'you' | 'jevcode', text: `turn ${i}` }));
    const c = chatCarry(turns);
    expect(c).toHaveLength(AGENT_CHAT_CARRY_TURNS);
    expect(c[0]!.text).toBe('turn 10');
    expect(c.at(-1)!.text).toBe('turn 29');
    const big = Array.from({ length: 5 }, (_, i) => ({ role: 'you' as const, text: `${i}`.repeat(4000) }));
    const b = chatCarry(big);
    expect(b.map((t) => t.text[0])).toEqual(['2', '3', '4']);
    expect(b.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(AGENT_CHAT_CARRY_CHARS);
    const huge = chatCarry([{ role: 'you', text: 'a' }, { role: 'you', text: 'x'.repeat(AGENT_CHAT_CARRY_CHARS + 50) }]);
    expect(huge).toHaveLength(1);
    expect(huge[0]!.text.length).toBe(AGENT_CHAT_CARRY_CHARS);
    expect(chatCarry([])).toEqual([]);
  });

  it('chat turns before a switch to agent mode reach the first agent run once; the run after it carries none', async () => {
    const h = await build({ decider: harnessDecider({ classify: () => 'greeting_or_smalltalk' }), script: agentScript });
    void h.controller.run();
    await h.ready();
    // legacy mode (the default): a chat reply lands in the ledger as a [you] + [jevcode] pair
    expect(await h.host.submit('hello there', submitOpts(h))).toEqual({ became: 'chat' });
    await h.command('/mode agent');
    await h.submit('fix the failing test');
    expect(h.factory.calls[0]!.mode).toBe('agent');
    expect(h.factory.calls[0]!.conversation).toEqual({ chat: [{ role: 'you', text: 'hello there' }, { role: 'jevcode', text: MOCK_CHAT_REPLY }], parent: null });
    await h.submit('thanks');
    expect(h.factory.calls[1]!.conversation?.chat).toEqual([]);
    expect(h.factory.calls[1]!.conversation?.parent?.runId).toBe(h.factory.engines[0]!.runId);
  });

  it('/new: the next run carries no turn and no parent of the ended session', async () => {
    const h = await build({ ...AGENT, script: agentScript });
    void h.controller.run();
    await h.ready();
    await h.submit('hi');
    await h.command('/new');
    await h.submit('hello');
    expect(h.factory.calls[1]!.conversation).toEqual({ chat: [], parent: null });
    expect(h.factory.calls[1]!.session?.sessionId).toBeNull();
  });
});

describe('§A1 follow-up spend gate: a silent clamp with a sparse note, a one-line refusal, never a box', () => {
  it('prints once when the clamp first applies, again only below the next whole dollar; refuses at the cap with one line', async () => {
    const costs = [7.6, 0.3, 0.2, 0.05, 5];
    const asked: string[] = [];
    const h = await build({ ...AGENT, flags: { mode: 'agent', sessionSpendCap: '12', spendCap: '5' }, prompts: { followUp: async () => (asked.push('box'), 'y') }, script: (_o, n) => ({ stop: 'answered', cost: { generator: costs[n - 1] ?? 0, jev: 0 } }) });
    void h.controller.run();
    await h.ready();
    const clampNotes = (): string[] => h.renderer.notes.filter((n) => n.text.startsWith('run cap clamped')).map((n) => n.text);
    await h.submit('hi'); // spent 0 → no clamp
    expect(clampNotes()).toEqual([]);
    await h.submit('hi'); // spent 7.60 → left 4.40: the first clamp — printed
    expect(clampNotes()).toEqual([runCapClampedNote(4.4, 4.4)]);
    expect(clampNotes()[0]).toBe('run cap clamped to $4.40 (session has $4.40 left)');
    await h.submit('hi'); // spent 7.90 → 4.10: same whole dollar — silent
    expect(clampNotes()).toHaveLength(1);
    await h.submit('hi'); // spent 8.10 → 3.90: below $4 — printed
    expect(clampNotes()).toEqual(['run cap clamped to $4.40 (session has $4.40 left)', 'run cap clamped to $3.90 (session has $3.90 left)']);
    await h.submit('hi'); // spent 8.15 → 3.85: silent; this run spends 5 → 13.15 ≥ 12
    expect(clampNotes()).toHaveLength(2);
    // the engine never gets a budget:clamp item (the note is the controller's, printed on its own cadence)
    for (const c of h.factory.calls) expect(c.session?.clamp).toBeUndefined();
    expect(h.factory.calls[1]!.meter.snapshot().capUsd).toBeCloseTo(4.4, 6);
    const before = h.factory.calls.length;
    expect(await h.host.submit('hi', submitOpts(h))).toEqual({ became: 'nothing' });
    expect(h.factory.calls).toHaveLength(before);
    expect(h.renderer.notes.filter((n) => n.text.startsWith('session cap reached'))).toHaveLength(1);
    expect(asked).toEqual([]);
  });
});

describe('/jev, /why, /decisions in agent mode (peer review G)', () => {
  it('answer "a normal agent run makes no Jev decisions" instead of an empty table', async () => {
    const h = await build({ ...AGENT, script: (o) => ({ ...agentScript(o), result: { jevQuestions: 0 } }) });
    void h.controller.run();
    await h.ready();
    await h.submit('fix the failing test');
    await h.command('/jev');
    expect(h.renderer.notes.at(-1)?.detail ?? h.renderer.notes.at(-1)?.text).toContain(AGENT_NO_DECISIONS_TEXT);
    await h.command('/decisions');
    expect(h.renderer.notes.at(-1)?.detail ?? '').toContain(AGENT_NO_DECISIONS_TEXT);
    await h.command('/why risk.destructive');
    expect(h.renderer.notes.at(-1)?.text).toBe(AGENT_NO_DECISIONS_TEXT);
  });
});

describe('§A5: a reply never hides the task before it from /undo, /rewind and /diff <step>', () => {
  it('fix → thanks: the step context (and /undo\'s target) is still the task run\'s changed steps', async () => {
    const outcome: EngineEvent = { type: 'outcome', step: 2, outcome: { status: 'executed', summary: 'ok', changedFiles: ['a.py'] } };
    const h = await build({ ...AGENT, script: (o) => (o.task === 'thanks' ? { stop: 'answered', steps: 1 } : { events: [toolCall('c1'), outcome], stop: 'complete', steps: 4 }) });
    void h.controller.run();
    await h.ready();
    await h.submit('fix the failing test');
    await h.submit('thanks');
    const ctx = h.controller.host.dispatchContext();
    expect(ctx.step).toBe(4);
    expect(ctx.changedSteps).toEqual([2]);
    expect(h.controller.view.runs.map((r) => r.stopReason)).toEqual(['complete', 'answered']);
  });
});

describe('§A5: a reply is never resumed — -c, /continue, the picker and --resume <title> adopt its session', () => {
  const notes = (h: Harness): string[] => h.renderer.notes.map((n) => n.text);

  it('fix → thanks → /new → /continue: no resume; the next message carries the thanks run as its parent', async () => {
    const h = await build({ ...AGENT, script: agentScript });
    void h.controller.run();
    await h.ready();
    await h.submit('fix the failing test');
    await h.submit('thanks');
    const [, thanks] = h.factory.engines;
    const sid = h.factory.engines[0]!.runId;
    await tick(20);
    await h.command('/new');
    await h.command('/continue');
    expect(h.factory.calls.filter((c) => c.resume !== undefined)).toEqual([]);
    expect(notes(h)).toContain(`session ${sid} continues: run ${thanks!.runId} was a reply, so type a follow-up`);
    expect(epilogues(h)).toEqual(['stopped — complete (exit 0)']);
    await h.submit('and the other test');
    expect(h.factory.calls).toHaveLength(3);
    expect(h.factory.calls[2]!.resume).toBeUndefined();
    expect(h.factory.calls[2]!.conversation?.parent?.runId).toBe(thanks!.runId);
    expect(h.factory.calls[2]!.session?.sessionId).toBe(sid);
  });

  it('-c at startup on a session whose newest run is a reply adopts it (no resume)', async () => {
    const first = await build({ ...AGENT, script: agentScript });
    void first.controller.run();
    await first.ready();
    await first.submit('fix the failing test');
    await first.submit('thanks');
    const sid = first.factory.engines[0]!.runId;
    const thanks = first.factory.engines[1]!.runId;
    await tick(20);
    const h = await build({ flags: { mode: 'agent', continue: true }, script: agentScript, home: first.home, workspace: first.workspace });
    void h.controller.run();
    await h.ready();
    await waitFor(() => notes(h).some((t) => t.startsWith(`session ${sid} continues`)), 4000, 'the adoption note');
    expect(h.factory.calls).toEqual([]);
    expect(notes(h)).toContain(`session ${sid} continues: run ${thanks} was a reply, so type a follow-up`);
    await h.submit('now the docs');
    expect(h.factory.calls).toHaveLength(1);
    expect(h.factory.calls[0]!.resume).toBeUndefined();
    expect(h.factory.calls[0]!.conversation?.parent?.runId).toBe(thanks);
    expect(h.factory.calls[0]!.session?.sessionId).toBe(sid);
  });

  it('--resume <title>, or the reply run\'s id, on a session whose newest run is a reply adopts it', async () => {
    const first = await build({ ...AGENT, script: agentScript });
    void first.controller.run();
    await first.ready();
    await first.submit('fix the failing test');
    await first.submit('thanks');
    const sid = first.factory.engines[0]!.runId;
    const thanks = first.factory.engines[1]!.runId;
    await tick(20);
    const h = await build({ flags: { mode: 'agent', resume: 'fix the failing test' }, script: agentScript, home: first.home, workspace: first.workspace });
    void h.controller.run();
    await h.ready();
    await waitFor(() => notes(h).some((t) => t.startsWith(`session ${sid} continues`)), 4000, 'the adoption note');
    expect(h.factory.calls).toEqual([]);
    expect(notes(h)).toContain(`session ${sid} continues: run ${thanks} was a reply, so type a follow-up`);
    // --resume <the reply's run id> adopts too
    const byId = await build({ flags: { mode: 'agent', resume: thanks }, script: agentScript, home: first.home, workspace: first.workspace });
    void byId.controller.run();
    await byId.ready();
    await waitFor(() => notes(byId).some((t) => t.startsWith(`session ${sid} continues`)), 4000, 'the adoption note');
    expect(byId.factory.calls).toEqual([]);
  });

  it('one-shot: `run --resume <reply> "<task>"` sends the task as the follow-up; with no task it is a usage error, never a hang', async () => {
    const first = await build({ ...AGENT, script: agentScript });
    void first.controller.run();
    await first.ready();
    await first.submit('fix the failing test');
    await first.submit('thanks');
    const thanks = first.factory.engines[1]!.runId;
    await tick(20);
    // with no task: a usage error (exit 2) naming what to do, never a process waiting for a message it cannot get
    for (const flags of [{ resume: thanks }, { continue: true }]) {
      const bare = await build({ mode: 'one-shot', task: null, flags: { mode: 'agent', ...flags }, script: agentScript, home: first.home, workspace: first.workspace });
      const code = await Promise.race([bare.controller.run(), tick(4000).then(() => 'hang')]);
      expect(code).toBe(2);
      expect(bare.factory.calls).toEqual([]);
      expect(bare.stderr.join('')).toContain(ONE_SHOT_REPLY_REFUSAL);
    }
    // with a task: the next turn of the conversation, the reply as its parent
    const withTask = await build({ mode: 'one-shot', task: 'now the docs', flags: { mode: 'agent', resume: thanks }, script: agentScript, home: first.home, workspace: first.workspace });
    expect(await withTask.controller.run()).toBe(0);
    expect(withTask.factory.calls).toHaveLength(1);
    expect(withTask.factory.calls[0]!.resume).toBeUndefined();
    expect(withTask.factory.calls[0]!.task).toBe('now the docs');
    expect(withTask.factory.calls[0]!.conversation?.parent?.runId).toBe(thanks);
  });

  it('--force still resumes the reply run (the escape hatch)', async () => {
    const h = await build({ ...AGENT, script: agentScript });
    void h.controller.run();
    await h.ready();
    await h.submit('thanks');
    const id = h.factory.engines[0]!.runId;
    await h.command(`/resume ${id} --force`);
    expect(h.factory.calls.at(-1)?.resume).toEqual({ runId: id, force: true });
  });
});

describe('§A5: a tool-less turn that failed or was stopped is a reply too', () => {
  it('hi → 503 → the retry answers: the session is untitled and the picker stop is `answered`', async () => {
    const h = await build({ ...AGENT, script: (_o, n) => (n === 1 ? { stop: 'error', error: PROVIDER_503, steps: 0 } : { stop: 'answered', steps: 1 }) });
    void h.controller.run();
    await h.ready();
    await h.host.submit('hi', submitOpts(h));
    await waitFor(() => h.factory.calls.length === 2 && h.host.phase() === 'none', 4000, 'the retry');
    await tick(0);
    expect(h.controller.view.runs.map((r) => [r.stopReason, r.reply])).toEqual([['error', true], ['answered', true]]);
    const s = (await readIndex(h.indexPath)).sessions[0]!;
    expect(s.title).toBe('');
    expect(newestWorkRun(s)?.stopReason).toBe('answered');
  });

  it('hi → Esc: the session is untitled', async () => {
    // an aborted reply commits no step
    const h = await build({ ...AGENT, script: () => ({ hold: true, stop: 'answered', steps: 0 }) });
    void h.controller.run();
    await h.ready();
    const live = h.factory.nextLive();
    await h.host.submit('hi', submitOpts(h));
    await live;
    h.host.pause();
    await h.host.awaitRunEnd();
    await tick(0);
    expect(h.controller.view.runs[0]).toMatchObject({ stopReason: 'human_abort', reply: true });
    expect((await readIndex(h.indexPath)).sessions[0]?.title).toBe('');
  });

  it('fix → thanks (503 → the retry answers): /undo and the step context still target the fix run', async () => {
    const outcome: EngineEvent = { type: 'outcome', step: 2, outcome: { status: 'executed', summary: 'ok', changedFiles: ['a.py'] } };
    let thanks = 0;
    const h = await build({ ...AGENT, script: (o) => (o.task === 'thanks' ? (++thanks === 1 ? { stop: 'error', error: PROVIDER_503, steps: 0 } : { stop: 'answered', steps: 1 }) : { events: [toolCall('c1'), outcome], stop: 'complete', steps: 4 }) });
    void h.controller.run();
    await h.ready();
    await h.submit('fix the failing test');
    await h.host.submit('thanks', submitOpts(h));
    await waitFor(() => h.factory.calls.length === 3 && h.host.phase() === 'none', 4000, 'the retry');
    await tick(0);
    expect(h.controller.view.runs.map((r) => r.stopReason)).toEqual(['complete', 'error', 'answered']);
    const ctx = h.controller.host.dispatchContext();
    expect(ctx.step).toBe(4);
    expect(ctx.changedSteps).toEqual([2]);
    await h.command('/undo');
    expect(h.renderer.notes.map((n) => n.text)).not.toContain('nothing to undo — the last run changed no files');
  });
});

describe('§A5: /new and /status count replies as replies', () => {
  it('hi, fix, thanks → `1 run, 2 replies`', async () => {
    const h = await build({ ...AGENT, script: agentScript });
    void h.controller.run();
    await h.ready();
    await h.submit('hi');
    await h.submit('fix the failing test');
    await h.submit('thanks');
    const sid = h.factory.engines[0]!.runId;
    await h.command('/status');
    expect(h.renderer.notes.at(-1)?.detail).toContain(`session    ${sid} · 1 run · 2 replies · $0.022`);
    await h.command('/new');
    expect(h.renderer.notes.at(-1)?.text).toBe(sessionEndedText(sid, 1, 0.022, 2));
    expect(sessionEndedText(sid, 1, 0.022, 2)).toBe(`session ${sid} ended: 1 run, 2 replies, $0.02 total`);
    expect(sessionEndedText(sid, 2, 1.5)).toBe(`session ${sid} ended: 2 runs, $1.50 total`);
  });
});

describe('isTransientProviderError: one automatic retry for a rate limit, a timeout, a 5xx or a broken stream', () => {
  const e = (message: string, extra: Partial<SerializedError> = {}): SerializedError => ({ name: 'ProviderHttpError', code: 'provider_http', message, exitCode: 5, ...extra });
  it('reads the error\'s own retryable / status first, then the transport wording', () => {
    expect(isTransientProviderError(e('openrouter HTTP 503: upstream overloaded'))).toBe(true);
    expect(isTransientProviderError(e('openrouter HTTP 401: invalid key'))).toBe(false);
    expect(isTransientProviderError(e('openrouter stream error 502'))).toBe(true);
    // Anthropic's mid-stream wording: `anthropic stream error <type> (<status>)`
    expect(isTransientProviderError(e('anthropic stream error overloaded_error (529): Overloaded'))).toBe(true);
    expect(isTransientProviderError(e('anthropic stream error invalid_request_error (400): bad'))).toBe(false);
    // the structured fields win over the text
    expect(isTransientProviderError(e('something odd', { retryable: true }))).toBe(true);
    expect(isTransientProviderError(e('openrouter HTTP 503', { retryable: false }))).toBe(false);
    expect(isTransientProviderError(e('something odd', { status: 429 }))).toBe(true);
    expect(isTransientProviderError(e('something odd', { status: 404 }))).toBe(false);
    expect(isTransientProviderError(e('network error: ECONNRESET'))).toBe(true);
    // never a key, credit or request problem, and never a non-provider error
    expect(isTransientProviderError(e('openrouter HTTP 402: insufficient credit', { retryable: true }))).toBe(false);
    expect(isTransientProviderError({ code: 'config', message: 'HTTP 503' })).toBe(false);
    expect(isTransientProviderError(null)).toBe(false);
  });
});
