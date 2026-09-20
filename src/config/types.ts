/** Config-module types (DESIGN.md §3). The public `ResolvedConfig` lives in core/types.ts; these are the internals plus the resume helper shapes. */
import type { ConfigError } from '../errors.js';
import type { ConfigSource, ConfigRecordValue, EngineMode, ResolvedConfig, RunLimits, SandboxProfile, StopReason } from '../core/types.js';
import type { StringFlagKey } from '../cli/args.js';

export type SettingName =
  | 'generator.provider'
  | 'generator.model'
  | 'generator.apiKey'
  | 'generator.baseUrl'
  | 'generator.temperature'
  | 'generator.maxTokens'
  | 'generator.priceInPerM'
  | 'generator.priceOutPerM'
  | 'decider.baseUrl'
  | 'decider.apiKey'
  | 'decider.model'
  | 'limits.spendCapUsd'
  | 'limits.maxSteps'
  | 'limits.maxWall'
  | 'limits.maxReplans'
  | 'limits.completeThreshold'
  | 'limits.impossibleThreshold'
  | 'workspace'
  | 'runsDir'
  | 'openAssistPath'
  | 'configFile'
  | 'sandbox'
  | 'noNetwork'
  | 'plain';

export interface SettingSpec {
  name: SettingName;
  /** ParsedFlags key; absent when the setting has no flag (pricing overrides) */
  flag?: StringFlagKey;
  /** env / dotenv variable names, checked in order within each layer */
  env: readonly string[];
  /** key in jevcode.json; absent when the setting cannot come from the file */
  fileKey?: string;
  /** null = no default (the setting may be absent) */
  defaultValue: string | null;
  secret: boolean;
  description: string;
}

export interface LoadedDotenv {
  path: string;
  vars: ReadonlyMap<string, string>;
}

export interface LoadedConfigFile {
  path: string;
  /** file keys already converted to strings */
  values: ReadonlyMap<string, string>;
  unknownKeys: readonly string[];
}

export interface ResolveOptions {
  /** package root used for the `../open-assist` sibling default; detected from this module's location when absent */
  packageRoot?: string;
  /** home directory used for `~/.jevcode/runs` and `~/.config/jevcode/config.json`; os.homedir() when absent */
  homedir?: string;
}

/** What resolveConfig returns: the contract plus diagnostics the integrator prints once. */
export interface ResolvedConfigWithDiagnostics extends ResolvedConfig {
  /** non-fatal findings (unknown pricing model, unknown config-file keys, ...) */
  readonly warnings: readonly string[];
  /** every layer consulted for a setting, for error messages and `jevcode config` */
  sourcesConsulted(setting: SettingName): readonly string[];
}

export interface Pricing {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

// --- resume (§9 "Configuration on --resume") ------------------------------------------

/** Settings a run keeps for its whole life; read back from run.json, never from the current precedence chain. */
export interface ResumeIdentity {
  task: string;
  /** realpath stored by the original run */
  workspace: string;
  mode: EngineMode;
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  jevModel: string | null;
  jevBaseUrl: string | null;
  completeThreshold: number | null;
  impossibleThreshold: number | null;
  sandbox: SandboxProfile | null;
}

/** The checkpoint fields the stored stopReason is compared against. */
export interface ResumeStateSummary {
  step: number;
  spendTotalUsd: number;
  wallMsUsed: number;
  replanCount: number;
  stopReason: StopReason | null;
}

export interface ResumeCurrentInputs {
  /** limits re-resolved from the current invocation under §3 precedence */
  limits: RunLimits;
  /** realpath of an explicit --workspace; null when the flag was not given */
  workspaceRealpath: string | null;
  state: ResumeStateSummary;
}

export interface ResumeOverride {
  setting: string;
  from: string;
  to: string;
  atStep: number;
}

export interface ResumeReconciliation {
  identity: ResumeIdentity;
  /** limits to run with (the re-resolved ones) */
  limits: RunLimits;
  overrides: ResumeOverride[];
  /** set when the stored stop reason still holds under the re-resolved limits (exit 4, nothing appended) */
  immediateStop: { reason: StopReason; message: string } | null;
  errors: ConfigError[];
}

export type { ConfigSource, ConfigRecordValue };
