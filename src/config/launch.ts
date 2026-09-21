/**
 * Launch settings (TUI-DESIGN §16, §1, §14.1): `ui.fps`, `ui.renderMode`, `ui.screenReader`, `ui.ascii`,
 * `ui.noColor` resolve **flag > env > default** from argv and `process.env` alone — no file, no I/O — because
 * Ink fixes `maxFps` / `incrementalRendering` / `isScreenReaderEnabled` in its constructor and F1 forbids any
 * file read before the first frame. Everything here is pure: the same inputs give the same output.
 *
 * TUI-DESIGN-2 §6 item 14 adds two argv + env members for the first frame: `modeHint` (`--mode` > `JEVCODE_MODE`; the badge
 * word of §1.5 until `resolveConfig` reads the `mode` setting) and `reducedMotion` (`--no-animation` > `JEVCODE_REDUCED_MOTION`
 * > screenReader; the splash's static form of §5.3 until the `ui.reducedMotion` chain is read).
 */
import type { ConfigSource, EngineMode, LaunchSettings } from '../core/types.js';
import { DEFAULT_FPS, MAX_FPS, MIN_FPS, SSH_FPS } from './defaults.js';

/**
 * The flags this resolver reads, structurally: `ParsedFlags` (cli/args.ts, O10) is assignable once it carries them;
 * until then a parser that lacks a key simply yields `undefined` and the chain falls through to env / default.
 */
export interface LaunchFlags {
  fps?: string;
  renderMode?: string;
  screenReader?: boolean;
  ascii?: boolean;
  noColor?: boolean;
  /** TUI-DESIGN-2 §6 item 14: `--mode` (args.ts folds `--condition` into it) */
  mode?: string;
  /** TUI-DESIGN-2 §6 item 14: `--no-animation` */
  noAnimation?: boolean;
}

/** Where each launch member came from; `jevcode config` prints it beside the value (§16). */
export type LaunchSource = Extract<ConfigSource, 'flag' | 'env' | 'default'>;
export type LaunchSources = Readonly<Record<keyof LaunchSettings, LaunchSource>>;

export const RENDER_MODES = ['standard', 'incremental'] as const;

/** TUI-DESIGN-2 §1.2 / §6 item 14: a `--mode` / `JEVCODE_MODE` value, or null so the next layer applies (the `mode` setting reports a bad value later, with its source). */
export function parseModeHint(text: string): EngineMode | null {
  const t = text.trim().toLowerCase();
  return t === 'jev-only' || t === 'jev-on' || t === 'jev-off' ? t : null;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** `0` / `false` / `no` / `off` → false; any other non-empty value → true (`=0 overrides`, §16). */
export function parseEnvBoolean(v: string): boolean {
  const t = v.trim().toLowerCase();
  return !(t === '0' || t === 'false' || t === 'no' || t === 'off' || t === '');
}

/** TUI-DESIGN §16: `SSH_TTY` / `SSH_CONNECTION` present and non-empty → a slow link (fps default 15). */
export function isSshSession(env: NodeJS.ProcessEnv): boolean {
  return envValue(env, 'SSH_TTY') !== null || envValue(env, 'SSH_CONNECTION') !== null;
}

/** TUI-DESIGN §14.1 Unicode gate: `TERM=dumb`, `TERM=linux` or a non-UTF-8 POSIX locale → ASCII glyphs. */
export function asciiAuto(env: NodeJS.ProcessEnv): boolean {
  const term = (envValue(env, 'TERM') ?? '').toLowerCase();
  if (term === 'dumb' || term === 'linux') return true;
  const locale = envValue(env, 'LC_ALL') ?? envValue(env, 'LC_CTYPE') ?? envValue(env, 'LANG');
  if (locale === null) return false;
  return !/utf-?8/i.test(locale);
}

/** Clamp to 5..30 (R14); NaN, ±Infinity and non-numbers are rejected (null) so the next layer applies. */
export function parseFps(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(n)));
}

function parseRenderMode(text: string): LaunchSettings['renderMode'] | null {
  const t = text.trim().toLowerCase();
  return t === 'standard' || t === 'incremental' ? t : null;
}

/** TUI-DESIGN §16: launch settings with their sources; flag > env > default, pure, argv + env only (§1). */
export function resolveLaunchSettingsWithSources(flags: LaunchFlags, env: NodeJS.ProcessEnv): { settings: LaunchSettings; sources: LaunchSources } {
  // fps: --fps > JEVCODE_FPS > 15 under SSH > 30; an unparsable layer is skipped, never fatal (nothing can render an error yet)
  let fps = isSshSession(env) ? SSH_FPS : DEFAULT_FPS;
  let fpsSource: LaunchSource = 'default';
  const fpsEnv = envValue(env, 'JEVCODE_FPS');
  const fpsFromEnv = fpsEnv === null ? null : parseFps(fpsEnv);
  if (fpsFromEnv !== null) {
    fps = fpsFromEnv;
    fpsSource = 'env';
  }
  const fpsFromFlag = typeof flags.fps === 'string' ? parseFps(flags.fps) : null;
  if (fpsFromFlag !== null) {
    fps = fpsFromFlag;
    fpsSource = 'flag';
  }

  // renderMode: --render-mode > JEVCODE_RENDER_MODE > standard
  let renderMode: LaunchSettings['renderMode'] = 'standard';
  let renderSource: LaunchSource = 'default';
  const rmEnv = envValue(env, 'JEVCODE_RENDER_MODE');
  const rmFromEnv = rmEnv === null ? null : parseRenderMode(rmEnv);
  if (rmFromEnv !== null) {
    renderMode = rmFromEnv;
    renderSource = 'env';
  }
  const rmFromFlag = typeof flags.renderMode === 'string' ? parseRenderMode(flags.renderMode) : null;
  if (rmFromFlag !== null) {
    renderMode = rmFromFlag;
    renderSource = 'flag';
  }

  // screenReader: --screen-reader > JEVCODE_SCREEN_READER > INK_SCREEN_READER > false (`=0` overrides)
  let screenReader = false;
  let srSource: LaunchSource = 'default';
  const srEnv = envValue(env, 'JEVCODE_SCREEN_READER') ?? envValue(env, 'INK_SCREEN_READER');
  if (srEnv !== null) {
    screenReader = parseEnvBoolean(srEnv);
    srSource = 'env';
  }
  if (flags.screenReader === true) {
    screenReader = true;
    srSource = 'flag';
  }

  // ascii: --ascii > JEVCODE_ASCII (`=0` forces Unicode even on TERM=dumb) > auto
  let ascii = asciiAuto(env);
  let asciiSource: LaunchSource = 'default';
  const asciiEnv = envValue(env, 'JEVCODE_ASCII');
  if (asciiEnv !== null) {
    ascii = parseEnvBoolean(asciiEnv);
    asciiSource = 'env';
  }
  if (flags.ascii === true) {
    ascii = true;
    asciiSource = 'flag';
  }

  // noColor: --no-color > NO_COLOR (any non-empty value, per no-color.org) > FORCE_COLOR=0 > terminal (false here)
  let noColor = false;
  let ncSource: LaunchSource = 'default';
  if (envValue(env, 'NO_COLOR') !== null || env['FORCE_COLOR'] === '0') {
    noColor = true;
    ncSource = 'env';
  }
  if (flags.noColor === true) {
    noColor = true;
    ncSource = 'flag';
  }

  // TUI-DESIGN-2 §6 item 14 / §1.1: modeHint = --mode > JEVCODE_MODE, absent otherwise (the App reads jev-only); a bad value is
  // skipped here (nothing can render an error yet) and reported by the `mode` setting with its source
  let modeHint: EngineMode | undefined;
  let modeSource: LaunchSource = 'default';
  const modeEnv = envValue(env, 'JEVCODE_MODE');
  const modeFromEnv = modeEnv === null ? null : parseModeHint(modeEnv);
  if (modeFromEnv !== null) {
    modeHint = modeFromEnv;
    modeSource = 'env';
  }
  const modeFromFlag = typeof flags.mode === 'string' ? parseModeHint(flags.mode) : null;
  if (modeFromFlag !== null) {
    modeHint = modeFromFlag;
    modeSource = 'flag';
  }

  // TUI-DESIGN-2 §6 item 14 / §5.3: reducedMotion = --no-animation > JEVCODE_REDUCED_MOTION (`=0` overrides) > screenReader
  let reducedMotion = screenReader;
  let rmSource: LaunchSource = 'default';
  const reducedEnv = envValue(env, 'JEVCODE_REDUCED_MOTION');
  if (reducedEnv !== null) {
    reducedMotion = parseEnvBoolean(reducedEnv);
    rmSource = 'env';
  }
  if (flags.noAnimation === true) {
    reducedMotion = true;
    rmSource = 'flag';
  }

  return {
    settings: { fps, renderMode, screenReader, ascii, noColor, ...(modeHint !== undefined ? { modeHint } : {}), reducedMotion },
    sources: { fps: fpsSource, renderMode: renderSource, screenReader: srSource, ascii: asciiSource, noColor: ncSource, modeHint: modeSource, reducedMotion: rmSource },
  };
}

/** TUI-DESIGN §16 / §15 item 17: `resolveLaunchSettings(flags, env)` — flag > env > default; pure; argv + env only, no file. */
export function resolveLaunchSettings(flags: LaunchFlags, env: NodeJS.ProcessEnv): LaunchSettings {
  return resolveLaunchSettingsWithSources(flags, env).settings;
}
