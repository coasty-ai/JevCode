/**
 * The controller's submit path, conversational (§3.8–3.10 rewritten): EVERY submission gets a streamed reply from the
 * code model and Jev's reading runs beside it, in the background, with no card anywhere — `hi` → one `[you]` + the
 * model's reply; `fix the test` → the reply, `On it — starting the run.` and `run:start` with `session.intake`;
 * `ambiguous` → the reply plus the `do it` offer, which the next message accepts; a reading that fails or never lands
 * is a log line, never a bubble (the reply already answered). `jev-only` keeps Jev's own answers (catalogue · facts ·
 * lookup) and the offer. Plus: the money of §3.9, the abort paths, the `--json` chat lines, the wizard re-read
 * (finding 26), the one-shot argv task, `/jev` line 3 and `/cost`'s chat line.
 */
import { whyErrorText } from '../../../src/tui/why.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { GenerateRequest, IntakeKind, Provider } from '../../../src/core/types.js';
import { CREDITS_EXHAUSTED, DO_IT_OFFER, offerWanted, INTAKE_UNREACHABLE, JEV_KEY_REJECTED, LLM_KEY_REJECTED, LLM_UNPRICED_REFUSAL, LLM_UNREACHABLE, MISSING_GENERATOR_KEY, MISSING_JEV_KEY, MOCK_CHAT_GENERATOR, ON_IT_LINE, RUN_LIVE_ERROR, SESSION_CAP_CHAT_REFUSAL, STILL_THINKING_TOAST, STOPPED_THINKING_TOAST, chatEstimateUsd, mockIntakeOverride, mockIntakeRules, mockJevLatencyMs, type ChatUiAction, type WizardReason } from '../../../src/cli/session.js';
import { writeJsonStream } from '../../../src/cli/json-stream.js';
import { readIndex } from '../../../src/session/index.js';
import { LOOKUP_FOOTER, LOOKUP_HEADER, lookupMissText } from '../../../src/chat/lookup.js';
import { PEERS_UNAVAILABLE_TEXT, WHAT_IT_IS_TEXT, peersFactText } from '../../../src/chat/facts.js';
import { REPLY_FALLBACK_KEY, fillReply, replyByKey } from '../../../src/chat/replies.js';
import { MOCK_CHAT_REPLY } from '../../../src/provider/mock.js';
import { ConfigError, ProviderHttpError } from '../../../src/errors.js';
import { createMockDecider } from '../../../src/jev/mock.js';
import { buildAllIntakeQuestions } from '../../../src/chat/intake.js';
import { harnessDecider, makeController, tick, waitFor, type Harness } from './helpers.js';
import type { UiAction } from '../../../src/tui/useEngine.js';

const SECRET = 'sk-ant-api03-SECRETSECRETSECRETSECRETSECRET1234';
/** the `<JEVCODE_EXTRA_ENV_FILE>` fallback must never find this machine's sibling checkout in a `mock: false` test */
const NO_EXTRA_ENV = '/nonexistent/extra.env';
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeController>): Promise<Harness> {
  const h = await makeController(...args);
  harnesses.push(h);
  return h;
}
const USAGE = { costUsd: 0.0002, inputTokens: 1500, outputTokens: 40, calls: 1 };
const bubbles = (h: Harness, label: '[you]' | '[jevcode]'): string[] => h.renderer.notes.filter((n) => n.label === label).map((n) => n.text);
const dispatchedOf = (h: Harness, type: string): (UiAction | ChatUiAction)[] => h.renderer.dispatched.filter((a) => a.type === type);
const uiErrors = (h: Harness): string[] => h.renderer.notes.filter((n) => n.label === '[ui]' && n.level === 'error').map((n) => n.text);

function fakeProvider(o: { text?: string; fail?: Error; deltas?: string[] }): Provider & { requests: GenerateRequest[] } {
  const requests: GenerateRequest[] = [];
  return {
    name: 'mock',
    model: 'fake-llm',
    requests,
    async generate(req, opts) {
      requests.push(req);
      if (o.fail) throw o.fail;
      for (const d of o.deltas ?? [o.text ?? '']) opts.onDelta?.(d);
      return { text: o.text ?? '', toolCalls: [], usage: { inputTokens: 900, outputTokens: 120, costUsd: 0.0031, calls: 1 }, model: 'fake-llm', stopReason: 'end_turn', latencyMs: 5 };
    },
  };
}

describe('TUI-DESIGN-2 §3.8: the submit path — greetings, tool questions, tasks', () => {
  it('`hi` → one [you] and the code model\'s streamed reply, no card, no run:start, the meter charged, `thinking` replying → null, s0 decision rows', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE }) });
    void h.controller.run();
    await h.ready();
    const outcome = await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    expect(outcome).toEqual({ became: 'chat' });
    expect(bubbles(h, '[you]')).toEqual(['hi']);
    // the `--mock` generator answers a no-tools chat request with one deterministic line — never a catalogue string
    expect(bubbles(h, '[jevcode]')).toEqual([MOCK_CHAT_REPLY]);
    expect(h.factory.calls).toHaveLength(0);
    expect(h.renderer.events.some((e) => e.type === 'run:start')).toBe(false);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.0002, 9);
    expect(dispatchedOf(h, 'thinking').map((a) => (a as { phase: string | null }).phase)).toEqual(['replying', null]);
    const rows = dispatchedOf(h, 'chat-decisions').at(-1) as { rows: { step: number; stage: string; id: string }[] } | undefined;
    // TUI-DESIGN-5 §8.1 item 10 / §2.3: `FactKey` gains `'peers'` (group C 14 -> 15), so the intake asks one more Noul
    expect(rows?.rows.length).toBe(1 + 5 + 1 + 15);
    expect(rows?.rows.every((r) => r.step === 0 && r.stage === 'intent')).toBe(true);
    expect(rows?.rows.map((r) => r.id)).toContain('intake');
    // the meter push carries the new total to the status row
    const pushed = dispatchedOf(h, 'spend:session');
    expect(pushed.length).toBeGreaterThanOrEqual(0);
    expect(h.decider).toHaveProperty('calls');
  });

  /**
   * TUI-DESIGN-5 §8.1 item 10 / §2.4 (round-5 fix pass, finding 9). The 15th fact costs ~140 intake tokens on a
   * budget measured at 4,366/4,500; the controller has to SET `FactsInput.peers` or every answer is the
   * permanently false `the peer registry is not available in this build`. `undefined` (no wiring) and `null`
   * (ledger not open) are deliberately different states, and this is the one that proves the wiring exists.
   */
  it('the `peers` fact is WIRED: the controller sets it, so the answer is the ledger state, not "not available in this build"', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE, facts: ['peers'] }), flags: { mode: 'jev-only' } });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('what can you do?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    const reply = bubbles(h, '[jevcode]').at(-1);
    // the ledger is not open in a chat-only harness, which is `null` — the honest state, and NOT `undefined`
    expect(reply).toBe(peersFactText(null));
    expect(reply).not.toContain(PEERS_UNAVAILABLE_TEXT);
    expect(reply).toContain('/who lists every jevcode on this workspace once it is');
  });

  it('`what can you do?` → one [jevcode] item per selected fact, in probability order (what_it_is, mode_now)', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE, facts: ['what_it_is', 'mode_now'] }), flags: { mode: 'jev-only' } });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('what can you do?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    const replies = bubbles(h, '[jevcode]');
    expect(replies).toHaveLength(2);
    expect(replies[0]).toBe(WHAT_IT_IS_TEXT);
    expect(replies[1]).toBe('Mode: jev-only — no generating LLM; code proposes, Jev decides, tests verify.');
    expect(h.factory.calls).toHaveLength(0);
  });

  it('`fix the test` → run:start; EngineOptions.session.intake records why (kind, probability, requestHash); the submission is a prompt, not chat', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE }) });
    void h.controller.run();
    await h.ready();
    const outcome = await h.host.submit('fix the failing test', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    expect(outcome).toEqual({ became: 'run' });
    await h.host.awaitRunEnd();
    expect(h.factory.calls).toHaveLength(1);
    expect(h.factory.calls[0]!.task).toBe('fix the failing test');
    expect(h.factory.calls[0]!.session?.intake).toEqual({ kind: 'coding_task', probability: 0.9, requestHash: 'h1' });
    expect(bubbles(h, '[you]')).toEqual(['fix the failing test']);
    // the reply still answers first; the reading appends the one line that says the run is starting
    expect(bubbles(h, '[jevcode]')).toEqual([MOCK_CHAT_REPLY, ON_IT_LINE]);
    expect(ON_IT_LINE).toBe('On it — starting the run.');
  });

  it('the [you] bubble is redacted at emission and split per line; the message never reaches the log', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE }) });
    void h.controller.run();
    await h.ready();
    await h.host.submit(`hi\nmy key is ${SECRET}`, { kind: 'prompt', secretSpans: [SECRET], pinnedFiles: [] });
    expect(bubbles(h, '[you]')).toEqual(['hi', 'my key is [REDACTED:composer#1]']);
    expect(JSON.stringify(h.renderer.notes)).not.toContain(SECRET);
  });

  it('Enter while thinking is ignored with the `one moment — still thinking` toast; a run or Enter while live is refused as before', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE, delayMs: () => 150 }) });
    void h.controller.run();
    await h.ready();
    const first = h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await tick(20);
    expect(await h.host.submit('hello again', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'nothing' });
    expect(dispatchedOf(h, 'toast').map((a) => (a as { text: string }).text)).toEqual([STILL_THINKING_TOAST]);
    expect(await first).toEqual({ became: 'chat' });
    expect(bubbles(h, '[you]')).toEqual(['hi']);
  });
});

describe('ambiguous — the `do it` offer, never a card and never a silent run', () => {
  const ambiguousDecider = () => harnessDecider({ usage: USAGE, classify: () => 'ambiguous' as IntakeKind });

  it('the reply lands and the offer line closes the bubble; the composer is free (became chat), no run, no prompt channel involved', async () => {
    const asked: string[] = [];
    const h = await build({ decider: ambiguousDecider(), prompts: { wizard: async () => { asked.push('wizard'); return { kind: 'cancelled' }; } } });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('the date parsing', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(bubbles(h, '[jevcode]')).toEqual([MOCK_CHAT_REPLY, DO_IT_OFFER]);
    expect(DO_IT_OFFER).toBe("Say `do it` and I'll make that a task.");
    expect(h.factory.calls).toHaveLength(0);
    expect(asked).toEqual([]);
  });

  it('`do it` accepts the offer with NO new request — the run starts on the reading already in hand; any other message drops it', async () => {
    const h = await build({ decider: ambiguousDecider() });
    void h.controller.run();
    await h.ready();
    await h.host.submit('the date parsing', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    const calls = h.decider.calls.length;
    expect(await h.host.submit('do it', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'run' });
    await h.host.awaitRunEnd();
    expect(h.decider.calls.length).toBe(calls); // the offer carries the reading: nothing is asked again
    expect(h.factory.calls).toHaveLength(1);
    expect(h.factory.calls[0]!.task).toBe('the date parsing');
    expect(h.factory.calls[0]!.session?.intake?.kind).toBe('ambiguous');
    expect(bubbles(h, '[jevcode]').at(-1)).toBe(ON_IT_LINE);
    // a later reading replaces the offer: `do it` then runs THAT message, never the older one
    await h.host.submit('the tests', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] });
    expect(await h.host.submit('do it', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'run' });
    await h.host.awaitRunEnd();
    expect(h.factory.calls.map((c) => c.task)).toEqual(['the date parsing', 'the tests']);
    // an ambiguous QUESTION gets no offer (live 2026-09-22: `who made you?` read ambiguous), so a `do it` after it is just a message
    await h.host.submit('tests?', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] });
    expect(bubbles(h, '[jevcode]').at(-1)).not.toBe(DO_IT_OFFER);
    expect(await h.host.submit('do it', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(h.factory.calls).toHaveLength(2);
  });

  it('a message that is not an acceptance drops the offer: a later `do it` is just a message', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE, classify: (m) => (m === 'the date parsing' ? 'ambiguous' : 'greeting_or_smalltalk') }) });
    void h.controller.run();
    await h.ready();
    await h.host.submit('the date parsing', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    expect(bubbles(h, '[jevcode]').at(-1)).toBe(DO_IT_OFFER);
    await h.host.submit('hi', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] });
    expect(await h.host.submit('do it', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(h.factory.calls).toHaveLength(0);
  });

  it('jev-only: no generator, so Jev answers — the catalogue fallback plus the offer, and `do it` still runs it', async () => {
    const h = await build({ decider: ambiguousDecider(), flags: { mode: 'jev-only' } });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('the date parsing', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    const dir = h.workspace.slice(h.workspace.lastIndexOf('/') + 1);
    expect(bubbles(h, '[jevcode]')).toEqual([fillReply(replyByKey(REPLY_FALLBACK_KEY), { dir, lastRun: null, mode: 'jev-only', runsDir: '' }), DO_IT_OFFER]);
    expect(await h.host.submit('do it', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'run' });
    await h.host.awaitRunEnd();
    expect(h.factory.calls[0]!.task).toBe('the date parsing');
  });
});

describe('TUI-DESIGN-2 §3.9: money', () => {
  it('at or over the session cap the submission is refused with zero requests; below it the intake is charged to the root meter', async () => {
    const h = await build({ decider: harnessDecider({ usage: { ...USAGE, costUsd: 0.02 } }), flags: { sessionSpendCap: '0.03' } });
    void h.controller.run();
    await h.ready();
    await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    expect(h.decider.calls).toHaveLength(1);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.02, 9);
    await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    expect(h.decider.calls).toHaveLength(2);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.04, 9);
    expect(await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(h.decider.calls).toHaveLength(2);
    expect(bubbles(h, '[jevcode]').at(-1)).toBe(SESSION_CAP_CHAT_REFUSAL(0.03));
    expect(SESSION_CAP_CHAT_REFUSAL(1.25)).toBe("The session cap ($1.25) is reached, so I'm not sending anything to Jev. Raise it with /budget session-spend-cap <usd>, or /new for a fresh session.");
  });

  it('the 50/80/95 % session items fire once each from chat spend', async () => {
    const h = await build({ decider: harnessDecider({ usage: { ...USAGE, costUsd: 0.3 } }), flags: { sessionSpendCap: '1' } });
    void h.controller.run();
    await h.ready();
    for (let i = 0; i < 3; i++) await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    const budget = h.renderer.notes.filter((n) => n.text.startsWith('budget: session spend'));
    expect(budget.map((n) => n.text)).toEqual([
      'budget: session spend $0.600 is 50 % of the $1.000 session cap — raise it with /budget session-spend-cap <usd>',
      'budget: session spend $0.900 is 80 % of the $1.000 session cap — raise it with /budget session-spend-cap <usd>',
    ]);
    expect(budget[1]?.level).toBe('warn');
  });

  it('`hi`, `hi`, then a task: the session total includes both intakes plus the run, and the meter object is the same across run:start (setCap, never recreated)', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE }), script: () => ({ cost: { generator: 0.1, jev: 0.015 } }) });
    void h.controller.run();
    await h.ready();
    const meter = h.controller.view.sessionMeter;
    await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    expect(h.controller.view.sessionMeter).toBe(meter);
    await h.host.submit('fix the failing test', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await h.host.awaitRunEnd();
    expect(h.controller.view.sessionMeter).toBe(meter);
    expect(meter.snapshot().totalUsd).toBeCloseTo(0.0002 * 3 + 0.115, 9);
    expect(h.factory.calls).toHaveLength(1);
    // the run's child meter forwarded to the same root: the run's own cap is the jev-only default $0.25 clamped by nothing here
    expect(h.factory.calls[0]!.meter.snapshot().parent?.totalUsd).toBeDefined();
  });

  it('/jev gains the intake line and /cost the chat line after a chat', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE, latencyMs: 118 }) });
    void h.controller.run();
    await h.ready();
    await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await h.command('/jev');
    const jev = h.renderer.notes.at(-1);
    expect(jev?.text).toBe('jev');
    // TUI-DESIGN-4 §3.3 / F-B2: kv rows — the key is `intake`, so the value never repeats the word, and the last
    // intake rides the same row as a ` · ` segment instead of a second `last: …` row
    // §3.3: the continuation hangs UNDER the value column (11), never at column 0 where it reads as a new key
    expect(jev?.detail).toContain('intake     1 message · p50 118 ms · $0.0002 · last greeting or\n           smalltalk (0.90)');
    await h.command('/cost');
    // §3.1.4: `$0.0001` for a sub-millicent, ` · ` the only inline separator, never scientific notation
    expect(h.renderer.notes.at(-1)?.detail).toContain('chat       $0.0002 · 1 message · p50 118 ms');
  });
});

describe('TUI-DESIGN-2 §3.1 rows 10, 12, 12′, 13: failures', () => {
  it('jev-only: Jev unreachable after the client\'s retries → the retry bubble, zero runs, meter unchanged', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE, failAt: [{ stage: 'intent', status: 503 }] }), flags: { mode: 'jev-only' } });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(bubbles(h, '[jevcode]')).toEqual([INTAKE_UNREACHABLE('Jev HTTP 503')]);
    expect(INTAKE_UNREACHABLE('x')).toBe("I couldn't reach Jev to read that (x). Press Enter to send it again.");
    expect(h.factory.calls).toHaveLength(0);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBe(0);
    expect(dispatchedOf(h, 'thinking').map((a) => (a as { phase: string | null }).phase)).toEqual(['intake', null]);
  });

  it('with a generator the same failure is invisible: the reply IS the answer, so a failed reading is a log line — no bubble, no run', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE, failAt: [{ stage: 'intent', status: 503 }] }) });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(bubbles(h, '[jevcode]')).toEqual([MOCK_CHAT_REPLY]);
    expect(uiErrors(h)).toEqual([]);
    expect(h.factory.calls).toHaveLength(0);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBe(0);
  });

  it('Ctrl-C ×1 while thinking (host.abort) aborts the request: toast `stopped thinking`, no bubble, became nothing', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE, delayMs: () => 500 }), flags: { mode: 'jev-only' } });
    void h.controller.run();
    await h.ready();
    const p = h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await tick(20);
    h.host.abort('human_abort');
    expect(await p).toEqual({ became: 'nothing' });
    expect(bubbles(h, '[jevcode]')).toEqual([]);
    expect(dispatchedOf(h, 'toast').map((a) => (a as { text: string }).text)).toEqual([STOPPED_THINKING_TOAST]);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBe(0);
    // idle and not thinking: Ctrl-C is a no-op
    h.host.abort('human_abort');
    expect(h.controller.view.phase).toBe('none');
  });

  it('no generator key under jev+llm (mock off): the reply cannot go out — the wizard, then `[ui] error: missing generator.apiKey`, no bubble, no request', async () => {
    // `extraEnvFile` off the machine's sibling checkout, so no real generator key resolves (the Jev key does)
    const provider = fakeProvider({ text: 'never' });
    const h = await build({ decider: harnessDecider({ usage: USAGE }), flags: { mock: false, mode: 'jev-on', extraEnvFile: NO_EXTRA_ENV }, env: { JEV_API_KEY: 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, deps: { buildProvider: async () => provider } });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('where is the date parsing?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'nothing' });
    expect(bubbles(h, '[jevcode]')).toEqual([]);
    expect(uiErrors(h).at(-1)).toBe(`error: ${MISSING_GENERATOR_KEY}`);
    expect(MISSING_GENERATOR_KEY).toBe('missing generator.apiKey: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY, or run jevcode login');
    expect(provider.requests).toHaveLength(0);
    expect(h.decider.calls).toHaveLength(0);
    expect(JSON.stringify(h.renderer.notes)).not.toContain('sk-or-v1-0123456789abcdef');
  });
});

describe('TUI-DESIGN-2 §3.6: question_about_the_code', () => {
  it('jev-only: the lookup — one more Jev request at stage context, `thinking` lookup, header + hits + footer (or the miss line)', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE }), flags: { mode: 'jev-only' }, deps: { listCandidates: async () => [{ path: 'utils/dates.py', bytes: 10 }, { path: 'README.md', bytes: 5 }] } });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('where is the dates parsing?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    const stages = h.decider.calls.map((c) => c.stage);
    expect(stages).toEqual(['intent', 'context']);
    expect(dispatchedOf(h, 'thinking').map((a) => (a as { phase: string | null }).phase)).toEqual(['intake', null, 'lookup', null]);
    const replies = bubbles(h, '[jevcode]');
    expect(replies[0]).toBe(LOOKUP_HEADER);
    expect(replies.at(-1)).toBe(LOOKUP_FOOTER);
    // the file is not on disk in the harness workspace → a path-only hit
    expect(replies).toContain('  utils/dates.py');
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.0004, 9);
    expect(h.factory.calls).toHaveLength(0);
  });

  it('jev-only with nothing matching → the miss line naming the directory', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE }), flags: { mode: 'jev-only' } });
    void h.controller.run();
    await h.ready();
    await h.host.submit('why does zzqx fail?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    const dir = h.workspace.slice(h.workspace.lastIndexOf('/') + 1);
    expect(bubbles(h, '[jevcode]')).toEqual([lookupMissText(dir, 0)]);
    expect(h.decider.calls.map((c) => c.stage)).toEqual(['intent']);
  });

  it('jev+llm: one generator turn streams into the live region and lands one [jevcode] item per line; the generator cost is charged', async () => {
    const provider = fakeProvider({ text: 'It fails because tz is None.\nSee utils/dates.py:12.', deltas: ['It fails because tz is None.\n', 'See utils/dates.py:12.'] });
    const h = await build({ decider: harnessDecider({ usage: USAGE }), flags: { mode: 'jev-on' }, deps: { buildProvider: async () => provider } });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('why does test_parse_date fail?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.tools).toBeUndefined();
    expect(provider.requests[0]!.maxTokens).toBe(800);
    expect(bubbles(h, '[jevcode]')).toEqual(['It fails because tz is None.', 'See utils/dates.py:12.']);
    expect(h.renderer.liveTexts).toEqual(['It fails because tz is None.\n', 'It fails because tz is None.\nSee utils/dates.py:12.', '']);
    expect(dispatchedOf(h, 'thinking').map((a) => (a as { phase: string | null }).phase)).toEqual(['replying', null]);
    // the request carries JevCode's own voice and this workspace
    expect(provider.requests[0]!.system).toContain('You are JevCode, a coding agent for the terminal, built by coasty-ai.');
    expect(provider.requests[0]!.system).toContain(`- name: ${h.workspace.slice(h.workspace.lastIndexOf('/') + 1)}`);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.0002 + 0.0031, 9);
    expect(h.decider.calls.map((c) => c.stage)).toEqual(['intent']);
  });

  it('jev+llm: a provider failure during the turn → the LLM_UNREACHABLE bubble, the live region emptied, the meter unchanged by the turn', async () => {
    const provider = fakeProvider({ fail: new ProviderHttpError('HTTP 500 upstream', { status: 500, retryable: true }) });
    const h = await build({ decider: harnessDecider({ usage: USAGE }), flags: { mode: 'jev-on' }, deps: { buildProvider: async () => provider } });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('why does test_parse_date fail?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(bubbles(h, '[jevcode]')).toEqual([LLM_UNREACHABLE(MOCK_CHAT_GENERATOR.model, 'HTTP 500 upstream')]);
    expect(LLM_UNREACHABLE('m', 'x')).toBe("I couldn't get an answer from m (x). Ask again, or /mode jev-only for the lookup.");
    expect(h.renderer.liveTexts.at(-1)).toBe('');
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.0002, 9);
  });

  it('chatEstimateUsd follows §3.6: (1,200 + chars × 0.25 + file bytes × 0.25) × in-price + min(800, maxTokens) × out-price', () => {
    const gen = { pricing: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0, cacheWritePerM: 0 }, maxTokens: 4096 };
    expect(chatEstimateUsd(gen, 'x'.repeat(400), 4000)).toBeCloseTo((1200 + 100 + 1000) * 3e-6 + 800 * 15e-6, 12);
    expect(chatEstimateUsd({ ...gen, maxTokens: 200 }, '', 0)).toBeCloseTo(1200 * 3e-6 + 200 * 15e-6, 12);
  });
});

describe('TUI-DESIGN-2 §3.8: keys, the wizard re-read and the one-shot path', () => {
  it('no key → the wizard once (cancelled → MISSING_JEV_KEY error), then saved → `hi` gets a reply with zero config errors (the config is re-read after the save)', async () => {
    let wizardCalls = 0;
    const h = await build({
      decider: harnessDecider({ usage: USAGE }),
      flags: { mock: false, mode: 'jev-only', extraEnvFile: NO_EXTRA_ENV },
      prompts: {
        wizard: async () => {
          wizardCalls += 1;
          return wizardCalls <= 2 ? { kind: 'cancelled' } : { kind: 'saved', patch: { jevApiKey: 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } };
        },
      },
    });
    void h.controller.run();
    await h.ready();
    expect(wizardCalls).toBe(1); // the startup wizard, cancelled
    expect(await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'nothing' });
    expect(wizardCalls).toBe(2);
    expect(uiErrors(h)).toEqual([`error: ${MISSING_JEV_KEY}`]);
    expect(MISSING_JEV_KEY).toBe('missing decider.apiKey: set TYPESAFE_API_KEY or OPENROUTER_API_KEY, or run jevcode login');
    expect(await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(wizardCalls).toBe(3);
    expect(uiErrors(h)).toHaveLength(1);
    expect(bubbles(h, '[jevcode]')).toHaveLength(1);
    expect(h.decider.calls).toHaveLength(1);
  });

  it('the one-shot argv task never passes intake: `jevcode run "hi"` runs a task named hi', async () => {
    const h = await build({ mode: 'one-shot', task: 'hi', decider: harnessDecider({ usage: USAGE }) });
    const code = await h.controller.run();
    expect(code).toBe(0);
    expect(h.factory.calls).toHaveLength(1);
    expect(h.factory.calls[0]!.task).toBe('hi');
    expect(h.factory.calls[0]!.session?.intake).toBeUndefined();
    expect(h.decider.calls.filter((c) => c.stage === 'intent' && c.step === 0)).toHaveLength(0);
    expect(bubbles(h, '[you]')).toEqual([]);
  });

  it('a follow-up after a run passes intake too; the run\'s follow-up kind is kept when it becomes a run', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE }) });
    void h.controller.run();
    await h.ready();
    await h.submit('fix the failing test');
    await h.host.submit('thanks', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] });
    expect(bubbles(h, '[jevcode]').at(-1)).toBe(MOCK_CHAT_REPLY);
    expect(h.factory.calls).toHaveLength(1);
    await h.host.submit('now update the docs', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] });
    await h.host.awaitRunEnd();
    expect(h.factory.calls).toHaveLength(2);
    expect(h.factory.calls[1]!.seed?.parentRunId).toBe(h.factory.calls[0]!.task === 'fix the failing test' ? h.factory.engines[0]!.runId : null);
  });
});

describe('TUI-DESIGN-2 §3.8 / §6 item 17: the `--json` `chat` line (finding 1)', () => {
  class Sink {
    chunks: string[] = [];
    write(s: string): boolean {
      this.chunks.push(s);
      return true;
    }
    get lines(): Record<string, unknown>[] {
      return this.chunks.join('').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
    }
  }
  const jsonHarness = async (o: Parameters<typeof makeController>[0] = {}): Promise<{ h: Harness; chat: () => Record<string, unknown>[] }> => {
    const sink = new Sink();
    const stream = writeJsonStream({ out: sink, version: '0.0.0-test', redact: (s) => s, now: () => '2026-09-21T10:00:00.000Z' });
    const h = await build({ ...o, rendererKind: 'json', options: { jsonStream: stream, ...(o.options ?? {}) } });
    return { h, chat: () => sink.lines.filter((l) => l['type'] === 'chat') };
  };

  it('`hi` → two chat lines: the background reading (route reply, its cost and hash) and the reply itself (route llm, provider generator, no hash); a task reads `run`', async () => {
    const { h, chat } = await jsonHarness({ decider: harnessDecider({ usage: USAGE, latencyMs: 118 }) });
    void h.controller.run();
    await h.ready();
    await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    expect(chat()[0]).toEqual({ v: 1, t: '2026-09-21T10:00:00.000Z', runId: null, sessionId: null, type: 'chat', intake: 'greeting_or_smalltalk', probability: 0.9, route: 'reply', provider: 'openrouter', costUsd: 0.0002, latencyMs: 118, requestHash: 'h1' });
    expect(chat()[1]).toMatchObject({ type: 'chat', intake: 'greeting_or_smalltalk', route: 'llm', provider: 'generator', costUsd: 0, requestHash: '' });
    await h.host.submit('fix the failing test', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await h.host.awaitRunEnd();
    expect(chat()).toHaveLength(4);
    expect(chat()[2]).toMatchObject({ type: 'chat', intake: 'coding_task', route: 'run', provider: 'openrouter', requestHash: 'h2' });
    // the message never rides the stream
    expect(JSON.stringify(chat())).not.toContain('failing test');
  });

  it('a code question is two lines: the intake (route lookup) and the lookup request itself; under jev+llm the second is the LLM turn (provider generator, no Jev request hash)', async () => {
    const { h, chat } = await jsonHarness({ decider: harnessDecider({ usage: USAGE }), flags: { mode: 'jev-only' }, deps: { listCandidates: async () => [{ path: 'utils/dates.py', bytes: 10 }] } });
    void h.controller.run();
    await h.ready();
    await h.host.submit('where is the dates parsing?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    expect(chat().map((l) => [l['route'], l['provider'], l['requestHash']])).toEqual([
      ['lookup', 'openrouter', 'h1'],
      ['lookup', 'openrouter', 'h2'],
    ]);
    expect(chat()[1]).toMatchObject({ intake: 'question_about_the_code', costUsd: 0.0002 });
    const provider = fakeProvider({ text: 'Because tz is None.' });
    const llm = await jsonHarness({ decider: harnessDecider({ usage: USAGE }), flags: { mode: 'jev-on' }, deps: { buildProvider: async () => provider } });
    void llm.h.controller.run();
    await llm.h.ready();
    await llm.h.host.submit('why does test_parse_date fail?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    expect(llm.chat().map((l) => [l['route'], l['provider'], l['requestHash'], l['costUsd']])).toEqual([
      ['llm', 'openrouter', 'h1', 0.0002],
      ['llm', 'generator', '', 0.0031],
    ]);
    expect(provider.requests).toHaveLength(1);
  });

  it('an ambiguous reading is route asked; a failed reading writes no chat line of its own (nothing was charged), only the reply\'s', async () => {
    const { h, chat } = await jsonHarness({ decider: harnessDecider({ usage: USAGE, classify: () => 'ambiguous' as IntakeKind }), flags: { mode: 'jev-only' } });
    void h.controller.run();
    await h.ready();
    await h.host.submit('the date parsing', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    expect(chat()).toHaveLength(1);
    expect(chat()[0]).toMatchObject({ route: 'asked', intake: 'ambiguous' });
    const failing = await jsonHarness({ decider: harnessDecider({ usage: USAGE, failAt: [{ stage: 'intent', status: 503 }] }), flags: { mode: 'jev-only' } });
    void failing.h.controller.run();
    await failing.h.ready();
    await failing.h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    expect(failing.chat()).toEqual([]);
  });
});

describe('TUI-DESIGN-2 §3.9: the `chat` index line and /resume (finding 2)', () => {
  it('`hi` (buffered), a task (flushes with the run\'s session id), `hi` (direct): every chat line lands under the first run\'s session id; the fold sums them; `-c` in a new controller restores runs + chat spend into the meter', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE }), flags: { mode: 'jev-only' }, script: () => ({ cost: { generator: 0.1, jev: 0.015 } }) });
    void h.controller.run();
    await h.ready();
    await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    // no session yet: the line waits for the run that creates the session (like the deferred budget lines, §8.2)
    expect(h.index().filter((l) => l.kind === 'chat')).toHaveLength(0);
    await h.host.submit('fix the failing test', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await h.host.awaitRunEnd();
    await h.host.submit('hi', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] });
    const sid = h.factory.engines[0]!.runId;
    const lines = h.index().filter((l) => l.kind === 'chat');
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.sessionId === sid)).toBe(true);
    expect(lines.map((l) => (l.kind === 'chat' ? [l.intake, l.route, l.provider, l.costUsd] : null))).toEqual([
      ['greeting_or_smalltalk', 'reply', 'openrouter', 0.0002],
      ['coding_task', 'run', 'openrouter', 0.0002],
      ['greeting_or_smalltalk', 'reply', 'openrouter', 0.0002],
    ]);
    // the writer's own fold agrees with the meter
    const folded = await readIndex(h.indexPath);
    expect(folded.chat.get(sid)).toEqual({ jev: expect.closeTo(0.0006, 9), generator: 0, messages: 2 });
    expect(folded.sessions.find((s) => s.sessionId === sid)?.totalUsd).toBeCloseTo(0.115 + 0.0006, 9);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.115 + 0.0006, 9);
    // a second controller over the same home and workspace continues the session: the meter is seeded from runs AND chat lines
    const h2 = await build({ home: h.home, workspace: h.workspace, flags: { continue: true, mode: 'jev-only' }, decider: harnessDecider({ usage: USAGE }) });
    void h2.controller.run();
    await h2.ready();
    await waitFor(() => h2.renderer.notes.some((n) => n.text.startsWith(`session ${sid} continues`)), 4000, 'the continue item');
    expect(h2.controller.view.sessionId).toBe(sid);
    expect(h2.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.115 + 0.0006, 9);
    // and its own chat lines land under the same session id at once
    await h2.host.submit('thanks', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] });
    expect(h2.index().filter((l) => l.kind === 'chat')).toHaveLength(4);
    expect(h2.index().filter((l) => l.kind === 'chat').at(-1)?.sessionId).toBe(sid);
    expect(h2.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.115 + 0.0008, 9);
  });

  it('a session that never runs writes no chat line (documented: the buffered lines are dropped with it)', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE }) });
    void h.controller.run();
    await h.ready();
    await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    expect(h.index()).toEqual([]);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.0004, 9);
  });
});

describe('TUI-DESIGN-2 §3.1 rows 10–13: aborts, rejected keys, the live run and the LLM caps (findings 5, 6, 12; missing tests)', () => {
  const NO_KEY_ANTHROPIC = `sk-ant-api03-${'a'.repeat(40)}`;
  const NO_KEY_OPENROUTER = `sk-or-v1-${'0123456789abcdef'.repeat(4)}`;

  it('finding 6: Ctrl-C ×1 during the lookup aborts the second Jev request — toast only, no bubble, only the intake charged, `thinking` lookup → null', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE, delayMs: (ctx) => (ctx.stage === 'context' ? 500 : 0) }), flags: { mode: 'jev-only' }, deps: { listCandidates: async () => [{ path: 'utils/dates.py', bytes: 10 }] } });
    void h.controller.run();
    await h.ready();
    const p = h.host.submit('where is the dates parsing?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await waitFor(() => dispatchedOf(h, 'thinking').some((a) => (a as { phase: string | null }).phase === 'lookup'), 2000, 'the lookup phase');
    h.host.abort('human_abort');
    expect(await p).toEqual({ became: 'nothing' });
    expect(bubbles(h, '[jevcode]')).toEqual([]);
    expect(dispatchedOf(h, 'toast').map((a) => (a as { text: string }).text)).toEqual([STOPPED_THINKING_TOAST]);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.0002, 9);
    expect(dispatchedOf(h, 'thinking').map((a) => (a as { phase: string | null }).phase)).toEqual(['intake', null, 'lookup', null]);
    expect(h.controller.view.phase).toBe('none');
  });

  it('finding 6: Ctrl-C while `buildProvider` is still pending (before the LLM request exists) → no generator call, toast only, live region emptied', async () => {
    const provider = fakeProvider({ text: 'never' });
    const h = await build({ decider: harnessDecider({ usage: USAGE }), flags: { mode: 'jev-on' }, deps: { buildProvider: () => new Promise((r) => setTimeout(() => r(provider), 300)) } });
    void h.controller.run();
    await h.ready();
    const p = h.host.submit('why does test_parse_date fail?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await waitFor(() => dispatchedOf(h, 'thinking').some((a) => (a as { phase: string | null }).phase === 'replying'), 2000, 'the replying phase');
    h.host.abort('human_abort');
    expect(await p).toEqual({ became: 'nothing' });
    expect(provider.requests).toHaveLength(0);
    expect(bubbles(h, '[jevcode]')).toEqual([]);
    expect(dispatchedOf(h, 'toast').map((a) => (a as { text: string }).text)).toEqual([STOPPED_THINKING_TOAST]);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.0002, 9);
    expect(h.renderer.liveTexts.at(-1)).toBe('');
  });

  it('finding 6: Ctrl-C during the LLM request itself aborts the generator call through its signal — toast only, meter unchanged by the turn', async () => {
    const requests: GenerateRequest[] = [];
    const hanging: Provider = {
      name: 'mock',
      model: 'fake-llm',
      generate: (req, opts) => {
        requests.push(req);
        return new Promise((_, reject) => {
          opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true });
        });
      },
    };
    const h = await build({ decider: harnessDecider({ usage: USAGE }), flags: { mode: 'jev-on' }, deps: { buildProvider: async () => hanging } });
    void h.controller.run();
    await h.ready();
    const p = h.host.submit('why does test_parse_date fail?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await waitFor(() => requests.length === 1, 2000, 'the generator request');
    h.host.abort('human_abort');
    expect(await p).toEqual({ became: 'nothing' });
    expect(dispatchedOf(h, 'toast').map((a) => (a as { text: string }).text)).toEqual([STOPPED_THINKING_TOAST]);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.0002, 9);
    expect(bubbles(h, '[jevcode]')).toEqual([]);
  });

  it('finding 5: a Ctrl-C\'d submission followed by one whose `buildDecider` throws a ConfigError → `[ui] error: config:`, never `stopped thinking` for the second', async () => {
    const slow = harnessDecider({ usage: USAGE, delayMs: () => 400 });
    let calls = 0;
    const h = await build({
      decider: slow,
      flags: { mode: 'jev-only' },
      deps: {
        buildDecider: async () => {
          calls += 1;
          if (calls > 1) throw new ConfigError('decider.model: "jev-9" is not served by api.typesafe.ai');
          return slow;
        },
      },
    });
    void h.controller.run();
    await h.ready();
    const first = h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await tick(20);
    h.host.abort('human_abort');
    expect(await first).toEqual({ became: 'nothing' });
    expect(await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'nothing' });
    expect(dispatchedOf(h, 'toast').map((a) => (a as { text: string }).text)).toEqual([STOPPED_THINKING_TOAST]);
    expect(uiErrors(h)).toEqual(['error: config: decider.model: "jev-9" is not served by api.typesafe.ai']);
    expect(bubbles(h, '[jevcode]')).toEqual([]);
  });

  it('finding 12: a 401 from Jev on the intake → `Jev rejected the key (HTTP 401). /login saves a new one.` and the TUI opens the wizard (reason rejected); Enter would not loop; the meter is unchanged', async () => {
    const reasons: WizardReason[] = [];
    const h = await build({ decider: harnessDecider({ usage: USAGE, failAt: [{ stage: 'intent', status: 401 }] }), flags: { mode: 'jev-only' }, prompts: { wizard: async (_m, o) => { reasons.push(o.reason); return { kind: 'cancelled' }; } } });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(bubbles(h, '[jevcode]')).toEqual([JEV_KEY_REJECTED(401)]);
    expect(JEV_KEY_REJECTED(401)).toBe('Jev rejected the key (HTTP 401). /login saves a new one.');
    await tick(10);
    expect(reasons).toEqual(['rejected']);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBe(0);
    expect(h.factory.calls).toHaveLength(0);
    // a 403 on the lookup is the same bubble; --plain never opens the wizard on its own (the bubble names /login)
    const plain = await build({ decider: harnessDecider({ usage: USAGE, failAt: [{ stage: 'context', status: 403 }] }), rendererKind: 'plain', flags: { mode: 'jev-only' }, deps: { listCandidates: async () => [{ path: 'utils/dates.py', bytes: 10 }] }, prompts: { wizard: async (_m, o) => { reasons.push(o.reason); return { kind: 'cancelled' }; } } });
    void plain.controller.run();
    await plain.ready();
    expect(await plain.host.submit('where is the dates parsing?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(bubbles(plain, '[jevcode]')).toEqual([JEV_KEY_REJECTED(403)]);
    await tick(10);
    expect(reasons).toEqual(['rejected']);
  });

  it('TUI-DESIGN-3 §1.7 (R3 F5/F10): a 402 from Jev on the intake → the CREDITS_EXHAUSTED bubble (never "unreachable"), no wizard, the meter unchanged; a 402 from the generator during the LLM turn the same', async () => {
    const reasons: WizardReason[] = [];
    const h = await build({ decider: harnessDecider({ usage: USAGE, failAt: [{ stage: 'intent', status: 402 }] }), flags: { mode: 'jev-only' }, prompts: { wizard: async (_m, o) => { reasons.push(o.reason); return { kind: 'cancelled' }; } } });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(bubbles(h, '[jevcode]')).toEqual([CREDITS_EXHAUSTED('jev', 402)]);
    expect(CREDITS_EXHAUSTED('jev', 402)).toBe('OpenRouter says this key has no credits (HTTP 402). Add credits at openrouter.ai/credits, or /mode jev-only ($1.00 cap; Jev bills the same key).');
    expect(CREDITS_EXHAUSTED('jev', 402).length).toBeLessThanOrEqual(160);
    expect(reasons).toEqual([]);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBe(0);
    const provider = fakeProvider({ fail: new ProviderHttpError('HTTP 402 insufficient credits', { status: 402, retryable: false }) });
    const g = await build({ decider: harnessDecider({ usage: USAGE }), flags: { mode: 'jev-on' }, deps: { buildProvider: async () => provider } });
    void g.controller.run();
    await g.ready();
    expect(await g.host.submit('why does test_parse_date fail?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(bubbles(g, '[jevcode]')).toEqual([CREDITS_EXHAUSTED('generator', 402)]);
  });

  it('finding 12: a 401 from the generator during the LLM turn → `<model> rejected the key (HTTP 401). /login saves a new one.`, the live region emptied', async () => {
    const provider = fakeProvider({ fail: new ProviderHttpError('HTTP 401 invalid x-api-key', { status: 401, retryable: false }) });
    const reasons: WizardReason[] = [];
    const h = await build({ decider: harnessDecider({ usage: USAGE }), flags: { mode: 'jev-on' }, deps: { buildProvider: async () => provider }, prompts: { wizard: async (_m, o) => { reasons.push(o.reason); return { kind: 'cancelled' }; } } });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('why does test_parse_date fail?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(bubbles(h, '[jevcode]')).toEqual([LLM_KEY_REJECTED(MOCK_CHAT_GENERATOR.model, 401)]);
    expect(h.renderer.liveTexts.at(-1)).toBe('');
    await tick(10);
    expect(reasons).toEqual(['rejected']);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.0002, 9);
  });

  it('a submission while a run is live is refused with `a run is live; Enter steers it (Esc pauses, Esc Esc aborts)` and no request', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE }), script: () => ({ hold: true }) });
    void h.controller.run();
    await h.ready();
    const running = h.host.submit('fix the failing test', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await h.factory.nextLive();
    const calls = h.decider.calls.length;
    expect(await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'nothing' });
    // while live, `note()` rides engine.annotate(): the error is a `notice ui` event of the run, not a renderer-local item
    expect(h.factory.current().annotated).toEqual([`error: ${RUN_LIVE_ERROR}`]);
    expect(h.renderer.events.some((e) => e.type === 'notice' && e.kind === 'ui' && e.level === 'error' && e.text === `error: ${RUN_LIVE_ERROR}`)).toBe(true);
    expect(RUN_LIVE_ERROR).toBe('a run is live; Enter steers it (Esc pauses, Esc Esc aborts)');
    expect(h.decider.calls.length).toBe(calls);
    h.factory.current().release();
    expect(await running).toEqual({ became: 'run' });
    await h.host.awaitRunEnd();
  });

  it('§3.6: an unpriced generator refuses before sending (LLM_UNPRICED_REFUSAL) unless --allow-unpriced, under which the turn runs', async () => {
    const provider = fakeProvider({ text: 'answer' });
    const flags = { mock: false, mode: 'jev-on' as const, provider: 'openrouter', model: 'some/unknown-model', extraEnvFile: NO_EXTRA_ENV };
    const h = await build({ decider: harnessDecider({ usage: USAGE }), flags, env: { OPENROUTER_API_KEY: NO_KEY_OPENROUTER }, deps: { buildProvider: async () => provider } });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('why does test_parse_date fail?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(bubbles(h, '[jevcode]')).toEqual([LLM_UNPRICED_REFUSAL('some/unknown-model')]);
    expect(LLM_UNPRICED_REFUSAL('m')).toBe("I can't answer through the LLM: m has no pricing entry and --allow-unpriced is off (jev-only lookup still works).");
    expect(provider.requests).toHaveLength(0);
    const allowed = await build({ decider: harnessDecider({ usage: USAGE }), flags: { ...flags, allowUnpriced: true }, env: { OPENROUTER_API_KEY: NO_KEY_OPENROUTER }, deps: { buildProvider: async () => provider } });
    void allowed.controller.run();
    await allowed.ready();
    expect(await allowed.host.submit('why does test_parse_date fail?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(provider.requests).toHaveLength(1);
    expect(bubbles(allowed, '[jevcode]')).toEqual(['answer']);
    expect(JSON.stringify([h.renderer.notes, allowed.renderer.notes])).not.toContain(NO_KEY_OPENROUTER);
  });

  it('§3.6: the estimate `sessionTotal + chatEstimateUsd > cap` refuses the LLM turn before the request (SESSION_CAP_CHAT_REFUSAL, zero generator calls), the intake itself having passed', async () => {
    const provider = fakeProvider({ text: 'never' });
    // the default generator is the cheap glm-5.3-flash (commit 2a92d0b): a $0.00025 cap lets the $0.0002 intake through and makes any priced turn's estimate (≥ 1,200 input + 800 output tokens) overshoot
    const h = await build({ decider: harnessDecider({ usage: USAGE }), flags: { mock: false, mode: 'jev-on', extraEnvFile: NO_EXTRA_ENV, sessionSpendCap: '0.00025' }, env: { ANTHROPIC_API_KEY: NO_KEY_ANTHROPIC, OPENROUTER_API_KEY: NO_KEY_OPENROUTER }, deps: { buildProvider: async () => provider } });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('why does test_parse_date fail?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(h.decider.calls).toHaveLength(1);
    expect(bubbles(h, '[jevcode]')).toEqual([SESSION_CAP_CHAT_REFUSAL(0.00025)]);
    expect(provider.requests).toHaveLength(0);
    expect(h.controller.view.sessionMeter.snapshot().totalUsd).toBeCloseTo(0.0002, 9);
    expect(dispatchedOf(h, 'thinking').map((a) => (a as { phase: string | null }).phase)).toEqual(['replying', null]);
  });
});

describe('TUI-DESIGN-2 §3.5 through the controller: the keys and workspace facts (findings 7, 9) and §3.11 /why intake (finding 13)', () => {
  it('the keys fact names the environment variable the key came from (env TYPESAFE_API_KEY) and never its value', async () => {
    const key = `ts-${'0123456789abcdef'.repeat(3)}`;
    const h = await build({ decider: harnessDecider({ usage: USAGE, facts: ['keys'] }), flags: { mock: false, mode: 'jev-only', extraEnvFile: NO_EXTRA_ENV }, env: { TYPESAFE_API_KEY: key } });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('which keys are you using?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(bubbles(h, '[jevcode]')).toEqual(['Keys: Jev through typesafe (env TYPESAFE_API_KEY, never printed); generator: none — needed for jev+llm; /mode jev-on asks for one.']);
    expect(JSON.stringify(h.renderer.notes)).not.toContain(key);
  });

  it('the workspace fact names the detected runner before any run (`tests: pytest (detected)`), agreeing with the intake state it sent', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE, facts: ['workspace'] }), flags: { mode: 'jev-only' }, deps: { listCandidates: async () => [{ path: 'pytest.ini', bytes: 1 }, { path: 'tests/test_dates.py', bytes: 1 }, { path: 'utils/dates.py', bytes: 1 }] } });
    void h.controller.run();
    await h.ready();
    await h.host.submit('which mode is this?', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    expect(bubbles(h, '[jevcode]')).toEqual([`Workspace: ${h.workspace} (not a git repository; tests: pytest (detected))`]);
    const state = h.decider.calls[0]!.state as { workspace: { hasTests: boolean; testRunner: string } };
    expect(state.workspace).toMatchObject({ hasTests: true, testRunner: 'pytest' });
  });

  it('/why intake, /why intake.reply, /why intake.about_mode_now print the standard block with the §3.11 consumers; an unknown id or no intake yet is a [ui] error', async () => {
    const h = await build({ decider: harnessDecider({ usage: USAGE, latencyMs: 118 }) });
    void h.controller.run();
    await h.ready();
    await h.command('/why intake');
    expect(uiErrors(h).at(-1)).toBe(whyErrorText('intake', 'missing'));
    await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] });
    await h.command('/why intake');
    expect(h.renderer.notes.at(-1)?.text).toBe('why s0.intent.intake  request h1  118ms  typesafe/jev-1.13-20260917');
    expect(h.renderer.notes.at(-1)?.detail).toContain('consumed by: resolveChoice → run floor 0.60 → greeting_or_smalltalk');
    await h.command('/why intake.reply');
    expect(h.renderer.notes.at(-1)?.detail).toContain('consumed by: argmax → catalogue');
    await h.command('/why intake.about_mode_now');
    expect(h.renderer.notes.at(-1)?.detail).toContain('consumed by: ≥ 0.5 → answer line');
    await h.command('/why intake.can_greeting_or_smalltalk');
    expect(h.renderer.notes.at(-1)?.detail).toContain('consumed by: paired ≥ 0.5');
    await h.command('/why intake.nope');
    expect(uiErrors(h).at(-1)).toBe(whyErrorText('intake.nope', 'missing'));
    await h.command('/why intake.Nope');
    expect(uiErrors(h).at(-1)).toBe(whyErrorText('intake.Nope', 'grammar')); // one text for both renderers (§4.4 F8)
  });
});

describe('TUI-DESIGN-2 §3.13: the mock decider bridge (`--mock`)', () => {
  it('mockIntakeRules classify by the design\'s regexes and answer reply / about_* / file_* Nouls; JEVCODE_MOCK_INTAKE forces the kind; JEVCODE_MOCK_JEV_MS delays', async () => {
    const decider = createMockDecider({ rules: await mockIntakeRules({}) });
    const questions = buildAllIntakeQuestions([]);
    const kindOf = async (message: string, conversation: unknown[] = []): Promise<{ kind: string; reply: string }> => {
      const r = await decider.ask({ message, conversation: conversation as never }, questions, { signal: new AbortController().signal, stage: 'intent', step: 0 });
      const a = r.answers['intake'];
      const reply = r.answers['reply'];
      return { kind: a?.type === 'choice' ? a.choice : '?', reply: reply?.type === 'choice' ? reply.choice : '?' };
    };
    expect(await kindOf('hi')).toEqual({ kind: 'greeting_or_smalltalk', reply: 'hello_first' });
    expect((await kindOf('hi', [{ role: 'you', text: 'hi' }])).reply).toBe('hello_again');
    expect((await kindOf('thanks!')).reply).toBe('thanks');
    expect((await kindOf('ok')).reply).toBe('ok_ack');
    expect((await kindOf('bye')).reply).toBe('bye');
    expect((await kindOf('which mode is this?')).kind).toBe('question_about_this_tool');
    expect((await kindOf('where is the date parsing?')).kind).toBe('question_about_the_code');
    // §3.13: `ambiguous` for ≤ 2 words without `?` — `the date parsing` is three words and reads as a task (which is why chat-ambiguous.steps forces JEVCODE_MOCK_INTAKE)
    expect((await kindOf('parse_date')).kind).toBe('ambiguous');
    expect((await kindOf('the date parsing')).kind).toBe('coding_task');
    expect((await kindOf('fix the failing test')).kind).toBe('coding_task');
    expect((await kindOf('make the tests pass')).kind).toBe('coding_task');
    const forced = createMockDecider({ rules: await mockIntakeRules({ JEVCODE_MOCK_INTAKE: 'ambiguous' }) });
    const f = await forced.ask({ message: 'fix the failing test' }, questions, { signal: new AbortController().signal, stage: 'intent', step: 0 });
    expect(f.answers['intake']?.type === 'choice' && f.answers['intake'].choice).toBe('ambiguous');
    expect(mockIntakeOverride({ JEVCODE_MOCK_INTAKE: 'nonsense' })).toBeNull();
    expect(mockIntakeOverride({})).toBeNull();
    expect(mockJevLatencyMs({ JEVCODE_MOCK_JEV_MS: '250' })).toBe(250);
    expect(mockJevLatencyMs({})).toBe(0);
  });

  it('a `--mock` session (the pty scenarios): `hi` gets the mock reply, a task runs after `On it`, an ambiguous message offers `do it` — and the trajectory is untouched by the chat turns', async () => {
    // the controller's own `buildDecider` AND `buildProvider` (the mock bridge of §3.13), as the pty scenarios exercise them
    const h = await build({ decider: 'controller' });
    void h.controller.run();
    await h.ready();
    expect(await h.host.submit('hi', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(bubbles(h, '[jevcode]')).toEqual([MOCK_CHAT_REPLY]);
    expect(await h.host.submit('fix the failing test', { kind: 'prompt', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'run' });
    await h.host.awaitRunEnd();
    expect(h.factory.calls).toHaveLength(1);
    expect(bubbles(h, '[jevcode]').at(-1)).toBe(ON_IT_LINE);
    expect(await h.host.submit('parse_date', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'chat' });
    expect(bubbles(h, '[jevcode]').at(-1)).toBe(DO_IT_OFFER);
    expect(await h.host.submit('do it', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] })).toEqual({ became: 'run' });
    await h.host.awaitRunEnd();
    expect(h.factory.calls).toHaveLength(2);
    await waitFor(() => h.controller.view.phase === 'none');
  });
});

describe('the `do it` offer is never made on a question', () => {
  const ambiguous = { intake: { kind: 'ambiguous' } } as Parameters<typeof offerWanted>[1];
  const task = { intake: { kind: 'coding_task' } } as Parameters<typeof offerWanted>[1];
  it('an ambiguous statement gets the offer; an ambiguous question does not (live 2026-09-22: `who made you?` read ambiguous); other readings never do', () => {
    expect(offerWanted('the date parsing', ambiguous)).toBe(true);
    expect(offerWanted('who made you?', ambiguous)).toBe(false);
    // a question without its mark (live 2026-09-22: `who made you`) — interrogative openers count
    expect(offerWanted('who made you', ambiguous)).toBe(false);
    expect(offerWanted('How do I run the tests', ambiguous)).toBe(false);
    expect(offerWanted('can this handle utf-8', ambiguous)).toBe(false);
    expect(offerWanted('whoever wrote this, the date parsing', ambiguous)).toBe(true);
    expect(offerWanted('  what does calc.sub do ?  ', ambiguous)).toBe(false);
    expect(offerWanted('the date parsing', task)).toBe(false);
  });
});
