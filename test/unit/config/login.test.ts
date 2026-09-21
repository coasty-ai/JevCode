/**
 * cli/login.ts (TUI-DESIGN §11.2, §16; §19.0 row O7; TUI-DESIGN-2 §1.4, §2.3, §2.7, §8.1 S2): --*-stdin paths; masked readline
 * prompt; secret settings refused as arguments; the jev-only login (Jev key only), `--jev-provider` written as `jevProvider`
 * beside `jevApiKey`, the §2.3 inference rules, the TTY provider question / the piped exit 2, the typesafe verification.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  JEV_KEY_PROMPT,
  JEV_PROVIDER_PROMPT,
  LOGIN_JEV_SKIP_HINT,
  LOGIN_NEEDS_TTY_OR_STDIN,
  SECRET_AS_ARGUMENT_REFUSED,
  VERIFY_PROBE_STATE,
  acceptKey,
  commandConfigSet,
  commandLogin,
  commandLogout,
  generatorProviderText,
  inferJevProvider,
  jevKeyPrompt,
  loginMode,
  loginTargetDisplay,
  parseJevProvider,
  readMaskedLine,
  readPlainLine,
  readStdinLines,
  resolvedJevProvider,
  verifyKeys,
  verifyProbeQuestions,
  type CommandIo,
} from '../../../src/cli/login.js';
import { fingerprint } from '../../../src/core/hash.js';
import type { Resolved } from '../../../src/core/types.js';
import { FIX_BLOCK_FOOTER, LOGIN_JEV_PROVIDER_REQUIRED } from '../../../src/tui/onboarding/lines.js';

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
const TS_KEY = 'ts-live-abcdefghijklmnopqrstuvwxyz-0123456789';
/** TUI-DESIGN-2 §12 "Wizard": the fix block of a jev-only session (no generator line) */
const FIX_JEV_ONLY = ['export TYPESAFE_API_KEY=…', 'export OPENROUTER_API_KEY=…', 'printenv TYPESAFE_API_KEY | jevcode login --jev-provider typesafe --jev-key-stdin', 'jevcode login', FIX_BLOCK_FOOTER];
/** the same when `--provider anthropic` asked for a generator: the Anthropic line joins */
const FIX_ANTHROPIC = [...FIX_JEV_ONLY.slice(0, 4), 'export ANTHROPIC_API_KEY=…', FIX_BLOCK_FOOTER];

class Sink {
  text = '';
  write(s: string): boolean {
    this.text += s;
    return true;
  }
}

interface TestIo extends CommandIo {
  out: Sink;
  err: Sink;
  /** every plain (provider) question asked */
  asked: string[];
}

/** a piped stdin (`stdinText`) or an interactive one (`null`); the provider question answers `2` (openrouter) unless overridden */
function io(stdinText: string | null, extra: Partial<CommandIo> = {}): TestIo {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  if (stdinText !== null) {
    stdin.end(stdinText);
  }
  const out = new Sink();
  const err = new Sink();
  const asked: string[] = [];
  return {
    stdin,
    stdout: out,
    stderr: err,
    env: { XDG_CONFIG_HOME: join(home, 'xdg') },
    home,
    cwd,
    platform: 'darwin',
    readLine: async (p) => {
      asked.push(p);
      return '2';
    },
    out,
    err,
    asked,
    ...extra,
  };
}

const configPath = (): string => join(home, 'xdg', 'jevcode', 'config.json');
async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath(), 'utf8')) as Record<string, unknown>;
}
const outLines = (t: TestIo): string[] => t.out.text.split('\n').filter(Boolean);

describe('readStdinLines / acceptKey / readMaskedLine / readPlainLine', () => {
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

  it('readPlainLine (the provider question): prompt echoed, the answer returned, EOF → null', async () => {
    const input = new PassThrough();
    const out = new Sink();
    const p = readPlainLine(JEV_PROVIDER_PROMPT, input, out);
    input.write('1\n');
    expect(await p).toBe('1');
    expect(out.text).toContain('Where do you reach Jev?  1 typesafe  2 openrouter: ');
    const eof = new PassThrough();
    const p2 = readPlainLine(JEV_PROVIDER_PROMPT, eof, new Sink());
    eof.end();
    expect(await p2).toBeNull();
  });
});

describe('the pure helpers (TUI-DESIGN-2 §1.2, §1.4, §2.3)', () => {
  const lookupOf = (vars: Record<string, string>) => ({ get: (n: string) => vars[n] });

  it('parseJevProvider accepts typesafe|openrouter (any case); auto, empty and unknown are null', () => {
    expect(parseJevProvider('typesafe')).toBe('typesafe');
    expect(parseJevProvider(' OpenRouter ')).toBe('openrouter');
    expect(parseJevProvider('auto')).toBeNull();
    expect(parseJevProvider('')).toBeNull();
    expect(parseJevProvider(undefined)).toBeNull();
    expect(parseJevProvider('anthropic')).toBeNull();
  });

  it('loginMode: JEVCODE_MODE (env / .env) > the file mode key > jev-only', () => {
    expect(loginMode(lookupOf({}), { values: {} })).toBe('jev-only');
    expect(loginMode(lookupOf({ JEVCODE_MODE: 'jev-on' }), { values: {} })).toBe('jev-on');
    expect(loginMode(lookupOf({}), { values: { mode: 'jev-off' } })).toBe('jev-off');
    expect(loginMode(lookupOf({ JEVCODE_MODE: 'jev-only' }), { values: { mode: 'jev-on' } })).toBe('jev-only');
    expect(loginMode(lookupOf({ JEVCODE_MODE: 'nope' }), { values: { mode: 3 } })).toBe('jev-only');
    expect(loginMode(lookupOf({ JEVCODE_MODE: 'llm-jev' }), { values: {} })).toBe('llm-jev'); // docs/LLM-JEV-DESIGN.md
    expect(loginMode(lookupOf({}), { values: { mode: 'llm-jev' } })).toBe('llm-jev');
  });

  it('inferJevProvider: flag > the session\'s resolved provider > JEV_PROVIDER > file jevProvider (beside a saved key only) > 2a base-URL host > 2b JEV_API_KEY → openrouter > 2c TYPESAFE_API_KEY → typesafe > 2d OPENROUTER_API_KEY → openrouter > null; the generator provider is no rule', () => {
    const none = { jevProvider: null, jevApiKey: null };
    expect(inferJevProvider({ flag: 'typesafe', lookup: lookupOf({ JEV_API_KEY: 'x' }), file: none })).toBe('typesafe');
    expect(inferJevProvider({ flag: 'auto', lookup: lookupOf({ JEV_PROVIDER: 'typesafe', JEV_API_KEY: 'x' }), file: none })).toBe('typesafe');
    // the resolved provider (main.tsx's resolveConfig: env, ./.env, <OPEN_ASSIST_PATH>/.env, the file, the auto rules) outranks the local rules
    expect(inferJevProvider({ flag: undefined, resolved: 'typesafe', lookup: lookupOf({ JEV_PROVIDER: 'openrouter', JEV_API_KEY: 'x' }), file: none })).toBe('typesafe');
    expect(inferJevProvider({ flag: 'openrouter', resolved: 'typesafe', lookup: lookupOf({}), file: none })).toBe('openrouter');
    expect(inferJevProvider({ flag: undefined, resolved: null, lookup: lookupOf({ JEV_PROVIDER: 'typesafe' }), file: none })).toBe('typesafe');
    // the file's jevProvider counts only beside a saved jevApiKey — the note `logout --jev` leaves is not a chosen provider (finding 3)
    expect(inferJevProvider({ flag: undefined, lookup: lookupOf({}), file: { jevProvider: 'typesafe', jevApiKey: TS_KEY } })).toBe('typesafe');
    expect(inferJevProvider({ flag: undefined, lookup: lookupOf({}), file: { jevProvider: 'typesafe', jevApiKey: null } })).toBeNull();
    expect(inferJevProvider({ flag: undefined, lookup: lookupOf({ JEV_BASE_URL: 'https://api.typesafe.ai/v1/systemone', JEV_API_KEY: 'x' }), file: none })).toBe('typesafe');
    expect(inferJevProvider({ flag: undefined, lookup: lookupOf({ JEV_BASE_URL: 'https://openrouter.ai/api/alpha/decisions', TYPESAFE_API_KEY: 'x' }), file: none })).toBe('openrouter');
    expect(inferJevProvider({ flag: undefined, lookup: lookupOf({ JEV_BASE_URL: 'not a url', TYPESAFE_API_KEY: 'x' }), file: none })).toBe('typesafe');
    expect(inferJevProvider({ flag: undefined, lookup: lookupOf({ JEV_API_KEY: 'x', TYPESAFE_API_KEY: 'y' }), file: none })).toBe('openrouter');
    expect(inferJevProvider({ flag: undefined, lookup: lookupOf({ TYPESAFE_API_KEY: 'y', OPENROUTER_API_KEY: 'z' }), file: none })).toBe('typesafe');
    expect(inferJevProvider({ flag: undefined, lookup: lookupOf({ OPENROUTER_API_KEY: 'z' }), file: none })).toBe('openrouter');
    // finding 10: an openrouter generator (chosen or the bare default) never infers the Jev provider by itself
    expect(inferJevProvider({ flag: undefined, lookup: lookupOf({}), file: none })).toBeNull();
    // empty values are unset
    expect(inferJevProvider({ flag: undefined, lookup: lookupOf({ TYPESAFE_API_KEY: '' }), file: none })).toBeNull();
  });

  it('resolvedJevProvider reads the session\'s `decider.provider` entry: an explicit or derived source counts, `default` (rule 2e) does not, a `file:` source without a saved jevApiKey is the stale logout note', async () => {
    const withKey = { jevApiKey: TS_KEY };
    const noKey = { jevApiKey: null };
    const resolver = (value: string, source: Resolved<string>['source']) => ({ resolveSecrets: async () => new Map<string, Resolved<string>>([['decider.provider', { value, source }]]) });
    expect(await resolvedJevProvider(resolver('typesafe', 'derived'), noKey)).toBe('typesafe');
    expect(await resolvedJevProvider(resolver('openrouter', 'env'), noKey)).toBe('openrouter');
    expect(await resolvedJevProvider(resolver('typesafe', 'flag'), noKey)).toBe('typesafe');
    expect(await resolvedJevProvider(resolver('typesafe', 'dotenv:/w/open-assist/.env'), noKey)).toBe('typesafe');
    expect(await resolvedJevProvider(resolver('openrouter', 'default'), withKey)).toBeNull();
    expect(await resolvedJevProvider(resolver('typesafe', 'file:/x/config.json'), withKey)).toBe('typesafe');
    expect(await resolvedJevProvider(resolver('typesafe', 'file:/x/config.json'), noKey)).toBeNull();
    expect(await resolvedJevProvider(resolver('auto', 'env'), noKey)).toBeNull();
    expect(await resolvedJevProvider({ resolveSecrets: async () => new Map() }, noKey)).toBeNull();
    expect(await resolvedJevProvider({}, noKey)).toBeNull();
    expect(generatorProviderText('openrouter', 'default')).toBe('generator provider: openrouter (default)');
    expect(generatorProviderText('anthropic', '--provider')).toBe('generator provider: anthropic (--provider)');
  });

  it('jevKeyPrompt names the provider variable (§12 "Wizard"); openrouter and null share the OpenRouter twin', () => {
    expect(jevKeyPrompt('typesafe')).toBe('Jev API key (TYPESAFE_API_KEY): ');
    expect(jevKeyPrompt('openrouter')).toBe(JEV_KEY_PROMPT);
    expect(jevKeyPrompt(null)).toBe('Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY): ');
    expect(JEV_PROVIDER_PROMPT).toBe('Where do you reach Jev?  1 typesafe  2 openrouter: ');
  });

  it('the typesafe probe is one valid Noul over { message: "hi" } (both criteria sides, ≥ 2 examples); no workspace data', () => {
    const q = verifyProbeQuestions();
    expect(Object.keys(q)).toEqual(['greeting']);
    expect(q['greeting']).toMatchObject({ type: 'noul' });
    expect(JSON.stringify(q)).toContain('`message`');
    expect(VERIFY_PROBE_STATE).toEqual({ message: 'hi' });
  });
});

describe('commandLogin', () => {
  it('--generator-key-stdin and --jev-key-stdin read one line each from a pipe and save with 0600; --jev-provider is written beside the Jev key; output is fingerprints only', async () => {
    const t = io(`${KEY}\n${OR_KEY}\n`);
    const code = await commandLogin({ provider: 'anthropic', jevProvider: 'openrouter', generatorKeyStdin: true, jevKeyStdin: true }, t);
    expect(code).toBe(0);
    expect(outLines(t)).toEqual([
      `[setup] generator key: entered (sha256:${fingerprint(KEY)}) source=stdin`,
      `[setup] jev key: entered (sha256:${fingerprint(OR_KEY)}) source=stdin`,
      '[setup] saved ~/xdg/jevcode/config.json (mode 0600, dir 0700)',
      '[setup] generator provider: anthropic (--provider)',
      '[setup] jev provider: openrouter (openrouter.ai)',
    ]);
    expect(t.out.text).not.toContain(KEY);
    expect(t.out.text).not.toContain(OR_KEY);
    expect(t.err.text).toBe('');
    expect(t.asked).toEqual([]);
    expect(await readConfig()).toEqual({ provider: 'anthropic', apiKey: KEY, jevApiKey: OR_KEY, jevProvider: 'openrouter' });
    expect(((await stat(configPath())).mode & 0o777)).toBe(0o600);
  });

  it('TUI-DESIGN-2 §1.4: --jev-key-stdin on a pipe with nothing to infer the provider from exits 2 with the usage line and writes nothing', async () => {
    const t = io(`${KEY}\n${OR_KEY}\n`);
    expect(await commandLogin({ provider: 'anthropic', generatorKeyStdin: true, jevKeyStdin: true }, t)).toBe(2);
    expect(t.err.text).toBe(`${LOGIN_JEV_PROVIDER_REQUIRED}\n`);
    expect(t.out.text).toBe('');
    await expect(stat(configPath())).rejects.toThrow();
    const alone = io(`${TS_KEY}\n`);
    expect(await commandLogin({ jevKeyStdin: true }, alone)).toBe(2);
    expect(alone.err.text).toBe('jevcode login: pass --jev-provider typesafe|openrouter with --jev-key-stdin\n');
  });

  it('TUI-DESIGN-2 §2.3: a piped Jev key infers its provider from the environment — TYPESAFE_API_KEY → typesafe, JEV_API_KEY → openrouter, JEV_PROVIDER, ./.env, a JEV_BASE_URL host', async () => {
    const ts = io(`${TS_KEY}\n`, { env: { XDG_CONFIG_HOME: join(home, 'xdg'), TYPESAFE_API_KEY: 'something-set-1234' } });
    expect(await commandLogin({ jevKeyStdin: true }, ts)).toBe(0);
    expect(await readConfig()).toEqual({ jevApiKey: TS_KEY, jevProvider: 'typesafe' });
    expect(ts.out.text).toContain('[setup] jev provider: typesafe (api.typesafe.ai)');
    expect(ts.out.text).not.toContain(TS_KEY);
    await rm(configPath());
    const or = io(`${OR_KEY}\n`, { env: { XDG_CONFIG_HOME: join(home, 'xdg'), JEV_API_KEY: 'something-set-1234', TYPESAFE_API_KEY: 'also-set-1234' } });
    expect(await commandLogin({ jevKeyStdin: true }, or)).toBe(0);
    expect(await readConfig()).toEqual({ jevApiKey: OR_KEY, jevProvider: 'openrouter' });
    await rm(configPath());
    const explicit = io(`${TS_KEY}\n`, { env: { XDG_CONFIG_HOME: join(home, 'xdg'), JEV_PROVIDER: 'typesafe', JEV_API_KEY: 'something-set-1234' } });
    expect(await commandLogin({ jevKeyStdin: true }, explicit)).toBe(0);
    expect((await readConfig())['jevProvider']).toBe('typesafe');
    await rm(configPath());
    // ./.env counts as the environment (TUI-DESIGN-2 §2.3 "env or dotenv"); the value never leaves the map
    await writeFile(join(cwd, '.env'), 'TYPESAFE_API_KEY=dotenv-secret-value-0001\n');
    const dotenv = io(`${TS_KEY}\n`);
    expect(await commandLogin({ jevKeyStdin: true }, dotenv)).toBe(0);
    expect((await readConfig())['jevProvider']).toBe('typesafe');
    expect(dotenv.out.text).not.toContain('dotenv-secret-value-0001');
    await rm(join(cwd, '.env'));
    await rm(configPath());
    const host = io(`${TS_KEY}\n`, { env: { XDG_CONFIG_HOME: join(home, 'xdg'), JEV_BASE_URL: 'https://api.typesafe.ai/v1/systemone' } });
    expect(await commandLogin({ jevKeyStdin: true }, host)).toBe(0);
    expect((await readConfig())['jevProvider']).toBe('typesafe');
    // --jev-provider wins over every inference
    await rm(configPath());
    const flag = io(`${OR_KEY}\n`, { env: { XDG_CONFIG_HOME: join(home, 'xdg'), TYPESAFE_API_KEY: 'something-set-1234' } });
    expect(await commandLogin({ jevKeyStdin: true, jevProvider: 'openrouter' }, flag)).toBe(0);
    expect((await readConfig())['jevProvider']).toBe('openrouter');
  });

  it('finding 10: a single --jev-key-stdin never infers the Jev provider from the file\'s openrouter generator — a pipe needs --jev-provider or a §2.3 rule; the existing keys and `provider` are untouched', async () => {
    await mkdir(join(home, 'xdg', 'jevcode'), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ provider: 'openrouter', apiKey: OR_KEY }));
    const t = io(`${TS_KEY}\n`);
    expect(await commandLogin({ jevKeyStdin: true }, t)).toBe(2);
    expect(t.err.text).toBe(`${LOGIN_JEV_PROVIDER_REQUIRED}\n`);
    expect(t.out.text).toBe('');
    expect(await readConfig()).toEqual({ provider: 'openrouter', apiKey: OR_KEY });
    // with the flag the Jev key is written beside its provider and the generator side is untouched
    const flagged = io(`${TS_KEY}\n`);
    expect(await commandLogin({ jevKeyStdin: true, jevProvider: 'typesafe' }, flagged)).toBe(0);
    expect(await readConfig()).toEqual({ provider: 'openrouter', apiKey: OR_KEY, jevApiKey: TS_KEY, jevProvider: 'typesafe' });
    expect(flagged.out.text).not.toContain('generator provider'); // no generator key written → no generator provider line
    // a saved jevProvider beside a saved jevApiKey is a source of its own on the next login
    const t2 = io(`${TS_KEY}\n`);
    await writeFile(configPath(), JSON.stringify({ provider: 'anthropic', jevProvider: 'typesafe', jevApiKey: OR_KEY }));
    expect(await commandLogin({ jevKeyStdin: true }, t2)).toBe(0);
    expect(await readConfig()).toEqual({ provider: 'anthropic', jevProvider: 'typesafe', jevApiKey: TS_KEY });
  });

  it('finding 10: the piped reuse — the same OpenRouter key piped as generator and Jev key saves jevProvider openrouter; two different keys under the openrouter generator need --jev-provider (exit 2, nothing written)', async () => {
    const same = io(`${OR_KEY}\n${OR_KEY}\n`);
    expect(await commandLogin({ provider: 'openrouter', generatorKeyStdin: true, jevKeyStdin: true }, same)).toBe(0);
    expect(await readConfig()).toEqual({ provider: 'openrouter', apiKey: OR_KEY, jevApiKey: OR_KEY, jevProvider: 'openrouter' });
    expect(outLines(same)).toContain('[setup] generator provider: openrouter (--provider)');
    expect(outLines(same)).toContain('[setup] jev provider: openrouter (openrouter.ai)');
    await rm(configPath());
    const different = io(`${OR_KEY}\n${TS_KEY}\n`);
    expect(await commandLogin({ provider: 'openrouter', generatorKeyStdin: true, jevKeyStdin: true }, different)).toBe(2);
    expect(different.err.text).toBe(`${LOGIN_JEV_PROVIDER_REQUIRED}\n`);
    expect(different.out.text).toBe('');
    await expect(stat(configPath())).rejects.toThrow();
    // the bare default generator (no --provider) behaves the same: same key → reuse, different → the flag is required
    const bare = io(`${OR_KEY}\n${OR_KEY}\n`);
    expect(await commandLogin({ generatorKeyStdin: true, jevKeyStdin: true }, bare)).toBe(0);
    expect(await readConfig()).toEqual({ provider: 'openrouter', apiKey: OR_KEY, jevApiKey: OR_KEY, jevProvider: 'openrouter' });
    expect(outLines(bare)).toContain('[setup] generator provider: openrouter (default)');
    await rm(configPath());
    const bareDifferent = io(`${OR_KEY}\n${TS_KEY}\n`);
    expect(await commandLogin({ generatorKeyStdin: true, jevKeyStdin: true }, bareDifferent)).toBe(2);
    await expect(stat(configPath())).rejects.toThrow();
    // an anthropic generator never reuses, identical lines or not
    const anth = io(`${KEY}\n${KEY}\n`);
    expect(await commandLogin({ provider: 'anthropic', generatorKeyStdin: true, jevKeyStdin: true }, anth)).toBe(2);
    expect(anth.err.text).toBe(`${LOGIN_JEV_PROVIDER_REQUIRED}\n`);
  });

  it('a short or empty stdin line is refused with exit 2 and nothing is written', async () => {
    const t = io('short\n');
    expect(await commandLogin({ generatorKeyStdin: true }, t)).toBe(2);
    expect(t.err.text).toContain('generator.apiKey: key too short (8+ characters) (first stdin line)');
    await expect(stat(configPath())).rejects.toThrow();
    const t2 = io(`${KEY}\n`);
    expect(await commandLogin({ generatorKeyStdin: true, jevKeyStdin: true, jevProvider: 'openrouter' }, t2)).toBe(2);
    expect(t2.err.text).toContain('decider.apiKey: key too short (8+ characters) (second stdin line)');
    const t3 = io(`${KEY}\n`);
    expect(await commandLogin({ jevKeyStdin: true, jevProvider: 'nope' }, t3)).toBe(2);
    expect(t3.err.text).toBe('jevcode: --jev-provider: expected typesafe|openrouter, got "nope"\n');
  });

  it('a pipe without --*-stdin flags refuses with the jev-only fix block (exit 2)', async () => {
    const t = io(`${KEY}\n`);
    expect(await commandLogin({}, t)).toBe(2);
    const lines = t.err.text.split('\n').filter(Boolean);
    expect(lines[0]).toBe(LOGIN_NEEDS_TTY_OR_STDIN);
    expect(lines.slice(1)).toEqual(FIX_JEV_ONLY);
    await expect(stat(configPath())).rejects.toThrow();
    // with --provider anthropic the Anthropic line joins
    const t2 = io(`${KEY}\n`);
    expect(await commandLogin({ provider: 'anthropic' }, t2)).toBe(2);
    expect(t2.err.text.split('\n').filter(Boolean).slice(1)).toEqual(FIX_ANTHROPIC);
  });

  it('TUI-DESIGN-2 §1.4: interactive jev-only (no --provider) asks where Jev is reached, then the provider-named Jev key only; the file gets jevApiKey + jevProvider and no generator provider', async () => {
    const prompts: string[] = [];
    const t = io(null, {
      readLine: async (p) => {
        t.asked.push(p);
        return '1';
      },
      readMasked: async (p) => {
        prompts.push(p);
        return TS_KEY;
      },
    });
    expect(await commandLogin({}, t)).toBe(0);
    expect(t.asked).toEqual([JEV_PROVIDER_PROMPT]);
    expect(prompts).toEqual(['Jev API key (TYPESAFE_API_KEY): ']);
    expect(outLines(t)).toEqual([`[setup] jev key: entered (sha256:${fingerprint(TS_KEY)}) source=login`, '[setup] saved ~/xdg/jevcode/config.json (mode 0600, dir 0700)', '[setup] jev provider: typesafe (api.typesafe.ai)']);
    expect(t.out.text).not.toContain(TS_KEY);
    expect(t.err.text).toBe('');
    expect(await readConfig()).toEqual({ jevApiKey: TS_KEY, jevProvider: 'typesafe' });
    // `2` → the OpenRouter prompt; a typed provider name works too; three bad answers cancel with the fix block
    await rm(configPath());
    const or = io(null, { readLine: async () => 'openrouter', readMasked: async () => OR_KEY });
    expect(await commandLogin({}, or)).toBe(0);
    expect(await readConfig()).toEqual({ jevApiKey: OR_KEY, jevProvider: 'openrouter' });
    await rm(configPath()); // a saved jevProvider would be inferred (a source of its own); the question needs nothing to infer from
    const bad = io(null, { readLine: async () => '7', readMasked: async () => OR_KEY });
    expect(await commandLogin({}, bad)).toBe(2);
    expect(bad.err.text.match(/pick 1 \(typesafe\) or 2 \(openrouter\)/g)).toHaveLength(3);
    expect(bad.err.text.split('\n').filter(Boolean).slice(3)).toEqual(FIX_JEV_ONLY);
    // an inferred provider skips the question
    const inferred = io(null, { readMasked: async (p) => (prompts.push(p), TS_KEY), env: { XDG_CONFIG_HOME: join(home, 'xdg'), TYPESAFE_API_KEY: 'something-set-1234' } });
    prompts.length = 0;
    expect(await commandLogin({}, inferred)).toBe(0);
    expect(inferred.asked).toEqual([]);
    expect(prompts).toEqual(['Jev API key (TYPESAFE_API_KEY): ']);
    expect((await readConfig())['jevProvider']).toBe('typesafe');
  });

  it('TUI-DESIGN-2 §1.2 / finding 10: JEVCODE_MODE=jev-on (or the file mode key) brings the generator step back without --provider; the default openrouter is never a chosen Jev provider — a different Jev key is asked where it belongs', async () => {
    const prompts: string[] = [];
    const t = io(null, {
      readLine: async (p) => {
        t.asked.push(p);
        return '1';
      },
      readMasked: async (p) => {
        prompts.push(p);
        return p.startsWith('OpenRouter') ? OR_KEY : TS_KEY;
      },
      env: { XDG_CONFIG_HOME: join(home, 'xdg'), JEVCODE_MODE: 'jev-on' },
    });
    expect(await commandLogin({}, t)).toBe(0);
    expect(prompts).toEqual(['OpenRouter API key (OPENROUTER_API_KEY): ', 'Jev API key (TYPESAFE_API_KEY): ']);
    expect(t.asked).toEqual([JEV_PROVIDER_PROMPT]); // nothing infers the Jev provider: the bare default generator does not count
    expect(t.out.text).toContain(`${'Enter = reuse the OpenRouter key for Jev'}\n${JEV_PROVIDER_PROMPT}`.slice(0, 'Enter = reuse the OpenRouter key for Jev'.length)); // the hint precedes the question
    expect(await readConfig()).toEqual({ provider: 'openrouter', apiKey: OR_KEY, jevApiKey: TS_KEY, jevProvider: 'typesafe' });
    // the generator provider is written with its key and named — the unprompted default says so
    expect(outLines(t)).toContain('[setup] generator provider: openrouter (default)');
    expect(outLines(t)).toContain('[setup] jev provider: typesafe (api.typesafe.ai)');
    expect(t.out.text).not.toContain(TS_KEY);
    expect(t.out.text).not.toContain(OR_KEY);
    await rm(configPath());
    // Enter on the question under the openrouter generator = reuse the OpenRouter key for Jev (jevProvider openrouter)
    const reuse = io(null, { readLine: async () => '', readMasked: async (p) => (prompts.push(p), OR_KEY), env: { XDG_CONFIG_HOME: join(home, 'xdg'), JEVCODE_MODE: 'jev-on' } });
    prompts.length = 0;
    expect(await commandLogin({}, reuse)).toBe(0);
    expect(prompts).toEqual(['OpenRouter API key (OPENROUTER_API_KEY): ']);
    expect(await readConfig()).toEqual({ provider: 'openrouter', apiKey: OR_KEY, jevApiKey: OR_KEY, jevProvider: 'openrouter' });
    await rm(configPath());
    await mkdir(join(home, 'xdg', 'jevcode'), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ mode: 'jev-off' }));
    prompts.length = 0;
    const t2 = io(null, { readMasked: async (p) => (prompts.push(p), OR_KEY) });
    expect(await commandLogin({}, t2)).toBe(0);
    expect(prompts[0]).toBe('OpenRouter API key (OPENROUTER_API_KEY): ');
    expect(t2.asked).toEqual([JEV_PROVIDER_PROMPT]);
    expect((await readConfig())['mode']).toBe('jev-off');
    expect((await readConfig())['jevProvider']).toBe('openrouter'); // `2` on the question, a key typed → openrouter
  });

  it('interactive: masked prompts for both keys; Enter on the Jev prompt reuses the OpenRouter key AND persists it as jevApiKey (the wizard’s reuseGeneratorForJev) with jevProvider openrouter; the prefix hint warns once', async () => {
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
    expect(t.asked).toEqual([JEV_PROVIDER_PROMPT]); // finding 10: --provider openrouter chooses the generator, not the Jev provider; `2` then Enter = reuse
    expect(t.err.text).toContain('this does not look like an openrouter key — Enter again to keep it');
    expect(t.out.text).toContain('Enter = reuse the OpenRouter key for Jev');
    expect(t.out.text.match(/Enter = reuse the OpenRouter key for Jev/g)).toHaveLength(1); // once, before the question
    expect(await readConfig()).toEqual({ provider: 'openrouter', apiKey: 'not-an-openrouter-key-000', jevApiKey: 'not-an-openrouter-key-000', jevProvider: 'openrouter' });
    expect(t.out.text).toContain(`[setup] jev key: entered (sha256:${fingerprint('not-an-openrouter-key-000')}) source=login`);
    expect(t.out.text).toContain('[setup] generator provider: openrouter (--provider)');
    expect(t.out.text).not.toContain('not-an-openrouter-key-000');
    // an inferred openrouter Jev provider (JEV_API_KEY set) skips the question; the hint then precedes the key prompt
    await rm(configPath());
    const inferred = io(null, { readMasked: async (p) => (p.startsWith('OpenRouter') ? OR_KEY : ''), env: { XDG_CONFIG_HOME: join(home, 'xdg'), JEV_API_KEY: 'something-set-1234' } });
    expect(await commandLogin({ provider: 'openrouter' }, inferred)).toBe(0);
    expect(inferred.asked).toEqual([]);
    expect(inferred.out.text).toContain('Enter = reuse the OpenRouter key for Jev');
    expect(await readConfig()).toEqual({ provider: 'openrouter', apiKey: OR_KEY, jevApiKey: OR_KEY, jevProvider: 'openrouter' });
  });

  it('finding 2: `--provider openrouter --jev-provider typesafe` (or JEV_PROVIDER=typesafe) never reuses the OpenRouter key for Jev — Enter is a skip, a typed key saves as typesafe', async () => {
    const prompts: string[] = [];
    const t = io(null, { readMasked: async (p) => (prompts.push(p), p.startsWith('OpenRouter') ? OR_KEY : '') });
    expect(await commandLogin({ provider: 'openrouter', jevProvider: 'typesafe' }, t)).toBe(0);
    expect(prompts).toEqual(['OpenRouter API key (OPENROUTER_API_KEY): ', 'Jev API key (TYPESAFE_API_KEY): ']);
    expect(t.asked).toEqual([]);
    expect(t.out.text).toContain(`${LOGIN_JEV_SKIP_HINT}\n`);
    expect(t.out.text).not.toContain('reuse the OpenRouter key');
    // the OpenRouter key is NOT saved as a TypeSafe Jev key
    expect(await readConfig()).toEqual({ provider: 'openrouter', apiKey: OR_KEY });
    expect(t.out.text).not.toContain('jev provider:');
    // JEV_PROVIDER=typesafe in the environment: the same
    await rm(configPath());
    const env = io(null, { readMasked: async (p) => (p.startsWith('OpenRouter') ? OR_KEY : ''), env: { XDG_CONFIG_HOME: join(home, 'xdg'), JEV_PROVIDER: 'typesafe' } });
    expect(await commandLogin({ provider: 'openrouter' }, env)).toBe(0);
    expect(env.out.text).not.toContain('reuse the OpenRouter key');
    expect(await readConfig()).toEqual({ provider: 'openrouter', apiKey: OR_KEY });
    // a typed TypeSafe key saves beside its provider
    await rm(configPath());
    const typed = io(null, { readMasked: async (p) => (p.startsWith('OpenRouter') ? OR_KEY : TS_KEY) });
    expect(await commandLogin({ provider: 'openrouter', jevProvider: 'typesafe' }, typed)).toBe(0);
    expect(await readConfig()).toEqual({ provider: 'openrouter', apiKey: OR_KEY, jevApiKey: TS_KEY, jevProvider: 'typesafe' });
    // and the question answered `1` (typesafe) after an openrouter generator: Enter on the TypeSafe prompt is a skip, never a reuse
    await rm(configPath());
    const questions: string[] = [];
    const asked = io(null, { readLine: async (p) => (questions.push(p), '1'), readMasked: async (p) => (p.startsWith('OpenRouter') ? OR_KEY : '') });
    expect(await commandLogin({ provider: 'openrouter' }, asked)).toBe(0);
    expect(questions).toEqual([JEV_PROVIDER_PROMPT]);
    expect(asked.out.text).toContain('Enter = reuse the OpenRouter key for Jev'); // the hint before the question: Enter there would have reused
    expect(await readConfig()).toEqual({ provider: 'openrouter', apiKey: OR_KEY });
  });

  it('finding 11: interactive jev-only with the Jev key already resolving from the environment (or a dotenv the session reads) says so and exits 0 — no second key asked, nothing written; a file-sourced key still prompts', async () => {
    const prompts: string[] = [];
    const t = io(null, {
      readMasked: async (p) => (prompts.push(p), TS_KEY),
      resolveSecrets: async () => new Map<string, Resolved<string>>([['decider.apiKey', { value: TS_KEY, source: 'dotenv:/w/open-assist/.env' }], ['decider.provider', { value: 'typesafe', source: 'derived' }]]),
    });
    expect(await commandLogin({}, t)).toBe(0);
    expect(prompts).toEqual([]);
    expect(t.asked).toEqual([]);
    expect(t.out.text).toBe(`[setup] decider.apiKey: already set from dotenv:/w/open-assist/.env (sha256:${fingerprint(TS_KEY)}) — Jev key step skipped\n`);
    expect(t.out.text).not.toContain(TS_KEY);
    await expect(stat(configPath())).rejects.toThrow();
    const env = io(null, { readMasked: async () => TS_KEY, resolveSecrets: async () => new Map<string, Resolved<string>>([['decider.apiKey', { value: TS_KEY, source: 'env' }]]) });
    expect(await commandLogin({}, env)).toBe(0);
    expect(env.out.text).toContain('already set from env');
    // a key saved in the file is replaceable: the prompt runs, the resolved provider (file, beside its key) skips the question
    await mkdir(join(home, 'xdg', 'jevcode'), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ jevApiKey: OR_KEY, jevProvider: 'typesafe' }));
    const file = io(null, {
      readMasked: async (p) => (prompts.push(p), TS_KEY),
      resolveSecrets: async () => new Map<string, Resolved<string>>([['decider.apiKey', { value: OR_KEY, source: `file:${configPath()}` }], ['decider.provider', { value: 'typesafe', source: `file:${configPath()}` }]]),
    });
    expect(await commandLogin({}, file)).toBe(0);
    expect(file.asked).toEqual([]);
    expect(prompts).toEqual(['Jev API key (TYPESAFE_API_KEY): ']);
    expect(await readConfig()).toEqual({ jevApiKey: TS_KEY, jevProvider: 'typesafe' });
    // the session's resolution (an OPENROUTER_API_KEY in <OPEN_ASSIST_PATH>/.env the local rules never see) decides the provider
    await rm(configPath());
    prompts.length = 0;
    const resolved = io(null, { readMasked: async (p) => (prompts.push(p), OR_KEY), resolveSecrets: async () => new Map<string, Resolved<string>>([['decider.provider', { value: 'openrouter', source: 'derived' }]]) });
    expect(await commandLogin({}, resolved)).toBe(0);
    expect(resolved.asked).toEqual([]);
    expect(prompts).toEqual([JEV_KEY_PROMPT]);
    expect(await readConfig()).toEqual({ jevApiKey: OR_KEY, jevProvider: 'openrouter' });
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
    expect(t.asked).toEqual([]);
    expect(t.out.text).toContain(`[setup] decider.apiKey: already set from env (sha256:${fingerprint(OR_KEY)}) — Jev key step skipped`);
    expect(t.err.text).toBe('');
    expect(await readConfig()).toEqual({ provider: 'anthropic', apiKey: KEY });
    expect(t.out.text).not.toContain(OR_KEY);
    // a dotenv source skips too; a file source does not (the prompt lets the user replace the saved key — the provider question first, nothing infers it)
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
    expect(t3.asked).toEqual([JEV_PROVIDER_PROMPT]);
  });

  it('interactive anthropic: an empty Enter on the Jev prompt skips it (hint `Enter = skip`), leaving jevApiKey untouched; Enter on the provider question skips the step outright; exit 0', async () => {
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
    expect(t.asked).toEqual([JEV_PROVIDER_PROMPT]);
    expect(prompts).toEqual(['Anthropic API key (ANTHROPIC_API_KEY): ', JEV_KEY_PROMPT]);
    expect(t.out.text).toContain(`${LOGIN_JEV_SKIP_HINT}\n`);
    expect(t.out.text).not.toContain('reuse the OpenRouter key');
    expect(t.err.text).toBe('');
    expect(await readConfig()).toEqual({ jevApiKey: OR_KEY, provider: 'anthropic', apiKey: KEY });
    // Enter on the provider question: no key prompt, nothing about Jev written
    const skipped: string[] = [];
    const t2 = io(null, { readLine: async () => '', readMasked: async (p) => (skipped.push(p), KEY) });
    expect(await commandLogin({ provider: 'anthropic' }, t2)).toBe(0);
    expect(skipped).toEqual(['Anthropic API key (ANTHROPIC_API_KEY): ']);
    expect(await readConfig()).toEqual({ jevApiKey: OR_KEY, provider: 'anthropic', apiKey: KEY });
    // `1` on the question → the TypeSafe prompt and jevProvider typesafe beside the key
    const ts: string[] = [];
    const t3 = io(null, { readLine: async () => '1', readMasked: async (p) => (ts.push(p), p.startsWith('Anthropic') ? KEY : TS_KEY) });
    expect(await commandLogin({ provider: 'anthropic' }, t3)).toBe(0);
    expect(ts).toEqual(['Anthropic API key (ANTHROPIC_API_KEY): ', 'Jev API key (TYPESAFE_API_KEY): ']);
    expect(await readConfig()).toEqual({ jevApiKey: TS_KEY, provider: 'anthropic', apiKey: KEY, jevProvider: 'typesafe' });
  });

  it('interactive: Ctrl-C on the Jev prompt (or the provider question) saves the accepted generator key first, then prints the fix block and exits 2', async () => {
    const answers: (string | null)[] = [KEY, null];
    const t = io(null, { readMasked: async () => answers.shift() ?? null });
    expect(await commandLogin({ provider: 'anthropic' }, t)).toBe(2);
    expect(await readConfig()).toEqual({ provider: 'anthropic', apiKey: KEY });
    expect(t.out.text).toContain(`[setup] generator key: entered (sha256:${fingerprint(KEY)}) source=login`);
    expect(t.err.text.split('\n').filter(Boolean)).toEqual(FIX_ANTHROPIC);
    await rm(configPath());
    const t2 = io(null, { readLine: async () => null, readMasked: async () => KEY });
    expect(await commandLogin({ provider: 'anthropic' }, t2)).toBe(2);
    expect(await readConfig()).toEqual({ provider: 'anthropic', apiKey: KEY });
    expect(t2.err.text.split('\n').filter(Boolean)).toEqual(FIX_ANTHROPIC);
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
    expect(t.asked).toEqual([JEV_PROVIDER_PROMPT]); // a TTY may ask what a pipe cannot
    expect(prompts).toEqual(['Anthropic API key (ANTHROPIC_API_KEY): ', JEV_KEY_PROMPT]);
    expect(await readConfig()).toEqual({ provider: 'anthropic', apiKey: KEY, jevApiKey: OR_KEY, jevProvider: 'openrouter' });
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
    // the jev-only twin: Ctrl-C on the provider question → the jev-only fix block
    const t3 = io(null, { readLine: async () => null, readMasked: async () => TS_KEY });
    expect(await commandLogin({}, t3)).toBe(2);
    expect(t3.err.text.split('\n').filter(Boolean)).toEqual(FIX_JEV_ONLY);
    await expect(stat(configPath())).rejects.toThrow();
  });

  it('--provider is validated; JEVCODE_PROVIDER preselects; without --provider and a generator key the default is openrouter (commit 2a92d0b)', async () => {
    const t = io(`${KEY}\n`);
    expect(await commandLogin({ provider: 'gemini', generatorKeyStdin: true }, t)).toBe(2);
    expect(t.err.text).toContain('--provider: expected anthropic|openrouter');
    const t2 = io(`${OR_KEY}\n`, { env: { XDG_CONFIG_HOME: join(home, 'xdg'), JEVCODE_PROVIDER: 'openrouter' } });
    expect(await commandLogin({ generatorKeyStdin: true }, t2)).toBe(0);
    expect((await readConfig())['provider']).toBe('openrouter');
    await rm(configPath());
    const t3 = io(`${OR_KEY}\n`);
    expect(await commandLogin({ generatorKeyStdin: true }, t3)).toBe(0);
    expect(await readConfig()).toEqual({ provider: 'openrouter', apiKey: OR_KEY });
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

  it('--verify runs the injected verifier after saving with the Jev provider: a rejected key exits 2 (§13.5 key rejected), an unreachable provider 5 (api)', async () => {
    const seen: { jevProvider: string | null; jevKey: string | null }[] = [];
    const t = io(`${KEY}\n`, {
      verify: async (input) => {
        seen.push({ jevProvider: input.jevProvider, jevKey: input.jevKey });
        return [{ which: 'generator', ok: input.generatorKey === KEY, text: 'verified: anthropic key ok (3 models listed)' }];
      },
    });
    expect(await commandLogin({ provider: 'anthropic', generatorKeyStdin: true, verify: true }, t)).toBe(0);
    expect(t.out.text).toContain('[setup] verified: anthropic key ok (3 models listed)');
    expect(seen).toEqual([{ jevProvider: null, jevKey: null }]);
    const t2 = io(`${KEY}\n`, { verify: async () => [{ which: 'generator', ok: false, text: 'verification failed: anthropic HTTP 401 — the key was kept; fix it with /login', reason: 'rejected' }] });
    expect(await commandLogin({ provider: 'anthropic', generatorKeyStdin: true, verify: true }, t2)).toBe(2);
    expect(t2.out.text).toContain('[setup] verification failed: anthropic HTTP 401 — the key was kept; fix it with /login');
    expect(await readConfig()).toEqual({ provider: 'anthropic', apiKey: KEY });
    // no reason given = rejected
    const t3 = io(`${KEY}\n`, { verify: async () => [{ which: 'generator', ok: false, text: 'verification failed: x' }] });
    expect(await commandLogin({ provider: 'anthropic', generatorKeyStdin: true, verify: true }, t3)).toBe(2);
    const t4 = io(`${KEY}\n`, { verify: async () => [{ which: 'generator', ok: false, text: 'verification failed: TypeError: fetch failed — the key was kept; fix it with /login', reason: 'unreachable' }] });
    expect(await commandLogin({ provider: 'anthropic', generatorKeyStdin: true, verify: true }, t4)).toBe(5);
    // one rejected + one unreachable: the rejection wins (2); the Jev provider rides along
    const t5 = io(`${KEY}\n${TS_KEY}\n`, {
      verify: async (input) => {
        seen.push({ jevProvider: input.jevProvider, jevKey: input.jevKey });
        return [{ which: 'generator', ok: false, text: 'a', reason: 'unreachable' }, { which: 'jev', ok: false, text: 'b', reason: 'rejected' }];
      },
    });
    expect(await commandLogin({ provider: 'anthropic', jevProvider: 'typesafe', generatorKeyStdin: true, jevKeyStdin: true, verify: true }, t5)).toBe(2);
    expect(seen[1]).toEqual({ jevProvider: 'typesafe', jevKey: TS_KEY });
  });

  it('verifyKeys uses the injected fetch: OpenRouter key endpoint (Bearer), Anthropic models (x-api-key), one priced TypeSafe decision (POST, Bearer, jev-1.13.0); failures become the §24 line', async () => {
    const calls: { url: string; method: string; headers: Record<string, string>; body: string | null }[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? 'GET', headers: (init?.headers as Record<string, string>) ?? {}, body: typeof init?.body === 'string' ? init.body : null });
      if (u.includes('typesafe')) return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { greeting: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 319, output_tokens: 23 } }), { status: 200 });
      if (u.includes('openrouter')) return new Response(JSON.stringify({ data: { label: 'laptop', limit_remaining: 4.12 } }), { status: 200 });
      return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5' }, { id: 'x' }] }), { status: 200 });
    }) as typeof fetch;
    const res = await verifyKeys({ provider: 'anthropic', jevProvider: 'openrouter', generatorKey: KEY, jevKey: OR_KEY }, f, 1000);
    expect(res).toEqual([
      { which: 'generator', ok: true, text: 'verified: anthropic key ok (2 models listed)' },
      { which: 'jev', ok: true, text: 'verified: openrouter key ok (label "laptop", limit remaining $4.12)' },
    ]);
    expect(calls[0]!.headers['x-api-key']).toBe(KEY);
    expect(calls[1]!.headers['authorization']).toBe(`Bearer ${OR_KEY}`);
    // TUI-DESIGN-2 §2.7: the typesafe check is one decision at api.typesafe.ai — no referer / title, the pinned model, the one-Noul probe
    calls.length = 0;
    const ts = await verifyKeys({ provider: 'anthropic', jevProvider: 'typesafe', generatorKey: null, jevKey: TS_KEY }, f, 1000);
    expect(ts).toEqual([{ which: 'jev', ok: true, text: 'verified: typesafe key ok (jev-1.13.0, 319 input tokens)' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['Authorization']).toBe(`Bearer ${TS_KEY}`);
    expect(calls[0]!.headers['HTTP-Referer']).toBeUndefined();
    const body = JSON.parse(calls[0]!.body ?? '{}') as { model: string; state: unknown; questions: Record<string, unknown> };
    expect(body.model).toBe('jev-1.13.0');
    expect(body.state).toEqual({ message: 'hi' });
    expect(Object.keys(body.questions)).toEqual(['greeting']);
    // an openrouter Jev key never reaches api.typesafe.ai and a typesafe key never reaches openrouter.ai
    calls.length = 0;
    await verifyKeys({ provider: 'openrouter', jevProvider: 'openrouter', generatorKey: OR_KEY, jevKey: OR_KEY }, f, 1000);
    expect(calls.map((c) => c.url)).toEqual(['https://openrouter.ai/api/v1/key']);
    const rejecting = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    const bad = await verifyKeys({ provider: 'openrouter', jevProvider: 'openrouter', generatorKey: OR_KEY, jevKey: OR_KEY }, rejecting, 1000);
    expect(bad).toEqual([{ which: 'generator', ok: false, text: 'verification failed: openrouter HTTP 401 — the key was kept; fix it with /login', reason: 'rejected' }]);
    const badTs = await verifyKeys({ provider: 'openrouter', jevProvider: 'typesafe', generatorKey: null, jevKey: TS_KEY }, rejecting, 1000);
    expect(badTs).toEqual([{ which: 'jev', ok: false, text: 'verification failed: typesafe HTTP 401 — the key was kept; fix it with /login', reason: 'rejected' }]);
    const throwing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const net = await verifyKeys({ provider: 'anthropic', jevProvider: null, generatorKey: KEY, jevKey: null }, throwing, 1000);
    expect(net[0]!.text).toBe('verification failed: TypeError: fetch failed — the key was kept; fix it with /login');
    expect(net[0]!.reason).toBe('unreachable');
    const netTs = await verifyKeys({ provider: 'anthropic', jevProvider: 'typesafe', generatorKey: null, jevKey: TS_KEY }, throwing, 1000);
    expect(netTs).toEqual([{ which: 'jev', ok: false, text: 'verification failed: TypeError: fetch failed — the key was kept; fix it with /login', reason: 'unreachable' }]);
    expect(await verifyKeys({ provider: 'anthropic', jevProvider: null, generatorKey: null, jevKey: null }, throwing, 1000)).toEqual([]);
  });
});

describe('commandLogout', () => {
  it('removes both keys by default, one with a flag, reports fingerprints, and names env-sourced keys it does not touch', async () => {
    const t0 = io(`${KEY}\n${OR_KEY}\n`);
    await commandLogin({ provider: 'anthropic', jevProvider: 'openrouter', generatorKeyStdin: true, jevKeyStdin: true }, t0);
    const t = io(null, { resolveSecrets: async () => new Map<string, Resolved<string>>([['generator.apiKey', { value: 'env-key-value-000', source: 'env' }]]) });
    expect(await commandLogout({ generator: true }, t)).toBe(0);
    expect(t.out.text.split('\n').filter(Boolean)).toEqual([
      `[setup] removed generator key (sha256:${fingerprint(KEY)}) from ~/xdg/jevcode/config.json`,
      `[setup] generator.apiKey is also set from env (sha256:${fingerprint('env-key-value-000')}) — not touched`,
    ]);
    expect(await readConfig()).toEqual({ provider: 'anthropic', jevApiKey: OR_KEY, jevProvider: 'openrouter' });
    const t2 = io(null);
    expect(await commandLogout({}, t2)).toBe(0);
    expect(t2.out.text).toContain(`removed jev key (sha256:${fingerprint(OR_KEY)})`);
    expect(t2.out.text).toContain('generator key: not in ~/xdg/jevcode/config.json');
    const after = await readConfig();
    expect(after).toMatchObject({ provider: 'anthropic' });
    expect(after['jevApiKey']).toBeUndefined();
    expect(after['apiKey']).toBeUndefined();
  });

  it('finding 3: after `logout --jev` the `jevProvider` note left in the file is never trusted — a flagless piped --jev-key-stdin exits 2 with the usage line; the flag rewrites the note beside the new key', async () => {
    const t0 = io(`${TS_KEY}\n`);
    expect(await commandLogin({ jevKeyStdin: true, jevProvider: 'typesafe' }, t0)).toBe(0);
    expect(await readConfig()).toEqual({ jevApiKey: TS_KEY, jevProvider: 'typesafe' });
    const out = io(null);
    expect(await commandLogout({ jev: true }, out)).toBe(0);
    expect(out.out.text).toContain(`removed jev key (sha256:${fingerprint(TS_KEY)})`);
    expect((await readConfig())['jevApiKey']).toBeUndefined();
    // the stale note (S1's removeCredentials keeps it today) is not a chosen provider: nothing infers → exit 2, nothing written
    const t = io(`${OR_KEY}\n`);
    expect(await commandLogin({ jevKeyStdin: true }, t)).toBe(2);
    expect(t.err.text).toBe(`${LOGIN_JEV_PROVIDER_REQUIRED}\n`);
    expect(t.out.text).toBe('');
    expect((await readConfig())['jevApiKey']).toBeUndefined();
    // the interactive twin asks instead of inferring typesafe from the note
    const ask = io(null, { readMasked: async () => OR_KEY });
    expect(await commandLogin({}, ask)).toBe(0);
    expect(ask.asked).toEqual([JEV_PROVIDER_PROMPT]);
    expect(await readConfig()).toEqual({ jevApiKey: OR_KEY, jevProvider: 'openrouter' });
    // the same with the session's resolution reporting the note as a `file:` source: still not trusted without a saved key
    await commandLogout({ jev: true }, io(null));
    const viaResolver = io(`${OR_KEY}\n`, { resolveSecrets: async () => new Map<string, Resolved<string>>([['decider.provider', { value: 'typesafe', source: `file:${configPath()}` }]]) });
    expect(await commandLogin({ jevKeyStdin: true }, viaResolver)).toBe(2);
    expect(viaResolver.err.text).toBe(`${LOGIN_JEV_PROVIDER_REQUIRED}\n`);
    const flagged = io(`${OR_KEY}\n`);
    expect(await commandLogin({ jevKeyStdin: true, jevProvider: 'openrouter' }, flagged)).toBe(0);
    expect(await readConfig()).toEqual({ jevApiKey: OR_KEY, jevProvider: 'openrouter' });
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
