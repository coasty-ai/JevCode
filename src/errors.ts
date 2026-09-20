/**
 * Typed error hierarchy and exit codes (DESIGN.md §11).
 * Every error carries a stable `code`, an `exitCode`, and an optional `cause`.
 * Messages must already be redacted by the thrower when they can contain command output
 * or HTTP bodies (see core/redact.ts).
 */

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
  constructor(message: string, opts: { status: number; retryable: boolean; retryAfterMs?: number | null; body?: string; cause?: unknown }) {
    super('jev_http', message, { cause: opts.cause });
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.body = opts.body ?? '';
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
  constructor(message: string, opts: { status: number; retryable: boolean; retryAfterMs?: number | null; body?: string; cause?: unknown }) {
    super('provider_http', message, { cause: opts.cause });
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.body = opts.body ?? '';
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

export type BudgetKind = 'spend_cap' | 'wall_time' | 'max_steps' | 'max_replans';

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

export type AbortReason = 'human_abort' | 'signal' | 'error';

export class AbortError extends JevCodeError {
  readonly reason: AbortReason;
  constructor(reason: AbortReason) {
    super('abort', `aborted: ${reason}`, { exitCode: reason === 'signal' ? 130 : reason === 'human_abort' ? 130 : 1 });
    this.reason = reason;
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
} as const;
