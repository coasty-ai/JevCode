/**
 * The mounted-App harness shared by `app.test.tsx` and `round2-app.test.tsx` (TUI-DESIGN §19.3; TUI-DESIGN-2 §8.1 S4):
 * `mountApp` mounts `<App>` through ink-testing-library (real key parsing, `debug` frames = static + dynamic in one
 * string, the bridge's `stateReader`), `fakeHost` is an in-memory `SessionHost` recording every call, `goLive` emits
 * `run:start` · `run:ready` · `status`, and `waitFor` polls a predicate (Ink commits on its own throttle, so a fixed
 * `tick(20)` after a key races the frame — TUI-DESIGN-2 §13 finding 7).
 */
import { render } from 'ink-testing-library';
import type { HistoryStore, LaunchSettings, RetryInfo, SecretHit, SessionHost, SteerResult } from '../../../src/core/types.js';
import { App, createBridge, type AppProps, type Bridge } from '../../../src/tui/App.js';
import { createEventBus, createTuiConfirmer, type UiAction, type UiState } from '../../../src/tui/useEngine.js';
import { detectSecrets, patternRedact } from '../../../src/core/redact.js';
import { mkStatus } from '../../fixtures/tui/fixtures.js';

export const ESC = '\x1b';
export const CTRL_C = '\x03';
export const CTRL_D = '\x04';
export const CTRL_G = '\x07';
export const CTRL_O = '\x0f';
export const CTRL_R = '\x12';
export const UP = '\x1b[A';
export const DOWN = '\x1b[B';
export const CANARY = `sk-ant-api03-${'A'.repeat(40)}`;

/** An in-memory `HistoryStore` recording every append (kind + text). */
export interface FakeHistory extends HistoryStore {
  appended: { kind: string; text: string }[];
  list: string[];
}

export function fakeHistory(entries: readonly string[] = []): FakeHistory {
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

export interface FakeHost extends SessionHost {
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

export function fakeHost(): FakeHost {
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

export interface Mounted {
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

export interface MountOptions {
  mode?: 'session' | 'one-shot';
  task?: string;
  host?: FakeHost | null;
  now?: () => number;
  fault?: string;
  launch?: LaunchSettings;
  bridge?: Bridge;
  runsDir?: string;
  home?: string;
  /**
   * TUI-DESIGN-5 §6.4 / §5.2 (R5-4's shared-shell wave): the two seams the mounted round-5 surfaces take. Both
   * are **optional and absent by default**, so every existing case mounts exactly the tree it did before; with
   * them supplied `<App>` does no `await import()` at all, which is what keeps `round5-shell-app.test.tsx`
   * offline and free of `src/models/**` / `src/import/**` module side effects.
   */
  models?: AppProps['models'];
  instantModels?: AppProps['instantModels'];
  importEngine?: AppProps['importEngine'];
  applyImport?: AppProps['applyImport'];
  env?: NodeJS.ProcessEnv;
}

/** Mount through ink-testing-library: real key parsing, `debug` frames (static + dynamic in one string). */
export function mountApp(opts: MountOptions = {}): Mounted {
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
      {...(opts.models !== undefined ? { models: opts.models } : {})}
      {...(opts.instantModels !== undefined ? { instantModels: opts.instantModels } : {})}
      {...(opts.importEngine !== undefined ? { importEngine: opts.importEngine } : {})}
      {...(opts.applyImport !== undefined ? { applyImport: opts.applyImport } : {})}
      {...(opts.env !== undefined ? { env: opts.env } : {})}
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

export const retryInfo = (attempt: number, waitMs = 12_000): RetryInfo => ({ attempt, maxAttempts: 3, waitMs, retryAfter: true, cause: { kind: 'http', status: 429, code: null, message: 'rate limited' } });

export function stripSgr(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Dynamic region = everything from the last rule row onwards (the <Static> scrollback sits above it). */
export function dynamicLines(frame: string): string[] {
  const lines = frame.split('\n');
  const idx = lines.map((l) => /^[─-]{3,}/.test(l.trim()) && /[─-]{2,}$/.test(l.trim())).lastIndexOf(true);
  return lines.slice(idx);
}

export function goLive(m: Mounted, step = 1): void {
  m.bus.emit({ type: 'run:start', runId: 'r1', task: 'Fix the failing test', mode: 'jev-on', resumedFromStep: null });
  m.bus.emit({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 'Fix the failing test', resumed: false });
  m.bus.emit({ type: 'status', status: mkStatus(step, 'propose') });
}

/**
 * Poll `pred` every 5 ms until it holds (or `timeoutMs` passes — the caller's next `expect` then reports the real state).
 * Used where a frame or a reducer flag follows a key on Ink's own schedule (the review arm, the note field, a toast).
 */
export async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return pred();
}
