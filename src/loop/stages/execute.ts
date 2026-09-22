/**
 * Execute stage (DESIGN.md §6, §8, §9.1): dispatch by action kind. read through the
 * workspace under the context bounds; edit/write/patch through the Workspace; run through
 * the Sandbox with the clamped timeout; done -> noop. Never throws for action-level errors
 * that are outcomes (the engine maps EditError/PatchError/PathEscapeError to `failed`).
 */
import type { ActionOutcome, ExecResult, KilledBy, Proposal, TestCommand, TestCounts } from '../../core/types.js';
import { isBudgetError } from '../../errors.js';
import { clampCommandTimeout } from '../budget.js';
import { headTail } from '../../core/text.js';
import { joinOutput } from '../window.js';
import type { StageContext } from '../engine.js';
import { parseOutputRef } from '../context/history.js';
import { FILE_VIEW_MAX_CHARS, OUTPUT_READ_PREFIX } from '../context/limits.js';
import { CONTEXT_MAX_FILE_BYTES, CONTEXT_MAX_FILES, CONTEXT_MAX_TOTAL_BYTES } from './context.js';
import { testsAllPassed } from '../state.js';

/** docs/COORDINATION-DESIGN.md §8.3: a `read` of `jevcode:outputs/step-<n>.txt` shows up to 32 KiB (head + tail beyond that). */
const OUTPUT_READ_MAX_CHARS = FILE_VIEW_MAX_CHARS;

export interface ExecuteStageResult {
  outcome: ActionOutcome;
  /** run: stdout + stderr; read: concatenated views; otherwise '' */
  output: string;
  changedFiles: string[];
  /** set when the command was the detected test command */
  tests: { command: string; parsed: TestCounts | null; allPassed: boolean | null } | null;
  /** paths first created by this action (write/patch), for createdThisRun */
  created: string[];
  execMs: number;
}

const SUBCOMMAND_LAUNCHERS: ReadonlySet<string> = new Set(['npm', 'yarn', 'pnpm', 'bun', 'cargo', 'go', 'make']);

/** True when `command` runs the detected test command (same program, e.g. `pytest tests/x.py` for `pytest -q`). */
export function isTestCommand(command: string, test: TestCommand | null): boolean {
  if (!test) return false;
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const c = norm(command);
  const t = norm(test.command);
  if (c === t || c.startsWith(`${t} `)) return true;
  const program = (s: string): string => {
    const toks = s.split(' ');
    // `python -m pytest ...` and `npx vitest ...` name the runner after a launcher.
    if ((toks[0] === 'python' || toks[0] === 'python3') && toks[1] === '-m' && toks[2]) return toks[2];
    if (toks[0] === 'npx' && toks[1]) return toks[1];
    // Package managers and toolchains take a subcommand: `npm run build` is not `npm test`,
    // `cargo build` is not `cargo test`; compare the first two tokens for these.
    if (toks[0] && SUBCOMMAND_LAUNCHERS.has(toks[0]) && toks[1]) return `${toks[0]} ${toks[1]}`;
    return toks[0] ?? '';
  };
  const pc = program(c);
  return pc.length > 0 && pc === program(t);
}

function summariseExec(exec: ExecResult): string {
  if (exec.killedBy === 'timeout') return `timed out after ${Math.round(exec.durationMs / 1000)}s`;
  if (exec.killedBy) return `killed (${exec.killedBy})`;
  return `exit ${exec.exitCode ?? 'null'}`;
}

export async function runExecuteStage(ctx: StageContext, proposal: Proposal): Promise<ExecuteStageResult> {
  const a = proposal.action;
  const t0 = ctx.now();
  const done = (r: Omit<ExecuteStageResult, 'execMs'>): ExecuteStageResult => ({ ...r, execMs: Math.max(0, ctx.now() - t0) });
  ctx.emit({ type: 'exec:start', step: ctx.step, action: a });
  switch (a.kind) {
    case 'done':
      return done({ outcome: { status: 'noop', summary: a.summary }, output: '', changedFiles: [], tests: null, created: [] });
    case 'read': {
      const parts: string[] = [];
      let total = 0;
      const paths = a.paths.slice(0, CONTEXT_MAX_FILES);
      for (const p of paths) {
        // docs/COORDINATION-DESIGN.md §8.3: `jevcode:outputs/step-<n>.txt` is served from the run dir, never from the workspace
        if (p.startsWith(OUTPUT_READ_PREFIX)) {
          const stored = parseOutputRef(p) === null ? null : await ctx.contextReads?.runOutput(p);
          if (stored === null || stored === undefined) parts.push(`### ${p} — no stored output under this name`);
          else {
            const shown = stored.length > OUTPUT_READ_MAX_CHARS ? headTail(stored, OUTPUT_READ_MAX_CHARS - 8_192, 8_000) : stored;
            total += shown.length;
            parts.push(`### ${p} (${stored.length} chars${shown.length < stored.length ? ', head and tail shown' : ''})\n${shown}`);
          }
          continue;
        }
        // §8.4: a file already in view whose stat is unchanged costs no read and no new tokens — the line points at Files in view
        const unchanged = await ctx.contextReads?.unchanged(p);
        if (unchanged !== null && unchanged !== undefined) {
          parts.push(`### ${p}\n${unchanged}`);
          continue;
        }
        const view = await ctx.workspace.read(p, CONTEXT_MAX_FILE_BYTES);
        if (total + view.content.length > CONTEXT_MAX_TOTAL_BYTES) {
          parts.push(`### ${p} (${view.bytes} bytes) — not shown: 60 KB read budget reached`);
          continue;
        }
        total += view.content.length;
        const trunc = view.truncatedBytes > 0 ? `, truncated ${view.truncatedBytes} bytes` : '';
        parts.push(`### ${p} (${view.bytes} bytes${trunc})\n${view.content}`);
      }
      if (a.paths.length > CONTEXT_MAX_FILES) parts.push(`(${a.paths.length - CONTEXT_MAX_FILES} more paths not shown: 12-file limit)`);
      const output = ctx.redact(parts.join('\n'));
      return done({ outcome: { status: 'executed', summary: `read ${paths.length} file(s)`, changedFiles: [] }, output, changedFiles: [], tests: null, created: [] });
    }
    case 'edit': {
      const r = await ctx.workspace.applyEdit(a);
      await ctx.workspace.noteChanged(r.changedFiles);
      return done({ outcome: { status: 'executed', summary: `edit applied to ${a.path} (1 match)`, changedFiles: r.changedFiles }, output: '', changedFiles: r.changedFiles, tests: null, created: [] });
    }
    case 'write': {
      const r = await ctx.workspace.writeFile(a);
      await ctx.workspace.noteChanged(r.changedFiles);
      return done({
        outcome: { status: 'executed', summary: `${r.created ? 'created' : 'overwrote'} ${a.path}`, changedFiles: r.changedFiles },
        output: '',
        changedFiles: r.changedFiles,
        tests: null,
        created: r.created ? [a.path] : [],
      });
    }
    case 'patch': {
      const before = new Set<string>();
      for (const p of ctx.patchTargets) if (!p.existsBefore) before.add(p.path);
      const r = await ctx.workspace.applyPatch(a.diff);
      await ctx.workspace.noteChanged(r.changedFiles);
      const created = r.changedFiles.filter((p) => before.has(p));
      return done({ outcome: { status: 'executed', summary: `patch applied (${r.changedFiles.length} file(s))`, changedFiles: r.changedFiles }, output: '', changedFiles: r.changedFiles, tests: null, created });
    }
    case 'run': {
      const timeoutMs = clampCommandTimeout(a.timeoutMs, ctx.limits, ctx.wallRemainingMs());
      const exec = await ctx.sandbox.run(a.command, {
        timeoutMs,
        maxOutputBytes: ctx.limits.maxOutputBytes,
        signal: ctx.signal,
        onOutput: (stream, chunk) => ctx.emit({ type: 'exec:output', step: ctx.step, stream, chunk: ctx.redact(chunk) }),
      });
      // The sandbox cannot know which abort fired; a wall-time abort is recorded as such (§6).
      const killedBy: KilledBy = exec.killedBy === 'abort' && isBudgetError(ctx.signal.reason) ? 'wall_time' : exec.killedBy;
      const fixed: ExecResult = { ...exec, killedBy, stdout: ctx.redact(exec.stdout), stderr: ctx.redact(exec.stderr), timedOut: killedBy === 'timeout' };
      const output = joinOutput(fixed.stdout, fixed.stderr);
      if (ctx.signal.aborted) {
        return done({ outcome: { status: 'interrupted', exec: fixed }, output, changedFiles: [], tests: null, created: [] });
      }
      const info = ctx.workspaceInfo;
      let tests: ExecuteStageResult['tests'] = null;
      if (info.testCommand && isTestCommand(a.command, info.testCommand)) {
        const parsed = ctx.workspace.parseTestOutput(info.testCommand.runner, output);
        tests = { command: a.command, parsed, allPassed: testsAllPassed(parsed) };
      }
      // Commands may create or delete files: refresh the candidate cache (overlaps the judge request).
      ctx.startCandidateRefresh();
      const changedFiles = await ctx.workspace.changedFiles().catch(() => [] as string[]);
      return done({ outcome: { status: 'executed', exec: fixed, summary: summariseExec(fixed), changedFiles }, output, changedFiles, tests, created: [] });
    }
  }
}
