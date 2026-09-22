/**
 * `verifyProvider` — one request that answers "does this key work", for the key-setup flow.
 *
 * It costs nothing: the check is a catalogue GET (or, for OpenRouter, a key-info GET), never a
 * generation, so a wizard can validate a pasted key without spending a token. There is no retry —
 * a key check must answer now, and the caller decides whether to offer "try again".
 *
 * Endpoint choice per provider (verified live 2026-09-21):
 *  - OpenRouter's `GET /api/v1/models` answers **unauthenticated**, so it proves nothing about a
 *    key; the check calls `GET /api/v1/key` instead, which 401s without a valid key.
 *  - xAI has `GET /v1/api-key` (key metadata), which is smaller than its model list.
 *  - Everyone else: the model list itself, which also yields a `modelCount` to show.
 *
 * Nothing from the response body is returned or logged. OpenRouter's `/key` payload contains a
 * partially masked key label and account usage; `VerifyResult` deliberately carries only `ok`,
 * `latencyMs`, `via`, a model count and a redacted error.
 */
import { httpError, parseJsonObject, readBodyCapped } from '../provider/sse.js';
import { CATALOGUE_TIMEOUT_MS, ERROR_BODY_CAP, timedFetch } from './http.js';
import { authHeaders, keyCheckUrl, listUrl, PROVIDERS } from './providers.js';
import { listArray } from './parse.js';
import { toModelsError } from './list.js';
import type { ModelsDeps, ProviderSpec, VerifyResult } from './types.js';

function nowFn(deps: ModelsDeps): () => number {
  return deps.now ?? Date.now;
}

/**
 * Send the one check request. `apiKey` must be the key as typed; an empty key short-circuits with a
 * `no_key` error and no request at all.
 */
export async function verifyProvider(spec: ProviderSpec, apiKey: string, deps: ModelsDeps = {}, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<VerifyResult> {
  const provider = spec.provider;
  const key = apiKey.trim();
  if (key === '') {
    return { ok: false, provider, latencyMs: 0, via: 'none', error: { kind: 'no_key', status: null, message: `${provider}: no API key`, retryable: false } };
  }
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const redact = deps.redact ?? ((s: string) => s);
  const now = nowFn(deps);
  const timeoutMs = opts.timeoutMs ?? CATALOGUE_TIMEOUT_MS;
  const checkUrl = keyCheckUrl(provider, spec.baseUrl);
  const via = checkUrl === null ? 'models' : 'key';
  const url = checkUrl ?? listUrl(provider, spec.baseUrl);
  const started = now();

  try {
    const res = await timedFetch({ fetch: fetchImpl, url, headers: authHeaders(provider, key), timeoutMs, signal: opts.signal, redact });
    if (!res.ok) {
      const body = await readBodyCapped(res, ERROR_BODY_CAP, timeoutMs);
      const parsed = parseJsonObject(body);
      const errObj = parsed === null ? null : parsed['error'];
      const message = typeof errObj === 'object' && errObj !== null && !Array.isArray(errObj) && typeof errObj['message'] === 'string' ? errObj['message'] : undefined;
      throw httpError({ provider, status: res.status, headers: res.headers, body, redact, kind: PROVIDERS[provider].keyCheckPath === null ? 'models' : 'key', ...(message === undefined ? {} : { message }) });
    }
    const latencyMs = Math.max(0, Math.round(now() - started));
    if (via === 'key') {
      // the body is key metadata (label, usage, limits): a 200 is the whole answer, nothing is read
      return { ok: true, provider, latencyMs, via };
    }
    const text = await readBodyCapped(res, 8 * 1024 * 1024, timeoutMs);
    const body = parseJsonObject(text);
    if (body === null) {
      return {
        ok: false,
        provider,
        latencyMs,
        via,
        error: { kind: 'invalid', status: res.status, message: `${provider}: key check response was not a JSON object`, retryable: false },
      };
    }
    return { ok: true, provider, latencyMs, via, modelCount: listArray(provider, body).length };
  } catch (e) {
    if (opts.signal?.aborted === true) throw opts.signal.reason;
    return { ok: false, provider, latencyMs: Math.max(0, Math.round(now() - started)), via, error: toModelsError(e, redact) };
  }
}

/**
 * Verify several providers at once (the wizard's "check everything I pasted"), in parallel. Keys
 * are taken from the map and never copied anywhere else.
 */
export async function verifyProviders(keys: Readonly<Partial<Record<ProviderSpec['provider'], string>>>, deps: ModelsDeps = {}, opts: { signal?: AbortSignal } = {}): Promise<VerifyResult[]> {
  const entries = Object.entries(keys).filter((e): e is [ProviderSpec['provider'], string] => typeof e[1] === 'string' && e[1].trim() !== '');
  return Promise.all(entries.map(([provider, key]) => verifyProvider({ provider }, key, deps, opts)));
}
