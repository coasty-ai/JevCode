/**
 * Launch settings (TUI-DESIGN §16, §1, §14.1): `ui.fps`, `ui.renderMode`, `ui.screenReader`, `ui.ascii`,
 * `ui.noColor` resolve **flag > env > default** from argv and `process.env` alone — no file, no I/O — because
 * Ink fixes `maxFps` / `incrementalRendering` / `isScreenReaderEnabled` in its constructor and F1 forbids any
 * file read before the first frame. Everything here is pure: the same inputs give the same output.
 *
 * TUI-DESIGN-2 §6 item 14 adds two argv + env members for the first frame: `modeHint` (`--mode` > `JEVCODE_MODE`; the badge
 * word of §1.5 until `resolveConfig` reads the `mode` setting) and `reducedMotion` (`--no-animation` > `JEVCODE_REDUCED_MOTION`
 * > screenReader; the splash's static form of §5.3 until the `ui.reducedMotion` chain is read).
 *
 * TUI-DESIGN-3 §6 item 8 adds `ssh` (the SSH launch source, exposed for `ui.wordmark`'s default) and `themeHint` (D-R: `COLORFGBG`
 * naming a light background makes `light` frame 0's theme unless `--theme` / `JEVCODE_THEME` is set).
 */
import type { ConfigSource, EngineMode, LaunchSettings } from '../core/types.js';
import { DEFAULT_FPS, MAX_FPS, MIN_FPS, MODE_SETTING_VALUES, SSH_FPS } from './defaults.js';

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
  /** TUI-DESIGN-3 §2.2 (D-R): `--theme` — an explicit theme suppresses the `COLORFGBG` hint (the chain resolves it) */
  theme?: string;
  /** TUI-DESIGN-4 §1.3.1: `--renderer classic|fullscreen` */
  renderer?: string;
  /** TUI-DESIGN-4 §1.3.1: `--fullscreen`, the short form of `--renderer fullscreen` */
  fullscreen?: boolean;
}

/** Where each launch member came from; `jevcode config` prints it beside the value (§16). */
export type LaunchSource = Extract<ConfigSource, 'flag' | 'env' | 'default'>;
export type LaunchSources = Readonly<Record<keyof LaunchSettings, LaunchSource>>;

export const RENDER_MODES = ['standard', 'incremental'] as const;

/**
 * TUI-DESIGN-4 §1.3.1: `ui.renderer` is a LAUNCH setting — Ink fixes `alternateScreen` in its constructor
 * (`node_modules/ink/build/ink.js:256`), so the renderer cannot be toggled in place. Only the **flag** and the **env**
 * layers are resolvable before the first frame (§1: zero file I/O); the FILE layer is applied by `resolveUiConfig`
 * through the `ui.renderer` setting row, which is why `renderer` is left **undefined** here when neither argv nor env
 * names it (`launch.renderer ?? <the file/default chain>` is the reader idiom, §8 item 6).
 */
function parseRenderer(text: string): 'classic' | 'fullscreen' | null {
  const t = text.trim().toLowerCase();
  return t === 'classic' || t === 'fullscreen' ? t : null;
}

/** TUI-DESIGN-2 §1.2 / §6 item 14: a `--mode` / `JEVCODE_MODE` value, or null so the next layer applies (the `mode` setting reports a bad value later, with its source). */
export function parseModeHint(text: string): EngineMode | null {
  const t = text.trim().toLowerCase();
  // TUI-DESIGN-3 §1.1 (R3 F2): every MODE_SETTING_VALUES member, llm-jev included — `--mode llm-jev` shows `llm+jev · verified` from frame 0
  return (MODE_SETTING_VALUES as readonly string[]).includes(t) ? (t as EngineMode) : null;
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

/**
 * TUI-DESIGN-3 §2.2 (D-R): `COLORFGBG` is `<fg>;<bg>` or `<fg>;<x>;<bg>` (iTerm2, Konsole, rxvt, mintty set it); a background index of
 * 7 or 15 is a light terminal → `'light'`; a dark index, a lone value, garbage or an empty string → null (the default `dark` stands).
 */
/** The theme names frame 0 may adopt from argv/env (mirrors `ThemeName` in src/tui/theme.ts without importing the TUI here). */
export type ThemeHint = 'dark' | 'light' | 'daltonized' | 'ansi';
const THEME_HINTS: readonly ThemeHint[] = ['dark', 'light', 'daltonized', 'ansi'];
/** `--theme <name>` / `JEVCODE_THEME` as a frame-0 hint: a known name (case-folded), else null (the chain decides later). */
export function parseThemeHint(text: string): ThemeHint | null {
  const t = text.trim().toLowerCase();
  return (THEME_HINTS as readonly string[]).includes(t) ? (t as ThemeHint) : null;
}

export function parseColorFgBg(text: string): 'light' | null {
  const parts = text.trim().split(';');
  if (parts.length < 2) return null;
  const bg = (parts[parts.length - 1] ?? '').trim();
  if (!/^\d+$/.test(bg)) return null;
  const n = Number(bg);
  return n === 7 || n === 15 ? 'light' : null;
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

  // TUI-DESIGN-2 §6 item 14 / §1.1: modeHint = --mode > JEVCODE_MODE, absent otherwise (the App reads DEFAULT_MODE); a bad value is
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

  // TUI-DESIGN-4 §1.3.1: renderer = --fullscreen > --renderer > JEVCODE_RENDERER > (the file row, applied later by
  // resolveUiConfig) > classic. Left ABSENT when nothing here names it, so the file layer is not shadowed; a bad value
  // is skipped (nothing can render an error yet) and `jevcode config` reports it with its source.
  let renderer: LaunchSettings['renderer'];
  let rendererSource: LaunchSource = 'default';
  const rendererEnv = envValue(env, 'JEVCODE_RENDERER');
  const rendererFromEnv = rendererEnv === null ? null : parseRenderer(rendererEnv);
  if (rendererFromEnv !== null) {
    renderer = rendererFromEnv;
    rendererSource = 'env';
  }
  const rendererFromFlag = typeof flags.renderer === 'string' ? parseRenderer(flags.renderer) : null;
  if (rendererFromFlag !== null) {
    renderer = rendererFromFlag;
    rendererSource = 'flag';
  }
  // `--fullscreen` is the short form of `--renderer fullscreen`; `src/cli/args.ts` raises a usage error when the two
  // are both given and disagree, so reaching here with `renderer === 'classic'` means only `--fullscreen` was typed.
  if (flags.fullscreen === true) {
    renderer = 'fullscreen';
    rendererSource = 'flag';
  }

  // TUI-DESIGN-3 §6 item 8: the SSH launch source (the fps default's input above), exposed for `ui.wordmark`'s `static` default
  const ssh = isSshSession(env);

  // TUI-DESIGN-3 §2.2 (D-R): themeHint = `light` when COLORFGBG names a light background (index 7 | 15) and neither --theme nor
  // JEVCODE_THEME is set — an explicit theme resolves through the chain after the first frame; env only, zero I/O
  // An explicit `--theme` / `JEVCODE_THEME` naming a known theme is frame 0's theme too (argv/env only, zero I/O): the splash and
  // the console never paint the dark palette first. Anything else resolves through the chain after the first frame.
  let themeHint: ThemeHint | undefined;
  let themeSource: LaunchSource = 'default';
  const flagTheme = typeof flags.theme === 'string' ? parseThemeHint(flags.theme) : null;
  const envTheme = parseThemeHint(envValue(env, 'JEVCODE_THEME') ?? '');
  const themeExplicit = (typeof flags.theme === 'string' && flags.theme.trim() !== '') || envValue(env, 'JEVCODE_THEME') !== null;
  const fgbg = envValue(env, 'COLORFGBG');
  const fgbgHint = fgbg === null ? null : parseColorFgBg(fgbg);
  if (flagTheme !== null) {
    themeHint = flagTheme;
    themeSource = 'flag';
  } else if (envTheme !== null) {
    themeHint = envTheme;
    themeSource = 'env';
  } else if (!themeExplicit && fgbgHint !== null) {
    themeHint = fgbgHint;
    themeSource = 'env';
  }

  return {
    settings: { fps, renderMode, screenReader, ascii, noColor, ...(modeHint !== undefined ? { modeHint } : {}), reducedMotion, ...(themeHint !== undefined ? { themeHint } : {}), ssh, ...(renderer !== undefined ? { renderer } : {}) },
    sources: {
      fps: fpsSource,
      renderMode: renderSource,
      screenReader: srSource,
      ascii: asciiSource,
      noColor: ncSource,
      modeHint: modeSource,
      reducedMotion: rmSource,
      themeHint: themeSource,
      ssh: ssh ? 'env' : 'default',
      // contract 1.7 (TUI-DESIGN-4 §8 item 6 / §1.3.1)
      renderer: rendererSource,
      // the refusal is not a configured value: it is produced at MOUNT by `createTuiRenderer`, which is the first place
      // rows / columns / TERM / the screen-reader fact are all known (§1.3.1's matrix). Never 'flag' or 'env'.
      rendererRefusal: 'default',
    },
  };
}

/** TUI-DESIGN §16 / §15 item 17: `resolveLaunchSettings(flags, env)` — flag > env > default; pure; argv + env only, no file. */
export function resolveLaunchSettings(flags: LaunchFlags, env: NodeJS.ProcessEnv): LaunchSettings {
  return resolveLaunchSettingsWithSources(flags, env).settings;
}
