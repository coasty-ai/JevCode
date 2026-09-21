/** Config-module types (DESIGN.md §3, TUI-DESIGN §16). The public `ResolvedConfig` lives in core/types.ts; these are the internals plus the resume helper shapes. */
import type { ConfigError } from '../errors.js';
import type { ConfigSource, ConfigRecordValue, EngineMode, ResolvedConfig, RunLimits, SandboxProfile, StopReason } from '../core/types.js';
import type { BooleanFlagKey, StringFlagKey } from '../cli/args.js';

export type SettingName =
  | 'generator.provider'
  | 'generator.model'
  | 'generator.apiKey'
  | 'generator.baseUrl'
  | 'generator.temperature'
  | 'generator.maxTokens'
  | 'generator.priceInPerM'
  | 'generator.priceOutPerM'
  | 'generator.priceCacheReadPerM'
  | 'generator.priceCacheWritePerM'
  | 'decider.baseUrl'
  | 'decider.apiKey'
  | 'decider.model'
  | 'limits.spendCapUsd'
  | 'limits.maxSteps'
  | 'limits.maxWall'
  | 'limits.maxReplans'
  | 'limits.completeThreshold'
  | 'limits.impossibleThreshold'
  | 'limits.allowUnpriced'
  | 'limits.maxGeneratorTokens'
  | 'session.spendCapUsd'
  | 'ui.theme'
  | 'ui.fps'
  | 'ui.renderMode'
  | 'ui.ascii'
  | 'ui.title'
  | 'ui.screenReader'
  | 'ui.reducedMotion'
  | 'ui.notify'
  | 'ui.osc52'
  | 'ui.history'
  | 'ui.noInput'
  | 'ui.trustWorkspace'
  | 'ui.budgetWarnings'
  | 'ui.allowSecretMention'
  | 'ui.exitCode'
  | 'ui.keybindings'
  | 'ui.noColor'
  | 'log.file'
  | 'log.level'
  | 'update.notify'
  | 'workspace'
  | 'runsDir'
  | 'openAssistPath'
  | 'configFile'
  | 'sandbox'
  | 'noNetwork'
  | 'plain';

/**
 * TUI-DESIGN §16 value flags that `cli/args.ts` (O10) adds to `STRING_FLAGS`. Typed here so the §16 SETTINGS rows
 * compile before args.ts gains them; `lookup()` reads flags structurally, so a flag the parser does not know yet is
 * simply absent (the chain falls through to env / file / default).
 */
export type TuiStringFlagKey = 'theme' | 'fps' | 'renderMode' | 'exitCode' | 'keybindings' | 'log' | 'logLevel' | 'sessionSpendCap' | 'maxGeneratorTokens';
/** TUI-DESIGN §16 boolean flags that `cli/args.ts` (O10) adds to `BOOLEAN_FLAGS`. */
export type TuiBooleanFlagKey =
  | 'ascii'
  | 'title'
  | 'screenReader'
  | 'noAnimation'
  | 'notify'
  | 'osc52'
  | 'noHistory'
  | 'noInput'
  | 'trustWorkspace'
  | 'noBudgetWarnings'
  | 'allowSecretMention'
  | 'noColor'
  | 'verbose'
  | 'allowUnpriced'
  | 'updateNotify';
export type AnyStringFlagKey = StringFlagKey | TuiStringFlagKey;
export type AnyBooleanFlagKey = BooleanFlagKey | TuiBooleanFlagKey;

/** A boolean flag feeding a setting: `--no-history` (negate) sets `ui.history` to false; `--notify` sets `ui.notify` to true. */
export interface BooleanFlagBinding {
  key: AnyBooleanFlagKey;
  /** the flag's presence means the setting is `false` */
  negate: boolean;
}

export interface SettingSpec {
  name: SettingName;
  /** ParsedFlags key of a value flag; absent when the setting has no value flag (pricing overrides, boolean-only settings) */
  flag?: AnyStringFlagKey;
  /** ParsedFlags key of a boolean flag (presence = true, or false when negated) */
  boolFlag?: BooleanFlagBinding;
  /** env / dotenv variable names, checked in order within each layer */
  env: readonly string[];
  /**
   * TUI-DESIGN §16: inverted-polarity variable names (`JEVCODE_NO_HISTORY`, `NO_UPDATE_NOTIFIER`), checked after `env`
   * within each layer and accepted as config-file keys too; a recognised boolean value is flipped before it is stored,
   * so `JEVCODE_NO_HISTORY=1` resolves `ui.history` to `false`.
   */
  negateEnv?: readonly string[];
  /** key in jevcode.json; absent when the setting cannot come from the file */
  fileKey?: string;
  /** null = no default (the setting may be absent) */
  defaultValue: string | null;
  secret: boolean;
  description: string;
  /**
   * TUI-DESIGN §16: a launch setting resolves flag > env > default before the first frame (`resolveLaunchSettings`);
   * a config-file value for it is recorded as `ignored:launch` and never applied.
   */
  launch?: true;
  /** TUI-DESIGN §16: a file key that is recognised only to be reported as `ignored:launch` (launch settings) */
  ignoredFileKey?: string;
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
  /** TUI-DESIGN §16: launch-setting keys found in the file (setting name → value), reported as `ignored:launch`, never applied */
  ignoredLaunch: ReadonlyMap<SettingName, string>;
}

export interface ResolveOptions {
  /** package root used for the `../open-assist` sibling default; detected from this module's location when absent */
  packageRoot?: string;
  /** home directory used for `~/.jevcode/runs` and `~/.config/jevcode/config.json`; os.homedir() when absent */
  homedir?: string;
  /**
   * TUI-DESIGN §9.1 / §16 (P45): the engine mode the run-cap default is keyed on, when it is known from somewhere other
   * than `--mode` / `--condition` — a `--resume` re-resolve passes `identity.mode` from run.json so a jev-only run keeps
   * its $0.25 default. Absent: read from the flags (default jev-on).
   */
  mode?: EngineMode;
  /** TUI-DESIGN §16 (P30): skip the legacy-config-path warning for this call (it is already once per process and path) */
  suppressLegacyWarning?: boolean;
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
  /** TUI-DESIGN §8.7 / §9.5: Σ `generatorTokensPerStep`, the counter a stored `token_cap` stop is compared against */
  generatorTokens: number;
}

/** TUI-DESIGN §9.1 (P45): where the re-resolved caps came from; `derived` marks a token cap computed from the spend cap. */
export interface ResumeLimitSources {
  spendCapUsd?: ConfigSource;
  maxGeneratorTokens?: ConfigSource;
}

export interface ResumeCurrentInputs {
  /** limits re-resolved from the current invocation under §3 precedence */
  limits: RunLimits;
  /** realpath of an explicit --workspace; null when the flag was not given */
  workspaceRealpath: string | null;
  state: ResumeStateSummary;
  /**
   * TUI-DESIGN §9.1 (P45): sources of the re-resolved caps. When both the stored and the current `limits.spendCapUsd`
   * are defaults the run keeps its own (mode-keyed) default instead of recording a spurious override. Absent = unknown,
   * treated as configured (the legacy behaviour: every difference is an override).
   */
  sources?: ResumeLimitSources;
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
