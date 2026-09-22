/**
 * TUI-DESIGN-5 §10 R5-6 `login.test.ts`: the free `verifyProvider` path, the three outcome strings, Ctrl-C aborting
 * only the in-flight request (§6.5, D-AR, §7 row 78, §12.5 S106).
 *
 * The landed `jevcode login` behaviour lives in `test/unit/config/login.test.ts`; this file is round 5's half —
 * the five providers the hardened wizard does not know, verified with **one free catalogue GET** rather than the
 * priced decider probe.
 */
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PERSISTABLE_PROVIDERS,
  VERIFY_TIMEOUT_MS,
  commandLogin,
  isPersistableProvider,
  parseAnyProvider,
  providerCheckResult,
  providerNotPersistableText,
  verifyExitCode,
  verifyProviderKey,
  verifyProviderKeys,
  type CommandIo,
  type ProviderKeyCheck,
} from '../../../src/cli/login.js';
import { browseOnlyText, keyRateLimitedText, keyRejectedText, keyVerifiedText } from '../../../src/tui/models/lines.js';
import { PROVIDER_IDS, type ProviderId } from '../../../src/provider/ids.js';
import { parseCliArgs } from '../../../src/cli/args.js';
import { resolveConfig } from '../../../src/config/resolve.js';
import { EXIT_CODES } from '../../../src/errors.js';

const KEY = 'sk-test-0123456789abcdef0123456789abcdef';

interface Call {
  url: string;
  auth: string | undefined;
  signal: AbortSignal | undefined;
}

/** A fetch that records every request and answers from a script; it never resolves for `hang: true`. */
function recordingFetch(script: readonly ({ status: number; body?: unknown; hang?: true } | undefined)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const i = calls.length;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const signal = init?.signal ?? undefined;
    calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, auth: headers['authorization'] ?? headers['x-api-key'] ?? headers['x-goog-api-key'], signal: signal ?? undefined });
    const r = script[i];
    if (r === undefined) throw new TypeError('fetch failed');
    if (r.hang === true) {
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        });
      });
    }
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: impl as typeof fetch, calls };
}

describe('verifyProviderKey — the free catalogue GET (§6.5, D-AR)', () => {
  it('a good key: one request, no generation, S106 with the model count', async () => {
    const f = recordingFetch([{ status: 200, body: { data: [{ id: 'gpt-6-astra' }, { id: 'gpt-6-mini' }] } }]);
    const r = await verifyProviderKey('openai', KEY, { fetch: f.fetch });
    expect(r.ok).toBe(true);
    expect(r.text).toBe(keyVerifiedText('OpenAI', 2));
    expect(r.text).toBe('OpenAI key verified — 2 models');
    // exactly one request, and it is a LIST, never a completion
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(f.calls[0]?.auth).toContain(KEY);
  });

  it('a rejected key: S106, reason `rejected`', async () => {
    const f = recordingFetch([{ status: 401, body: { error: { message: 'invalid key' } } }]);
    const r = await verifyProviderKey('openai', KEY, { fetch: f.fetch });
    expect(r).toMatchObject({ ok: false, text: keyRejectedText('OpenAI', 401), reason: 'rejected' });
    expect(r.text).toBe('OpenAI key rejected (401)');
  });

  it('a 429: S106, reason `rate_limited`', async () => {
    const f = recordingFetch([{ status: 429, body: {} }]);
    const r = await verifyProviderKey('xai', KEY, { fetch: f.fetch });
    expect(r).toMatchObject({ ok: false, text: keyRateLimitedText('xAI'), reason: 'rate_limited' });
    expect(r.text).toBe('xAI: rate limited — try again');
  });

  it('an unreachable host is the catalogue’s own sentence, never a raw throw', async () => {
    const r = await verifyProviderKey('meta', KEY, { fetch: recordingFetch([]).fetch });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unreachable');
    expect(r.text).toBe('Meta: offline — showing the last list');
  });

  it('an empty key spends no request at all', async () => {
    const f = recordingFetch([{ status: 200, body: { data: [] } }]);
    const r = await verifyProviderKey('gemini', '   ', { fetch: f.fetch });
    expect(f.calls).toHaveLength(0);
    expect(r).toMatchObject({ ok: false, reason: 'rejected' });
    // the catalogue's own S102 sentence, which names the variable to set — never a second hand-written string
    expect(r.text).toBe('Google Gemini: no API key — set GEMINI_API_KEY');
  });

  it('OpenRouter answers through /key, whose body carries no model list — the count is OMITTED, not zeroed', async () => {
    const f = recordingFetch([{ status: 200, body: { data: { label: 'sk-or-v1-…' } } }]);
    const r = await verifyProviderKey('openrouter', KEY, { fetch: f.fetch });
    expect(f.calls[0]?.url).toBe('https://openrouter.ai/api/v1/key');
    expect(r.text).toBe('OpenRouter key verified');
    expect(r.text).not.toContain('0 models');
    expect(r.modelCount).toBeUndefined();
  });

  it('never surfaces the response body — a gateway echoing the key into its 401 cannot leak it (§7 row 65)', async () => {
    const f = recordingFetch([{ status: 401, body: { error: { message: `Authorization: Bearer ${KEY}` } } }]);
    const r = await verifyProviderKey('fireworks', KEY, { fetch: f.fetch });
    expect(r.text).toBe('Fireworks AI key rejected (401)');
    expect(r.text).not.toContain(KEY);
  });
});

describe('Ctrl-C aborts only the in-flight request (§7 row 78)', () => {
  it('the aborted check returns `aborted` with an empty line; the other provider still answers', async () => {
    const hanging = new AbortController();
    const f = recordingFetch([{ status: 200, body: { data: [{ id: 'a' }] } }, { hang: true, status: 0 }]);
    const good = verifyProviderKey('openai', KEY, { fetch: f.fetch });
    const cancelled = verifyProviderKey('gemini', KEY, { fetch: f.fetch, signal: hanging.signal });
    await good;
    hanging.abort();
    const r = await cancelled;
    expect(r).toEqual({ ok: false, text: '', aborted: true });
    // a cancel prints nothing: the caller keeps the typed key and may retry without re-pasting
    expect(r.text).toBe('');
    expect((await good).ok).toBe(true);
  });

  it('one controller per request: `verifyProviderKeys` mints one per id and each request gets its OWN signal', async () => {
    const f = recordingFetch([{ status: 200, body: { data: [{ id: 'a' }] } }, { status: 401, body: {} }]);
    const minted: ProviderId[] = [];
    const rs = await verifyProviderKeys({ openai: KEY, xai: KEY }, { fetch: f.fetch, onRequest: (id) => void minted.push(id) });
    expect(rs).toHaveLength(2);
    expect(f.calls).toHaveLength(2);
    expect(new Set(f.calls.map((c) => c.url)).size).toBe(2);
    expect(minted.sort()).toEqual(['openai', 'xai']);
    /**
     * The assertion the old test was missing: two DISTINCT signal objects. `Promise.all(ids.map((id) =>
     * verifyProviderKey(id, key, opts)))` passes `opts` — the caller's one signal — by reference, and that
     * version of this test (two URLs, two calls) passed with a single shared controller, so §7 row 78's
     * "only the in-flight call aborts" was never demonstrated for the batch path.
     */
    const signals = f.calls.map((c) => c.signal);
    expect(signals.every((sig) => sig !== undefined)).toBe(true);
    expect(new Set(signals).size).toBe(2);
  });

  it('one provider can be cancelled without touching the others (the wizard’s per-verify controller)', async () => {
    const f = recordingFetch([{ hang: true, status: 0 }, { status: 200, body: { data: [{ id: 'a' }] } }]);
    const byId = new Map<ProviderId, AbortController>();
    const pending = verifyProviderKeys({ openai: KEY, xai: KEY }, { fetch: f.fetch, onRequest: (id, c) => void byId.set(id, c) });
    await new Promise((r) => setImmediate(r));
    byId.get('openai')?.abort();
    const [openai, xai] = await pending;
    expect(openai).toEqual({ ok: false, text: '', aborted: true });
    expect(xai?.ok).toBe(true);
  });

  it('the caller’s own signal still cancels the whole batch (it is chained, not replaced)', async () => {
    const all = new AbortController();
    const f = recordingFetch([{ hang: true, status: 0 }, { hang: true, status: 0 }]);
    const pending = verifyProviderKeys({ openai: KEY, xai: KEY }, { fetch: f.fetch, signal: all.signal });
    await new Promise((r) => setImmediate(r));
    all.abort();
    expect(await pending).toEqual([
      { ok: false, text: '', aborted: true },
      { ok: false, text: '', aborted: true },
    ]);
  });

  it('`timeoutMs` bounds one check: a host that never answers is `unreachable`, not a hang (VERIFY_TIMEOUT_MS)', async () => {
    const f = recordingFetch([{ hang: true, status: 0 }]);
    const t0 = Date.now();
    const r = await verifyProviderKey('meta', KEY, { fetch: f.fetch, timeoutMs: 40 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.ok).toBe(false);
    expect(r.aborted).toBeUndefined();
    // the catalogue's own S102 sentence for a host it could not reach — never a raw `TimeoutError`
    expect(r.reason).toBe('unreachable');
    expect(r.text).toBe('Meta: offline — showing the last list');
    expect(VERIFY_TIMEOUT_MS).toBe(5000);
  });

  it('a provider with no key is skipped entirely', async () => {
    const f = recordingFetch([]);
    expect(await verifyProviderKeys({ openai: '  ' }, { fetch: f.fetch })).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });
});

describe('parseAnyProvider (§6.5, D-AP)', () => {
  it('accepts all seven ids, case- and space-insensitively', () => {
    for (const id of PROVIDER_IDS) {
      expect(parseAnyProvider(id)).toBe(id);
      expect(parseAnyProvider(` ${id.toUpperCase()} `)).toBe(id);
    }
  });
  it('rejects a non-id, an empty value and a prototype key', () => {
    expect(parseAnyProvider('llama')).toBeNull();
    expect(parseAnyProvider('')).toBeNull();
    expect(parseAnyProvider(undefined)).toBeNull();
    expect(parseAnyProvider('toString')).toBeNull();
    expect(parseAnyProvider('constructor')).toBeNull();
  });
});


// ---------------------------------------------------------------------------------------
// The D-AP guard: what `jevcode login` may WRITE, against what `src/config/validate.ts` reads back
// ---------------------------------------------------------------------------------------

let dir: string;
let home: string;
let cwd: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevcode-r5-login-'));
  home = join(dir, 'home');
  cwd = join(dir, 'ws');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

class Sink {
  text = '';
  write(s: string): boolean {
    this.text += s;
    return true;
  }
}
function loginIo(stdinText: string | null, extra: Partial<CommandIo> = {}): CommandIo & { out: Sink; err: Sink } {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  if (stdinText !== null) stdin.end(stdinText);
  const out = new Sink();
  const err = new Sink();
  return { stdin, stdout: out, stderr: err, env: { XDG_CONFIG_HOME: join(home, 'xdg') }, home, cwd, platform: 'darwin', out, err, ...extra };
}
const configPath = (): string => join(home, 'xdg', 'jevcode', 'config.json');

describe('the write half of D-AP is gated on its read half (§6.1, §8.1 item 6)', () => {
  /**
   * The guard's reason, read from the file that owns it. `src/config/validate.ts:161` is R5-3's (§9.2), and the
   * `isProviderId(provider)` hunk is in R5-6's report as a request. When it lands, the `else` branch below fails
   * — which is the signal to delete `PERSISTABLE_PROVIDERS`, `providerNotPersistableText`, the guard in
   * `commandLogin` and this test, in one commit.
   */
  const twoNameCheckStillThere = readFileSync('src/config/validate.ts', 'utf8').includes("provider !== 'anthropic' && provider !== 'openrouter'");

  it('the guard says exactly what validate.ts will accept back — no more, no less', () => {
    if (twoNameCheckStillThere) expect([...PERSISTABLE_PROVIDERS]).toEqual(['anthropic', 'openrouter']);
    else expect([...PERSISTABLE_PROVIDERS]).toEqual([...PROVIDER_IDS]);
    for (const id of PROVIDER_IDS) expect(isPersistableProvider(id)).toBe(PERSISTABLE_PROVIDERS.includes(id));
  });

  it('`login --provider gemini --generator-key-stdin` refuses BEFORE any key is read, and writes nothing', async () => {
    if (!twoNameCheckStillThere) return;
    const t = loginIo('gm-live-0123456789abcdefghij\n');
    expect(await commandLogin({ provider: 'gemini', generatorKeyStdin: true }, t)).toBe(EXIT_CODES.config);
    // nothing on disk: the profile is not bricked, and there is nothing to hand-edit back
    await expect(stat(configPath())).rejects.toThrow();
    expect(t.out.text).toBe('');
    // the reason is §12.5 S107's own sentence, plus the two providers that can run today
    expect(t.err.text.trim()).toBe(`jevcode: ${providerNotPersistableText('gemini')}`);
    expect(t.err.text).toContain(browseOnlyText('gemini'));
    expect(t.err.text).toContain('--provider anthropic|openrouter');
  });

  it('all five new ids are refused the same way; the two that can generate are untouched', async () => {
    if (!twoNameCheckStillThere) return;
    for (const id of PROVIDER_IDS.filter((p) => !isPersistableProvider(p))) {
      const t = loginIo('sk-test-0123456789abcdefghijkl\n');
      expect(await commandLogin({ provider: id, generatorKeyStdin: true }, t)).toBe(EXIT_CODES.config);
      expect(t.err.text).toContain(id);
    }
  });

  it('END TO END: a config `jevcode login` wrote still resolves — `resolveConfig(...).generator()` does not throw', async () => {
    const t = loginIo('sk-or-v1-abcdefghijklmnopqrstuvwxyz0123\n');
    expect(await commandLogin({ provider: 'openrouter', generatorKeyStdin: true }, t)).toBe(EXIT_CODES.ok);
    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual({ provider: 'openrouter', apiKey: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123' });
    /**
     * The pair the blocker was made of: `test/unit/config/login.test.ts` asserted the WRITE and
     * `test/unit/config/provider.test.ts` asserted the REFUSAL, and nothing asserted that the two meet. This
     * does — `config.generator()` is on the ordinary startup path (`src/cli/session.ts:719`, `:2229`).
     */
    const resolved = await resolveConfig(parseCliArgs(['run', 'task']), { XDG_CONFIG_HOME: join(home, 'xdg') }, cwd, { homedir: home });
    expect(() => resolved.generator()).not.toThrow();
    expect(resolved.generator().provider).toBe('openrouter');
  });

  it('END TO END: whatever the guard DOES let through resolves, for every id it allows', async () => {
    for (const id of PERSISTABLE_PROVIDERS) {
      const xdg = join(home, `xdg-${id}`);
      const t = loginIo('sk-test-0123456789abcdefghijklmn\n', { env: { XDG_CONFIG_HOME: xdg } });
      expect(await commandLogin({ provider: id, generatorKeyStdin: true }, t)).toBe(EXIT_CODES.ok);
      const resolved = await resolveConfig(parseCliArgs(['run', 'task', '--model', 'claude-sonnet-5']), { XDG_CONFIG_HOME: xdg }, cwd, { homedir: home });
      expect(() => resolved.generator()).not.toThrow();
      expect(resolved.generator().provider).toBe(id);
    }
  });
});

describe('--verify adds the free check to the results list, it never replaces the step (§6.5)', () => {
  const check = (over: Partial<ProviderKeyCheck>): ProviderKeyCheck => ({ ok: false, text: 'x', ...over });

  it('a passing free check is an `ok` generator row, so `verifyExitCode` still sees every result', () => {
    const r = providerCheckResult(check({ ok: true, text: keyVerifiedText('OpenAI', 84) }));
    expect(r).toEqual({ which: 'generator', ok: true, text: 'OpenAI key verified — 84 models' });
    expect(verifyExitCode([r])).toBe(EXIT_CODES.ok);
  });

  it('a rejected key is exit 2 and a 429 / unreachable host is exit 5 — `verifyExitCode`’s contract, verbatim', () => {
    const rejected = providerCheckResult(check({ text: keyRejectedText('OpenAI', 401), reason: 'rejected' }));
    expect(rejected.reason).toBe('rejected');
    expect(verifyExitCode([rejected])).toBe(EXIT_CODES.config);
    const limited = providerCheckResult(check({ text: keyRateLimitedText('xAI'), reason: 'rate_limited' }));
    // §13.5: "no credits / unreachable is 5" — the old early return answered 1 (`unexpected`) for both
    expect(limited.reason).toBe('unreachable');
    expect(verifyExitCode([limited])).toBe(EXIT_CODES.api);
    const unreachable = providerCheckResult(check({ text: 'Meta: offline — showing the last list', reason: 'unreachable' }));
    expect(verifyExitCode([unreachable])).toBe(EXIT_CODES.api);
  });

  it('a free check beside a failed DECIDER check: both rows are printed and the worse code wins', () => {
    const free = providerCheckResult(check({ ok: true, text: keyVerifiedText('OpenAI', 84) }));
    const jev = { which: 'jev', ok: false, text: 'verification failed: openrouter HTTP 401', reason: 'rejected' } as const;
    // this is the shape `commandLogin` builds: `[...free, ...verifyKeys(...)]`, one list, one exit code
    expect(verifyExitCode([free, jev])).toBe(EXIT_CODES.config);
    expect([free, jev].map((r) => r.text)).toEqual(['OpenAI key verified — 84 models', 'verification failed: openrouter HTTP 401']);
  });
});
