/**
 * Per-run log (TUI-DESIGN §13.6, D11). One file per run (`<runDir>/jevcode.log`, `JEVCODE_LOG`
 * override) with the levels `error | warn | info | debug | trace`; `warn`+ is appended
 * synchronously, `info`− through a 250 ms buffer that the `'exit'` handler flushes synchronously;
 * every line is stripped of escape sequences and control bytes, then passes the injected `redact`,
 * then is clipped to 512 chars; keystrokes are logged as categories only (§10.6); write failures
 * are swallowed and never reach stdout/stderr (Ink owns the terminal). When the target directory
 * is unwritable the log falls back to `~/.jevcode/logs/jevcode-<pid>-<stamp>.log`, keeping the
 * newest 10 files there (P63). All open logs share one process `'exit'` hook.
 */
import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stripTerminalControls } from './ansi.js';
import { patternRedact } from './redact.js';

/** TUI-DESIGN §13.6: the five levels, most severe first. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** TUI-DESIGN §13.6: every level, most severe first. */
export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

/** TUI-DESIGN §13.6: default level. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';
/** TUI-DESIGN §13.6: key=value lines are clipped here after redaction. */
export const LOG_LINE_MAX = 512;
/** TUI-DESIGN §13.6: `info`− buffer interval. */
export const LOG_FLUSH_MS = 250;
/** TUI-DESIGN §13.6: 8 MiB cap with one rotation (`jevcode.log.1`). */
export const LOG_MAX_BYTES = 8 * 1024 * 1024;
/** TUI-DESIGN §13.6 / P63: newest files kept in the fallback directory. */
export const LOG_FALLBACK_KEEP = 10;
/** TUI-DESIGN §13.6: the per-run file name. */
export const LOG_FILE_NAME = 'jevcode.log';

/** TUI-DESIGN §10.6: the only thing a keystroke ever becomes in a log line. */
export type KeyClass = 'return' | 'backspace' | 'ctrl' | 'escape' | 'arrow' | 'text' | 'paste' | 'filtered';

/** TUI-DESIGN §13.6: the per-run log handle. */
export interface Log {
  readonly level: LogLevel;
  /** the file receiving lines (the fallback path when the requested one was unwritable) */
  readonly file: string;
  /** true when `file` is the fallback, not the requested path */
  readonly fellBack: boolean;
  error(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
  debug(msg: string): void;
  trace(msg: string): void;
  /** true when a line at `level` would be written */
  enabled(level: LogLevel): boolean;
  /** TUI-DESIGN §10.6: `key kind=<class> len=<n> masked=<bool>` at trace — never the key itself */
  key(kind: KeyClass, len: number, masked?: boolean): void;
  /** TUI-DESIGN §10.6: `paste len=<n>` at trace */
  paste(len: number): void;
  /** write the buffered `info`− lines now (synchronous) */
  flush(): void;
  /** flush, stop the timer and detach the exit hook; further lines are dropped */
  close(): void;
}

/** File-system seam for tests (every member is the `node:fs` sync call of the same name). */
export interface LogFs {
  appendFileSync(path: string, data: string): void;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, opts: { recursive: true; mode?: number }): void;
  statSync(path: string): { size: number; mtimeMs: number };
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  readdirSync(path: string): string[];
}

const NODE_FS: LogFs = {
  appendFileSync: (p, d) => appendFileSync(p, d),
  writeFileSync: (p, d) => writeFileSync(p, d),
  mkdirSync: (p, o) => {
    mkdirSync(p, o);
  },
  statSync: (p) => {
    const st = statSync(p);
    return { size: st.size, mtimeMs: st.mtimeMs };
  },
  renameSync: (a, b) => renameSync(a, b),
  unlinkSync: (p) => unlinkSync(p),
  readdirSync: (p) => readdirSync(p),
};

/** TUI-DESIGN §13.6: `createLog` inputs; everything with I/O or a clock is injectable. */
export interface CreateLogOptions {
  /** requested file; `null` disables writing entirely (every line is dropped, the API stays usable) */
  file: string | null;
  level?: LogLevel;
  /** the config redactor; defaults to `patternRedact` (the safe layer before `resolveConfig` exists) */
  redact?: (s: string) => string;
  /** `~/.jevcode/logs`; when absent an unwritable `file` disables the log */
  fallbackDir?: string;
  /** clock for the timestamp column and the fallback stamp */
  now?: () => Date;
  pid?: number;
  /** rotation cap (default 8 MiB) */
  maxBytes?: number;
  /** buffer interval (default 250 ms) */
  flushMs?: number;
  /** register `process.on('exit', flush)` (default true; tests pass false) */
  exitHook?: boolean;
  fs?: LogFs;
}

const RANK: Readonly<Record<LogLevel, number>> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

/** TUI-DESIGN §13.6: parse a level name; unknown or empty → null. */
export function parseLogLevel(s: string | undefined): LogLevel | null {
  if (s === undefined) return null;
  const t = s.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(t) ? (t as LogLevel) : null;
}

/**
 * TUI-DESIGN §13.6 / §16 `log.file`, `log.level`: the env layer of the log settings, pure.
 * `JEVCODE_TRACE=<file>` is an alias for `JEVCODE_LOG=<file>` at level `trace` (the explicit
 * `JEVCODE_LOG` / `JEVCODE_LOG_LEVEL` win when both are set); `--verbose` = `debug`.
 */
export function logSettingsFromEnv(env: NodeJS.ProcessEnv, flags: { log?: string; logLevel?: string; verbose?: boolean } = {}): { file: string | null; level: LogLevel; source: 'flag' | 'env' | 'default' } {
  const traceFile = env['JEVCODE_TRACE']?.trim();
  const envFile = env['JEVCODE_LOG']?.trim();
  const file = flags.log?.trim() || envFile || traceFile || null;
  const flagLevel = parseLogLevel(flags.logLevel) ?? (flags.verbose ? 'debug' : null);
  if (flagLevel) return { file, level: flagLevel, source: 'flag' };
  const envLevel = parseLogLevel(env['JEVCODE_LOG_LEVEL']);
  if (envLevel) return { file, level: envLevel, source: 'env' };
  if (traceFile) return { file, level: 'trace', source: 'env' };
  return { file, level: DEFAULT_LOG_LEVEL, source: file ? 'env' : 'default' };
}

/** TUI-DESIGN §13.6: `<runDir>/jevcode.log`. */
export function runLogPath(runDir: string): string {
  return join(runDir, LOG_FILE_NAME);
}

/** TUI-DESIGN §13.6: `~/.jevcode/logs`. */
export function fallbackLogDir(home: string): string {
  return join(home, '.jevcode', 'logs');
}

function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** TUI-DESIGN §13.6: `jevcode-<pid>-<yyyymmdd-hhmmss>.log` inside the fallback dir. */
export function fallbackLogPath(dir: string, pid: number, now: Date): string {
  return join(dir, `jevcode-${pid}-${stamp(now)}.log`);
}


/**
 * TUI-DESIGN §13.6: one line — ISO time, level padded to five, the message on one line, clipped
 * to 512 chars. Order matters: escape sequences (whole, `core/ansi.ts`), control bytes and newlines are
 * stripped FIRST and `redact` runs on the cleaned text, so a key split by an ESC sequence or a NUL (command output
 * routed here via `routeConsole`) is recognised instead of being reassembled after redaction;
 * clipping happens last so it can never split a marker back into secret bytes. Pure; `redact`
 * defaults to `patternRedact`.
 */
export function formatLogLine(level: LogLevel, msg: string, at: Date, redact: (s: string) => string = patternRedact): string {
  // sequences before the line breaks are flattened: an unterminated OSC ends at its own line, not at the message's end
  const clean = stripTerminalControls(String(msg)).replace(/\r\n|\r|\n/g, ' ⏎ ');
  const flat = redact(clean);
  const head = `${Number.isFinite(at.getTime()) ? at.toISOString() : '0000-00-00T00:00:00.000Z'} ${level.padEnd(5)} `;
  const room = Math.max(0, LOG_LINE_MAX - head.length);
  const body = flat.length > room ? `${flat.slice(0, Math.max(0, room - 1))}…` : flat;
  return `${head}${body}\n`;
}

/** TUI-DESIGN §10.6: the trace line for one key event — the class and length, never the bytes. Pure. */
export function keyTraceLine(kind: KeyClass, len: number, masked: boolean): string {
  const n = Number.isFinite(len) && len >= 0 ? Math.floor(len) : 0;
  return `key kind=${kind} len=${n} masked=${masked}`;
}

/** TUI-DESIGN §13.6 / P63: delete all but the newest `keep` `jevcode-*.log` files in `dir` (never `exclude`, the live log); failures are swallowed. */
export function pruneFallbackLogs(dir: string, keep: number = LOG_FALLBACK_KEEP, fs: LogFs = NODE_FS, exclude: string | null = null): number {
  let removed = 0;
  try {
    const files = fs
      .readdirSync(dir)
      .filter((n) => /^jevcode-\d+-\d{8}-\d{6}\.log$/.test(n) && join(dir, n) !== exclude)
      .map((n) => {
        const p = join(dir, n);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(p).mtimeMs;
        } catch {
          /* unreadable: sorts oldest */
        }
        return { p, n, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.n < b.n ? 1 : -1));
    for (const f of files.slice(Math.max(0, exclude === null ? keep : keep - 1))) {
      try {
        fs.unlinkSync(f.p);
        removed++;
      } catch {
        /* swallowed: the log never becomes a second error path */
      }
    }
  } catch {
    /* no directory: nothing to prune */
  }
  return removed;
}

// One process-level 'exit' hook for every open log (P63 sessions open a log per run): registered
// with the first open log, removed with the last close, so Node's MaxListeners warning can never
// reach stderr while Ink is mounted (§13.6).
const OPEN_LOGS = new Set<() => void>();
function sharedExitHook(): void {
  for (const flush of OPEN_LOGS) flush();
}
function registerExitFlush(flush: () => void): void {
  if (OPEN_LOGS.size === 0) process.on('exit', sharedExitHook);
  OPEN_LOGS.add(flush);
}
function unregisterExitFlush(flush: () => void): void {
  if (!OPEN_LOGS.delete(flush)) return;
  if (OPEN_LOGS.size === 0) process.removeListener('exit', sharedExitHook);
}

/** Number of open logs sharing the process 'exit' hook (tests). */
export function openLogCount(): number {
  return OPEN_LOGS.size;
}

function ensureWritable(path: string, fs: LogFs): boolean {
  try {
    fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fs.appendFileSync(path, '');
    return true;
  } catch {
    return false;
  }
}

/**
 * TUI-DESIGN §13.6: open the per-run log. `warn`+ lines hit the disk synchronously, `info`−
 * lines are buffered for 250 ms (flushed synchronously on `'exit'`); the file rotates once at
 * 8 MiB; an unwritable target falls back to `fallbackDir` (newest 10 kept); every failure is
 * swallowed. Never writes to stdout or stderr.
 */
export function createLog(opts: CreateLogOptions): Log {
  const fs = opts.fs ?? NODE_FS;
  const now = opts.now ?? ((): Date => new Date());
  const redact = opts.redact ?? patternRedact;
  const level = opts.level ?? DEFAULT_LOG_LEVEL;
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
  const flushMs = opts.flushMs ?? LOG_FLUSH_MS;
  const pid = opts.pid ?? process.pid;

  let file: string | null = null;
  let fellBack = false;
  if (opts.file !== null) {
    if (ensureWritable(opts.file, fs)) file = opts.file;
    else if (opts.fallbackDir) {
      const fb = fallbackLogPath(opts.fallbackDir, pid, now());
      if (ensureWritable(fb, fs)) {
        file = fb;
        fellBack = true;
        pruneFallbackLogs(opts.fallbackDir, LOG_FALLBACK_KEEP, fs, fb);
      }
    }
  }

  let size = 0;
  if (file) {
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
  }
  let buffer: string[] = [];
  let buffered = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function rotateIfNeeded(incoming: number): void {
    if (!file || size + incoming <= maxBytes) return;
    try {
      fs.renameSync(file, `${file}.1`);
    } catch {
      /* rotation failure: keep appending to the same file */
    }
    size = 0;
  }

  function write(text: string): void {
    if (!file || text.length === 0) return;
    const bytes = Buffer.byteLength(text, 'utf8');
    rotateIfNeeded(bytes);
    try {
      fs.appendFileSync(file, text);
      size += bytes;
    } catch {
      /* swallowed (§13.6): disk failure of the log itself is never a second error path */
    }
  }

  function flush(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const text = buffer.join('');
    buffer = [];
    buffered = 0;
    write(text);
  }

  function onExit(): void {
    flush();
  }
  const exitHook = opts.exitHook ?? true;
  if (exitHook && file) registerExitFlush(onExit);

  function emit(l: LogLevel, msg: string): void {
    if (closed || !file || RANK[l] > RANK[level]) return;
    const line = formatLogLine(l, msg, now(), redact);
    if (RANK[l] <= RANK.warn) {
      flush();
      write(line);
      return;
    }
    buffer.push(line);
    buffered += line.length;
    if (buffered >= 64 * 1024) {
      flush();
      return;
    }
    if (!timer) {
      timer = setTimeout(flush, flushMs);
      timer.unref?.();
    }
  }

  return {
    level,
    file: file ?? opts.file ?? '',
    fellBack,
    error: (m) => emit('error', m),
    warn: (m) => emit('warn', m),
    info: (m) => emit('info', m),
    debug: (m) => emit('debug', m),
    trace: (m) => emit('trace', m),
    enabled: (l) => file !== null && !closed && RANK[l] <= RANK[level],
    key: (kind, len, masked = false) => emit('trace', keyTraceLine(kind, len, masked)),
    paste: (len) => emit('trace', `paste len=${Number.isFinite(len) && len >= 0 ? Math.floor(len) : 0}`),
    flush,
    close: () => {
      flush();
      closed = true;
      if (exitHook && file) unregisterExitFlush(onExit);
    },
  };
}

/** A log that drops everything (before a file exists, bench, tests). */
export function nullLog(level: LogLevel = DEFAULT_LOG_LEVEL): Log {
  return createLog({ file: null, level, exitHook: false });
}

type ConsoleMethod = 'log' | 'info' | 'debug' | 'warn' | 'error' | 'trace';
const CONSOLE_MAP: Readonly<Record<ConsoleMethod, LogLevel>> = { log: 'info', info: 'info', debug: 'debug', warn: 'warn', error: 'error', trace: 'trace' };

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

/**
 * TUI-DESIGN §13.6: route `console.*` into the log while Ink is mounted (`patchConsole: false`
 * means a stray write would corrupt the frame). Returns the restore function.
 */
export function routeConsole(log: Log, target: Console = console): () => void {
  const saved: Partial<Record<ConsoleMethod, Console[ConsoleMethod]>> = {};
  for (const m of Object.keys(CONSOLE_MAP) as ConsoleMethod[]) {
    saved[m] = target[m];
    const lvl = CONSOLE_MAP[m];
    target[m] = (...args: unknown[]): void => {
      log[lvl](`console.${m} ${args.map(stringifyArg).join(' ')}`);
    };
  }
  return () => {
    for (const m of Object.keys(saved) as ConsoleMethod[]) {
      const fn = saved[m];
      if (fn) target[m] = fn;
    }
  };
}
