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
import { basename, join } from 'node:path';
import type { AgentContext, Candidate, GitState, Json, JsonObject, UndoLogEntry } from '../core/types.js';
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
import { parseState } from './state.js';
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

async function workspaceBlock(ctx: AgentContext): Promise<string> {
  const g = ctx.workspace.gitState?.() ?? ctx.workspaceInfo.gitState ?? null;
  const candidates = await ctx.workspace.listCandidates();
  const top = topLevel(candidates);
  const lines = [`- root: ${basename(ctx.workspace.root)}; ${gitLine(g, ctx.workspaceInfo.git)}`];
  if (g !== null && g.repo && g.dirty.entries.length > 0) {
    const paths = g.dirty.entries.map((e) => e.path);
    const shown = paths.slice(0, AGENT_DIRTY_PATHS_SHOWN);
    lines.push(`- your uncommitted changes: ${shown.join(', ')}${paths.length > shown.length ? `, … (+${paths.length - shown.length} more)` : ''}`);
  }
  lines.push(`- detected: ${await detectedLine(ctx, top.files)}`);
  lines.push(`- test command: ${ctx.workspaceInfo.testCommand !== null ? `\`${ctx.workspaceInfo.testCommand.command}\`` : 'none detected'}`);
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
  const parent = ctx.conversation?.parent ?? null;
  if (parent === null || parent.mode !== 'agent') return null;
  const facts = await parentFacts(parent.runDir);
  const parentState = parseState(facts.agentState);
  if (parentState === null) return null;
  const parentRecords = await readTranscript(transcriptPath(parent.runDir)).catch(() => null);
  if (parentRecords === null || parentRecords.length === 0) return null;
  let kept = parentRecords.filter((r) => r.seq <= parentState.transcriptSeq);
  if (kept.length === 0) return null;
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

/** §3.1 step 1: the head of a fresh run — the carried parent transcript, else the first user message. */
export async function buildHead(ctx: AgentContext, systemHash: string): Promise<Head> {
  const carried = await carryHead(ctx, systemHash);
  if (carried !== null) return carried;
  const text = ctx.redact(await firstUserMessage(ctx));
  return { records: [{ v: 1, seq: 1, at: at(ctx.now()), kind: 'user', text }], carriedFrom: null };
}
