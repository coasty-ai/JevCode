/**
 * Typed error hierarchy and exit codes (DESIGN.md §11).
 * Every error carries a stable `code`, an `exitCode`, and an optional `cause`.
 * Messages must already be redacted by the thrower when they can contain command output
 * or HTTP bodies (see core/redact.ts).
 */
import type { SerializedError, SignalName } from './core/types.js';

export type ErrorCode =
  | 'config'
  | 'usage'
  | 'jev_http'
  | 'jev_response'
  | 'jev_model_drift'
  | 'provider_http'
  | 'generator_response'
  | 'sandbox'
  | 'path_escape'
  | 'secret_path'
  | 'edit'
  | 'patch'
  | 'not_found'
  | 'budget'
  | 'checkpoint'
  | 'abort'
  | 'internal';

export class JevCodeError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  override readonly cause: unknown;
  constructor(code: ErrorCode, message: string, opts: { exitCode?: number; cause?: unknown } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.exitCode = opts.exitCode ?? 1;
    this.cause = opts.cause;
  }
  toJSON(): { name: string; code: ErrorCode; message: string; exitCode: number } {
    return { name: this.name, code: this.code, message: this.message, exitCode: this.exitCode };
  }
}

/**
 * TUI-DESIGN §15 item 4: the wire shape of an HTTP-side error (`JevHttpError` / `ProviderHttpError`
 * `toJSON()`); a `SerializedError` that keeps `JevCodeError.toJSON()`'s `ErrorCode` narrowing and
 * always carries `status`, `retryable`, `side` and `requestId`.
 */
export interface HttpErrorJson extends SerializedError {
  code: ErrorCode;
  status: number;
  retryable: boolean;
  side: 'jev' | 'generator';
  requestId: string | null;
}

/**
 * TUI-DESIGN §15 item 4 / §13.2 `last: … · request-id <id>`: the one cap on a server request id copied into an
 * error (both sides). A request id is server-controlled wire text like a body: the reader redacts it first (a proxy
 * may echo a client header), then clips it here; an id that redacts to nothing is `null`.
 */
export const REQUEST_ID_MAX_CHARS = 128;

/** Bad or missing configuration, or a usage error (unknown flag, missing task text). Exit 2. */
export class ConfigError extends JevCodeError {
  readonly setting: string | undefined;
  constructor(message: string, opts: { setting?: string; cause?: unknown } = {}) {
    super('config', message, { exitCode: 2, cause: opts.cause });
    this.setting = opts.setting;
  }
}

export class UsageError extends JevCodeError {
  constructor(message: string) {
    super('usage', message, { exitCode: 2 });
  }
}

/** Base for every decider-side failure. Exit 5. */
export class JevError extends JevCodeError {
  constructor(code: 'jev_http' | 'jev_response' | 'jev_model_drift', message: string, opts: { cause?: unknown; exitCode?: number } = {}) {
    super(code, message, { exitCode: opts.exitCode ?? 5, cause: opts.cause });
  }
}

export class JevHttpError extends JevError {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly body: string;
  /**
   * TUI-DESIGN §15 item 4 / §13.2 `last: … · request-id <id>`: the server's request id when the response carried one —
   * `request-id`, then `x-request-id`, then OpenRouter's `x-generation-id` — redacted and clipped to REQUEST_ID_MAX_CHARS
   * by the client; null for a network failure or a timeout.
   */
  readonly requestId: string | null;
  constructor(message: string, opts: { status: number; retryable: boolean; retryAfterMs?: number | null; body?: string; requestId?: string | null; cause?: unknown }) {
    super('jev_http', message, { cause: opts.cause });
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.body = opts.body ?? '';
    this.requestId = opts.requestId ?? null;
  }
  /** TUI-DESIGN §15.2 `jev/client.ts` row: `toJSON()` adds `status`, `retryable`, `side: 'jev'`, `requestId` (never the body). */
  override toJSON(): HttpErrorJson & { side: 'jev' } {
    return { ...super.toJSON(), status: this.status, retryable: this.retryable, side: 'jev', requestId: this.requestId };
  }
}

export class JevResponseError extends JevError {
  readonly path: string;
  /** True when the same request could plausibly produce a valid body on retry (§5.2). */
  readonly transient: boolean;
  constructor(message: string, opts: { path: string; transient: boolean; cause?: unknown }) {
    super('jev_response', message, { cause: opts.cause });
    this.path = opts.path;
    this.transient = opts.transient;
  }
}

export class JevModelDriftError extends JevError {
  readonly configured: string;
  readonly served: string;
  constructor(configured: string, served: string, opts: { firstCall: boolean }) {
    super(
      'jev_model_drift',
      `Jev served model "${served}" but --jev-model is "${configured}"${opts.firstCall ? ' (first call of the run)' : ''}`,
      { exitCode: opts.firstCall ? 2 : 5 },
    );
    this.configured = configured;
    this.served = served;
  }
}

/** Base for generator-side failures. Exit 5. */
export class ProviderError extends JevCodeError {
  constructor(code: 'provider_http' | 'generator_response', message: string, opts: { cause?: unknown } = {}) {
    super(code, message, { exitCode: 5, cause: opts.cause });
  }
}

export class ProviderHttpError extends ProviderError {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly body: string;
  /**
   * TUI-DESIGN §15 item 4 / §13.2: `request-id` (Anthropic; its error bodies also carry `request_id`) or `x-request-id`
   * (OpenRouter and proxies) when the response carried one; a mid-stream API error after a 200 carries that response's
   * id. Redacted and clipped to REQUEST_ID_MAX_CHARS by the transport; null for a transport failure (`TransportError`,
   * `IdleTimeoutError`).
   */
  readonly requestId: string | null;
  constructor(message: string, opts: { status: number; retryable: boolean; retryAfterMs?: number | null; body?: string; requestId?: string | null; cause?: unknown }) {
    super('provider_http', message, { cause: opts.cause });
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.body = opts.body ?? '';
    this.requestId = opts.requestId ?? null;
  }
  /** TUI-DESIGN §15.2 `provider/sse.ts` row: `toJSON()` likewise, with `side: 'generator'`. */
  override toJSON(): HttpErrorJson & { side: 'generator' } {
    return { ...super.toJSON(), status: this.status, retryable: this.retryable, side: 'generator', requestId: this.requestId };
  }
}

/** The generator's reply could not be turned into a valid Proposal (§7). */
export class GeneratorResponseError extends ProviderError {
  readonly reason: string;
  readonly rawText: string;
  constructor(reason: string, rawText: string) {
    super('generator_response', `malformed generator response: ${reason}`);
    this.reason = reason;
    this.rawText = rawText;
  }
}

/** Spawn failure only; timeout and output cap are ExecResult fields, not exceptions. Exit 6. */
export class SandboxError extends JevCodeError {
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super('sandbox', message, { exitCode: 6, cause: opts.cause });
  }
}

export type PathEscapeKind = 'outside' | 'symlink' | 'git' | 'absolute' | 'secret';

export class PathEscapeError extends JevCodeError {
  readonly kind: PathEscapeKind;
  readonly path: string;
  constructor(kind: PathEscapeKind, path: string, message?: string) {
    super(kind === 'secret' ? 'secret_path' : 'path_escape', message ?? `path "${path}" is not allowed (${kind})`, { exitCode: 6 });
    this.kind = kind;
    this.path = path;
  }
}

export class SecretPathError extends PathEscapeError {
  constructor(path: string) {
    super('secret', path, `path "${path}" is a secret store and is never read or written by JevCode`);
  }
}

export class EditError extends JevCodeError {
  readonly matches: number;
  readonly path: string;
  constructor(path: string, matches: number) {
    super('edit', matches === 0 ? `EditError: no match in ${path}` : `EditError: ${matches} matches in ${path} (must be exactly one)`, { exitCode: 6 });
    this.path = path;
    this.matches = matches;
  }
}

export class PatchError extends JevCodeError {
  readonly hunk: string;
  constructor(message: string, hunk: string) {
    super('patch', `PatchError: ${message}`, { exitCode: 6 });
    this.hunk = hunk;
  }
}

/** A `read` (or any harness file access) named a path that does not exist. Per-action outcome, never an exit. */
export class FileNotFoundError extends JevCodeError {
  readonly path: string;
  constructor(path: string, opts: { cause?: unknown } = {}) {
    super('not_found', `FileNotFoundError: no such file: ${path}`, { exitCode: 6, cause: opts.cause });
    this.path = path;
  }
}

/** TUI-DESIGN §15 item 19: 'token_cap' = RunLimits.maxGeneratorTokens reached (a plain budget stop) */
export type BudgetKind = 'spend_cap' | 'wall_time' | 'max_steps' | 'max_replans' | 'token_cap';

export class BudgetError extends JevCodeError {
  readonly reason: BudgetKind;
  constructor(reason: BudgetKind) {
    super('budget', `budget exhausted: ${reason}`, { exitCode: 4 });
    this.reason = reason;
  }
}

/** Corrupt or missing checkpoint on --resume. Exit 3. */
export class CheckpointError extends JevCodeError {
  readonly runDir: string;
  constructor(message: string, runDir: string, opts: { cause?: unknown } = {}) {
    super('checkpoint', message, { exitCode: 3, cause: opts.cause });
    this.runDir = runDir;
  }
}

/** contract 1.4 (COORDINATION-DESIGN §7.2, W0 item 2): `human_pause` is the pause-now soft interrupt through the shared controller */
export type AbortReason = 'human_abort' | 'signal' | 'error' | 'human_pause';

/** contract 1.4 (COORDINATION-DESIGN §12.0.2 exit-code table): the exit code an AbortError carries per reason */
function abortExitCode(reason: AbortReason, signalName: SignalName | null): number {
  switch (reason) {
    case 'signal':
      return signalName === 'SIGTERM' ? EXIT_CODES.sigterm : signalName === 'SIGHUP' ? EXIT_CODES.sighup : EXIT_CODES.sigint;
    case 'human_abort':
      return EXIT_CODES.sigint;
    case 'human_pause':
      // exit 4, the human_pause family (stop.ts exitCodeFor): a serialised pause never reads exit 1
      return EXIT_CODES.budget;
    case 'error':
      return EXIT_CODES.unexpected;
  }
}

export class AbortError extends JevCodeError {
  readonly reason: AbortReason;
  /** TUI-DESIGN §15 item 19: the signal behind abort('signal'), read by exitCodeFor for 130 / 143 / 129 (§13.5) */
  readonly signalName: SignalName | null;
  constructor(reason: AbortReason, signalName: SignalName | null = null) {
    super('abort', `aborted: ${reason}`, { exitCode: abortExitCode(reason, signalName) });
    this.reason = reason;
    this.signalName = signalName;
  }
}

export function isJevCodeError(e: unknown): e is JevCodeError {
  return e instanceof JevCodeError;
}

export function isAbortError(e: unknown): e is AbortError {
  return e instanceof AbortError;
}

export function isBudgetError(e: unknown): e is BudgetError {
  return e instanceof BudgetError;
}

/** Wrap any thrown value into a JevCodeError without losing the original. */
export function toJevCodeError(e: unknown): JevCodeError {
  if (e instanceof JevCodeError) return e;
  if (e instanceof Error) return new JevCodeError('internal', e.message, { cause: e });
  return new JevCodeError('internal', String(e));
}

export const EXIT_CODES = {
  ok: 0,
  unexpected: 1,
  config: 2,
  checkpoint: 3,
  budget: 4,
  api: 5,
  sandbox: 6,
  sigint: 130,
  sigterm: 143,
  /** TUI-DESIGN §13.5: SIGHUP / EIO */
  sighup: 129,
} as const;

// ---------------------------------------------------------------------------------------
// `explainFsError` — errors that name the fix (TUI-DESIGN-4 §7.4, P-D4)
// ---------------------------------------------------------------------------------------

/**
 * TUI-DESIGN-4 §7.4: what the caller was doing when the errno came back, so one code can pick the right row
 * (`EACCES` on the runs dir and `EACCES` on the config file want different sentences).
 */
export type FsOp =
  /** creating `<JEVCODE_HOME>/runs` (or `--runs-dir`) at launch */
  | 'runs-dir'
  /** writing inside an existing run directory mid-run */
  | 'run-dir'
  /** reading the config file */
  | 'config'
  /** anything else that touched the file system */
  | 'other';

export interface FsErrorContext {
  op?: FsOp;
  /** the directory or file the operation named; interpolated into the line */
  path?: string;
  /**
   * TUI-DESIGN-4 §7.4 edge 2: the `~` abbreviation. `shortPath` (§3.4, `src/core/text.ts`) is S3's module and is
   * not imported here — `src/errors.ts` is in the eager bundle and must stay dependency-free — so the caller
   * passes it. Default: identity.
   */
  shorten?: (p: string) => string;
  /** TUI-DESIGN-4 §7.4 edge 1: a path can contain a token. Default: identity (the caller normally passes `config.redact`). */
  redact?: (s: string) => string;
}

export interface FsExplanation {
  /** the sentence: what failed, with the path */
  readonly line: string;
  /** TUI-DESIGN-4 §7.4 edge 4: at most two rows, so it fits the flat tier */
  readonly fix: readonly string[];
  /** the errno behind it */
  readonly code: string;
  /** the exit code this condition deserves: 2 for a configuration/permission problem, 3 when the run cannot be resumed */
  readonly exitCode: number;
}

/** TUI-DESIGN-4 §7.4 edge 4. */
export const FS_FIX_MAX_ROWS = 2;

/**
 * TUI-DESIGN-4 §7.4 edge 1: a path reaches a terminal row, so drop C0/C1 controls and DEL, collapse newlines and
 * tabs to a space and strip the bidi controls §14.1 names. `terminalSafeLine` proper lives in
 * `src/tui/blocking/lines.ts`, which pulls in `plain.ts` and `composer/width.ts`; `errors.ts` is eager and stays
 * import-free, so the same rule is re-stated here in four lines.
 */
function safeText(s: string): string {
  return s
    // U+2028 / U+2029 are written as ESCAPES, never as literals: inside a regex literal the parser treats a raw
    // line separator as a line terminator, so `/...|<U+2028>|.../` is an unterminated regex and the whole module
    // fails to parse (oxc: "Unterminated regular expression"). Escaped, the character class is identical.
    .replace(/\r\n|\r|\n|\u2028|\u2029|\t/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[؜‎‏‪-‮⁦-⁩﻿]/g, '')
    .trim();
}

/** Walk a `cause` chain (a CheckpointError wraps the errno error) to the first string `code`, bounded. */
function errnoOf(e: unknown): string | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 8 && typeof cur === 'object' && cur !== null; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** The syscall the errno came from, when the platform recorded one (`mkdir`, `open`, `write`, …). */
function syscallOf(e: unknown): string | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 8 && typeof cur === 'object' && cur !== null; depth++) {
    const s = (cur as { syscall?: unknown }).syscall;
    if (typeof s === 'string' && s.length > 0) return s;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * TUI-DESIGN-4 §7.4 (P-D4): turn a raw errno into a sentence that names the value, the source, the constraint and
 * the consequence — the standard `limits.maxSteps: "lots" (from file:<path>) is not an integer >= 1` already set.
 * Returns null for anything unclassified, which keeps today's `[ui] error: <raw errno>` fallback (plus
 * `run with JEVCODE_DEBUG=1 for the stack`).
 *
 * Pure. Windows errnos fall through to null (edge 3): macOS and Linux are the supported platforms.
 */
export function explainFsError(e: unknown, ctx: FsErrorContext = {}): FsExplanation | null {
  const code = errnoOf(e);
  if (code === null) return null;
  const op = ctx.op ?? 'other';
  const redact = ctx.redact ?? ((s: string) => s);
  const shorten = ctx.shorten ?? ((p: string) => p);
  const shown = safeText(redact(shorten(ctx.path ?? '')));
  const where = shown.length > 0 ? shown : 'the run directory';
  const build = (line: string, fix: readonly string[], exitCode: number): FsExplanation => ({
    line,
    fix: fix.slice(0, FS_FIX_MAX_ROWS),
    code,
    exitCode,
  });
  const syscall = syscallOf(e);
  switch (code) {
    case 'EACCES':
    case 'EPERM':
    case 'EROFS': {
      if (op === 'config') return build(`cannot read ${where}: permission denied`, [`chmod u+r ${where}, or pass --config <path>`], EXIT_CODES.config);
      if (op === 'runs-dir' || syscall === 'mkdir')
        return build(`cannot create the runs directory ${where}: permission denied`, ['set JEVCODE_HOME to a writable directory, or pass --runs-dir <dir>'], EXIT_CODES.config);
      return build(`cannot write inside ${where}: permission denied`, ['set JEVCODE_HOME to a writable directory, or pass --runs-dir <dir>'], EXIT_CODES.config);
    }
    case 'ENOSPC':
    case 'EDQUOT':
      return build(`the disk holding ${where} is full`, ['free space, or pass --runs-dir <dir> on another volume'], EXIT_CODES.config);
    case 'ENOENT': {
      if (op === 'config') return build(`cannot read ${where}: no such file`, ['pass --config <path>, or remove the setting that names it'], EXIT_CODES.config);
      if (op === 'run-dir')
        return build(`the run directory ${where} disappeared during the run`, ['this run cannot be resumed; the transcript above is complete'], EXIT_CODES.checkpoint);
      return null;
    }
    case 'EMFILE':
    case 'ENFILE':
      return build('too many open files', ['raise the file-descriptor limit (ulimit -n)'], EXIT_CODES.config);
    default:
      return null;
  }
}

/**
 * TUI-DESIGN-4 §7.4: "every launch-time failure routes through `fatalExit` … and a correct code (**2** for a
 * configuration/permission problem, not 1)". Wrap a classified errno in the typed error that carries that code;
 * anything already typed (a `CheckpointError`'s 3, an `AbortError`'s 130) is returned untouched, and an
 * unclassified errno stays unclassified so the raw-errno fallback keeps its job.
 */
export function fsErrorToJevCodeError(e: unknown, ctx: FsErrorContext = {}): JevCodeError | null {
  if (e instanceof JevCodeError) return e;
  const x = explainFsError(e, ctx);
  if (x === null) return null;
  return x.exitCode === EXIT_CODES.checkpoint
    ? new CheckpointError(x.line, ctx.path ?? '', { cause: e })
    : new ConfigError(x.line, { cause: e });
}
