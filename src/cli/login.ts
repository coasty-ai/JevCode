/**
 * `jevcode login` / `jevcode logout` / `jevcode config set` (TUI-DESIGN §11.2, §16, A125, D5).
 * Pure command handlers over an injected `CommandIo`: keys arrive on stdin — one line per
 * `--*-stdin` flag on a pipe, or a masked `node:readline` prompt with its output muted on a TTY
 * (`--plain`; the Ink masked field is the wizard's) — and leave only as fingerprints. Secret
 * settings are refused as arguments. Zero network unless `--verify` is asked for. Every line is
 * written through `io.stdout` / `io.stderr`, never `console`.
 *
 * The interactive twin mirrors the wizard (§11.1): the Jev step is skipped when `decider.apiKey`
 * already resolves from the environment or a dotenv file, an empty Enter on it is a skip (or,
 * under openrouter, "reuse the OpenRouter key for Jev", persisted as `jevApiKey` exactly like the
 * wizard's `reuseGeneratorForJev`), and an accepted generator key is saved before a cancelled
 * Jev step fails the command.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { SETTINGS } from '../config/defaults.js';
import { credentialsPath, displayPath, readCredentialsFile, removeCredentials, writeConfigValue, writeCredentials, type CredentialKey, type CredentialsPatch } from '../config/credentials.js';
import { fingerprint } from '../core/hash.js';
import { MIN_SECRET_LENGTH } from '../core/redact.js';
import type { Resolved, SecretSettingName } from '../core/types.js';
import { ConfigError, EXIT_CODES } from '../errors.js';
import { PROVIDER_DISPLAY, PROVIDER_ENV, WIZARD_REUSE_HINT, fixBlockLines, verificationFailedText, verifiedText } from '../tui/onboarding/lines.js';
import { HINT_TOO_SHORT, hintPrefix, looksLikeKey, sanitizeKeyInput, type WizardProvider } from '../tui/onboarding/reducer.js';

/** TUI-DESIGN §24 (CLI): the refusal for `jevcode config set generator.apiKey …` and friends. */
export const SECRET_AS_ARGUMENT_REFUSED = "secret settings are set with 'jevcode login' (stdin or masked prompt), never as an argument";
/** `jevcode login` on a pipe without a `--*-stdin` flag. */
export const LOGIN_NEEDS_TTY_OR_STDIN = 'jevcode login: stdin is not a terminal; pipe the key with --generator-key-stdin and/or --jev-key-stdin';
/** The Jev prompt's hint when the generator is not openrouter (an empty Enter leaves `jevApiKey` untouched). */
export const LOGIN_JEV_SKIP_HINT = 'Enter = skip';
/** TUI-DESIGN §11.1: the Jev prompt text (the §24 title without its `2/2` counter, as a readline prompt). */
export const JEV_KEY_PROMPT = 'Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY): ';
/** TUI-DESIGN §11.1: verification timeout. */
export const VERIFY_TIMEOUT_MS = 5000;
/** masked prompt attempts before giving up */
export const MAX_PROMPT_ATTEMPTS = 3;

/** TUI-DESIGN §11.2: `jevcode login` flags. */
export interface LoginFlags {
  provider?: string;
  generatorKeyStdin?: boolean;
  jevKeyStdin?: boolean;
  status?: boolean;
  verify?: boolean;
  /** `--config <file>` */
  config?: string;
}
/** TUI-DESIGN §11.2: `jevcode logout` flags. */
export interface LogoutFlags {
  generator?: boolean;
  jev?: boolean;
  config?: string;
}

/** TUI-DESIGN §11.1: what `--verify` checks. */
export interface VerifyInput {
  provider: WizardProvider;
  generatorKey: string | null;
  jevKey: string | null;
}
/** TUI-DESIGN §11.1: one verification outcome (status only). */
export interface VerifyResult {
  which: 'generator' | 'jev';
  ok: boolean;
  /** the `[setup] …` item text (`verified: …` / `verification failed: …`) */
  text: string;
  /** why it failed: the provider rejected the key (exit 2, §13.5) or it could not be reached (exit 5); absent = rejected */
  reason?: 'rejected' | 'unreachable';
}

/** TUI-DESIGN §11.2: the command handlers' I/O seam — streams, env, home, cwd and injectable readers. */
export interface CommandIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  platform?: NodeJS.Platform;
  /** masked prompt (default: `readMaskedLine` over stdin/stdout); null = cancelled (Ctrl-C / EOF) */
  readMasked?: (prompt: string) => Promise<string | null>;
  /** the resolved secret entries (`generator.apiKey`, `decider.apiKey`) for `--status`, logout reporting and the Jev-step skip */
  resolveSecrets?: () => Promise<ReadonlyMap<string, Resolved<string>>>;
  /** key verification (default: `verifyKeys` over `fetch`) */
  verify?: (input: VerifyInput) => Promise<VerifyResult[]>;
  fetch?: typeof fetch;
}

/**
 * TUI-DESIGN §11.2: a masked line from `input` via `node:readline` with the output muted after
 * the prompt — nothing typed is echoed, history is off; readline's own line editing applies
 * (Backspace deletes, bracketed-paste markers are unknown keys and dropped). Resolves null on
 * Ctrl-C or EOF.
 */
export function readMaskedLine(prompt: string, input: NodeJS.ReadableStream, output: { write(s: string): unknown }): Promise<string | null> {
  let muted = false;
  const sink = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      if (!muted) output.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  const rl = createInterface({ input, output: sink, terminal: true, historySize: 0 });
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null): void => {
      if (done) return;
      done = true;
      muted = true;
      rl.close();
      output.write('\n');
      resolve(v);
    };
    rl.on('close', () => finish(null));
    rl.on('SIGINT', () => finish(null));
    rl.question(prompt, (answer) => finish(answer));
    muted = true;
  });
}

/** Read up to `n` lines from a piped stdin (Codex's `--*-stdin` shape: one key per line). */
export function readStdinLines(stdin: NodeJS.ReadableStream, n: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      const lines = buf.split(/\r?\n/);
      resolve(lines.slice(0, Math.max(0, n)));
    };
    stdin.on('data', (chunk: Buffer | string) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const count = buf.split(/\r?\n/).length - 1;
      if (count >= n) {
        finish();
        if ('pause' in stdin && typeof stdin.pause === 'function') stdin.pause();
      }
    });
    stdin.on('end', finish);
    stdin.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

function parseProvider(s: string | undefined): WizardProvider | null {
  const t = s?.trim().toLowerCase();
  return t === 'anthropic' || t === 'openrouter' ? t : null;
}

async function defaultProvider(flags: LoginFlags, io: CommandIo): Promise<WizardProvider> {
  const fromFlag = parseProvider(flags.provider);
  if (fromFlag) return fromFlag;
  if (flags.provider !== undefined) throw new ConfigError(`--provider: expected anthropic|openrouter, got "${flags.provider}"`, { setting: 'generator.provider' });
  const fromEnv = parseProvider(io.env['JEVCODE_PROVIDER']);
  if (fromEnv) return fromEnv;
  const file = await readCredentialsFile(credentialsPath({ env: io.env, home: io.home, cwd: io.cwd, configFlag: flags.config ?? null }).path);
  return parseProvider(file.provider ?? undefined) ?? 'anthropic';
}

/** Sanitise and length-check one key line; null when too short. */
export function acceptKey(raw: string): string | null {
  const k = sanitizeKeyInput(raw);
  return k.length >= MIN_SECRET_LENGTH ? k : null;
}

const CANCELLED = Symbol('cancelled');
type PromptOutcome = string | null | typeof CANCELLED;

/**
 * One masked prompt with up to MAX_PROMPT_ATTEMPTS answers: too short re-prompts, a prefix
 * mismatch warns once (the next answer is kept), an empty answer is `null` when `allowEmpty`,
 * Ctrl-C/EOF or three failed attempts → CANCELLED.
 */
async function promptKey(io: CommandIo, prompt: string, provider: WizardProvider | null, allowEmpty: boolean): Promise<PromptOutcome> {
  const read = io.readMasked ?? ((p: string) => readMaskedLine(p, io.stdin, io.stdout));
  let warned = false;
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
    const raw = await read(prompt);
    if (raw === null) return CANCELLED;
    const clean = sanitizeKeyInput(raw);
    if (clean.length === 0 && allowEmpty) return null;
    if (clean.length < MIN_SECRET_LENGTH) {
      io.stderr.write(`jevcode: ${HINT_TOO_SHORT}\n`);
      continue;
    }
    if (provider && !looksLikeKey(clean, provider) && !warned) {
      io.stderr.write(`jevcode: ${hintPrefix(provider)}\n`);
      warned = true;
      continue;
    }
    return clean;
  }
  return CANCELLED;
}

function printFix(io: CommandIo): void {
  for (const l of fixBlockLines()) io.stderr.write(`${l}\n`);
}

function generatorPrompt(provider: WizardProvider): string {
  return `${PROVIDER_DISPLAY[provider]} API key (${PROVIDER_ENV[provider]}): `;
}

async function statusLines(io: CommandIo): Promise<{ lines: string[]; ok: boolean }> {
  if (!io.resolveSecrets) return { lines: ['generator.apiKey: unknown (no resolver)', 'decider.apiKey: unknown (no resolver)'], ok: false };
  const entries = await io.resolveSecrets();
  const lines: string[] = [];
  let ok = true;
  for (const name of ['generator.apiKey', 'decider.apiKey'] as const) {
    const r = entries.get(name);
    if (r && r.value.trim() !== '') lines.push(`${name}: ${r.source} (sha256:${fingerprint(r.value.trim())})`);
    else {
      lines.push(`${name}: not set`);
      ok = false;
    }
  }
  return { lines, ok };
}

/** TUI-DESIGN §11.1: `decider.apiKey` already resolves from `JEV_API_KEY`/`OPENROUTER_API_KEY` (env or dotenv) → the Jev step is skipped. */
async function jevResolvedFromEnv(io: CommandIo): Promise<Resolved<string> | null> {
  if (!io.resolveSecrets) return null;
  const r = (await io.resolveSecrets()).get('decider.apiKey');
  if (!r || r.value.trim() === '') return null;
  return r.source === 'env' || r.source.startsWith('dotenv:') ? r : null;
}

/**
 * TUI-DESIGN §11.1 verification with an injectable `fetch`: OpenRouter `GET /api/v1/key` and
 * Anthropic `GET /v1/models`, 5 s each, status only in the output. The Jev key is checked
 * through the OpenRouter key endpoint (it is an OpenRouter key); the priced one-decision probe
 * belongs to the wizard's host, not this CLI. A non-2xx answer is `rejected`; a thrown fetch
 * (DNS, timeout, refused) is `unreachable`.
 */
export async function verifyKeys(input: VerifyInput, f: typeof fetch = fetch, timeoutMs = VERIFY_TIMEOUT_MS): Promise<VerifyResult[]> {
  const out: VerifyResult[] = [];
  const short = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 120);
  async function openrouterKey(which: 'generator' | 'jev', key: string): Promise<VerifyResult> {
    try {
      const res = await f('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { which, ok: false, text: verificationFailedText(`openrouter HTTP ${res.status}`), reason: 'rejected' };
      const body = (await res.json()) as { data?: { label?: unknown; limit_remaining?: unknown } };
      const label = typeof body.data?.label === 'string' ? body.data.label : '';
      const limit = typeof body.data?.limit_remaining === 'number' ? body.data.limit_remaining : null;
      return { which, ok: true, text: verifiedText('openrouter', label, limit) };
    } catch (e) {
      return { which, ok: false, text: verificationFailedText(short(e)), reason: 'unreachable' };
    }
  }
  async function anthropicKey(key: string): Promise<VerifyResult> {
    try {
      const res = await f('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { which: 'generator', ok: false, text: verificationFailedText(`anthropic HTTP ${res.status}`), reason: 'rejected' };
      const body = (await res.json()) as { data?: unknown[] };
      const n = Array.isArray(body.data) ? body.data.length : 0;
      return { which: 'generator', ok: true, text: `verified: anthropic key ok (${n} models listed)` };
    } catch (e) {
      return { which: 'generator', ok: false, text: verificationFailedText(short(e)), reason: 'unreachable' };
    }
  }
  if (input.generatorKey) out.push(input.provider === 'anthropic' ? await anthropicKey(input.generatorKey) : await openrouterKey('generator', input.generatorKey));
  if (input.jevKey && input.jevKey !== input.generatorKey) out.push(await openrouterKey('jev', input.jevKey));
  return out;
}

/** Write the patch and print its items/warnings; the exit code (0, or 2 on a ConfigError, 1 otherwise). */
async function save(patch: CredentialsPatch, source: 'login' | 'stdin', flags: LoginFlags, io: CommandIo): Promise<number> {
  try {
    const result = await writeCredentials(patch, { env: io.env, home: io.home, cwd: io.cwd, configFlag: flags.config ?? null, ...(io.platform ? { platform: io.platform } : {}) }, source);
    for (const item of result.items) io.stdout.write(`[setup] ${item}\n`);
    for (const w of result.warnings) io.stderr.write(`jevcode: ${w}\n`);
    return EXIT_CODES.ok;
  } catch (e) {
    io.stderr.write(`jevcode: ${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof ConfigError ? EXIT_CODES.config : EXIT_CODES.unexpected;
  }
}

/**
 * TUI-DESIGN §11.2: `jevcode login [--provider …] [--generator-key-stdin] [--jev-key-stdin] [--status] [--verify]`.
 * Returns the exit code: 0 saved; 2 cancelled, refused or a rejected key under `--verify`
 * (§13.5: key rejected = 2); 5 when `--verify` could not reach the provider at all.
 */
export async function commandLogin(flags: LoginFlags, io: CommandIo): Promise<number> {
  if (flags.status) {
    const { lines, ok } = await statusLines(io);
    for (const l of lines) io.stdout.write(`${l}\n`);
    return ok ? EXIT_CODES.ok : EXIT_CODES.unexpected;
  }
  let provider: WizardProvider;
  try {
    provider = await defaultProvider(flags, io);
  } catch (e) {
    io.stderr.write(`jevcode: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_CODES.config;
  }
  const patch: CredentialsPatch = { provider };
  let source: 'login' | 'stdin' = 'login';
  const wantGenerator = flags.generatorKeyStdin === true;
  const wantJev = flags.jevKeyStdin === true;
  const interactive = io.stdin.isTTY === true || io.readMasked !== undefined;

  if (wantGenerator || wantJev) {
    if (interactive) {
      // A terminal cannot deliver a "stdin line" without echoing it: the flagged keys are asked for masked instead.
      if (wantGenerator) {
        const k = await promptKey(io, generatorPrompt(provider), provider, false);
        if (k === CANCELLED || k === null) {
          printFix(io);
          return EXIT_CODES.config;
        }
        patch.apiKey = k;
      }
      if (wantJev) {
        const k = await promptKey(io, JEV_KEY_PROMPT, null, false);
        if (k === CANCELLED || k === null) {
          if (patch.apiKey !== undefined) {
            const code = await save(patch, source, flags, io);
            if (code !== EXIT_CODES.ok) return code;
          }
          printFix(io);
          return EXIT_CODES.config;
        }
        patch.jevApiKey = k;
      }
    } else {
      source = 'stdin';
      const lines = await readStdinLines(io.stdin, (wantGenerator ? 1 : 0) + (wantJev ? 1 : 0));
      let idx = 0;
      if (wantGenerator) {
        const k = acceptKey(lines[idx++] ?? '');
        if (!k) {
          io.stderr.write(`jevcode: generator.apiKey: ${HINT_TOO_SHORT} (first stdin line)\n`);
          return EXIT_CODES.config;
        }
        patch.apiKey = k;
      }
      if (wantJev) {
        const k = acceptKey(lines[idx++] ?? '');
        if (!k) {
          io.stderr.write(`jevcode: decider.apiKey: ${HINT_TOO_SHORT} (${wantGenerator ? 'second' : 'first'} stdin line)\n`);
          return EXIT_CODES.config;
        }
        patch.jevApiKey = k;
      }
    }
  } else if (interactive) {
    const gen = await promptKey(io, generatorPrompt(provider), provider, false);
    if (gen === CANCELLED || gen === null) {
      printFix(io);
      return EXIT_CODES.config;
    }
    patch.apiKey = gen;
    const resolved = await jevResolvedFromEnv(io);
    if (resolved) {
      io.stdout.write(`[setup] decider.apiKey: already set from ${resolved.source} (sha256:${fingerprint(resolved.value.trim())}) — Jev key step skipped\n`);
    } else {
      io.stdout.write(`${provider === 'openrouter' ? WIZARD_REUSE_HINT : LOGIN_JEV_SKIP_HINT}\n`);
      const jev = await promptKey(io, JEV_KEY_PROMPT, null, true);
      if (jev === CANCELLED) {
        // The generator key was accepted: save it before failing on the Jev step.
        const code = await save(patch, source, flags, io);
        if (code !== EXIT_CODES.ok) return code;
        printFix(io);
        return EXIT_CODES.config;
      }
      if (jev !== null) patch.jevApiKey = jev;
      else if (provider === 'openrouter') patch.jevApiKey = gen;
    }
  } else {
    io.stderr.write(`${LOGIN_NEEDS_TTY_OR_STDIN}\n`);
    printFix(io);
    return EXIT_CODES.config;
  }

  const saved = await save(patch, source, flags, io);
  if (saved !== EXIT_CODES.ok) return saved;

  if (flags.verify) {
    const verify = io.verify ?? ((input: VerifyInput) => verifyKeys(input, io.fetch ?? fetch));
    const results = await verify({ provider, generatorKey: patch.apiKey ?? null, jevKey: patch.jevApiKey ?? null });
    for (const r of results) io.stdout.write(`[setup] ${r.text}\n`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) return failed.every((r) => r.reason === 'unreachable') ? EXIT_CODES.api : EXIT_CODES.config;
  }
  return EXIT_CODES.ok;
}

/** TUI-DESIGN §11.2: `jevcode logout [--generator] [--jev]` — rewrites the file atomically; env-sourced keys are reported, never touched. */
export async function commandLogout(flags: LogoutFlags, io: CommandIo): Promise<number> {
  const keys: CredentialKey[] = [];
  if (flags.generator || (!flags.generator && !flags.jev)) keys.push('apiKey');
  if (flags.jev || (!flags.generator && !flags.jev)) keys.push('jevApiKey');
  try {
    const result = await removeCredentials(keys, { env: io.env, home: io.home, cwd: io.cwd, configFlag: flags.config ?? null, ...(io.platform ? { platform: io.platform } : {}) });
    for (const item of result.items) io.stdout.write(`[setup] ${item}\n`);
  } catch (e) {
    io.stderr.write(`jevcode: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_CODES.config;
  }
  if (io.resolveSecrets) {
    const entries = await io.resolveSecrets();
    const names: Record<CredentialKey, SecretSettingName> = { apiKey: 'generator.apiKey', jevApiKey: 'decider.apiKey' };
    for (const k of keys) {
      const r = entries.get(names[k]);
      if (r && (r.source === 'env' || r.source.startsWith('dotenv:') || r.source === 'flag')) {
        io.stdout.write(`[setup] ${names[k]} is also set from ${r.source} (sha256:${fingerprint(r.value.trim())}) — not touched\n`);
      }
    }
  }
  return EXIT_CODES.ok;
}

/** TUI-DESIGN §16: `jevcode config set <setting> <value>` — non-secret settings only, written to the XDG file atomically. */
export async function commandConfigSet(setting: string, value: string, io: CommandIo, flags: { config?: string } = {}): Promise<number> {
  const name = setting.trim();
  const spec = SETTINGS.find((s) => s.name === name || s.fileKey === name);
  if (!spec) {
    io.stderr.write(`jevcode: unknown setting "${setting}"; run 'jevcode config' to list them\n`);
    return EXIT_CODES.config;
  }
  if (spec.secret) {
    io.stderr.write(`jevcode: ${SECRET_AS_ARGUMENT_REFUSED}\n`);
    return EXIT_CODES.config;
  }
  if (!spec.fileKey) {
    io.stderr.write(`jevcode: ${spec.name} cannot be stored in the config file; pass it as a flag or set ${spec.env[0] ?? 'the variable'}\n`);
    return EXIT_CODES.config;
  }
  if (value.trim() === '') {
    io.stderr.write(`jevcode: ${spec.name}: a value is required\n`);
    return EXIT_CODES.config;
  }
  try {
    const r = await writeConfigValue(spec.fileKey, value, { env: io.env, home: io.home, cwd: io.cwd, configFlag: flags.config ?? null, ...(io.platform ? { platform: io.platform } : {}) });
    io.stdout.write(`${spec.name} = ${value}  (file:${r.displayPath})\n`);
    return EXIT_CODES.ok;
  } catch (e) {
    io.stderr.write(`jevcode: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_CODES.config;
  }
}

/** Where `login` writes, for `--help` and the fix block: the XDG file unless `--config`/`JEVCODE_CONFIG`. */
export function loginTargetDisplay(io: Pick<CommandIo, 'env' | 'home' | 'cwd'>, configFlag: string | null = null): string {
  return displayPath(credentialsPath({ env: io.env, home: io.home, cwd: io.cwd, configFlag }).path, io.home);
}
