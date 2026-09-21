/**
 * `jevcode login` / `jevcode logout` / `jevcode config set` (TUI-DESIGN §11.2, §16, A125, D5; TUI-DESIGN-2 §1.4, §2.3, §2.7).
 * Pure command handlers over an injected `CommandIo`: keys arrive on stdin — one line per
 * `--*-stdin` flag on a pipe, or a masked `node:readline` prompt with its output muted on a TTY
 * (`--plain`; the Ink masked field is the wizard's) — and leave only as fingerprints. Secret
 * settings are refused as arguments. Zero network unless `--verify` is asked for. Every line is
 * written through `io.stdout` / `io.stderr`, never `console`.
 *
 * The interactive twin mirrors the wizard (§11.1, TUI-DESIGN-2 §1.4): under jev-only (the default mode) and without
 * `--provider` only the Jev key is asked for; the generator step runs when `--provider` is given or the mode needs a
 * generator (`JEVCODE_MODE`, `./.env`, the file's `mode` key). The Jev provider is `--jev-provider`, else the session's own
 * resolution of `decider.provider` (`io.resolveSecrets()`: `JEV_PROVIDER`, `./.env`, `<OPEN_ASSIST_PATH>/.env`, the
 * file's `jevProvider`, then §2.3 rules 2a–2d), else — without a resolver — the same rules over the process env and
 * `./.env`. A `jevProvider` note left in the file after `logout --jev` (no `jevApiKey` beside it) is not a chosen provider.
 * The generator provider never infers the Jev provider: the one shortcut is the wizard's reuse — the OpenRouter key just
 * typed (or piped twice) serves Jev, and only then is the Jev provider openrouter. When nothing infers it a TTY asks
 * `Where do you reach Jev?  1 typesafe  2 openrouter` (Enter = reuse the OpenRouter key / skip) and a pipe exits 2.
 * Whenever the provider is known it is written as `jevProvider` beside `jevApiKey`, so a TypeSafe key saved on a machine
 * without `TYPESAFE_API_KEY` exported never resolves to openrouter and is never sent to openrouter.ai; the generator
 * provider is written only with a generator key and named (`[setup] generator provider: <p> (<why>)`).
 * The Jev step is skipped when `decider.apiKey` already resolves from the environment or a dotenv file (the jev-only
 * login says so and exits 0 — the piped `--jev-key-stdin` still writes), and an accepted generator key is saved before a
 * cancelled Jev step fails the command.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { join } from 'node:path';
import { DEFAULT_PROVIDER, SETTINGS } from '../config/defaults.js';
import { credentialsPath, displayPath, readCredentialsFile, removeCredentials, writeConfigValue, writeCredentials, type CredentialKey, type CredentialsFile, type CredentialsPatch } from '../config/credentials.js';
import { readDotenv } from '../config/env.js';
import { fingerprint } from '../core/hash.js';
import { MIN_SECRET_LENGTH } from '../core/redact.js';
import type { EngineMode, JevProvider, Resolved, SecretSettingName } from '../core/types.js';
import { ConfigError, EXIT_CODES } from '../errors.js';
import { JEV_PROVIDERS, providerForHost } from '../jev/providers.js';
import { noul, ref } from '../jev/questions.js';
import { DEFAULT_REFERER } from '../jev/types.js';
import { LOGIN_JEV_PROVIDER_PROMPT, LOGIN_JEV_PROVIDER_REQUIRED, PROVIDER_DISPLAY, PROVIDER_ENV, WIZARD_REUSE_HINT, fixBlockLines, jevKeyTitle, verificationFailedText, verifiedText, verifiedTypesafeText } from '../tui/onboarding/lines.js';
import { HINT_TOO_SHORT, hintPrefix, looksLikeKey, sanitizeKeyInput, type WizardProvider } from '../tui/onboarding/reducer.js';

/** TUI-DESIGN §24 (CLI): the refusal for `jevcode config set generator.apiKey …` and friends. */
export const SECRET_AS_ARGUMENT_REFUSED = "secret settings are set with 'jevcode login' (stdin or masked prompt), never as an argument";
/** `jevcode login` on a pipe without a `--*-stdin` flag. */
export const LOGIN_NEEDS_TTY_OR_STDIN = 'jevcode login: stdin is not a terminal; pipe the key with --generator-key-stdin and/or --jev-key-stdin';
/** The Jev prompt's hint when the generator is not openrouter (an empty Enter leaves `jevApiKey` untouched). */
export const LOGIN_JEV_SKIP_HINT = 'Enter = skip';
/** TUI-DESIGN-2 §1.4: why `jevcode login` used this generator provider (printed beside a saved generator key, never silently) */
export type GeneratorProviderWhy = '--provider' | 'JEVCODE_PROVIDER' | 'file' | 'default';
/** `[setup] generator provider: openrouter (default)` — the generator provider is written only with a generator key, and named */
export function generatorProviderText(provider: WizardProvider, why: GeneratorProviderWhy): string {
  return `generator provider: ${provider} (${why})`;
}
/** TUI-DESIGN §11.1: the OpenRouter Jev prompt text (the §24 title without its counter, as a readline prompt); `jevKeyPrompt` keys it by provider. */
export const JEV_KEY_PROMPT = 'Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY): ';
/** TUI-DESIGN-2 §12 "Wizard": the provider question as a readline prompt (a plain line; nothing secret is typed there). */
export const JEV_PROVIDER_PROMPT = `${LOGIN_JEV_PROVIDER_PROMPT}: `;
/** TUI-DESIGN §11.1: verification timeout. */
export const VERIFY_TIMEOUT_MS = 5000;
/** masked prompt attempts before giving up */
export const MAX_PROMPT_ATTEMPTS = 3;
/** TUI-DESIGN-2 §2.7: the one-Noul probe state of the typesafe verification (nothing from the workspace) */
export const VERIFY_PROBE_STATE = { message: 'hi' } as const;

/** TUI-DESIGN §11.2 / TUI-DESIGN-2 §1.4: `jevcode login` flags. */
export interface LoginFlags {
  provider?: string;
  /** `--jev-provider typesafe|openrouter` (`auto` = infer, like an absent flag) */
  jevProvider?: string;
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

/** TUI-DESIGN §11.1 / TUI-DESIGN-2 §2.7: what `--verify` checks; `jevProvider` keys the Jev check (null = no Jev key to check, or openrouter). */
export interface VerifyInput {
  provider: WizardProvider;
  jevProvider: JevProvider | null;
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
  /** TUI-DESIGN-2 §1.4: the plain (echoed) provider question; default `readPlainLine` over stdin/stdout; null = cancelled */
  readLine?: (prompt: string) => Promise<string | null>;
  /**
   * the resolved entries `generator.apiKey`, `decider.apiKey` (for `--status`, logout reporting and the Jev-step skip) and — TUI-DESIGN-2
   * §2.3 — `decider.provider` (the session's own provider resolution, `resolvedJevProvider`); `main.tsx` builds it from `resolveConfig`
   */
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

/** TUI-DESIGN-2 §1.4: a plain echoed line (the provider question) — history off; null on Ctrl-C or EOF. */
export function readPlainLine(prompt: string, input: NodeJS.ReadableStream & { isTTY?: boolean }, output: { write(s: string): unknown }): Promise<string | null> {
  const sink = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      output.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  const rl = createInterface({ input, output: sink, terminal: input.isTTY === true, historySize: 0 });
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null): void => {
      if (done) return;
      done = true;
      rl.close();
      resolve(v);
    };
    rl.on('close', () => finish(null));
    rl.on('SIGINT', () => finish(null));
    rl.question(prompt, (answer) => finish(answer));
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

/** TUI-DESIGN-2 §2.3: `typesafe` | `openrouter`; `auto`, empty and unknown are null (the caller decides whether that is an error). */
export function parseJevProvider(s: string | undefined): JevProvider | null {
  const t = s?.trim().toLowerCase();
  return t === 'typesafe' || t === 'openrouter' ? t : null;
}

function parseMode(s: string | undefined): EngineMode | null {
  const t = s?.trim().toLowerCase();
  return t === 'jev-only' || t === 'jev-on' || t === 'jev-off' || t === 'llm-jev' ? t : null;
}

/** the process env first, then `./.env` (TUI-DESIGN-2 §2.3: "env or dotenv"); empty values are unset */
interface EnvLookup {
  get(name: string): string | undefined;
}

async function envLookup(io: CommandIo): Promise<EnvLookup> {
  let dotenv: ReadonlyMap<string, string> | null = null;
  try {
    dotenv = (await readDotenv(join(io.cwd, '.env')))?.vars ?? null;
  } catch {
    dotenv = null; // an unreadable .env is the config layer's problem to report; login only infers from it
  }
  return {
    get(name) {
      const v = io.env[name]?.trim();
      if (v) return v;
      const d = dotenv?.get(name)?.trim();
      return d ? d : undefined;
    },
  };
}

/** TUI-DESIGN-2 §1.2: the mode `jevcode login` shapes its prompts for — `JEVCODE_MODE` (env, `./.env`) > the file's `mode` key > jev-only. */
export function loginMode(lookup: EnvLookup, file: Pick<CredentialsFile, 'values'>): EngineMode {
  const fileMode = file.values['mode'];
  return parseMode(lookup.get('JEVCODE_MODE')) ?? parseMode(typeof fileMode === 'string' ? fileMode : undefined) ?? 'jev-only';
}

/**
 * TUI-DESIGN-2 §1.4: the generator provider and why — `--provider`, `JEVCODE_PROVIDER`, the file's `provider`, else the
 * wizard's prompted default `DEFAULT_PROVIDER` (openrouter, commit 2a92d0b). Throws ConfigError on an unknown `--provider`.
 */
function generatorProviderFor(flags: LoginFlags, io: CommandIo, file: CredentialsFile): { provider: WizardProvider; why: GeneratorProviderWhy } {
  const fromFlag = parseProvider(flags.provider);
  if (fromFlag) return { provider: fromFlag, why: '--provider' };
  if (flags.provider !== undefined) throw new ConfigError(`--provider: expected anthropic|openrouter, got "${flags.provider}"`, { setting: 'generator.provider' });
  const fromEnv = parseProvider(io.env['JEVCODE_PROVIDER']);
  if (fromEnv) return { provider: fromEnv, why: 'JEVCODE_PROVIDER' };
  const fromFile = parseProvider(file.provider ?? undefined);
  if (fromFile) return { provider: fromFile, why: 'file' };
  return { provider: parseProvider(DEFAULT_PROVIDER) ?? 'openrouter', why: 'default' };
}

/**
 * TUI-DESIGN-2 §1.4 / §2.3: the Jev provider `jevcode login` records — `--jev-provider`, then `resolved` (the session's own
 * `decider.provider`, see `resolvedJevProvider`), then — the fallback without a resolver — `JEV_PROVIDER`, the file's
 * `jevProvider` (only beside a saved `jevApiKey`: a note `logout --jev` left behind is not a chosen provider), rules 2a
 * (a configured `JEV_BASE_URL` host), 2b (`JEV_API_KEY` → openrouter), 2c (`TYPESAFE_API_KEY` → typesafe), 2d
 * (`OPENROUTER_API_KEY` → openrouter). The generator provider is no rule: null = nothing infers it (ask, or exit 2 on a pipe).
 */
export function inferJevProvider(i: { flag: string | undefined; resolved?: JevProvider | null; lookup: EnvLookup; file: Pick<CredentialsFile, 'jevProvider' | 'jevApiKey'> }): JevProvider | null {
  const value = (name: string): string | undefined => {
    const v = i.lookup.get(name)?.trim();
    return v ? v : undefined; // an empty variable is unset (the `.env.example` case)
  };
  const explicit = parseJevProvider(i.flag);
  if (explicit) return explicit;
  if (i.resolved) return i.resolved;
  const fromEnv = parseJevProvider(value('JEV_PROVIDER'));
  if (fromEnv) return fromEnv;
  const fromFile = i.file.jevApiKey !== null ? parseJevProvider(i.file.jevProvider ?? undefined) : null;
  if (fromFile) return fromFile;
  const baseUrl = value('JEV_BASE_URL');
  const fromHost = baseUrl !== undefined ? providerForHost(baseUrl) : null;
  if (fromHost) return fromHost;
  if (value('JEV_API_KEY') !== undefined) return 'openrouter';
  if (value('TYPESAFE_API_KEY') !== undefined) return 'typesafe';
  if (value('OPENROUTER_API_KEY') !== undefined) return 'openrouter';
  return null;
}

/**
 * TUI-DESIGN-2 §2.3: the session's own resolution of `decider.provider` through `io.resolveSecrets()` (flag > `JEV_PROVIDER` >
 * `./.env` > `<OPEN_ASSIST_PATH>/.env` > file `jevProvider` > rules 2a–2d), so `jevcode login` and the session never disagree
 * about the provider on the same machine. `default` (rule 2e) is not an inference; a `file:` source without a saved
 * `jevApiKey` is the stale note `logout --jev` leaves and does not count either. Null without a resolver or on a ConfigError.
 */
export async function resolvedJevProvider(io: Pick<CommandIo, 'resolveSecrets'>, file: Pick<CredentialsFile, 'jevApiKey'>): Promise<JevProvider | null> {
  if (!io.resolveSecrets) return null;
  const r = (await io.resolveSecrets()).get('decider.provider');
  if (!r || r.source === 'default') return null;
  if (r.source.startsWith('file:') && file.jevApiKey === null) return null;
  return parseJevProvider(r.value);
}

/** TUI-DESIGN-2 §12 "Wizard": `Jev API key (TYPESAFE_API_KEY): ` / `Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY): `. */
export function jevKeyPrompt(provider: JevProvider | null): string {
  return `${jevKeyTitle(provider, '1/1').replace(/\s+1\/1$/, '')}: `;
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

/**
 * TUI-DESIGN-2 §1.4: `Where do you reach Jev?  1 typesafe  2 openrouter` on a TTY — `1`/`typesafe`, `2`/`openrouter`; an empty
 * answer is `null` when `allowEmpty` (the optional Jev step of the generator flow: Enter = skip); Ctrl-C/EOF or three bad
 * answers → CANCELLED.
 */
async function promptJevProvider(io: CommandIo, allowEmpty: boolean): Promise<JevProvider | null | typeof CANCELLED> {
  const read = io.readLine ?? ((p: string) => readPlainLine(p, io.stdin, io.stdout));
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
    const raw = await read(JEV_PROVIDER_PROMPT);
    if (raw === null) return CANCELLED;
    const t = raw.trim().toLowerCase();
    if (t === '' && allowEmpty) return null;
    if (t === '1' || t === 'typesafe') return 'typesafe';
    if (t === '2' || t === 'openrouter') return 'openrouter';
    io.stderr.write(`jevcode: pick 1 (typesafe) or 2 (openrouter)\n`);
  }
  return CANCELLED;
}

function printFix(io: CommandIo, mode: EngineMode, provider: WizardProvider | null): void {
  for (const l of fixBlockLines(mode, provider)) io.stderr.write(`${l}\n`);
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

/** TUI-DESIGN §11.1: `decider.apiKey` already resolves from `JEV_API_KEY`/`TYPESAFE_API_KEY`/`OPENROUTER_API_KEY` (env or dotenv) → the Jev step is skipped. */
async function jevResolvedFromEnv(io: CommandIo): Promise<Resolved<string> | null> {
  if (!io.resolveSecrets) return null;
  const r = (await io.resolveSecrets()).get('decider.apiKey');
  if (!r || r.value.trim() === '') return null;
  return r.source === 'env' || r.source.startsWith('dotenv:') ? r : null;
}

/** TUI-DESIGN-2 §2.7: the one-Noul probe of the typesafe verification (`{ message: 'hi' }`, ≈ 320 input tokens ≈ $0.00002). */
export function verifyProbeQuestions(): Record<string, ReturnType<typeof noul>> {
  return {
    greeting: noul(`Is ${ref('message')} a greeting rather than a request for work?`, {
      true: { definition: 'the message opens a conversation and asks for nothing to be done', examples: ['hi', 'hello there'] },
      false: { definition: 'the message names a change, a file or a command to run', examples: ['fix the failing test', 'run pytest'] },
    }),
  };
}

/**
 * TUI-DESIGN §11.1 / TUI-DESIGN-2 §2.7 verification with an injectable `fetch`: OpenRouter `GET /api/v1/key`, Anthropic
 * `GET /v1/models`, and under `typesafe` one priced decision at api.typesafe.ai (`jev-1.13.0`, ≈ $0.00002); 5 s each, status only
 * in the output. An OpenRouter Jev key is checked through the OpenRouter key endpoint (it is an OpenRouter key). A non-2xx
 * answer is `rejected`; a thrown fetch (DNS, timeout, refused) is `unreachable`.
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
  async function typesafeDecision(key: string): Promise<VerifyResult> {
    const spec = JEV_PROVIDERS.typesafe;
    try {
      const res = await f(spec.baseUrl, {
        method: 'POST',
        headers: spec.headers(key, DEFAULT_REFERER),
        body: JSON.stringify({ model: spec.defaultModel, state: VERIFY_PROBE_STATE, questions: verifyProbeQuestions() }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { which: 'jev', ok: false, text: verificationFailedText(`typesafe HTTP ${res.status}`), reason: 'rejected' };
      const body = (await res.json()) as { model?: unknown; usage?: { input_tokens?: unknown } };
      const model = typeof body.model === 'string' ? body.model : spec.defaultModel;
      const tokens = typeof body.usage?.input_tokens === 'number' ? body.usage.input_tokens : null;
      return { which: 'jev', ok: true, text: verifiedTypesafeText(model, tokens) };
    } catch (e) {
      return { which: 'jev', ok: false, text: verificationFailedText(short(e)), reason: 'unreachable' };
    }
  }
  if (input.generatorKey) out.push(input.provider === 'anthropic' ? await anthropicKey(input.generatorKey) : await openrouterKey('generator', input.generatorKey));
  if (input.jevKey && input.jevKey !== input.generatorKey) out.push(input.jevProvider === 'typesafe' ? await typesafeDecision(input.jevKey) : await openrouterKey('jev', input.jevKey));
  return out;
}

/** Write the patch and print its items/warnings; the exit code (0, or 2 on a ConfigError, 1 otherwise). */
async function save(patch: CredentialsPatch, source: 'login' | 'stdin', flags: LoginFlags, io: CommandIo, generatorWhy: GeneratorProviderWhy): Promise<number> {
  try {
    const result = await writeCredentials(patch, { env: io.env, home: io.home, cwd: io.cwd, configFlag: flags.config ?? null, ...(io.platform ? { platform: io.platform } : {}) }, source);
    for (const item of result.items) io.stdout.write(`[setup] ${item}\n`);
    // §1.4: both providers are named whenever their key was written — never a silent `provider`
    if (patch.provider !== undefined && patch.apiKey !== undefined) io.stdout.write(`[setup] ${generatorProviderText(patch.provider, generatorWhy)}\n`);
    if (patch.jevProvider !== undefined && patch.jevApiKey !== undefined) io.stdout.write(`[setup] jev provider: ${patch.jevProvider} (${JEV_PROVIDERS[patch.jevProvider].displayHost})\n`);
    for (const w of result.warnings) io.stderr.write(`jevcode: ${w}\n`);
    return EXIT_CODES.ok;
  } catch (e) {
    io.stderr.write(`jevcode: ${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof ConfigError ? EXIT_CODES.config : EXIT_CODES.unexpected;
  }
}

/**
 * TUI-DESIGN §11.2 / TUI-DESIGN-2 §1.4: `jevcode login [--provider …] [--jev-provider …] [--generator-key-stdin] [--jev-key-stdin]
 * [--status] [--verify]`. Returns the exit code: 0 saved; 2 cancelled, refused or a rejected key under `--verify`
 * (§13.5: key rejected = 2); 5 when `--verify` could not reach the provider at all.
 */
export async function commandLogin(flags: LoginFlags, io: CommandIo): Promise<number> {
  if (flags.status) {
    const { lines, ok } = await statusLines(io);
    for (const l of lines) io.stdout.write(`${l}\n`);
    return ok ? EXIT_CODES.ok : EXIT_CODES.unexpected;
  }
  if (flags.jevProvider !== undefined && parseJevProvider(flags.jevProvider) === null && flags.jevProvider.trim().toLowerCase() !== 'auto') {
    io.stderr.write(`jevcode: --jev-provider: expected typesafe|openrouter, got "${flags.jevProvider}"\n`);
    return EXIT_CODES.config;
  }
  const file = await readCredentialsFile(credentialsPath({ env: io.env, home: io.home, cwd: io.cwd, configFlag: flags.config ?? null }).path);
  let generator: { provider: WizardProvider; why: GeneratorProviderWhy };
  try {
    generator = generatorProviderFor(flags, io, file);
  } catch (e) {
    io.stderr.write(`jevcode: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_CODES.config;
  }
  const { provider, why } = generator;
  const lookup = await envLookup(io);
  const mode = loginMode(lookup, file);
  // §1.4: the generator step runs when `--provider` is given or the mode needs a generator; jev-only alone asks for the Jev key only
  const generatorStep = flags.provider !== undefined || mode !== 'jev-only';
  const patch: CredentialsPatch = {};
  let source: 'login' | 'stdin' = 'login';
  const wantGenerator = flags.generatorKeyStdin === true;
  const wantJev = flags.jevKeyStdin === true;
  const interactive = io.stdin.isTTY === true || io.readMasked !== undefined;
  // §2.3: the Jev provider — the flag, the session's own resolution, else the local rules; the generator provider is never one of them
  const inferred = inferJevProvider({ flag: flags.jevProvider, resolved: await resolvedJevProvider(io, file), lookup, file });
  const fixProvider = generatorStep || wantGenerator ? provider : null;
  /** the fix block names a generator whenever this login asked for one (§12 "Wizard": the Anthropic line is jev-on only) */
  const fixMode: EngineMode = (generatorStep || wantGenerator) && mode === 'jev-only' ? 'jev-on' : mode;
  const persist = (): Promise<number> => save(patch, source, flags, io, why);
  /** an accepted generator key is saved before a cancelled Jev step fails the command (exit 2 with the fix block) */
  const failAfterGenerator = async (): Promise<number> => {
    if (patch.apiKey !== undefined) {
      const code = await persist();
      if (code !== EXIT_CODES.ok) return code;
    }
    printFix(io, fixMode, fixProvider);
    return EXIT_CODES.config;
  };

  if (wantGenerator || wantJev) {
    if (interactive) {
      // A terminal cannot deliver a "stdin line" without echoing it: the flagged keys are asked for masked instead.
      if (wantGenerator) {
        const k = await promptKey(io, generatorPrompt(provider), provider, false);
        if (k === CANCELLED || k === null) {
          printFix(io, fixMode, fixProvider);
          return EXIT_CODES.config;
        }
        patch.provider = provider;
        patch.apiKey = k;
      }
      if (wantJev) {
        // `--jev-key-stdin` announces a Jev key: the provider question (nothing to reuse) and then the provider-named prompt
        const jp = inferred !== null ? inferred : await promptJevProvider(io, false);
        const k = jp === CANCELLED || jp === null ? CANCELLED : await promptKey(io, jevKeyPrompt(jp), null, false);
        if (jp === CANCELLED || jp === null || k === CANCELLED || k === null) return failAfterGenerator();
        patch.jevApiKey = k;
        patch.jevProvider = jp;
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
        patch.provider = provider;
        patch.apiKey = k;
      }
      if (wantJev) {
        const k = acceptKey(lines[idx++] ?? '');
        if (!k) {
          io.stderr.write(`jevcode: decider.apiKey: ${HINT_TOO_SHORT} (${wantGenerator ? 'second' : 'first'} stdin line)\n`);
          return EXIT_CODES.config;
        }
        // §1.4: a pipe cannot ask — the provider must be given or inferable; the one shortcut is the wizard's reuse:
        // the same OpenRouter key piped as generator and Jev key serves both (the Jev provider is openrouter)
        const jp = inferred !== null ? inferred : wantGenerator && provider === 'openrouter' && k === patch.apiKey ? 'openrouter' : null;
        if (jp === null) {
          io.stderr.write(`${LOGIN_JEV_PROVIDER_REQUIRED}\n`);
          return EXIT_CODES.config;
        }
        patch.jevApiKey = k;
        patch.jevProvider = jp;
      }
    }
  } else if (interactive && generatorStep) {
    const gen = await promptKey(io, generatorPrompt(provider), provider, false);
    if (gen === CANCELLED || gen === null) {
      printFix(io, fixMode, fixProvider);
      return EXIT_CODES.config;
    }
    patch.provider = provider;
    patch.apiKey = gen;
    const resolved = await jevResolvedFromEnv(io);
    if (resolved) {
      io.stdout.write(`[setup] decider.apiKey: already set from ${resolved.source} (sha256:${fingerprint(resolved.value.trim())}) — Jev key step skipped\n`);
    } else {
      // the optional Jev step. §1.4: the OpenRouter key just typed can serve Jev — but only under the openrouter Jev provider
      // (or when nothing resolves it); a typesafe Jev provider never receives it. Enter = reuse (openrouter) / skip (else).
      const reuseWith = (jp: JevProvider | null): boolean => provider === 'openrouter' && (jp === null || jp === 'openrouter');
      const reuse = (): void => {
        patch.jevApiKey = gen;
        patch.jevProvider = 'openrouter';
      };
      let jp: JevProvider | null = inferred;
      let asked = false;
      if (jp === null) {
        // nothing infers the Jev provider: ask first — a different Jev key must name its provider before it is saved
        asked = true;
        io.stdout.write(`${reuseWith(null) ? WIZARD_REUSE_HINT : LOGIN_JEV_SKIP_HINT}\n`);
        const a = await promptJevProvider(io, true);
        if (a === CANCELLED) return failAfterGenerator();
        jp = a;
        if (jp === null && reuseWith(null)) reuse();
      }
      if (jp !== null) {
        if (!asked) io.stdout.write(`${reuseWith(jp) ? WIZARD_REUSE_HINT : LOGIN_JEV_SKIP_HINT}\n`);
        const jev = await promptKey(io, jevKeyPrompt(jp), null, true);
        if (jev === CANCELLED) return failAfterGenerator();
        if (jev !== null) {
          patch.jevApiKey = jev;
          patch.jevProvider = jp;
        } else if (reuseWith(jp)) reuse();
      }
    }
  } else if (interactive) {
    // §1.4: jev-only, no --provider — the Jev key alone (the whole point of the command; Ctrl-C prints the fix block, exit 2)
    const resolved = await jevResolvedFromEnv(io);
    if (resolved) {
      // §2.3: the key already resolves from the environment (or a dotenv file the session reads) — nothing to save; the piped
      // `printenv … | jevcode login --jev-provider … --jev-key-stdin` of the fix block still writes the file
      io.stdout.write(`[setup] decider.apiKey: already set from ${resolved.source} (sha256:${fingerprint(resolved.value.trim())}) — Jev key step skipped\n`);
      return EXIT_CODES.ok;
    }
    const jp = inferred !== null ? inferred : await promptJevProvider(io, false);
    const jev = jp === CANCELLED || jp === null ? CANCELLED : await promptKey(io, jevKeyPrompt(jp), null, false);
    if (jp === CANCELLED || jp === null || jev === CANCELLED || jev === null) {
      printFix(io, fixMode, null);
      return EXIT_CODES.config;
    }
    patch.jevApiKey = jev;
    patch.jevProvider = jp;
  } else {
    io.stderr.write(`${LOGIN_NEEDS_TTY_OR_STDIN}\n`);
    printFix(io, fixMode, fixProvider);
    return EXIT_CODES.config;
  }

  const saved = await persist();
  if (saved !== EXIT_CODES.ok) return saved;

  if (flags.verify) {
    const verify = io.verify ?? ((input: VerifyInput) => verifyKeys(input, io.fetch ?? fetch));
    const results = await verify({ provider, jevProvider: patch.jevProvider ?? inferred, generatorKey: patch.apiKey ?? null, jevKey: patch.jevApiKey ?? null });
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
