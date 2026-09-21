/** cli/login.ts (TUI-DESIGN §11.2, §16; §19.0 row O7): --*-stdin paths; masked readline prompt; secret settings refused as arguments. */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  JEV_KEY_PROMPT,
  LOGIN_JEV_SKIP_HINT,
  LOGIN_NEEDS_TTY_OR_STDIN,
  SECRET_AS_ARGUMENT_REFUSED,
  acceptKey,
  commandConfigSet,
  commandLogin,
  commandLogout,
  loginTargetDisplay,
  readMaskedLine,
  readStdinLines,
  verifyKeys,
  type CommandIo,
} from '../../../src/cli/login.js';
import { fingerprint } from '../../../src/core/hash.js';
import type { Resolved } from '../../../src/core/types.js';

let dir: string;
let home: string;
let cwd: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevcode-login-'));
  home = join(dir, 'home');
  cwd = join(dir, 'ws');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuv_-x';
const OR_KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123';

class Sink {
  text = '';
  write(s: string): boolean {
    this.text += s;
    return true;
  }
}

function io(stdinText: string | null, extra: Partial<CommandIo> = {}): CommandIo & { out: Sink; err: Sink } {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  if (stdinText !== null) {
    stdin.end(stdinText);
  }
  const out = new Sink();
  const err = new Sink();
  return { stdin, stdout: out, stderr: err, env: { XDG_CONFIG_HOME: join(home, 'xdg') }, home, cwd, platform: 'darwin', out, err, ...extra };
}

const configPath = (): string => join(home, 'xdg', 'jevcode', 'config.json');
async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath(), 'utf8')) as Record<string, unknown>;
}

describe('readStdinLines / acceptKey / readMaskedLine', () => {
  it('reads n lines from a pipe (CRLF tolerated), fewer when the stream ends early', async () => {
    const s = new PassThrough();
    s.end('one\r\ntwo\nthree\n');
    expect(await readStdinLines(s, 2)).toEqual(['one', 'two']);
    const short = new PassThrough();
    short.end('only');
    expect(await readStdinLines(short, 2)).toEqual(['only']);
    const empty = new PassThrough();
    empty.end('');
    expect(await readStdinLines(empty, 1)).toEqual(['']);
  });

  it('acceptKey sanitises and enforces the 8-char floor', () => {
    expect(acceptKey(` ${KEY}\n`)).toBe(KEY);
    expect(acceptKey('short')).toBeNull();
    expect(acceptKey('')).toBeNull();
    expect(acceptKey('\u001b[200~abcdefghij\u001b[201~')).toBe('abcdefghij');
  });

  it('readMaskedLine echoes the prompt only: no typed byte reaches the output; history off; EOF/Ctrl-C → null', async () => {
    const input = new PassThrough();
    const out = new Sink();
    const p = readMaskedLine('Key: ', input, out);
    input.write(`${KEY}\r`);
    expect(await p).toBe(KEY);
    expect(out.text).toContain('Key: ');
    expect(out.text).not.toContain(KEY);
    for (let i = 0; i + 4 <= KEY.length; i += 4) expect(out.text).not.toContain(KEY.slice(i, i + 4));
    const eof = new PassThrough();
    const p2 = readMaskedLine('Key: ', eof, new Sink());
    eof.end();
    expect(await p2).toBeNull();
    const ctrlC = new PassThrough();
    const p3 = readMaskedLine('Key: ', ctrlC, new Sink());
    ctrlC.write('\u0003');
    expect(await p3).toBeNull();
  });

  it('readMaskedLine: a bracketed paste and Backspace edits resolve to the edited key; nothing echoed', async () => {
    const input = new PassThrough();
    const out = new Sink();
    const p = readMaskedLine('Key: ', input, out);
    input.write(`\u001b[200~${KEY}xy\u001b[201~`);
    input.write('\u007f\u007f\r');
    expect(await p).toBe(KEY);
    // readline's own cursor-positioning CSI precedes the prompt echo; no typed byte is ever echoed
    expect(out.text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')).toBe('Key: \n');
    expect(out.text).not.toContain('xy');
    for (let i = 0; i + 4 <= KEY.length; i += 4) expect(out.text).not.toContain(KEY.slice(i, i + 4));
    const p2 = readMaskedLine('Key: ', new PassThrough().end(`${KEY}\u007f\u007f-z\n`), new Sink());
    expect(acceptKey((await p2) ?? '')).toBe(`${KEY.slice(0, -2)}-z`);
  });
});

describe('commandLogin', () => {
  it('--generator-key-stdin and --jev-key-stdin read one line each from a pipe and save with 0600; output is fingerprints only', async () => {
    const t = io(`${KEY}\n${OR_KEY}\n`);
    const code = await commandLogin({ provider: 'anthropic', generatorKeyStdin: true, jevKeyStdin: true }, t);
    expect(code).toBe(0);
    expect(t.out.text.split('\n').filter(Boolean)).toEqual([
      `[setup] generator key: entered (sha256:${fingerprint(KEY)}) source=stdin`,
      `[setup] jev key: entered (sha256:${fingerprint(OR_KEY)}) source=stdin`,
      '[setup] saved ~/xdg/jevcode/config.json (mode 0600, dir 0700)',
    ]);
    expect(t.out.text).not.toContain(KEY);
    expect(t.err.text).toBe('');
    expect(await readConfig()).toEqual({ provider: 'anthropic', apiKey: KEY, jevApiKey: OR_KEY });
    expect(((await stat(configPath())).mode & 0o777)).toBe(0o600);
  });

  it('a single --jev-key-stdin keeps the existing generator key and defaults the provider from the file', async () => {
    await mkdir(join(home, 'xdg', 'jevcode'), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ provider: 'openrouter', apiKey: OR_KEY }));
    const t = io(`${KEY}\n`);
    expect(await commandLogin({ jevKeyStdin: true }, t)).toBe(0);
    expect(await readConfig()).toEqual({ provider: 'openrouter', apiKey: OR_KEY, jevApiKey: KEY });
  });

  it('a short or empty stdin line is refused with exit 2 and nothing is written', async () => {
    const t = io('short\n');
    expect(await commandLogin({ generatorKeyStdin: true }, t)).toBe(2);
    expect(t.err.text).toContain('generator.apiKey: key too short (8+ characters) (first stdin line)');
    await expect(stat(configPath())).rejects.toThrow();
    const t2 = io(`${KEY}\n`);
    expect(await commandLogin({ generatorKeyStdin: true, jevKeyStdin: true }, t2)).toBe(2);
    expect(t2.err.text).toContain('decider.apiKey: key too short (8+ characters) (second stdin line)');
  });

  it('a pipe without --*-stdin flags refuses with the fix block (exit 2)', async () => {
    const t = io(`${KEY}\n`);
    expect(await commandLogin({}, t)).toBe(2);
    const lines = t.err.text.split('\n').filter(Boolean);
    expect(lines[0]).toBe(LOGIN_NEEDS_TTY_OR_STDIN);
    expect(lines.slice(1)).toEqual(['export ANTHROPIC_API_KEY=…', 'export JEV_API_KEY=…', 'printenv OPENROUTER_API_KEY | jevcode login --jev-key-stdin', 'jevcode login', 'Keys are never accepted as command-line arguments in the interactive flow']);
    await expect(stat(configPath())).rejects.toThrow();
  });

  it('interactive: masked prompts for both keys; Enter on the Jev prompt reuses the OpenRouter key AND persists it as jevApiKey (the wizard’s reuseGeneratorForJev); the prefix hint warns once', async () => {
    const answers = ['not-an-openrouter-key-000', 'not-an-openrouter-key-000', ''];
    const prompts: string[] = [];
    const t = io(null, {
      readMasked: async (p) => {
        prompts.push(p);
        return answers.shift() ?? null;
      },
    });
    expect(await commandLogin({ provider: 'openrouter' }, t)).toBe(0);
    expect(prompts).toEqual(['OpenRouter API key (OPENROUTER_API_KEY): ', 'OpenRouter API key (OPENROUTER_API_KEY): ', JEV_KEY_PROMPT]);
    expect(t.err.text).toContain('this does not look like an openrouter key — Enter again to keep it');
    expect(t.out.text).toContain('Enter = reuse the OpenRouter key for Jev');
    expect(await readConfig()).toEqual({ provider: 'openrouter', apiKey: 'not-an-openrouter-key-000', jevApiKey: 'not-an-openrouter-key-000' });
    expect(t.out.text).toContain(`[setup] jev key: entered (sha256:${fingerprint('not-an-openrouter-key-000')}) source=login`);
    expect(t.out.text).not.toContain('not-an-openrouter-key-000');
  });

  it('interactive anthropic with the Jev key already resolved from env: the Jev prompt is skipped, the generator key saved, exit 0', async () => {
    const prompts: string[] = [];
    const t = io(null, {
      readMasked: async (p) => {
        prompts.push(p);
        return KEY;
      },
      resolveSecrets: async () => new Map<string, Resolved<string>>([['decider.apiKey', { value: OR_KEY, source: 'env' }]]),
      env: { XDG_CONFIG_HOME: join(home, 'xdg'), JEV_API_KEY: OR_KEY },
    });
    expect(await commandLogin({ provider: 'anthropic' }, t)).toBe(0);
    expect(prompts).toEqual(['Anthropic API key (ANTHROPIC_API_KEY): ']);
    expect(t.out.text).toContain(`[setup] decider.apiKey: already set from env (sha256:${fingerprint(OR_KEY)}) — Jev key step skipped`);
    expect(t.err.text).toBe('');
    expect(await readConfig()).toEqual({ provider: 'anthropic', apiKey: KEY });
    expect(t.out.text).not.toContain(OR_KEY);
    // a dotenv source skips too; a file source does not (the prompt lets the user replace the saved key)
    const t2 = io(null, { readMasked: async () => KEY, resolveSecrets: async () => new Map<string, Resolved<string>>([['decider.apiKey', { value: OR_KEY, source: 'dotenv:/w/.env' }]]) });
    expect(await commandLogin({ provider: 'anthropic' }, t2)).toBe(0);
    expect(t2.out.text).toContain('Jev key step skipped');
    const asked: string[] = [];
    const t3 = io(null, {
      readMasked: async (p) => {
        asked.push(p);
        return asked.length === 1 ? KEY : '';
      },
      resolveSecrets: async () => new Map<string, Resolved<string>>([['decider.apiKey', { value: OR_KEY, source: 'file:/x/config.json' }]]),
    });
    expect(await commandLogin({ provider: 'anthropic' }, t3)).toBe(0);
    expect(asked).toHaveLength(2);
  });

  it('interactive anthropic: an empty Enter on the Jev prompt skips it (hint `Enter = skip`), leaving jevApiKey untouched; exit 0', async () => {
    await mkdir(join(home, 'xdg', 'jevcode'), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ jevApiKey: OR_KEY }));
    const answers = [KEY, ''];
    const prompts: string[] = [];
    const t = io(null, {
      readMasked: async (p) => {
        prompts.push(p);
        return answers.shift() ?? null;
      },
    });
    expect(await commandLogin({ provider: 'anthropic' }, t)).toBe(0);
    expect(prompts).toEqual(['Anthropic API key (ANTHROPIC_API_KEY): ', JEV_KEY_PROMPT]);
    expect(t.out.text).toContain(`${LOGIN_JEV_SKIP_HINT}\n`);
    expect(t.out.text).not.toContain('reuse the OpenRouter key');
    expect(t.err.text).toBe('');
    expect(await readConfig()).toEqual({ jevApiKey: OR_KEY, provider: 'anthropic', apiKey: KEY });
  });

  it('interactive: Ctrl-C on the Jev prompt saves the accepted generator key first, then prints the fix block and exits 2', async () => {
    const answers: (string | null)[] = [KEY, null];
    const t = io(null, { readMasked: async () => answers.shift() ?? null });
    expect(await commandLogin({ provider: 'anthropic' }, t)).toBe(2);
    expect(await readConfig()).toEqual({ provider: 'anthropic', apiKey: KEY });
    expect(t.out.text).toContain(`[setup] generator key: entered (sha256:${fingerprint(KEY)}) source=login`);
    expect(t.err.text.split('\n').filter(Boolean)).toEqual(['export ANTHROPIC_API_KEY=…', 'export JEV_API_KEY=…', 'printenv OPENROUTER_API_KEY | jevcode login --jev-key-stdin', 'jevcode login', 'Keys are never accepted as command-line arguments in the interactive flow']);
  });

  it('--generator-key-stdin / --jev-key-stdin on a TTY stdin use the masked prompt (a terminal line would echo the key)', async () => {
    const prompts: string[] = [];
    const answers = [KEY, OR_KEY];
    const t = io(null, {
      readMasked: async (p) => {
        prompts.push(p);
        return answers.shift() ?? null;
      },
    });
    (t.stdin as { isTTY?: boolean }).isTTY = true;
    expect(await commandLogin({ provider: 'anthropic', generatorKeyStdin: true, jevKeyStdin: true }, t)).toBe(0);
    expect(prompts).toEqual(['Anthropic API key (ANTHROPIC_API_KEY): ', JEV_KEY_PROMPT]);
    expect(await readConfig()).toEqual({ provider: 'anthropic', apiKey: KEY, jevApiKey: OR_KEY });
    expect(t.out.text).toContain('source=login');
    // Ctrl-C on the flagged Jev prompt still saves the generator key and exits 2
    const t2 = io(null, { readMasked: async (p) => (p.startsWith('Anthropic') ? KEY : null), env: { XDG_CONFIG_HOME: join(home, 'xdg2') } });
    (t2.stdin as { isTTY?: boolean }).isTTY = true;
    expect(await commandLogin({ provider: 'anthropic', generatorKeyStdin: true, jevKeyStdin: true }, t2)).toBe(2);
    expect(JSON.parse(await readFile(join(home, 'xdg2', 'jevcode', 'config.json'), 'utf8'))).toEqual({ provider: 'anthropic', apiKey: KEY });
  });

  it('an unwritable config dir (EACCES) fails with the §24 form `could not write <file>: <code>` and exit 2', async () => {
    if (process.getuid?.() === 0) return;
    const ro = join(dir, 'ro');
    await mkdir(ro, { recursive: true });
    await chmod(ro, 0o500);
    try {
      const t = io(`${KEY}\n`, { env: { XDG_CONFIG_HOME: ro } });
      expect(await commandLogin({ provider: 'anthropic', generatorKeyStdin: true }, t)).toBe(2);
      expect(t.err.text).toBe(`jevcode: could not write ${join(ro, 'jevcode', 'config.json')}: EACCES\n`);
      expect(t.out.text).toBe('');
      const t2 = io(null, { env: { XDG_CONFIG_HOME: ro } });
      expect(await commandConfigSet('generator.model', 'x', t2)).toBe(2);
      expect(t2.err.text).toContain('could not write');
    } finally {
      await chmod(ro, 0o755);
    }
  });

  it('interactive: Ctrl-C (null) prints the fix block and exits 2; too-short answers re-prompt up to 3 times', async () => {
    const t = io(null, { readMasked: async () => null });
    expect(await commandLogin({ provider: 'anthropic' }, t)).toBe(2);
    expect(t.err.text).toContain('jevcode login');
    let n = 0;
    const t2 = io(null, {
      readMasked: async () => {
        n++;
        return 'tiny';
      },
    });
    expect(await commandLogin({ provider: 'anthropic' }, t2)).toBe(2);
    expect(n).toBe(3);
    expect(t2.err.text.match(/key too short/g)).toHaveLength(3);
  });

  it('--provider is validated; JEVCODE_PROVIDER preselects', async () => {
    const t = io(`${KEY}\n`);
    expect(await commandLogin({ provider: 'gemini', generatorKeyStdin: true }, t)).toBe(2);
    expect(t.err.text).toContain('--provider: expected anthropic|openrouter');
    const t2 = io(`${OR_KEY}\n`, { env: { XDG_CONFIG_HOME: join(home, 'xdg'), JEVCODE_PROVIDER: 'openrouter' } });
    expect(await commandLogin({ generatorKeyStdin: true }, t2)).toBe(0);
    expect((await readConfig())['provider']).toBe('openrouter');
  });

  it('--status prints source + fingerprint per secret, exit 0 when both resolve and 1 otherwise; zero network', async () => {
    const entries = new Map<string, Resolved<string>>([
      ['generator.apiKey', { value: KEY, source: 'file:/x/config.json' }],
      ['decider.apiKey', { value: OR_KEY, source: 'env' }],
    ]);
    const t = io(null, { resolveSecrets: async () => entries });
    expect(await commandLogin({ status: true }, t)).toBe(0);
    expect(t.out.text).toBe(`generator.apiKey: file:/x/config.json (sha256:${fingerprint(KEY)})\ndecider.apiKey: env (sha256:${fingerprint(OR_KEY)})\n`);
    entries.delete('decider.apiKey');
    const t2 = io(null, { resolveSecrets: async () => entries });
    expect(await commandLogin({ status: true }, t2)).toBe(1);
    expect(t2.out.text).toContain('decider.apiKey: not set');
    const t3 = io(null);
    expect(await commandLogin({ status: true }, t3)).toBe(1);
  });

  it('--verify runs the injected verifier after saving: a rejected key exits 2 (§13.5 key rejected), an unreachable provider 5 (api)', async () => {
    const t = io(`${KEY}\n`, { verify: async (input) => [{ which: 'generator', ok: input.generatorKey === KEY, text: 'verified: anthropic key ok (3 models listed)' }] });
    expect(await commandLogin({ provider: 'anthropic', generatorKeyStdin: true, verify: true }, t)).toBe(0);
    expect(t.out.text).toContain('[setup] verified: anthropic key ok (3 models listed)');
    const t2 = io(`${KEY}\n`, { verify: async () => [{ which: 'generator', ok: false, text: 'verification failed: anthropic HTTP 401 — the key was kept; fix it with /login', reason: 'rejected' }] });
    expect(await commandLogin({ provider: 'anthropic', generatorKeyStdin: true, verify: true }, t2)).toBe(2);
    expect(t2.out.text).toContain('[setup] verification failed: anthropic HTTP 401 — the key was kept; fix it with /login');
    expect(await readConfig()).toEqual({ provider: 'anthropic', apiKey: KEY });
    // no reason given = rejected
    const t3 = io(`${KEY}\n`, { verify: async () => [{ which: 'generator', ok: false, text: 'verification failed: x' }] });
    expect(await commandLogin({ provider: 'anthropic', generatorKeyStdin: true, verify: true }, t3)).toBe(2);
    const t4 = io(`${KEY}\n`, { verify: async () => [{ which: 'generator', ok: false, text: 'verification failed: TypeError: fetch failed — the key was kept; fix it with /login', reason: 'unreachable' }] });
    expect(await commandLogin({ provider: 'anthropic', generatorKeyStdin: true, verify: true }, t4)).toBe(5);
    // one rejected + one unreachable: the rejection wins (2)
    const t5 = io(`${KEY}\n${OR_KEY}\n`, { verify: async () => [{ which: 'generator', ok: false, text: 'a', reason: 'unreachable' }, { which: 'jev', ok: false, text: 'b', reason: 'rejected' }] });
    expect(await commandLogin({ provider: 'anthropic', generatorKeyStdin: true, jevKeyStdin: true, verify: true }, t5)).toBe(2);
  });

  it('verifyKeys uses the injected fetch: OpenRouter key endpoint (Bearer) and Anthropic models (x-api-key); failures become the §24 line', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, headers: (init?.headers as Record<string, string>) ?? {} });
      if (u.includes('openrouter')) return new Response(JSON.stringify({ data: { label: 'laptop', limit_remaining: 4.12 } }), { status: 200 });
      return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5' }, { id: 'x' }] }), { status: 200 });
    }) as typeof fetch;
    const res = await verifyKeys({ provider: 'anthropic', generatorKey: KEY, jevKey: OR_KEY }, f, 1000);
    expect(res).toEqual([
      { which: 'generator', ok: true, text: 'verified: anthropic key ok (2 models listed)' },
      { which: 'jev', ok: true, text: 'verified: openrouter key ok (label "laptop", limit remaining $4.12)' },
    ]);
    expect(calls[0]!.headers['x-api-key']).toBe(KEY);
    expect(calls[1]!.headers['authorization']).toBe(`Bearer ${OR_KEY}`);
    const rejecting = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    const bad = await verifyKeys({ provider: 'openrouter', generatorKey: OR_KEY, jevKey: OR_KEY }, rejecting, 1000);
    expect(bad).toEqual([{ which: 'generator', ok: false, text: 'verification failed: openrouter HTTP 401 — the key was kept; fix it with /login', reason: 'rejected' }]);
    const throwing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const net = await verifyKeys({ provider: 'anthropic', generatorKey: KEY, jevKey: null }, throwing, 1000);
    expect(net[0]!.text).toBe('verification failed: TypeError: fetch failed — the key was kept; fix it with /login');
    expect(net[0]!.reason).toBe('unreachable');
    expect(await verifyKeys({ provider: 'anthropic', generatorKey: null, jevKey: null }, throwing, 1000)).toEqual([]);
  });
});

describe('commandLogout', () => {
  it('removes both keys by default, one with a flag, reports fingerprints, and names env-sourced keys it does not touch', async () => {
    const t0 = io(`${KEY}\n${OR_KEY}\n`);
    await commandLogin({ provider: 'anthropic', generatorKeyStdin: true, jevKeyStdin: true }, t0);
    const t = io(null, { resolveSecrets: async () => new Map<string, Resolved<string>>([['generator.apiKey', { value: 'env-key-value-000', source: 'env' }]]) });
    expect(await commandLogout({ generator: true }, t)).toBe(0);
    expect(t.out.text.split('\n').filter(Boolean)).toEqual([
      `[setup] removed generator key (sha256:${fingerprint(KEY)}) from ~/xdg/jevcode/config.json`,
      `[setup] generator.apiKey is also set from env (sha256:${fingerprint('env-key-value-000')}) — not touched`,
    ]);
    expect(await readConfig()).toEqual({ provider: 'anthropic', jevApiKey: OR_KEY });
    const t2 = io(null);
    expect(await commandLogout({}, t2)).toBe(0);
    expect(t2.out.text).toContain(`removed jev key (sha256:${fingerprint(OR_KEY)})`);
    expect(t2.out.text).toContain('generator key: not in ~/xdg/jevcode/config.json');
    expect(await readConfig()).toEqual({ provider: 'anthropic' });
  });
});

describe('commandConfigSet', () => {
  it('refuses secret settings with the §24 line, unknown settings, flag-only settings and empty values (exit 2)', async () => {
    for (const s of ['generator.apiKey', 'decider.apiKey', 'apiKey', 'jevApiKey']) {
      const t = io(null);
      expect(await commandConfigSet(s, KEY, t)).toBe(2);
      expect(t.err.text).toBe(`jevcode: ${SECRET_AS_ARGUMENT_REFUSED}\n`);
      expect(t.err.text).toContain("secret settings are set with 'jevcode login' (stdin or masked prompt), never as an argument");
    }
    const unknown = io(null);
    expect(await commandConfigSet('ui.bogus', 'x', unknown)).toBe(2);
    expect(unknown.err.text).toContain('unknown setting "ui.bogus"');
    const flagOnly = io(null);
    expect(await commandConfigSet('configFile', '/x', flagOnly)).toBe(2);
    expect(flagOnly.err.text).toContain('cannot be stored in the config file');
    const empty = io(null);
    expect(await commandConfigSet('generator.model', '  ', empty)).toBe(2);
    await expect(stat(configPath())).rejects.toThrow();
  });

  it('writes a non-secret setting (by name or file key) into the XDG file atomically, keeping other keys', async () => {
    const t0 = io(`${KEY}\n`);
    await commandLogin({ provider: 'anthropic', generatorKeyStdin: true }, t0);
    const t = io(null);
    expect(await commandConfigSet('generator.model', 'claude-sonnet-5', t)).toBe(0);
    expect(t.out.text).toBe('generator.model = claude-sonnet-5  (file:~/xdg/jevcode/config.json)\n');
    const t2 = io(null);
    expect(await commandConfigSet('maxSteps', '12', t2)).toBe(0);
    expect(await readConfig()).toEqual({ provider: 'anthropic', apiKey: KEY, model: 'claude-sonnet-5', maxSteps: '12' });
    expect(((await stat(configPath())).mode & 0o777)).toBe(0o600);
    expect(loginTargetDisplay(t)).toBe('~/xdg/jevcode/config.json');
    expect(loginTargetDisplay(t, '/etc/j.json')).toBe('/etc/j.json');
  });
});
