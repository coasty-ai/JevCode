/**
 * `jevcode login` / `jevcode logout` / `jevcode config set` (TUI-DESIGN §11.2, §16, A125, D5; TUI-DESIGN-2 §1.4, §2.3, §2.7).
 * Pure command handlers over an injected `CommandIo`: keys arrive on stdin — one line per
 * `--*-stdin` flag on a pipe, or a masked `node:readline` prompt with its output muted on a TTY
 * (`--plain`; the Ink masked field is the wizard's) — and leave only as fingerprints. Secret
 * settings are refused as arguments. Zero network unless `--verify` is asked for. Every line is
 * written through `io.stdout` / `io.stderr`, never `console`.
 *
 * The interactive twin mirrors the wizard (§11.1, TUI-DESIGN-2 §1.4, TUI-DESIGN-3 §1.6): under jev-only and without `--provider`
 * only the Jev key is asked for; under a generator mode (`DEFAULT_MODE`, `JEVCODE_MODE`, `./.env`, the file's `mode` key) with
 * nothing resolving, the other-ways line and ONE masked OpenRouter key serve Jev and the code model (`--key-stdin` is the piped
 * form: one line → four file keys). The Jev provider is `--jev-provider`, else the session's own
 * resolution of `decider.provider` (`io.resolveSecrets()`: `JEV_PROVIDER`, `./.env`, `<JEVCODE_EXTRA_ENV_FILE>`, the
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
import { DEFAULT_MODE, DEFAULT_MODEL, DEFAULT_PROVIDER, MODE_SETTING_VALUES, SETTINGS } from '../config/defaults.js';
import { credentialsPath, displayPath, readCredentialsFile, removeCredentials, writeConfigValue, writeCredentials, type CredentialKey, type CredentialsFile, type CredentialsPatch } from '../config/credentials.js';
import { readDotenv } from '../config/env.js';
import { fingerprint } from '../core/hash.js';
import { MIN_SECRET_LENGTH } from '../core/redact.js';
import type { EngineMode, JevProvider, Resolved, SecretSettingName } from '../core/types.js';
import { ConfigError, EXIT_CODES } from '../errors.js';
import { JEV_PROVIDERS, providerForHost } from '../jev/providers.js';
import { noul, ref } from '../jev/questions.js';
import { DEFAULT_REFERER } from '../jev/types.js';
import {
  LOGIN_JEV_PROVIDER_PROMPT,
  LOGIN_JEV_PROVIDER_REQUIRED,
  loginOneKeyPrompt,
  LOGIN_OTHER_WAYS_PROMPT,
  WIZARD_REUSE_HINT,
  fixBlockLines,
  jevKeyTitle,
  modeSavedItem,
  verificationCreditsText,
  verificationFailedText,
  verificationModelText,
  verificationRateLimitedText,
  verifiedGeneratorText,
  verifiedJevText,
  verifiedText,
  verifiedTypesafeText,
} from '../tui/onboarding/lines.js';
import { HINT_TOO_SHORT, hintPrefix, looksLikeKey, sanitizeKeyInput, type WizardProvider } from '../tui/onboarding/reducer.js';
// TUI-DESIGN-5 §6.2 / §6.3 / §8.2 R14: `provider/ids.ts` is the ONE zero-import provider module the argv path may
// read (this file is on it — `src/cli/session.ts:194` imports it statically). The catalogue itself
// (`src/models/**`) arrives only through the `await import()` in `verifyProviderKey`.
import { PROVIDER_DISPLAY_NAME, PROVIDER_IDS, isProviderId, keyEnvNames } from '../provider/ids.js';
import { keyRateLimitedText, keyRejectedText, keyVerifiedText } from '../tui/models/lines.js';
import type { ProviderId } from '../provider/ids.js';

/** TUI-DESIGN §24 (CLI): the refusal for `jevcode config set generator.apiKey …` and friends. */
export const SECRET_AS_ARGUMENT_REFUSED = "secret settings are set with 'jevcode login' (stdin or masked prompt), never as an argument";
/** `jevcode login` on a pipe without a `--*-stdin` flag (TUI-DESIGN-3 §1.6: `--key-stdin` first). */
export const LOGIN_NEEDS_TTY_OR_STDIN = 'jevcode login: stdin is not a terminal; pipe one OpenRouter key with --key-stdin, or --generator-key-stdin and/or --jev-key-stdin';
/** TUI-DESIGN-3 §1.6: `--key-stdin` is the one-OpenRouter-key form — it never names another provider */
export const KEY_STDIN_ONE_PROVIDER = '--key-stdin is the one-OpenRouter-key form; use --generator-key-stdin --jev-key-stdin';
/** The Jev prompt's hint when the generator is not openrouter (an empty Enter leaves `jevApiKey` untouched). */
export const LOGIN_JEV_SKIP_HINT = 'Enter = skip';
/** TUI-DESIGN-2 §1.4: why `jevcode login` used this generator provider (printed beside a saved generator key, never silently) */
export type GeneratorProviderWhy = '--provider' | 'JEVCODE_PROVIDER' | 'file' | 'default';
/** `[setup] generator provider: openrouter (default)` — the generator provider is written only with a generator key, and named (TUI-DESIGN-5 §6.3 row 3: seven ids, not two) */
export function generatorProviderText(provider: ProviderId, why: GeneratorProviderWhy): string {
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
  /** TUI-DESIGN-3 §1.6: one OpenRouter key from the first stdin line → apiKey + jevApiKey + provider + jevProvider openrouter */
  keyStdin?: boolean;
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

/**
 * TUI-DESIGN §11.1 / TUI-DESIGN-2 §2.7 / TUI-DESIGN-3 §1.5: what `--verify` checks; `jevProvider` keys the Jev check (null = no Jev key to
 * check, or openrouter). `mode` decides whether the generator gets its 1-token completion; `generatorModel` / `jevBaseUrl` / `jevModel`
 * name what is sent (their defaults are the tables'); `signal` chains Ctrl-C (edge 5).
 */
export interface VerifyInput {
  provider: WizardProvider;
  jevProvider: JevProvider | null;
  generatorKey: string | null;
  jevKey: string | null;
  mode?: EngineMode;
  generatorModel?: string;
  jevBaseUrl?: string;
  jevModel?: string;
  signal?: AbortSignal;
}
/** TUI-DESIGN §11.1: one verification outcome (status only). */
export interface VerifyResult {
  which: 'generator' | 'jev';
  ok: boolean;
  /** the `[setup] …` item text (`verified: …` / `verification failed: …`) */
  text: string;
  /**
   * why it failed (TUI-DESIGN-3 §1.5): the provider rejected the key (exit 2, §13.5), the key has no credits (402, exit 5), the code model
   * is not served (400/404, exit 2) or the host could not be reached (408/429/5xx/thrown, exit 5); absent = rejected
   */
  reason?: 'rejected' | 'credits' | 'unreachable' | 'model';
  /** the priced call's usage (the decision, the completion) — the session meters it (`meterVerify`) */
  usage?: { inputTokens: number; outputTokens: number; costUsd: number; calls: number };
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

/**
 * TUI-DESIGN-5 §6.5 (D-AR (b)): every one of the seven ids. The hardened wizard stays binary — `WizardProvider`
 * and `KEY_PREFIXES` are untouched (§6.3 row 4) — and the other five are reached through `jevcode login --provider
 * <id>` and `/provider <id>`. `isProviderId` reads no prototype key, so `'toString'` is not a provider.
 */
export function parseAnyProvider(s: string | undefined): ProviderId | null {
  const t = s?.trim().toLowerCase();
  return t !== undefined && isProviderId(t) ? t : null;
}

/** The two the hardened wizard knows how to prompt for; the other five have no documented key prefix to hint at. */
function asWizardProvider(id: ProviderId): WizardProvider | null {
  return id === 'anthropic' || id === 'openrouter' ? id : null;
}

/** TUI-DESIGN-2 §2.3: `typesafe` | `openrouter`; `auto`, empty and unknown are null (the caller decides whether that is an error). */
export function parseJevProvider(s: string | undefined): JevProvider | null {
  const t = s?.trim().toLowerCase();
  return t === 'typesafe' || t === 'openrouter' ? t : null;
}

function parseMode(s: string | undefined): EngineMode | null {
  const t = s?.trim().toLowerCase();
  return t !== undefined && (MODE_SETTING_VALUES as readonly string[]).includes(t) ? (t as EngineMode) : null;
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

/** TUI-DESIGN-2 §1.2 / TUI-DESIGN-3 §1.1: the mode `jevcode login` shapes its prompts for — `JEVCODE_MODE` (env, `./.env`) > the file's `mode` key > DEFAULT_MODE. */
export function loginMode(lookup: EnvLookup, file: Pick<CredentialsFile, 'values'>): EngineMode {
  const fileMode = file.values['mode'];
  return parseMode(lookup.get('JEVCODE_MODE')) ?? parseMode(typeof fileMode === 'string' ? fileMode : undefined) ?? DEFAULT_MODE;
}
/** TUI-DESIGN-3 §1.5: the generator model `--verify` sends its 1-token completion to — `JEVCODE_MODEL` (env, `./.env`) > the file's `model` key > the default */
export function loginGeneratorModel(lookup: EnvLookup, file: Pick<CredentialsFile, 'values'>): string {
  const fileModel = file.values['model'];
  return lookup.get('JEVCODE_MODEL') ?? (typeof fileModel === 'string' && fileModel.trim() !== '' ? fileModel.trim() : DEFAULT_MODEL);
}
/** the `mode` row's source for `--status` (`env`, `dotenv`, `file`, `default`) */
export function loginModeSource(lookup: EnvLookup, file: Pick<CredentialsFile, 'values'>, env: NodeJS.ProcessEnv): 'env' | 'dotenv' | 'file' | 'default' {
  if (parseMode(lookup.get('JEVCODE_MODE')) !== null) return parseMode(env['JEVCODE_MODE']) !== null ? 'env' : 'dotenv';
  const fileMode = file.values['mode'];
  return parseMode(typeof fileMode === 'string' ? fileMode : undefined) !== null ? 'file' : 'default';
}

/**
 * TUI-DESIGN-2 §1.4: the generator provider and why — `--provider`, `JEVCODE_PROVIDER`, the file's `provider`, else the
 * wizard's prompted default `DEFAULT_PROVIDER` (openrouter, commit 2a92d0b). Throws ConfigError on an unknown `--provider`.
 */
function generatorProviderFor(flags: LoginFlags, io: CommandIo, file: CredentialsFile): { provider: ProviderId; why: GeneratorProviderWhy } {
  // TUI-DESIGN-5 §6.5: all seven ids here; the *wizard* stays binary (D-AR (b)), this is its CLI twin
  const fromFlag = parseAnyProvider(flags.provider);
  if (fromFlag) return { provider: fromFlag, why: '--provider' };
  if (flags.provider !== undefined) throw new ConfigError(`--provider: expected ${PROVIDER_IDS.join('|')}, got "${flags.provider}"`, { setting: 'generator.provider' });
  const fromEnv = parseAnyProvider(io.env['JEVCODE_PROVIDER']);
  if (fromEnv) return { provider: fromEnv, why: 'JEVCODE_PROVIDER' };
  const fromFile = parseAnyProvider(file.provider ?? undefined);
  if (fromFile) return { provider: fromFile, why: 'file' };
  return { provider: parseAnyProvider(DEFAULT_PROVIDER) ?? 'openrouter', why: 'default' };
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
 * `./.env` > `<JEVCODE_EXTRA_ENV_FILE>` > file `jevProvider` > rules 2a–2d), so `jevcode login` and the session never disagree
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

/**
 * TUI-DESIGN-5 §6.3 row 5: the title reads the SEVEN-entry tables — `keyEnvNames(id)[0]` (already in
 * `provider/ids.ts`) and `PROVIDER_DISPLAY_NAME` (the same module, R14). The two-entry `PROVIDER_DISPLAY` /
 * `PROVIDER_ENV` in `src/tui/onboarding/lines.ts` are R5-5's to re-point; until then the two agree for the two
 * providers they both know, which `test/unit/config/provider.test.ts` asserts.
 */
function generatorPrompt(provider: ProviderId): string {
  return `${PROVIDER_DISPLAY_NAME[provider]} API key (${keyEnvNames(provider)[0] ?? 'the provider key'}): `;
}

/** `jevcode login --status`'s `needs:` clause: jev-only needs Jev alone, agent the generator alone (AGENT-LOOP-DESIGN §14.2), every other mode both */
export function modeNeeds(mode: EngineMode): string {
  return mode === 'jev-only' ? 'jev' : mode === 'agent' ? 'generator (Jev optional)' : 'generator, jev';
}

async function statusLines(io: CommandIo, mode: EngineMode, modeSource: string): Promise<{ lines: string[]; ok: boolean }> {
  // TUI-DESIGN-3 §1.6: the third line names the mode, its source and what it needs — a jev-only session is `ok` with the Jev key alone;
  // AGENT-LOOP-DESIGN §14.2: an agent session is `ok` with the generator key alone (Jev only makes optional quick routing calls)
  const modeLine = `mode: ${mode} (${modeSource}) — needs: ${modeNeeds(mode)}`;
  if (!io.resolveSecrets) return { lines: ['generator.apiKey: unknown (no resolver)', 'decider.apiKey: unknown (no resolver)', modeLine], ok: false };
  const entries = await io.resolveSecrets();
  const lines: string[] = [];
  let ok = true;
  for (const name of ['generator.apiKey', 'decider.apiKey'] as const) {
    const r = entries.get(name);
    if (r && r.value.trim() !== '') lines.push(`${name}: ${r.source} (sha256:${fingerprint(r.value.trim())})`);
    else {
      lines.push(`${name}: not set`);
      if (name === 'decider.apiKey' ? mode !== 'agent' : mode !== 'jev-only') ok = false;
    }
  }
  lines.push(modeLine);
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

/** TUI-DESIGN-3 §1.5: the 1-token completion of the generator check */
export const VERIFY_COMPLETION_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';

/** TUI-DESIGN-3 §1.5: HTTP status → outcome (2xx `ok`; 401/403 `rejected`; 402 `credits`; 408/429/5xx `unreachable`; 400/404 on a completion `model`) */
export function verifyReasonFor(status: number, completion = false): NonNullable<VerifyResult['reason']> {
  if (status === 402) return 'credits';
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return 'unreachable';
  if (completion && (status === 400 || status === 404)) return 'model';
  return 'rejected';
}

function retryAfterSeconds(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (h === null) return null;
  const n = Number(h.trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * TUI-DESIGN §11.1 / TUI-DESIGN-2 §2.7 / TUI-DESIGN-3 §1.5 verification with an injectable `fetch` — four outcomes per call
 * (`ok` · `rejected` · `credits` · `unreachable`, plus `model` for a completion the router does not serve):
 *   Jev under openrouter → ONE real decision (`POST <jevBaseUrl>`, the one-Noul probe, ≈ $0.00002); under typesafe the same probe at api.typesafe.ai
 *   the generator under openrouter → `POST /api/v1/chat/completions { model, messages: [hi], max_tokens: 1, temperature: 0 }` (≈ $0.000002), only when
 *     `mode` bills a generator; under anthropic `GET /v1/models` (free)
 *   `GET /api/v1/key` ($0) for the OpenRouter key's `label` / `limit_remaining` (kept: it cannot see the balance of an unlimited key — R3 F14)
 * Every call has `AbortSignal.any([timeout, input.signal])` so Ctrl-C at `verify` aborts (edge 5). Status only in the output; a thrown fetch
 * (DNS, timeout, refused, aborted) is `unreachable` with `<name>: <message>`.
 */
export async function verifyKeys(input: VerifyInput, f: typeof fetch = fetch, timeoutMs = VERIFY_TIMEOUT_MS): Promise<VerifyResult[]> {
  const out: VerifyResult[] = [];
  const short = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 120);
  const signal = (): AbortSignal => (input.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), input.signal]) : AbortSignal.timeout(timeoutMs));
  const mode = input.mode ?? DEFAULT_MODE;
  const generatorModel = input.generatorModel ?? DEFAULT_MODEL;
  const jevProvider: JevProvider = input.jevProvider ?? 'openrouter';
  const jevSpec = JEV_PROVIDERS[jevProvider];
  const jevBaseUrl = input.jevBaseUrl ?? jevSpec.baseUrl;
  const jevModel = input.jevModel ?? jevSpec.defaultModel;
  const usageOf = (body: { usage?: { input_tokens?: unknown; prompt_tokens?: unknown; output_tokens?: unknown; completion_tokens?: unknown; cost?: unknown } }, fallbackUsd: number | null): { inputTokens: number; outputTokens: number; costUsd: number; calls: number; tokens: number | null; usd: number | null } => {
    const u = body.usage ?? {};
    const tokens = typeof u.input_tokens === 'number' ? u.input_tokens : typeof u.prompt_tokens === 'number' ? u.prompt_tokens : null;
    const outTokens = typeof u.output_tokens === 'number' ? u.output_tokens : typeof u.completion_tokens === 'number' ? u.completion_tokens : 0;
    const usd = typeof u.cost === 'number' ? u.cost : fallbackUsd;
    return { inputTokens: tokens ?? 0, outputTokens: outTokens, costUsd: usd ?? 0, calls: 1, tokens, usd };
  };
  /** a non-2xx answer on an OpenRouter call: the four texts */
  const failed = (which: VerifyResult['which'], res: Response, host: 'openrouter' | 'typesafe', completion = false): VerifyResult => {
    const reason = verifyReasonFor(res.status, completion);
    if (host === 'openrouter' && reason === 'credits') return { which, ok: false, text: verificationCreditsText(res.status), reason };
    if (host === 'openrouter' && res.status === 429) return { which, ok: false, text: verificationRateLimitedText(retryAfterSeconds(res)), reason };
    if (reason === 'model') return { which, ok: false, text: verificationModelText(generatorModel, res.status), reason };
    return { which, ok: false, text: verificationFailedText(`${host} HTTP ${res.status}`), reason };
  };
  async function openrouterKey(which: 'generator' | 'jev', key: string): Promise<VerifyResult> {
    try {
      const res = await f(OPENROUTER_KEY_URL, { headers: { authorization: `Bearer ${key}` }, signal: signal() });
      if (!res.ok) return failed(which, res, 'openrouter');
      const body = (await res.json()) as { data?: { label?: unknown; limit_remaining?: unknown } };
      const label = typeof body.data?.label === 'string' ? body.data.label : '';
      const limit = typeof body.data?.limit_remaining === 'number' ? body.data.limit_remaining : null;
      return { which, ok: true, text: verifiedText('openrouter', label, limit) };
    } catch (e) {
      return { which, ok: false, text: verificationFailedText(short(e)), reason: 'unreachable' };
    }
  }
  async function openrouterCompletion(key: string): Promise<VerifyResult> {
    try {
      const res = await f(VERIFY_COMPLETION_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'HTTP-Referer': DEFAULT_REFERER },
        body: JSON.stringify({ model: generatorModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, temperature: 0 }),
        signal: signal(),
      });
      if (!res.ok) return failed('generator', res, 'openrouter', true);
      const body = (await res.json()) as { model?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown } };
      const model = typeof body.model === 'string' ? body.model : generatorModel;
      const u = usageOf(body, null);
      return { which: 'generator', ok: true, text: verifiedGeneratorText(model, u.usd), usage: { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd, calls: 1 } };
    } catch (e) {
      return { which: 'generator', ok: false, text: verificationFailedText(short(e)), reason: 'unreachable' };
    }
  }
  async function anthropicKey(key: string): Promise<VerifyResult> {
    try {
      const res = await f('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: signal() });
      if (!res.ok) return { which: 'generator', ok: false, text: verificationFailedText(`anthropic HTTP ${res.status}`), reason: verifyReasonFor(res.status) === 'unreachable' ? 'unreachable' : 'rejected' };
      const body = (await res.json()) as { data?: unknown[] };
      const n = Array.isArray(body.data) ? body.data.length : 0;
      return { which: 'generator', ok: true, text: `verified: anthropic key ok (${n} models listed)` };
    } catch (e) {
      return { which: 'generator', ok: false, text: verificationFailedText(short(e)), reason: 'unreachable' };
    }
  }
  /** one real decision — the one-Noul probe over `{ message: 'hi' }` at the Jev provider's endpoint (nothing from the workspace) */
  async function jevDecision(key: string): Promise<VerifyResult> {
    const host = jevProvider;
    try {
      const res = await f(jevBaseUrl, {
        method: 'POST',
        headers: jevSpec.headers(key, DEFAULT_REFERER),
        body: JSON.stringify({ model: jevModel, state: VERIFY_PROBE_STATE, questions: verifyProbeQuestions() }),
        signal: signal(),
      });
      if (!res.ok) return failed('jev', res, host);
      const body = (await res.json()) as { model?: unknown; usage?: { input_tokens?: unknown; cost?: unknown } };
      const model = typeof body.model === 'string' ? body.model : jevModel;
      const u = usageOf(body, null);
      const usd = u.usd ?? (u.tokens === null ? null : u.tokens * jevSpec.pricing.inputUsdPerToken);
      const usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: usd ?? 0, calls: 1 };
      // the typesafe twin keeps its round-2 text (status only; the model and the tokens)
      return { which: 'jev', ok: true, text: host === 'typesafe' ? verifiedTypesafeText(model, u.tokens) : verifiedJevText(model, u.tokens, usd), usage };
    } catch (e) {
      return { which: 'jev', ok: false, text: verificationFailedText(short(e)), reason: 'unreachable' };
    }
  }
  if (input.jevKey) out.push(await jevDecision(input.jevKey));
  if (input.generatorKey && mode !== 'jev-only') out.push(input.provider === 'anthropic' ? await anthropicKey(input.generatorKey) : await openrouterCompletion(input.generatorKey));
  // the key info: once, with whichever OpenRouter key is in play (the Jev key under openrouter, else an OpenRouter generator key)
  const infoKey = input.jevKey && jevProvider === 'openrouter' ? input.jevKey : input.generatorKey && input.provider === 'openrouter' ? input.generatorKey : null;
  if (infoKey !== null && !out.some((r) => r.reason === 'rejected')) out.push(await openrouterKey(input.jevKey && jevProvider === 'openrouter' ? 'jev' : 'generator', infoKey));
  return out;
}

/** TUI-DESIGN-3 §1.5: the exit code of a failed `--verify` — a rejected key or an unserved model is 2 (§13.5), no credits / unreachable is 5 */
export function verifyExitCode(results: readonly VerifyResult[]): number {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return EXIT_CODES.ok;
  return failed.some((r) => r.reason === undefined || r.reason === 'rejected' || r.reason === 'model') ? EXIT_CODES.config : EXIT_CODES.api;
}

/**
 * TUI-DESIGN-5 §6.5 / D-AR / §7 row 78 / §12.5 S106: **verification is the free catalogue GET, never the priced
 * probe.** `verifyProvider` (`src/models/verify.ts:37`) sends one authenticated list (or key-info) request across
 * all seven providers, returns `{ ok, latencyMs, via, modelCount?, error? }` and is redacted by construction —
 * nothing from the response body is surfaced, so a gateway that echoes `Authorization` into its 401 cannot leak the
 * key we just typed (§7 row 65).
 *
 * **Ctrl-C:** one `AbortController` per request (the wizard's shape, `src/tui/onboarding/Wizard.tsx:141`, `:180`) —
 * only the in-flight call aborts and the key already typed is kept, so the caller may retry without re-pasting. An
 * aborted check returns `aborted: true` and an **empty** `text`: a cancel prints nothing.
 *
 * `src/models/index.js` is reached by `await import()`, never statically: this module is on the argv path
 * (`src/cli/session.ts:194`) and `models/index.js` pulls the whole catalogue, `provider/openrouter.js` included
 * (§6.2, gate G-R5-1).
 */
export interface ProviderKeyCheck {
  ok: boolean;
  /** the `[setup] …` line (§12.5 S106); `''` when the request was aborted */
  text: string;
  aborted?: boolean;
  /** models the key can see, when the check listed them (OpenRouter's `/key` answers without a count) */
  modelCount?: number;
  reason?: 'rejected' | 'rate_limited' | 'unreachable';
}

export async function verifyProviderKey(provider: ProviderId, apiKey: string, opts: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ProviderKeyCheck> {
  const name = PROVIDER_DISPLAY_NAME[provider];
  const { errorLabel, verifyProvider } = await import('../models/index.js');
  let result;
  try {
    result = await verifyProvider(
      { provider },
      apiKey,
      { ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }) },
      { ...(opts.signal === undefined ? {} : { signal: opts.signal }), timeoutMs: opts.timeoutMs ?? VERIFY_TIMEOUT_MS },
    );
  } catch (e) {
    // `verifyProvider` rethrows `signal.reason` on an abort and nothing else (`src/models/verify.ts:81`)
    if (opts.signal?.aborted === true) return { ok: false, text: '', aborted: true };
    throw e;
  }
  if (opts.signal?.aborted === true) return { ok: false, text: '', aborted: true };
  if (result.ok) return { ok: true, text: keyVerifiedText(name, result.modelCount), ...(result.modelCount === undefined ? {} : { modelCount: result.modelCount }) };
  const error = result.error;
  if (error?.kind === 'auth') return { ok: false, text: keyRejectedText(name, error.status ?? 401), reason: 'rejected' };
  if (error?.kind === 'rate_limit') return { ok: false, text: keyRateLimitedText(name), reason: 'rate_limited' };
  // `no_key` is "nothing was typed"; `network`/`http`/`invalid` are "could not reach it and be sure". Both keep the
  // catalogue's own sentence (§12.5 S102) rather than a second hand-written string.
  if (error === undefined) return { ok: false, text: `${name}: could not be reached`, reason: 'unreachable' };
  return { ok: false, text: errorLabel(provider, error), reason: error.kind === 'no_key' ? 'rejected' : 'unreachable' };
}

/**
 * §6.5 / §7 row 78: several providers, **one `AbortController` per request** — minted here, one per id, and
 * handed to `onRequest` so a caller can cancel a single provider without touching the others (the wizard's shape,
 * `src/tui/onboarding/Wizard.tsx:180`). `opts.signal` is the caller's own Ctrl-C and is chained into every
 * request through `AbortSignal.any`, so it still cancels the whole batch; the two are different powers and both
 * exist. An aborted member answers `{ ok: false, text: '', aborted: true }` and the rest keep going.
 */
export async function verifyProviderKeys(
  keys: Readonly<Partial<Record<ProviderId, string>>>,
  opts: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; onRequest?: (id: ProviderId, controller: AbortController) => void } = {},
): Promise<ProviderKeyCheck[]> {
  const ids = PROVIDER_IDS.filter((id) => (keys[id] ?? '').trim() !== '');
  const base = { ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }), ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) };
  return Promise.all(
    ids.map((id) => {
      const controller = new AbortController();
      opts.onRequest?.(id, controller);
      const signal = opts.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, opts.signal]);
      return verifyProviderKey(id, keys[id] ?? '', { ...base, signal });
    }),
  );
}

/**
 * §6.5: the free catalogue check as a row in `--verify`'s **one** results list. §6.5 describes the new outcome
 * strings as "parallel to `verifiedGeneratorText`/`verificationFailedText`" — an addition, not a replacement of
 * the verify step, so the decider half still runs and `verifyExitCode` still states the exit contract in one
 * place (§13.5: a rejected key is 2, unreachable / rate limited is 5).
 */
export function providerCheckResult(check: ProviderKeyCheck): VerifyResult {
  if (check.ok) return { which: 'generator', ok: true, text: check.text };
  return { which: 'generator', ok: false, text: check.text, reason: check.reason === 'rejected' ? 'rejected' : 'unreachable' };
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
  const file = await readCredentialsFile(credentialsPath({ env: io.env, home: io.home, cwd: io.cwd, configFlag: flags.config ?? null }).path);
  const lookup = await envLookup(io);
  const mode = loginMode(lookup, file);
  if (flags.status) {
    const { lines, ok } = await statusLines(io, mode, loginModeSource(lookup, file, io.env));
    for (const l of lines) io.stdout.write(`${l}\n`);
    return ok ? EXIT_CODES.ok : EXIT_CODES.unexpected;
  }
  if (flags.jevProvider !== undefined && parseJevProvider(flags.jevProvider) === null && flags.jevProvider.trim().toLowerCase() !== 'auto') {
    io.stderr.write(`jevcode: --jev-provider: expected typesafe|openrouter, got "${flags.jevProvider}"\n`);
    return EXIT_CODES.config;
  }
  // TUI-DESIGN-3 §1.6: `--key-stdin` is the one-OpenRouter-key form — another provider on the same command is a usage error
  if (flags.keyStdin === true && flags.provider !== undefined && parseProvider(flags.provider) !== 'openrouter') {
    io.stderr.write(`jevcode: ${KEY_STDIN_ONE_PROVIDER}\n`);
    return EXIT_CODES.config;
  }
  let generator: { provider: ProviderId; why: GeneratorProviderWhy };
  try {
    generator = generatorProviderFor(flags, io, file);
  } catch (e) {
    io.stderr.write(`jevcode: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_CODES.config;
  }
  const { provider, why } = generator;
  // §1.4: the generator step runs when `--provider` is given or the mode needs a generator; jev-only alone asks for the Jev key only
  const generatorStep = flags.provider !== undefined || mode !== 'jev-only';
  const patch: CredentialsPatch = {};
  let source: 'login' | 'stdin' = 'login';
  const wantGenerator = flags.generatorKeyStdin === true;
  const wantJev = flags.jevKeyStdin === true;
  const wantOneKey = flags.keyStdin === true;
  const interactive = io.stdin.isTTY === true || io.readMasked !== undefined;
  // §2.3: the Jev provider — the flag, the session's own resolution, else the local rules; the generator provider is never one of them
  const inferred = inferJevProvider({ flag: flags.jevProvider, resolved: await resolvedJevProvider(io, file), lookup, file });
  // the fix block's key lines are the wizard's two; one of the five new ids has no `KEY_PREFIXES` row to name (§6.3 row 4)
  const fixProvider = generatorStep || wantGenerator ? asWizardProvider(provider) : null;
  /** the fix block names a generator whenever this login asked for one (§12 "Wizard": the Anthropic line is jev-on only) */
  const fixMode: EngineMode = (generatorStep || wantGenerator || wantOneKey) && mode === 'jev-only' ? 'jev-on' : mode;
  /** TUI-DESIGN-3 §1.6: `[j] Jev only` on the other-ways line — the mode is persisted after the save */
  let persistJevOnly = false;
  const persist = (): Promise<number> => save(patch, source, flags, io, why);
  /** TUI-DESIGN-3 §1.6: the one OpenRouter key serves Jev and the code model — four file keys from one value */
  const oneKey = (k: string): void => {
    patch.provider = 'openrouter';
    patch.apiKey = k;
    patch.jevApiKey = k;
    patch.jevProvider = 'openrouter';
  };
  /** an accepted generator key is saved before a cancelled Jev step fails the command (exit 2 with the fix block) */
  const failAfterGenerator = async (): Promise<number> => {
    if (patch.apiKey !== undefined) {
      const code = await persist();
      if (code !== EXIT_CODES.ok) return code;
    }
    printFix(io, fixMode, fixProvider);
    return EXIT_CODES.config;
  };

  if (wantOneKey) {
    if (interactive) {
      // a terminal cannot deliver a "stdin line" without echoing it: the one key is asked for masked
      const k = await promptKey(io, loginOneKeyPrompt(mode), 'openrouter', false);
      if (k === CANCELLED || k === null) {
        printFix(io, fixMode, null);
        return EXIT_CODES.config;
      }
      oneKey(k);
    } else {
      source = 'stdin';
      // TUI-DESIGN-3 §1.8 edge 29: the first line only; a second line is ignored, nothing printed
      const lines = await readStdinLines(io.stdin, 1);
      const k = acceptKey(lines[0] ?? '');
      if (!k) {
        io.stderr.write(`jevcode: apiKey: ${HINT_TOO_SHORT} (first stdin line)\n`);
        return EXIT_CODES.config;
      }
      oneKey(k);
    }
  } else if (wantGenerator || wantJev) {
    if (interactive) {
      // A terminal cannot deliver a "stdin line" without echoing it: the flagged keys are asked for masked instead.
      if (wantGenerator) {
        const k = await promptKey(io, generatorPrompt(provider), asWizardProvider(provider), false);
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
  } else if (interactive && generatorStep && flags.provider === undefined && provider === 'openrouter' && (await jevResolvedFromEnv(io)) === null && inferred === null) {
    // TUI-DESIGN-3 §1.6: a generator mode with nothing resolving — the other-ways line the Ink `options` step and the plain twin share, then ONE
    // masked OpenRouter key for both (`[t]` → the TypeSafe prompts, `[j]` → the Jev prompt and `mode jev-only saved`, `[a]` → the Anthropic prompts)
    const read = io.readLine ?? ((p: string) => readPlainLine(p, io.stdin, io.stdout));
    const other = (await read(LOGIN_OTHER_WAYS_PROMPT))?.trim().toLowerCase() ?? null;
    if (other === null) {
      printFix(io, fixMode, null);
      return EXIT_CODES.config;
    }
    if (other === 't' || other === 'j') {
      const jp: JevProvider = other === 't' ? 'typesafe' : (await promptJevProvider(io, false)) === 'typesafe' ? 'typesafe' : 'openrouter';
      const jev = await promptKey(io, jevKeyPrompt(jp), null, false);
      if (jev === CANCELLED || jev === null) {
        printFix(io, fixMode, null);
        return EXIT_CODES.config;
      }
      patch.jevApiKey = jev;
      patch.jevProvider = jp;
      if (other === 't') {
        // the optional OpenRouter generator key: Enter = skip (stays Jev-only through `config set mode jev-only`)
        const gen = await promptKey(io, 'OpenRouter API key (OPENROUTER_API_KEY) — Enter = skip: ', 'openrouter', true);
        if (gen === CANCELLED) return failAfterGenerator();
        if (gen !== null) {
          patch.provider = 'openrouter';
          patch.apiKey = gen;
        }
      } else persistJevOnly = true;
    } else if (other === 'a') {
      const gen = await promptKey(io, generatorPrompt('anthropic'), 'anthropic', false);
      if (gen === CANCELLED || gen === null) {
        printFix(io, fixMode, 'anthropic');
        return EXIT_CODES.config;
      }
      patch.provider = 'anthropic';
      patch.apiKey = gen;
      io.stdout.write(`${LOGIN_JEV_SKIP_HINT}\n`);
      const a = await promptJevProvider(io, true);
      if (a === CANCELLED) return failAfterGenerator();
      if (a !== null) {
        const jev = await promptKey(io, jevKeyPrompt(a), null, true);
        if (jev === CANCELLED) return failAfterGenerator();
        if (jev !== null) {
          patch.jevApiKey = jev;
          patch.jevProvider = a;
        }
      }
    } else {
      const k = await promptKey(io, loginOneKeyPrompt(mode), 'openrouter', false);
      if (k === CANCELLED || k === null) {
        printFix(io, fixMode, null);
        return EXIT_CODES.config;
      }
      oneKey(k);
    }
  } else if (interactive && generatorStep) {
    const gen = await promptKey(io, generatorPrompt(provider), asWizardProvider(provider), false);
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
  if (persistJevOnly) {
    // TUI-DESIGN-3 §1.6 (D-J ext.): `[j] Jev only` persists the mode beside the key
    const r = await writeConfigValue('mode', 'jev-only', { env: io.env, home: io.home, cwd: io.cwd, configFlag: flags.config ?? null, ...(io.platform ? { platform: io.platform } : {}) });
    io.stdout.write(`[setup] ${modeSavedItem('jev-only', r.displayPath)}\n`);
  }

  if (flags.verify) {
    const chosen = patch.provider ?? provider;
    const wizardChosen = asWizardProvider(chosen);
    const verifyMode: EngineMode = persistJevOnly ? 'jev-only' : patch.apiKey !== undefined && mode === 'jev-only' ? 'jev-on' : mode;
    const jp = patch.jevProvider ?? inferred;
    /**
     * TUI-DESIGN-5 §6.5 (D-AR): one of the five providers the hardened wizard does not know is verified with the
     * **free catalogue GET**, never the priced decider probe — spending a token to prove an OpenAI key can list
     * models is indefensible. The two the wizard does know keep `verifyKeys` (the landed priced path that also
     * checks the decider), so no existing `--verify` run changes shape.
     */
    const free: VerifyResult[] = [];
    if (wizardChosen === null && patch.apiKey !== undefined) {
      const check = await verifyProviderKey(chosen, patch.apiKey, { ...(io.fetch ? { fetch: io.fetch } : {}) });
      // an aborted check prints nothing (§7 row 78) and is not a failure; anything else is a row in the one list
      if (!(check.aborted === true)) free.push(providerCheckResult(check));
    }
    const verify = io.verify ?? ((input: VerifyInput) => verifyKeys(input, io.fetch ?? fetch));
    // the generator half was just checked for free; `verifyKeys` still runs, for the DECIDER key written in the
    // same invocation — returning early here silently verified strictly less than `--verify` used to (§6.5)
    const results = await verify({ provider: wizardChosen ?? 'openrouter', jevProvider: jp, generatorKey: wizardChosen === null ? null : (patch.apiKey ?? null), jevKey: patch.jevApiKey ?? null, mode: verifyMode, generatorModel: loginGeneratorModel(lookup, file), jevBaseUrl: JEV_PROVIDERS[jp ?? 'openrouter'].baseUrl, jevModel: JEV_PROVIDERS[jp ?? 'openrouter'].defaultModel });
    const all = [...free, ...results];
    for (const r of all) io.stdout.write(`[setup] ${r.text}\n`);
    return verifyExitCode(all);
  }
  return EXIT_CODES.ok;
}

/**
 * TUI-DESIGN §11.2: `jevcode logout [--generator] [--jev]` — rewrites the file atomically; env-sourced keys are reported, never touched.
 * TUI-DESIGN-3 §4.4 F16: the session calls it with `labelled: false` and adds the one `[setup]` label itself.
 */
export async function commandLogout(flags: LogoutFlags, io: CommandIo, opts: { labelled?: boolean } = {}): Promise<number> {
  const label = opts.labelled === false ? '' : '[setup] ';
  const keys: CredentialKey[] = [];
  if (flags.generator || (!flags.generator && !flags.jev)) keys.push('apiKey');
  if (flags.jev || (!flags.generator && !flags.jev)) keys.push('jevApiKey');
  try {
    const result = await removeCredentials(keys, { env: io.env, home: io.home, cwd: io.cwd, configFlag: flags.config ?? null, ...(io.platform ? { platform: io.platform } : {}) });
    for (const item of result.items) io.stdout.write(`${label}${item}\n`);
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
        io.stdout.write(`${label}${names[k]} is also set from ${r.source} (sha256:${fingerprint(r.value.trim())}) — not touched\n`);
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
