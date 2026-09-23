/**
 * Epilogue and the exit-code table (TUI-DESIGN §13.5, A62, 17 §4.9) — pure.
 *
 *   jevcode: stopped — jev_http: Jev HTTP 429: Rate limit exceeded (exit 5)
 *     run       20260920-191506-5gnampki
 *     files     ~/.jevcode/runs/20260920-191506-5gnampki/  (transcript.log, state.json, jevcode.log)
 *     resume    jevcode run --resume 20260920-191506-5gnampki        | state.json missing — not resumable
 *     report    jevcode report 20260920-191506-5gnampki   (redacted bundle written locally; nothing is sent)
 *
 * `<msg>` always passes `redact` and then the §14.1 one-row sanitiser. The same rows minus the `jevcode: ` prefix
 * and the indent form the session-mode `[ui] stopped — …` item (§24 renderer-originated items).
 */
import type { SerializedError, SignalName, StopReason } from '../core/types.js';
import { shortPath } from '../core/text.js';
import { exitCodeFor } from '../loop/stop.js';
import { TIER_NARROW_MIN, blockTexts, blockWidth, type BlockRow } from '../tui/block/lines.js';
import { cellWidth } from '../tui/glyphs.js';
import { terminalSafeLine } from '../tui/blocking/lines.js';

/** TUI-DESIGN §13.5 / §14.1: the one-row sanitiser the epilogue applies to every untrusted string (re-exported for fatal.ts). */
export { terminalSafeLine };

export interface EpilogueContext {
  /** null before a run exists (a launch-time fatal): only the first line is printed */
  runId: string | null;
  runDir: string | null;
  /** state.json is loadable (run:end.resumable) */
  resumable: boolean;
  /** the run's stop reason; used for the first line when there is no error */
  stopReason?: StopReason;
  /** the exit code the process will use (run:end.exitCode); derived through exitCodeFor when absent */
  exitCode?: number;
  /** the signal behind a `signal` stop (`AbortError.signalName`); drives 130/143/129 and the first line */
  signal?: SignalName;
  /** the checkpoint degraded during the run (`[c] continue without checkpoints`): a non-error stop exits 3 */
  degraded?: boolean;
  /** $HOME, for the `~` abbreviation of runDir; no substitution when absent */
  home?: string;
  /**
   * TUI-DESIGN-4 §7.2 item 4 (P-D5/P-D2): the run-directory artefacts that ACTUALLY exist, so the epilogue never
   * advertises a file that is not there. Absent = the historical `(transcript.log, state.json, jevcode.log)`.
   */
  files?: readonly string[];
  /** §7.2 item 4 / §12: the run directory was removed or became unwritable during the run — the `files` row says so */
  gone?: boolean;
}

export const FILES_SUFFIX = '(transcript.log, state.json, jevcode.log)';
export const NOT_RESUMABLE = 'state.json missing — not resumable';
export const REPORT_SUFFIX = '(redacted bundle written locally; nothing is sent)';

/**
 * `~` for the home prefix (TUI-DESIGN §13.5 example); a trailing slash marks the directory. TUI-DESIGN-4 §3.4:
 * a thin wrapper over `shortPath` now — one function, every path. `width` 0 means "never elide": the epilogue's
 * `files` row must keep the run id whole (§3.4 measured motivation), and the block wraps it instead.
 */
export function abbreviateDir(dir: string, home?: string, width = 0): string {
  const out = shortPath(dir, { root: '', ...(home !== undefined ? { home } : {}), width, measure: cellWidth });
  return out.endsWith('/') ? out : `${out}/`;
}

/**
 * TUI-DESIGN §13.5: the exit code the epilogue prints — the caller's when given, else `exitCodeFor(reason, error,
 * degraded, signal)` over the context (143 for SIGTERM, 129 for SIGHUP, 3 for a degraded non-error stop).
 */
export function epilogueExitCode(err: SerializedError | null, ctx: EpilogueContext): number {
  if (ctx.exitCode !== undefined && Number.isInteger(ctx.exitCode)) return ctx.exitCode;
  return exitCodeFor(ctx.stopReason ?? 'error', err ?? undefined, ctx.degraded === true, ctx.signal);
}

/**
 * `stopped — <code>: <msg> (exit N)` with `<msg>` redacted and one-row safe (TUI-DESIGN §13.5, §24). Without an
 * error the stop reason stands in for `<code>` (`stopped — complete (exit 0)`, `stopped — signal: SIGTERM (exit 143)`).
 */
export function stoppedLine(err: SerializedError | null, ctx: EpilogueContext, redact: (s: string) => string): string {
  const code = epilogueExitCode(err, ctx);
  if (err) return `stopped — ${terminalSafeLine(err.code)}: ${terminalSafeLine(redact(err.message))} (exit ${code})`;
  const reason = ctx.stopReason ?? 'error';
  const detail = reason === 'signal' && ctx.signal !== undefined ? `: ${ctx.signal}` : '';
  return `stopped — ${reason}${detail} (exit ${code})`;
}

/** TUI-DESIGN-4 §12 / §7.2 item 4: the `files` row when the run directory is gone. */
export const FILES_GONE = 'gone (the run directory was removed or became unwritable during the run)';

/**
 * TUI-DESIGN-4 §3.3: the epilogue as `BlockRow[]` — kv rows at the 10-cell key column with `shortPath`, so the
 * `report` row's continuation hangs under its value instead of landing at column 0 where it reads as a new key
 * (§3.4 measured motivation, PROBED `postrun`). Empty when no run exists.
 */
export function epilogueBlockRows(ctx: EpilogueContext, width = 0): BlockRow[] {
  if (ctx.runId === null) return [];
  // §3.1.5: `run`, `resume` and `report` carry an IDENTIFIER (and a copy-pasteable command) — never elided
  const rows: BlockRow[] = [{ kind: 'kv', key: 'run', value: ctx.runId, id: true }];
  if (ctx.runDir !== null) {
    // §7.2 item 4: the row NEVER advertises a file that is not there, and a vanished (or empty, or unwritable)
    // directory replaces the whole row. There is no `(empty)` sentence in §12 and there never was one.
    const gone = ctx.gone === true || (ctx.files !== undefined && ctx.files.length === 0);
    // §3.4: the directory is given the row's own room, so it is shortened to `…/<run id>/` rather than hard-split
    // mid-id by the block's wrap (the measured `…/runs/2` ⏎ `0260922-…` defect this round set out to remove)
    const dir = abbreviateDir(ctx.runDir, ctx.home, width <= 0 ? 0 : Math.max(1, (width >= TIER_NARROW_MIN ? width - 11 : width - 2)));
    const suffix = gone ? FILES_GONE : ctx.files === undefined ? FILES_SUFFIX : `(${ctx.files.join(', ')})`;
    // NOT `path: true`: the value is the dir PLUS the artefact list, so a left elision would eat the directory.
    // The kv wrap breaks at the space between them and the run id stays whole (§3.4 measured motivation).
    rows.push({ kind: 'kv', key: 'files', value: gone ? `${dir} — ${suffix}` : `${dir}  ${suffix}`, id: true });
  }
  rows.push({ kind: 'kv', key: 'resume', value: ctx.resumable ? `jevcode run --resume ${ctx.runId}` : NOT_RESUMABLE, id: true });
  rows.push({ kind: 'kv', key: 'report', value: `jevcode report ${ctx.runId}   ${REPORT_SUFFIX}`, id: true });
  return rows;
}

/**
 * TUI-DESIGN §13.5 / TUI-DESIGN-4 §3.3: the `run` / `files` / `resume` / `report` rows without indentation, at the
 * block body width (`blockWidth(columns())`); empty when no run exists.
 */
export function epilogueRows(ctx: EpilogueContext, width: number = blockWidth(80)): string[] {
  return blockTexts(epilogueBlockRows(ctx, width), width);
}

/**
 * TUI-DESIGN §13.5: the stderr epilogue for every `run:end` and fatal path in one-shot mode; `<msg>` passes
 * `redact`. Pure; joined with `\n` by the writer.
 */
export function epilogueLines(err: SerializedError | null, ctx: EpilogueContext, redact: (s: string) => string, columns = 80): string[] {
  // §3.3: the stderr twin indents two cells, so its body width is `columns − 2`, not the block's rung width
  return [`jevcode: ${stoppedLine(err, ctx, redact)}`, ...epilogueRows(ctx, Math.max(1, Math.floor(columns) - 2)).map((r) => `  ${r}`)];
}

/**
 * TUI-DESIGN §24: the session-mode twin — `stopped — …` as the item text (the `[ui]` label is the item's) and
 * the rows as its detail lines.
 */
export function epilogueItemLines(err: SerializedError | null, ctx: EpilogueContext, redact: (s: string) => string, width: number = blockWidth(80)): { text: string; detail: string[] } {
  return { text: stoppedLine(err, ctx, redact), detail: epilogueRows(ctx, width) };
}

// ---------------------------------------------------------------------------------------
// Exit-code table (TUI-DESIGN §13.5) as data
// ---------------------------------------------------------------------------------------

export interface ExitCodeRow {
  situation: string;
  /** exit code of `jevcode run`; null = the process does not exit on this row */
  oneShot: number | null;
  /** the code carried by the `run:end` item (or the process exit when the row exits); null = none */
  session: number | null;
  /** true when the session process exits on this row (the composer does not reopen) */
  sessionExits: boolean;
  /** the stop reasons this row covers, when it is a stop-reason row */
  stopReasons: readonly StopReason[];
  /** the signal behind a `signal` row (`exitCodeFor(…, signal)`) */
  signal?: SignalName;
}

/**
 * TUI-DESIGN §13.5 as data. `human_abort` (a TUI Ctrl-C ×2 while live) carries 130 on the item and the composer
 * reopens; an external SIGINT is `signal` and exits the session process.
 */
export const EXIT_CODE_TABLE: readonly ExitCodeRow[] = [
  { situation: 'complete / generator_done / answered', oneShot: 0, session: 0, sessionExits: false, stopReasons: ['complete', 'generator_done', 'answered'] },
  {
    situation: 'budget (max_steps, wall_time, spend_cap, max_replans, token_cap), replan_stop, impossible, human_pause, stuck',
    oneShot: 4,
    session: 4,
    sessionExits: false,
    stopReasons: ['max_steps', 'wall_time', 'spend_cap', 'max_replans', 'token_cap', 'replan_stop', 'impossible', 'human_pause', 'stuck'],
  },
  { situation: 'ConfigError / usage at launch; unpriced refusal', oneShot: 2, session: 2, sessionExits: true, stopReasons: [] },
  { situation: 'first-call 401/403, first-call drift', oneShot: 2, session: 2, sessionExits: false, stopReasons: [] },
  { situation: 'API failure after retries; spend-limit [q]', oneShot: 5, session: 5, sessionExits: false, stopReasons: [] },
  { situation: 'checkpoint degraded and stopped (incl. complete); --resume unusable', oneShot: 3, session: 3, sessionExits: false, stopReasons: [] },
  { situation: 'sandbox / path abort', oneShot: 6, session: 6, sessionExits: false, stopReasons: [] },
  { situation: 'Ctrl-C ×2 while a run is live (TUI: human_abort, the composer reopens)', oneShot: 130, session: 130, sessionExits: false, stopReasons: ['human_abort'] },
  { situation: 'external SIGINT (abort signal SIGINT)', oneShot: 130, session: 130, sessionExits: true, stopReasons: ['signal'], signal: 'SIGINT' },
  { situation: 'SIGTERM (abort signal SIGTERM)', oneShot: 143, session: 143, sessionExits: true, stopReasons: ['signal'], signal: 'SIGTERM' },
  { situation: 'SIGHUP / EIO (abort signal SIGHUP)', oneShot: 129, session: 129, sessionExits: true, stopReasons: ['signal'], signal: 'SIGHUP' },
  { situation: 'uncaught / render fault escalated', oneShot: 1, session: 1, sessionExits: true, stopReasons: ['error'] },
  { situation: '/exit (incl. [y] while live), Ctrl-D ×2 (incl. [y] while live), Ctrl-C ×2 idle', oneShot: null, session: 0, sessionExits: true, stopReasons: [] },
];

/**
 * TUI-DESIGN §13.5 table: the row for a stop reason (for `signal`, the row of the given signal, SIGINT by default);
 * null for reasons the table does not key on.
 */
export function exitCodeRowFor(reason: StopReason, signal?: SignalName): ExitCodeRow | null {
  if (reason === 'signal') {
    const want: SignalName = signal ?? 'SIGINT';
    return EXIT_CODE_TABLE.find((r) => r.stopReasons.includes('signal') && r.signal === want) ?? null;
  }
  return EXIT_CODE_TABLE.find((r) => r.stopReasons.includes(reason)) ?? null;
}
