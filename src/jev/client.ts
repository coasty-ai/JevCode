/**
 * Jev decider over the decisions endpoint of either provider (DESIGN.md §5.1; TUI-DESIGN-2 §2: OpenRouter's router or
 * TypeSafe's native API, one client, the differences in the `JEV_PROVIDERS` table), a port of lab.mjs raw()/ask() with
 * the retry policy adopted in RESEARCH.md §5.2.
 *
 * The client returns the paid, validated response and nothing else: spend accounting is the
 * engine's (§6), model pinning is decided by the engine through `checkServedModel` (§5.4
 * rule 7), and every string that can carry an HTTP body or a key passes through `redact`.
 */
import { appendFileSync } from 'node:fs';
import { ConfigError, JevCodeError, JevHttpError, JevModelDriftError, JevResponseError, REQUEST_ID_MAX_CHARS, toJevCodeError } from '../errors.js';
import { sha12 } from '../core/hash.js';
import { parseJson, toJson } from '../core/json.js';
import { clip } from '../core/text.js';
import { monotonicNow, sleep as defaultSleep } from '../core/time.js';
import type { AskOptions, AskResult, Decider, DeciderConfig, JevProvider, JevRequest, JevResponse, Json, Question, RetryCause, RetryInfo, TokenUsage } from '../core/types.js';
import { QuestionBuildError, assertQuestionBatch } from './questions.js';
import { JEV_PROVIDERS, aliasMatches, isPinnedJevModel, normaliseModelId } from './providers.js';
import { DEFAULT_REFERER, JEV_ERROR_BODY_MAX, JEV_RESPONSE_BODY_MAX_BYTES, JEV_RETRY } from './types.js';
import type { JevClientDeps, JevResponseHeaders, ServedModelCheck } from './types.js';
import { validateJevResponse } from './validate.js';

// contract 1.2 (TUI-DESIGN-2 §2.2): the constants moved to jev/types.ts and the id normaliser to the pure jev/providers.ts (the
// provider table needs both without importing the client); every existing `from './client.js'` import keeps compiling.
export { APP_TITLE, DEFAULT_REFERER } from './types.js';
export { normaliseModelId } from './providers.js';

// ---------------------------------------------------------------------------------------
// Model id handling (§5.4 rule 7): pure helpers so config, engine and bench agree
// ---------------------------------------------------------------------------------------

/** A normalised id ending in -YYYYMMDD is dated (pinned); anything else is an alias. */
export function isDatedModelId(id: string): boolean {
  return /-\d{8}$/.test(normaliseModelId(id));
}

/**
 * Compare the served id with the configured one. `resolved` is the id the run already
 * resolved to (null on the first Jev call). The engine turns `ok: false` into an abort on
 * the first call or a drift record later; `error.exitCode` already reflects that.
 *
 * TUI-DESIGN-2 §2.5: `pinned` is the DeciderConfig's provider-aware verdict (`-YYYYMMDD` on openrouter, `jev-<major>.<minor>.<patch>`
 * on typesafe); an alias matches through `aliasMatches` — `jev-latest` accepts any `jev-*` (PROBE: it serves `jev-1.13.0`),
 * `jev-1.13` accepts `jev-1.13-20260917`. `provider` is optional so bench and the existing callers compile; when it is given the
 * verdict is `jevModelMatches` under that naming — a caller that derived `pinned` with the OpenRouter-only `normaliseJevModelId`
 * still sees `jev-1.13.0` pinned on typesafe (`pinned || isPinnedJevModel(model, provider)`; a caller's `pinned: true` is never undone).
 */
export function checkServedModel(configured: { model: string; pinned: boolean; provider?: JevProvider }, served: string, resolved: string | null): ServedModelCheck {
  const s = normaliseModelId(served);
  const firstCall = resolved === null;
  if (resolved !== null) {
    return s === normaliseModelId(resolved) ? { ok: true, resolved } : { ok: false, error: new JevModelDriftError(configured.model, served, { firstCall }) };
  }
  const c = normaliseModelId(configured.model);
  const pinned = configured.provider !== undefined ? configured.pinned || isPinnedJevModel(configured.model, configured.provider) : configured.pinned;
  if (pinned) {
    return s === c ? { ok: true, resolved: served } : { ok: false, error: new JevModelDriftError(configured.model, served, { firstCall }) };
  }
  if (aliasMatches(c, s)) return { ok: true, resolved: served };
  return { ok: false, error: new JevModelDriftError(configured.model, served, { firstCall }) };
}

// ---------------------------------------------------------------------------------------
// Retry arithmetic (exported for tests)
// ---------------------------------------------------------------------------------------

export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500 && status <= 599 && status !== 501;
}

/** Seconds form only, honoured when 0 < v <= 60; HTTP-date and out-of-range values are ignored. */
export function parseRetryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const t = header.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const seconds = Number(t);
  if (!(seconds > 0 && seconds <= JEV_RETRY.maxRetryAfterSeconds)) return null;
  return Math.round(seconds * 1000);
}

/** min(500·2^(attempt−1), 5000) ms × (1 − U[0, 0.25)); `attempt` is the 1-based attempt that failed. */
export function backoffMs(attempt: number, random: () => number): number {
  const base = Math.min(JEV_RETRY.backoffBaseMs * 2 ** Math.max(0, attempt - 1), JEV_RETRY.backoffMaxMs);
  const u = Math.min(Math.max(random(), 0), 0.999_999);
  return Math.round(base * (1 - u * JEV_RETRY.jitter));
}

function isTimeoutError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'name' in e && (e as { name: unknown }).name === 'TimeoutError';
}

/**
 * TUI-DESIGN §13.2: the per-attempt timer fired but the transport rejected with something other than a `TimeoutError`
 * (an injected fetch, a runtime that surfaces the abort as `AbortError`). The classification rides the error's cause
 * chain so `retryCauseOf` and the "timed out" message can never disagree; the raw rejection stays reachable as `cause`.
 */
class AttemptTimeoutError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'TimeoutError';
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const cause = e.cause instanceof Error ? ` (${e.cause.message})` : '';
    return `${e.name}: ${e.message}${cause}`;
  }
  return String(e);
}

/** Walk a thrown value's `cause` chain for a string `code` (OS errno / undici `UND_ERR_*`); JevCodeErrors are skipped (their `code` is ours). */
function errnoOf(e: unknown): string | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 8 && typeof cur === 'object' && cur !== null; depth++) {
    if (!(cur instanceof JevCodeError)) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === 'string' && code.length > 0) return code;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** TUI-DESIGN §13.2: codes rendered as `no response from <host> in 10 s` rather than as "offline". */
const TIMEOUT_CODES: ReadonlySet<string> = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/** TUI-DESIGN §15 item 5: `RetryCause.message` is a redacted hint of at most 200 chars, never a body. */
const RETRY_CAUSE_MESSAGE_MAX = 200;

/** `core/time.ts` `sleep` narrowed to this client's call shape (the engine signal is always passed; `wake` is the §13.2 waker). */
type JevSleep = (ms: number, signal: AbortSignal, wake?: AbortSignal) => Promise<void>;

/**
 * TUI-DESIGN §15 item 4 / TUI-DESIGN-2 §2.4: the server's request id from the provider's `requestIdHeaders`, first hit wins
 * (typesafe: `x-typesafe-request-id`, then the generic pair; openrouter: `request-id`, `x-request-id`, `x-generation-id`).
 * Wire text that reaches `toJSON()` / `state.json` / the §13.2 `last:` row, so it is redacted like a body (a proxy may echo a
 * client header) BEFORE the clip to the shared REQUEST_ID_MAX_CHARS (F9); blank or redacted-away → null.
 */
function requestIdOf(h: Headers, names: readonly string[], redact: (s: string) => string): string | null {
  let v: string | null = null;
  for (const name of names) {
    v = h.get(name);
    if (v !== null) break;
  }
  if (v === null) return null;
  const id = redact(v.trim()).trim();
  return id.length > 0 ? clip(id, REQUEST_ID_MAX_CHARS) : null;
}

/**
 * TUI-DESIGN §15 item 5: why the client is about to sleep. The message is the error's own (already
 * redacted, body-free) clipped to 200 chars; `code` carries the errno for network / timeout causes so
 * the retry row can render the §13.2 offline copy. Only status-0 errors can be network or timeout.
 */
function retryCauseOf(err: JevHttpError): RetryCause {
  const message = clip(err.message, RETRY_CAUSE_MESSAGE_MAX);
  if (err.status > 0) return { kind: 'http', status: err.status, code: null, message };
  // The attempt timer's word wins (§13.2 `no response from <host> in 10 s`): a TimeoutError cause is a timeout whatever
  // errno the transport happened to surface underneath it; a socket-level timeout code is a timeout too.
  if (isTimeoutError(err.cause)) return { kind: 'timeout', status: null, code: 'TimeoutError', message };
  const code = errnoOf(err.cause);
  if (code !== null && TIMEOUT_CODES.has(code)) return { kind: 'timeout', status: null, code, message };
  return { kind: 'network', status: null, code, message };
}

/**
 * TUI-DESIGN §13.2 / §15.2 `jev/client.ts` row: call `onRetry` with the RetryInfo, then read the `wake`
 * GETTER for this one sleep (the engine's handler creates a fresh AbortController per call, so every
 * sleep sees its own). A throwing hook is a harness bug, not a Jev failure: it surfaces typed as
 * 'internal' so the chain never re-bills it.
 */
function notifyRetry(opts: AskOptions, info: RetryInfo): AbortSignal | undefined {
  try {
    opts.onRetry?.(info);
    return opts.wake?.();
  } catch (e) {
    throw toJevCodeError(e);
  }
}

/** Whitespace-collapsed first 200 chars, the shape of every hint below. */
function hintText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * TUI-DESIGN-2 §2.4: the human part of an error body, ≤ 200 chars, from an already-redacted text — OpenRouter's
 * `error.message`, then TypeSafe's `detail.message` (400 `{ detail: { error_type: 'api_usage_error', message } }`, PROBE),
 * then a string `detail` (FastAPI's 422 form), then the body itself.
 */
export function errorHint(text: string): string {
  const parsed = parseJson(text);
  if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)) {
    const err = parsed.value['error'];
    if (typeof err === 'object' && err !== null && !Array.isArray(err) && typeof err['message'] === 'string') return hintText(err['message']);
    const detail = parsed.value['detail'];
    if (typeof detail === 'object' && detail !== null && !Array.isArray(detail) && typeof detail['message'] === 'string') return hintText(detail['message']);
    if (typeof detail === 'string') return hintText(detail);
  }
  return hintText(text);
}

/**
 * TUI-DESIGN-2 §2.4: a 400/422 whose hint says the model does not exist is a configuration error, not a Jev failure —
 * TypeSafe's `Unknown model: jev-1.13` (PROBE), OpenRouter's `… is not a valid model ID` / `No endpoints found …`. Tested on
 * every host (a proxy may front either API); a mismatched base URL is already refused offline (§2.3 row 4).
 */
export const UNKNOWN_MODEL_HINT_RE = /unknown model|is not a valid model|no endpoints found/i;

function captureHeaders(h: Headers, requestIdHeaders: readonly string[], redact: (s: string) => string): JevResponseHeaders {
  return {
    generationId: h.get('x-generation-id'),
    retryAfter: h.get('retry-after'),
    providerName: h.get('x-provider-name'),
    requestId: requestIdOf(h, requestIdHeaders, redact),
  };
}

/**
 * Read at most `maxBytes` of the body. `res.text()` would buffer whatever the edge sends; a
 * body over the cap is not a Jev answer, so the rest is cancelled and `truncated` reported.
 */
async function readBodyBounded(res: Response, maxBytes: number, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { text: '', truncated: true };
  }
  if (res.body === null) return { text: '', truncated: false };
  const reader = res.body.getReader();
  // Every read() is raced against the attempt signal. undici does not settle a pending read()
  // on a reader-locked body when the fetch is aborted after the headers arrived (observed live
  // 2026-09-19: headers at t, Ctrl-C at t, body read pending forever), so the abort has to win
  // here explicitly and the reader is cancelled by hand.
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { text: Buffer.concat(chunks).toString('utf8'), truncated: true };
      }
      chunks.push(value);
    }
    return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
  } catch (e) {
    await reader.cancel(e).catch(() => undefined);
    throw e;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Jev rejects any state that is not a string, object or array (research 06 §1); fail before paying for the 400. */
function isSendableState(state: Json): boolean {
  return typeof state === 'string' || (typeof state === 'object' && state !== null);
}

// ---------------------------------------------------------------------------------------
// Decider
// ---------------------------------------------------------------------------------------

type AttemptOutcome =
  | { kind: 'ok'; response: JevResponse; headers: JevResponseHeaders; latencyMs: number }
  | { kind: 'http'; error: JevHttpError }
  /** TUI-DESIGN-2 §2.4: the endpoint does not serve `cfg.model` — exit 2, never retried, never billed (a 400 carries no usage) */
  | { kind: 'config'; error: ConfigError }
  | { kind: 'invalid'; error: JevResponseError };

/** Opt-in trace (JEVCODE_TRACE=<file>) for shutdown debugging; never affects the request. */
function jtrace(msg: string): void {
  const f = process.env['JEVCODE_TRACE'];
  if (!f) return;
  try {
    appendFileSync(f, `${new Date().toISOString()} jev.client ${msg}\n`);
  } catch {
    // trace only
  }
}

/**
 * The wire request's `requestHash`: `sha12(toJson({ model, state, questions }))`, the same bytes
 * `ask` hashes below and every `jev.jsonl` row records. Exported so a caller can key on a request
 * it has not sent yet (jev/cache.ts, OOS 2026-09-22 ranked change 2: 454 of 2,330 requests, 19.5 %,
 * repeated a hash already issued in the same run). One definition, so the two can never disagree.
 */
export function requestHashOf(model: string, state: Json, questions: Record<string, Question>): string {
  const request: JevRequest = { model, state, questions };
  return sha12(toJson(request));
}

export function createJevDecider(cfg: DeciderConfig, deps: JevClientDeps): Decider {
  // Every error message goes through redact; a missing function would surface as a bare
  // TypeError inside the error path, exactly where the unredacted text is in hand.
  if (typeof deps.redact !== 'function') throw new JevCodeError('internal', 'createJevDecider: deps.redact must be a function');
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? monotonicNow;
  const random = deps.random ?? Math.random;
  // TUI-DESIGN §15.2 `core/time.ts`: the 3-arg shape (signal always given here); an injected 2-arg sleep (JevClientDeps) simply ignores the waker
  const sleep: JevSleep = deps.sleep ?? defaultSleep;
  const redact = deps.redact;
  const referer = deps.referer ?? DEFAULT_REFERER;

  // resolveConfig validates these already; re-checking here keeps the client safe to build directly (tests, bench --live).
  // TUI-DESIGN-2 §2.2: the provider row of the table decides headers, request-id header and the unknown-model hint.
  if (cfg.provider !== 'typesafe' && cfg.provider !== 'openrouter') throw new ConfigError(`--jev-provider: "${String(cfg.provider)}" is not one of typesafe|openrouter`, { setting: 'decider.provider' });
  const spec = JEV_PROVIDERS[cfg.provider];
  if (typeof cfg.apiKey !== 'string' || cfg.apiKey.length === 0) throw new ConfigError('--jev-api-key: no key configured', { setting: 'jev-api-key' });
  if (typeof cfg.model !== 'string' || cfg.model.trim().length === 0) throw new ConfigError('--jev-model: model id is empty', { setting: 'jev-model' });
  let baseUrl: URL;
  try {
    baseUrl = new URL(cfg.baseUrl);
  } catch (e) {
    throw new ConfigError(`--jev-base-url: "${redact(cfg.baseUrl)}" is not a URL`, { setting: 'jev-base-url', cause: e });
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
    throw new ConfigError(`--jev-base-url: "${redact(cfg.baseUrl)}" must use http or https`, { setting: 'jev-base-url' });
  }

  // TUI-DESIGN-2 §2.2 / §2.4: OpenRouter gets the attribution pair (`HTTP-Referer`, `X-Title`), TypeSafe the bearer + content type
  const headers: Record<string, string> = spec.headers(cfg.apiKey, referer);

  function httpError(status: number, text: string, retryAfter: string | null, requestId: string | null): { error: JevHttpError; hint: string } {
    const body = redact(text).slice(0, JEV_ERROR_BODY_MAX);
    const hint = errorHint(body);
    const error = new JevHttpError(redact(`Jev HTTP ${status}${hint ? `: ${hint}` : ''}`), {
      status,
      retryable: isRetryableStatus(status),
      retryAfterMs: parseRetryAfterMs(retryAfter),
      body,
      requestId, // TUI-DESIGN §15 item 4: rides toJSON() and the §13.2 `last: … · request-id <id>` row
    });
    return { error, hint };
  }

  /**
   * TUI-DESIGN-2 §2.4: `--jev-model: "<model>" is not served by <host> (<hint>); <TypeSafe|OpenRouter accepts …>` — the host
   * actually used (not `spec.displayHost`), the redacted hint, the provider's own `accepts` line; `setting: 'decider.model'`. The
   * JevHttpError of the 400/422 rides as `cause`, so the server's request id (`x-typesafe-request-id`, PROBE: on every response)
   * stays reachable for a support report (`toJSON()`, the log) without changing the §12 message.
   */
  function unknownModelError(hint: string, cause: JevHttpError): ConfigError {
    return new ConfigError(redact(`--jev-model: "${cfg.model}" is not served by ${baseUrl.host} (${hint}); ${spec.accepts}`), { setting: 'decider.model', cause });
  }

  async function attempt(body: string, questions: Record<string, Question>, signal: AbortSignal): Promise<AttemptOutcome> {
    // A per-attempt controller linked to the engine signal, plus an explicit timer. Not
    // `AbortSignal.any([signal, AbortSignal.timeout(...)])`: composite signals are only weakly
    // held by their sources, and under the TUI's GC pressure the request stalled for good once
    // the composite was collected (observed live 2026-09-19, DECISIONS.md). The controller and
    // the timer are strongly referenced by this frame for the whole attempt.
    if (signal.aborted) throw signal.reason;
    const attemptCtl = new AbortController();
    const onParentAbort = (): void => attemptCtl.abort(signal.reason);
    signal.addEventListener('abort', onParentAbort, { once: true });
    let timedOutByTimer = false;
    const timer = setTimeout(() => {
      timedOutByTimer = true;
      attemptCtl.abort(new DOMException(`Jev attempt exceeded ${JEV_RETRY.attemptTimeoutMs} ms`, 'TimeoutError'));
    }, JEV_RETRY.attemptTimeoutMs);
    const t0 = now();
    let status: number;
    let text: string;
    let truncated: boolean;
    let captured: JevResponseHeaders;
    try {
      jtrace('attempt: fetch start');
      const res = await doFetch(cfg.baseUrl, { method: 'POST', headers, body, signal: attemptCtl.signal });
      jtrace(`attempt: headers status=${res.status}`);
      status = res.status;
      captured = captureHeaders(res.headers, spec.requestIdHeaders, redact);
      ({ text, truncated } = await readBodyBounded(res, JEV_RESPONSE_BODY_MAX_BYTES, attemptCtl.signal));
      jtrace(`attempt: body read bytes=${text.length}`);
    } catch (e) {
      jtrace(`attempt: caught ${e instanceof Error ? e.name : typeof e} signalAborted=${signal.aborted}`);
      // The engine's abort wins over everything: rethrow its reason untouched (§5.1).
      if (signal.aborted) throw signal.reason;
      const timedOut = timedOutByTimer || isTimeoutError(e);
      const message = timedOut ? `Jev request timed out after ${JEV_RETRY.attemptTimeoutMs} ms` : `Jev request failed: ${errorMessage(e)}`;
      // TUI-DESIGN §13.2: one predicate for the message and for retryCauseOf — a timer-fired attempt whose transport rejected
      // with a non-TimeoutError is still classified 'timeout' (the decision rides the cause; the raw rejection stays under it)
      const cause = timedOut && !isTimeoutError(e) ? new AttemptTimeoutError(message, e) : e;
      return { kind: 'http', error: new JevHttpError(redact(message), { status: 0, retryable: true, cause }) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onParentAbort);
    }
    const latencyMs = Math.max(0, now() - t0);
    if (status !== 200) {
      const { error, hint } = httpError(status, text, captured.retryAfter, captured.requestId);
      // TUI-DESIGN-2 §2.4: 400 (TypeSafe `api_usage_error`) or 422 naming an unknown model → ConfigError, exit 2, no retry
      if ((status === 400 || status === 422) && UNKNOWN_MODEL_HINT_RE.test(hint)) return { kind: 'config', error: unknownModelError(hint, error) };
      return { kind: 'http', error };
    }
    if (truncated) {
      return {
        kind: 'invalid',
        error: new JevResponseError(`Jev response body exceeds ${JEV_RESPONSE_BODY_MAX_BYTES} bytes`, { path: '$', transient: true }),
      };
    }

    const parsed = parseJson(text);
    if (!parsed.ok) {
      return {
        kind: 'invalid',
        error: new JevResponseError(redact(`Jev response is not JSON: ${parsed.error}`), { path: '$', transient: true }),
      };
    }
    try {
      const response = validateJevResponse(parsed.value, questions);
      return { kind: 'ok', response, headers: captured, latencyMs };
    } catch (e) {
      if (e instanceof JevResponseError) {
        return { kind: 'invalid', error: new JevResponseError(redact(e.message), { path: e.path, transient: e.transient, cause: e }) };
      }
      throw e;
    }
  }

  async function ask(state: Json, questions: Record<string, Question>, opts: AskOptions): Promise<AskResult> {
    try {
      assertQuestionBatch(questions);
    } catch (e) {
      if (e instanceof QuestionBuildError) throw new JevCodeError('internal', e.message, { cause: e });
      throw e;
    }
    if (!isSendableState(state)) throw new JevCodeError('internal', `Jev state must be a string, object or array, got ${state === null ? 'null' : typeof state}`);
    const request: JevRequest = { model: cfg.model, state, questions };
    const requestJson = toJson(request);
    const requestHash = requestHashOf(cfg.model, state, questions);
    const body = JSON.stringify(requestJson);

    let httpAttempts = 0;
    let validationRetries = 0;
    let attempts = 0;
    for (;;) {
      if (opts.signal.aborted) throw opts.signal.reason;
      attempts += 1;
      httpAttempts += 1;
      const outcome = await attempt(body, questions, opts.signal);

      if (outcome.kind === 'ok') {
        const { response, headers: h, latencyMs } = outcome;
        // TUI-DESIGN-2 §2.4 / §6 items 5–6: OpenRouter sends `usage.cost`; TypeSafe's native response carries none, so the
        // provider table prices it (`costBasis: 'table'`, `~` in the UI). A present non-finite cost still surfaces as NaN
        // (TUI-DESIGN §9.5: the meter clamps it to 0, figures render `$?`, the engine emits budget:unpriced).
        const provided = response.usage.cost;
        const table = response.usage.input_tokens * cfg.pricing.inputUsdPerToken + response.usage.output_tokens * cfg.pricing.outputUsdPerToken;
        const usage: TokenUsage = {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          costUsd: typeof provided === 'number' ? (Number.isFinite(provided) ? provided : Number.NaN) : table,
          calls: 1,
        };
        return {
          answers: response.answers,
          usage,
          latencyMs,
          model: response.model,
          requestHash,
          attempts,
          // §2.4: the body id (`gen-dec-…`), else OpenRouter's generation header, else the provider's request id (`x-typesafe-request-id`)
          id: response.id ?? h.generationId ?? h.requestId ?? null,
          costBasis: typeof provided === 'number' ? 'provider' : 'table',
        };
      }

      if (outcome.kind === 'config') throw outcome.error;

      if (outcome.kind === 'invalid') {
        // A bad body is not a network failure: one extra try for transient shapes, none for
        // deterministic mismatches, which would only bill the same failure twice (§5.2).
        if (!outcome.error.transient || validationRetries >= JEV_RETRY.validationRetries) throw outcome.error;
        validationRetries += 1;
        httpAttempts -= 1;
        continue;
      }

      const err = outcome.error;
      if (!err.retryable || httpAttempts >= JEV_RETRY.attempts) throw err;
      const waitMs = err.retryAfterMs ?? backoffMs(httpAttempts, random);
      // TUI-DESIGN §13.2 / §15.2 `jev/client.ts` row: RetryInfo before the sleep; the waker getter is read per sleep
      const wake = notifyRetry(opts, { attempt: httpAttempts, maxAttempts: JEV_RETRY.attempts, waitMs, retryAfter: err.retryAfterMs !== null, cause: retryCauseOf(err) });
      await sleep(waitMs, opts.signal, wake);
    }
  }

  // contract 1.2 (TUI-DESIGN-2 §6 item 7): the provider rides the Decider so intake ledgers and `/jev` name it without the config
  return { model: cfg.model, provider: cfg.provider, ask };
}
