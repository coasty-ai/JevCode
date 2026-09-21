/**
 * Colour detection (TUI-DESIGN §14.1 "Colour", D13, F2). `bin/jevcode.js` maps `NO_COLOR` → `FORCE_COLOR=0`
 * before the bundle is evaluated; this module repeats the shim as a first-position side effect so the same
 * rule holds under tsx / vitest (Q14), and exports the one runtime detection the theme reads:
 * `colorEnabled()` = flag > `FORCE_COLOR` > `NO_COLOR` > `TERM=dumb` > `stream.hasColors?.(16)`.
 * No terminal query is ever sent (A112); ANSI-16 only, so the answer is a boolean.
 */

/** TUI-DESIGN §14.1: `NO_COLOR` set (any non-empty value, per no-color.org) and `FORCE_COLOR` unset → `FORCE_COLOR=0`. Returns true when it wrote. */
export function applyNoColorShim(env: NodeJS.ProcessEnv = process.env): boolean {
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '' && env['FORCE_COLOR'] === undefined) {
    env['FORCE_COLOR'] = '0';
    return true;
  }
  return false;
}

// First-position side effect (TUI-DESIGN §14.1): chalk 5 inside Ink reads FORCE_COLOR only.
applyNoColorShim();

/** The part of a write stream the detection reads (`process.stdout` satisfies it; tests inject a stub). */
export interface ColorStream {
  isTTY?: boolean | undefined;
  hasColors?: (count?: number) => boolean;
}

export interface ColorEnabledOptions {
  /** `--no-color` */
  noColor?: boolean;
  env?: NodeJS.ProcessEnv;
  stream?: ColorStream | null;
}

/** `FORCE_COLOR` as chalk reads it: `0`/`false` → off, `1`/`2`/`3`/`true`/`` → on, anything else → unset. */
function forceColor(env: NodeJS.ProcessEnv): boolean | null {
  const v = env['FORCE_COLOR'];
  if (v === undefined) return null;
  const t = v.trim().toLowerCase();
  if (t === '0' || t === 'false') return false;
  if (t === '' || t === '1' || t === '2' || t === '3' || t === 'true') return true;
  return null;
}

/**
 * TUI-DESIGN §14.1: one `colorEnabled()` — `--no-color` > `FORCE_COLOR` > `NO_COLOR` > `TERM=dumb` > `hasColors?.(16)`
 * (a stream without `hasColors` counts as a colour terminal when it is a TTY, else no colour). Pure over its inputs.
 */
export function colorEnabled(opts: ColorEnabledOptions = {}): boolean {
  if (opts.noColor === true) return false;
  const env = opts.env ?? process.env;
  const forced = forceColor(env);
  if (forced !== null) return forced;
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return false;
  if ((env['TERM'] ?? '').trim().toLowerCase() === 'dumb') return false;
  const stream = opts.stream === undefined ? process.stdout : opts.stream;
  if (stream === null) return false;
  if (typeof stream.hasColors === 'function') {
    try {
      return stream.hasColors(16);
    } catch {
      return false;
    }
  }
  return stream.isTTY === true;
}
