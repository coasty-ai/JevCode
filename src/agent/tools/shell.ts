/**
 * Read-only `bash` (docs/AGENT-LOOP-DESIGN.md §3.2, §7.2): a command the classifier proved read-only runs inside the
 * driver's observe batch, through the same sandbox as every command but with no pre-images, and its output is rendered
 * and spilled exactly like an executed command's.
 */
import type { AgentContext } from '../../core/types.js';
import { isAbortError } from '../../errors.js';
import { normaliseForSignature } from '../../core/text.js';
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from '../limits.js';
import { oneLine, renderBash } from './format.js';
import { errorResult, type ToolResult } from './result.js';

export interface BashArgs {
  command: string;
  workdir?: string;
  timeout_ms?: number;
  description?: string;
}

/** stdout, then `[stderr]` and stderr — the execute stage's `joinOutput`, so both paths render alike. */
export function joinStreams(stdout: string, stderr: string): string {
  if (stderr.length === 0) return stdout;
  if (stdout.length === 0) return stderr;
  return `${stdout}\n[stderr]\n${stderr}`;
}

/** The command's timeout: `min(timeout_ms ?? 120 s, 600 s, wall remaining)`. */
export function commandTimeout(ctx: AgentContext, timeoutMs: number | undefined): number {
  return Math.max(1, Math.floor(Math.min(timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, ctx.wallRemainingMs())));
}

/** The loop signature's result half for a command: the exit code and the normalised output (§3.6). */
export function bashHashBasis(exitCode: number | null, output: string, root: string): string {
  return `${exitCode ?? 'null'}\n${normaliseForSignature(output, root)}`;
}

/** Run one read-only command. `part` names its spill file when an observe step runs several (`step-N-<part>.txt`). */
export async function runReadonlyBash(ctx: AgentContext, a: BashArgs, part: number | undefined): Promise<ToolResult> {
  const label = `bash ${oneLine(a.command, 60)}`;
  let exec;
  try {
    exec = await ctx.sandbox.run(a.command, {
      timeoutMs: commandTimeout(ctx, a.timeout_ms),
      maxOutputBytes: ctx.limits.maxOutputBytes,
      signal: ctx.signal,
      ...(a.workdir !== undefined ? { cwd: a.workdir } : {}),
    });
  } catch (e) {
    if (isAbortError(e) || ctx.signal.aborted) throw e;
    return errorResult(`ERROR: ${ctx.redact(e instanceof Error ? e.message : String(e))}`, `${label} (error)`);
  }
  const stdout = ctx.redact(exec.stdout);
  const stderr = ctx.redact(exec.stderr);
  const output = joinStreams(stdout, stderr);
  const r = await renderBash({ ...exec, stdout, stderr }, output, { workdir: a.workdir ?? null, tests: null, spill: (text) => ctx.writeOutput(text, part) });
  const tail = exec.killedBy === 'timeout' ? 'timed out' : exec.killedBy !== null ? 'killed' : `exit ${exec.exitCode ?? 'null'}`;
  return { text: r.text, ok: r.ok, summary: `${label} (${tail})`, hashBasis: bashHashBasis(exec.exitCode, output, ctx.workspace.root) };
}
