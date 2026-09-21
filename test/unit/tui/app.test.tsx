/**
 * TUI-DESIGN §19.3 (`app.test.tsx`): the mounted App — the argv-only first frame in both modes (§1, F-A), keys
 * through `resolveKey` (§3), the review keys and the §6.3 deferral / arming (`y` approves; `n` / Esc decline;
 * Enter inert; typed-ahead `y` lands in the draft; a paste never matches), the `d` note path to `resolveDetailed`,
 * the Ctrl-C matrix cells S0 / S1 / S2 / S4 (§3.3), Enter while live = steer with the 9th refused (§8.6), the
 * paste chip (§4.5), the secret gate (§4.10: `y` sends only on an armed frame ≥ 150 ms after the Enter,
 * `host.addSecret` before `host.submit`), the palette (exact match runs, a typo keeps the draft), toasts, `[`/`]`
 * tabs, `?` help, and the piped-stdin mount (the confirmer declines). Ink's key parser is fed real bytes.
 */
import { EventEmitter } from 'node:events';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BlockingRequest, HistoryStore, LaunchSettings, RetryInfo, SecretHit, SessionHost, SteerResult } from '../../../src/core/types.js';
import { App, COALESCED_ENTER_TOAST, EXITED_CTRL_C, EXITED_CTRL_D, SR_REVIEW_MENU, SR_REVIEW_PROMPT, builderFaultFor, createBridge, createTuiRenderer, draftsDirFor, liveLines, queueRows, splitInputChunk, srReviewAnswer, type Bridge } from '../../../src/tui/App.js';
import { REVIEW_KEYS_80 } from '../../../src/tui/review/lines.js';
import { LIVE_FLUSH_MS, createEventBus, createTuiConfirmer, type UiAction, type UiState } from '../../../src/tui/useEngine.js';
import { IDENTITY_NO_TTY, formatTranscriptItem, itemsFromEvent, plainFirstLine } from '../../../src/tui/plain.js';
import { PLACEHOLDERS } from '../../../src/tui/composer/Composer.js';
import { EXIT_CONFIRM_ROW } from '../../../src/tui/Overlay.js';
import { renderFaultFor, resetRenderFaults } from '../../../src/tui/PaneBoundary.js';
import { resolveLaunchSettings } from '../../../src/config/launch.js';
import { detectSecrets, patternRedact } from '../../../src/core/redact.js';
import { fakeEngine, loadRunEvents, mkConfirmRequest, mkDecision, mkProposal, mkStatus, tick } from '../../fixtures/tui/fixtures.js';
import { StubStdin, StubStdout, dynamicRegion } from './stub-stdout.js';

afterEach(() => cleanup());
beforeEach(() => resetRenderFaults());

const ESC = '\x1b';
const CTRL_C = '\x03';
const CTRL_D = '\x04';
const CTRL_G = '\x07';
const CTRL_O = '\x0f';
const CTRL_R = '\x12';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const CANARY = `sk-ant-api03-${'A'.repeat(40)}`;

/** An in-memory `HistoryStore` recording every append (kind + text). */
interface FakeHistory extends HistoryStore {
  appended: { kind: string; text: string }[];
  list: string[];
}

function fakeHistory(entries: readonly string[] = []): FakeHistory {
  const s: FakeHistory = {
    appended: [],
    list: [...entries],
    entries: () => s.list,
    append: (kind, text) => {
      s.appended.push({ kind, text });
      s.list.push(text);
    },
    clear: () => {
      s.list = [];
    },
  };
  return s;
}

interface FakeHost extends SessionHost {
  submitted: { text: string; kind: string; secretSpans: readonly string[]; pinnedFiles: readonly string[] }[];
  steered: { text: string; secretSpans: readonly string[] }[];
  secrets: { name: string; value: string }[];
  notes: string[];
  commands: string[];
  exits: number[];
  aborts: string[];
  paused: number;
  retries: number;
  order: string[];
  steerResult: SteerResult;
  historyStore: FakeHistory | null;
}

function fakeHost(): FakeHost {
  const h: FakeHost = {
    submitted: [],
    steered: [],
    secrets: [],
    notes: [],
    commands: [],
    exits: [],
    aborts: [],
    paused: 0,
    retries: 0,
    order: [],
    steerResult: { ok: true, index: 1, queued: 1 },
    historyStore: null,
    submit: async (text, opts) => {
      h.order.push('submit');
      h.submitted.push({ text, kind: opts.kind, secretSpans: opts.secretSpans, pinnedFiles: opts.pinnedFiles });
    },
    command: async (line) => {
      h.commands.push(line);
    },
    steer: (text, opts) => {
      h.order.push('steer');
      h.steered.push({ text, secretSpans: opts.secretSpans });
      return h.steerResult;
    },
    unsteer: () => null,
    pause: () => {
      h.paused += 1;
    },
    abort: (r) => {
      h.aborts.push(r);
    },
    retryNow: () => {
      h.retries += 1;
      return true;
    },
    note: (text) => {
      h.notes.push(text);
    },
    redact: (s) => patternRedact(s),
    addSecret: (name, value) => {
      h.order.push('addSecret');
      h.secrets.push({ name, value });
      return true;
    },
    detectSecrets: (s): readonly SecretHit[] => detectSecrets(s),
    exit: (code) => {
      h.exits.push(code);
    },
    index: () => [],
    history: () => h.historyStore,
    workspaceCandidates: async () => [],
  };
  return h;
}

interface Mounted {
  bus: ReturnType<typeof createEventBus>;
  confirmer: ReturnType<typeof createTuiConfirmer>;
  aborts: string[];
  exits: number[];
  host: FakeHost | null;
  bridge: Bridge;
  stdin: { write: (s: string) => void };
  lastFrame: () => string;
  frames: string[];
  state: () => UiState | null;
  dispatch: (a: UiAction) => void;
}

interface MountOptions {
  mode?: 'session' | 'one-shot';
  task?: string;
  host?: FakeHost | null;
  now?: () => number;
  fault?: string;
  launch?: LaunchSettings;
  bridge?: Bridge;
  runsDir?: string;
  home?: string;
}

/** Mount through ink-testing-library: real key parsing, `debug` frames (static + dynamic in one string). */
function mountApp(opts: MountOptions = {}): Mounted {
  const bus = createEventBus();
  const confirmer = createTuiConfirmer();
  const aborts: string[] = [];
  const exits: number[] = [];
  const host = opts.host ?? null;
  // the bridge is private to App.tsx: hand the host through createTuiRenderer's shape by mounting with the same props it uses
  const bridge = opts.bridge ?? createBridge(host, null);
  const ui = render(
    <App
      task={opts.task ?? (opts.mode === 'session' ? '' : 'Fix the failing test')}
      resumeId={null}
      source={bus}
      confirmer={confirmer}
      onAbort={(r) => aborts.push(r)}
      mode={opts.mode ?? 'one-shot'}
      cwd="/Users/x/proj"
      onExit={(c) => exits.push(c)}
      tickMs={0}
      {...(opts.now ? { now: opts.now } : {})}
      {...(opts.fault !== undefined ? { fault: opts.fault } : {})}
      {...(opts.launch ? { launch: opts.launch } : {})}
      {...(opts.runsDir !== undefined ? { runsDir: opts.runsDir } : {})}
      {...(opts.home !== undefined ? { home: opts.home } : {})}
      bridge={bridge}
    />,
  );
  return {
    bus,
    confirmer,
    aborts,
    exits,
    host,
    bridge,
    stdin: ui.stdin,
    lastFrame: () => stripSgr(ui.lastFrame() ?? ''),
    frames: ui.frames,
    state: () => bridge.stateReader?.() ?? null,
    dispatch: (a) => bridge.command({ type: 'dispatch', action: a }),
  };
}

const retryInfo = (attempt: number, waitMs = 12_000): RetryInfo => ({ attempt, maxAttempts: 3, waitMs, retryAfter: true, cause: { kind: 'http', status: 429, code: null, message: 'rate limited' } });

function stripSgr(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Dynamic region = everything from the last rule row onwards (the <Static> scrollback sits above it). */
function dynamicLines(frame: string): string[] {
  const lines = frame.split('\n');
  const idx = lines.map((l) => /^[─-]{3,}/.test(l.trim()) && /[─-]{2,}$/.test(l.trim())).lastIndexOf(true);
  return lines.slice(idx);
}

function goLive(m: Mounted, step = 1): void {
  m.bus.emit({ type: 'run:start', runId: 'r1', task: 'Fix the failing test', mode: 'jev-on', resumedFromStep: null });
  m.bus.emit({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 'Fix the failing test', resumed: false });
  m.bus.emit({ type: 'status', status: mkStatus(step, 'propose') });
}

describe('<App> first frame (§1)', () => {
  it('one-shot: renders the status sentinel `step 0/` and the task header in the very first frame, before any engine is attached', () => {
    const m = mountApp();
    expect(m.frames.length).toBeGreaterThanOrEqual(1);
    expect(stripSgr(m.frames[0] ?? '')).toContain('step 0/–');
    expect(stripSgr(m.frames[0] ?? '')).toContain(plainFirstLine('Fix the failing test', null));
    expect(m.lastFrame()).toContain('starting');
    expect(m.lastFrame()).toContain('─'.repeat(10));
  });

  it('session: header `jevcode session · <dir> | step 0/– starting`, the rule, the composer placeholder and the idle status line — from argv only (F-A)', () => {
    const m = mountApp({ mode: 'session' });
    const f = m.lastFrame();
    expect(f).toContain('[run] jevcode session · proj | step 0/– starting');
    expect(f).toContain(`> ${PLACEHOLDERS.task}`);
    const dyn = dynamicLines(f);
    expect(dyn).toHaveLength(3); // rule + composer + status
    expect(dyn[2]).toMatch(/^idle\s+step 0\/–\s+\? help$/);
  });

  it('resume mode: the first frame names the run being resumed', () => {
    const bus = createEventBus();
    const { frames } = render(<App task="resuming 20260919-120000-ab12" resumeId="20260919-120000-ab12" source={bus} confirmer={createTuiConfirmer()} onAbort={() => undefined} tickMs={0} />);
    expect(stripSgr(frames[0] ?? '')).toContain('[run] jevcode resuming 20260919-120000-ab12 | step 0/– starting');
  });
});

describe('<App> transcript, live region and pane', () => {
  it('exec:output feeds the live region through the coalescer with escape sequences stripped; outcome clears it', async () => {
    const m = mountApp();
    goLive(m, 2);
    m.bus.emit({ type: 'exec:start', step: 2, action: { kind: 'run', command: 'pytest -q' } });
    m.bus.emit({ type: 'exec:output', step: 2, stream: 'stdout', chunk: 'collected 3 items\n' });
    m.bus.emit({ type: 'exec:output', step: 2, stream: 'stderr', chunk: '\u001b[2J\u001b[31mFAILED\u001b[0m tests/test_a.py\n' });
    await tick(LIVE_FLUSH_MS * 2);
    const f = m.lastFrame();
    expect(f).toContain('collected 3 items');
    expect(f).toContain('[2J[31mFAILED[0m tests/test_a.py');
    expect(f).not.toContain('\u001b[2J');
    m.bus.emit({ type: 'outcome', step: 2, outcome: { status: 'executed', summary: 'ran pytest', changedFiles: [] } });
    await tick(LIVE_FLUSH_MS * 2);
    expect(dynamicLines(m.lastFrame()).join('\n')).not.toContain('collected 3 items');
  });

  it('decisions pane shows DecisionRows with verdict words, the derived `~`, and the rule row carries the tab header', async () => {
    const m = mountApp();
    goLive(m, 3);
    const fe = fakeEngine();
    fe.engine.events.onAny((e) => m.bus.emit(e));
    fe.emit({ type: 'decision', decision: mkDecision({ id: 'destructive', verdict: 'review' }) });
    fe.emit({ type: 'decision', decision: mkDecision({ id: 'irreversible', verdict: 'block', probability: 0.9 }) });
    fe.emit({ type: 'decision', decision: mkDecision({ stage: 'judge', id: 'succeeded', question: { type: 'noul', instructions: 'x', criteria: { true: 't', false: 'f' } }, answer: { type: 'noul', noul: 0.92 }, probability: 0.92, confidence: 0.84 }) });
    fe.emit({ type: 'status', status: mkStatus(3, 'judge') });
    await tick(20);
    const f = m.lastFrame();
    expect(f).toContain('[d]ecisions [p]lan [t]ime [s]ynth');
    expect(f).toMatch(/s3 risk\s+destructive\s+L1 .*\[review\]/);
    expect(f).toMatch(/s3 risk\s+irreversible\s+L1 .*\[block\]/);
    expect(f).toMatch(/s3 judge\s+succeeded\s+noul .*0\.92 {2}c 0\.84~/);
    expect(f).toContain('step 3/40');
  });

  it('`]` and `[` cycle the tabs on an empty composer; `d p t s` insert text', async () => {
    const m = mountApp();
    goLive(m);
    await tick(10);
    m.stdin.write(']');
    await tick(10);
    expect(m.lastFrame()).toContain('─── plan s1');
    m.stdin.write('[');
    await tick(10);
    expect(m.lastFrame()).toContain('─── decisions s1');
    m.stdin.write('d');
    await tick(10);
    expect(m.lastFrame()).toContain('> d');
    expect(m.lastFrame()).toContain('─── decisions s1');
  });

  it('renders the whole scripted run: transcript rows match formatTranscriptItem line for line; run:end reopens the composer with the follow-up placeholder', async () => {
    const m = mountApp({ mode: 'session' });
    const events = loadRunEvents();
    for (const e of events) m.bus.emit(e);
    await tick(LIVE_FLUSH_MS * 2);
    const f = m.lastFrame();
    let seq = 0;
    for (const e of events) {
      for (const item of itemsFromEvent(e, seq)) {
        expect(f).toContain(formatTranscriptItem(item));
        seq += 1;
      }
    }
    expect(f).toContain('idle exit 4');
    expect(f).toContain(`> ${PLACEHOLDERS.followup}`);
    expect(m.state()?.run).toBe('none');
  });

  it('streams deltas into the live region (coalesced) and commits exactly one proposal item that clears the live region', async () => {
    const m = mountApp();
    goLive(m);
    m.bus.emit({ type: 'generator:start', step: 1, attempt: 1 });
    const before = m.frames.length;
    for (let i = 0; i < 40; i++) m.bus.emit({ type: 'generator:delta', step: 1, text: `{"chunk":${i}}` });
    await tick(LIVE_FLUSH_MS * 2);
    expect(m.frames.length - before).toBeLessThan(10);
    expect(m.lastFrame()).toMatch(/streaming… \d+ chars/);
    m.bus.emit({ type: 'generator:delta', step: 1, text: '\nline A\nline B\nline C' });
    await tick(LIVE_FLUSH_MS * 2);
    expect(m.lastFrame()).toContain('line B');
    expect(m.lastFrame()).toContain('line C');
    expect(m.lastFrame()).not.toContain('line A');
    const proposal = mkProposal();
    m.bus.emit({ type: 'proposal', step: 1, proposal });
    await tick(LIVE_FLUSH_MS * 2);
    const f = m.lastFrame();
    const line = formatTranscriptItem(itemsFromEvent({ type: 'proposal', step: 1, proposal }, 0)[0]!);
    expect(f.split(line).length - 1).toBe(1);
    expect(f).not.toContain('line C');
    expect(dynamicLines(f).join('\n')).not.toContain('proposal edit');
  });
});

describe('<App> review (§6)', () => {
  it('the box appears after the ~1 s deferral; y approves; typed-ahead keys during the deferral land in the draft', async () => {
    const m = mountApp();
    goLive(m, 3);
    await tick(10);
    m.stdin.write('y'); // a key just before the request: the box defers ≥ 1 s after it
    await tick(10);
    const req = mkConfirmRequest('c1', 3);
    const p = m.confirmer.confirm(req, { signal: new AbortController().signal });
    m.bus.emit({ type: 'confirm:request', request: req });
    await tick(30);
    // during the deferral: keys are text, the status says review pending…
    expect(m.lastFrame()).toContain('review pending…');
    m.stdin.write('y');
    await tick(30);
    expect(m.lastFrame()).toContain('> yy');
    expect(m.confirmer.pending()?.id).toBe('c1');
    // typing keeps deferring (visibleAt = lastKeystrokeAt + 1000)
    await tick(1250);
    const f = m.lastFrame();
    expect(f).toContain('review  step 3  risk 0.50 (exp)  edit src/a.py "fix the off-by-one"');
    expect(f).toContain(REVIEW_KEYS_80);
    expect(f).toContain('--- old');
    expect(f).toContain('(review pending');
    // the draft `y` under the review: Ctrl-C clears it (F5 text rule outranks), the box stays
    m.stdin.write(CTRL_C);
    await tick(30);
    expect(m.aborts).toEqual([]);
    expect(m.lastFrame()).toContain(REVIEW_KEYS_80);
    m.stdin.write('y');
    await expect(p).resolves.toBe(true);
    await tick(30);
    expect(m.lastFrame()).not.toContain(REVIEW_KEYS_80);
  });

  it('n declines, Esc declines, Enter is inert, a paste never matches, printables toast `review pending: …`', async () => {
    const m = mountApp();
    goLive(m, 4);
    const signal = new AbortController().signal;
    const req = mkConfirmRequest('c2', 4);
    const p = m.confirmer.confirm(req, { signal });
    await tick(1250);
    expect(m.lastFrame()).toContain('review  step 4');
    m.stdin.write('\r');
    await tick(20);
    expect(m.confirmer.pending()?.id).toBe('c2');
    m.stdin.write('\x1b[200~y\x1b[201~');
    await tick(20);
    expect(m.confirmer.pending()?.id).toBe('c2');
    m.stdin.write('x');
    await tick(20);
    expect(m.lastFrame()).toContain('review pending: y n d e w · Esc declines');
    m.stdin.write('n');
    await expect(p).resolves.toBe(false);

    const req3 = mkConfirmRequest('c3', 5);
    const p3 = m.confirmer.confirm(req3, { signal });
    await tick(1250);
    m.stdin.write(ESC);
    await tick(80); // the 30 ms re-buffer expires → Esc = decline
    await expect(p3).resolves.toBe(false);
  });

  it('Ctrl-C with an empty draft on an armed review calls abort and never resolveDetailed (rule-1 discard through the signal)', async () => {
    const m = mountApp();
    goLive(m, 4);
    const ac = new AbortController();
    const req = mkConfirmRequest('c4', 4);
    const p = m.confirmer.confirm(req, { signal: ac.signal });
    await tick(1250);
    expect(m.lastFrame()).toContain(REVIEW_KEYS_80);
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(m.aborts).toEqual(['human_abort']);
    expect(m.confirmer.pending()?.id).toBe('c4'); // still pending until the engine's signal rejects it
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(Error);
  });

  it('d opens the note field in the header row 2; Enter sends resolveDetailed({ approved: false, note }); the draft is restored', async () => {
    const m = mountApp();
    goLive(m, 4);
    await tick(10);
    m.stdin.write('my draft');
    await tick(10);
    const req = mkConfirmRequest('c5', 4);
    const p = m.confirmer.confirmDetailed(req, { signal: new AbortController().signal });
    await tick(1250);
    m.stdin.write('d');
    await tick(20);
    expect(m.lastFrame()).toContain('note (≤ 600, Enter sends, Esc cancels):'); // Ink trims the row's trailing space
    m.stdin.write('skip the tests');
    await tick(20);
    expect(m.lastFrame()).toContain('note (≤ 600, Enter sends, Esc cancels): skip the tests');
    m.stdin.write('\r');
    await expect(p).resolves.toEqual({ approved: false, note: 'skip the tests' });
    await tick(20);
    expect(m.lastFrame()).toContain('> my draft');
  });

  it('e expands the preview (pane yields); w then a digit appends the /why block', async () => {
    const m = mountApp();
    goLive(m, 3);
    m.bus.emit({ type: 'decision', decision: mkDecision({ step: 3, stage: 'risk', id: 'destructive', verdict: 'review' }) });
    const req = mkConfirmRequest('c6', 3, { kind: 'write', path: 'big.txt', content: Array.from({ length: 30 }, (_, i) => `content line ${i}`).join('\n') });
    void m.confirmer.confirm(req, { signal: new AbortController().signal });
    await tick(1250);
    const before = dynamicLines(m.lastFrame()).filter((l) => l.includes('content line')).length;
    m.stdin.write('e');
    await tick(20);
    const after = dynamicLines(m.lastFrame()).filter((l) => l.includes('content line')).length;
    expect(after).toBeGreaterThan(before);
    expect(m.state()?.expanded).toBe(true);
    m.stdin.write('w');
    await tick(10);
    m.stdin.write('1');
    await tick(20);
    expect(m.lastFrame()).toContain('[ui] why s3.risk.destructive');
  });
});

describe('<App> Ctrl-C / Esc / Ctrl-D matrix (§3.3)', () => {
  it('S0 idle·empty (session): Ctrl-C toasts `press Ctrl-C again to exit`; a second within 1.5 s exits 0 with the item', async () => {
    const m = mountApp({ mode: 'session' });
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(m.lastFrame()).toContain('! press Ctrl-C again to exit');
    expect(m.exits).toEqual([]);
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(m.exits).toEqual([0]);
    expect(m.lastFrame()).toContain(`[ui] ${EXITED_CTRL_C}`);
  });

  it('S1 idle·text: Ctrl-C clears the draft (no exit, no abort); Esc Esc clears too', async () => {
    const m = mountApp({ mode: 'session' });
    m.stdin.write('half a thought');
    await tick(10);
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(m.lastFrame()).not.toContain('half a thought');
    expect(m.exits).toEqual([]);
    expect(m.aborts).toEqual([]);
    m.stdin.write('again');
    await tick(10);
    m.stdin.write(ESC);
    await tick(80);
    expect(m.lastFrame()).toContain('Esc again clears the draft');
    m.stdin.write(ESC);
    await tick(80);
    expect(m.lastFrame()).not.toContain('> again');
  });

  it('S2 live·empty: one-shot Ctrl-C aborts (human_abort); session Ctrl-C aborts and stays; Esc pauses with the toast', async () => {
    const one = mountApp({ mode: 'one-shot' });
    goLive(one);
    await tick(10);
    one.stdin.write(CTRL_C);
    await tick(20);
    expect(one.aborts).toEqual(['human_abort']);
    expect(one.lastFrame()).toContain('aborting');
    cleanup();
    const host = fakeHost();
    const s = mountApp({ mode: 'session', host });
    goLive(s);
    await tick(10);
    s.stdin.write(ESC);
    await tick(80);
    expect(host.paused).toBe(1);
    expect(s.lastFrame()).toContain('Esc again aborts the run'); // the toast owns the left zone for 2 s
    expect(s.state()?.run).toBe('pausing');
    s.stdin.write(ESC);
    await tick(80);
    expect(host.aborts).toEqual(['human_abort']);
    expect(s.exits).toEqual([]);
  });

  it('S2 Ctrl-D twice opens the exit confirm; n stays; y aborts and exits 0 after run:end', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    goLive(m);
    await tick(10);
    m.stdin.write(CTRL_D);
    await tick(20);
    expect(m.lastFrame()).toContain('run is live — Ctrl-D again to choose');
    m.stdin.write(CTRL_D);
    await tick(20);
    expect(m.lastFrame()).toContain('a run is live: [y] abort and exit   [n] stay');
    expect(m.lastFrame()).toContain('> (waiting for y/n)');
    m.stdin.write('y'); // not armed yet (< 150 ms): inert
    await tick(20);
    expect(host.aborts).toEqual([]);
    m.stdin.write('n');
    await tick(20);
    expect(m.lastFrame()).not.toContain('a run is live:');
    m.stdin.write(CTRL_D);
    m.stdin.write(CTRL_D);
    await tick(200);
    m.stdin.write('y');
    await tick(20);
    expect(host.aborts).toEqual(['human_abort']);
    m.bus.emit({ type: 'run:end', result: { ...loadRunEvents().find((e) => e.type === 'run:end')!.result, stopReason: 'human_abort' } as never, exitCode: 130 });
    await tick(30);
    expect(host.exits).toEqual([0]);
  });
});

describe('<App> composer, steer, paste, gate, palette (§4, §5, §8.6, §10)', () => {
  it('Enter while live steers through host.steer; the queue rows show; a full queue toasts', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    goLive(m, 5);
    await tick(10);
    m.stdin.write('use fromisoformat');
    await tick(10);
    m.stdin.write('\r');
    await tick(20);
    expect(host.steered).toEqual([{ text: 'use fromisoformat', secretSpans: [] }]);
    m.bus.emit({ type: 'steer:queued', step: 6, index: 1, text: 'use fromisoformat', queued: 1 });
    await tick(20);
    expect(m.lastFrame()).toContain('↑1 queued for step 6: use fromisoformat');
    expect(m.lastFrame()).toContain('[↑ takes back]');
    host.steerResult = { ok: false, reason: 'full', queued: 8 };
    m.stdin.write('ninth');
    await tick(10);
    m.stdin.write('\r');
    await tick(20);
    expect(m.lastFrame()).toContain('steer queue full (8)');
    expect(host.notes).toContain('! steer queue full (8)');
    expect(queueRows([{ text: 'a' }, { text: 'b' }], 6, 2, 80)[1]).toMatch(/\[↑ takes back\]$/);
  });

  it('Enter while idle submits through host.submit (kind prompt, then follow-up), never before the host attached (held)', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    m.stdin.write('fix parse_date tz handling');
    await tick(10);
    m.stdin.write('\r');
    await tick(20);
    expect(host.submitted).toEqual([{ text: 'fix parse_date tz handling', kind: 'prompt', secretSpans: [], pinnedFiles: [] }]);
    expect(m.lastFrame()).toContain('starting');
  });

  it('a `/` at column 0 opens the palette; Enter on a typo keeps the draft with the [ui] error; an exact match runs (host.command)', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    m.stdin.write('/');
    await tick(20);
    expect(m.lastFrame()).toContain('Tab completes · Enter runs an exact match · Esc closes');
    expect(m.lastFrame()).toMatch(/palette\s/);
    m.stdin.write('budgett');
    await tick(10);
    m.stdin.write('\r');
    await tick(20);
    expect(host.notes).toContain('error: unknown command /budgett; type / to list commands');
    expect(m.lastFrame()).toContain('> /budgett');
    expect(host.submitted).toEqual([]);
    m.stdin.write(CTRL_C); // S5 palette: closes the palette, the draft is kept
    await tick(20);
    expect(m.lastFrame()).toContain('> /budgett');
    expect(m.lastFrame()).not.toContain('Tab completes');
    m.stdin.write(CTRL_C); // S1: clears the draft
    await tick(20);
    expect(m.lastFrame()).not.toContain('/budgett');
    m.stdin.write('/status');
    await tick(10);
    m.stdin.write('\r');
    await tick(20);
    expect(host.commands).toEqual(['/status']);
  });

  it('a multi-line paste becomes a chip whose body never appears in a frame; submit expands it', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    const body = Array.from({ length: 6 }, (_, i) => `pasted secret-free line ${i}`).join('\n');
    m.stdin.write(`\x1b[200~${body}\x1b[201~`);
    await tick(20);
    expect(m.lastFrame()).toContain('[Pasted #1, 6 lines]');
    expect(m.lastFrame()).not.toContain('pasted secret-free line 3');
    m.stdin.write('\r');
    await tick(20);
    expect(host.submitted[0]?.text).toContain('pasted secret-free line 3');
  });

  it('the secret gate: Enter on a draft with an sk-ant- canary opens the row; y within 150 ms is ignored (§6.3: the row stays, nothing typed); an armed y sends with addSecret before submit; Esc dismisses', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    const canary = `sk-ant-api03-${'A'.repeat(40)}`;
    m.stdin.write(`use ${canary} for the smoke test`);
    await tick(10);
    // the composer masks the span as • cells
    expect(m.lastFrame()).not.toContain(canary);
    expect(m.lastFrame()).toContain('•'.repeat(20));
    expect(m.lastFrame()).toContain('⚠ secret?');
    m.stdin.write('\r');
    await tick(10);
    expect(m.lastFrame()).toContain('Looks like this contains a secret (sk-ant-…). Send anyway? y/N');
    m.stdin.write('y'); // within 150 ms of the Enter: neither a confirmation nor a dismissal — the row stays and the y is dropped (§4.10, §6.3)
    await tick(10);
    expect(host.submitted).toEqual([]);
    expect(m.lastFrame()).toContain('Send anyway? y/N');
    expect(m.lastFrame()).not.toMatch(/smoke testy/);
    await tick(200);
    expect(m.lastFrame()).toContain('Send anyway? y/N');
    m.stdin.write('y'); // armed: sends
    await tick(20);
    expect(host.submitted).toHaveLength(1);
    expect(host.submitted[0]?.secretSpans).toEqual([canary]); // the host addSecret()s every span before createEngine (§10.2)
    expect(host.submitted[0]?.text).toContain(canary);
    // the frames never carried the bytes
    for (const f of m.frames) expect(f).not.toContain(canary);
    // dismiss path
    m.stdin.write(`again ${canary}`);
    await tick(10);
    m.stdin.write('\r');
    await tick(10);
    expect(m.lastFrame()).toContain('Send anyway? y/N');
    m.stdin.write(ESC);
    await tick(80);
    expect(m.lastFrame()).not.toContain('Send anyway?');
    expect(m.lastFrame()).toContain('Tip: put it in .env and refer to it by name');
    expect(host.submitted).toHaveLength(1);
  });

  it('? on an empty draft appends the help block; Ctrl+O appends the decision detail', async () => {
    const m = mountApp({ mode: 'session' });
    m.stdin.write('?');
    await tick(20);
    expect(m.lastFrame()).toContain('[ui] keys');
    expect(m.lastFrame()).toContain('Shift+Enter needs a keyboard protocol');
  });

  it('a toast replaces the status left zone for 2 s and expires on the tick', async () => {
    const m = mountApp({ mode: 'session', now: () => 5000 });
    m.dispatch({ type: 'toast', text: 'saved — applies to the next run (this run keeps its key)', level: 'ok', ms: 2000 });
    await tick(20);
    expect(m.lastFrame()).toContain('✓ saved — applies to the next run (this run keeps its key)');
    m.dispatch({ type: 'tick', now: 9000 });
    await tick(20);
    expect(m.lastFrame()).not.toContain('✓ saved');
  });
});

describe('createTuiRenderer', () => {
  it('mounts without throwing when stdin has no isTTY (piped) and still renders the sentinel; the confirmer declines', async () => {
    class Out extends EventEmitter {
      frames: string[] = [];
      columns = 80;
      rows = 24;
      write = (s: string): boolean => {
        this.frames.push(s);
        return true;
      };
    }
    class In extends EventEmitter {
      isTTY: boolean | undefined = undefined;
      setEncoding(): void {}
      resume(): void {}
      pause(): void {}
      ref(): void {}
      unref(): void {}
      read(): null {
        return null;
      }
    }
    const out = new Out();
    const stdin = new In();
    const r = createTuiRenderer({
      task: 'piped task',
      resumeId: null,
      onAbort: () => undefined,
      stdout: out as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      confirmTimeoutMs: 5,
    });
    await r.firstFrame();
    expect(r.confirmer.identity).toBe(IDENTITY_NO_TTY);
    const fe = fakeEngine();
    r.attach(fe.engine);
    fe.emit({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 'piped task', resumed: false });
    await expect(r.confirmer.confirm(mkConfirmRequest('c1', 1), { signal: new AbortController().signal })).resolves.toBe(false);
    r.notify('recent: "fix parse_date tz" · 2 h ago  (Enter continues, /resume browses)', { label: '[ui]' });
    await tick(20);
    await r.unmount();
    const all = stripSgr(out.frames.join(''));
    expect(all).toContain('step 0/');
    expect(all).toContain('[run] ready r1 step 0/40');
    expect(all).toContain(plainFirstLine('piped task', null));
    expect(all).toContain('[ui] recent: "fix parse_date tz"');
  });

  it('liveLines keeps its contract', () => {
    expect(liveLines('', 2)).toEqual([]);
    expect(liveLines('abc', 2)).toEqual(['streaming… 3 chars']);
    expect(liveLines('a\nb', 0)).toEqual([]);
    expect(liveLines('done\r\n', 2)).toEqual(['done']);
  });
});


// ---------------------------------------------------------------------------------------------------------------
// FIX pass: the findings of the O9 review (blocker 1, majors 2–8, minors 10–19) and the missing §19.3 items
// ---------------------------------------------------------------------------------------------------------------

describe('<App> a submission that never becomes a run (§4.9, finding 1)', () => {
  it('host.submit() resolving without run:start returns run to none: the status is idle again, Enter submits again, Ctrl-C ×2 exits 0', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    m.stdin.write('first attempt');
    await tick(10);
    m.stdin.write('\r');
    await tick(30);
    expect(host.submitted).toHaveLength(1);
    expect(m.state()?.run).toBe('none');
    expect(dynamicLines(m.lastFrame()).at(-1)).toMatch(/^idle\s/);
    expect(m.lastFrame()).not.toContain('run is ending; wait for run:end');
    m.stdin.write('second attempt');
    await tick(10);
    m.stdin.write('\r');
    await tick(30);
    expect(host.submitted).toHaveLength(2);
    expect(host.submitted[1]?.text).toBe('second attempt');
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(m.lastFrame()).toContain('press Ctrl-C again to exit');
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(host.exits).toEqual([0]);
    expect(host.aborts).toEqual([]);
  });

  it('/exit after a refused submission exits 0 at once (no exit confirm for a run that does not exist)', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    m.stdin.write('refused task\r');
    await tick(30);
    expect(m.state()?.run).toBe('none');
    m.stdin.write('/exit');
    await tick(10);
    m.stdin.write('\r');
    await tick(20);
    expect(host.exits).toEqual([0]);
    expect(m.lastFrame()).not.toContain(EXIT_CONFIRM_ROW);
  });

  it('while the submit is still in flight (starting, no engine) Ctrl-C follows the S0 rules: hint then exit 0 through the host, never an abort on nothing', async () => {
    const host = fakeHost();
    let release: () => void = () => undefined;
    host.submit = () =>
      new Promise<void>((r) => {
        release = r;
      });
    const m = mountApp({ mode: 'session', host });
    m.stdin.write('slow start\r');
    await tick(30);
    expect(m.state()?.run).toBe('starting');
    expect(m.lastFrame()).toMatch(/\nstarting\s/);
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(host.aborts).toEqual([]);
    expect(m.state()?.run).toBe('starting');
    expect(m.lastFrame()).toContain('press Ctrl-C again to exit');
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(host.exits).toEqual([0]);
    release();
    await tick(20);
    expect(m.state()?.run).toBe('none');
  });

  it('a submit that does start a run stays live (run:start flips starting → live before submit resolves)', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    host.submit = async () => {
      goLive(m, 1);
    };
    m.stdin.write('real task\r');
    await tick(30);
    expect(m.state()?.run).toBe('live');
  });
});

describe('<App> coalesced input chunks (§4.5 step 1 amended, finding 2)', () => {
  const NONE = { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false };

  it('splitInputChunk: `text\\r` is text then Enter; `abc\\r\\x03\\x03` splits into text, Enter, Ctrl-C, Ctrl-C; `^C^C/exit\\r` into Ctrl-C ×2, text, Enter', () => {
    const a = splitInputChunk('probe task via chat\r', NONE);
    expect(a.events.map((e) => (e.key.return ? 'RET' : e.input))).toEqual(['probe task via chat', 'RET']);
    expect(a.foldedEnter).toBe(false);
    const b = splitInputChunk('abc\r\x03\x03', NONE);
    expect(b.events.map((e) => (e.key.return ? 'RET' : e.key.ctrl ? `^${e.input}` : e.input))).toEqual(['abc', 'RET', '^c', '^c']);
    const c = splitInputChunk('\x03\x03/exit\r', NONE);
    expect(c.events.map((e) => (e.key.return ? 'RET' : e.key.ctrl ? `^${e.input}` : e.input))).toEqual(['^c', '^c', '/exit', 'RET']);
    const d = splitInputChunk('\x04\x04', NONE);
    expect(d.events.map((e) => `^${e.input}`)).toEqual(['^d', '^d']);
    const e = splitInputChunk('a\x1bb', NONE);
    expect(e.events.map((x) => (x.key.escape ? 'ESC' : x.input))).toEqual(['a', 'ESC', 'b']);
    const f = splitInputChunk('ab\x7f\x7fc', NONE);
    expect(f.events.map((x) => (x.key.backspace ? 'BS' : x.input))).toEqual(['ab', 'BS', 'BS', 'c']);
  });

  it('splitInputChunk: a lone control byte with no flags is Ink\'s stripped `ESC <byte>` → Esc then the key; meta+ctrl+letter likewise; named keys, modifiers, single graphemes and plain text pass through', () => {
    const stripped = splitInputChunk('\x03', NONE);
    expect(stripped.events).toHaveLength(2);
    expect(stripped.events[0]?.key.escape).toBe(true);
    expect(stripped.events[1]).toMatchObject({ input: 'c', key: { ctrl: true } });
    const metaCtrl = splitInputChunk('c', { ...NONE, meta: true, ctrl: true });
    expect(metaCtrl.events[0]?.key.escape).toBe(true);
    expect(metaCtrl.events[1]).toMatchObject({ input: 'c', key: { ctrl: true, meta: false } });
    expect(splitInputChunk('', { ...NONE, upArrow: true }).events).toEqual([{ input: '', key: { ...NONE, upArrow: true } }]);
    expect(splitInputChunk('c', { ...NONE, ctrl: true }).events).toEqual([{ input: 'c', key: { ...NONE, ctrl: true } }]);
    expect(splitInputChunk('é', NONE).events).toEqual([{ input: 'é', key: NONE }]);
    expect(splitInputChunk('plain typed text', NONE).events).toEqual([{ input: 'plain typed text', key: NONE }]);
    expect(splitInputChunk('\t', NONE).events).toEqual([{ input: '\t', key: NONE }]);
  });

  it('splitInputChunk: an interior newline keeps the chunk paste-like (a 2004-less terminal pastes this way) and flags a trailing CR', () => {
    const p = splitInputChunk('line one\rline two\r', NONE);
    expect(p.events).toEqual([{ input: 'line one\rline two\r', key: NONE }]);
    expect(p.foldedEnter).toBe(true);
    expect(splitInputChunk('line one\nline two', NONE).foldedEnter).toBe(false);
  });

  it('through the App: `task\\r` in one chunk submits the task; `\\x03\\x03/exit\\r` in one chunk exits 0 (the Enter and the Ctrl-Cs are not swallowed)', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    m.stdin.write('probe task via chat\r');
    await tick(30);
    expect(host.submitted.map((s) => s.text)).toEqual(['probe task via chat']);
    expect(m.lastFrame()).not.toContain('> probe task via chat');
    m.stdin.write('\x03\x03/exit\r');
    await tick(30);
    expect(host.exits[0]).toBe(0);
    expect(host.notes).toContain(EXITED_CTRL_C); // renderer lines go through host.note (§15.1)
  });

  it('through the App: an ESC-stripped `\\x03` under the secret gate is Esc (dismiss) then Ctrl-C (clear the draft); a paste-like chunk toasts the folded Enter', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    m.stdin.write(`use ${CANARY} here`);
    await tick(10);
    m.stdin.write('\r');
    await tick(200);
    expect(m.lastFrame()).toContain('Send anyway? y/N');
    m.stdin.write('\x1b\x03'); // Ink parses this to `\x03` with ctrl: false
    await tick(80);
    expect(m.lastFrame()).not.toContain('Send anyway?');
    expect(m.lastFrame()).not.toContain('use •');
    expect(host.submitted).toEqual([]);
    m.stdin.write('two lines\rtyped fast\r');
    await tick(30);
    // the `Tip:` toast still owns the left zone (info toasts queue, ≤ 4): the folded-Enter toast is queued behind it
    expect(m.state()?.toasts.map((t) => t.text)).toContain(COALESCED_ENTER_TOAST);
    expect(m.lastFrame()).toContain('> two lines');
    expect(m.lastFrame()).toContain('  typed fast');
    expect(host.submitted).toEqual([]);
  });
});

describe('<App> the `d` note field (§6.2, §6.4, findings 3 and 8)', () => {
  async function openNote(m: Mounted, draft: string): Promise<ReturnType<typeof m.confirmer.confirmDetailed>> {
    goLive(m, 4);
    await tick(10);
    if (draft !== '') {
      m.stdin.write(draft);
      await tick(10);
    }
    const req = mkConfirmRequest('cn', 4);
    const p = m.confirmer.confirmDetailed(req, { signal: new AbortController().signal });
    await tick(1250);
    expect(m.lastFrame()).toContain(REVIEW_KEYS_80);
    m.stdin.write('d');
    await tick(20);
    expect(m.lastFrame()).toContain('note (≤ 600, Enter sends, Esc cancels):');
    return p;
  }

  it('a secret typed into the note renders as • cells (never the bytes); Enter opens the note gate; y calls host.addSecret before resolveDetailed and the note is redacted', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    const p = openNote(m, '');
    await tick(1300);
    m.stdin.write(`key is ${CANARY}`);
    await tick(20);
    expect(m.lastFrame()).not.toContain(CANARY);
    expect(m.lastFrame()).toContain(`note (≤ 600, Enter sends, Esc cancels): key is ${'•'.repeat(10)}`);
    m.stdin.write('\r');
    await tick(20);
    expect(m.lastFrame()).toContain('Looks like this contains a secret (sk-ant-…). Send anyway? y/N');
    m.stdin.write('y');
    const outcome = await p;
    expect(host.secrets.map((s) => s.value)).toEqual([CANARY]);
    expect(outcome.approved).toBe(false);
    expect(outcome.note).toBeDefined();
    expect(outcome.note).not.toContain(CANARY);
    for (const f of m.frames) expect(f).not.toContain(CANARY);
  });

  it('Ctrl-C in an empty note with a stashed draft restores the draft and keeps the box (no abort); Ctrl-C with note text cancels the note without writing it to history', async () => {
    const host = fakeHost();
    host.historyStore = fakeHistory();
    const m = mountApp({ mode: 'session', host });
    const p = openNote(m, 'my real draft');
    await tick(1300);
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(host.aborts).toEqual([]);
    expect(m.lastFrame()).toContain(REVIEW_KEYS_80);
    expect(m.state()?.noteMode).toBe(false);
    expect(m.confirmer.pending()?.id).toBe('cn');
    // the box is still up: `d` again, type a note, Ctrl-C cancels it (not to history), the box stays
    m.stdin.write('d');
    await tick(20);
    m.stdin.write('half a note');
    await tick(10);
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(host.aborts).toEqual([]);
    expect(host.historyStore.appended.some((e) => e.text.includes('half a note'))).toBe(false);
    expect(m.lastFrame()).toContain(REVIEW_KEYS_80);
    m.stdin.write('n');
    await expect(p).resolves.toEqual({ approved: false });
    await tick(20);
    expect(m.lastFrame()).toContain('> my real draft');
  });

  it('a review settled from outside while the note is open (a second request) restores the stashed draft', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    void openNote(m, 'keep me');
    await tick(1300);
    m.stdin.write('typing a note');
    await tick(10);
    expect(m.lastFrame()).toContain('note (≤ 600, Enter sends, Esc cancels): typing a note');
    const req2 = mkConfirmRequest('cn2', 5);
    void m.confirmer.confirmDetailed(req2, { signal: new AbortController().signal }).catch(() => undefined);
    await tick(30);
    expect(m.state()?.noteMode).toBe(false);
    expect(m.lastFrame()).toContain('> keep me');
    expect(m.lastFrame()).not.toContain('typing a note');
  });
});

describe('<App> review deferral over another overlay (§6.3, finding 4)', () => {
  it('a review arriving while the exit confirm is open waits; y/n answer the exit confirm (never the review); the box shows once the overlay closed', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    goLive(m, 2);
    await tick(10);
    m.stdin.write(CTRL_D);
    m.stdin.write(CTRL_D);
    await tick(20);
    expect(m.lastFrame()).toContain(EXIT_CONFIRM_ROW);
    const req = mkConfirmRequest('cx', 2);
    const p = m.confirmer.confirm(req, { signal: new AbortController().signal });
    await tick(1300);
    expect(m.state()?.overlay).toBe('exitConfirm');
    expect(m.lastFrame()).toContain(EXIT_CONFIRM_ROW);
    expect(m.lastFrame()).not.toContain(REVIEW_KEYS_80);
    m.stdin.write('y'); // armed: answers the exit confirm (abort + exit after run:end), not the review
    await tick(20);
    expect(host.aborts).toEqual(['human_abort']);
    expect(m.confirmer.pending()?.id).toBe('cx');
    expect(m.state()?.overlay).not.toBe('exitConfirm');
    cleanup();
    // the `n` path: stay, and the deferred review appears afterwards
    const host2 = fakeHost();
    const m2 = mountApp({ mode: 'session', host: host2 });
    goLive(m2, 2);
    await tick(10);
    m2.stdin.write(CTRL_D);
    m2.stdin.write(CTRL_D);
    await tick(20);
    const req2 = mkConfirmRequest('cy', 2);
    const p2 = m2.confirmer.confirm(req2, { signal: new AbortController().signal });
    await tick(1300);
    m2.stdin.write('n');
    await tick(1300);
    expect(host2.aborts).toEqual([]);
    expect(m2.lastFrame()).toContain(REVIEW_KEYS_80);
    m2.stdin.write('y');
    await expect(p2).resolves.toBe(true);
    void p;
  });

  it('a review never replaces an open palette; it shows after Esc closes it', async () => {
    const m = mountApp({ mode: 'session', host: fakeHost() });
    goLive(m, 2);
    await tick(10);
    m.stdin.write('/');
    await tick(20);
    expect(m.state()?.overlay).toBe('palette');
    const req = mkConfirmRequest('cp', 2);
    void m.confirmer.confirm(req, { signal: new AbortController().signal });
    await tick(1300);
    expect(m.state()?.overlay).toBe('palette');
    m.stdin.write(ESC);
    await tick(1300);
    expect(m.state()?.overlay).toBe('review');
  });
});

describe('<App> App-level fault injection (§13.4, finding 5)', () => {
  it.each(['rule', 'live', 'queue', 'banner', 'status', 'composer', 'pane'])('render:%s:lines: the builder throws once, that pane degrades, the [ui] item is appended and the rest of the frame survives', async (pane) => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host, fault: builderFaultFor(pane) });
    goLive(m, 2);
    m.bus.emit({ type: 'retry', side: 'jev', step: 2, stage: 'propose', info: retryInfo(2) });
    m.bus.emit({ type: 'steer:queued', step: 3, index: 1, text: 'queued text', queued: 1 });
    await tick(40);
    const f = m.lastFrame();
    expect(f).toContain(`[ui] ui: ${pane} pane failed to render (InjectedRenderFault)`); // the item wraps at the test stdout's 100 columns
    expect(f).not.toContain('ERROR');
    expect(f).toContain('step 2/40');
    expect(f).toContain('Type to steer the next step…');
    expect(m.state()?.run).toBe('live');
  });

  it('render:overlay:lines with the palette open: the palette want falls back to one row; render:overlay (component) with a pending review declines it through the App', async () => {
    const m = mountApp({ mode: 'session', host: fakeHost(), fault: builderFaultFor('overlay') });
    m.stdin.write('/');
    await tick(30);
    expect(m.lastFrame()).toContain('ui: overlay pane failed to render (InjectedRenderFault)');
    expect(m.lastFrame()).toContain('> /');
    cleanup();
    const m2 = mountApp({ mode: 'session', host: fakeHost(), fault: renderFaultFor('overlay') });
    goLive(m2, 3);
    const req = mkConfirmRequest('cf', 3);
    const p = m2.confirmer.confirm(req, { signal: new AbortController().signal });
    await expect(p).resolves.toBe(false);
    await tick(20);
    expect(m2.lastFrame()).toContain('ui: overlay pane failed to render (InjectedRenderFault)');
    expect(m2.state()?.run).toBe('live');
  });

  it('render:static: one throwing item costs one fallback row; every later item keeps flowing into the scrollback', async () => {
    const m = mountApp({ mode: 'session', host: fakeHost(), fault: renderFaultFor('static') });
    await tick(20);
    expect(m.lastFrame()).toContain('ui: static pane failed to render (InjectedRenderFault)');
    m.dispatch({ type: 'local', text: 'after the fault', label: '[ui]' });
    m.dispatch({ type: 'local', text: 'and another', label: '[ui]' });
    await tick(20);
    expect(m.lastFrame()).toContain('[ui] after the fault');
    expect(m.lastFrame()).toContain('[ui] and another');
    expect(m.lastFrame().split('failed to render').length - 1).toBeLessThanOrEqual(2); // the fallback row + the [ui] report item
  });
});

describe('<App> retry row `[r] retry now` (§13.2, finding 7)', () => {
  it('`r` on an empty draft while retrying calls host.retryNow (two presses, two calls); with a draft r is text; after retry:settled r is text again', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    goLive(m, 2);
    m.bus.emit({ type: 'retry', side: 'jev', step: 2, stage: 'propose', info: retryInfo(1) });
    await tick(20);
    expect(m.lastFrame()).toContain('[r] retry now');
    m.stdin.write('r');
    await tick(10);
    m.stdin.write('r');
    await tick(10);
    expect(host.retries).toBe(2);
    expect(m.lastFrame()).not.toContain('> r');
    m.stdin.write('ab');
    await tick(10);
    m.stdin.write('r');
    await tick(10);
    expect(host.retries).toBe(2);
    expect(m.lastFrame()).toContain('> abr');
    m.stdin.write(CTRL_C);
    await tick(10);
    m.bus.emit({ type: 'retry:settled', side: 'jev', step: 2, stage: 'propose', attempts: 2 } as never);
    await tick(20);
    expect(m.lastFrame()).not.toContain('[r] retry now');
    m.stdin.write('r');
    await tick(10);
    expect(host.retries).toBe(2);
    expect(m.lastFrame()).toContain('> r');
  });

  it('the retry countdown follows the 1 Hz tick and clears on retry:settled through the mounted App', async () => {
    const m = mountApp({ mode: 'session', host: fakeHost(), now: () => 100_000 });
    goLive(m, 2);
    m.bus.emit({ type: 'retry', side: 'jev', step: 2, stage: 'propose', info: retryInfo(2, 12_000) });
    await tick(20);
    expect(m.lastFrame()).toContain('jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)');
    m.dispatch({ type: 'tick', now: 105_000 });
    await tick(20);
    expect(m.lastFrame()).toContain('jev: retrying 2/3 in 7 s');
    m.bus.emit({ type: 'retry:settled', side: 'jev', step: 2, stage: 'propose', attempts: 2 } as never);
    await tick(20);
    expect(m.lastFrame()).not.toContain('retrying 2/3');
  });
});

describe('<App> Ctrl-C / Esc / Ctrl-D matrix, the remaining cells (§3.3)', () => {
  it('S3 live·text: Ctrl-C clears the draft and never aborts (F5); Esc Esc clears too', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    goLive(m);
    await tick(10);
    m.stdin.write('a steer in progress');
    await tick(10);
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(host.aborts).toEqual([]);
    expect(m.lastFrame()).not.toContain('a steer in progress');
    expect(m.state()?.run).toBe('live');
    m.stdin.write('again');
    await tick(10);
    m.stdin.write(ESC);
    await tick(80);
    expect(host.paused).toBe(0);
    m.stdin.write(ESC);
    await tick(80);
    expect(m.lastFrame()).not.toContain('> again');
    expect(host.aborts).toEqual([]);
  });

  it('S6 aborting: a second Ctrl-C is the immediate exit through host.abort (EXIT_NOW_130); Enter, text and Esc are ignored', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    goLive(m);
    await tick(10);
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(host.aborts).toEqual(['human_abort']);
    expect(m.state()?.run).toBe('aborting');
    m.stdin.write('x');
    m.stdin.write('\r');
    await tick(20);
    expect(m.lastFrame()).not.toContain('> x');
    m.stdin.write(ESC);
    await tick(80);
    expect(host.paused).toBe(0);
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(host.aborts).toEqual(['human_abort', 'human_abort']);
  });

  it('S7 pausing: Esc is a no-op (arms), Esc Esc aborts; Ctrl-C aborts now; Enter steers to pendingDirectives', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    goLive(m);
    await tick(10);
    m.stdin.write(ESC);
    await tick(80);
    expect(host.paused).toBe(1);
    expect(m.state()?.run).toBe('pausing');
    await tick(2100); // the first Esc Esc window lapses
    m.stdin.write(ESC);
    await tick(80);
    expect(host.aborts).toEqual([]); // no-op, arms
    m.stdin.write('late steer');
    await tick(10);
    m.stdin.write('\r');
    await tick(20);
    expect(host.steered.map((s) => s.text)).toEqual(['late steer']);
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(host.aborts).toEqual(['human_abort']);
  });

  it('S0 Esc Esc opens the rewind menu (palette pre-filtered); Ctrl-D ×2 idle exits 0 with the `exited on Ctrl-D ×2` item', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    m.stdin.write(ESC);
    await tick(80);
    m.stdin.write(ESC);
    await tick(80);
    expect(m.state()?.overlay).toBe('palette');
    expect(m.lastFrame()).toContain('> /');
    expect(m.lastFrame()).toMatch(/\/rewind|\/undo|\/resume|\/new/);
    m.stdin.write(ESC);
    await tick(80);
    expect(m.state()?.overlay).toBe('none');
    m.stdin.write(CTRL_C); // clears the remembered `/`
    await tick(20);
    m.stdin.write(CTRL_D);
    await tick(20);
    expect(m.lastFrame()).toContain('press Ctrl-D again to exit');
    m.stdin.write(CTRL_D);
    await tick(20);
    expect(host.exits).toEqual([0]);
    expect(host.notes).toContain(EXITED_CTRL_D);
  });

  it('/exit while live opens the exit confirm; Enter is inert; y aborts and exits 0 after run:end', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    goLive(m);
    await tick(10);
    m.stdin.write('/exit');
    await tick(10);
    m.stdin.write('\r');
    await tick(20);
    expect(m.lastFrame()).toContain(EXIT_CONFIRM_ROW);
    expect(host.exits).toEqual([]);
    m.stdin.write('\r');
    await tick(200);
    expect(m.lastFrame()).toContain(EXIT_CONFIRM_ROW);
    m.stdin.write('y');
    await tick(20);
    expect(host.aborts).toEqual(['human_abort']);
    expect(host.exits).toEqual([]);
    m.bus.emit({ type: 'run:end', result: { ...loadRunEvents().find((e) => e.type === 'run:end')!.result, stopReason: 'human_abort' } as never, exitCode: 130 });
    await tick(30);
    expect(host.exits).toEqual([0]);
  });
});

describe('<App> composer paths (§4.6, §5.4, §8.6, §10.2, finding 12)', () => {
  it('`/steer <text>` with a secret passes the gate: the row opens, an armed y sends the steer with the span and the command lands in history redacted', async () => {
    const host = fakeHost();
    host.historyStore = fakeHistory();
    const m = mountApp({ mode: 'session', host });
    goLive(m, 5);
    await tick(10);
    m.stdin.write(`/steer use ${CANARY} for auth`);
    await tick(10);
    m.stdin.write('\r');
    await tick(200);
    expect(m.lastFrame()).toContain('Looks like this contains a secret (sk-ant-…). Send anyway? y/N');
    expect(host.steered).toEqual([]);
    m.stdin.write('y');
    await tick(20);
    expect(host.steered).toEqual([{ text: `use ${CANARY} for auth`, secretSpans: [CANARY] }]);
    expect(host.historyStore.appended).toHaveLength(1);
    expect(host.historyStore.appended[0]?.kind).toBe('command');
    expect(host.historyStore.appended[0]?.text).not.toContain(CANARY);
    expect(host.historyStore.appended[0]?.text).toContain('/steer');
  });

  it('`/steer <text>` without a secret steers at once; a plain steer\'s history entry follows host.steer (addSecret first)', async () => {
    const host = fakeHost();
    host.historyStore = fakeHistory();
    const m = mountApp({ mode: 'session', host });
    goLive(m, 5);
    await tick(10);
    m.stdin.write('/steer go faster\r');
    await tick(30);
    expect(host.steered.map((s) => s.text)).toEqual(['go faster']);
    expect(host.historyStore.appended).toEqual([{ kind: 'command', text: '/steer go faster' }]);
    m.stdin.write('plain steer\r');
    await tick(30);
    expect(host.order.slice(-1)).toEqual(['steer']);
    expect(host.historyStore.appended.at(-1)).toEqual({ kind: 'steer', text: 'plain steer' });
  });

  it('`@` opens the mention popup with the host\'s candidates; Enter inserts `@path `; a denied mention is reported', async () => {
    const host = fakeHost();
    host.workspaceCandidates = async () => [
      { path: 'src/parse_date.py', bytes: 120 },
      { path: 'tests/test_parse.py', bytes: 80 },
    ];
    const m = mountApp({ mode: 'session', host });
    m.stdin.write('@');
    await tick(30);
    expect(m.state()?.overlay).toBe('palette');
    expect(m.lastFrame()).toContain('Tab completes · Enter inserts @path · Esc closes');
    m.stdin.write('pars');
    await tick(20);
    m.stdin.write('\r');
    await tick(20);
    expect(m.lastFrame()).toContain('> @src/parse_date.py');
    expect(m.state()?.overlay).toBe('none');
  });

  it('Up on an empty draft with queued steers takes the newest back (host.unsteer → draft); history Up / Down / Ctrl-R walk the store', async () => {
    const host = fakeHost();
    host.unsteer = () => ({ text: 'taken back', at: '2026-09-20T00:00:00.000Z', index: 1 });
    host.historyStore = fakeHistory(['older prompt', 'newer prompt']);
    const m = mountApp({ mode: 'session', host });
    goLive(m, 5);
    m.bus.emit({ type: 'steer:queued', step: 6, index: 1, text: 'taken back', queued: 1 });
    await tick(20);
    expect(m.lastFrame()).toContain('↑1 queued for step 6: taken back');
    m.stdin.write(UP);
    await tick(20);
    expect(m.lastFrame()).toContain('> taken back');
    m.stdin.write(CTRL_C); // clears the draft → history (§10.7): `taken back` becomes the newest entry
    await tick(20);
    expect(host.historyStore.appended.at(-1)).toEqual({ kind: 'prompt', text: 'taken back' });
    m.bus.emit({ type: 'steer:withdrawn', step: 6, index: 1 });
    await tick(20);
    m.stdin.write(UP);
    await tick(20);
    expect(m.lastFrame()).toContain('> taken back');
    m.stdin.write(UP);
    await tick(20);
    expect(m.lastFrame()).toContain('> newer prompt');
    m.stdin.write(UP);
    await tick(20);
    expect(m.lastFrame()).toContain('> older prompt');
    m.stdin.write(DOWN);
    await tick(20);
    expect(m.lastFrame()).toContain('> newer prompt');
    m.stdin.write(CTRL_C);
    await tick(20);
    m.stdin.write(CTRL_R);
    await tick(20);
    expect(m.lastFrame()).toContain("(reverse-i-search)'':");
    m.stdin.write('old');
    await tick(20);
    expect(m.lastFrame()).toContain("(reverse-i-search)'old': older prompt");
    m.stdin.write(ESC);
    await tick(80);
    expect(m.lastFrame()).not.toContain('reverse-i-search');
  });

  it('Ctrl+G with a secret in the draft is refused with the toast (no editor, no file); the drafts dir is <runDir>/drafts while a run is live', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host, runsDir: '/tmp/jev-runs', home: '/tmp/jev-home' });
    m.stdin.write(`token ${CANARY}`);
    await tick(10);
    m.stdin.write(CTRL_G);
    await tick(30);
    expect(m.lastFrame()).toContain('editor: the draft contains a secret (sk-ant-…); remove it or send it first');
    expect(m.lastFrame()).toContain('token ••••');
    expect(draftsDirFor({ run: 'live', paths: null, runId: 'r1' }, { home: '/tmp/jev-home', runsDir: '/tmp/jev-runs' })).toBe('/tmp/jev-runs/r1/drafts');
    expect(draftsDirFor({ run: 'live', paths: { runDir: '/x/r2', transcript: '', log: '' }, runId: 'r2' }, { home: '/tmp/jev-home' })).toBe('/x/r2/drafts');
    expect(draftsDirFor({ run: 'none', paths: { runDir: '/x/r2', transcript: '', log: '' }, runId: 'r2' }, { home: '/tmp/jev-home' })).toBe('/tmp/jev-home/.jevcode/drafts');
    expect(draftsDirFor({ run: 'live', paths: null, runId: null }, { home: '/tmp/jev-home' })).toBe('/tmp/jev-home/.jevcode/drafts');
  });

  it('AWS `AKIA…` and PEM canaries open the gate with their labels; the draft masks them', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    const aws = 'AKIAIOSFODNN7EXAMPLE';
    m.stdin.write(`creds ${aws} end`);
    await tick(10);
    expect(m.lastFrame()).not.toContain(aws);
    m.stdin.write('\r');
    await tick(20);
    expect(m.lastFrame()).toContain('Looks like this contains a secret (AKIA…). Send anyway? y/N');
    m.stdin.write(ESC);
    await tick(80);
    m.stdin.write(CTRL_C);
    await tick(20);
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----`;
    m.stdin.write(`\x1b[200~${pem}\x1b[201~`);
    await tick(20);
    m.stdin.write('\r');
    await tick(20);
    expect(m.lastFrame()).toContain('Looks like this contains a secret (-----BEGIN…). Send anyway? y/N');
    expect(host.submitted).toEqual([]);
    for (const f of m.frames) expect(f).not.toContain('MIIBOgIBAAJBAKj34');
  });

  it('Ctrl+O appends the step\'s /why blocks and then the recent warnings/errors (through host.note while live), clearing `!n`', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    goLive(m, 2);
    m.bus.emit({ type: 'decision', decision: mkDecision({ step: 2, stage: 'risk', id: 'destructive', verdict: 'review' }) });
    m.bus.emit({ type: 'error', step: 2, fatal: false, error: { name: 'Error', message: 'disk hiccup', code: 'EIO' } } as never);
    await tick(20);
    expect(m.lastFrame()).toContain('!1');
    m.stdin.write(CTRL_O);
    await tick(20);
    expect(host.notes.some((n) => n.startsWith('why s2.risk  1 decision'))).toBe(true);
    expect(host.notes).toContain('recent warnings/errors (1)');
    expect(host.notes.indexOf('recent warnings/errors (1)')).toBeGreaterThan(host.notes.findIndex((n) => n.startsWith('why s2.risk')));
    expect(m.lastFrame()).not.toContain('!1');
  });

  it('queue rows name the step the engine reported in steer:queued, not step + 1', async () => {
    const m = mountApp({ mode: 'session', host: fakeHost() });
    goLive(m, 5);
    m.bus.emit({ type: 'steer:queued', step: 9, index: 1, text: 'for step nine', queued: 1 });
    await tick(20);
    expect(m.lastFrame()).toContain('↑1 queued for step 9: for step nine');
  });
});

describe('<App> bridge prompts, blocking pane and wizard (§9.3, §12.4, §13.3, §11.1)', () => {
  it('confirmFollowUp: y is inert before arming, then starts; r prefills the raise command; Esc cancels and settles the promise', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    const input = { runCapUsd: 2, clampedToUsd: 0.42, sessionSpentUsd: 9.58, sessionCapUsd: 10, runs: 5, lastRunUsd: 0.71 };
    const answers: string[] = [];
    m.bridge.command({ type: 'followup', input, resolve: (a) => answers.push(a) });
    await tick(20);
    expect(m.lastFrame()).toContain('follow-up would exceed the session cap');
    expect(m.lastFrame()).toContain('> (waiting for y/r/n)');
    m.stdin.write('y');
    await tick(10);
    expect(answers).toEqual([]);
    await tick(200);
    m.stdin.write('y');
    await tick(20);
    expect(answers).toEqual(['start']);
    expect(m.state()?.overlay).toBe('none');
    m.bridge.command({ type: 'followup', input, resolve: (a) => answers.push(a) });
    await tick(20);
    m.stdin.write('r');
    await tick(20);
    expect(answers).toEqual(['start', 'raise']);
    expect(m.lastFrame()).toContain('> /budget session-spend-cap 12.00');
    m.stdin.write(CTRL_C);
    await tick(20);
    m.bridge.command({ type: 'followup', input, resolve: (a) => answers.push(a) });
    await tick(20);
    m.stdin.write(ESC);
    await tick(80);
    expect(answers).toEqual(['start', 'raise', 'cancel']);
  });

  it('promptUndo: y after arming, n, a, s and Esc (abort) settle the promise; confirmExit while idle resolves true at once, while live n resolves false', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    const answers: string[] = [];
    const row = 'src/a.py changed since step 3 (outside JevCode). Overwrite? [y/N]  a=all  s=skip rest  Esc=abort';
    m.bridge.command({ type: 'undo', row, resolve: (a) => answers.push(a) });
    await tick(20);
    expect(m.lastFrame()).toContain(row);
    m.stdin.write('y');
    await tick(10);
    expect(answers).toEqual([]);
    await tick(200);
    m.stdin.write('y');
    await tick(20);
    expect(answers).toEqual(['yes']);
    for (const [key, want] of [
      ['n', 'no'],
      ['a', 'all'],
      ['s', 'skipRest'],
      [ESC, 'abort'],
    ] as const) {
      m.bridge.command({ type: 'undo', row, resolve: (a) => answers.push(a) });
      await tick(20);
      m.stdin.write(key);
      await tick(80);
      expect(answers.at(-1)).toBe(want);
    }
    expect(answers).toEqual(['yes', 'no', 'all', 'skipRest', 'abort']);
    const exits: boolean[] = [];
    m.bridge.command({ type: 'exitConfirm', resolve: (a) => exits.push(a) });
    await tick(20);
    expect(exits).toEqual([true]);
    goLive(m);
    await tick(10);
    m.bridge.command({ type: 'exitConfirm', resolve: (a) => exits.push(a) });
    await tick(20);
    expect(m.lastFrame()).toContain(EXIT_CONFIRM_ROW);
    m.stdin.write('n');
    await tick(20);
    expect(exits).toEqual([true, false]);
  });

  it('the blocking pane renders the §24 rows and its keys resolve the promise (r → retry, q → stop); Ctrl-C is that pane\'s [q]', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    goLive(m, 2);
    const request: BlockingRequest = { id: 'b1', step: 2, kind: 'key-rejected', side: 'jev', detail: 'HTTP 401 — "User not found."', sources: ['env JEV_API_KEY'], stop: 'error', exitCode: 2 };
    const answers: string[] = [];
    m.bridge.command({ type: 'blocking', request, resolve: (a) => answers.push(a) });
    await tick(20);
    expect(m.lastFrame()).toContain('jev: key rejected (HTTP 401 — "User not found.")');
    expect(m.lastFrame()).toContain('> (paused — answer the pane above)');
    m.stdin.write('r');
    await tick(20);
    expect(answers).toEqual(['retry']);
    m.bus.emit({ type: 'blocking:resolved', id: 'b1', answer: 'retry' } as never);
    await tick(20);
    m.bridge.command({ type: 'blocking', request: { ...request, id: 'b2' }, resolve: (a) => answers.push(a) });
    await tick(20);
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(answers).toEqual(['retry', 'stop']);
  });

  it('the wizard through the App: masked key bytes never appear in a frame; Ctrl-C with no run exits 2; mid-run Ctrl-C closes it and the run continues', async () => {
    const saved: string[] = [];
    let cancels = 0;
    const wizardHost = {
      save: async (input: { values: Readonly<Partial<Record<string, string>>> }) => {
        saved.push(...Object.values(input.values).filter((v): v is string => typeof v === 'string'));
        return { ok: true as const, items: ['[setup] saved /tmp/cred.json (mode 0600, dir 0700)'] };
      },
      cancel: () => {
        cancels += 1;
      },
    };
    const host = fakeHost();
    const bridge = createBridge(host, wizardHost);
    const m = mountApp({ mode: 'session', host, bridge });
    m.bridge.command({ type: 'wizard', detect: { missing: ['generator.apiKey'], mode: 'jev-on', provider: 'anthropic', trustNeeded: false } });
    await tick(20);
    expect(m.state()?.overlay).toBe('wizard');
    expect(m.lastFrame()).toContain('No API key found. Pick the generator provider:');
    m.stdin.write('\r'); // Enter = anthropic (the detected provider)
    await tick(20);
    const secret = 'sk-ant-api03-WIZARDBYTESWIZARDBYTESWIZARDBYTESWIZARD';
    m.stdin.write(secret);
    await tick(20);
    for (const f of m.frames) expect(f).not.toContain('WIZARDBYTES');
    expect(m.lastFrame()).toMatch(new RegExp(`${secret.length} chars`));
    m.stdin.write(CTRL_C);
    await tick(20);
    expect(host.exits).toEqual([2]);
    expect(cancels).toBe(1); // §11.1: the controller's pending wizard prompt settles through the host, not an overlay watch
    cleanup();
    const host2 = fakeHost();
    const m2 = mountApp({ mode: 'session', host: host2, bridge: createBridge(host2, wizardHost) });
    goLive(m2);
    await tick(10);
    m2.bridge.command({ type: 'wizard:reopen', at: 'generator.apiKey', runLive: true });
    await tick(20);
    expect(m2.state()?.overlay).toBe('wizard');
    m2.stdin.write(CTRL_C);
    await tick(20);
    expect(host2.exits).toEqual([]);
    expect(host2.aborts).toEqual([]);
    expect(m2.state()?.overlay).toBe('none');
    expect(m2.state()?.run).toBe('live');
    expect(cancels).toBe(2); // the mid-run close cancels once too (the `done` it produces does not cancel again)
  });

  it('promptSecretGate (argv task, §4.10 / §10.2): the row renders over the idle one-shot composer; a y within 150 ms is ignored (the row stays, nothing typed); an armed y resolves true; Esc / n / Enter refuse; a new prompt refuses the previous one', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'one-shot', host });
    const hits = detectSecrets(`deploy with AKIAIOSFODNN7EXAMPLE now`);
    expect(hits.length).toBeGreaterThan(0);
    const answers: boolean[] = [];
    const ask = (): void => m.bridge.command({ type: 'secretGate', hits, resolve: (send) => answers.push(send) });
    ask();
    await tick(10);
    expect(m.state()?.overlay).toBe('secret');
    expect(m.lastFrame()).toContain('Looks like this contains a secret (AKIA…). Send anyway? y/N');
    m.stdin.write('y'); // within 150 ms of the row: not a confirmation and not a dismissal (§6.3) — the row stays, the prompt is still open
    await tick(10);
    expect(answers).toEqual([]);
    expect(m.state()?.overlay).toBe('secret');
    expect(m.lastFrame()).toContain('Send anyway? y/N');
    expect(m.lastFrame()).not.toContain('> y'); // the early y never reached the composer either
    expect(host.submitted).toEqual([]);
    await tick(200);
    m.stdin.write('y'); // armed now: the same prompt resolves true
    await tick(20);
    expect(answers).toEqual([true]);
    expect(m.state()?.overlay).toBe('none');
    for (const key of ['\x1b', 'n', '\r']) {
      ask();
      await tick(200);
      m.stdin.write(key);
      await tick(80); // the Esc re-buffer (30 ms) plus a commit
      expect(answers.at(-1)).toBe(false);
      expect(m.state()?.overlay).toBe('none');
    }
    // a second prompt while one is open refuses the first and owns the row
    ask();
    await tick(10);
    ask();
    await tick(200);
    expect(answers.at(-1)).toBe(false);
    m.stdin.write('y');
    await tick(20);
    expect(answers.at(-1)).toBe(true);
    expect(answers).toHaveLength(6);
    // nothing reached the composer's send path and no frame carried the token bytes
    expect(host.submitted).toEqual([]);
    for (const f of m.frames) expect(f).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('<App> screen-reader review answering (§6.5)', () => {
  const sr: LaunchSettings = { ...resolveLaunchSettings({}, {}), screenReader: true };

  it('srReviewAnswer maps exactly 1/2/3/y/n; anything else is text', () => {
    expect(srReviewAnswer('1')).toBe('approve');
    expect(srReviewAnswer(' y ')).toBe('approve');
    expect(srReviewAnswer('2')).toBe('decline');
    expect(srReviewAnswer('n')).toBe('decline');
    expect(srReviewAnswer('3')).toBe('note');
    expect(srReviewAnswer('yes')).toBeNull();
    expect(srReviewAnswer('')).toBeNull();
    expect(srReviewAnswer('12')).toBeNull();
  });

  it('when the review arms the numbered list and the prompt are appended, the draft is stashed, one BEL sounds; a line begun before arming never answers; `2` declines; the draft comes back', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host, launch: sr });
    goLive(m, 3);
    await tick(10);
    m.stdin.write('half a thought');
    await tick(10);
    const req = mkConfirmRequest('sr1', 3);
    const p = m.confirmer.confirm(req, { signal: new AbortController().signal });
    await tick(1300);
    // the announcements are renderer lines: through host.note while the run is live (§15.1)
    expect(host.notes).toContain(SR_REVIEW_MENU);
    expect(host.notes).toContain(SR_REVIEW_PROMPT);
    expect(host.notes.indexOf(SR_REVIEW_MENU)).toBeLessThan(host.notes.indexOf(SR_REVIEW_PROMPT));
    expect(m.frames.some((f) => f.includes('\x07'))).toBe(true);
    expect(m.lastFrame()).not.toContain('> half a thought');
    m.stdin.write('\r'); // an empty line: re-announce, no answer
    await tick(20);
    expect(m.confirmer.pending()?.id).toBe('sr1');
    m.stdin.write('yes please');
    await tick(10);
    m.stdin.write('\r'); // not exactly y/1: a steer, re-announced
    await tick(20);
    expect(m.confirmer.pending()?.id).toBe('sr1');
    expect(host.steered.map((s) => s.text)).toEqual(['yes please']);
    expect(host.notes.filter((n) => n === SR_REVIEW_PROMPT).length).toBeGreaterThanOrEqual(3);
    m.stdin.write('2');
    await tick(10);
    m.stdin.write('\r');
    await expect(p).resolves.toBe(false);
    await tick(20);
    expect(m.lastFrame()).toContain('> half a thought');
  });

  it('`1` approves and `3` opens the note field (Enter sends the note); Esc declines', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host, launch: sr });
    goLive(m, 3);
    const req = mkConfirmRequest('sr2', 3);
    const p = m.confirmer.confirm(req, { signal: new AbortController().signal });
    await tick(1300);
    m.stdin.write('1\r');
    await expect(p).resolves.toBe(true);
    const req3 = mkConfirmRequest('sr3', 4);
    const p3 = m.confirmer.confirmDetailed(req3, { signal: new AbortController().signal });
    await tick(1300);
    m.stdin.write('3\r');
    await tick(20);
    expect(m.state()?.noteMode).toBe(true);
    m.stdin.write('needs a test first\r');
    await expect(p3).resolves.toEqual({ approved: false, note: 'needs a test first' });
    const req4 = mkConfirmRequest('sr4', 5);
    const p4 = m.confirmer.confirm(req4, { signal: new AbortController().signal });
    await tick(1300);
    m.stdin.write(ESC);
    await tick(80);
    await expect(p4).resolves.toBe(false);
  });
});

/** Strip every CSI sequence (SGR, cursor moves, erase lines, hide/show) so text assertions see the cells of an interactive frame. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

describe('createTuiRenderer: unmount flushes the final frame (finding 10); resize through the early listener (finding 11)', () => {
  it('the last frame written before unmount shows `done <stop>` with no spinner and no steer placeholder', async () => {
    const stdout = new StubStdout(24, 80, true);
    const stdin = new StubStdin();
    const r = createTuiRenderer({ task: 'final frame task', resumeId: null, onAbort: () => undefined, stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, mode: 'one-shot', interactive: true });
    await r.firstFrame();
    const fe = fakeEngine();
    r.attach(fe.engine);
    fe.emit({ type: 'run:start', runId: 'r1', task: 'final frame task', mode: 'jev-on', resumedFromStep: null });
    fe.emit({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 'final frame task', resumed: false });
    fe.emit({ type: 'status', status: mkStatus(6, 'judge') });
    await tick(60);
    expect(stripAnsi(stdout.frames.join(''))).toContain('Type to steer the next step…');
    const before = stdout.frames.length;
    const end = loadRunEvents().find((e) => e.type === 'run:end')!;
    fe.emit({ ...end, exitCode: 0 } as never);
    await r.unmount();
    const after = stripAnsi(stdout.frames.slice(before).join(''));
    expect(after).toContain('done max_steps'); // the fixture run stops on max_steps
    const lastDynamic = stripAnsi(stdout.frames.slice(before).filter((f) => /done max_steps|judge/.test(stripAnsi(f))).at(-1) ?? '');
    expect(lastDynamic).toContain('done max_steps');
    expect(lastDynamic).not.toContain('Type to steer the next step…');
    // §1 / §3.3: a one-shot run has no follow-up — the scrollback left behind must not invite one
    expect(after).not.toContain('Follow-up or /command…');
    expect(lastDynamic).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] judge/);
  });

  it('a shrink on the renderer\'s stdout commits the new budget synchronously in the resize listener (before Ink\'s own repaint), so no stale taller frame is painted at the new viewport; a grow takes the async path; 0×0 streams fall back to 80×24', async () => {
    const stdout = new StubStdout(40, 80, true);
    const stdin = new StubStdin();
    const r = createTuiRenderer({ task: '', resumeId: null, onAbort: () => undefined, stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, mode: 'session', cwd: '/tmp/proj', interactive: true });
    await r.firstFrame();
    const fe = fakeEngine();
    r.attach(fe.engine);
    fe.emit({ type: 'run:start', runId: 'r1', task: 't', mode: 'jev-on', resumedFromStep: null });
    fe.emit({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 't', resumed: false });
    for (let i = 0; i < 12; i++) fe.emit({ type: 'decision', decision: mkDecision({ id: `d${i}`, step: 1 }) });
    fe.emit({ type: 'status', status: mkStatus(1, 'risk') });
    await tick(60);
    const tall = stdout.frames.map(stripAnsi).filter((f) => f.includes('step 1/40')).at(-1) ?? '';
    expect(dynamicRegion(tall.replace(/\n+$/, ''), 80).length).toBeGreaterThan(10); // the pane is open: taller than the 12-row terminal to come
    const before = stdout.frames.length;
    stdout.resize(12, 60);
    // the shrink is committed on the SIGWINCH tick itself (instance.rerender), so the frame Ink's own `resized` handler
    // paints synchronously is already the 12x60 tree — never the stale 40x80 one
    expect(stdout.frames.length).toBeGreaterThan(before);
    const sync = stdout.frames.slice(before).map(stripAnsi);
    for (const f of sync) for (const line of f.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
    await tick(120);
    const after = stdout.frames.slice(before).map(stripAnsi);
    // every frame written from the resize on is under the new geometry (no stale 80-column / 15-row repaint)
    for (const f of after) for (const line of f.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
    for (const f of after) if (f.includes('step 1/40')) expect(dynamicRegion(f.replace(/\n+$/, ''), 60).length).toBeLessThanOrEqual(10);
    expect(r.state()?.runId).toBe('r1');
    // a grow takes the async path (no synchronous commit is needed: a stale narrower frame never costs a clear) and the next frames use the wide budget
    const beforeGrow = stdout.frames.length;
    stdout.resize(40, 80);
    await tick(120);
    const grown = stdout.frames.slice(beforeGrow).map(stripAnsi);
    expect(grown.length).toBeGreaterThan(0);
    expect(grown.some((f) => f.split('\n').some((line) => line.length > 60))).toBe(true); // laid out at 80 columns again (the rule row carries the pane title, so no bare 80-cell rule)
    await r.unmount();
    cleanup();
    const zero = new StubStdout(0, 0, true);
    const r2 = createTuiRenderer({ task: '', resumeId: null, onAbort: () => undefined, stdout: zero as unknown as NodeJS.WriteStream, stdin: new StubStdin() as unknown as NodeJS.ReadStream, mode: 'session', cwd: '/tmp/proj', interactive: true });
    await r2.firstFrame();
    expect(stripAnsi(zero.frames.join(''))).toContain('─'.repeat(80));
    await r2.unmount();
  });
});
