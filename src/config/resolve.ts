/**
 * Configuration resolution (DESIGN.md §3, TUI-DESIGN §16) and the pure --resume reconciliation (§9).
 *
 * Precedence, highest first: flag > process env > ./.env > <OPEN_ASSIST_PATH>/.env > config
 * file > default. Every entry records its source. Nothing is validated here except what is
 * needed to find the other sources (config file, Open Assist path) and the eager, cheap
 * settings (sandbox, booleans, paths); generator(), decider(), limits() and ui() validate lazily
 * so `jevcode run` / `jevcode chat` can render the first frame before any key is checked.
 *
 * TUI-DESIGN §16 adds two resolution classes: launch settings (fps, renderMode, ascii, screenReader, noColor) come
 * from `resolveLaunchSettings(flags, env)` — flag > env > default, never the file (a file value is recorded as
 * `ignored:launch`) — and session settings follow the full chain through `ui(launch)`. The run spend cap default is
 * mode-keyed (P45: $0.25 under jev-only) and the session cap derives from it (5 ×, source `derived`).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParsedFlags } from '../cli/args.js';
import type {
  CheckpointState,
  ConfigRecordValue,
  ConfigSource,
  DeciderConfig,
  EngineMode,
  GeneratorConfig,
  JevProvider,
  JevProviderSource,
  Json,
  LaunchSettings,
  Resolved,
  ResolvedConfig,
  RunLimits,
  RunMeta,
  SandboxProfile,
  SecretSettingName,
  StopReason,
  UiConfig,
} from '../core/types.js';
import { formatDuration, parseDuration } from '../core/time.js';
import { clip } from '../core/text.js';
import { isJsonObject, parseJson } from '../core/json.js';
import { ConfigError } from '../errors.js';
import { MIN_SECRET_LENGTH, createRedactor, patternRedact, SECRET_NAME_RE, type SecretEntry } from '../core/redact.js';
import { JEV_PROVIDERS, equivalentJevModel, jevModelMatches as providerJevModelMatches, providerForHost, sameJevWeights } from '../jev/providers.js';
import {
  CACHE_READ_FACTOR,
  CACHE_WRITE_FACTOR,
  DEFAULT_MODE,
  KNOWN_KEY_ENV,
  MODE_SETTING_VALUES,
  SESSION_CAP_MULTIPLIER,
  SETTINGS,
  SECRET_SETTINGS,
  TRACE_ENV,
  TRACE_LOG_LEVEL,
  configDirsFor,
  legacyConfigDir,
  lookupPricing,
  settingSpec,
  xdgConfigDir,
} from './defaults.js';
import { readDotenv } from './env.js';
import { parseModeHint as parseModeHintText, resolveLaunchSettingsWithSources, type LaunchFlags } from './launch.js';
import { maskEntries } from './mask.js';
import { defaultRunSpendCapUsd, resolveSessionSpendCap, resolveUiConfig, runSpendCapUsd } from './ui.js';
import {
  deriveMaxGeneratorTokens,
  jevModelMatches,
  normaliseJevModelId,
  parseBooleanSetting,
  parseJevProviderSetting,
  parseModeSetting,
  readAllowUnpriced,
  validateDecider,
  validateGenerator,
  validateLimits,
  validateSandbox,
  type SettingReader,
} from './validate.js';
import type { LoadedConfigFile, LoadedDotenv, ResolveOptions, ResolvedConfigWithDiagnostics, ResumeCurrentInputs, ResumeIdentity, ResumeReconciliation, SettingName, SettingSpec } from './types.js';

export type { ResolveOptions, ResolvedConfigWithDiagnostics, ResumeCurrentInputs, ResumeIdentity, ResumeLimitSources, ResumeReconciliation, ResumeStateSummary, ResumeOverride } from './types.js';

/** A config file larger than this is not ours to parse. */
export const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

const PROVIDER_KEY_ENV: Readonly<Record<string, string>> = { anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' };

/** Walk up from this module until a package.json named jevcode is found (src/config/ in dev, dist/ when bundled). */
export function detectPackageRoot(fromDir: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = fromDir;
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = parseJson(readFileSync(pkg, 'utf8'));
        if (parsed.ok && isJsonObject(parsed.value) && parsed.value['name'] === 'jevcode') return dir;
      } catch {
        // unreadable package.json: keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function scalarToString(v: Json): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return null;
}

/** Keys accepted in jevcode.json: the camelCase fileKey of each setting, any of its env variable names (inverted ones included), or a launch setting's ignored key. */
function fileKeyToSetting(): Map<string, SettingSpec> {
  const m = new Map<string, SettingSpec>();
  for (const s of SETTINGS) {
    if (s.fileKey) m.set(s.fileKey, s);
    if (s.ignoredFileKey) m.set(s.ignoredFileKey, s);
    for (const e of s.env) m.set(e, s);
    for (const e of s.negateEnv ?? []) m.set(e, s);
  }
  return m;
}

/**
 * TUI-DESIGN §16 inverted-polarity variables (`JEVCODE_NO_HISTORY=1` → `ui.history` false): a recognised boolean is
 * flipped; anything else is kept verbatim so the validator reports the malformed value with its real source.
 */
export function negateBooleanText(v: string): string {
  const t = v.trim().toLowerCase();
  if (t === 'true' || t === '1' || t === 'yes') return 'false';
  if (t === 'false' || t === '0' || t === 'no') return 'true';
  return v;
}

/** How far down the chain a source sits (flag 0 … default 4); `derived` and the rest rank below every real layer. */
function layerRank(source: string): number {
  if (source === 'flag') return 0;
  if (source === 'env') return 1;
  if (source.startsWith('dotenv:')) return 2;
  if (source.startsWith('file:')) return 3;
  if (source === 'default') return 4;
  return 5;
}

/**
 * V8 quotes up to ten characters of the offending source in some SyntaxErrors
 * (`Unexpected token 's', "sk-or-v1-a"... is not valid JSON`); a config file holds keys, so
 * the quoted fragment is dropped and the rest goes through the pattern layer before the
 * message can reach stderr, which runs before the redactor exists.
 */
function sanitiseJsonError(message: string): string {
  return patternRedact(message.replace(/, "[^"]*"(?:\.\.\.)? is not valid JSON/, ' (source not shown)'));
}

/** DESIGN §3: parse jevcode.json; TUI-DESIGN §16: a launch setting's key is kept apart as `ignoredLaunch` (never applied). */
export async function readConfigFile(path: string): Promise<LoadedConfigFile> {
  let text: string;
  try {
    const buf = await readFile(path);
    if (buf.byteLength > MAX_CONFIG_FILE_BYTES) throw new ConfigError(`configFile: ${path} is larger than ${MAX_CONFIG_FILE_BYTES} bytes`, { setting: 'configFile' });
    text = buf.toString('utf8');
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`configFile: cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`, { setting: 'configFile', cause: e });
  }
  const parsed = parseJson(text);
  if (!parsed.ok) throw new ConfigError(`configFile: ${path} is not valid JSON: ${sanitiseJsonError(parsed.error)}`, { setting: 'configFile' });
  if (!isJsonObject(parsed.value)) throw new ConfigError(`configFile: ${path} must contain a JSON object`, { setting: 'configFile' });
  const known = fileKeyToSetting();
  const values = new Map<string, string>();
  const ignoredLaunch = new Map<SettingName, string>();
  const unknownKeys: string[] = [];
  for (const [k, v] of Object.entries(parsed.value)) {
    const spec = known.get(k);
    if (!spec || (!spec.fileKey && !spec.ignoredFileKey)) {
      unknownKeys.push(k);
      continue;
    }
    if (spec.launch) {
      // TUI-DESIGN §16: a launch key can never take effect, so its shape is not worth a fatal error — it is only reported (ignored:launch).
      ignoredLaunch.set(spec.name, scalarToString(v) ?? clip(JSON.stringify(v), 80));
      continue;
    }
    const s = scalarToString(v);
    if (s === null) throw new ConfigError(`configFile: ${path} key "${k}" must be a string, number or boolean`, { setting: spec.name });
    // an inverted variable name used as a file key (`"JEVCODE_NO_HISTORY": true`) keeps the variable's polarity
    if (spec.fileKey) values.set(spec.fileKey, spec.negateEnv?.includes(k) === true ? negateBooleanText(s) : s);
  }
  return { path, values, unknownKeys, ignoredLaunch };
}

/** The precedence layers `resolveConfig` reads (flag > env > dotenvs > file > default); exported for `resolveMode` (TUI-DESIGN-2 §1.2). */
export interface Layers {
  flags: ParsedFlags;
  env: NodeJS.ProcessEnv;
  dotenvs: LoadedDotenv[];
  file: LoadedConfigFile | null;
  /** extra env names checked first for a setting (generator key by provider) */
  extraEnv: Partial<Record<SettingName, readonly string[]>>;
}

interface EnvName {
  name: string;
  /** TUI-DESIGN §16: an inverted-polarity variable (`JEVCODE_NO_HISTORY`); its boolean is flipped on read */
  negate: boolean;
}

/** The env / dotenv names of a setting in precedence order: provider-specific extras, `env`, then the inverted names. */
function envNames(layers: Layers, spec: SettingSpec): readonly EnvName[] {
  const extra = layers.extraEnv[spec.name] ?? [];
  return [...extra.map((name) => ({ name, negate: false })), ...spec.env.map((name) => ({ name, negate: false })), ...(spec.negateEnv ?? []).map((name) => ({ name, negate: true }))];
}

/** A resolved value plus the variable name that produced it (null for a flag, file or default hit). */
interface Hit extends Resolved<string> {
  via: string | null;
}

/**
 * Structural flag read: `ParsedFlags` is typed by the flag lists in cli/args.ts, which gain the §16 keys in O10's PR;
 * reading by name keeps this module compiling either way (an unknown key is simply absent).
 */
function flagValue(flags: ParsedFlags, key: string): unknown {
  return (flags as unknown as Readonly<Record<string, unknown>>)[key];
}

/** The flag layer of a setting: a non-empty value flag, or a boolean flag's presence (`true`, or `false` when it negates). */
function flagLayer(flags: ParsedFlags, spec: SettingSpec): Resolved<string> | null {
  if (spec.flag) {
    const v = flagValue(flags, spec.flag);
    if (typeof v === 'string' && v.trim() !== '') return { value: v, source: 'flag' };
  }
  if (spec.boolFlag && flagValue(flags, spec.boolFlag.key) === true) return { value: spec.boolFlag.negate ? 'false' : 'true', source: 'flag' };
  return null;
}

/** Empty strings count as unset at every layer: `.env.example` ships `ANTHROPIC_API_KEY=`. Inverted names flip their boolean. */
function lookupDetailed(layers: Layers, spec: SettingSpec, opts: { useFile: boolean; useDefault: boolean } = { useFile: true, useDefault: true }): Hit | null {
  const fromFlag = flagLayer(layers.flags, spec);
  if (fromFlag) return { ...fromFlag, via: null };
  const names = envNames(layers, spec);
  const read = (n: EnvName, v: string | undefined, source: ConfigSource): Hit | null => {
    if (v === undefined || v.trim() === '') return null;
    return { value: n.negate ? negateBooleanText(v) : v, source, via: n.name };
  };
  for (const n of names) {
    const hit = read(n, layers.env[n.name], 'env');
    if (hit) return hit;
  }
  for (const d of layers.dotenvs) {
    for (const n of names) {
      const hit = read(n, d.vars.get(n.name), `dotenv:${d.path}`);
      if (hit) return hit;
    }
  }
  if (opts.useFile && layers.file && spec.fileKey) {
    const v = layers.file.values.get(spec.fileKey);
    if (v !== undefined && v.trim() !== '') return { value: v, source: `file:${layers.file.path}`, via: null };
  }
  if (opts.useDefault && spec.defaultValue !== null) return { value: spec.defaultValue, source: 'default', via: null };
  return null;
}

/** `lookupDetailed` without the variable name: exactly `{ value, source }`, the shape `entries` and `record()` hold. */
function lookup(layers: Layers, spec: SettingSpec, opts?: { useFile: boolean; useDefault: boolean }): Resolved<string> | null {
  const hit = lookupDetailed(layers, spec, opts);
  return hit ? { value: hit.value, source: hit.source } : null;
}

function describeSources(layers: Layers, spec: SettingSpec, flagName: string | null): string[] {
  const out: string[] = [];
  if (flagName) out.push(`--${flagName} (flag)`);
  const names = envNames(layers, spec).map((n) => (n.negate ? `${n.name} (inverted)` : n.name));
  if (names.length > 0) out.push(`${names.join(' / ')} (env)`);
  for (const d of layers.dotenvs) if (names.length > 0) out.push(`${names.join(' / ')} (dotenv:${d.path})`);
  if (layers.file && spec.fileKey) out.push(`${spec.fileKey} (file:${layers.file.path})`);
  if (layers.file && spec.launch && spec.ignoredFileKey) out.push(`${spec.ignoredFileKey} (file:${layers.file.path}, ignored:launch)`);
  out.push(spec.defaultValue !== null ? `default ${spec.defaultValue}` : 'no default');
  return out;
}

/** A derived number for the record: 12 significant digits, so `3 × 0.1` prints `0.3`, not `0.30000000000000004`. */
function numText(n: number): string {
  return String(Number(n.toPrecision(12)));
}

function kebab(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function flagNameFor(spec: SettingSpec): string | null {
  // ParsedFlags keys are camelCase of the long flag; reverse it for messages.
  if (spec.flag) return kebab(spec.flag);
  if (spec.boolFlag) return kebab(spec.boolFlag.key);
  return null;
}

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-2 §2.3: the Jev provider (rules 1–2e), resolved before the key row so it can steer the key order (step 3)
// ---------------------------------------------------------------------------------------

/** What `decider.provider` resolved to and why. */
interface JevProviderResolution {
  provider: JevProvider;
  providerSource: JevProviderSource;
  /** the `decider.provider` entry: the explicit row, `derived` for an auto rule, `default` when nothing decided (rule 2e) */
  entry: Resolved<string>;
}

function isExplicitProviderSource(s: string): s is 'flag' | 'env' | `dotenv:${string}` | `file:${string}` {
  return s === 'flag' || s === 'env' || s.startsWith('dotenv:') || s.startsWith('file:');
}

/** rules 2b–2d: the variable is set (non-empty) in the process environment or in any loaded .env */
function keyVariablePresent(layers: Layers, name: string): boolean {
  const v = layers.env[name];
  if (typeof v === 'string' && v.trim() !== '') return true;
  return layers.dotenvs.some((d) => (d.vars.get(name) ?? '').trim() !== '');
}

/** A reader over the layers alone for the eager, pre-`entries` validations (`decider.provider`, `mode`): the row given plus the consulted-sources list. */
function layerReader(layers: Layers, name: SettingName, row: Resolved<string> | undefined): SettingReader {
  return {
    get: (n) => (n === name ? row : undefined),
    sources: (n) => describeSources(layers, settingSpec(n), flagNameFor(settingSpec(n))),
  };
}

/**
 * TUI-DESIGN-2 §2.3 rules 1–2e. Rule 1's "any other value → ConfigError (exit 2) naming the source" is eager (like `validateSandbox`):
 * `JEV_PROVIDER=foo jevcode chat --mock` fails at resolveConfig rather than running silently with the bad row recorded (`decider()`
 * is never called under --mock).
 */
function resolveJevProvider(layers: Layers): JevProviderResolution {
  const row = lookup(layers, settingSpec('decider.provider')) ?? { value: 'auto', source: 'default' };
  // rule 1: flag > JEV_PROVIDER > ./.env > <OPEN_ASSIST_PATH>/.env > file jevProvider; any other value is a ConfigError naming the source
  const v = parseJevProviderSetting(layerReader(layers, 'decider.provider', row), row);
  if (v === 'typesafe' || v === 'openrouter') return { provider: v, providerSource: isExplicitProviderSource(row.source) ? row.source : 'default', entry: { value: v, source: row.source } };
  // rule 2a: a configured base URL whose host the table knows
  const baseR = lookup(layers, settingSpec('decider.baseUrl'));
  if (baseR && baseR.source !== 'default') {
    const host = providerForHost(baseR.value.trim());
    if (host !== null) return { provider: host, providerSource: 'auto:base-url', entry: { value: host, source: 'derived' } };
  }
  // rules 2b–2d: today's users configured JEV_API_KEY for OpenRouter and are not redirected; then the TypeSafe key; then the OpenRouter key
  if (keyVariablePresent(layers, 'JEV_API_KEY')) return { provider: 'openrouter', providerSource: 'auto:openrouter-key', entry: { value: 'openrouter', source: 'derived' } };
  if (keyVariablePresent(layers, 'TYPESAFE_API_KEY')) return { provider: 'typesafe', providerSource: 'auto:typesafe-key', entry: { value: 'typesafe', source: 'derived' } };
  if (keyVariablePresent(layers, 'OPENROUTER_API_KEY')) return { provider: 'openrouter', providerSource: 'auto:openrouter-key', entry: { value: 'openrouter', source: 'derived' } };
  // rule 2e: nothing — the wizard asks (§1.4); nothing is sent
  return { provider: 'openrouter', providerSource: 'default', entry: { value: 'openrouter', source: 'default' } };
}

/** TUI-DESIGN-2 §1.2 / TUI-DESIGN-3 §1.1: `--mode` (or its hidden alias `--condition`) as an argv-only hint; anything else is DEFAULT_MODE (the one rule; cli/main.tsx has no twin). */
export function modeFromParsedFlags(flags: ParsedFlags): EngineMode {
  const m = flags.mode ?? flags.condition;
  return isEngineMode(m) ? m : DEFAULT_MODE;
}

/** the `MODE_SETTING_VALUES` membership test as a type guard (`includes` over a readonly tuple narrows nothing) */
export function isEngineMode(v: unknown): v is EngineMode {
  return typeof v === 'string' && (MODE_SETTING_VALUES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-2 §1.2 (D-A): the `mode` setting — flag > JEVCODE_MODE > ./.env > <OPEN_ASSIST_PATH>/.env > file `mode` > DEFAULT_MODE
// ---------------------------------------------------------------------------------------

/** The `mode` row through the chain; `--condition` (args.ts's hidden alias, not the row's flag key) counts as the flag layer. */
function modeRow(layers: Layers): Resolved<string> {
  const spec = settingSpec('mode');
  const fromFlag = flagLayer(layers.flags, spec);
  if (fromFlag) return fromFlag;
  const condition = flagValue(layers.flags, 'condition');
  if (typeof condition === 'string' && condition.trim() !== '') return { value: condition, source: 'flag' };
  return lookup(layers, spec) ?? { value: spec.defaultValue ?? DEFAULT_MODE, source: 'default' };
}

/** TUI-DESIGN-2 §1.2: the resolved engine mode, or the §12 ConfigError `mode: "<v>" (from <source>) is not one of jev-only|jev-on|jev-off|llm-jev`. */
export function resolveMode(layers: Layers): EngineMode {
  return parseModeSetting(modeRow(layers));
}

const LAUNCH_ROW_NAMES: readonly SettingName[] = ['ui.fps', 'ui.renderMode', 'ui.screenReader', 'ui.ascii', 'ui.noColor'];

/** TUI-DESIGN §16 (P30): legacy config paths already warned about in this process — the warning is printed once. */
const legacyWarned = new Set<string>();

function launchRows(flags: ParsedFlags, env: NodeJS.ProcessEnv): Map<SettingName, Resolved<string>> {
  const launchFlags: LaunchFlags = {
    ...(typeof flagValue(flags, 'fps') === 'string' ? { fps: flagValue(flags, 'fps') as string } : {}),
    ...(typeof flagValue(flags, 'renderMode') === 'string' ? { renderMode: flagValue(flags, 'renderMode') as string } : {}),
    ...(flagValue(flags, 'screenReader') === true ? { screenReader: true } : {}),
    ...(flagValue(flags, 'ascii') === true ? { ascii: true } : {}),
    ...(flagValue(flags, 'noColor') === true ? { noColor: true } : {}),
    // TUI-DESIGN-2 §6 item 14: modeHint / reducedMotion are computed too (the rows below are the five §16 launch settings only)
    ...(typeof flagValue(flags, 'mode') === 'string' ? { mode: flagValue(flags, 'mode') as string } : {}),
    ...(flagValue(flags, 'noAnimation') === true ? { noAnimation: true } : {}),
  };
  const { settings, sources } = resolveLaunchSettingsWithSources(launchFlags, env);
  return new Map<SettingName, Resolved<string>>([
    ['ui.fps', { value: String(settings.fps), source: sources.fps }],
    ['ui.renderMode', { value: settings.renderMode, source: sources.renderMode }],
    ['ui.screenReader', { value: String(settings.screenReader), source: sources.screenReader }],
    ['ui.ascii', { value: String(settings.ascii), source: sources.ascii }],
    ['ui.noColor', { value: String(settings.noColor), source: sources.noColor }],
  ]);
}

/**
 * DESIGN §3 / TUI-DESIGN §16: resolve every setting with its source. Throws ConfigError only for what the first frame
 * needs (config file location and syntax, sandbox profile, the two eager booleans); every section validates lazily.
 */
export async function resolveConfig(flags: ParsedFlags, env: NodeJS.ProcessEnv, cwd: string, opts: ResolveOptions = {}): Promise<ResolvedConfigWithDiagnostics> {
  const home = opts.homedir ?? osHomedir();
  const packageRoot = opts.packageRoot ?? detectPackageRoot();
  const warnings: string[] = [];
  const consultedPaths: string[] = [];
  const layers: Layers = { flags, env, dotenvs: [], file: null, extraEnv: {} };

  // 1. ./.env
  const cwdDotenv = join(cwd, '.env');
  consultedPaths.push(cwdDotenv);
  const localEnv = await readDotenv(cwdDotenv);
  if (localEnv) layers.dotenvs.push(localEnv);

  // 2. config file: flag > env > ./.env, then ./jevcode.json, the XDG file, the legacy file (TUI-DESIGN §16, P30: XDG
  //    preferred, legacy checked with a one-time warning). It cannot come from the Open Assist .env or from itself.
  let configFile: LoadedConfigFile | null = null;
  let configFileEntry: Resolved<string> | null = null;
  const cfgSpec = settingSpec('configFile');
  const cfgR = lookup(layers, cfgSpec, { useFile: false, useDefault: false });
  const xdgFile = join(xdgConfigDir(home, env), 'config.json');
  const legacyFile = join(legacyConfigDir(home), 'config.json');
  if (cfgR) {
    const p = resolvePath(cwd, cfgR.value);
    consultedPaths.push(p);
    if (!isFile(p)) throw new ConfigError(`configFile: ${p} (from ${cfgR.source}) does not exist`, { setting: 'configFile' });
    configFile = await readConfigFile(p);
    configFileEntry = { value: p, source: cfgR.source };
  } else {
    const candidates = [join(cwd, 'jevcode.json'), xdgFile, ...(legacyFile !== xdgFile ? [legacyFile] : [])];
    for (const candidate of candidates) {
      consultedPaths.push(candidate);
      if (isFile(candidate)) {
        configFile = await readConfigFile(candidate);
        configFileEntry = { value: candidate, source: 'default' };
        if (candidate === legacyFile && legacyFile !== xdgFile && opts.suppressLegacyWarning !== true && !legacyWarned.has(legacyFile)) {
          // P30: warn once per process (the 7b flow re-runs resolveConfig after /login; the user reads this once)
          legacyWarned.add(legacyFile);
          warnings.push(`configFile: using the legacy ${legacyFile}; move it to ${xdgFile} (XDG_CONFIG_HOME) — the legacy path is read only when the XDG file is absent`);
        }
        break;
      }
    }
  }
  layers.file = configFile;
  if (configFile && configFile.unknownKeys.length > 0) warnings.push(`configFile: ${configFile.path} has unknown keys ignored: ${configFile.unknownKeys.join(', ')}`);
  if (configFile && configFile.ignoredLaunch.size > 0) {
    const keys = [...configFile.ignoredLaunch.keys()].map((n) => settingSpec(n).ignoredFileKey ?? n);
    warnings.push(`configFile: ${configFile.path} sets launch settings that a file cannot change (${keys.join(', ')}); use the flag or the environment variable (ignored:launch)`);
  }

  // 3. Open Assist path: flag > env > ./.env > file > sibling default; then its .env joins the chain.
  const oaSpec = settingSpec('openAssistPath');
  let oaEntry: Resolved<string> | null = null;
  const oaR = lookup(layers, oaSpec);
  if (oaR) oaEntry = { value: resolvePath(cwd, oaR.value), source: oaR.source };
  else if (packageRoot) {
    const sibling = join(dirname(packageRoot), 'open-assist');
    if (isDirectory(sibling)) oaEntry = { value: sibling, source: 'default' };
  }
  if (oaEntry) {
    const oaDotenv = join(oaEntry.value, '.env');
    if (oaDotenv !== cwdDotenv) {
      consultedPaths.push(oaDotenv);
      const loaded = await readDotenv(oaDotenv);
      if (loaded) layers.dotenvs.push(loaded);
    }
  }

  // 3b. TUI-DESIGN-2 §1.2: the `mode` setting, resolved once every layer is loaded and before the mode-keyed cap default below.
  //     A --resume re-resolve passes run.json's mode (opts.mode) and the chain is not consulted (TUI-DESIGN §9.1, P45).
  const entries = new Map<SettingName, Resolved<string>>();
  const modeR = modeRow(layers);
  const mode: EngineMode = opts.mode ?? parseModeSetting(modeR);
  entries.set('mode', opts.mode !== undefined ? { value: opts.mode, source: modeR.source !== 'default' && parseModeHintText(modeR.value) === opts.mode ? modeR.source : 'default' } : { value: mode, source: modeR.source });

  // 4. Provider first: it decides which env var holds the generator key.
  const providerR = lookup(layers, settingSpec('generator.provider'));
  if (providerR) {
    entries.set('generator.provider', providerR);
    const keyEnv = PROVIDER_KEY_ENV[providerR.value.trim().toLowerCase()];
    if (keyEnv) layers.extraEnv['generator.apiKey'] = [keyEnv];
  }
  // 4b. TUI-DESIGN-2 §2.3: the Jev provider likewise — step 3 prepends its variable (TYPESAFE_API_KEY) to the decider key
  //     lookup when the provider was explicit, host- or TypeSafe-key-inferred; under `auto:openrouter-key` / `default` today's
  //     order `JEV_API_KEY, OPENROUTER_API_KEY` applies unchanged, so no existing user's paying key changes.
  //     §10 deviation (recorded): for an explicit `openrouter` the variable is already in the row, so today's order
  //     `JEV_API_KEY, OPENROUTER_API_KEY` stands (the spec's own openrouter consulted-list string) rather than a prepend that would
  //     flip the paying key of a user holding both.
  const jev = resolveJevProvider(layers);
  entries.set('decider.provider', jev.entry);
  const jevKeyEnv = JEV_PROVIDERS[jev.provider].keyEnv;
  if (jev.providerSource !== 'auto:openrouter-key' && jev.providerSource !== 'default' && !settingSpec('decider.apiKey').env.includes(jevKeyEnv)) {
    layers.extraEnv['decider.apiKey'] = [jevKeyEnv];
  }

  let logFileHit: Hit | null = null;
  let deciderKeyHit: Hit | null = null;
  for (const spec of SETTINGS) {
    if (spec.name === 'generator.provider' || spec.name === 'decider.provider' || spec.name === 'mode' || spec.name === 'configFile' || spec.name === 'openAssistPath') continue;
    if (spec.launch) continue; // TUI-DESIGN §16: launch rows never read the file (added below from resolveLaunchSettings)
    const hit = lookupDetailed(layers, spec);
    if (!hit) continue;
    entries.set(spec.name, { value: hit.value, source: hit.source });
    if (spec.name === 'log.file') logFileHit = hit;
    if (spec.name === 'decider.apiKey') deciderKeyHit = hit;
  }
  // TUI-DESIGN-2 §2.3 row 4: an unset base URL / model takes the provider's own values (`default (typesafe)` in `jevcode config`)
  {
    const spec = JEV_PROVIDERS[jev.provider];
    if (entries.get('decider.baseUrl')?.source === 'default') entries.set('decider.baseUrl', { value: spec.baseUrl, source: 'default' });
    if (entries.get('decider.model')?.source === 'default') entries.set('decider.model', { value: spec.defaultModel, source: 'default' });
  }
  // `--verbose` is `--log-level debug` (TUI-DESIGN §16); an explicit --log-level wins.
  if (flagValue(flags, 'verbose') === true && entries.get('log.level')?.source !== 'flag') entries.set('log.level', { value: 'debug', source: 'flag' });
  // TUI-DESIGN §16: `JEVCODE_TRACE=<file>` is `JEVCODE_LOG=<file>` at level `trace` — it sets log.level at its own layer's
  // precedence, so a flag or a same-or-higher-layer JEVCODE_LOG_LEVEL still wins.
  if (logFileHit !== null && logFileHit.via === TRACE_ENV) {
    const level = entries.get('log.level');
    if (!level || layerRank(level.source) > layerRank(logFileHit.source)) entries.set('log.level', { value: TRACE_LOG_LEVEL, source: logFileHit.source });
  }
  // TUI-DESIGN §9.1 / §16 (P45) / TUI-DESIGN-2 §1.2: the run cap default is mode-keyed on the `mode` setting ($0.25 under jev-only).
  const capR = entries.get('limits.spendCapUsd');
  if (!capR || capR.source === 'default') entries.set('limits.spendCapUsd', { value: String(defaultRunSpendCapUsd(mode)), source: 'default' });
  for (const [name, r] of launchRows(flags, env)) entries.set(name, r);
  if (configFileEntry) entries.set('configFile', configFileEntry);
  if (oaEntry) entries.set('openAssistPath', oaEntry);

  // Paths: workspace defaults to cwd; JEVCODE_HOME is the home whose runs/ is the runs dir.
  const wsR = entries.get('workspace');
  const workspace: Resolved<string> = wsR ? { value: resolvePath(cwd, wsR.value), source: wsR.source } : { value: cwd, source: 'default' };
  entries.set('workspace', workspace);
  const runsR = entries.get('runsDir');
  let runsDir: Resolved<string>;
  if (!runsR) runsDir = { value: join(home, '.jevcode', 'runs'), source: 'default' };
  else if (runsR.source === 'env' || runsR.source.startsWith('dotenv:')) runsDir = { value: join(resolvePath(cwd, runsR.value), 'runs'), source: runsR.source };
  else runsDir = { value: resolvePath(cwd, runsR.value), source: runsR.source };
  entries.set('runsDir', runsDir);

  const reader: SettingReader = {
    get: (name) => entries.get(name),
    sources: (name) => {
      const spec = settingSpec(name);
      return describeSources(layers, spec, flagNameFor(spec));
    },
  };

  // Eager, cheap validation of settings the wiring code needs before the first frame. The
  // stored entry takes the normalised form so run.json compares equal on --resume (§9).
  const sandbox: SandboxProfile = validateSandbox(reader);
  entries.set('sandbox', { value: sandbox, source: entries.get('sandbox')?.source ?? 'default' });
  const noNetworkR = entries.get('noNetwork');
  const plainR = entries.get('plain');
  const noNetwork = noNetworkR ? parseBooleanSetting(reader, 'noNetwork', noNetworkR) : false;
  const plain = plainR ? parseBooleanSetting(reader, 'plain', plainR) : false;

  // SecretSet (§8.4): resolved secret settings, then every secret-looking variable in every loaded .env and the config file.
  const secrets: SecretEntry[] = [];
  const secretNames = new Set<string>(SECRET_SETTINGS);
  for (const name of SECRET_SETTINGS) {
    const r = entries.get(name);
    if (r) secrets.push({ name, value: r.value.trim() });
  }
  for (const d of layers.dotenvs) for (const [k, v] of d.vars) if (SECRET_NAME_RE.test(k)) secrets.push({ name: k, value: v });
  if (configFile) for (const [k, v] of configFile.values) if (SECRET_NAME_RE.test(k)) secrets.push({ name: k, value: v });
  // TUI-DESIGN-2 §2.3 Redaction: every known key variable exported in the process environment, whichever provider was selected
  // (a TYPESAFE_API_KEY in the shell under `--jev-provider openrouter` is masked too); a value already named by a setting keeps that name
  for (const name of KNOWN_KEY_ENV) {
    const v = env[name];
    if (typeof v === 'string' && v.trim().length >= MIN_SECRET_LENGTH) secrets.push({ name, value: v.trim() });
  }
  const redactor = createRedactor(secrets);

  const secretPaths = [...new Set(consultedPaths.filter((p) => isAbsolute(p)))];
  const dotenvFiles = layers.dotenvs.map((d) => d.path);
  const configDirs = configDirsFor(home, env);

  let generatorMemo: GeneratorConfig | null = null;
  let deciderMemo: DeciderConfig | null = null;
  let limitsMemo: RunLimits | null = null;
  const warn = (m: string): void => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const hasSecret = (name: SecretSettingName): boolean => {
    const r = entries.get(name);
    return r !== undefined && r.value.trim() !== '';
  };
  const mocked = flags.mock === true;
  const mockedGenerator = mocked || flags.mockGenerator === true;

  /** TUI-DESIGN §16: rows that exist only by derivation (`derived`) or as an ignored file value (`ignored:launch`). */
  function derivedRows(): Record<string, ConfigRecordValue> {
    const out: Record<string, ConfigRecordValue> = {};
    if (!entries.has('session.spendCapUsd')) {
      out['session.spendCapUsd'] = { value: String(SESSION_CAP_MULTIPLIER * runSpendCapUsd(reader, mode)), source: 'derived' };
    }
    let allowUnpriced = false;
    try {
      allowUnpriced = readAllowUnpriced(reader);
    } catch {
      allowUnpriced = false; // limits() reports the malformed boolean; the record must never throw
    }
    if (allowUnpriced && !entries.has('limits.maxGeneratorTokens')) {
      out['limits.maxGeneratorTokens'] = { value: String(deriveMaxGeneratorTokens(runSpendCapUsd(reader, mode))), source: 'derived' };
    }
    const modelR = entries.get('generator.model');
    if (modelR && !lookupPricing(modelR.value).known) {
      const inR = entries.get('generator.priceInPerM');
      const inPerM = inR ? Number(inR.value.trim()) : Number.NaN;
      if (Number.isFinite(inPerM) && inPerM >= 0) {
        if (!entries.has('generator.priceCacheReadPerM')) out['generator.priceCacheReadPerM'] = { value: numText(inPerM * CACHE_READ_FACTOR), source: 'derived' };
        if (!entries.has('generator.priceCacheWritePerM')) out['generator.priceCacheWritePerM'] = { value: numText(inPerM * CACHE_WRITE_FACTOR), source: 'derived' };
      }
    }
    if (configFile) {
      for (const [name, value] of configFile.ignoredLaunch) {
        if (LAUNCH_ROW_NAMES.includes(name)) out[`${name}.ignored`] = { value, source: 'ignored:launch' };
      }
    }
    // TUI-DESIGN-2 §2.6: `--json` carries why the provider was chosen; the table folds it into the `decider.provider` source column
    out['decider.providerSource'] = { value: jev.providerSource, source: 'derived' };
    return out;
  }

  return {
    entries,
    // contract 1.2 (TUI-DESIGN-2 §6 item 9 / §1.2): the `mode` setting the caps above were keyed on — opts.mode (a --resume
    // re-resolve) or the chain (flag > JEVCODE_MODE > dotenv > file > DEFAULT_MODE)
    mode,
    generator() {
      if (!generatorMemo) generatorMemo = validateGenerator(reader, warn, { allowUnpriced: readAllowUnpriced(reader) });
      return generatorMemo;
    },
    decider() {
      // TUI-DESIGN-2 §2.3: the resolved provider and the variable the key came from (row 3's OPENROUTER_API_KEY-under-typesafe refusal)
      if (!deciderMemo) deciderMemo = validateDecider(reader, { provider: { name: jev.provider, source: jev.providerSource }, keyVia: deciderKeyHit?.via ?? null });
      return deciderMemo;
    },
    limits() {
      if (!limitsMemo) limitsMemo = validateLimits(reader, { allowUnpriced: readAllowUnpriced(reader) });
      return limitsMemo;
    },
    workspace: workspace.value,
    runsDir: runsDir.value,
    openAssistPath: oaEntry ? oaEntry.value : null,
    configFile: configFileEntry ? configFileEntry.value : null,
    dotenvFiles,
    sandbox,
    noNetwork,
    plain,
    secretPaths,
    redact: redactor.redact,
    redactJson: redactor.redactJson,
    record: () => ({ ...maskEntries(entries, secretNames), ...derivedRows() }),
    warnings,
    sourcesConsulted: (name) => reader.sources(name),
    // TUI-DESIGN §15 item 17 / §11.1 (D5): non-throwing; the generator key is skipped for jev-only and --mock*, the Jev key for --mock
    // (llm-jev needs both: the generator writes candidates inside the Jev-only search, docs/LLM-JEV-DESIGN.md)
    missingSecrets(m: EngineMode): readonly SecretSettingName[] {
      const out: SecretSettingName[] = [];
      if (m !== 'jev-only' && !mockedGenerator && !hasSecret('generator.apiKey')) out.push('generator.apiKey');
      if (!mocked && !hasSecret('decider.apiKey')) out.push('decider.apiKey');
      return out;
    },
    // TUI-DESIGN §16: session settings through the full chain; launch members copied from the argument
    ui(launch: LaunchSettings): UiConfig {
      return resolveUiConfig(reader, launch, { home, cwd, env });
    },
    // TUI-DESIGN §9.1: configured, `none` → +Infinity, else derived 5 × the mode-keyed run cap
    sessionSpendCap(m: EngineMode) {
      return resolveSessionSpendCap(reader, m);
    },
    // TUI-DESIGN §15 item 19 / §10.2: in-place mutation of the one redactor every holder shares
    addSecret: (name: string, value: string) => redactor.addSecret(name, value),
    dropSecret: (name: string) => redactor.dropSecret(name),
    configDirs,
  };
}

// ---------------------------------------------------------------------------------------
// --resume reconciliation (§9 "Configuration on --resume"), pure
// ---------------------------------------------------------------------------------------

function recordString(config: Record<string, ConfigRecordValue>, name: SettingName): string | null {
  const v = config[name];
  return v && typeof v.value === 'string' ? v.value : null;
}

function recordNumber(config: Record<string, ConfigRecordValue>, name: SettingName): number | null {
  const s = recordString(config, name);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** The settings a run keeps for life, read from run.json. */
export function resumeIdentityFromRunMeta(meta: RunMeta): ResumeIdentity {
  const c = meta.config;
  const sandboxRaw = recordString(c, 'sandbox');
  const sandbox: SandboxProfile | null = sandboxRaw === 'auto' || sandboxRaw === 'seatbelt' || sandboxRaw === 'none' ? sandboxRaw : null;
  return {
    task: meta.task,
    workspace: meta.workspace,
    mode: meta.mode,
    provider: recordString(c, 'generator.provider'),
    model: recordString(c, 'generator.model'),
    baseUrl: recordString(c, 'generator.baseUrl'),
    jevModel: recordString(c, 'decider.model'),
    jevBaseUrl: recordString(c, 'decider.baseUrl'),
    // TUI-DESIGN-2 §2.5: a run recorded before the row reads as openrouter (the caller applies that default)
    jevProvider: recordString(c, 'decider.provider'),
    completeThreshold: recordNumber(c, 'limits.completeThreshold'),
    impossibleThreshold: recordNumber(c, 'limits.impossibleThreshold'),
    sandbox,
  };
}

/**
 * Adapter for the wiring code: the re-resolved limits of this invocation plus the checkpoint
 * fields the stored stop reason is compared against. `workspaceRealpath` is the realpath of
 * an explicit --workspace (null when the flag was not given, or the directory is missing).
 */
export function resumeInputsFrom(config: Pick<ResolvedConfig, 'limits'> & Partial<Pick<ResolvedConfig, 'entries' | 'decider'>>, state: CheckpointState, workspaceRealpath: string | null): ResumeCurrentInputs {
  const limits = config.limits();
  // TUI-DESIGN-2 §2.5: the current Jev provider + model for the cross-provider check; a decider() that cannot validate (no key
  // under --mock, a bad model) reports itself where the engine is built, so it is simply absent here
  let decider: ResumeCurrentInputs['decider'];
  try {
    const d = config.decider?.();
    if (d) decider = { provider: d.provider, model: d.model };
  } catch {
    decider = undefined;
  }
  // TUI-DESIGN §8.7 / §9.5: the token counter survives --resume, rebuilt from generatorTokensPerStep (absent in older checkpoints = 0)
  const generatorTokens = (state.generatorTokensPerStep ?? []).reduce((acc, n) => acc + (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0), 0);
  const capSource = config.entries?.get('limits.spendCapUsd')?.source;
  const tokensSource: ConfigSource | undefined = limits.maxGeneratorTokens === undefined ? undefined : (config.entries?.get('limits.maxGeneratorTokens')?.source ?? 'derived');
  return {
    limits,
    workspaceRealpath,
    state: {
      step: state.step,
      spendTotalUsd: state.spend.totalUsd,
      wallMsUsed: state.wallMsUsed,
      replanCount: state.loopDetector.replanCount,
      stopReason: state.stopReason,
      generatorTokens,
    },
    ...(config.entries ? { sources: { ...(capSource ? { spendCapUsd: capSource } : {}), ...(tokensSource ? { maxGeneratorTokens: tokensSource } : {}) } } : {}),
    ...(decider ? { decider } : {}),
  };
}

/** TUI-DESIGN §8.7: the stored stops that still block a resume until their limit is raised (`token_cap` like `spend_cap`; `human_pause` is not one). */
const BUDGET_STOPS: ReadonlySet<StopReason> = new Set<StopReason>(['spend_cap', 'max_steps', 'wall_time', 'max_replans', 'token_cap']);

/**
 * Decide how a stored run continues under the current invocation: identity comes from
 * run.json, limits are re-resolved and diffed into overrides, and a stored budget stop that
 * still holds becomes an immediate stop (exit 4) rather than a wasted step.
 */
export function reconcileResumeConfig(current: ResumeCurrentInputs, runMeta: RunMeta, flags: ParsedFlags): ResumeReconciliation {
  const identity = resumeIdentityFromRunMeta(runMeta);
  const errors: ConfigError[] = [];
  const overrides: ResumeReconciliation['overrides'] = [];
  const atStep = current.state.step;

  if (flags.provider !== undefined && identity.provider !== null && flags.provider.trim().toLowerCase() !== identity.provider.trim().toLowerCase()) {
    errors.push(new ConfigError(`--provider "${flags.provider}" differs from the run's provider "${identity.provider}"; a resumed run keeps its provider`, { setting: 'generator.provider' }));
  }
  if (flags.model !== undefined && identity.model !== null && flags.model.trim() !== identity.model.trim()) {
    errors.push(new ConfigError(`--model "${flags.model}" differs from the run's model "${identity.model}"; a resumed run keeps its model`, { setting: 'generator.model' }));
  }
  if (flags.jevModel !== undefined && identity.jevModel !== null) {
    // TUI-DESIGN-2 §2.5: the same weights under the other provider's naming (jev-1.13-20260917 ≡ jev-1.13.0) are the same model
    const same = normaliseJevModelId(flags.jevModel).normalised === normaliseJevModelId(identity.jevModel).normalised || jevModelMatches(flags.jevModel, identity.jevModel) || sameJevWeights(flags.jevModel, identity.jevModel);
    if (!same) errors.push(new ConfigError(`--jev-model "${flags.jevModel}" differs from the run's decider model "${identity.jevModel}"; a resumed run keeps its model`, { setting: 'decider.model' }));
  }
  // TUI-DESIGN-2 §2.5: a cross-provider resume is allowed only when EQUIVALENT_IDS maps the run's resolved model onto what the
  // current provider will serve (recorded as a `decider.provider` override); a run without the row reads as openrouter
  const runProvider = identity.jevProvider ?? 'openrouter';
  if (current.decider !== undefined && current.decider.provider !== runProvider) {
    const runModel = runMeta.resolvedJevModel ?? identity.jevModel;
    const equivalent = runModel === null ? null : equivalentJevModel(runModel, current.decider.provider);
    if (equivalent !== null && providerJevModelMatches(current.decider.model, equivalent, current.decider.provider)) {
      overrides.push({ setting: 'decider.provider', from: runProvider, to: current.decider.provider, atStep });
    } else {
      errors.push(new ConfigError(`--resume: run ${runMeta.runId} used decider.provider ${runProvider} with ${runModel ?? 'an unrecorded model'}; pass --jev-provider ${runProvider}, or start a follow-up`, { setting: 'decider.provider' }));
    }
  }
  if (flags.workspace !== undefined && current.workspaceRealpath !== identity.workspace) {
    errors.push(
      new ConfigError(`--workspace "${flags.workspace}"${current.workspaceRealpath ? ` (realpath ${current.workspaceRealpath})` : ' (does not exist)'} is not the run's workspace ${identity.workspace}`, {
        setting: 'workspace',
      }),
    );
  }

  const c = runMeta.config;
  // TUI-DESIGN §9.1 (P45): a default meets a default — the run keeps its own mode-keyed default (a jev-only run resumed
  // without `--mode jev-only` stays at $0.25); only a configured value (flag / env / dotenv / file) overrides the stored cap.
  let spendCapUsd = current.limits.spendCapUsd;
  let maxGeneratorTokens = current.limits.maxGeneratorTokens;
  const storedCap = c['limits.spendCapUsd'];
  const storedCapValue = recordNumber(c, 'limits.spendCapUsd');
  if (current.sources?.spendCapUsd === 'default' && storedCap?.source === 'default' && storedCapValue !== null && storedCapValue > 0) {
    spendCapUsd = storedCapValue;
    if (maxGeneratorTokens !== undefined && current.sources.maxGeneratorTokens === 'derived') maxGeneratorTokens = deriveMaxGeneratorTokens(spendCapUsd);
  }
  const limits: RunLimits = {
    ...current.limits,
    spendCapUsd,
    ...(maxGeneratorTokens !== undefined ? { maxGeneratorTokens } : {}),
    completeThreshold: identity.completeThreshold ?? current.limits.completeThreshold,
    impossibleThreshold: identity.impossibleThreshold ?? current.limits.impossibleThreshold,
  };

  const diffNumber = (setting: SettingName, to: number): void => {
    const from = recordNumber(c, setting);
    if (from !== null && from !== to) overrides.push({ setting, from: String(from), to: String(to), atStep });
  };
  diffNumber('limits.spendCapUsd', limits.spendCapUsd);
  diffNumber('limits.maxSteps', limits.maxSteps);
  diffNumber('limits.maxReplans', limits.maxReplans);
  const wallFrom = recordString(c, 'limits.maxWall');
  if (wallFrom !== null) {
    let fromMs: number | null = null;
    try {
      fromMs = parseDuration(wallFrom, 'limits.maxWall');
    } catch {
      fromMs = null;
    }
    if (fromMs !== null && fromMs !== limits.maxWallMs) overrides.push({ setting: 'limits.maxWall', from: wallFrom, to: formatDuration(limits.maxWallMs), atStep });
  }

  let immediateStop: ResumeReconciliation['immediateStop'] = null;
  const stop = current.state.stopReason;
  if (stop === 'complete' && !flags.force) {
    errors.push(new ConfigError(`run ${runMeta.runId} already completed; pass --force to resume it anyway`, { setting: 'resume' }));
  } else if (stop !== null && BUDGET_STOPS.has(stop)) {
    const s = current.state;
    if (stop === 'spend_cap' && limits.spendCapUsd <= s.spendTotalUsd) {
      immediateStop = { reason: stop, message: `stopped: spend_cap (spent $${s.spendTotalUsd.toFixed(4)}, cap $${limits.spendCapUsd}); raise --spend-cap above ${s.spendTotalUsd.toFixed(4)} to continue` };
    } else if (stop === 'max_steps' && limits.maxSteps <= s.step) {
      immediateStop = { reason: stop, message: `stopped: max_steps (${s.step} steps taken, limit ${limits.maxSteps}); raise --max-steps above ${s.step} to continue` };
    } else if (stop === 'wall_time' && limits.maxWallMs <= s.wallMsUsed) {
      immediateStop = { reason: stop, message: `stopped: wall_time (${formatDuration(s.wallMsUsed)} used, limit ${formatDuration(limits.maxWallMs)}); raise --max-wall above ${formatDuration(s.wallMsUsed)} to continue` };
    } else if (stop === 'max_replans' && limits.maxReplans <= s.replanCount) {
      immediateStop = { reason: stop, message: `stopped: max_replans (${s.replanCount} replans, limit ${limits.maxReplans}); raise --max-replans above ${s.replanCount} to continue` };
    } else if (stop === 'token_cap' && limits.maxGeneratorTokens !== undefined && limits.maxGeneratorTokens <= s.generatorTokens) {
      // TUI-DESIGN §8.7 / §9.5: blocked until /budget max-generator-tokens <n> raised the limit; without a token cap now (allowUnpriced off) the engine decides
      immediateStop = { reason: stop, message: `stopped: token_cap (${s.generatorTokens} tokens used, limit ${limits.maxGeneratorTokens}); raise --max-generator-tokens above ${s.generatorTokens} to continue` };
    }
  }

  return { identity, limits, overrides, immediateStop, errors };
}
