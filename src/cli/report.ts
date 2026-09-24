/**
 * `jevcode report <id>` and `/report` (TUI-DESIGN §13.6, A168, A169): a redacted support bundle under
 * `~/.jevcode/reports/<run-id>/` — `run.json`, `transcript.log`, `jevcode.log`, the last 20 `steps.jsonl` rows,
 * `config.json` (what `jevcode config --json` prints), `versions.txt` (node, jevcode, ink, TERM/TERM_PROGRAM,
 * rows×cols) and `README.txt` with the issues URL. Everything passes `redact`; `jev.jsonl` request bodies only with
 * `--include-requests`; nothing is sent anywhere. Pure over an injectable file system so the bundle is unit-tested
 * offline.
 */
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ParsedFlags } from './args.js';
import { EXIT_CODES, explainFsError } from '../errors.js';
import { VERSION } from '../version.js';

/** TUI-DESIGN §13.6: `steps.jsonl` rows kept in the bundle. */
export const REPORT_STEPS_TAIL = 20;
/** TUI-DESIGN-4 §7.7 item 1: `decisions.jsonl` rows kept in the bundle. */
export const REPORT_DECISIONS_TAIL = 200;
/**
 * TUI-DESIGN-4 §7.7 item 2: the per-file cap — the first `REPORT_FILE_MAX` bytes and the last `REPORT_FILE_MAX`
 * bytes, with an elision marker between them. Before round 4 `put()` did `redact(await readFile(<whole file>))`, so
 * a multi-hour `transcript.log` of hundreds of MB was read into one string and regex-redacted at exactly the moment
 * the user was filing a bug.
 */
export const REPORT_FILE_MAX = 2 * 1024 * 1024;
/** TUI-DESIGN-4 §7.7 edge: a run directory on a stalled network mount bounds each read at this. */
export const REPORT_READ_TIMEOUT_MS = 10_000;
/** the pinned Ink version (package.json `dependencies.ink`; the bundle inlines it, so no runtime lookup exists) */
export const INK_VERSION = '7.1.1';
/** the pinned React version esbuild inlines beside Ink (`--version --json`, §17 item 3; `versions.txt`) */
export const REACT_VERSION = '19.3.0';
export const ISSUES_URL = 'https://github.com/coasty-ai/JevCode/issues';
/**
 * Files copied (head + tail capped, line by line through `redact`).
 *
 * TUI-DESIGN-4 §7.7 item 1 adds `state.json` (the file the epilogue calls the important one), `jevcode.log.1` (the
 * rotated half — after a rotation the old bundle kept only the newest 8 MiB and **lost the crash**) and `ui.json`
 * (the renderer snapshot the `launch` block of `versions.txt` is built from). `decisions.jsonl` and
 * `keybindings.json` are copied by their own rules below.
 */
export const REPORT_COPIED_FILES: readonly string[] = ['run.json', 'state.json', 'transcript.log', 'jevcode.log', 'jevcode.log.1', 'ui.json'];

/** TUI-DESIGN-4 §7.7 item 4: written first, and again last without the marker, so a mid-way failure is self-describing. */
export const BUNDLE_INCOMPLETE_MARKER = '(bundle incomplete)';

/** TUI-DESIGN-4 §7.7 edge: the errnos that mean "this bundle cannot be finished" rather than "this path is wrong" — exit 3, not 2. */
const DISK_FULL_CODES: ReadonlySet<string> = new Set(['ENOSPC', 'EDQUOT']);

/** TUI-DESIGN-4 §7.7 item 2 / §12: `… <n> bytes elided (original <m> bytes) …`. */
export function elisionMarker(elided: number, original: number): string {
  return `… ${elided} bytes elided (original ${original} bytes) …`;
}

export interface ReportFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /**
   * TUI-DESIGN-4 §7.7 item 2: the head/tail window of a file, in bytes, without reading the middle. Optional so a
   * test seam may supply only `readFile`; the default falls back to `readFile` and slices.
   */
  readCapped?(path: string, max: number): Promise<{ head: string; tail: string; bytes: number }>;
}

/** Cut a head window back to its last complete line so a copied file never begins or ends mid-row. */
function cutHead(text: string): string {
  const at = text.lastIndexOf('\n');
  return at < 0 ? text : text.slice(0, at + 1);
}
function cutTail(text: string): string {
  const at = text.indexOf('\n');
  return at < 0 ? text : text.slice(at + 1);
}

/**
 * TUI-DESIGN-4 §7.7 item 2: a head window at offset 0 and a tail window at `size - max` OVERLAP for every file
 * between `max` and `2 * max` bytes — the bundle would then carry the middle twice and the marker would claim
 * `0 bytes elided`, which is worse than no cap at all. The windows are therefore only taken when the file is
 * strictly larger than **both** of them: at or under `2 * max` the whole file is copied (it is 4 MiB at the
 * shipped cap, which is the size a support bundle is allowed to be).
 */
export function cappedWindowFits(bytes: number, max: number): boolean {
  return bytes <= 2 * max;
}

const NODE_FS: ReportFs = {
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, t) => writeFile(p, t, { mode: 0o600 }),
  mkdir: async (p) => {
    await mkdir(p, { recursive: true, mode: 0o700 });
  },
  readCapped: async (p, max) => {
    const bytes = (await stat(p)).size;
    if (cappedWindowFits(bytes, max)) return { head: await readFile(p, 'utf8'), tail: '', bytes };
    const fh = await open(p, 'r');
    try {
      const head = Buffer.allocUnsafe(max);
      const tail = Buffer.allocUnsafe(max);
      const h = await fh.read(head, 0, max, 0);
      // the two windows cannot meet: `bytes > 2 * max`, so `bytes - max > max` = the head's last offset
      const t = await fh.read(tail, 0, max, bytes - max);
      return { head: cutHead(head.subarray(0, h.bytesRead).toString('utf8')), tail: cutTail(tail.subarray(0, t.bytesRead).toString('utf8')), bytes };
    } finally {
      await fh.close();
    }
  },
};

/**
 * TUI-DESIGN-4 §7.7 edge: a run directory on a stalled network mount must not hang `jevcode report`. Each per-file
 * read is bounded at `REPORT_READ_TIMEOUT_MS`; on the deadline the file is listed under `not available` and the
 * bundle carries on. The timer is `unref`ed so it can never hold the process open.
 */
export class ReportReadTimeout extends Error {
  readonly file: string;
  readonly ms: number;
  constructor(file: string, ms: number) {
    super(`reading ${file} timed out after ${ms} ms`);
    this.name = 'ReportReadTimeout';
    this.file = file;
    this.ms = ms;
  }
}

function withReadTimeout<T>(p: Promise<T>, file: string, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const handle: unknown = setTimeout(() => reject(new ReportReadTimeout(file, ms)), ms);
    if (typeof (handle as { unref?: () => void }).unref === 'function') (handle as { unref: () => void }).unref();
    p.then(
      (v) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * TUI-DESIGN-4 §7.7 item 2: redact **line by line**. A whole-file regex over hundreds of MB is what the 1 GB
 * gate exists to stop; the cost of splitting the two 2 MiB windows is bounded by construction.
 */
function redactLines(text: string, redact: (s: string) => string): string {
  if (text.length === 0) return text;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) lines[i] = redact(lines[i] ?? '');
  return lines.join('\n');
}

export interface ReportBundleOptions {
  runDir: string;
  runId: string;
  /** the bundle directory (`~/.jevcode/reports/<id>/`) */
  out: string;
  redact: (s: string) => string;
  /** what `jevcode config --json` prints (already masked) */
  configJson: unknown;
  term: string | null;
  termProgram: string | null;
  columns: number | null;
  rows: number | null;
  /** `--include-requests`: the redacted `jev.jsonl` bodies too */
  includeRequests?: boolean;
  /**
   * §13.6: the session log (`~/.jevcode/logs/jevcode-<pid>-<stamp>.log`) copied as `jevcode.log` when the run directory
   * has none (pre-run and session-level events land there; the run-dir log exists only for runs the controller drove)
   */
  fallbackLog?: string | null;
  version?: string;
  inkVersion?: string;
  nodeVersion?: string;
  platform?: string;
  stepsTail?: number;
  /** TUI-DESIGN-4 §7.7 item 1: the effective `keybindings.json`, copied when present */
  keybindingsPath?: string | null;
  /** TUI-DESIGN-4 §7.7 item 3: the environment `versions.txt` reports (never the values of SSH_TTY / TMUX / STY) */
  env?: NodeJS.ProcessEnv;
  /** TUI-DESIGN-4 §7.7 item 3: `stdout.isTTY` */
  isTty?: boolean | null;
  /** TUI-DESIGN-4 §7.7 item 3: the resolved launch block; when absent it is read from the run's `ui.json` */
  launch?: Readonly<Record<string, string | number | boolean | null>> | null;
  /** TUI-DESIGN-4 §7.7 item 2: the per-file head/tail cap (test seam) */
  fileMax?: number;
  /** TUI-DESIGN-4 §7.7 edge: the per-file read deadline; 0 disables it (test seam, default `REPORT_READ_TIMEOUT_MS`) */
  readTimeoutMs?: number;
  fs?: ReportFs;
}

export interface ReportBundleResult {
  dir: string;
  /** files written, in order */
  files: string[];
  /** source files that were absent or unreadable (the bundle notes them in README.txt) */
  missing: string[];
  /** provenance notes (README.txt): e.g. `jevcode.log` copied from the session log */
  notes: string[];
  /** TUI-DESIGN-4 §7.7 item 5: the total bytes written */
  bytes: number;
  /** TUI-DESIGN-4 §7.7 item 4: false when a step failed and `README.txt` still carries `(bundle incomplete)` */
  complete: boolean;
}

/** TUI-DESIGN-4 §7.7 item 3: the env keys reported by value (never a secret; `TERM`/`TERM_PROGRAM` keep their own rows). */
export const REPORT_ENV_KEYS: readonly string[] = ['LANG', 'LC_ALL', 'TZ', 'COLORTERM', 'NO_COLOR'];
/** TUI-DESIGN-4 §7.7 item 3: reported as presence booleans only — a tty path and a session name are identifying. */
export const REPORT_ENV_PRESENCE_KEYS: readonly string[] = ['SSH_TTY', 'TMUX', 'STY'];
/** TUI-DESIGN-4 §7.7 item 3: the launch fields, in the order `versions.txt` prints them. */
export const REPORT_LAUNCH_KEYS: readonly string[] = ['tier', 'fps', 'renderMode', 'renderer', 'ascii', 'screenReader', 'reducedMotion', 'plain', 'theme'];

/** TUI-DESIGN-4 §7.7 item 5 / §12: `tar -czf <id>.tgz -C <parent> <id>`. */
export function tarSuggestion(dir: string, runId: string): string {
  return `tar -czf ${runId}.tgz -C ${dirname(dir)} ${runId}`;
}

/**
 * TUI-DESIGN §13.6 + TUI-DESIGN-4 §7.7 item 3: the `versions.txt` body.
 *
 * The measured bundle carried 111 bytes — `TERM`/`TERM_PROGRAM`/`rows×cols` and nothing else — i.e. none of the
 * variables that decide *which* frame the user was looking at. Round 4 adds the locale and colour environment, the
 * multiplexer/SSH **presence** booleans (never their values: a tty path and a session name identify a machine),
 * `stdout.isTTY`, and a `launch` block with the resolved tier, fps, renderMode, renderer, ascii, screenReader,
 * reducedMotion, plain and theme.
 */
export function versionsText(
  o: Pick<ReportBundleOptions, 'term' | 'termProgram' | 'columns' | 'rows' | 'version' | 'inkVersion' | 'nodeVersion' | 'platform' | 'env' | 'isTty' | 'launch'>,
): string {
  const env = o.env ?? {};
  const lines = [
    `jevcode ${o.version ?? VERSION}`,
    `node ${o.nodeVersion ?? process.version}`,
    `ink ${o.inkVersion ?? INK_VERSION}`,
    `react ${REACT_VERSION}`,
    `platform ${o.platform ?? process.platform}`,
    `TERM ${o.term ?? '(unset)'}`,
    `TERM_PROGRAM ${o.termProgram ?? '(unset)'}`,
    `size ${o.rows ?? '?'}×${o.columns ?? '?'}`,
    `isTTY ${o.isTty === null || o.isTty === undefined ? '(unknown)' : String(o.isTty)}`,
  ];
  for (const k of REPORT_ENV_KEYS) lines.push(`${k} ${env[k] ?? '(unset)'}`);
  for (const k of REPORT_ENV_PRESENCE_KEYS) lines.push(`${k} ${typeof env[k] === 'string' && env[k] !== '' ? 'set' : '(unset)'}`);
  lines.push('', 'launch:');
  const launch = o.launch ?? null;
  for (const k of REPORT_LAUNCH_KEYS) {
    const v = launch === null ? undefined : launch[k];
    lines.push(`  ${k} ${v === undefined || v === null ? '(unknown)' : String(v)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** TUI-DESIGN §13.6 + TUI-DESIGN-4 §7.7 item 4: the `README.txt` body; `incomplete` marks a bundle still being written. */
export function readmeText(
  runId: string,
  files: readonly string[],
  missing: readonly string[],
  issuesUrl = ISSUES_URL,
  notes: readonly string[] = [],
  incomplete = false,
): string {
  const lines = [
    `JevCode support bundle for run ${runId}${incomplete ? ` ${BUNDLE_INCOMPLETE_MARKER}` : ''}`,
    '',
    'Every file in this directory passed the run\'s redactor (configured secrets, acknowledged values and recognised key',
    'formats read [REDACTED:…]). Nothing was sent anywhere: attach the directory to an issue yourself if you want to.',
    '',
    `issues: ${issuesUrl}`,
    '',
    'files:',
    ...files.map((f) => `  ${f}`),
  ];
  if (notes.length > 0) lines.push('', 'notes:', ...notes.map((n) => `  ${n}`));
  if (missing.length > 0) lines.push('', 'not available in the run directory:', ...missing.map((f) => `  ${f}`));
  lines.push('');
  return lines.join('\n');
}

/** TUI-DESIGN §13.6: the newest `jevcode-<pid>-<stamp>.log` of the session-log directory (by mtime), or null. */
export async function newestSessionLog(logsDir: string): Promise<string | null> {
  try {
    const names = (await readdir(logsDir)).filter((n) => /^jevcode-\d+-.*\.log$/.test(n));
    let best: { path: string; mtime: number } | null = null;
    for (const n of names) {
      const path = join(logsDir, n);
      try {
        const m = (await stat(path)).mtimeMs;
        if (best === null || m > best.mtime) best = { path, mtime: m };
      } catch {
        /* vanished */
      }
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

/** the last `n` non-empty lines of a JSONL text */
export function tailLines(text: string, n: number): string[] {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  return lines.slice(Math.max(0, lines.length - n));
}

/**
 * TUI-DESIGN §13.6 / TUI-DESIGN-4 §7.7 `writeReportBundle`: copy the run's files into `out`, head+tail capped at
 * `REPORT_FILE_MAX` and redacted **line by line**, add the steps and decisions tails, the config JSON,
 * `versions.txt` and `README.txt`. Missing source files are listed, never fatal.
 *
 * Ordering is §7.7 item 4's: `README.txt` is written **first** carrying `(bundle incomplete)` and rewritten last
 * without it, so a mid-way failure (ENOSPC, a vanished run dir) leaves a directory that says so.
 */
export async function writeReportBundle(o: ReportBundleOptions): Promise<ReportBundleResult> {
  const fs = o.fs ?? NODE_FS;
  const max = o.fileMax ?? REPORT_FILE_MAX;
  const readMs = o.readTimeoutMs ?? REPORT_READ_TIMEOUT_MS;
  const files: string[] = [];
  const missing: string[] = [];
  const notes: string[] = [];
  let bytes = 0;
  /**
   * §7.7 item 4: false when a step that should have worked did not, so the final `README.txt` keeps
   * `(bundle incomplete)`. An **absent** source file (ENOENT) is not incompleteness — a run without
   * `jevcode.log.1` never rotated — so only a non-ENOENT failure (EACCES, ENOSPC on the write, a stalled mount)
   * clears the flag.
   */
  let complete = true;
  await fs.mkdir(o.out);

  const write = async (name: string, text: string): Promise<void> => {
    await fs.writeFile(join(o.out, name), text);
    bytes += Buffer.byteLength(text, 'utf8');
  };
  // §7.7 item 4: the self-describing placeholder, before anything can fail. Its bytes are NOT counted: the final
  // README (written last, without the marker) replaces it, and the size the command prints is the bundle's.
  await fs.writeFile(join(o.out, 'README.txt'), readmeText(o.runId, [], [], ISSUES_URL, [], true));

  /** ENOENT means "this run never wrote that file"; anything else means the bundle is missing something it wanted. */
  const noteFailure = (name: string, e: unknown): void => {
    missing.push(name);
    const code = typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : null;
    if (e instanceof ReportReadTimeout) {
      complete = false;
      notes.push(`${name}: not available — the read did not finish within ${e.ms} ms (a stalled mount?)`);
      return;
    }
    if (code !== null && code !== 'ENOENT') {
      complete = false;
      notes.push(`${name}: not available — ${code}`);
    }
  };

  /** §7.7 item 2: head + tail with the elision marker, every line through `redact`; each read bounded. */
  const copyCapped = async (from: string, name: string): Promise<void> => {
    const capped = await withReadTimeout(
      fs.readCapped
        ? fs.readCapped(from, max)
        : (async (): Promise<{ head: string; tail: string; bytes: number }> => {
            const whole = await fs.readFile(from);
            const size = Buffer.byteLength(whole, 'utf8');
            // §7.7 item 2: the windows must not overlap — at or under 2x the cap the file is copied whole.
            // The slice is by BYTES (a `Buffer`), never by UTF-16 code units, or a multi-byte file is cut short.
            if (cappedWindowFits(size, max)) return { head: whole, tail: '', bytes: size };
            const buf = Buffer.from(whole, 'utf8');
            return { head: cutHead(buf.subarray(0, max).toString('utf8')), tail: cutTail(buf.subarray(size - max).toString('utf8')), bytes: size };
          })(),
      name,
      readMs,
    );
    const head = redactLines(capped.head, o.redact);
    const elided = capped.bytes - Buffer.byteLength(capped.head, 'utf8') - Buffer.byteLength(capped.tail, 'utf8');
    // a marker claiming `0 bytes elided` would mean the two windows met: copy the head alone instead
    if (capped.tail.length === 0 || elided <= 0) {
      await write(name, head);
    } else {
      const sep = head.endsWith('\n') || head.length === 0 ? '' : '\n';
      await write(name, `${head}${sep}${elisionMarker(elided, capped.bytes)}\n${redactLines(capped.tail, o.redact)}`);
      notes.push(`${name}: capped at ${max} bytes head + ${max} bytes tail (original ${capped.bytes} bytes)`);
    }
    files.push(name);
  };

  const put = async (name: string, text: string): Promise<void> => {
    await write(name, redactLines(text, o.redact));
    files.push(name);
  };

  for (const name of REPORT_COPIED_FILES) {
    try {
      await copyCapped(join(o.runDir, name), name);
    } catch (e) {
      // §13.6: the session log stands in for a run directory without jevcode.log
      if (name === 'jevcode.log' && o.fallbackLog !== undefined && o.fallbackLog !== null) {
        try {
          await copyCapped(o.fallbackLog, name);
          notes.push(`jevcode.log: copied from the session log ${o.fallbackLog} (the run directory had none)`);
          continue;
        } catch {
          /* the fallback is missing too */
        }
      }
      noteFailure(name, e);
    }
  }
  try {
    const steps = await withReadTimeout(fs.readFile(join(o.runDir, 'steps.jsonl')), 'steps.jsonl', readMs);
    await put('steps.tail.jsonl', `${tailLines(steps, o.stepsTail ?? REPORT_STEPS_TAIL).join('\n')}\n`);
  } catch (e) {
    noteFailure('steps.jsonl', e);
  }
  // §7.7 item 1: the decisions tail — what Jev decided, which is half of every TUI bug report
  try {
    const decisions = await withReadTimeout(fs.readFile(join(o.runDir, 'decisions.jsonl')), 'decisions.jsonl', readMs);
    await put('decisions.tail.jsonl', `${tailLines(decisions, REPORT_DECISIONS_TAIL).join('\n')}\n`);
  } catch (e) {
    noteFailure('decisions.jsonl', e);
  }
  // §7.7 item 1: the effective keybindings decide which keys the captures show
  if (o.keybindingsPath !== undefined && o.keybindingsPath !== null) {
    try {
      await copyCapped(o.keybindingsPath, 'keybindings.json');
    } catch (e) {
      noteFailure('keybindings.json', e);
    }
  }
  if (o.includeRequests === true) {
    // §7.7 edge: `--include-requests`' jev.jsonl takes the same cap and the same redactor
    try {
      await copyCapped(join(o.runDir, 'jev.jsonl'), 'jev.jsonl');
    } catch (e) {
      noteFailure('jev.jsonl', e);
    }
  }
  await put('config.json', `${JSON.stringify(o.configJson, null, 2)}\n`);
  await put('versions.txt', versionsText({ ...o, launch: o.launch ?? (await readLaunchBlock(fs, o.runDir, readMs)) }));
  // §7.7 item 4: the final README — the marker survives only when a step that should have worked did not
  await write('README.txt', readmeText(o.runId, [...files, 'README.txt'], missing, ISSUES_URL, notes, !complete));
  files.push('README.txt');
  return { dir: o.out, files, missing, notes, bytes, complete };
}

/**
 * TUI-DESIGN-4 §7.7 item 3: the `launch` block, read from the run's own `ui.json` (the renderer snapshot
 * `writeUi()` records at run start), so `report` works offline and after the process is gone. Unparseable or
 * absent → `(unknown)` on every row.
 */
async function readLaunchBlock(fs: ReportFs, runDir: string, readMs: number): Promise<Readonly<Record<string, string | number | boolean | null>> | null> {
  try {
    const parsed: unknown = JSON.parse(await withReadTimeout(fs.readFile(join(runDir, 'ui.json')), 'ui.json', readMs));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const src = parsed as Record<string, unknown>;
    const block: Record<string, string | number | boolean | null> = {};
    for (const k of REPORT_LAUNCH_KEYS) {
      const v = src[k];
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') block[k] = v;
    }
    return Object.keys(block).length > 0 ? block : null;
  } catch {
    return null;
  }
}

/** the CLI command's I/O seam */
export interface ReportIo {
  stdout: { write(s: string): unknown; columns?: number | undefined; rows?: number | undefined };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** `resolveConfig(flags, env, cwd)` — injected so the command is testable without a config chain */
  resolveConfig: (flags: ParsedFlags) => Promise<{ runsDir: string; redact: (s: string) => string; record(): unknown; sandbox: string }>;
  /** default `~/.jevcode/reports` (or `<JEVCODE_HOME>/reports`) */
  reportsDir: string;
  /** §13.6: the session log to copy when the run directory has no `jevcode.log` (`newestSessionLog(<jevcodeDir>/logs)`) */
  sessionLog?: () => Promise<string | null>;
  /** TUI-DESIGN-4 §7.7 item 1: the effective `keybindings.json` (`<jevcodeDir>/keybindings.json`) */
  keybindingsPath?: string | null;
  fs?: ReportFs;
}

/** TUI-DESIGN §13.6: `jevcode report <id> [--out <dir>] [--include-requests]` — prints the bundle directory; exit 0 / 2. */
export async function commandReport(flags: ParsedFlags, io: ReportIo): Promise<number> {
  const runId = flags.runId;
  if (runId === undefined) {
    io.stderr.write('jevcode report needs a run id (jevcode report <id>)\n');
    return EXIT_CODES.config;
  }
  let config: Awaited<ReturnType<ReportIo['resolveConfig']>>;
  try {
    config = await io.resolveConfig(flags);
  } catch (e) {
    io.stderr.write(`jevcode: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_CODES.config;
  }
  const runDir = join(config.runsDir, runId);
  const out = flags.out !== undefined ? flags.out : join(io.reportsDir, runId);
  try {
    const fallbackLog = io.sessionLog ? await io.sessionLog().catch(() => null) : null;
    const r = await writeReportBundle({
      runDir,
      runId,
      out,
      redact: config.redact,
      configJson: { ...(typeof config.record() === 'object' && config.record() !== null ? (config.record() as Record<string, unknown>) : {}), sandboxLevel: config.sandbox },
      term: io.env['TERM'] ?? null,
      termProgram: io.env['TERM_PROGRAM'] ?? null,
      columns: typeof io.stdout.columns === 'number' ? io.stdout.columns : null,
      rows: typeof io.stdout.rows === 'number' ? io.stdout.rows : null,
      // TUI-DESIGN-4 §7.7 item 3: the environment that decides which frame the user was looking at
      env: io.env,
      isTty: typeof io.stdout.columns === 'number',
      ...(flags.includeRequests ? { includeRequests: true } : {}),
      ...(fallbackLog !== null ? { fallbackLog } : {}),
      ...(io.keybindingsPath !== undefined && io.keybindingsPath !== null ? { keybindingsPath: io.keybindingsPath } : {}),
      ...(io.fs ? { fs: io.fs } : {}),
    });
    if (r.missing.includes('run.json')) {
      io.stderr.write(`jevcode report: no run ${runId} under ${config.runsDir} (run.json missing)\n`);
      return EXIT_CODES.config;
    }
    io.stdout.write(`report written to ${r.dir}/ (${r.files.length} files, ${r.bytes} bytes; redacted bundle written locally; nothing is sent)\n`);
    for (const n of r.notes) io.stdout.write(`${n}\n`);
    if (r.missing.length > 0) io.stdout.write(`not available: ${r.missing.join(', ')}\n`);
    if (!r.complete) io.stdout.write(`${BUNDLE_INCOMPLETE_MARKER} — a file the bundle wanted could not be read or written (see README.txt)\n`);
    // TUI-DESIGN-4 §7.7 item 5: the one command that turns the directory into an attachment
    io.stdout.write(`${tarSuggestion(r.dir, runId)}\n`);
    return EXIT_CODES.ok;
  } catch (e) {
    /**
     * TUI-DESIGN-4 §7.7 edge: ENOSPC leaves `(bundle incomplete)` in the README already on disk and exits 3 with
     * §7.4's explanation; anything else keeps today's message and exit 1. The marker is never rewritten here —
     * the placeholder written first **is** the record that the bundle is partial.
     */
    const x = explainFsError(e, { op: 'run-dir', path: out, redact: config.redact });
    if (x !== null) {
      io.stderr.write(`jevcode report: ${x.line}\n`);
      for (const fix of x.fix) io.stderr.write(`  ${fix}\n`);
      io.stderr.write(`the bundle at ${out}/ is marked ${BUNDLE_INCOMPLETE_MARKER}\n`);
      /**
       * §7.4: the condition decides the code — 3 when the bundle cannot be written (a full disk: this run's
       * artefacts are incomplete and no flag fixes that), 2 for a permission or configuration problem on `--out`.
       * Returning 3 for every classified errno told an EACCES the wrong story.
       *
       * §7.7's edge names 3 for ENOSPC, but `explainFsError` (`src/errors.ts`) answers 2 for it, because it
       * classifies an errno without knowing which write failed. The split is made here, where §7.7's edge is the
       * only reader: a disk-full bundle is exit 3, everything else keeps the explanation's own code. It becomes a
       * no-op for this call site the day `explainFsError` takes the context.
       */
      return DISK_FULL_CODES.has(x.code) ? EXIT_CODES.checkpoint : x.exitCode;
    }
    io.stderr.write(`jevcode report: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_CODES.unexpected;
  }
}
