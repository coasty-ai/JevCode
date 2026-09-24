/**
 * Execute stage (DESIGN.md §6, §8, §9.1): dispatch by action kind. read through the
 * workspace under the context bounds; edit/write/patch through the Workspace; run through
 * the Sandbox with the clamped timeout; done -> noop. Never throws for action-level errors
 * that are outcomes (the engine maps EditError/PatchError/PathEscapeError to `failed`).
 */
import type { ActionOutcome, ExecResult, KilledBy, Proposal, TestCounts } from '../../core/types.js';
import { isBudgetError } from '../../errors.js';
import { clampCommandTimeout } from '../budget.js';
import { headTail } from '../../core/text.js';
import { joinOutput } from '../window.js';
import type { StageContext } from '../engine.js';
import { parseOutputRef } from '../context/history.js';
// docs/COORDINATION-DESIGN.md §8.5: the read caps rise with the relaxed context (16 files / 32 KiB / 128 KiB, `core/limits.ts`)
import { OUTPUT_READ_PREFIX, READ_MAX_FILES, READ_MAX_FILE_CHARS, READ_MAX_TOTAL_CHARS } from '../../core/limits.js';
import { testsAllPassed } from '../state.js';
import { isTestCommand } from '../../workspace/tests.js';

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
      const paths = a.paths.slice(0, READ_MAX_FILES);
      const budgetLine = (p: string, size: string): string => `### ${p} (${size}) — not shown: the ${Math.round(READ_MAX_TOTAL_CHARS / 1024)} KB read budget for this step is spent; read it alone on the next step`;
      for (const p of paths) {
        // docs/COORDINATION-DESIGN.md §8.3: `jevcode:outputs/step-<n>.txt` is served from the run dir, never from the workspace
        if (p.startsWith(OUTPUT_READ_PREFIX)) {
          const stored = parseOutputRef(p) === null ? null : await ctx.contextReads?.runOutput(p);
          if (stored === null || stored === undefined) {
            parts.push(`### ${p} — no stored output under this name`);
            continue;
          }
          const shown = stored.length > READ_MAX_FILE_CHARS ? headTail(stored, READ_MAX_FILE_CHARS - 8_192, 8_000) : stored;
          // review D4: the same budget guard as the workspace branch — 14 `jevcode:` paths used to return 392 KB in one step
          if (total + shown.length > READ_MAX_TOTAL_CHARS) {
            parts.push(budgetLine(p, `${stored.length} chars`));
            continue;
          }
          total += shown.length;
          const clipped = shown.length < stored.length ? `, head and tail shown; the whole ${stored.length} chars stay at ${p}` : '';
          parts.push(`### ${p} (${stored.length} chars${clipped})\n${shown}`);
          continue;
        }
        // §8.4: a file already in view, rendered whole and unchanged, costs no read and no new tokens
        const unchanged = await ctx.contextReads?.unchanged(p);
        if (unchanged !== null && unchanged !== undefined) {
          parts.push(`### ${p}\n${unchanged}`);
          continue;
        }
        // §8.4 / review D1: in view but shown as a window → the NEXT window, so the tail is reachable and the step differs
        const next = await ctx.contextReads?.nextWindow(p);
        if (next !== null && next !== undefined) {
          if (total + next.length > READ_MAX_TOTAL_CHARS) {
            parts.push(budgetLine(p, 'next window'));
            continue;
          }
          total += next.length;
          parts.push(`### ${p}\n${next}`);
          continue;
        }
        const view = await ctx.workspace.read(p, READ_MAX_FILE_CHARS);
        if (total + view.content.length > READ_MAX_TOTAL_CHARS) {
          parts.push(budgetLine(p, `${view.bytes} bytes`));
          continue;
        }
        total += view.content.length;
        const trunc = view.truncatedBytes > 0 ? `, ${view.truncatedBytes} more bytes not shown; read ${p} again for the next window` : '';
        parts.push(`### ${p} (${view.bytes} bytes${trunc})\n${view.content}`);
      }
      if (a.paths.length > READ_MAX_FILES) parts.push(`(${a.paths.length - READ_MAX_FILES} more paths not shown: the ${READ_MAX_FILES}-file limit; read them on the next step)`);
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
        // docs/AGENT-LOOP-DESIGN.md §3.2: an agent `bash` call's validated `workdir` (workspace-relative; the sandbox resolves and
        // contains it). Absent for the root and on every legacy action, so their sandbox options are unchanged.
        ...(a.cwd !== undefined ? { cwd: a.cwd } : {}),
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
