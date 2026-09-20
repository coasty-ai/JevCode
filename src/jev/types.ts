/**
 * Module-local types and constants for the Jev client, validator and mock (DESIGN.md §5).
 * The shared contract (Decider, AskResult, Question, Answer, JevResponse) lives in
 * core/types.ts; nothing here is re-declared from there.
 */
import type { JevModelDriftError } from '../errors.js';

/** Dated id pinned by default (REPORT §16; §3 table). */
export const DEFAULT_JEV_MODEL = 'typesafe/jev-1.13-20260917';

/** Decisions endpoint through OpenRouter (lab.mjs:14). */
export const DEFAULT_JEV_BASE_URL = 'https://openrouter.ai/api/alpha/decisions';

/** OpenRouter pricing.prompt for the model; output tokens are free (research 06 §1). */
export const JEV_INPUT_USD_PER_TOKEN = 4.2e-8;

/** Fixed token overhead per request and per short question (REPORT §4), used by the mock. */
export const JEV_TOKEN_OVERHEAD = 271;
export const JEV_TOKENS_PER_CHAR = 0.196;

/**
 * Retry policy adopted in RESEARCH.md §5.2 (TypeSafe SDK schedule, 3 attempts). The
 * validation retry is separate from the HTTP attempts: a transient bad body is retried
 * once on top of them (§5.2), so one ask() makes at most attempts + validationRetries fetches.
 */
export const JEV_RETRY = {
  attempts: 3,
  backoffBaseMs: 500,
  backoffMaxMs: 5000,
  jitter: 0.25,
  maxRetryAfterSeconds: 60,
  attemptTimeoutMs: 10_000,
  validationRetries: 1,
} as const;

/** Length cap on the error body kept on JevHttpError (already redacted). */
export const JEV_ERROR_BODY_MAX = 2000;

/**
 * Cap on a response body read from the wire (any status). A 1,000-Noul answer is ~60 KB and a
 * 255-option Choice with echoed legends stays far under 1 MiB, so anything larger is not a Jev
 * answer; a 200 over the cap is a transient shape failure, an error body is clipped anyway.
 */
export const JEV_RESPONSE_BODY_MAX_BYTES = 4 * 1024 * 1024;

/** Cap on wire identifier strings (`model`, `id`, `provider`) copied into records. */
export const JEV_WIRE_ID_MAX_CHARS = 256;

export interface JevClientDeps {
  fetch?: typeof fetch;
  /** redaction from resolveConfig (§8.4); applied to every error message and body */
  redact: (s: string) => string;
  /** HTTP-Referer header value */
  referer?: string;
  /** monotonic clock in ms (tests) */
  now?: () => number;
  /** U[0,1) source for backoff jitter (tests) */
  random?: () => number;
  /** injectable sleep; must reject with signal.reason when aborted */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Response headers the client captures (lab.mjs `interesting`). */
export interface JevResponseHeaders {
  generationId: string | null;
  retryAfter: string | null;
  providerName: string | null;
}

export type ServedModelCheck = { ok: true; resolved: string } | { ok: false; error: JevModelDriftError };

/** Which side of §5.2 a validation failure falls on. */
export type ValidationClass = 'transient' | 'deterministic';
