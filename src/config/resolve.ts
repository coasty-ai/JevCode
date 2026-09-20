/**
 * Configuration resolution (DESIGN.md §3) and the pure --resume reconciliation (§9).
 *
 * Precedence, highest first: flag > process env > ./.env > <OPEN_ASSIST_PATH>/.env > config
 * file > default. Every entry records its source. Nothing is validated here except what is
 * needed to find the other sources (config file, Open Assist path) and the eager, cheap
 * settings (sandbox, booleans, paths); generator(), decider() and limits() validate lazily
 * so `jevcode run` can render its first frame before any key is checked.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParsedFlags } from '../cli/args.js';
import type { CheckpointState, ConfigRecordValue, ConfigSource, DeciderConfig, GeneratorConfig, Json, Resolved, ResolvedConfig, RunLimits, RunMeta, SandboxProfile, StopReason } from '../core/types.js';
import { formatDuration, parseDuration } from '../core/time.js';
import { isJsonObject, parseJson } from '../core/json.js';
import { ConfigError } from '../errors.js';
import { createRedactor, patternRedact, SECRET_NAME_RE, type SecretEntry } from '../core/redact.js';
import { SETTINGS, SECRET_SETTINGS, settingSpec } from './defaults.js';
import { readDotenv } from './env.js';
import { maskEntries } from './mask.js';
import { jevModelMatches, normaliseJevModelId, parseBooleanSetting, validateDecider, validateGenerator, validateLimits, validateSandbox, type SettingReader } from './validate.js';
import type { LoadedConfigFile, LoadedDotenv, ResolveOptions, ResolvedConfigWithDiagnostics, ResumeCurrentInputs, ResumeIdentity, ResumeReconciliation, SettingName, SettingSpec } from './types.js';

export type { ResolveOptions, ResolvedConfigWithDiagnostics, ResumeCurrentInputs, ResumeIdentity, ResumeReconciliation, ResumeStateSummary, ResumeOverride } from './types.js';

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

/** Keys accepted in jevcode.json: the camelCase fileKey of each setting, or any of its env variable names. */
function fileKeyToSetting(): Map<string, SettingSpec> {
  const m = new Map<string, SettingSpec>();
  for (const s of SETTINGS) {
    if (s.fileKey) m.set(s.fileKey, s);
    for (const e of s.env) m.set(e, s);
  }
  return m;
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
  const unknownKeys: string[] = [];
  for (const [k, v] of Object.entries(parsed.value)) {
    const spec = known.get(k);
    if (!spec || !spec.fileKey) {
      unknownKeys.push(k);
      continue;
    }
    const s = scalarToString(v);
    if (s === null) throw new ConfigError(`configFile: ${path} key "${k}" must be a string, number or boolean`, { setting: spec.name });
    values.set(spec.fileKey, s);
  }
  return { path, values, unknownKeys };
}

interface Layers {
  flags: ParsedFlags;
  env: NodeJS.ProcessEnv;
  dotenvs: LoadedDotenv[];
  file: LoadedConfigFile | null;
  /** extra env names checked first for a setting (generator key by provider) */
  extraEnv: Partial<Record<SettingName, readonly string[]>>;
}

function envNames(layers: Layers, spec: SettingSpec): readonly string[] {
  const extra = layers.extraEnv[spec.name];
  return extra ? [...extra, ...spec.env] : spec.env;
}

/** Empty strings count as unset at every layer: `.env.example` ships `ANTHROPIC_API_KEY=`. */
function lookup(layers: Layers, spec: SettingSpec, opts: { useFile: boolean; useDefault: boolean } = { useFile: true, useDefault: true }): Resolved<string> | null {
  if (spec.flag) {
    const v = layers.flags[spec.flag];
    if (typeof v === 'string' && v.trim() !== '') return { value: v, source: 'flag' };
  }
  const names = envNames(layers, spec);
  for (const n of names) {
    const v = layers.env[n];
    if (v !== undefined && v.trim() !== '') return { value: v, source: 'env' };
  }
  for (const d of layers.dotenvs) {
    for (const n of names) {
      const v = d.vars.get(n);
      if (v !== undefined && v.trim() !== '') return { value: v, source: `dotenv:${d.path}` };
    }
  }
  if (opts.useFile && layers.file && spec.fileKey) {
    const v = layers.file.values.get(spec.fileKey);
    if (v !== undefined && v.trim() !== '') return { value: v, source: `file:${layers.file.path}` };
  }
  if (opts.useDefault && spec.defaultValue !== null) return { value: spec.defaultValue, source: 'default' };
  return null;
}

function describeSources(layers: Layers, spec: SettingSpec, flagName: string | null): string[] {
  const out: string[] = [];
  if (flagName) out.push(`--${flagName} (flag)`);
  const names = envNames(layers, spec);
  if (names.length > 0) out.push(`${names.join(' / ')} (env)`);
  for (const d of layers.dotenvs) if (names.length > 0) out.push(`${names.join(' / ')} (dotenv:${d.path})`);
  if (layers.file && spec.fileKey) out.push(`${spec.fileKey} (file:${layers.file.path})`);
  out.push(spec.defaultValue !== null ? `default ${spec.defaultValue}` : 'no default');
  return out;
}

function flagNameFor(spec: SettingSpec): string | null {
  if (!spec.flag) return null;
  // ParsedFlags keys are camelCase of the long flag; reverse it for messages.
  return spec.flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

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

  // 2. config file: flag > env > ./.env, then the two default locations. It cannot come from
  //    the Open Assist .env or from itself.
  let configFile: LoadedConfigFile | null = null;
  let configFileEntry: Resolved<string> | null = null;
  const cfgSpec = settingSpec('configFile');
  const cfgR = lookup(layers, cfgSpec, { useFile: false, useDefault: false });
  if (cfgR) {
    const p = resolvePath(cwd, cfgR.value);
    consultedPaths.push(p);
    if (!isFile(p)) throw new ConfigError(`configFile: ${p} (from ${cfgR.source}) does not exist`, { setting: 'configFile' });
    configFile = await readConfigFile(p);
    configFileEntry = { value: p, source: cfgR.source };
  } else {
    for (const candidate of [join(cwd, 'jevcode.json'), join(home, '.config', 'jevcode', 'config.json')]) {
      consultedPaths.push(candidate);
      if (isFile(candidate)) {
        configFile = await readConfigFile(candidate);
        configFileEntry = { value: candidate, source: 'default' };
        break;
      }
    }
  }
  layers.file = configFile;
  if (configFile && configFile.unknownKeys.length > 0) warnings.push(`configFile: ${configFile.path} has unknown keys ignored: ${configFile.unknownKeys.join(', ')}`);

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

  // 4. Provider first: it decides which env var holds the generator key.
  const entries = new Map<SettingName, Resolved<string>>();
  const providerR = lookup(layers, settingSpec('generator.provider'));
  if (providerR) {
    entries.set('generator.provider', providerR);
    const keyEnv = PROVIDER_KEY_ENV[providerR.value.trim().toLowerCase()];
    if (keyEnv) layers.extraEnv['generator.apiKey'] = [keyEnv];
  }

  for (const spec of SETTINGS) {
    if (spec.name === 'generator.provider' || spec.name === 'configFile' || spec.name === 'openAssistPath') continue;
    if (spec.name === 'noNetwork' || spec.name === 'plain') {
      const flagOn = spec.name === 'noNetwork' ? flags.noNetwork === true : flags.plain === true;
      const r = flagOn ? { value: 'true', source: 'flag' as ConfigSource } : lookup(layers, spec);
      if (r) entries.set(spec.name, r);
      continue;
    }
    const r = lookup(layers, spec);
    if (r) entries.set(spec.name, r);
  }
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
  const redactor = createRedactor(secrets);

  const secretPaths = [...new Set(consultedPaths.filter((p) => isAbsolute(p)))];
  const dotenvFiles = layers.dotenvs.map((d) => d.path);

  let generatorMemo: GeneratorConfig | null = null;
  let deciderMemo: DeciderConfig | null = null;
  let limitsMemo: RunLimits | null = null;
  const warn = (m: string): void => {
    if (!warnings.includes(m)) warnings.push(m);
  };

  return {
    entries,
    generator() {
      if (!generatorMemo) generatorMemo = validateGenerator(reader, warn);
      return generatorMemo;
    },
    decider() {
      if (!deciderMemo) deciderMemo = validateDecider(reader);
      return deciderMemo;
    },
    limits() {
      if (!limitsMemo) limitsMemo = validateLimits(reader);
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
    record: () => maskEntries(entries, secretNames),
    warnings,
    sourcesConsulted: (name) => reader.sources(name),
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
export function resumeInputsFrom(config: Pick<ResolvedConfig, 'limits'>, state: CheckpointState, workspaceRealpath: string | null): ResumeCurrentInputs {
  return {
    limits: config.limits(),
    workspaceRealpath,
    state: {
      step: state.step,
      spendTotalUsd: state.spend.totalUsd,
      wallMsUsed: state.wallMsUsed,
      replanCount: state.loopDetector.replanCount,
      stopReason: state.stopReason,
    },
  };
}

const BUDGET_STOPS: ReadonlySet<StopReason> = new Set<StopReason>(['spend_cap', 'max_steps', 'wall_time', 'max_replans']);

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
    const same = normaliseJevModelId(flags.jevModel).normalised === normaliseJevModelId(identity.jevModel).normalised || jevModelMatches(flags.jevModel, identity.jevModel);
    if (!same) errors.push(new ConfigError(`--jev-model "${flags.jevModel}" differs from the run's decider model "${identity.jevModel}"; a resumed run keeps its model`, { setting: 'decider.model' }));
  }
  if (flags.workspace !== undefined && current.workspaceRealpath !== identity.workspace) {
    errors.push(
      new ConfigError(`--workspace "${flags.workspace}"${current.workspaceRealpath ? ` (realpath ${current.workspaceRealpath})` : ' (does not exist)'} is not the run's workspace ${identity.workspace}`, {
        setting: 'workspace',
      }),
    );
  }

  const limits: RunLimits = {
    ...current.limits,
    completeThreshold: identity.completeThreshold ?? current.limits.completeThreshold,
    impossibleThreshold: identity.impossibleThreshold ?? current.limits.impossibleThreshold,
  };

  const c = runMeta.config;
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
    }
  }

  return { identity, limits, overrides, immediateStop, errors };
}
