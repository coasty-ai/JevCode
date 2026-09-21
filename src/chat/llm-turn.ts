/**
 * `question_about_the_code` in jev+llm — one generator chat turn, no tools (TUI-DESIGN-2 §3.6). The request carries
 * the system prompt, the session facts, the last run's plan and window, ≤ 3 @-mentioned files and ≤ 6 conversation
 * turns; deltas stream to the live region through `onDelta`; a returned tool call is dropped (the caller logs it).
 * The floor (`llmAnswerAllowed`) and the spend checks run in the controller before this module is called.
 */
import type { ChatMessage, FileView, GenerateRequest, Plan, Provider, TokenUsage, WindowEntry } from '../core/types.js';
import { headTail } from '../core/text.js';
import type { Fact } from './facts.js';
import type { ChatTurn } from './ledger.js';

export interface LlmTurnInput {
  provider: Provider;
  message: string;
  conversation: readonly ChatTurn[];
  facts: readonly Fact[];
  /** the last run's plan, window ≤ 4, @-mentioned files ≤ 3 × 8 KiB after the denylist */
  context: { plan: Plan | null; window: readonly WindowEntry[]; files: readonly FileView[] };
  /** AGENTS.md only when trusted */
  instructions: string | null;
  /** min(800, cfg.maxTokens), null */
  generation: { maxTokens: number; temperature: number | null };
  signal: AbortSignal;
  onDelta: (text: string) => void;
  redact: (s: string) => string;
  /** a dropped tool call is reported here (jevcode.log warning) */
  warn?: (message: string) => void;
}

export const CHAT_SYSTEM_PROMPT = [
  'You are the assistant of JevCode, a coding agent in which Jev (a decision model) makes every decision. You are in a conversation about the code in the workspace named below.',
  'Answer the question. Do not propose file edits, patches or commands to run: the human starts a run for that by describing a task, and Jev then decides each step.',
  'Be concrete, cite paths and line numbers you were shown, and keep the answer under twelve lines. If the shown files do not contain the answer, say what to open next.',
].join('\n');

export const CHAT_MAX_OUTPUT_TOKENS = 800;
export const CHAT_CONVERSATION_TURNS = 6;
export const CHAT_WINDOW_ENTRIES = 4;
export const CHAT_FILES_MAX = 3;
export const CHAT_FILE_BYTES = 8 * 1024;
/** §3.6 `chatEstimateUsd`: the fixed input tokens of a turn (prompt + facts + plan) */
export const CHAT_FIXED_INPUT_TOKENS = 1200;

/** the output cap of a turn: `min(800, cfg.maxTokens)` */
export function chatMaxTokens(configuredMax: number): number {
  return Math.max(1, Math.min(CHAT_MAX_OUTPUT_TOKENS, Math.floor(configuredMax)));
}

function planSection(plan: Plan): string {
  const lines: string[] = [];
  for (const d of plan.done.slice(0, 10)) lines.push(`- done: ${d.text}`);
  for (const r of plan.remaining.slice(0, 10)) lines.push(`- remaining: ${r}`);
  for (const p of plan.openProblems.slice(0, 5)) lines.push(`- open problem: ${p}`);
  return lines.length > 0 ? lines.join('\n') : '(empty plan)';
}

function windowSection(window: readonly WindowEntry[]): string {
  return window
    .slice(-CHAT_WINDOW_ENTRIES)
    .map((w) => `- step ${w.step}: ${w.action}${w.outcome ? ` → ${w.outcome}` : ''}${w.reason ? ` (${w.reason})` : ''}`)
    .join('\n');
}

function filesSection(files: readonly FileView[]): string {
  return files
    .slice(0, CHAT_FILES_MAX)
    .map((f) => {
      const body = headTail(f.content, CHAT_FILE_BYTES, 0);
      return `### ${f.path}${f.truncatedBytes > 0 || body.length < f.content.length ? ' (truncated)' : ''}\n${body}`;
    })
    .join('\n\n');
}

/** conversation (≤ 6, you→user, jevcode→assistant) + the message; consecutive same-role turns merge and the first message is the human's */
export function chatMessages(conversation: readonly ChatTurn[], message: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const t of conversation.slice(-CHAT_CONVERSATION_TURNS)) {
    const role = t.role === 'you' ? 'user' : 'assistant';
    if (out.length === 0 && role === 'assistant') continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.role === role) last.content = `${last.content}\n${t.text}`;
    else out.push({ role, content: t.text });
  }
  const last = out[out.length - 1];
  if (last !== undefined && last.role === 'user') last.content = `${last.content}\n${message}`;
  else out.push({ role: 'user', content: message });
  return out;
}

/** system = CHAT_SYSTEM_PROMPT + facts + optional instructions, plan, recent steps, files; no tools, no toolChoice */
export function buildChatRequest(i: LlmTurnInput): GenerateRequest {
  const sections: string[] = [CHAT_SYSTEM_PROMPT, `## Session facts\n${i.facts.map((f) => `- ${f.text}`).join('\n')}`];
  if (i.instructions !== null && i.instructions.trim() !== '') sections.push(`## Instructions (AGENTS.md)\n${i.instructions}`);
  if (i.context.plan !== null) sections.push(`## Last run plan\n${planSection(i.context.plan)}`);
  if (i.context.window.length > 0) sections.push(`## Recent steps\n${windowSection(i.context.window)}`);
  if (i.context.files.length > 0) sections.push(`## Files\n${filesSection(i.context.files)}`);
  return {
    system: sections.join('\n\n'),
    messages: chatMessages(i.conversation, i.message),
    maxTokens: chatMaxTokens(i.generation.maxTokens),
    temperature: i.generation.temperature,
  };
}

export interface LlmTurnResult {
  text: string;
  usage: TokenUsage;
  latencyMs: number;
  model: string;
}

export async function llmChatTurn(i: LlmTurnInput): Promise<LlmTurnResult> {
  const req = buildChatRequest(i);
  const r = await i.provider.generate(req, { signal: i.signal, onDelta: (d) => i.onDelta(d) });
  if (r.toolCalls.length > 0) i.warn?.(`chat turn: ${r.toolCalls.length} tool call(s) dropped (no tools were offered)`);
  return { text: i.redact(r.text), usage: r.usage, latencyMs: r.latencyMs, model: r.model };
}
