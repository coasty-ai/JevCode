/**
 * `jevcode sessions [list|reindex|prune|unlock <id>]` (TUI-DESIGN §1, §8.2 P11, §8.5): the CLI twins of the picker
 * and the index's repair paths. `list` prints the picker rows of this workspace (`--json`: the folded `SessionRow`s),
 * `reindex` rebuilds `sessions/index.jsonl` from every `run.json`, `prune` rebuilds it and reports the runs whose
 * directory is gone, `unlock <id>` removes a `run.lock` left behind by a dead process. Pure over an injected I/O
 * seam; nothing here starts an engine.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ParsedFlags } from './args.js';
import { EXIT_CODES } from '../errors.js';
import { readIndex, reindex, splitIndexText, foldIndex } from '../session/index.js';
import { lockInUseMessage, readRunLock, releaseRunLock, isPidAlive } from '../session/lock.js';
import { noSessionMessage, pickerHeader, pickerRows } from '../session/picker-lines.js';

export interface SessionsIo {
  stdout: { write(s: string): unknown; columns?: number | undefined };
  stderr: { write(s: string): unknown };
  runsDir: string;
  /** `<jevcodeDir>/sessions/index.jsonl` */
  indexPath: string;
  /** the workspace realpath the rows are filtered to */
  workspace: string;
  redact: (s: string) => string;
  now?: () => number;
  ascii?: boolean;
  /** `process.kill(pid, 0)` stand-in for `unlock` */
  isAlive?: (pid: number) => boolean;
  /** the file reader behind `prune` (default `fs/promises.readFile`) */
  readIndexText?: (path: string) => Promise<string>;
}

/** TUI-DESIGN §8.2: `sessions list` — picker rows of this workspace (`--json`: the fold). */
export async function sessionsList(flags: ParsedFlags, io: SessionsIo): Promise<number> {
  const r = await readIndex(io.indexPath);
  if (r.error) io.stderr.write(`jevcode sessions: ${r.error}\n`);
  if (flags.json) {
    io.stdout.write(`${JSON.stringify({ sessions: r.sessions, skipped: r.skipped }, null, 2)}\n`);
    return EXIT_CODES.ok;
  }
  const columns = typeof io.stdout.columns === 'number' && io.stdout.columns > 0 ? io.stdout.columns : 80;
  const rows = pickerRows(r.sessions, { workspace: io.workspace, widened: true, nowMs: io.now?.() ?? Date.now(), columns, ascii: io.ascii === true });
  if (rows.length === 0) {
    io.stdout.write(`${noSessionMessage(io.workspace)}\n`);
    if (!existsSync(io.indexPath) && (await runDirCount(io.runsDir)) > 0) io.stdout.write("the index is missing but runs exist: run 'jevcode sessions reindex'\n");
    return EXIT_CODES.ok;
  }
  io.stdout.write(`${pickerHeader({ workspace: io.workspace, widened: true, columns, ascii: io.ascii === true })}\n${rows.join('\n')}\n`);
  return EXIT_CODES.ok;
}

async function runDirCount(runsDir: string): Promise<number> {
  try {
    return (await readdir(runsDir)).filter((n) => /^\d{8}-\d{6}-[a-z2-7]{8}$/.test(n)).length;
  } catch {
    return 0;
  }
}

/** TUI-DESIGN §8.2 (P11): `sessions reindex` — rebuild the index from `run.json` files. */
export async function sessionsReindex(io: SessionsIo): Promise<number> {
  try {
    const r = await reindex(io.runsDir, io.indexPath, { redact: io.redact });
    io.stdout.write(`reindexed ${r.runs} run${r.runs === 1 ? '' : 's'} into ${io.indexPath}${r.skipped > 0 ? ` (${r.skipped} unreadable run dir${r.skipped === 1 ? '' : 's'} skipped)` : ''}\n`);
    return EXIT_CODES.ok;
  } catch (e) {
    io.stderr.write(`jevcode sessions reindex: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_CODES.unexpected;
  }
}

/**
 * `sessions prune`: rebuild the index from the run directories that still exist and report the runs the old index
 * named whose directory is gone (a run dir moved to `~/.jevcode/trash/` by the picker, or deleted by hand).
 */
export async function sessionsPrune(io: SessionsIo): Promise<number> {
  let before = 0;
  let gone = 0;
  try {
    const read = io.readIndexText ?? ((p: string) => import('node:fs/promises').then((m) => m.readFile(p, 'utf8')));
    const text = await read(io.indexPath).catch(() => '');
    const fold = foldIndex(splitIndexText(text));
    for (const s of fold.sessions.values()) {
      for (const r of s.runs) {
        before += 1;
        if (!existsSync(join(io.runsDir, r.runId))) gone += 1;
      }
    }
  } catch {
    before = 0;
  }
  const code = await sessionsReindex(io);
  if (code !== EXIT_CODES.ok) return code;
  io.stdout.write(`pruned ${gone} of ${before} indexed run${before === 1 ? '' : 's'} whose directory is gone\n`);
  return EXIT_CODES.ok;
}

/** TUI-DESIGN §8.5: `sessions unlock <id>` — remove a stale `run.lock`; a live lock (same host, pid alive) is refused with the §24 message. */
export function sessionsUnlock(runId: string, io: SessionsIo): number {
  const runDir = join(io.runsDir, runId);
  if (!existsSync(join(runDir, 'run.json'))) {
    io.stderr.write(`jevcode sessions unlock: no run ${runId} under ${io.runsDir}\n`);
    return EXIT_CODES.config;
  }
  const lock = readRunLock(runDir);
  if (lock === null) {
    io.stdout.write(`run ${runId} has no run.lock\n`);
    return EXIT_CODES.ok;
  }
  const alive = io.isAlive ?? ((pid: number) => isPidAlive(pid));
  if (alive(lock.pid)) {
    io.stderr.write(`jevcode sessions unlock: ${lockInUseMessage(runId, lock)} (pid ${lock.pid} is alive; not removed)\n`);
    return EXIT_CODES.config;
  }
  releaseRunLock(runDir);
  io.stdout.write(`removed run.lock of ${runId} (pid ${lock.pid} is gone)\n`);
  return EXIT_CODES.ok;
}

/** TUI-DESIGN §1: the `sessions` command dispatcher. */
export async function commandSessions(flags: ParsedFlags, io: SessionsIo): Promise<number> {
  switch (flags.sessionsOp ?? 'list') {
    case 'list':
      return sessionsList(flags, io);
    case 'reindex':
      return sessionsReindex(io);
    case 'prune':
      return sessionsPrune(io);
    case 'unlock':
      if (flags.runId === undefined) {
        io.stderr.write('jevcode sessions unlock needs a run id\n');
        return EXIT_CODES.config;
      }
      return sessionsUnlock(flags.runId, io);
  }
}
