/**
 * Context policy (docs/AGENT-LOOP-DESIGN.md §7.1-§7.5): the budget, the estimate before a turn, stage-1 masking of stale
 * tool results, stage-2 simple compaction, and the meter the engine shows.
 *
 *  - Budget: min(0.9 × the model's window, 200,000 tokens).
 *  - Estimate: the last turn's reported input tokens (minus what the server cleared) plus the characters appended since,
 *    at 3.4 chars per token; before the first turn, all characters.
 *  - Masking at 50 % (client mode only, and only when ≥ 20,000 chars can be reclaimed): results older than the newest 6
 *    and longer than 800 chars become one-line markers. Anthropic clears server-side instead; a Claude model behind
 *    another adapter is never masked (its thinking is bound to the prefix, §6.5).
 *  - Compaction at 85 % (or `/compact`), only with an empty queue: the next request becomes ONE user message — the head,
 *    a summary, the last 3 results, the re-read content of up to 5 recently edited files, "Continue with the task." — and
 *    replays no earlier assistant turn and no reasoning state, on every provider alike.
 */
import type { AgentContext, CompactionMode, ContextUsage, GenerateRequest, TokenUsage } from '../core/types.js';
import { CHARS_PER_TOKEN } from '../core/limits.js';
import { clip } from '../core/text.js';
import {
  AGENT_COMPACT_AT,
  AGENT_COMPACT_FILE_CHARS,
  AGENT_COMPACT_FILES,
  AGENT_COMPACT_FINDING_CHARS,
  AGENT_COMPACT_FINDINGS,
  AGENT_COMPACT_KEEP_RESULTS,
  AGENT_COMPACT_RESULT_CHARS,
  AGENT_COMPACT_SOURCE_CHARS,
  AGENT_COMPACT_SOURCE_RESULT_CHARS,
  AGENT_COMPACT_SUMMARY_TOKENS,
  AGENT_CONTEXT_CAP_TOKENS,
  AGENT_CONTEXT_WINDOW_SHARE,
  AGENT_DEFAULT_WINDOW_TOKENS,
  AGENT_FILE_MAX_BYTES,
  AGENT_MASK_AT,
  AGENT_MASK_KEEP_RESULTS,
  AGENT_MASK_MIN_RECLAIM_CHARS,
  AGENT_MASK_MIN_RESULT_CHARS,
} from './limits.js';
import { CONTINUE_WITH_TASK } from './prompt.js';
import { agentReasoning, agentTemperature, lowEffortReasoning, type MaskingMode } from './providers.js';
import type { AgentStateV1 } from './state.js';
import { elided, type AssistantRecord, type ResultRecord, type Transcript, type TranscriptRecord } from './transcript.js';

export interface Budget {
  windowTokens: number;
  budgetTokens: number;
  boundBy: 'window' | 'ceiling';
}

/** §7.1 */
export function budgetFor(windowTokens: number | null): Budget {
  const window = windowTokens !== null && windowTokens > 0 ? windowTokens : AGENT_DEFAULT_WINDOW_TOKENS;
  const share = Math.floor(AGENT_CONTEXT_WINDOW_SHARE * window);
  return share > AGENT_CONTEXT_CAP_TOKENS ? { windowTokens: window, budgetTokens: AGENT_CONTEXT_CAP_TOKENS, boundBy: 'ceiling' } : { windowTokens: window, budgetTokens: share, boundBy: 'window' };
}

/** The estimate between turns (§7.1). In memory only: a resumed run starts from the character count. */
export class ContextEstimate {
  private lastTokens: number | null = null;
  private charsAtLast = 0;

  /** `inputTokens` already includes the cached share (`TokenUsage.cacheReadTokens` is a part of it, src/core/types.ts). */
  observe(usage: TokenUsage, clearedInputTokens: number, requestChars: number): void {
    this.lastTokens = Math.max(0, usage.inputTokens - clearedInputTokens);
    this.charsAtLast = requestChars;
  }

  /** Forget the provider's count (after a compaction or masking the character count is the better guide). */
  reset(): void {
    this.lastTokens = null;
  }

  tokens(requestChars: number): number {
    if (this.lastTokens === null) return Math.round(requestChars / CHARS_PER_TOKEN);
    return Math.max(0, Math.round(this.lastTokens + (requestChars - this.charsAtLast) / CHARS_PER_TOKEN));
  }
}

// ---------------------------------------------------------------------------------------
// Stage 1: masking
// ---------------------------------------------------------------------------------------

/** The results a mask would elide now, and the characters it would reclaim. */
export function maskCandidates(t: Transcript): { ids: string[]; reclaim: number } {
  const masked = t.masked();
  const results = t.live().filter((r): r is ResultRecord => r.kind === 'result');
  const stale = results.slice(0, Math.max(0, results.length - AGENT_MASK_KEEP_RESULTS));
  const ids: string[] = [];
  let reclaim = 0;
  for (const r of stale) {
    if (masked.has(r.toolUseId) || r.content.length <= AGENT_MASK_MIN_RESULT_CHARS) continue;
    ids.push(r.toolUseId);
    reclaim += r.content.length - elided(r).length;
  }
  return { ids, reclaim };
}

export function maskDue(mode: MaskingMode, tokens: number, budget: Budget, reclaim: number): boolean {
  return mode === 'client' && tokens > AGENT_MASK_AT * budget.budgetTokens && reclaim >= AGENT_MASK_MIN_RECLAIM_CHARS;
}

export function compactionDue(tokens: number, budget: Budget): boolean {
  return tokens > AGENT_COMPACT_AT * budget.budgetTokens;
}

/** §7.4: the compaction writer. `llm` is the agent's default unless the user set `context.compaction` explicitly. */
export function compactionWriter(c: { mode: CompactionMode; explicit: boolean }): 'llm' | 'code' | 'off' {
  if (!c.explicit) return 'llm';
  return c.mode;
}

/** §7.3 server mode: the constant clearing request of an Anthropic session. */
export function clearToolResultsFor(budget: Budget, clearAtLeast: number): { triggerTokens: number; keep: number; clearAtLeastTokens: number } {
  return { triggerTokens: Math.round(AGENT_MASK_AT * budget.budgetTokens), keep: AGENT_MASK_KEEP_RESULTS, clearAtLeastTokens: clearAtLeast };
}

// ---------------------------------------------------------------------------------------
// Stage 2: compaction
// ---------------------------------------------------------------------------------------

function firstLineOf(s: string): string {
  const i = s.indexOf('\n');
  return i < 0 ? s : s.slice(0, i);
}

function callsById(records: readonly TranscriptRecord[]): Map<string, { name: string; input: Record<string, unknown> }> {
  const out = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const r of records) if (r.kind === 'assistant') for (const c of r.calls) out.set(c.id, { name: c.name, input: c.input });
  return out;
}

/** Workspace files the run edited or wrote (successfully), most recent first. */
export function editedFiles(records: readonly TranscriptRecord[]): { path: string; edits: number; created: boolean }[] {
  const calls = callsById(records);
  const out = new Map<string, { path: string; edits: number; created: boolean }>();
  for (const r of records) {
    if (r.kind !== 'result' || r.isError) continue;
    const c = calls.get(r.toolUseId);
    const path = c?.input['path'];
    if (c === undefined || (c.name !== 'edit_file' && c.name !== 'write_file') || typeof path !== 'string') continue;
    const prev = out.get(path);
    out.delete(path);
    out.set(path, { path, edits: (prev?.edits ?? 0) + 1, created: (prev?.created ?? false) || r.content.startsWith('OK: created') });
  }
  return [...out.values()].reverse();
}

/** §7.4 `code`: the summary template filled from the transcript and the run's facts, deterministically. */
export function codeSummary(ctx: AgentContext, t: Transcript, state: AgentStateV1): string {
  const records = t.records;
  const calls = callsById(records);
  const todos = state.todos.map((x) => `- [${x.status === 'completed' ? 'x' : x.status === 'in_progress' ? '>' : ' '}] ${x.content}`);
  const files = editedFiles(records).map((f) => `- ${f.path} — ${f.edits} edit${f.edits === 1 ? '' : 's'}${f.created ? ', created' : ''}`);
  const commands = records
    .filter((r): r is ResultRecord => r.kind === 'result' && calls.get(r.toolUseId)?.name === 'bash')
    .slice(-10)
    .map((r) => `- \`${clip(String(calls.get(r.toolUseId)?.input['command'] ?? ''), 200)}\` → ${firstLineOf(r.content)}`);
  const last = ctx.lastTestRun;
  const findings = records
    .filter((r): r is AssistantRecord => r.kind === 'assistant' && r.text.trim() !== '')
    .slice(-AGENT_COMPACT_FINDINGS)
    .map((r) => `- ${clip(r.text.replace(/\s+/g, ' ').trim(), AGENT_COMPACT_FINDING_CHARS)}`);
  return [
    `# Context summary (compacted at step ${ctx.step}; earlier turns were removed)`,
    '## Goal and constraints',
    clip(ctx.task, 1_000),
    '## Todo',
    todos.length > 0 ? todos.join('\n') : '(no todo list)',
    '## Files changed so far',
    files.length > 0 ? files.join('\n') : '(none)',
    '## Commands run',
    commands.length > 0 ? commands.join('\n') : '(none)',
    '## Last test run',
    last !== null ? `\`${last.command}\` ${last.passed} passed, ${last.failed} failed, ${last.errors} errors (step ${last.step})` : '(none)',
    '## Findings and decisions',
    findings.length > 0 ? findings.join('\n') : '(none recorded)',
    '## Open questions and next step',
    'Continue from the last step above; re-read files before editing them.',
  ].join('\n');
}

/** The turns a compaction removes, as text for the LLM writer (bounded; the newest part is kept). */
function renderForSummary(records: readonly TranscriptRecord[]): string {
  const lines: string[] = [];
  for (const r of records) {
    if (r.kind === 'user' || r.kind === 'note' || r.kind === 'compaction') lines.push(`[${r.kind === 'compaction' ? 'earlier summary' : 'user'}] ${r.text}`);
    else if (r.kind === 'assistant') {
      if (r.text.trim() !== '') lines.push(`[assistant] ${r.text}`);
      for (const c of r.calls) lines.push(`[assistant calls ${c.name}] ${clip(JSON.stringify(c.input), 300)}`);
    } else if (r.kind === 'result') lines.push(`[${r.name} result] ${clip(r.content, AGENT_COMPACT_SOURCE_RESULT_CHARS)}`);
  }
  let text = lines.join('\n');
  if (text.length > AGENT_COMPACT_SOURCE_CHARS) text = `…\n${text.slice(text.length - AGENT_COMPACT_SOURCE_CHARS)}`;
  return text;
}

const SUMMARY_SYSTEM =
  'You write the handoff summary of a coding agent\'s work so far, so the agent can continue after its earlier turns are removed. Fill in the template exactly, with its headings. Be concrete: file paths, commands and their results, test counts, decisions and what remains. No preamble.';

/** §7.4 `llm`: the main provider fills the template from the removed turns; null on any failure (the caller falls back to `code`). */
export async function llmSummary(ctx: AgentContext, t: Transcript, state: AgentStateV1, turn: number): Promise<string | null> {
  const template = codeSummary(ctx, t, state);
  const reasoning = lowEffortReasoning(ctx.provider.name) ?? agentReasoning(ctx.provider.name, ctx.provider.model);
  const req: GenerateRequest = {
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: `Template (keep the headings; improve and complete every section from the turns below):\n${template}\n\nThe turns to summarise:\n${renderForSummary(t.live())}` }],
    maxTokens: AGENT_COMPACT_SUMMARY_TOKENS,
    temperature: agentTemperature(ctx.provider.name, ctx.generation.temperature),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
  try {
    const r = await ctx.generate(req, { turn, silent: true });
    const text = r.text.trim();
    return text.length > 0 ? ctx.redact(text) : null;
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    return null;
  }
}

/** §7.4: the one user message that replaces the history — head, summary, the last results, the edited files. */
export async function compactionText(ctx: AgentContext, t: Transcript, summary: string): Promise<string> {
  const parts: string[] = [];
  const head = t.firstUser();
  if (head !== null) parts.push(head.text);
  const current = [...t.records].reverse().find((r) => r.kind === 'user');
  if (current !== undefined && current !== head && current.kind === 'user') parts.push(current.text);
  parts.push(summary);
  const results = t.live().filter((r): r is ResultRecord => r.kind === 'result').slice(-AGENT_COMPACT_KEEP_RESULTS);
  if (results.length > 0) parts.push(`# Most recent tool results\n${results.map((r) => `## ${r.summary}\n${clip(r.content, AGENT_COMPACT_RESULT_CHARS)}`).join('\n\n')}`);
  const files: string[] = [];
  for (const f of editedFiles(t.records).slice(0, AGENT_COMPACT_FILES)) {
    try {
      const v = await ctx.workspace.read(f.path, AGENT_FILE_MAX_BYTES);
      files.push(`## ${f.path}\n${clip(v.content, AGENT_COMPACT_FILE_CHARS)}`);
    } catch {
      // a file deleted since is simply not shown
    }
  }
  if (files.length > 0) parts.push(`# Recently edited files (current content)\n${files.join('\n\n')}`);
  parts.push(CONTINUE_WITH_TASK);
  return parts.join('\n\n');
}

/** §7.5: the meter's `ContextUsage` for the next turn. */
export function contextUsage(o: { tokens: number; budget: Budget; promptChars: number; turns: number; state: AgentStateV1; writer: CompactionMode; buildMs: number }): ContextUsage {
  const budgetChars = Math.round(o.budget.budgetTokens * CHARS_PER_TOKEN);
  return {
    promptChars: o.promptChars,
    budgetChars,
    pct: Math.round((100 * o.tokens) / Math.max(1, o.budget.budgetTokens)),
    files: 0,
    historyEntries: o.turns,
    summaryAt: o.state.lastCompactionStep,
    lastCompactionStep: o.state.lastCompactionStep,
    tokensInWindow: o.tokens,
    budgetTokens: o.budget.budgetTokens,
    windowTokens: o.budget.windowTokens,
    compactions: o.state.compactions,
    lastCompactionAt: o.state.lastCompactionAt,
    compaction: o.writer,
    budgetBoundBy: o.budget.boundBy,
    usdPerStep: null,
    windowTooSmall: false,
    recentSteps: { chars: 0, allowanceChars: 0, whole: 0, clipped: 0, oneLine: 0, reads: 0 },
    promptBuildMs: o.buildMs,
    refreshMs: 0,
  };
}
