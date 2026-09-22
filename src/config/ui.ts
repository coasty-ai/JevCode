/**
 * Session UI settings (TUI-DESIGN §16, §15 item 17): everything in `UiConfig` that is not a launch setting follows the
 * full chain flag > env > ./.env > <OPEN_ASSIST_PATH>/.env > file > default through the same `SettingReader` as every
 * other section, after `firstFrame()`. The launch members are copied from the `LaunchSettings` argument and never
 * re-resolved (Ink fixed them at mount). Also here: the `session.spendCapUsd` parser (`none` = +Infinity, §9.1).
 */
import { resolve as resolvePath } from 'node:path';
import type { ConfigSource, EngineMode, LaunchSettings, Resolved, UiConfig } from '../core/types.js';
import { DEFAULT_SPEND_CAP_USD, JEV_ONLY_DEFAULT_SPEND_CAP_USD, SESSION_CAP_MULTIPLIER, defaultKeybindingsPath } from './defaults.js';
import type { SettingName } from './types.js';
import { invalid, parseBooleanSetting, parseNumberSetting, type SettingReader } from './validate.js';

export const UI_THEMES = ['dark', 'light', 'daltonized', 'ansi'] as const;
/** TUI-DESIGN-3 §6 item 5 / §3.2: `ui.wordmark` — the idle sweep, the static mark, or no mark at all */
export const WORDMARK_MODES = ['sweep', 'static', 'off'] as const;
export const EXIT_CODE_POLICIES = ['zero', 'last-run'] as const;
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;

export interface UiResolveContext {
  /** home directory for the default keybindings path */
  home: string;
  /** relative `--log` / `--keybindings` paths resolve against this */
  cwd: string;
  /** `XDG_CONFIG_HOME` is read from here */
  env: NodeJS.ProcessEnv;
}

function enumSetting<T extends string>(reader: SettingReader, name: SettingName, r: Resolved<string>, values: readonly T[]): T {
  const v = r.value.trim().toLowerCase();
  const hit = values.find((x) => x === v);
  if (hit === undefined) throw invalid(reader, name, r, `one of ${values.join('|')}`);
  return hit;
}

function optionalBoolean(reader: SettingReader, name: SettingName, fallback: boolean): boolean {
  const r = reader.get(name);
  return r ? parseBooleanSetting(reader, name, r) : fallback;
}

function optionalPath(reader: SettingReader, name: SettingName, cwd: string): string | null {
  const r = reader.get(name);
  if (!r || r.value.trim() === '') return null;
  return resolvePath(cwd, r.value.trim());
}

/**
 * TUI-DESIGN §16: build `UiConfig` — session settings through the reader (ConfigError on a bad value, naming the setting
 * and the sources consulted), launch members copied from `launch`; `reducedMotion` and `notify` default to true under
 * screen-reader mode (A96), `log.file` null means `<runDir>/jevcode.log`.
 */
export function resolveUiConfig(reader: SettingReader, launch: LaunchSettings, ctx: UiResolveContext): UiConfig {
  const themeR = reader.get('ui.theme');
  const theme = themeR ? enumSetting(reader, 'ui.theme', themeR, UI_THEMES) : 'dark';
  const exitR = reader.get('ui.exitCode');
  const exitCode = exitR ? enumSetting(reader, 'ui.exitCode', exitR, EXIT_CODE_POLICIES) : 'zero';
  const levelR = reader.get('log.level');
  const logLevel = levelR ? enumSetting(reader, 'log.level', levelR, LOG_LEVELS) : 'info';
  const keybindings = optionalPath(reader, 'ui.keybindings', ctx.cwd) ?? defaultKeybindingsPath(ctx.home, ctx.env);
  // TUI-DESIGN-3 §6 item 5: `static` under the SSH launch source, `sweep` otherwise, unless the chain sets it
  const wordmarkR = reader.get('ui.wordmark');
  const wordmark = wordmarkR ? enumSetting(reader, 'ui.wordmark', wordmarkR, WORDMARK_MODES) : launch.ssh === true ? 'static' : 'sweep';
  return {
    fps: launch.fps,
    renderMode: launch.renderMode,
    screenReader: launch.screenReader,
    ascii: launch.ascii,
    noColor: launch.noColor,
    theme,
    title: optionalBoolean(reader, 'ui.title', false),
    reducedMotion: optionalBoolean(reader, 'ui.reducedMotion', launch.screenReader),
    notify: optionalBoolean(reader, 'ui.notify', launch.screenReader),
    osc52: optionalBoolean(reader, 'ui.osc52', false),
    history: optionalBoolean(reader, 'ui.history', true),
    noInput: optionalBoolean(reader, 'ui.noInput', false),
    trustWorkspace: optionalBoolean(reader, 'ui.trustWorkspace', false),
    budgetWarnings: optionalBoolean(reader, 'ui.budgetWarnings', true),
    allowSecretMention: optionalBoolean(reader, 'ui.allowSecretMention', false),
    exitCode,
    logLevel,
    logFile: optionalPath(reader, 'log.file', ctx.cwd),
    keybindingsFile: keybindings,
    wordmark,
  };
}

/** TUI-DESIGN §16 (P45): the run spend cap default is mode-keyed — $0.25 under jev-only, $2.00 otherwise (jev-on, jev-off and llm-jev all pay a generator). */
export function defaultRunSpendCapUsd(mode: EngineMode): number {
  return mode === 'jev-only' ? JEV_ONLY_DEFAULT_SPEND_CAP_USD : DEFAULT_SPEND_CAP_USD;
}

/**
 * TUI-DESIGN §9.1: the run cap a session derives its default from — the configured `limits.spendCapUsd` when it came
 * from any layer above the default, else the mode-keyed default. Never throws: a malformed configured value falls back
 * to the default so the session cap can still be derived (the run's own `limits()` reports the error).
 */
export function runSpendCapUsd(reader: SettingReader, mode: EngineMode): number {
  const r = reader.get('limits.spendCapUsd');
  if (!r || r.source === 'default') return defaultRunSpendCapUsd(mode);
  const n = Number(r.value.trim());
  return Number.isFinite(n) && n > 0 ? n : defaultRunSpendCapUsd(mode);
}

export interface SessionSpendCap {
  value: number;
  source: ConfigSource;
  derived: boolean;
}

/**
 * TUI-DESIGN §9.1 / §15 item 17: `session.spendCapUsd` — a configured USD value (> 0), `none` → +Infinity, else derived
 * as 5 × the run cap with source `derived`.
 */
export function resolveSessionSpendCap(reader: SettingReader, mode: EngineMode): SessionSpendCap {
  const r = reader.get('session.spendCapUsd');
  if (!r || r.value.trim() === '') {
    return { value: SESSION_CAP_MULTIPLIER * runSpendCapUsd(reader, mode), source: 'derived', derived: true };
  }
  if (r.value.trim().toLowerCase() === 'none') return { value: Number.POSITIVE_INFINITY, source: r.source, derived: false };
  return { value: parseNumberSetting(reader, 'session.spendCapUsd', r, { gt: 0 }), source: r.source, derived: false };
}
