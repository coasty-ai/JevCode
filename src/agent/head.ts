/**
 * The head of a fresh run (docs/AGENT-LOOP-DESIGN.md §5.3, §7.6): what the model reads before its first turn.
 *
 *  - With an agent parent in the session, the parent's transcript is carried: its records up to the parent checkpoint's
 *    `transcriptSeq` are copied behind a `carry` record, calls it never ran are answered `NOT_EXECUTED_RUN_ENDED`, its
 *    reasoning state is kept only when the system prompt, provider and model are unchanged, and the continuation
 *    message (`# Since the last run` … `# New task`) follows. The provider cache stays warm across runs.
 *  - Otherwise the first user message: the conversation so far (the session's chat turns), the task, a deterministic
 *    workspace block (no model-ranked file list: the uncommitted-changes line is printed only when there is signal), the
 *    legacy parent's "Previous run" block from the `EngineSeed`, and the pinned files.
 *
 * Every fact comes from what the engine already has — the cached candidates, the run-start git probe, the detected test
 * command — so building it spawns nothing (§A1: nothing slow before the first request).
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { AgentContext, Candidate, GitState, Json, JsonObject, TestCommand, UndoLogEntry } from '../core/types.js';
import { clip } from '../core/text.js';
import {
  AGENT_CHAT_CARRY_CHARS,
  AGENT_CHAT_CARRY_TURNS,
  AGENT_DIRTY_PATHS_SHOWN,
  AGENT_PINNED_FILE_BYTES,
  AGENT_PINNED_FILES,
  AGENT_SEED_TASK_CHARS,
  AGENT_TOP_LEVEL_ENTRIES,
} from './limits.js';
import { notExecutedRunEnded } from './prompt.js';
import { parseState, type AgentStateV1 } from './state.js';
import { readTranscript, transcriptPath, withoutProviderState, type TranscriptRecord } from './transcript.js';

// ---------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------

/** The session's chat turns, newest AGENT_CHAT_CARRY_TURNS within AGENT_CHAT_CARRY_CHARS, oldest first. */
export function chatLines(chat: readonly { role: 'you' | 'jevcode'; text: string }[]): string[] {
  const kept: string[] = [];
  let chars = 0;
  for (let i = chat.length - 1; i >= 0 && kept.length < AGENT_CHAT_CARRY_TURNS; i -= 1) {
    const t = chat[i]!;
    const line = `[${t.role}] ${t.text.trim()}`;
    if (chars + line.length > AGENT_CHAT_CARRY_CHARS) break;
    kept.unshift(line);
    chars += line.length + 1;
  }
  return kept;
}

function undoLines(log: readonly UndoLogEntry[] | undefined): string | null {
  if (log === undefined || log.length === 0) return null;
  return log.map((u) => `step ${u.step} (${u.by}: ${u.restored.length > 0 ? u.restored.slice(0, 5).join(', ') : 'nothing restored'})`).join('; ');
}

function gitLine(g: GitState | null, isRepo: boolean): string {
  if (g === null || !g.repo) return isRepo ? 'git repository' : 'not a git repository';
  const head = g.head === null ? 'unknown branch' : g.head.kind === 'detached' ? `detached at ${g.head.oid.slice(0, 7)}` : g.head.name;
  const modified = g.dirty.modified + g.dirty.staged + g.dirty.renamed + g.dirty.unmerged;
  return `git: ${head}, ${modified} modified, ${g.dirty.untracked} untracked`;
}

const MANIFESTS: readonly [string, string][] = [
  ['package.json', 'node'],
  ['tsconfig.json', 'typescript'],
  ['deno.json', 'deno'],
  ['pyproject.toml', 'python'],
  ['setup.py', 'python'],
  ['setup.cfg', 'python'],
  ['requirements.txt', 'python'],
  ['Cargo.toml', 'rust'],
  ['go.mod', 'go'],
  ['Gemfile', 'ruby'],
  ['pom.xml', 'java'],
  ['build.gradle', 'java'],
  ['build.gradle.kts', 'kotlin'],
  ['composer.json', 'php'],
  ['mix.exs', 'elixir'],
  ['CMakeLists.txt', 'c/c++'],
  ['Makefile', 'make'],
];

async function detectedLine(ctx: AgentContext, top: ReadonlySet<string>): Promise<string> {
  const found: string[] = [];
  for (const [file, lang] of MANIFESTS) {
    if (!top.has(file)) continue;
    if (file === 'package.json') {
      let type = '';
      try {
        const pkg: unknown = JSON.parse((await ctx.workspace.read(file, 64 * 1024)).content);
        if (typeof pkg === 'object' && pkg !== null && (pkg as { type?: unknown }).type === 'module') type = ', type module';
      } catch {
        // an unreadable manifest is still a manifest
      }
      found.push(`${file} (${lang}${type})`);
    } else found.push(`${file} (${lang})`);
  }
  return found.length > 0 ? found.join(', ') : 'no known manifest';
}

function topLevel(candidates: readonly Candidate[]): { line: string; files: Set<string> } {
  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const c of candidates) {
    const slash = c.path.indexOf('/');
    if (slash < 0) files.add(c.path);
    else dirs.add(`${c.path.slice(0, slash)}/`);
  }
  const all = [...[...dirs].sort(), ...[...files].sort()];
  const shown = all.slice(0, AGENT_TOP_LEVEL_ENTRIES);
  return { line: `${shown.join(' ')}${all.length > shown.length ? ` … (+${all.length - shown.length} more)` : ''}`, files };
}

/**
 * The root line names the workspace folder and says that tool paths start below it: with the bare name alone
 * (`- root: js-fix`) glm-5.3-flash and glm-5p3-flash both prefixed it (`read_file js-fix/src/math.js`, a nested
 * `hello-fireworks/hello.txt` written by write_file) in the S6 live runs of 2026-09-23.
 */
export function rootLine(name: string, candidates: readonly Candidate[]): string {
  // a top-level entry of the same name (a Python package named like its repo) makes `<name>/…` a real path: no "never"
  if (candidates.some((c) => c.path === name || c.path.startsWith(`${name}/`))) return `${name} (your working directory: tool paths are relative to it)`;
  return `${name} (your working directory: tool paths are relative to it, so \`src/a.ts\`, never \`${name}/src/a.ts\`)`;
}

/**
 * A package manager's run of the package.json `test` script (`npm test`, `pnpm run test`, `yarn test`, `bun run test`).
 * `bun test` is bun's own runner, not the script.
 */
const PM_TEST_SCRIPT_RE = /^(?:(npm|pnpm|yarn)\s+(?:run\s+)?test|(bun)\s+run\s+test)(?:\s|$)/;
const TEST_SCRIPT_SHOWN_CHARS = 120;

/** Runners that take test files as positional arguments on their own (`vitest run a.test.ts`, `jest a.test.js`). */
const FILE_RUNNERS: ReadonlySet<string> = new Set(['vitest', 'jest', 'mocha', 'ava', 'tap', 'jasmine']);
/** Programs that take test files only in their test form: `node --test`, `tsx --test`, `bun test`, `playwright test`. */
const FILE_RUNNER_FLAG: ReadonlyMap<string, string> = new Map([['node', '--test'], ['tsx', '--test']]);
const FILE_RUNNER_SUBCOMMAND: ReadonlyMap<string, string> = new Map([['bun', 'test'], ['playwright', 'test']]);

/**
 * True when a one-command package script (no `&&`, `;` or pipe) ends in a runner known to take a file path, with no file,
 * directory or glob of its own, so an appended `<file>` runs that one file. Launchers before the runner are skipped:
 * `VAR=…` assignments, `cross-env`, `c8` / `nyc` (and their flags), `npx` (and its flags), `pnpm exec`, `yarn`. Anything
 * else is false: `ng test` reads the file as a project name, `karma start` as a config file, `nx` / `turbo` / `lerna` /
 * `gulp` / `grunt` do not pass it on, `cypress run` needs `--spec`, and `node test/run.js` or `./scripts/test.sh` ignore
 * it and run everything. A positional argument after the runner (`node --test test/`, `mocha 'test/**'`, the value of a
 * flag such as `--config jest.config.js`) is also false: the file would be added to what the script already names.
 */
export function scriptTakesFile(script: string): boolean {
  const toks = script.trim().split(/\s+/).filter((t) => t !== '');
  let i = 0;
  const skipFlags = (): void => {
    while (toks[i]?.startsWith('-') === true) i += 1;
  };
  for (;;) {
    const t = toks[i];
    if (t === undefined) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || t === 'cross-env' || t === 'yarn') i += 1;
    else if (t === 'c8' || t === 'nyc' || t === 'npx') {
      i += 1;
      skipFlags();
    } else if (t === 'pnpm' && toks[i + 1] === 'exec') i += 2;
    else break;
  }
  const program = toks[i]!.slice(toks[i]!.lastIndexOf('/') + 1);
  let rest = toks.slice(i + 1);
  const flag = FILE_RUNNER_FLAG.get(program);
  const sub = FILE_RUNNER_SUBCOMMAND.get(program);
  if (FILE_RUNNERS.has(program)) {
    if (program === 'vitest' && rest[0] === 'run') rest = rest.slice(1);
  } else if (flag !== undefined) {
    if (!rest.includes(flag)) return false;
  } else if (sub !== undefined) {
    if (rest[0] !== sub) return false;
    rest = rest.slice(1);
  } else return false;
  return rest.every((t) => t.startsWith('-'));
}

/**
 * The detected test command, said to be the whole suite, and how to run less of it: the one-file form when the runner can
 * scope, or what a package.json `test` script runs (`node --test`, `vitest run`), so the model can call the runner directly
 * with a file. A one-file form of the script itself (`npm test -- <file>`) is named only when `scriptTakesFile` holds. The
 * model is told to run the tests of what it touched (§5.1 "Verifying"); in a large repository the whole suite takes minutes.
 */
export function testCommandLine(test: TestCommand | null, packageTestScript: string | null = null): string {
  if (test === null) return 'none detected';
  if (test.scope !== undefined) return `\`${test.command}\` (the whole suite); one file: \`${test.scope(['<file>'])}\``;
  const script = packageTestScript?.replace(/\s+/g, ' ').trim() ?? '';
  const m = PM_TEST_SCRIPT_RE.exec(test.command);
  const pm = m?.[1] ?? m?.[2];
  if (script === '' || script === test.command || pm === undefined) return `\`${test.command}\` (the whole suite)`;
  const runs = `\`${test.command}\` (the whole suite; it runs \`${clip(script, TEST_SCRIPT_SHOWN_CHARS)}\`)`;
  // arguments after the script name reach the end of the script (npm and pnpm need `--` first, or they keep the
  // argument): a chain (`tsc && vitest run`, `a; b`, a pipe) would hand the file to its last part only
  if (/&&|\|\||[;|<>]/.test(script) || !scriptTakesFile(script)) return runs;
  return `${runs}; one file: \`${test.command}${pm === 'npm' || pm === 'pnpm' ? ' --' : ''} <file>\``;
}

/** package.json's `scripts.test`, when the workspace root has one. */
async function packageTestScript(ctx: AgentContext, top: ReadonlySet<string>): Promise<string | null> {
  if (!top.has('package.json')) return null;
  try {
    const pkg: unknown = JSON.parse((await ctx.workspace.read('package.json', 64 * 1024)).content);
    const scripts = typeof pkg === 'object' && pkg !== null ? (pkg as { scripts?: unknown }).scripts : undefined;
    const test = typeof scripts === 'object' && scripts !== null ? (scripts as { test?: unknown }).test : undefined;
    return typeof test === 'string' ? test : null;
  } catch {
    return null;
  }
}

async function workspaceBlock(ctx: AgentContext): Promise<string> {
  const g = ctx.workspace.gitState?.() ?? ctx.workspaceInfo.gitState ?? null;
  const candidates = await ctx.workspace.listCandidates();
  const top = topLevel(candidates);
  const lines = [`- root: ${rootLine(basename(ctx.workspace.root), candidates)}; ${gitLine(g, ctx.workspaceInfo.git)}`];
  if (g !== null && g.repo && g.dirty.entries.length > 0) {
    const paths = g.dirty.entries.map((e) => e.path);
    const shown = paths.slice(0, AGENT_DIRTY_PATHS_SHOWN);
    lines.push(`- your uncommitted changes: ${shown.join(', ')}${paths.length > shown.length ? `, … (+${paths.length - shown.length} more)` : ''}`);
  }
  lines.push(`- detected: ${await detectedLine(ctx, top.files)}`);
  lines.push(`- test command: ${testCommandLine(ctx.workspaceInfo.testCommand, await packageTestScript(ctx, top.files))}`);
  lines.push(`- top level: ${top.line || '(empty)'}`);
  return `# Workspace\n${lines.join('\n')}`;
}

async function pinnedBlock(ctx: AgentContext): Promise<string | null> {
  const pins = (ctx.seed?.pinnedFiles ?? []).slice(0, AGENT_PINNED_FILES);
  const parts: string[] = [];
  for (const p of pins) {
    try {
      const v = await ctx.workspace.read(p, AGENT_PINNED_FILE_BYTES);
      parts.push(`### ${v.path}${v.truncatedBytes > 0 ? ' (truncated)' : ''}\n${v.content}`);
    } catch {
      // an unreadable pin (deleted, secret) is left out
    }
  }
  return parts.length > 0 ? `# Pinned files\n${parts.join('\n\n')}` : null;
}

// ---------------------------------------------------------------------------------------
// The parent run
// ---------------------------------------------------------------------------------------

async function readJson(path: string): Promise<JsonObject | null> {
  try {
    const v: unknown = JSON.parse(await readFile(path, 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : null;
  } catch {
    return null;
  }
}

interface ParentFacts {
  task: string | null;
  stopReason: string;
  agentState: Json | null;
  undoLog: UndoLogEntry[] | undefined;
}

/** The parent's checkpoint (an envelope `{version, checksum, state}` or a bare state) and task, read-only. */
async function parentFacts(runDir: string): Promise<ParentFacts> {
  const envelope = await readJson(join(runDir, 'state.json'));
  const inner = envelope?.['state'];
  const state = typeof inner === 'object' && inner !== null && !Array.isArray(inner) ? inner : envelope;
  const meta = await readJson(join(runDir, 'run.json'));
  const stop = state?.['stopReason'];
  return {
    task: typeof meta?.['task'] === 'string' ? meta['task'] : null,
    stopReason: typeof stop === 'string' ? stop : 'unknown',
    agentState: state?.['agentState'] ?? null,
    undoLog: Array.isArray(state?.['undoLog']) ? (state['undoLog'] as unknown as UndoLogEntry[]) : undefined,
  };
}

function legacyBlock(ctx: AgentContext, facts: ParentFacts | null): string | null {
  const seed = ctx.seed;
  if (seed === null) return null;
  const lines: string[] = [];
  if (facts?.task !== null && facts?.task !== undefined) lines.push(`- task: ${clip(facts.task.replace(/\s+/g, ' '), AGENT_SEED_TASK_CHARS)}; stopped: ${facts.stopReason}`);
  const done = seed.plan.done.map((d) => d.text);
  if (done.length > 0 || seed.plan.remaining.length > 0) lines.push(`- plan: ${done.join('; ') || 'nothing done'} / remaining: ${seed.plan.remaining.join('; ') || 'nothing'}`);
  const steps = seed.window.slice(-4).map((w) => `step ${w.step}: ${w.action}${w.outcome !== null ? ` → ${w.outcome}` : ''}`);
  if (steps.length > 0) lines.push(`- last steps: ${steps.join(' · ')}`);
  const t = seed.lastTestRun;
  if (t !== null) lines.push(`- last test run: \`${t.command}\` ${t.passed}/${t.failed}/${t.errors} (step ${t.step})`);
  const undone = undoLines(seed.undoLog);
  if (undone !== null) lines.push(`- undone since: ${undone}`);
  return lines.length > 0 ? `# Previous run in this session\n${lines.join('\n')}` : null;
}

/** §5.3: the first user message of a run with no agent parent. */
export async function firstUserMessage(ctx: AgentContext): Promise<string> {
  const parts: string[] = [];
  const chat = chatLines(ctx.conversation?.chat ?? []);
  if (chat.length > 0) parts.push(`# Conversation so far\n${chat.join('\n')}`);
  parts.push(`# Task\n${ctx.task}`);
  parts.push(await workspaceBlock(ctx));
  const parent = ctx.conversation?.parent ?? null;
  const legacy = legacyBlock(ctx, parent !== null ? await parentFacts(parent.runDir) : null);
  if (legacy !== null) parts.push(legacy);
  const pinned = await pinnedBlock(ctx);
  if (pinned !== null) parts.push(pinned);
  return parts.join('\n\n');
}

/** §7.6 step 4: the continuation message of a follow-up run. */
export async function continuationMessage(ctx: AgentContext, stopReason: string, undoLog: readonly UndoLogEntry[] | undefined): Promise<string> {
  const since = [`- it stopped: ${stopReason}`];
  const undone = undoLines(ctx.seed?.undoLog ?? (undoLog === undefined ? undefined : [...undoLog]));
  if (undone !== null) since.push(`- undone since: ${undone}`);
  const chat = chatLines(ctx.conversation?.chat ?? []);
  if (chat.length > 0) since.push(`- conversation since the last run:\n${chat.join('\n')}`);
  const parts = [`# Since the last run\n${since.join('\n')}`, `# New task\n${ctx.task}`];
  const pinned = await pinnedBlock(ctx);
  if (pinned !== null) parts.push(pinned);
  return parts.join('\n\n');
}

export interface Head {
  records: TranscriptRecord[];
  carriedFrom: string | null;
}

function at(now: number): string {
  return new Date(now).toISOString();
}

/**
 * §7.6: carry the agent parent's transcript, or null when there is nothing to carry (no agent parent, an unreadable
 * checkpoint or transcript) — the caller then builds the first user message.
 */
export async function carryHead(ctx: AgentContext, systemHash: string): Promise<Head | null> {
  const named = ctx.conversation?.parent ?? null;
  if (named === null || named.mode !== 'agent') return null;
  const found = await carriedParent(named);
  if (found === null) return null;
  const { parent, facts, parentState, parentRecords } = found;
  let kept = parentRecords.filter((r) => r.seq <= parentState.transcriptSeq);
  if (kept.length === 0) return null;
  // what a request replays starts at the latest compaction; the first user record stays as the head a later compaction
  // carries forward. Copying the whole history would make every follow-up run's file grow with the session.
  const compaction = kept.map((r) => r.kind).lastIndexOf('compaction');
  if (compaction > 0) {
    const head = kept.findIndex((r) => r.kind === 'user');
    kept = [...(head >= 0 && head < compaction ? [kept[head]!] : []), ...kept.slice(compaction)];
  }
  // §7.6 step 5: reasoning state survives only an unchanged prefix (system prompt, provider, model)
  const sameModel = kept.every((r) => r.kind !== 'assistant' || r.providerState === undefined || (r.providerState.provider === ctx.provider.name && r.providerState.model === ctx.provider.model));
  if (parentState.systemHash !== systemHash || !sameModel) kept = withoutProviderState(kept);
  const now = ctx.now();
  const out: TranscriptRecord[] = [{ v: 1, seq: 1, at: at(now), kind: 'carry', parentRunId: parent.runId, parentSeq: parentState.transcriptSeq }];
  for (const r of kept) out.push({ ...r, seq: out.length + 1 });
  // §7.6 step 3: calls the parent never ran are answered, so every tool_use keeps its tool_result
  let latest: Extract<TranscriptRecord, { kind: 'assistant' }> | null = null;
  for (const r of out) if (r.kind === 'assistant') latest = r;
  else if (r.kind === 'compaction') latest = null;
  if (latest !== null) {
    const answered = new Set(out.filter((r) => r.kind === 'result' && r.seq > latest.seq).map((r) => (r.kind === 'result' ? r.toolUseId : '')));
    for (const c of latest.calls) {
      if (answered.has(c.id)) continue;
      out.push({ v: 1, seq: out.length + 1, at: at(now), kind: 'result', toolUseId: c.id, name: c.name, content: notExecutedRunEnded(facts.stopReason), isError: true, summary: `${c.name} (not executed)` });
    }
  }
  out.push({ v: 1, seq: out.length + 1, at: at(now), kind: 'user', text: ctx.redact(await continuationMessage(ctx, facts.stopReason, facts.undoLog)) });
  return { records: out, carriedFrom: parent.runId };
}

/** How many runs back carryHead follows `carry` records past parents that never checkpointed a driver state. */
const CARRY_FALLBACK_DEPTH = 8;

/**
 * The run whose transcript a follow-up carries: the named parent when it checkpointed a driver state; else (a run that
 * died before its checkpoint landed — a crash, or one written before the head was checkpointed at once) the run its own
 * transcript's `carry` record names, and so on back, so one failed message never drops the whole conversation.
 */
async function carriedParent(named: { runId: string; runDir: string }): Promise<{ parent: { runId: string; runDir: string }; facts: ParentFacts; parentState: AgentStateV1; parentRecords: TranscriptRecord[] } | null> {
  let parent = named;
  for (let depth = 0; depth <= CARRY_FALLBACK_DEPTH; depth += 1) {
    const facts = await parentFacts(parent.runDir);
    const parentState = parseState(facts.agentState);
    const parentRecords = await readTranscript(transcriptPath(parent.runDir)).catch(() => null);
    if (parentState !== null) return parentRecords === null || parentRecords.length === 0 ? null : { parent, facts, parentState, parentRecords };
    const carry = parentRecords?.[0];
    if (carry === undefined || carry.kind !== 'carry' || !/^[\w.-]+$/.test(carry.parentRunId)) return null;
    parent = { runId: carry.parentRunId, runDir: join(dirname(parent.runDir), carry.parentRunId) };
  }
  return null;
}

/** §3.1 step 1: the head of a fresh run — the carried parent transcript, else the first user message. */
export async function buildHead(ctx: AgentContext, systemHash: string): Promise<Head> {
  const carried = await carryHead(ctx, systemHash);
  if (carried !== null) return carried;
  const text = ctx.redact(await firstUserMessage(ctx));
  return { records: [{ v: 1, seq: 1, at: at(ctx.now()), kind: 'user', text }], carriedFrom: null };
}
