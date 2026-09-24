/**
 * Resolving the calls of a turn (docs/AGENT-LOOP-DESIGN.md §3.2, §4, §12).
 *
 * Every call gets a disposition, in call order, at the moment it is reached:
 *
 *  - resolvable — `read_file`, `grep`, `glob`, `todo_write`, a `bash` command the classifier proves read-only, and any
 *    call rejected before it touched the workspace (invalid arguments, an unknown tool, an `edit_file` with no or an
 *    ambiguous match, a secret or out-of-workspace path, a placeholder, a write into `.git`). These run inside the driver,
 *    in parallel batches, and form an `observe` step.
 *  - mutating — a matched `edit_file`, a `write_file`, any other `bash` command: exactly one per `act` step, executed by
 *    the engine's shared tail (pre-images, execute, post-images), then reported back through `observe()`.
 *
 * Under full autonomy nothing is refused or asked (§A2); a destructive command carries its truthful note in the gate.
 * Under review, destructive and unknown commands get the human's card.
 */
import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Action, AgentContext, AgentGate, AgentObservation, AgentToolName } from '../core/types.js';
import { sha12 } from '../core/hash.js';
import { PRE_IMAGE_MAX_FILES, PRE_IMAGE_MAX_TOTAL_BYTES } from '../checkpoint/images.js';
import { AGENT_FILE_MAX_BYTES, DEFAULT_COMMAND_TIMEOUT_MS } from './limits.js';
import { blockedResult, declinedResult, unknownTool } from './prompt.js';
import { ignoredLine, type NormalisedCall } from './repair.js';
import { classifyCommand, commandGate, destructiveNote, type CommandVerdict, type DestructiveRule } from './safety.js';
import { syntaxCheck, syntaxCheckBlock } from './tools/check.js';
import { editResultLine, matchEdit, placeholderLine } from './tools/edit-match.js';
import { oneLine, renderBash } from './tools/format.js';
import { runReadFile, type ReadArgs, type ReadHashes } from './tools/read.js';
import { accessError, errorResult, hasRedactionMarker, isBinary, rootNameHint, type ToolResult } from './tools/result.js';
import { runGlob, runGrep, type GlobArgs, type GrepArgs } from './tools/search.js';
import { bashHashBasis, runReadonlyBash } from './tools/shell.js';
import { todoWrite, type Todo } from './tools/todo.js';
import { FileNotFoundError, isAbortError, isBudgetError } from '../errors.js';

export interface CallEnv {
  ctx: AgentContext;
  /** the tools this run offered (a research child gets no write_file / edit_file, §4.1) */
  tools: readonly AgentToolName[];
  readHashes: ReadHashes;
  rg: (ctx: AgentContext) => Promise<boolean>;
  setTodos: (todos: Todo[]) => void;
}

/** A mutating call, prepared: the engine action, its gate, and what `observe()` needs to report it. */
export interface PreparedAct {
  call: NormalisedCall;
  tool: 'edit_file' | 'write_file' | 'bash';
  action: Extract<Action, { kind: 'edit' | 'write' | 'run' }>;
  gate: AgentGate;
  /** `edit_file src/a.ts`, `bash npm test` */
  goal: string;
  path: string | null;
  /** the file before the change (null: a new file) and after it, for the syntax check */
  before: string | null;
  after: string | null;
  /** the `OK: edited …` line, prepared when the span was matched */
  editLine: string | null;
  stale: boolean;
  command: string | null;
  workdir: string | null;
  rule: DestructiveRule | null;
}

export type Disposition =
  | { kind: 'resolve'; name: AgentToolName | 'invalid'; callSummary: string; run: (part: number | undefined) => Promise<ToolResult> }
  | { kind: 'act'; act: PreparedAct };

/** The one-line summary of a call before it runs (`tool:call`). */
export function callSummary(c: NormalisedCall): string {
  const a = c.args;
  const s = (k: string): string => (typeof a[k] === 'string' ? oneLine(a[k], 80) : '');
  if (c.error !== null) return `${oneLine(c.rawName, 40)} (invalid)`;
  switch (c.name) {
    case 'read_file':
      return `read_file ${c.paths !== undefined ? c.paths.join(', ') : s('path')}`;
    case 'grep':
      return `grep ${JSON.stringify(oneLine(s('pattern'), 50))}${typeof a['path'] === 'string' ? ` in ${s('path')}` : ''}`;
    case 'glob':
      return `glob ${s('pattern')}`;
    case 'bash':
      return `bash ${oneLine(s('command'), 60)}`;
    case 'todo_write':
      return 'todo_write';
    default:
      return `${c.name} ${s('path')}`;
  }
}

/** `text` with one more line, when there is one (the `(ignored unknown arguments: …)` line, §4.4 step 4). */
function withLine(text: string, line: string | null): string {
  return line === null ? text : `${text}\n${line}`;
}

function withIgnored(r: ToolResult, ignored: readonly string[]): ToolResult {
  return { ...r, text: withLine(r.text, ignoredLine(ignored)) };
}

function resolved(c: NormalisedCall, run: (part: number | undefined) => Promise<ToolResult>): Disposition {
  return { kind: 'resolve', name: c.name, callSummary: callSummary(c), run: async (part) => withIgnored(await run(part), c.ignored) };
}

function rejected(c: NormalisedCall, text: string): Disposition {
  return resolved(c, async () => errorResult(text, `${callSummary(c)} (rejected)`));
}

/** The run's own stop (a pause, `/stop`, a budget) travels up; anything else a tool throws is the tool's failure. */
function rethrowRunStop(ctx: AgentContext, e: unknown): void {
  if (isAbortError(e) || isBudgetError(e) || ctx.signal.aborted) throw e;
}

function failureText(ctx: AgentContext, e: unknown): string {
  return `ERROR: ${ctx.redact(e instanceof Error ? e.message : String(e))}`;
}

/** §3.5: a call whose preparation threw (an unreadable file, a sandbox failure) is an error result, never a failed step. */
export function failedDisposition(ctx: AgentContext, c: NormalisedCall, e: unknown): Disposition {
  rethrowRunStop(ctx, e);
  return rejected(c, failureText(ctx, e));
}

/** §3.5: a resolvable call that threw while running is an error result, never a failed step. */
export function failedResult(ctx: AgentContext, summary: string, e: unknown): ToolResult {
  rethrowRunStop(ctx, e);
  return errorResult(failureText(ctx, e), `${summary} (error)`);
}

const redactedRewrite = (path: string): string =>
  `ERROR: ${path} contains text the harness redacts, so edit_file cannot rewrite the whole file safely; edit each occurrence with its own edit_file call and a unique old_string`;

const inGit = (path: string): boolean => /^(\.\/)*\.git(\/|$)/.test(path);
const GIT_INTERNALS = (path: string): string => `ERROR: ${path} is inside .git; the harness never writes there (rule git_internals)`;

/** The classifier context of a command in this run. */
function classifyContext(ctx: AgentContext, workdir: string | null): Parameters<typeof classifyCommand>[1] {
  return { root: ctx.workspace.root, workdir, home: homedir(), tmpdir: join(ctx.runDir, 'tmp'), dirtyAtStart: ctx.dirtyAtStart, testCommand: ctx.workspaceInfo.testCommand };
}

/**
 * §A5: a `git_discard` of tracked files is covered by the dirty-set pre-images when every dirty file is listed and the set
 * is within the copy caps (200 files, 16 MiB). The set the step copies is the dirty set now — the run's own changes
 * included — not only the run-start one. Everything else is not provably covered.
 */
async function preImagesCover(ctx: AgentContext, v: CommandVerdict): Promise<boolean> {
  if (v.rule !== 'git_discard' || v.discard !== 'tracked') return false;
  const dirty = ctx.workspace.dirtySet?.() ?? ctx.dirtyAtStart;
  if (dirty.size > PRE_IMAGE_MAX_FILES) return false;
  const sizes = new Map((await ctx.workspace.listCandidates()).map((c) => [c.path, c.bytes]));
  let bytes = 0;
  for (const p of dirty) {
    const b = sizes.get(p);
    if (b === undefined) return false;
    bytes += b;
  }
  return bytes <= PRE_IMAGE_MAX_TOTAL_BYTES;
}

/** A workspace-relative directory that exists: on disk, or (a directory the disk does not show yet) in the candidate list. */
async function isWorkspaceDir(ctx: AgentContext, rel: string): Promise<boolean> {
  if (await stat(join(ctx.workspace.root, rel)).then((st) => st.isDirectory(), () => false)) return true;
  return (await ctx.workspace.listCandidates()).some((f) => f.path.startsWith(`${rel}/`));
}

/**
 * The directory a bash call runs in (null: the root), or the model-facing error. glm-5.3-flash passes the root's own name as
 * the workdir (`workdir: "demo"` in `…/demo`, three S6 live runs of 2026-09-23), and every command failed as
 * `spawn … ENOENT`: when no such directory exists, the root's name means the root and `<root>/sub` means `sub` (§4.4 repair,
 * like an absolute path inside the workspace). Anything else that is not a directory is an error that names it.
 */
async function resolveWorkdir(ctx: AgentContext, workdir: string): Promise<{ workdir: string | null } | { error: string }> {
  if (await isWorkspaceDir(ctx, workdir)) return { workdir };
  const name = basename(ctx.workspace.root);
  if (workdir === name) return { workdir: null };
  if (workdir.startsWith(`${name}/`) && (await isWorkspaceDir(ctx, workdir.slice(name.length + 1)))) return { workdir: workdir.slice(name.length + 1) };
  return { error: `ERROR: workdir "${workdir}" is not a directory in the workspace` };
}

async function bashDisposition(env: CallEnv, c: NormalisedCall): Promise<Disposition> {
  const { ctx } = env;
  const command = String(c.args['command']);
  const asked = typeof c.args['workdir'] === 'string' ? c.args['workdir'] : null;
  const wd = asked === null ? { workdir: null } : await resolveWorkdir(ctx, asked);
  if ('error' in wd) return rejected(c, wd.error);
  const workdir = wd.workdir;
  const timeoutMs = typeof c.args['timeout_ms'] === 'number' ? c.args['timeout_ms'] : undefined;
  const v = classifyCommand(command, classifyContext(ctx, workdir));
  if (v.class === 'readonly') {
    return resolved(c, (part) => runReadonlyBash(ctx, { command, ...(workdir !== null ? { workdir } : {}), ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}) }, part));
  }
  const note = v.class === 'destructive' && v.rule !== null && ctx.autonomy === 'full' ? destructiveNote(command, v.rule, await preImagesCover(ctx, v)) : null;
  return {
    kind: 'act',
    act: {
      call: c,
      tool: 'bash',
      action: { kind: 'run', command, timeoutMs: timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, ...(workdir !== null ? { cwd: workdir } : {}) },
      gate: commandGate(v, ctx.autonomy, note),
      goal: `bash ${oneLine(command, 80)}`,
      path: null,
      before: null,
      after: null,
      editLine: null,
      stale: false,
      command,
      workdir,
      rule: v.rule,
    },
  };
}

/** Read the target of an edit/write: its content, null for a new file, or the model-facing error. */
async function readTarget(ctx: AgentContext, path: string): Promise<{ content: string | null; truncated: boolean } | { error: string }> {
  try {
    const v = await ctx.workspace.read(path, AGENT_FILE_MAX_BYTES);
    return { content: v.content, truncated: v.truncatedBytes > 0 };
  } catch (e) {
    if (e instanceof FileNotFoundError) return { content: null, truncated: false };
    const text = accessError(path, e);
    if (text === null) throw e;
    return { error: text };
  }
}

async function writeDisposition(env: CallEnv, c: NormalisedCall): Promise<Disposition> {
  const path = String(c.args['path']);
  const content = String(c.args['content']);
  if (inGit(path)) return rejected(c, GIT_INTERNALS(path));
  const placeholder = placeholderLine(content);
  if (placeholder !== null) return rejected(c, `ERROR: content contains a placeholder ("${placeholder}"); write the complete file`);
  const target = await readTarget(env.ctx, path);
  if ('error' in target) return rejected(c, target.error);
  return {
    kind: 'act',
    act: { call: c, tool: 'write_file', action: { kind: 'write', path, content }, gate: { verdict: 'ok', reason: '', rule: null }, goal: `write_file ${path}`, path, before: target.content, after: content, editLine: null, stale: false, command: null, workdir: null, rule: null },
  };
}

async function editDisposition(env: CallEnv, c: NormalisedCall): Promise<Disposition> {
  const path = String(c.args['path']);
  if (inGit(path)) return rejected(c, GIT_INTERNALS(path));
  const target = await readTarget(env.ctx, path);
  if ('error' in target) return rejected(c, target.error);
  if (target.content === null) return rejected(c, `ERROR: ${path}: no such file${rootNameHint(env.ctx.workspace.root, path) || ' (use write_file to create it)'}`);
  if (isBinary(target.content)) return rejected(c, `ERROR: ${path} is binary; edit_file edits text files`);
  if (target.truncated) return rejected(c, `ERROR: ${path} is larger than 1 MiB; edit_file cannot edit it safely (use a narrower tool through bash)`);
  const m = matchEdit(target.content, { path, oldString: String(c.args['old_string']), newString: String(c.args['new_string']), replaceAll: c.args['replace_all'] === true });
  if (!m.ok) return rejected(c, m.error);
  // the view is redacted (Workspace.read): a whole-file write built from it would put the markers on disk in place of the
  // user's values. A single exact edit is safe — the engine matches it against the real file and fails on a marker.
  if (m.action.kind === 'write' && hasRedactionMarker(target.content)) return rejected(c, redactedRewrite(path));
  const lastRead = env.readHashes.get(path);
  return {
    kind: 'act',
    act: {
      call: c,
      tool: 'edit_file',
      action: m.action.kind === 'edit' ? { kind: 'edit', path, old: m.action.old, new: m.action.new } : { kind: 'write', path, content: m.action.content },
      gate: { verdict: 'ok', reason: '', rule: null },
      goal: `edit_file ${path}`,
      path,
      before: target.content,
      after: m.newContent,
      editLine: editResultLine(path, m),
      stale: lastRead !== undefined && lastRead !== sha12(target.content),
      command: null,
      workdir: null,
      rule: null,
    },
  };
}

/**
 * A validated call's arguments in the executor's shape. `validateArgs` (tools/specs.ts) already proved every member
 * against the tool's exact schema — types, bounds, no unknown keys — so this is a view, not a conversion.
 */
function argsOf<T>(c: NormalisedCall): T {
  return c.args as unknown as T;
}

/** §3.2: the disposition of one call, computed when the call is reached (a preceding edit may have changed its file). */
export async function dispose(env: CallEnv, c: NormalisedCall): Promise<Disposition> {
  const { ctx } = env;
  // a tool the run did not offer (a research child's write_file, even under an alias or as leaked XML) does not exist here
  const offered = c.name !== 'invalid' && env.tools.includes(c.name);
  if (!offered) return rejected(c, unknownTool(c.rawName, env.tools));
  if (c.error !== null) return rejected(c, c.error);
  switch (c.name) {
    case 'read_file':
      return resolved(c, () => runReadFile(ctx, argsOf<ReadArgs>(c), c.paths, env.readHashes));
    case 'grep':
      return resolved(c, () => runGrep(ctx, argsOf<GrepArgs>(c), env.rg));
    case 'glob':
      return resolved(c, () => runGlob(ctx, argsOf<GlobArgs>(c)));
    case 'todo_write':
      return resolved(c, async () => {
        const r = todoWrite(c.args['todos'] ?? null);
        if (r.ok) env.setTodos(r.todos);
        return { text: r.text, ok: r.ok, summary: r.summary, hashBasis: null };
      });
    case 'bash':
      return bashDisposition(env, c);
    case 'write_file':
      return writeDisposition(env, c);
    case 'edit_file':
      return editDisposition(env, c);
    default:
      return rejected(c, `ERROR: ${c.rawName} cannot run`);
  }
}

// ---------------------------------------------------------------------------------------
// Reporting a mutating call after the engine ran it (§3.4, §4.3)
// ---------------------------------------------------------------------------------------

export interface ActReport extends ToolResult {
  /** blocked or declined: nothing ran (the loop signature's `refused`) */
  refused: boolean;
  /** a failing run of the detected test command (the signature is its failing set) */
  failingTest: boolean;
}

function lineCount(s: string): number {
  if (s.length === 0) return 0;
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}

/** Render the result of an executed `act` step for the model, with the call's `(ignored unknown arguments: …)` line. */
export async function reportAct(ctx: AgentContext, act: PreparedAct, o: AgentObservation): Promise<ActReport> {
  const r = await renderAct(ctx, act, o);
  return { ...r, text: withLine(r.text, ignoredLine(act.call.ignored)) };
}

async function renderAct(ctx: AgentContext, act: PreparedAct, o: AgentObservation): Promise<ActReport> {
  const base = { refused: false, failingTest: false };
  const out = o.outcome;
  if (out.status === 'blocked') {
    const text = blockedResult(act.gate.rule ?? 'policy', ctx.redact(out.reason));
    return { ...base, text, ok: false, summary: `${act.goal} (blocked)`, hashBasis: 'refused', refused: true };
  }
  if (out.status === 'declined') {
    return { ...base, text: declinedResult(ctx.redact(out.reason), null), ok: false, summary: `${act.goal} (declined)`, hashBasis: 'refused', refused: true };
  }
  if (out.status === 'failed') {
    const text = `ERROR: ${ctx.redact(o.error?.message ?? out.error)}`;
    return { ...base, text, ok: false, summary: `${act.goal} (failed)`, hashBasis: text };
  }
  if (act.tool === 'bash') {
    const exec = 'exec' in out && out.exec !== undefined ? out.exec : null;
    if (exec === null) {
      const text = out.status === 'interrupted' ? 'interrupted' : `ran (no exit status was reported)\n${o.output.length > 0 ? o.output : '(no output)'}`;
      return { ...base, text, ok: out.status !== 'interrupted', summary: `${act.goal} (${out.status})`, hashBasis: text };
    }
    const r = await renderBash(exec, o.output, { workdir: act.workdir, tests: o.tests?.parsed ?? null, interrupted: out.status === 'interrupted', spill: (text) => ctx.writeOutput(text) });
    const tail = exec.killedBy === 'timeout' ? 'timed out' : exec.killedBy !== null ? 'killed' : `exit ${exec.exitCode ?? 'null'}`;
    const failingTest = o.tests !== null && !r.ok;
    return { ...base, text: r.text, ok: r.ok, summary: `${act.goal} (${tail})`, hashBasis: bashHashBasis(exec.exitCode, o.output, ctx.workspace.root), failingTest, ...(r.pointer !== null ? { pointer: r.pointer } : {}) };
  }
  if (out.status === 'interrupted') return { ...base, text: 'interrupted', ok: false, summary: `${act.goal} (interrupted)`, hashBasis: 'interrupted' };
  const path = act.path ?? '';
  const lines: string[] = [];
  if (act.tool === 'edit_file') lines.push(act.editLine ?? `OK: edited ${path}`);
  else lines.push(`OK: ${act.before === null ? 'created' : 'overwrote'} ${path} (${lineCount(act.after ?? '')} lines)`);
  if (act.stale) lines[0] = `${lines[0]} (note: ${path} changed since you last read it)`;
  if (act.after !== null) {
    const block = syntaxCheckBlock(await syntaxCheck(ctx, path, act.before, act.after));
    if (block !== null) lines.push(block);
  }
  const text = lines.join('\n');
  return { ...base, text, ok: true, summary: act.goal, hashBasis: text };
}

/** Whether an executed act changed files in a way that needs verification (§3.4). */
export function changesWorkspace(act: PreparedAct, o: AgentObservation, testCommandRun: boolean): boolean {
  if (o.outcome.status !== 'executed') return false;
  if (act.tool !== 'bash') return true;
  return o.changedFiles.length > 0 && !testCommandRun;
}

