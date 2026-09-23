/** Config-module types (DESIGN.md §3, TUI-DESIGN §16). The public `ResolvedConfig` lives in core/types.ts; these are the internals plus the resume helper shapes. */
import type { ConfigError } from '../errors.js';
import type { ConfigSource, ConfigRecordValue, EngineMode, JevProvider, ResolvedConfig, RunLimits, SandboxProfile, StopReason } from '../core/types.js';
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
  | 'decider.provider'
  | 'mode'
  // who approves a `review` risk verdict — `full` (the default) auto-approves and logs it, `review` stops for y/n
  | 'autonomy'
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
  // TUI-DESIGN-4 §8 (the round-4 config rows): the relaxed-context policy of docs/COORDINATION-DESIGN.md §8, resolved
  // here so `jevcode config` prints it and a config file can set it. OPTIONAL everywhere — `ResolvedConfig.context()`
  // returns only the members that were actually set, and the engine keeps its own defaults for the rest (§8.1 limits).
  | 'context.mode'
  | 'context.compaction'
  // TUI-DESIGN-5 §3.6 / §8.1 item 7 (D-AI): the kept-items ranker (docs/COORDINATION-DESIGN.md §8.6). The engine
  // member it feeds does not exist yet — see the row's comment in defaults.ts and `resolveContextConfig`.
  | 'context.kept'
  | 'context.compactEvery'
  | 'context.historySteps'
  | 'context.fileCacheBytes'
  | 'context.budgetChars'
  | 'ui.theme'
  | 'ui.fps'
  | 'ui.renderMode'
  // contract 1.6 (TUI-DESIGN-4 §8 item 5 / §1.3): the opt-in pinned-header renderer and its on-exit transcript dump
  | 'ui.renderer'
  | 'ui.fullscreenDump'
  | 'ui.ascii'
  | 'ui.title'
  | 'ui.screenReader'
  | 'ui.reducedMotion'
  | 'ui.wordmark'
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
  /**
   * TUI-DESIGN-5 §8.1 item 7 / §8.3, `docs/COORDINATION-DESIGN.md` §4.1, §9.1, §9.3, §8.5, §6.2: the six
   * `coordination.*` rows (R5-2's half of §9.2's config PR). Every one is printed by `jevcode config`, validated
   * by `jevcode config set` and reachable from a config file; none is a launch setting. The ledger reads them
   * through `src/coordination/**`, which is read-only this round — a row set here and not yet read is the honest
   * D-AN state, exactly like `context.kept`.
   */
  | 'coordination.claims'
  | 'coordination.remoteControl'
  | 'coordination.sync'
  | 'coordination.syncRuns'
  | 'coordination.notify'
  | 'coordination.maxChildren'
  /**
   * TUI-DESIGN-5 §4.8 / §8.3 (R5-4): the thirty-four `orchestrate.*` rows, in `docs/ORCHESTRATION-DESIGN.md`
   * §6.4's own order (`:1427–1461` — THAT table is the authority, not this document, §14.2 #19). `depth` is a
   * constant, not a setting, and `--yes-split` is a flag, not a setting; both are deliberately absent.
   */
  | 'orchestrate.split'
  | 'orchestrate.maxAgents'
  | 'orchestrate.maxSplits'
  | 'orchestrate.splitEvery'
  | 'orchestrate.preludeMaxFiles'
  | 'orchestrate.selfContainedFloor'
  | 'orchestrate.reserveFraction'
  | 'orchestrate.maxReserveUsd'
  | 'orchestrate.minAgentUsd'
  | 'orchestrate.agentMaxSteps'
  | 'orchestrate.agentMaxWall'
  | 'orchestrate.agentStallMs'
  | 'orchestrate.onStall'
  | 'orchestrate.maxKicks'
  | 'orchestrate.critic'
  | 'orchestrate.criticCapUsd'
  | 'orchestrate.criticMaxSteps'
  | 'orchestrate.criticWriteGlobs'
  | 'orchestrate.verify'
  | 'orchestrate.verifyRetries'
  | 'orchestrate.testGlobs'
  | 'orchestrate.land'
  | 'orchestrate.incidentalGlobs'
  | 'orchestrate.agentMode'
  | 'orchestrate.agentInclude'
  | 'orchestrate.commitIdentity'
  | 'orchestrate.dockCleanExclude'
  | 'orchestrate.dockRetentionDays'
  | 'orchestrate.notify'
  | 'orchestrate.agentWaitCeilingMs'
  | 'orchestrate.agentJsonLineBytes'
  | 'orchestrate.agentDeltaHz'
  | 'orchestrate.minFreeBytes'
  | 'orchestrate.agentMemBytes'
  // TUI-DESIGN-5 §5.5 / §8.1 item 7 (R5-5): the import surface's five rows; `seen.import` is the sixth and joins
  // `seen.defaultMode` below as a hidden bookkeeping row.
  | 'import.enabled'
  | 'import.scope'
  | 'import.sources'
  | 'memory.enabled'
  | 'memory.path'
  // TUI-DESIGN-3 §0.1 (D-Q): the bookkeeping row behind the one-time default-mode item — a config-file key, never a flag or a variable
  | 'seen.defaultMode'
  // TUI-DESIGN-5 §5.1: the same contract for the wizard's one-time import step (`2 later` writes the version, `3 never` writes `never`)
  | 'seen.import'
  | 'log.file'
  | 'log.level'
  | 'update.notify'
  | 'workspace'
  | 'runsDir'
  | 'extraEnvFile'
  | 'configFile'
  | 'sandbox'
  | 'noNetwork'
  | 'plain';

/**
 * TUI-DESIGN §16 value flags that `cli/args.ts` (O10) adds to `STRING_FLAGS`. Typed here so the §16 SETTINGS rows
 * compile before args.ts gains them; `lookup()` reads flags structurally, so a flag the parser does not know yet is
 * simply absent (the chain falls through to env / file / default).
 */
export type TuiStringFlagKey = 'theme' | 'fps' | 'renderMode' | 'exitCode' | 'keybindings' | 'log' | 'logLevel' | 'sessionSpendCap' | 'maxGeneratorTokens' | 'renderer';
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
/**
 * TUI-DESIGN-2 §2.3 / §6 item 17: the `--jev-provider` value flag that `cli/args.ts` (S2) adds to `STRING_FLAGS`; typed here
 * so the `decider.provider` row compiles first (the parser reads flags structurally, so an absent key falls through to env).
 */
export type ProviderStringFlagKey = 'jevProvider';
export type AnyStringFlagKey = StringFlagKey | TuiStringFlagKey | ProviderStringFlagKey;
export type AnyBooleanFlagKey = BooleanFlagKey | TuiBooleanFlagKey;

/** A boolean flag feeding a setting: `--no-history` (negate) sets `ui.history` to false; `--notify` sets `ui.notify` to true. */
export interface BooleanFlagBinding {
  key: AnyBooleanFlagKey;
  /** the flag's presence means the setting is `false` */
  negate: boolean;
}

/**
 * TUI-DESIGN-4 §7.5 (P-D5): the shape `jevcode config` validates a resolved value against, so the command a user
 * reaches for when something is wrong actually tells them. Absent = free text (a path, a model id, an API key).
 * `clamp` marks a bound that is applied rather than refused (`ui.fps: 240` is a `⚠ clamped to 30` row, not a `✗`).
 */
export type SettingShape =
  | { kind: 'int'; min?: number; max?: number; clamp?: true }
  | { kind: 'number'; min?: number; max?: number; clamp?: true }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'usd'; none?: true }
  | { kind: 'duration' };

/** TUI-DESIGN-4 §7.5: the problem a row carries — the contract shape of `ConfigRecordValue.problem` (§8 item 7). */
export type SettingProblem = { readonly kind: 'unknown-key' | 'wrong-type' | 'out-of-range'; readonly expected: string };

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
  /** TUI-DESIGN-3 §0.1 (D-Q): a bookkeeping row `jevcode config` hides unless `--all` (`seen.*`); `--json` keeps it */
  hidden?: true;
  /** TUI-DESIGN-4 §7.5: what a value must look like; `jevcode config` reports a row that does not (`✗ expected …`) */
  shape?: SettingShape;
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
  /** home directory used for `~/.jevcode/runs` and `~/.config/jevcode/config.json`; os.homedir() when absent */
  homedir?: string;
  /**
   * TUI-DESIGN §9.1 / §16 (P45) / TUI-DESIGN-2 §1.2: the engine mode the run-cap default is keyed on, when it is known from
   * somewhere other than the `mode` setting — a `--resume` re-resolve passes `identity.mode` from run.json so a jev-only run
   * keeps its $1.00 default. Absent: `resolveMode(layers)` (flag > JEVCODE_MODE > dotenv > file > DEFAULT_MODE).
   */
  mode?: EngineMode;
  /** TUI-DESIGN §16 (P30): skip the legacy-config-path warning for this call (it is already once per process and path) */
  suppressLegacyWarning?: boolean;
}

/** What resolveConfig returns: the contract plus diagnostics the integrator prints once. */
export interface ResolvedConfigWithDiagnostics extends ResolvedConfig {
  /** non-fatal findings (unknown pricing model, unknown config-file keys, ...) */
  readonly warnings: readonly string[];
  /**
   * TUI-DESIGN-4 §7.5 item 4: the config-file keys that name no setting, verbatim and in file order, so
   * `configTableLines` can build the one warning row that names the nearest valid setting for each. Optional so no
   * fake of this interface outside `config/resolve.ts` breaks.
   */
  readonly unknownFileKeys?: readonly string[];
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
  /** TUI-DESIGN-2 §2.5: the run's `decider.provider` row; null for a run recorded before the row (reads as openrouter) */
  jevProvider: string | null;
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
  /** TUI-DESIGN-2 §2.5: the Jev provider and model this invocation resolved to, for the cross-provider check; absent = not checked */
  decider?: { provider: JevProvider; model: string };
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
