/**
 * The `--plain` line composer (TUI-DESIGN §1, §4.9, §5.2, §10.2, §13.4, §14.2): `node:readline` over a
 * TTY in cooked mode (`terminal: false`, DESIGN §10), prompt `> `. Enter submits while idle and steers
 * while a run is live through the `SessionHost`; slash commands go through the same `dispatchCommand()`
 * as the Ink composer (a `/` token that matches nothing never submits); every text — and every command
 * line — passes the secret gate (`detectSecrets` → the readline twin of the y/N row) before `submit`/
 * `steer`/`command`; history rides the host's `HistoryStore` and is appended only after the host call
 * returned (the host's `addSecret` ran, so the store's redactor masks an acknowledged span, §10.2).
 *
 * One readline interface per stdin (§1, §6.5): the composer owns it and lends its `'line'` stream to the
 * readline confirmer through `lines` (a `LineSource`); while lent, lines go to the borrower and the
 * composer shows no prompt. Cooked mode delivers SIGINT itself, so Ctrl-C follows the F5 matrix here
 * (live → abort and stay; idle → `press Ctrl-C again to exit`, a second within 1.5 s → exit 0) and EOF
 * (`close`) is the Ctrl-D rule (idle → exit 0; live → abort, exit 0 after `run:end`; aborting → exit 0
 * after `run:end` without a second abort). Nothing here reads `process.*` unless the caller leaves the
 * defaults.
 */
import { createInterface, type Interface } from 'node:readline';
import type { SecretHit, SessionHost } from '../core/types.js';
import { dispatchCommand, type CommandAction, type DispatchContext } from './commands/dispatch.js';
import { isCommandLine } from './commands/parse.js';
import type { CommandSpec } from './commands/registry.js';
import { routeSend, secretSpans, type SubmitDecision, deniedMentionNotice } from './composer/submit.js';
import type { KeyRunPhase } from './keys/resolve.js';
import { GATE_DISMISS_TIP, gatePlainPrompt } from './secrets/gate-lines.js';
import { sanitizeStream, type LineSource } from './plain.js';

/** TUI-DESIGN §1: the readline prompt. */
export const PLAIN_PROMPT = '> ';
/** TUI-DESIGN §3.3 / §14.2: the second Ctrl-C must arrive within this window to exit. */
export const CTRL_C_WINDOW_MS = 1_500;
/** TUI-DESIGN §24 (CLI, stderr): the hint after the first idle Ctrl-C. */
export const CTRL_C_AGAIN_HINT = 'press Ctrl-C again to exit';
/** TUI-DESIGN §24 toast twin on stderr when the engine refuses a ninth steer. */
export const STEER_QUEUE_FULL_HINT = 'steer queue full (8)';
/** A line typed while the run is ending (Esc Esc / abort in flight) goes nowhere; the hint says so. */
export const RUN_ENDING_HINT = 'run is ending; wait for run:end';

/** TUI-DESIGN §5.2: the `[ui] error:` text (without the label) for a command the readline composer cannot run. */
export function plainUnavailableError(spec: CommandSpec): string {
  return `error: /${spec.name}: not available in --plain (${spec.plain})`;
}

/**
 * TUI-DESIGN §5.2 `plain` column: `yes`, `n/a`, `inline only`, `` `/resume <id>` only ``, `` `/login` raw-mode prompt ``,
 * `` yes (readline `y/N`) ``. Everything but `n/a` runs; `/resume` without an argument would open the picker (pane only)
 * and `/diff --full` the pager (idle-only anyway), so those two shapes are refused with the `[ui] error:` sentence.
 */
export function plainSupports(spec: CommandSpec, action: CommandAction): { ok: true } | { ok: false; error: string } {
  if (spec.plain === 'n/a') return { ok: false, error: plainUnavailableError(spec) };
  if (action.kind === 'resume' && action.target.kind === 'picker') return { ok: false, error: 'error: /resume: the picker needs the TUI; give a run id or a session title (/resume <id|title>)' };
  if (action.kind === 'diff' && action.full) return { ok: false, error: 'error: /diff --full: the pager needs the TUI; the inline block is available' };
  return { ok: true };
}

/** What the composer needs from the process: SIGINT subscription (the default is `process`). */
export interface SignalSource {
  on(event: 'SIGINT', fn: () => void): unknown;
  off(event: 'SIGINT', fn: () => void): unknown;
}

/**
 * TUI-DESIGN §14.2: **the composer owns SIGINT on a `--plain` TTY.** In cooked mode Ctrl-C *is* SIGINT, so the F5
 * matrix runs here (live → `host.abort('human_abort')` and stay; idle → hint, second within 1.5 s → `host.exit(0)`).
 * The session controller must not install its own `SIGINT → abort('signal')` listener while a readline composer
 * is open (two listeners would abort twice and exit 130 on the first press); SIGTERM and SIGHUP stay with the
 * controller. `ReadlineComposer.ownsSigint` states the rule for the wiring test.
 */
export interface ReadlineComposerOptions {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
  /** the ephemeral hints (`press Ctrl-C again to exit`, the gate tip); default `output` */
  stderr?: NodeJS.WritableStream;
  host: SessionHost;
  /** TUI-DESIGN §15 item 20 `RunPhase`: `none` while idle; live/starting/pausing route Enter to `steer` */
  phase: () => KeyRunPhase;
  /** at least one run ended in this session → a submission is a follow-up (§4.9) */
  ranBefore?: () => boolean;
  /** the dispatch context beyond the phase (step count, changed steps, the index fold, the `@` denylist) */
  dispatch?: () => Omit<DispatchContext, 'run'>;
  /** TUI-DESIGN §13.4: resolves at `run:end`; the EOF-while-live (or -aborting) path awaits it before exiting 0 */
  awaitRunEnd?: () => Promise<void>;
  now?: () => number;
  prompt?: string;
  /** the SIGINT source (default `process`); the composer is its only SIGINT listener on a plain TTY (§14.2) */
  signals?: SignalSource;
  ctrlCWindowMs?: number;
}

export interface ReadlineComposer {
  /** stop reading; detaches the SIGINT listener (idempotent) */
  close(): void;
  readonly closed: boolean;
  /** re-show the prompt (the controller calls it after it printed items while idle); a no-op while the lines are lent */
  prompt(): void;
  /** resolves once every line received so far has been handled (tests) */
  idle(): Promise<void>;
  /**
   * TUI-DESIGN §1 / §6.5: the shared stdin's line source for the readline confirmer (`createPlainRenderer({ lines })`
   * or `renderer.setLineSource(composer.lines)`); while a borrower holds it, lines go there and no prompt is shown.
   */
  readonly lines: LineSource;
  /** TUI-DESIGN §14.2: the controller must not add a SIGINT listener of its own while this composer is open */
  readonly ownsSigint: true;
}

/** TUI-DESIGN §4.10 / §10.2: the pending gate — a text to send, or a command line whose spans the composer registers itself. */
type GateState = { kind: 'send'; full: string; hits: readonly SecretHit[] } | { kind: 'command'; line: string; hits: readonly SecretHit[] } | null;

/** TUI-DESIGN §1 / §14.2: the readline composer over `{ terminal: false }`. */
export function createReadlineComposer(opts: ReadlineComposerOptions): ReadlineComposer {
  const { host } = opts;
  const stderr = opts.stderr ?? opts.output;
  const now = opts.now ?? ((): number => Date.now());
  const window = opts.ctrlCWindowMs ?? CTRL_C_WINDOW_MS;
  const promptText = opts.prompt ?? PLAIN_PROMPT;
  const signals: SignalSource = opts.signals ?? process;
  const ranBefore = opts.ranBefore ?? ((): boolean => false);
  const rl: Interface = createInterface({ input: opts.input, output: opts.output, terminal: false, prompt: promptText });
  let closed = false;
  let closing = false;
  let lastCtrlC: number | null = null;
  let gate: GateState = null;
  let secretSeq = 0;
  // TUI-DESIGN §1 / §6.5: the borrower of the 'line' stream (the readline confirmer during a review), and its EOF listeners
  let borrower: ((line: string) => void) | null = null;
  const closeFns = new Set<() => void>();
  // lines are handled strictly in order: a host call may be async (submit awaits the run start)
  let chain: Promise<void> = Promise.resolve();

  const ctx = (): DispatchContext => ({ ...(opts.dispatch?.() ?? { step: 0 }), run: opts.phase() });
  const live = (): boolean => {
    const p = opts.phase();
    return p === 'live' || p === 'starting' || p === 'pausing';
  };
  const note = (text: string, level: 'info' | 'warn' | 'error' = 'error'): void => host.note(text, { label: '[ui]', level });
  const hint = (text: string): void => {
    stderr.write(`${text}\n`);
  };
  const showPrompt = (): void => {
    if (!closed && borrower === null) rl.prompt();
  };

  const lines: LineSource = {
    onLine(fn) {
      borrower = fn;
      return () => {
        if (borrower !== fn) return;
        borrower = null;
        // the review is over: the composer's prompt comes back (idle or steering alike)
        if (gate === null) showPrompt();
      };
    },
    onClose(fn) {
      closeFns.add(fn);
      return () => closeFns.delete(fn);
    },
    get closed() {
      return closed;
    },
  };

  /** TUI-DESIGN §4.9 `send`: steer while live, submit while idle, dropped while aborting; history after the host call (§10.2). */
  async function send(full: string, hits: readonly SecretHit[]): Promise<void> {
    const denied = opts.dispatch?.().isDeniedPath;
    const d: SubmitDecision = routeSend(full, hits, { run: opts.phase(), ranBefore: ranBefore(), ...(denied !== undefined ? { isDeniedPath: denied } : {}) });
    if (d.kind === 'ignore') {
      hint(RUN_ENDING_HINT);
      return;
    }
    if (d.kind !== 'steer' && d.kind !== 'submit') return; // the router only yields these three for a gated text
    for (const rel of d.droppedMentions) note(deniedMentionNotice(rel), 'info');
    if (d.notice !== null) note(d.notice, 'info');
    if (d.kind === 'steer') {
      const r = host.steer(d.full, { secretSpans: d.secretSpans });
      if (!r.ok) {
        if (r.reason === 'full') hint(STEER_QUEUE_FULL_HINT);
        else if (r.reason === 'finished') {
          // the run ended between the phase read and the steer: the text becomes a submission (§4.9 idle path)
          await host.submit(d.full, { kind: ranBefore() ? 'follow-up' : 'prompt', secretSpans: d.secretSpans, pinnedFiles: [] });
          host.history()?.append('prompt', d.full);
        }
        return;
      }
      host.history()?.append('steer', d.full);
      return;
    }
    // TUI-DESIGN §10.2: `submit` registers the acknowledged spans (`addSecret`) — only then may the store see the text
    await host.submit(d.full, { kind: d.promptKind, secretSpans: d.secretSpans, pinnedFiles: d.pinnedFiles });
    host.history()?.append('prompt', d.full);
  }

  /** TUI-DESIGN §5.1 / §10.2: a gate-cleared command line — the acknowledged spans are registered here (no `secretSpans` on `command()`). */
  async function runCommand(line: string, spans: readonly string[]): Promise<void> {
    for (const span of spans) host.addSecret(`composer#${++secretSeq}`, span);
    await host.command(line);
    host.history()?.append('command', line);
  }

  /** TUI-DESIGN §5.1 / §5.2: `/` lines through `dispatchCommand`; errors are `[ui] error:` items and never submit. */
  async function command(line: string): Promise<void> {
    const r = dispatchCommand(line, ctx());
    if (!r.ok) {
      note(r.text);
      return;
    }
    const support = plainSupports(r.spec, r.action);
    if (!support.ok) {
      note(support.error);
      return;
    }
    // TUI-DESIGN §10.2: `/steer <text>`, `/rename <title>` (any rest argument) pass the same gate as a prompt
    const hits = host.detectSecrets(line);
    if (hits.length > 0) {
      gate = { kind: 'command', line, hits };
      opts.output.write(`${gatePlainPrompt(hits)} `);
      return;
    }
    await runCommand(line, []);
  }

  async function handle(raw: string): Promise<void> {
    const text = sanitizeStream(raw.replace(/\r$/, ''));
    if (gate !== null) {
      // TUI-DESIGN §4.10 plain twin: only `y` sends; anything else cancels and shows the tip
      const pending = gate;
      gate = null;
      const a = text.trim().toLowerCase();
      if (a !== 'y' && a !== 'yes') {
        hint(GATE_DISMISS_TIP);
        return;
      }
      if (pending.kind === 'send') await send(pending.full, pending.hits);
      else await runCommand(pending.line, secretSpans(pending.line, pending.hits));
      return;
    }
    if (text.trim() === '') return;
    const lead = text.trimStart();
    if (isCommandLine(lead)) {
      await command(lead.trim());
      return;
    }
    const full = (lead.startsWith('//') ? lead.slice(1) : lead).trim();
    if (full === '') return;
    const hits = host.detectSecrets(full);
    if (hits.length > 0) {
      gate = { kind: 'send', full, hits };
      opts.output.write(`${gatePlainPrompt(hits)} `);
      return;
    }
    await send(full, []);
  }

  rl.on('line', (line: string) => {
    // TUI-DESIGN §1 / §6.5: a lent line belongs to the borrower (the review's y/n/d), never to the host
    if (borrower !== null) {
      borrower(line.replace(/\r$/, ''));
      return;
    }
    chain = chain
      .then(() => handle(line))
      .catch((e: unknown) => {
        note(`error: ${e instanceof Error ? e.message : String(e)}`);
      })
      .then(() => {
        if (gate === null) showPrompt();
      });
  });

  // TUI-DESIGN §13.4 / §22: EOF is final in cooked mode — idle → exit 0; live → abort, then exit 0 after run:end;
  // aborting → exit 0 after run:end (the abort is already in flight; never a second one)
  rl.on('close', () => {
    if (closing) return;
    closing = true;
    closed = true;
    signals.off('SIGINT', onSigint);
    // a pending review declines first (nobody can approve after EOF)
    for (const fn of [...closeFns]) fn();
    chain = chain.then(async () => {
      const p = opts.phase();
      if (p === 'aborting') await opts.awaitRunEnd?.();
      else if (live()) {
        host.abort('human_abort');
        await opts.awaitRunEnd?.();
      }
      host.exit(0);
    });
  });

  // TUI-DESIGN §14.2: cooked-mode Ctrl-C is SIGINT and follows the F5 matrix
  const onSigint = (): void => {
    if (closed) return;
    const p = opts.phase();
    if (p === 'live' || p === 'starting' || p === 'pausing') {
      host.abort('human_abort');
      lastCtrlC = null;
      return;
    }
    if (p === 'aborting') return;
    const t = now();
    if (lastCtrlC !== null && t - lastCtrlC <= window) {
      closed = true;
      closing = true;
      signals.off('SIGINT', onSigint);
      rl.close();
      host.exit(0);
      return;
    }
    lastCtrlC = t;
    hint(CTRL_C_AGAIN_HINT);
    showPrompt();
  };
  signals.on('SIGINT', onSigint);

  showPrompt();

  return {
    get closed() {
      return closed;
    },
    close() {
      if (closed) return;
      closing = true;
      closed = true;
      signals.off('SIGINT', onSigint);
      rl.close();
    },
    prompt: showPrompt,
    idle: () => chain,
    lines,
    ownsSigint: true,
  };
}
