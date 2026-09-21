/**
 * `jevcode report <id>` and `/report` (TUI-DESIGN §13.6, A168, A169): a redacted support bundle under
 * `~/.jevcode/reports/<run-id>/` — `run.json`, `transcript.log`, `jevcode.log`, the last 20 `steps.jsonl` rows,
 * `config.json` (what `jevcode config --json` prints), `versions.txt` (node, jevcode, ink, TERM/TERM_PROGRAM,
 * rows×cols) and `README.txt` with the issues URL. Everything passes `redact`; `jev.jsonl` request bodies only with
 * `--include-requests`; nothing is sent anywhere. Pure over an injectable file system so the bundle is unit-tested
 * offline.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ParsedFlags } from './args.js';
import { EXIT_CODES } from '../errors.js';
import { VERSION } from '../version.js';

/** TUI-DESIGN §13.6: `steps.jsonl` rows kept in the bundle. */
export const REPORT_STEPS_TAIL = 20;
/** the pinned Ink version (package.json `dependencies.ink`; the bundle inlines it, so no runtime lookup exists) */
export const INK_VERSION = '7.1.1';
/** the pinned React version esbuild inlines beside Ink (`--version --json`, §17 item 3; `versions.txt`) */
export const REACT_VERSION = '19.3.0';
export const ISSUES_URL = 'https://github.com/prateekjannu/jevcode/issues';
/** files copied whole (after `redact`) */
export const REPORT_COPIED_FILES: readonly string[] = ['run.json', 'transcript.log', 'jevcode.log'];

export interface ReportFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

const NODE_FS: ReportFs = {
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, t) => writeFile(p, t, { mode: 0o600 }),
  mkdir: async (p) => {
    await mkdir(p, { recursive: true, mode: 0o700 });
  },
};

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
}

/** TUI-DESIGN §13.6: the `versions.txt` body. */
export function versionsText(o: Pick<ReportBundleOptions, 'term' | 'termProgram' | 'columns' | 'rows' | 'version' | 'inkVersion' | 'nodeVersion' | 'platform'>): string {
  return [
    `jevcode ${o.version ?? VERSION}`,
    `node ${o.nodeVersion ?? process.version}`,
    `ink ${o.inkVersion ?? INK_VERSION}`,
    `react ${REACT_VERSION}`,
    `platform ${o.platform ?? process.platform}`,
    `TERM ${o.term ?? '(unset)'}`,
    `TERM_PROGRAM ${o.termProgram ?? '(unset)'}`,
    `size ${o.rows ?? '?'}×${o.columns ?? '?'}`,
    '',
  ].join('\n');
}

/** TUI-DESIGN §13.6: the `README.txt` body. */
export function readmeText(runId: string, files: readonly string[], missing: readonly string[], issuesUrl = ISSUES_URL, notes: readonly string[] = []): string {
  const lines = [
    `JevCode support bundle for run ${runId}`,
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
 * TUI-DESIGN §13.6 `writeReportBundle`: copy the run's files through `redact` into `out`, add the steps tail, the
 * config JSON, `versions.txt` and `README.txt`. Missing source files are listed, never fatal.
 */
export async function writeReportBundle(o: ReportBundleOptions): Promise<ReportBundleResult> {
  const fs = o.fs ?? NODE_FS;
  const files: string[] = [];
  const missing: string[] = [];
  const notes: string[] = [];
  await fs.mkdir(o.out);
  const put = async (name: string, text: string): Promise<void> => {
    await fs.writeFile(join(o.out, name), o.redact(text));
    files.push(name);
  };
  for (const name of REPORT_COPIED_FILES) {
    try {
      await put(name, await fs.readFile(join(o.runDir, name)));
    } catch {
      // §13.6: the session log stands in for a run directory without jevcode.log
      if (name === 'jevcode.log' && o.fallbackLog !== undefined && o.fallbackLog !== null) {
        try {
          await put(name, await fs.readFile(o.fallbackLog));
          notes.push(`jevcode.log: copied from the session log ${o.fallbackLog} (the run directory had none)`);
          continue;
        } catch {
          /* the fallback is missing too */
        }
      }
      missing.push(name);
    }
  }
  try {
    const steps = await fs.readFile(join(o.runDir, 'steps.jsonl'));
    await put('steps.tail.jsonl', `${tailLines(steps, o.stepsTail ?? REPORT_STEPS_TAIL).join('\n')}\n`);
  } catch {
    missing.push('steps.jsonl');
  }
  if (o.includeRequests === true) {
    try {
      await put('jev.jsonl', await fs.readFile(join(o.runDir, 'jev.jsonl')));
    } catch {
      missing.push('jev.jsonl');
    }
  }
  await put('config.json', `${JSON.stringify(o.configJson, null, 2)}\n`);
  await put('versions.txt', versionsText(o));
  await fs.writeFile(join(o.out, 'README.txt'), readmeText(o.runId, [...files, 'README.txt'], missing, ISSUES_URL, notes));
  files.push('README.txt');
  return { dir: o.out, files, missing, notes };
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
      ...(flags.includeRequests ? { includeRequests: true } : {}),
      ...(fallbackLog !== null ? { fallbackLog } : {}),
      ...(io.fs ? { fs: io.fs } : {}),
    });
    if (r.missing.includes('run.json')) {
      io.stderr.write(`jevcode report: no run ${runId} under ${config.runsDir} (run.json missing)\n`);
      return EXIT_CODES.config;
    }
    io.stdout.write(`report written to ${r.dir}/ (${r.files.length} files; redacted bundle written locally; nothing is sent)\n`);
    for (const n of r.notes) io.stdout.write(`${n}\n`);
    if (r.missing.length > 0) io.stdout.write(`not available: ${r.missing.join(', ')}\n`);
    return EXIT_CODES.ok;
  } catch (e) {
    io.stderr.write(`jevcode report: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_CODES.unexpected;
  }
}
