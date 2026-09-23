/**
 * Connection prewarm (network map P5, 2026-09-23). The first chat turn of a session used to pay the whole cold path
 * before its request could go out: undici's lazy initialisation (~7 ms on the first fetch of a process), DNS, TCP and
 * TLS (a median 47 ms to openrouter.ai, n = 63). The session controller fires ONE cheap GET at the generator's origin
 * while the human is still reading the first frame, so that turn finds all of it done — and, when it comes within
 * undici's keep-alive window, the socket itself open (sse.ts `drainToEof` keeps it poolable after each generation).
 *
 * The request is ANONYMOUS: a path on the generation origin that answers a tiny 401/403 JSON without a key (measured
 * 2026-09-23: 67–248 bytes on all seven providers), so the prewarm never sends a key anywhere, never reads anything
 * worth logging, and never costs a cent. A GET, not a HEAD — undici closes the socket right after a HEAD response
 * (measured by the network map), which would throw the warm connection away. The body is read to its end (bounded)
 * and discarded, which is what lets undici pool the socket; nothing about the answer is ever logged or surfaced.
 *
 * Limits, stated rather than hidden: Node's global fetch keeps undici's default 4 s keepAliveTimeout (OpenRouter sends
 * no `Keep-Alive: timeout=` hint) and there is no public way to lengthen it without bundling undici or reaching for its
 * internal global-dispatcher symbol — both ruled out — so a first turn typed more than 4 s after start reconnects; it
 * still skips undici's init and finds DNS warm and a TLS session to resume.
 */
import type { EngineMode } from '../core/types.js';
import type { ProviderId } from './ids.js';
import { socketReleased } from './sse.js';

/**
 * The whole prewarm, headers and body, gives up after this (it is fire-and-forget: nothing waits on it). A warm socket is
 * only worth anything if it is ready before the first keystroke lands, and a warm handshake takes ~50 ms — past 1.5 s the
 * network is slow enough that the first turn's own connect is no worse.
 */
export const PREWARM_TIMEOUT_MS = 1_500;
/** The most body a prewarm reads; its answer is a small JSON error. Past this the body is cancelled (the socket is dropped, nothing else). */
export const PREWARM_BODY_BYTES = 16 * 1024;

/**
 * The anonymous GET per provider, appended to the generator `baseUrl` so it lands on the SAME origin as the generation
 * request (undici pools per origin). OpenRouter: `/key` (its `/models` is public and hundreds of KB).
 */
export const PREWARM_PATH: Readonly<Record<ProviderId, string>> = {
  anthropic: '/v1/models',
  openrouter: '/key',
  openai: '/models',
  gemini: '/models',
  xai: '/models',
  fireworks: '/models',
  meta: '/models',
};

export interface PrewarmTarget {
  provider: ProviderId;
  baseUrl: string;
}

/** The URL a prewarm GETs, or null when the base URL is not http(s) (a proxy socket, a typo: nothing to warm). */
export function prewarmUrl(t: PrewarmTarget): string | null {
  const base = t.baseUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  return `${base}${PREWARM_PATH[t.provider]}`;
}

/** Why no prewarm went out. */
export type PrewarmSkip = 'not-interactive' | 'mock' | 'no-network' | 'test' | 'jev-only' | 'no-key' | 'no-target';

export type PrewarmOutcome = { kind: 'warmed'; status: number } | { kind: 'failed' } | { kind: 'skipped'; reason: PrewarmSkip };

export interface PrewarmDeps {
  fetch?: typeof fetch;
}

/**
 * One anonymous GET to `target`'s origin, its body read to the end (≤ `PREWARM_BODY_BYTES`) and discarded. Never throws
 * and never logs: a prewarm that fails (offline, refused, timed out, aborted) changes nothing — the first turn simply
 * connects itself, as it did before.
 */
export async function prewarm(target: PrewarmTarget, signal: AbortSignal, deps: PrewarmDeps = {}): Promise<PrewarmOutcome> {
  const url = prewarmUrl(target);
  if (url === null) return { kind: 'skipped', reason: 'no-target' };
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  try {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(PREWARM_TIMEOUT_MS)]);
    // `manual`: a redirect would warm some other origin, never the one the generation talks to
    const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: bounded });
    if (res.body !== null) {
      const reader = res.body.getReader();
      let bytes = 0;
      for (;;) {
        const r = await reader.read();
        if (r.done) {
          await socketReleased();
          break;
        }
        bytes += r.value.byteLength;
        if (bytes > PREWARM_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    return { kind: 'warmed', status: res.status };
  } catch {
    return { kind: 'failed' };
  }
}

/** What the prewarm reads from the resolved configuration (a structural slice of `ResolvedConfig`). */
export interface PrewarmConfig {
  readonly noNetwork: boolean;
  missingSecrets(mode: EngineMode): readonly string[];
  generator(): PrewarmTarget;
}

export interface PrewarmWhen {
  /**
   * A human is about to type: an interactive session (an Ink composer, session mode, not `--list-sessions`). A one-shot
   * run, a pipe or a listing needs no warm socket, and an in-flight GET would hold its natural exit (main.tsx exits by
   * draining the event loop): `--list-sessions` took 163–227 ms with a prewarm in flight, 72–77 ms without one.
   */
  interactive: boolean;
  mode: EngineMode;
  /** `--mock` / `--mock-generator`: the scripted provider talks to nobody */
  mock: boolean;
  /** the caller's no-network assertion (`JEVCODE_ASSERT_NO_NETWORK=1`, bin/jevcode.js): a fetch would throw by design */
  offline: boolean;
}

/**
 * Why the session must not prewarm, or null when it may: never outside an interactive session, never under `--mock`,
 * `--no-network`, the no-network assertion or a test (vitest sets `VITEST` in every worker, and a pty child inherits it
 * through the harness's copy of the environment), never in `jev-only` (no generator) and never without a generator key
 * (nothing could use the socket).
 */
export function prewarmSkip(cfg: PrewarmConfig, when: PrewarmWhen, processEnv: NodeJS.ProcessEnv = process.env): PrewarmSkip | null {
  if (!when.interactive) return 'not-interactive';
  if (when.mock) return 'mock';
  if (cfg.noNetwork || when.offline) return 'no-network';
  if (processEnv['VITEST'] !== undefined) return 'test';
  if (when.mode === 'jev-only') return 'jev-only';
  if (cfg.missingSecrets(when.mode).includes('generator.apiKey')) return 'no-key';
  return null;
}

/**
 * The session-start prewarm: `prewarmSkip`, then `prewarm` against the generator's own origin. Fire-and-forget — the
 * caller does not await it, and nothing it does can fail the session (an invalid generator section is simply "no target").
 * `deps.signal` is the session's end: an abort drops the request, so it never outlives the session.
 */
export async function prewarmGenerator(cfg: PrewarmConfig, when: PrewarmWhen, deps: PrewarmDeps & { processEnv?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<PrewarmOutcome> {
  const skip = prewarmSkip(cfg, when, deps.processEnv);
  if (skip !== null) return { kind: 'skipped', reason: skip };
  let target: PrewarmTarget;
  try {
    const gen = cfg.generator();
    target = { provider: gen.provider, baseUrl: gen.baseUrl };
  } catch {
    return { kind: 'skipped', reason: 'no-target' };
  }
  return prewarm(target, deps.signal ?? new AbortController().signal, deps.fetch === undefined ? {} : { fetch: deps.fetch });
}
