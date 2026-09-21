/**
 * TUI-DESIGN §19.0 `src/tui/plain-composer.ts`: `terminal: false` readline over PassThrough streams; Enter → submit
 * (idle) / steer (live) through the SessionHost; slash commands through `dispatchCommand` (a `/` typo never submits,
 * `plain: n/a` commands are refused, `/resume` without an id is refused); the secret gate twin (`y` sends with the
 * spans, anything else cancels with the tip); `@` denylist; history kinds; the §14.2 SIGINT matrix (live → abort and
 * stay; idle → hint, second within 1.5 s → exit 0); `close` = the §13.4 Ctrl-D rule (idle → exit 0; live → abort,
 * exit 0 after run:end; aborting → exit 0 after run:end without a second abort); lines are handled in order; one readline
 * interface per stdin — the confirmer borrows the composer's `lines` (§1, §6.5); history is appended after the host call
 * and `/steer <text>` / `/rename <title>` pass the secret gate (§10.2).
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Candidate, PendingDirective, SecretHit, SessionHost, SessionRow, SteerResult, SubmitOutcome, UiLabel } from '../../../src/core/types.js';
import type { KeyRunPhase } from '../../../src/tui/keys/resolve.js';
import { CTRL_C_AGAIN_HINT, PLAIN_PROMPT, RUN_ENDING_HINT, STEER_QUEUE_FULL_HINT, createReadlineComposer, plainSupports, plainUnavailableError, type SignalSource } from '../../../src/tui/plain-composer.js';
import { READLINE_CONFIRM_KEYS, createPlainRenderer, createReadlineConfirmer, type ConfirmInput } from '../../../src/tui/plain.js';
import { mkConfirmRequest } from '../../fixtures/tui/fixtures.js';
import { findCommand, type CommandSpec } from '../../../src/tui/commands/registry.js';
import { dispatchCommand } from '../../../src/tui/commands/dispatch.js';
import { GATE_DISMISS_TIP } from '../../../src/tui/secrets/gate-lines.js';
import { deniedMentionNotice } from '../../../src/tui/composer/submit.js';
import { tick } from '../../fixtures/tui/fixtures.js';

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

const SECRET = 'sk-ant-api03-SECRETSECRETSECRETSECRETSECRET';
/** a warn-only family (§10.1 aws): detected, never masked by `patternRedact` — only `addSecret` can redact it */
const AWS_KEY = 'AKIAABCDEFGHIJKLMNOP';

interface Call {
  kind: string;
  args: unknown[];
}

interface Fake {
  host: SessionHost;
  calls: Call[];
  /** every host touch in order: submit / steer / command / addSecret / history:<kind> (§10.2 ordering) */
  order: string[];
  history: { kind: string; text: string }[];
  notes: { text: string; label: UiLabel | undefined; level: string | undefined }[];
  exits: number[];
  aborts: string[];
  steerResult: SteerResult;
  hits: (s: string) => readonly SecretHit[];
  /** TUI-DESIGN-2 §3.9: what `submit` resolves — undefined is a pre-1.2 host (a run) */
  submitOutcome: SubmitOutcome | undefined;
}

function fakeHost(): Fake {
  const f: Fake = {
    calls: [],
    order: [],
    history: [],
    notes: [],
    exits: [],
    aborts: [],
    steerResult: { ok: true, index: 1, queued: 1 },
    submitOutcome: undefined,
    hits: (s) => {
      const out: SecretHit[] = [];
      const i = s.indexOf(SECRET);
      if (i >= 0) out.push({ family: 'anthropic', label: 'sk-ant-…', start: i, end: i + SECRET.length, warnOnly: false });
      const j = s.indexOf(AWS_KEY);
      if (j >= 0) out.push({ family: 'aws', label: 'AKIA…', start: j, end: j + AWS_KEY.length, warnOnly: true });
      return out;
    },
    host: {
      submit: async (text, opts) => {
        f.calls.push({ kind: 'submit', args: [text, opts] });
        f.order.push('submit');
        await tick();
        return f.submitOutcome;
      },
      command: async (line) => {
        f.calls.push({ kind: 'command', args: [line] });
        f.order.push('command');
        await tick();
      },
      steer: (text, opts) => {
        f.calls.push({ kind: 'steer', args: [text, opts] });
        f.order.push('steer');
        return f.steerResult;
      },
      unsteer: (): PendingDirective | null => null,
      pause: () => undefined,
      abort: (reason) => {
        f.aborts.push(reason);
      },
      retryNow: () => false,
      note: (text, opts) => {
        f.notes.push({ text, label: opts?.label, level: opts?.level });
      },
      redact: (s) => s.split(SECRET).join('[REDACTED:pattern]'),
      addSecret: (name, value) => {
        f.calls.push({ kind: 'addSecret', args: [name, value] });
        f.order.push('addSecret');
        return true;
      },
      detectSecrets: (s) => f.hits(s),
      exit: (code) => {
        f.exits.push(code);
      },
      index: (): readonly SessionRow[] => [],
      history: () => ({
        entries: () => [],
        append: (kind, text) => {
          f.history.push({ kind, text });
          f.order.push(`history:${kind}`);
        },
        clear: () => undefined,
      }),
      workspaceCandidates: async (): Promise<readonly Candidate[]> => [],
    },
  };
  return f;
}

class Signals implements SignalSource {
  listeners = new Set<() => void>();
  on(_e: 'SIGINT', fn: () => void): void {
    this.listeners.add(fn);
  }
  off(_e: 'SIGINT', fn: () => void): void {
    this.listeners.delete(fn);
  }
  fire(): void {
    for (const l of [...this.listeners]) l();
  }
}

function setup(o: { phase?: KeyRunPhase; ranBefore?: boolean; isDeniedPath?: (rel: string) => boolean; runEnd?: () => Promise<void>; reprompt?: boolean } = {}) {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  const output = new Sink();
  const stderr = new Sink();
  const fake = fakeHost();
  const signals = new Signals();
  let nowMs = 1_000_000;
  const state = { phase: o.phase ?? ('none' as KeyRunPhase), ranBefore: o.ranBefore ?? false };
  const composer = createReadlineComposer({
    input,
    output,
    stderr,
    host: fake.host,
    phase: () => state.phase,
    ranBefore: () => state.ranBefore,
    dispatch: () => ({ step: 3, changedSteps: [2], sessions: [{ id: '20260919-142301-k7q2m3xa', title: 'tz fixes' }], ...(o.isDeniedPath ? { isDeniedPath: o.isDeniedPath } : {}) }),
    ...(o.runEnd ? { awaitRunEnd: o.runEnd } : {}),
    ...(o.reprompt !== undefined ? { repromptAtRunEnd: o.reprompt } : {}),
    now: () => nowMs,
    signals,
  });
  const type = async (line: string): Promise<void> => {
    input.write(`${line}\n`);
    await tick();
    await composer.idle();
    await tick();
  };
  return { input, output, stderr, fake, signals, composer, state, type, advance: (ms: number) => (nowMs += ms) };
}

describe('createReadlineComposer: prompt and submissions (§1, §4.9)', () => {
  it('shows the `> ` prompt without echoing input (terminal: false); an idle line is a prompt submission with history', async () => {
    const s = setup();
    expect(s.output.text).toBe(PLAIN_PROMPT);
    await s.type('fix the failing test');
    expect(s.fake.calls).toEqual([{ kind: 'submit', args: ['fix the failing test', { kind: 'prompt', secretSpans: [], pinnedFiles: [] }] }]);
    expect(s.fake.history).toEqual([{ kind: 'prompt', text: 'fix the failing test' }]);
    expect(s.output.text).toBe(`${PLAIN_PROMPT}${PLAIN_PROMPT}`);
    expect(s.output.text).not.toContain('fix the failing test');
    s.composer.close();
    expect(s.composer.closed).toBe(true);
    s.composer.close();
    expect(s.fake.exits).toEqual([]);
  });

  it('after a run ended the submission is a follow-up; `//` escapes a literal slash; empty lines and controls are ignored', async () => {
    const s = setup({ ranBefore: true });
    await s.type('//usr/bin/env is the target');
    expect(s.fake.calls[0]).toEqual({ kind: 'submit', args: ['/usr/bin/env is the target', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] }] });
    await s.type('   ');
    await s.type('\u0007\u001b\u009b');
    expect(s.fake.calls).toHaveLength(1);
    s.composer.close();
  });

  it('while live a line steers through the host (history steer); a full queue and a finished run are handled', async () => {
    const s = setup({ phase: 'live' });
    await s.type('also update the docs');
    expect(s.fake.calls).toEqual([{ kind: 'steer', args: ['also update the docs', { secretSpans: [] }] }]);
    expect(s.fake.history).toEqual([{ kind: 'steer', text: 'also update the docs' }]);
    s.fake.steerResult = { ok: false, reason: 'full', queued: 8 };
    await s.type('ninth');
    expect(s.stderr.text).toContain(STEER_QUEUE_FULL_HINT);
    expect(s.fake.history).toHaveLength(1);
    // the run ended between the phase read and the steer: the text becomes a submission
    s.fake.steerResult = { ok: false, reason: 'finished', queued: 0 };
    await s.type('next task');
    expect(s.fake.calls.at(-1)).toEqual({ kind: 'submit', args: ['next task', { kind: 'prompt', secretSpans: [], pinnedFiles: [] }] });
    s.state.phase = 'starting';
    s.fake.steerResult = { ok: true, index: 2, queued: 1 };
    await s.type('early steer');
    expect(s.fake.calls.at(-1)).toEqual({ kind: 'steer', args: ['early steer', { secretSpans: [] }] });
    s.state.phase = 'aborting';
    await s.type('too late');
    expect(s.fake.calls.at(-1)?.args[0]).toBe('early steer');
    expect(s.stderr.text).toContain(RUN_ENDING_HINT);
    s.composer.close();
  });

  it('@ mentions become pinnedFiles; denylisted ones are dropped with the §24 notice', async () => {
    const s = setup({ isDeniedPath: (rel) => rel === '.env' });
    await s.type('read @src/a.py and @.env then fix');
    expect(s.fake.calls[0]).toEqual({ kind: 'submit', args: ['read @src/a.py and @.env then fix', { kind: 'prompt', secretSpans: [], pinnedFiles: ['src/a.py'] }] });
    expect(s.fake.notes).toEqual([{ text: deniedMentionNotice('.env'), label: '[ui]', level: 'info' }]);
    s.composer.close();
  });

  it('lines are handled strictly in order even though submit is asynchronous', async () => {
    const s = setup();
    s.input.write('first\nsecond\n/status\n');
    await tick();
    await s.composer.idle();
    expect(s.fake.calls.map((c) => c.args[0])).toEqual(['first', 'second', '/status']);
    s.composer.close();
  });
});

describe('TUI-DESIGN-2 §3.9 "History": the kind follows the SubmitOutcome', () => {
  it('a reply or lookup (`chat`) appends kind chat, a run appends prompt, a kept draft (`nothing`) appends nothing, a void (pre-1.2) host appends prompt — always after the host call', async () => {
    const s = setup();
    s.fake.submitOutcome = { became: 'chat' };
    await s.type('hi');
    expect(s.fake.history).toEqual([{ kind: 'chat', text: 'hi' }]);
    expect(s.fake.order).toEqual(['submit', 'history:chat']);
    s.fake.submitOutcome = { became: 'nothing' };
    await s.type('the date parsing');
    expect(s.fake.history).toHaveLength(1);
    expect(s.fake.calls.map((c) => c.args[0])).toEqual(['hi', 'the date parsing']);
    s.fake.submitOutcome = { became: 'run' };
    await s.type('fix the failing test');
    expect(s.fake.history.at(-1)).toEqual({ kind: 'prompt', text: 'fix the failing test' });
    s.fake.submitOutcome = undefined;
    await s.type('another task');
    expect(s.fake.history.at(-1)).toEqual({ kind: 'prompt', text: 'another task' });
    expect(s.fake.history).toHaveLength(3);
    s.composer.close();
  });

  it('the steer-fallback submission (the run ended between the phase read and the steer) follows the same rule', async () => {
    const s = setup({ phase: 'live', ranBefore: true });
    s.fake.steerResult = { ok: false, reason: 'finished', queued: 0 };
    s.fake.submitOutcome = { became: 'chat' };
    await s.type('thanks');
    expect(s.fake.calls.at(-1)).toEqual({ kind: 'submit', args: ['thanks', { kind: 'follow-up', secretSpans: [], pinnedFiles: [] }] });
    expect(s.fake.history).toEqual([{ kind: 'chat', text: 'thanks' }]);
    s.fake.submitOutcome = { became: 'nothing' };
    await s.type('hm');
    expect(s.fake.history).toHaveLength(1);
    s.composer.close();
  });
});

describe('createReadlineComposer: slash commands (§5.1, §5.2)', () => {
  it('a known command goes through dispatchCommand then host.command with history; typos and bad args are [ui] error items and never submit', async () => {
    const s = setup();
    await s.type('/status');
    await s.type('  /budget spend-cap 3');
    expect(s.fake.calls).toEqual([{ kind: 'command', args: ['/status'] }, { kind: 'command', args: ['/budget spend-cap 3'] }]);
    expect(s.fake.history).toEqual([{ kind: 'command', text: '/status' }, { kind: 'command', text: '/budget spend-cap 3' }]);
    await s.type('/foo');
    await s.type('/budget spend-cap abc');
    await s.type('/pause');
    expect(s.fake.calls).toHaveLength(2);
    expect(s.fake.notes.map((n) => n.text)).toEqual([
      'error: unknown command /foo; type / to list commands',
      'error: /budget spend-cap: expected a positive USD amount, got "abc"',
      'error: /pause needs a live run',
    ]);
    for (const n of s.fake.notes) expect(n).toMatchObject({ label: '[ui]', level: 'error' });
    s.composer.close();
  });

  it('live-only commands run while live; idle-only ones are refused while live; `/steer` text is a rest argument', async () => {
    const s = setup({ phase: 'live' });
    await s.type('/pause');
    await s.type("/steer don't touch the tests");
    await s.type('/undo');
    expect(s.fake.calls.map((c) => c.args[0])).toEqual(['/pause', "/steer don't touch the tests"]);
    expect(s.fake.notes.map((n) => n.text)).toEqual(['error: /undo runs when the run is idle; Esc pauses first']);
    s.composer.close();
  });

  it('plain: n/a commands, the /resume picker and /diff --full are refused with a [ui] error; /resume <id|title> runs', async () => {
    const s = setup();
    await s.type('/theme dark');
    await s.type('/copy');
    await s.type('/editor');
    await s.type('/resume');
    await s.type('/diff --full');
    expect(s.fake.calls).toEqual([]);
    expect(s.fake.notes.map((n) => n.text)).toEqual([
      plainUnavailableError(findCommand('theme') as CommandSpec),
      plainUnavailableError(findCommand('copy') as CommandSpec),
      plainUnavailableError(findCommand('editor') as CommandSpec),
      'error: /resume: the picker needs the TUI; give a run id or a session title (/resume <id|title>)',
      'error: /diff --full: the pager needs the TUI; the inline block is available',
    ]);
    await s.type('/resume "tz fixes"');
    await s.type('/diff 2');
    expect(s.fake.calls.map((c) => c.args[0])).toEqual(['/resume "tz fixes"', '/diff 2']);
    expect(plainUnavailableError(findCommand('theme') as CommandSpec)).toBe('error: /theme: not available in --plain (n/a)');
    const ok = dispatchCommand('/help', { run: 'none', step: 0 });
    expect(ok.ok && plainSupports(ok.spec, ok.action)).toEqual({ ok: true });
    s.composer.close();
  });
});

describe('createReadlineComposer: the secret gate twin (§4.10, §10.2)', () => {
  it('a text with a hit asks the readline gate; `y` sends with the spans, anything else cancels with the tip', async () => {
    const s = setup();
    await s.type(`use ${SECRET} for auth`);
    expect(s.fake.calls).toEqual([]);
    expect(s.output.text).toContain('jevcode: looks like this contains a secret (sk-ant-…); type y to send, anything else to cancel: ');
    await s.type('n');
    expect(s.fake.calls).toEqual([]);
    expect(s.stderr.text).toContain(GATE_DISMISS_TIP);
    await s.type(`use ${SECRET} for auth`);
    await s.type('y');
    expect(s.fake.calls).toEqual([{ kind: 'submit', args: [`use ${SECRET} for auth`, { kind: 'prompt', secretSpans: [SECRET], pinnedFiles: [] }] }]);
    // the store redacts with the session redactor: the composer hands the raw text over exactly once, after `submit` ran `addSecret`
    expect(s.fake.history).toEqual([{ kind: 'prompt', text: `use ${SECRET} for auth` }]);
    expect(s.fake.order).toEqual(['submit', 'history:prompt']);
    s.composer.close();
  });

  it('while live the gated text steers with its spans', async () => {
    const s = setup({ phase: 'live' });
    await s.type(`${SECRET}`);
    await s.type('yes');
    expect(s.fake.calls).toEqual([{ kind: 'steer', args: [SECRET, { secretSpans: [SECRET] }] }]);
    s.composer.close();
  });
});

describe('createReadlineComposer: SIGINT (§14.2) and EOF (§13.4)', () => {
  it('live: Ctrl-C aborts the run and stays; idle: hint, then a second within 1.5 s exits 0 (a later one hints again)', async () => {
    const s = setup({ phase: 'live' });
    s.signals.fire();
    expect(s.fake.aborts).toEqual(['human_abort']);
    expect(s.fake.exits).toEqual([]);
    s.state.phase = 'none';
    s.signals.fire();
    expect(s.stderr.text.split('\n').filter((l) => l === CTRL_C_AGAIN_HINT)).toHaveLength(1);
    expect(s.fake.exits).toEqual([]);
    s.advance(1_600);
    s.signals.fire();
    expect(s.stderr.text.split('\n').filter((l) => l === CTRL_C_AGAIN_HINT)).toHaveLength(2);
    expect(s.fake.exits).toEqual([]);
    s.advance(1_000);
    s.signals.fire();
    expect(s.fake.exits).toEqual([0]);
    expect(s.composer.closed).toBe(true);
    expect(s.signals.listeners.size).toBe(0);
  });

  it('aborting: Ctrl-C does nothing; close() detaches the listener', () => {
    const s = setup({ phase: 'aborting' });
    s.signals.fire();
    expect(s.fake.aborts).toEqual([]);
    expect(s.fake.exits).toEqual([]);
    s.composer.close();
    expect(s.signals.listeners.size).toBe(0);
  });

  it('EOF while idle exits 0; EOF while live aborts, waits for run:end, then exits 0', async () => {
    const idle = setup();
    idle.input.end();
    await tick();
    await idle.composer.idle();
    expect(idle.fake.exits).toEqual([0]);
    expect(idle.fake.aborts).toEqual([]);

    let release: () => void = () => undefined;
    const runEnd = new Promise<void>((r) => {
      release = r;
    });
    const live = setup({ phase: 'live', runEnd: () => runEnd });
    live.input.end();
    await tick();
    expect(live.fake.aborts).toEqual(['human_abort']);
    expect(live.fake.exits).toEqual([]);
    release();
    await tick();
    await live.composer.idle();
    expect(live.fake.exits).toEqual([0]);
    expect(live.composer.closed).toBe(true);
  });
});

describe('createReadlineComposer: the prompt returns at run:end (§1 session loop)', () => {
  it('repromptAtRunEnd: a submitted line shows one prompt when the run starts and one more when awaitRunEnd resolves; without the option the run end is silent', async () => {
    let release: () => void = () => undefined;
    const runEnd = new Promise<void>((r) => {
      release = r;
    });
    const s = setup({ runEnd: () => runEnd, reprompt: true });
    const before = s.output.text.split(PLAIN_PROMPT).length;
    await s.type('fix the failing test');
    expect(s.fake.calls).toEqual([{ kind: 'submit', args: ['fix the failing test', { kind: 'prompt', secretSpans: [], pinnedFiles: [] }] }]);
    // submit resolved at run start: the chain re-showed the prompt once (the steer prompt while live)
    expect(s.output.text.split(PLAIN_PROMPT).length).toBe(before + 1);
    release();
    await tick();
    expect(s.output.text.split(PLAIN_PROMPT).length).toBe(before + 2);
    s.composer.close();

    let release2: () => void = () => undefined;
    const runEnd2 = new Promise<void>((r) => {
      release2 = r;
    });
    const plain = setup({ runEnd: () => runEnd2 });
    const before2 = plain.output.text.split(PLAIN_PROMPT).length;
    await plain.type('fix the failing test');
    release2();
    await tick();
    expect(plain.output.text.split(PLAIN_PROMPT).length).toBe(before2 + 1);
    plain.composer.close();
  });

  it('repromptAtRunEnd never prompts while the lines are lent (a review) or while a gate is pending', async () => {
    let release: () => void = () => undefined;
    const runEnd = new Promise<void>((r) => {
      release = r;
    });
    const s = setup({ runEnd: () => runEnd, reprompt: true });
    await s.type('fix the failing test');
    const off = s.composer.lines.onLine(() => undefined);
    const before = s.output.text.split(PLAIN_PROMPT).length;
    release();
    await tick();
    expect(s.output.text.split(PLAIN_PROMPT).length).toBe(before);
    off();
    s.composer.close();
  });
});

describe('createReadlineComposer: history follows the host call; command lines pass the gate (§10.2)', () => {
  it('a warn-only span (AKIA…) acknowledged with y: history.append runs after submit (which registers the span), never before', async () => {
    const s = setup();
    await s.type(`deploy with ${AWS_KEY} today`);
    expect(s.fake.calls).toEqual([]);
    expect(s.output.text).toContain('looks like this contains a secret (AKIA…)');
    await s.type('y');
    expect(s.fake.calls).toEqual([{ kind: 'submit', args: [`deploy with ${AWS_KEY} today`, { kind: 'prompt', secretSpans: [AWS_KEY], pinnedFiles: [] }] }]);
    expect(s.fake.order).toEqual(['submit', 'history:prompt']);
    // while live the same order holds for steer; a plain command appends after host.command
    s.state.phase = 'live';
    await s.type('keep going');
    await s.type('/pause');
    expect(s.fake.order.slice(2)).toEqual(['steer', 'history:steer', 'command', 'history:command']);
    s.composer.close();
  });

  it('`/steer <secret>` while live and `/rename <secret>` while idle are gated: anything but y cancels; y registers the spans, then runs the command, then appends history', async () => {
    const s = setup({ phase: 'live' });
    await s.type(`/steer use ${AWS_KEY} for the deploy`);
    expect(s.fake.calls).toEqual([]);
    expect(s.output.text).toContain('looks like this contains a secret (AKIA…)');
    await s.type('n');
    expect(s.fake.calls).toEqual([]);
    expect(s.fake.history).toEqual([]);
    expect(s.stderr.text).toContain(GATE_DISMISS_TIP);
    await s.type(`/steer use ${AWS_KEY} for the deploy`);
    await s.type('y');
    expect(s.fake.calls).toEqual([
      { kind: 'addSecret', args: ['composer#1', AWS_KEY] },
      { kind: 'command', args: [`/steer use ${AWS_KEY} for the deploy`] },
    ]);
    expect(s.fake.order).toEqual(['addSecret', 'command', 'history:command']);
    s.state.phase = 'none';
    await s.type(`/rename ${SECRET}`);
    await s.type('yes');
    expect(s.fake.calls.slice(2)).toEqual([
      { kind: 'addSecret', args: ['composer#2', SECRET] },
      { kind: 'command', args: [`/rename ${SECRET}`] },
    ]);
    // a typo still never reaches the gate or the host
    await s.type(`/renam ${SECRET}`);
    expect(s.fake.calls).toHaveLength(4);
    expect(s.fake.notes.at(-1)?.text).toMatch(/^error: unknown command/);
    s.composer.close();
  });
});

describe('createReadlineComposer + createReadlineConfirmer on one stdin (§1, §6.5: one readline interface per stdin)', () => {
  it('a review answer typed while live resolves the review and is never steered; the next line reaches the composer; the prompt returns', async () => {
    const s = setup({ phase: 'live' });
    const confirmer = createReadlineConfirmer(s.input as ConfirmInput, s.output, { onAbort: () => undefined, lines: () => s.composer.lines });
    const p = confirmer.confirmDetailed(mkConfirmRequest('c1', 3), { signal: new AbortController().signal });
    await tick();
    expect(s.output.text).toContain(`[step 3] ${READLINE_CONFIRM_KEYS} > `);
    const promptsBefore = s.output.text.split(PLAIN_PROMPT).length;
    await s.type('y');
    await expect(p).resolves.toEqual({ approved: true });
    expect(s.fake.calls).toEqual([]);
    expect(s.fake.history).toEqual([]);
    // the composer's prompt comes back once the review released the lines
    expect(s.output.text.split(PLAIN_PROMPT).length).toBe(promptsBefore + 1);
    await s.type('also update the docs');
    expect(s.fake.calls).toEqual([{ kind: 'steer', args: ['also update the docs', { secretSpans: [] }] }]);
    expect(s.input.isPaused()).toBe(false);
    // a second review on the same stream still works (no interface was closed)
    const p2 = confirmer.confirmDetailed(mkConfirmRequest('c2', 4), { signal: new AbortController().signal });
    await tick();
    await s.type('d wrong file');
    await expect(p2).resolves.toEqual({ approved: false, note: 'wrong file' });
    await s.type('and the tests');
    expect(s.fake.calls.at(-1)).toEqual({ kind: 'steer', args: ['and the tests', { secretSpans: [] }] });
    s.composer.close();
  });

  it('through createPlainRenderer({ lines }) / setLineSource: the renderer\'s confirmer borrows the composer\'s lines; EOF declines a pending review and follows the Ctrl-D rule', async () => {
    let release: () => void = () => undefined;
    const runEnd = new Promise<void>((r) => {
      release = r;
    });
    const s = setup({ phase: 'live', runEnd: () => runEnd });
    const r = createPlainRenderer({ task: 't', resumeId: null, onAbort: () => undefined, stdout: s.output as unknown as NodeJS.WriteStream, stdin: s.input as unknown as NodeJS.ReadStream, lines: s.composer.lines });
    await r.firstFrame();
    const p = r.confirmer.confirmDetailed!(mkConfirmRequest('c1', 2), { signal: new AbortController().signal });
    await tick();
    await s.type('maybe');
    expect(s.fake.calls).toEqual([]);
    s.input.end();
    await tick();
    await expect(p).resolves.toEqual({ approved: false });
    expect(s.fake.aborts).toEqual(['human_abort']);
    expect(s.fake.exits).toEqual([]);
    release();
    await tick();
    await s.composer.idle();
    expect(s.fake.exits).toEqual([0]);
    // a review after EOF declines at once: nobody can answer it
    const late = createPlainRenderer({ task: 't', resumeId: null, onAbort: () => undefined, stdout: s.output as unknown as NodeJS.WriteStream, stdin: s.input as unknown as NodeJS.ReadStream });
    late.setLineSource(s.composer.lines);
    await expect(late.confirmer.confirmDetailed!(mkConfirmRequest('c3', 2), { signal: new AbortController().signal })).resolves.toEqual({ approved: false });
    expect(s.output.text).toContain('[step 2] confirm c3 declined: stdin closed');
    expect(s.composer.ownsSigint).toBe(true);
  });
});

describe('createReadlineComposer: EOF while aborting (§13.4)', () => {
  it('waits for run:end without a second abort, then exits 0', async () => {
    let release: () => void = () => undefined;
    const runEnd = new Promise<void>((r) => {
      release = r;
    });
    const s = setup({ phase: 'aborting', runEnd: () => runEnd });
    s.input.end();
    await tick();
    expect(s.fake.aborts).toEqual([]);
    expect(s.fake.exits).toEqual([]);
    release();
    await tick();
    await s.composer.idle();
    expect(s.fake.exits).toEqual([0]);
    expect(s.composer.closed).toBe(true);
  });
});
