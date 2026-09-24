/**
 * Credentials writer (TUI-DESIGN §11.2, A117, A120, A125, D5). The wizard, `jevcode login`,
 * `jevcode logout` and `jevcode config set` all write `${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json`
 * (or `--config` / `JEVCODE_CONFIG`) through one path: read + merge (`provider`, `apiKey?`,
 * `jevApiKey?` for keys), `writeFileAtomic(…, { mode: 0o600, mkdir: true })`, then `chmod` the
 * file 0600 — and the directory 0700 only when it is the jevcode config dir (never a workspace or
 * `$HOME` a `--config` path points into); Windows prints the ACL note instead (P41). Never `./.env`,
 * `./jevcode.json` or the extra `.env` file (A118). Keys only ever leave this module as
 * fingerprints. The `[setup]`/`[config]` string builders live here so `src/tui` depends on
 * `src/config`, never the reverse.
 */
import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';
import { fingerprint } from '../core/hash.js';
import { isJsonObject, parseJson } from '../core/json.js';
import { MIN_SECRET_LENGTH } from '../core/redact.js';
import type { Json, JsonObject, Resolved } from '../core/types.js';
import { keyEnvNames, type ProviderId } from '../provider/ids.js';
import { ConfigError } from '../errors.js';

/** TUI-DESIGN §11.2: the file name under the jevcode config dir. */
export const CREDENTIALS_FILE_NAME = 'config.json';
/** TUI-DESIGN §11.2: the two secret file keys. */
export type CredentialKey = 'apiKey' | 'jevApiKey';
/** TUI-DESIGN §11.2: both secret file keys (logout default). */
export const CREDENTIAL_KEYS: readonly CredentialKey[] = ['apiKey', 'jevApiKey'];

/** TUI-DESIGN §24: `(Windows: protected by your user profile ACL)` (P41). */
export const WINDOWS_ACL_NOTE = '(Windows: protected by your user profile ACL)';

// ---------------------------------------------------------------------------------------
// §24 item strings (fingerprints only, never a key)
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §24: `generator key: entered (sha256:<8>) source=wizard` (the `[setup]` label is `TranscriptItem.label`). */
export function keyEnteredText(which: 'generator' | 'jev', fp: string, source: 'wizard' | 'login' | 'stdin' = 'wizard'): string {
  return `${which} key: entered (sha256:${fp.slice(0, 8)}) source=${source}`;
}

/**
 * TUI-DESIGN §24: `saved <path> (mode 0600, dir 0700)`; `(mode 0600)` when the directory is not
 * the jevcode config dir (a `--config` path: its parent's mode is left alone); on Windows the ACL
 * note replaces the mode (P41).
 */
export function savedText(shown: string, windows = false, dirSecured = true): string {
  if (windows) return `saved ${shown} ${WINDOWS_ACL_NOTE}`;
  return dirSecured ? `saved ${shown} (mode 0600, dir 0700)` : `saved ${shown} (mode 0600)`;
}

/** TUI-DESIGN §24 shadowing line (`[config]` label): env overrides the saved file. Fingerprints only. */
export function shadowingText(setting: string, envVar: string, envFingerprint: string, filePath: string, fileFingerprint: string): string {
  return `${setting}: env ${envVar} (sha256:${envFingerprint.slice(0, 8)}) overrides file ${filePath} (sha256:${fileFingerprint.slice(0, 8)}) — unset the variable to use the saved key`;
}

// ---------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §11.2: `${XDG_CONFIG_HOME:-~/.config}`; a relative XDG value is invalid per the spec and ignored. */
export function xdgConfigHome(env: NodeJS.ProcessEnv, home: string): string {
  const x = env['XDG_CONFIG_HOME']?.trim();
  return x && isAbsolute(x) ? x : join(home, '.config');
}

/** TUI-DESIGN §11.2 / §12.7: the XDG jevcode config dir. */
export function xdgJevcodeDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(xdgConfigHome(env, home), 'jevcode');
}

/** TUI-DESIGN §11.2: the legacy location, checked and preferred against when both exist (P30). */
export function legacyJevcodeDir(home: string): string {
  return join(home, '.config', 'jevcode');
}

/** TUI-DESIGN §12.7: `EngineOptions.configDirs` — XDG + legacy, de-duplicated, for the seatbelt read denies. */
export function configDirs(env: NodeJS.ProcessEnv, home: string): readonly string[] {
  return [...new Set([xdgJevcodeDir(env, home), legacyJevcodeDir(home)])];
}

/** TUI-DESIGN §11.2: where credentials are written and why. */
export interface CredentialsTarget {
  path: string;
  source: 'flag' | 'env' | 'xdg';
}

/** TUI-DESIGN §11.2: where credentials are written — `--config` > `JEVCODE_CONFIG` > the XDG file. */
export function credentialsPath(opts: { env: NodeJS.ProcessEnv; home: string; cwd: string; configFlag?: string | null }): CredentialsTarget {
  const flag = opts.configFlag?.trim();
  if (flag) return { path: resolvePath(opts.cwd, flag), source: 'flag' };
  const env = opts.env['JEVCODE_CONFIG']?.trim();
  if (env) return { path: resolvePath(opts.cwd, env), source: 'env' };
  return { path: join(xdgJevcodeDir(opts.env, opts.home), CREDENTIALS_FILE_NAME), source: 'xdg' };
}

/**
 * TUI-DESIGN §11.2: is `dir` one of the jevcode config dirs (XDG or legacy)? Only those are
 * chmod'ed 0700 — a `--config` path inside the workspace or `$HOME` never changes its parent's mode.
 */
export function isJevcodeConfigDir(dir: string, env: NodeJS.ProcessEnv, home: string): boolean {
  const d = resolvePath(dir);
  return configDirs(env, home).some((c) => resolvePath(c) === d);
}

/** `~/…` for display; never the value of anything. */
export function displayPath(path: string, home: string): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

// ---------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §11.2: a tolerant read of the credentials file. */
export interface CredentialsFile {
  path: string;
  exists: boolean;
  /** every key in the file (unknown keys are preserved on rewrite) */
  values: JsonObject;
  provider: string | null;
  apiKey: string | null;
  jevApiKey: string | null;
  /** TUI-DESIGN-2 §2.3 / §1.4: the Jev provider `login --jev-provider` saved next to `jevApiKey` (the `jevProvider` file key) */
  jevProvider: string | null;
  /** parse or read error (other than ENOENT); the file is treated as empty */
  error: string | null;
}

function errnoCode(e: unknown): string | null {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : null;
}

function stringOrNull(v: Json | undefined): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** TUI-DESIGN §11.2: tolerant read of a credentials file — missing → `exists: false`; malformed → `error` set, values empty. */
export async function readCredentialsFile(path: string): Promise<CredentialsFile> {
  const empty: CredentialsFile = { path, exists: false, values: {}, provider: null, apiKey: null, jevApiKey: null, jevProvider: null, error: null };
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    const code = errnoCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR') return empty;
    return { ...empty, exists: code !== 'ENOENT', error: `${code ?? 'error'}: cannot read ${path}` };
  }
  const parsed = parseJson(text);
  if (!parsed.ok || !isJsonObject(parsed.value)) return { ...empty, exists: true, error: `${path} is not a JSON object` };
  const values = parsed.value;
  return { path, exists: true, values, provider: stringOrNull(values['provider']), apiKey: stringOrNull(values['apiKey']), jevApiKey: stringOrNull(values['jevApiKey']), jevProvider: stringOrNull(values['jevProvider']), error: null };
}

// ---------------------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §11.2: environment for the writer (no I/O globals read inside). */
export interface WriteOptions {
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  /** `--config <file>` */
  configFlag?: string | null;
  platform?: NodeJS.Platform;
}

interface SecureWrite {
  windows: boolean;
  /** the directory was chmod'ed 0700 (jevcode config dir only) */
  dirSecured: boolean;
}

/**
 * The one write path: mkdir (0700 for the jevcode config dir, default mode elsewhere), atomic
 * write with the temp file created 0600 (no world-readable window), chmod the file 0600 (an
 * existing file keeps its bits otherwise), chmod the dir 0700 only for the jevcode config dir.
 * Any fs failure becomes `ConfigError('could not write <file>: <code>')` (§24, exit 2).
 */
async function writeJsonSecure(target: CredentialsTarget, values: JsonObject, opts: WriteOptions): Promise<SecureWrite> {
  const platform = opts.platform ?? process.platform;
  const windows = platform === 'win32';
  const dir = dirname(target.path);
  const secureDir = target.source === 'xdg' || isJevcodeConfigDir(dir, opts.env, opts.home);
  const shown = displayPath(target.path, opts.home);
  try {
    if (secureDir) {
      await mkdir(dirname(dir), { recursive: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } else await mkdir(dir, { recursive: true });
    await writeFileAtomic(target.path, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
    if (!windows) {
      await chmod(target.path, 0o600);
      if (secureDir) {
        try {
          await chmod(dir, 0o700);
        } catch {
          /* a dir we do not own (shared XDG_CONFIG_HOME): the file itself is 0600 */
        }
      }
    }
  } catch (e) {
    throw new ConfigError(`could not write ${shown}: ${errnoCode(e) ?? (e instanceof Error ? e.message : String(e))}`, { setting: 'configFile', cause: e });
  }
  return { windows, dirSecured: secureDir && !windows };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** TUI-DESIGN §11.2 / P30: one warning when both the XDG file and the legacy file exist (XDG preferred). */
export async function legacyWarning(env: NodeJS.ProcessEnv, home: string): Promise<string | null> {
  const xdg = join(xdgJevcodeDir(env, home), CREDENTIALS_FILE_NAME);
  const legacy = join(legacyJevcodeDir(home), CREDENTIALS_FILE_NAME);
  if (xdg === legacy) return null;
  if ((await exists(xdg)) && (await exists(legacy))) {
    return `both ${displayPath(xdg, home)} and ${displayPath(legacy, home)} exist — the XDG file wins; remove the legacy file to silence this`;
  }
  return null;
}

/** TUI-DESIGN §11.2: `./jevcode.json` takes precedence for non-secret keys (research 13 §5.4). */
export function jevcodeJsonWarning(savedTo: string): string {
  return `./jevcode.json takes precedence for non-secret keys; keys were saved to ${savedTo} — remove any apiKey there`;
}

/**
 * TUI-DESIGN §11.2: the only keys the wizard/login ever write.
 *
 * TUI-DESIGN-5 §6.3 row 3: `provider` is `ProviderId` (seven), not the two-member literal it re-declared. The
 * import is `provider/ids.ts`, which has **zero imports** and is the one provider module the argv path may read
 * (`ids.ts`'s own docblock; §6.2) — never `models/providers.ts`, which would pull `provider/openrouter.js` onto
 * this path through `config/**`.
 *
 * The **slot count is unchanged** (D-AR as §6.5 states it): one `apiKey` + one `provider`. A user who wants several
 * providers live at once exports several env vars, which `PROVIDER_KEY_ENV`'s per-provider lookup already serves.
 * §0.1's D-AR row asks for a per-provider *map* instead; §6.5 and §15 Q12 defer that migration (it touches
 * `jevcode logout`, `--config`, `resolve.ts` and every existing file), so this widening is written to be a strict
 * subset of that shape rather than an obstacle to it.
 */
export interface CredentialsPatch {
  provider?: ProviderId;
  apiKey?: string;
  jevApiKey?: string;
  /** TUI-DESIGN-2 §2.3 / §1.4: written as the `jevProvider` file key beside `jevApiKey` so resolve.ts reads it as the `file:` layer of decider.provider */
  jevProvider?: 'typesafe' | 'openrouter';
}

/** TUI-DESIGN §11.2: what a write reports — fingerprints, never keys. */
export interface WriteCredentialsResult {
  path: string;
  displayPath: string;
  dir: string;
  /** `[setup]` item texts (fingerprints only) */
  items: string[];
  warnings: string[];
  fingerprints: { generator: string | null; jev: string | null };
  windows: boolean;
  /** the directory is the jevcode config dir and was set to 0700 */
  dirSecured: boolean;
}

function checkKey(name: 'apiKey' | 'jevApiKey', value: string | undefined): void {
  if (value === undefined) return;
  const setting = name === 'apiKey' ? 'generator.apiKey' : 'decider.apiKey';
  if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) throw new ConfigError(`${setting}: a key must have at least ${MIN_SECRET_LENGTH} characters`, { setting });
  if (/\s/.test(value)) throw new ConfigError(`${setting}: a key never contains whitespace`, { setting });
}

/**
 * TUI-DESIGN §11.2: merge `patch` into the credentials file and write it atomically with mode
 * 0600 (dir 0700 when it is the jevcode config dir). Returns the `[setup]` item texts and
 * warnings; the keys themselves are never returned, only their fingerprints.
 */
export async function writeCredentials(patch: CredentialsPatch, opts: WriteOptions, source: 'wizard' | 'login' | 'stdin' = 'wizard'): Promise<WriteCredentialsResult> {
  checkKey('apiKey', patch.apiKey);
  checkKey('jevApiKey', patch.jevApiKey);
  const target = credentialsPath(opts);
  const existing = await readCredentialsFile(target.path);
  if (existing.error) throw new ConfigError(`configFile: ${existing.error}; refusing to overwrite a file that is not ours to merge`, { setting: 'configFile' });
  const values: JsonObject = { ...existing.values };
  if (patch.provider) values['provider'] = patch.provider;
  if (patch.apiKey !== undefined) values['apiKey'] = patch.apiKey;
  if (patch.jevApiKey !== undefined) values['jevApiKey'] = patch.jevApiKey;
  if (patch.jevProvider !== undefined) values['jevProvider'] = patch.jevProvider;
  const { windows, dirSecured } = await writeJsonSecure(target, values, opts);

  const shown = displayPath(target.path, opts.home);
  const items: string[] = [];
  const fps = { generator: patch.apiKey !== undefined ? fingerprint(patch.apiKey) : null, jev: patch.jevApiKey !== undefined ? fingerprint(patch.jevApiKey) : null };
  if (fps.generator) items.push(keyEnteredText('generator', fps.generator, source));
  if (fps.jev) items.push(keyEnteredText('jev', fps.jev, source));
  items.push(savedText(shown, windows, dirSecured));

  const warnings: string[] = [];
  const legacy = await legacyWarning(opts.env, opts.home);
  if (legacy) warnings.push(legacy);
  if (target.source === 'xdg' && (await exists(join(opts.cwd, 'jevcode.json')))) warnings.push(jevcodeJsonWarning(shown));
  return { path: target.path, displayPath: shown, dir: dirname(target.path), items, warnings, fingerprints: fps, windows, dirSecured };
}

/** TUI-DESIGN §11.2: what `logout` reports. */
export interface RemoveCredentialsResult {
  path: string;
  removed: { key: CredentialKey; fingerprint: string }[];
  /** keys asked for but absent from the file */
  absent: CredentialKey[];
  items: string[];
}

/** TUI-DESIGN §11.2: `jevcode logout` — drop the named keys from the file and rewrite atomically with the same modes; fingerprints only. */
export async function removeCredentials(keys: readonly CredentialKey[], opts: WriteOptions): Promise<RemoveCredentialsResult> {
  const target = credentialsPath(opts);
  const existing = await readCredentialsFile(target.path);
  const removed: RemoveCredentialsResult['removed'] = [];
  const absent: CredentialKey[] = [];
  const values: JsonObject = { ...existing.values };
  for (const k of keys) {
    const v = values[k];
    if (typeof v === 'string' && v.length > 0) {
      removed.push({ key: k, fingerprint: fingerprint(v) });
      delete values[k];
    } else absent.push(k);
  }
  const items: string[] = [];
  if (removed.length > 0 && !existing.error) {
    await writeJsonSecure(target, values, opts);
    for (const r of removed) items.push(`removed ${r.key === 'apiKey' ? 'generator' : 'jev'} key (sha256:${r.fingerprint}) from ${displayPath(target.path, opts.home)}`);
  }
  for (const a of absent) items.push(`${a === 'apiKey' ? 'generator' : 'jev'} key: not in ${displayPath(target.path, opts.home)}`);
  return { path: target.path, removed, absent, items };
}

/** TUI-DESIGN §16: `jevcode config set <k> <v>` — a non-secret file key merged into the same file, same modes. */
export async function writeConfigValue(fileKey: string, value: string | number | boolean, opts: WriteOptions): Promise<{ path: string; displayPath: string }> {
  const target = credentialsPath(opts);
  const existing = await readCredentialsFile(target.path);
  if (existing.error) throw new ConfigError(`configFile: ${existing.error}`, { setting: 'configFile' });
  const values: JsonObject = { ...existing.values, [fileKey]: value };
  await writeJsonSecure(target, values, opts);
  return { path: target.path, displayPath: displayPath(target.path, opts.home) };
}

/**
 * The variable a generator key resolved from the environment came from: `JEVCODE_API_KEY` when set (the setting's own
 * env row), else the first of the provider's key variables that is set (`FIREWORKS_API_KEY`, `GEMINI_API_KEY` or
 * `GOOGLE_API_KEY`, …), else the provider's canonical name. The shadowing line used to say `OPENROUTER_API_KEY` for
 * every provider but anthropic (S6 live run of 2026-09-23, `--provider fireworks`).
 */
export function generatorKeyEnvVar(provider: ProviderId, env: Readonly<Record<string, string | undefined>>): string {
  const names = ['JEVCODE_API_KEY', ...keyEnvNames(provider)];
  return names.find((n) => (env[n] ?? '').trim() !== '') ?? keyEnvNames(provider)[0] ?? 'JEVCODE_API_KEY';
}

/**
 * TUI-DESIGN §11.2 / P43 shadowing: when a secret resolved from `env`/`dotenv` and the file also
 * holds that key with a different fingerprint, the `[config]` line; null otherwise. Pure.
 */
export function shadowingLine(setting: 'generator.apiKey' | 'decider.apiKey', resolved: Resolved<string> | undefined, envVar: string, filePath: string, fileValue: string | null, home: string): string | null {
  if (!resolved || fileValue === null || fileValue === '') return null;
  if (resolved.source !== 'env' && !resolved.source.startsWith('dotenv:')) return null;
  const envFp = fingerprint(resolved.value.trim());
  const fileFp = fingerprint(fileValue.trim());
  if (envFp === fileFp) return null;
  const where = resolved.source === 'env' ? envVar : `${envVar} (${resolved.source})`;
  return shadowingText(setting, where, envFp, displayPath(filePath, home), fileFp);
}
