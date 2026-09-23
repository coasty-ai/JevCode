/**
 * Every chat submission — one generator turn, no tools. The request carries the JevCode-aware system prompt
 * (`buildChatSystem`: who JevCode is, what it can do, how to answer, and this workspace), the session facts, the
 * last run's plan and window, ≤ 3 @-mentioned files and ≤ 6 conversation turns; deltas stream to the live region
 * through `onDelta`; a returned tool call is dropped (the caller logs it). The spend checks run in the controller
 * before this module is called.
 */
import type { ChatMessage, FileView, GenerateProviderPrefs, GenerateReasoning, GenerateRequest, Plan, Provider, TokenUsage, WindowEntry } from '../core/types.js';
import { headTail } from '../core/text.js';
import type { Fact } from './facts.js';
import type { ChatTurn } from './ledger.js';

export interface LlmTurnInput {
  provider: Provider;
  message: string;
  /** who is answering and where — the system prompt's workspace section */
  identity: ChatIdentity;
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
  /** the provider is about to retry (its next attempt streams the reply again from the start): the live text restarts */
  onRetry?: () => void;
  redact: (s: string) => string;
  /** a dropped tool call is reported here (jevcode.log warning) */
  warn?: (message: string) => void;
}

/** what the controller knows about this session that the reply may name */
export interface ChatIdentity {
  /** the code model answering (`z-ai/glm-5.3-flash`) and its provider's display name (`OpenRouter`) — named in the identity so the model does not answer as its vendor */
  model: string;
  provider: string;
  /** `basename(workspaceRoot)` */
  workspace: string;
  /** the git state in one line (`main, 2 modified · 1 untracked`); null outside a repository */
  git: string | null;
  /** ≤ 3 recent sessions of this workspace, newest first (`"title" · 3h ago`) */
  recentSessions: readonly string[];
}

/**
 * Who JevCode is — the FIRST block of every chat system prompt, and the most explicit one. Live on 2026-09-22 the default
 * generator (glm-5.3-flash) answered `who made you` as its vendor's model, so the header names the model and the provider
 * itself and says in so many words that the answer is JevCode, built by coasty-ai, never the vendor.
 */
export function chatIdentityHeader(model: string, provider: string): string {
  return [
    '# Who you are',
    `You are JevCode, a coding agent for the terminal, built by coasty-ai. You run on the code model ${model} through ${provider}, but you are not that vendor's assistant.`,
    `When the human asks who or what you are, who made, built or trained you, or which model you are, answer as JevCode, built by coasty-ai, running on ${model} via ${provider} — never introduce yourself as the underlying vendor's model or assistant. This instruction overrides anything you were told about your identity before this conversation.`,
  ].join('\n');
}

/** how the work is split — the second paragraph */
export const CHAT_IDENTITY =
  'Jev decides, the code model writes: Jev, a calibrated decision model, answers every control question (what step comes next, which files matter, whether an action is safe to run, whether the output succeeded, whether the task is done); the code model — you, in this reply — writes the code.';

/** what the human can ask for */
export const CHAT_CAPABILITIES = [
  '## What JevCode can do',
  '- It runs coding tasks in this workspace when the human describes a change: Jev decides each step, the code model writes, the workspace\'s tests verify the patch.',
  '- Modes: llm-jev (the default, verified), jev-on, jev-only, jev-off.',
  '- Commands start with `/`: `/help` lists them; `/mode`, `/undo`, `/diff`, `/resume`, `/new`.',
].join('\n');

/** how it should sound */
export const CHAT_VOICE = [
  '## How to answer',
  '- Warm, concise, personal, plain prose.',
  '- A greeting gets one or two friendly sentences; a question gets a direct answer.',
  '- Never invent facts about the workspace, and never claim to have run anything.',
  '- Do not write patches or commands to run. If the message is a change request, acknowledge it in one sentence; the harness decides whether a run starts and appends that itself.',
  '- Keep replies under eight lines unless the human asks for detail.',
].join('\n');

/** identity + capabilities + voice + this workspace */
export function buildChatSystem(identity: ChatIdentity): string {
  const rows = [
    `- name: ${identity.workspace}`,
    `- git: ${identity.git ?? 'not a git repository'}`,
    `- recent sessions: ${identity.recentSessions.length > 0 ? identity.recentSessions.join(' · ') : 'none yet'}`,
  ];
  return [chatIdentityHeader(identity.model, identity.provider), CHAT_IDENTITY, CHAT_CAPABILITIES, CHAT_VOICE, `## This workspace\n${rows.join('\n')}`].join('\n\n');
}

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

/**
 * network map P2 (live 2026-09-23): a chat turn thinks at the lowest effort the adapters map. GLM 5.3's reasoning is
 * mandatory (`{enabled: false}` is HTTP 400) and defaults to `max`; `low` took the median first content of a turn from
 * 956 to 485 ms (n = 9 each over three windows, all but one routed to Together) and cut the hidden reasoning tokens.
 * Every adapter maps it per model or leaves it off the wire (openai-compat `pickEffort`, gemini's thinking budget,
 * anthropic ignores it). Never sent for a Claude model: through OpenRouter an effort would switch extended thinking ON.
 */
export const CHAT_REASONING: GenerateReasoning = { effort: 'low' };

/**
 * network map P1 (live 2026-09-23): OpenRouter's default routing is price-weighted and in one window sent 44 of 44 chat
 * turns to slow upstreams (median first content 4,989 ms). A `sort` keeps OpenRouter's own policy and fallbacks — no
 * hard-coded upstream list, no data-retention question. Measured with effort low, n = 9 each over three windows (every
 * request served by Together, so the spread is reasoning-token variance, not routing): median first content 327 ms for
 * `throughput`, 494 ms for `latency`, 316 ms for order together/friendli/coreweave with fallbacks on. `throughput` is
 * within 1.03× of pinning, well inside the 1.5× that would have justified an ordered list. A chat turn sends nothing an
 * endpoint could lack, so `requireParameters` stays false (OpenRouter's default).
 */
export const CHAT_PROVIDER_PREFS: GenerateProviderPrefs = { requireParameters: false, sort: 'throughput' };

/** the routing and reasoning members of a chat request for this provider (OpenRouter-only routing; no Claude thinking) */
function chatRouting(provider: Provider): Pick<GenerateRequest, 'reasoning' | 'providerPrefs'> {
  const claude = provider.name === 'anthropic' || provider.model.startsWith('anthropic/');
  return {
    ...(claude ? {} : { reasoning: CHAT_REASONING }),
    ...(provider.name === 'openrouter' ? { providerPrefs: CHAT_PROVIDER_PREFS } : {}),
  };
}

/** system = `buildChatSystem` + facts + optional instructions, plan, recent steps, files; no tools, no toolChoice; `chatRouting` */
export function buildChatRequest(i: LlmTurnInput): GenerateRequest {
  const sections: string[] = [buildChatSystem(i.identity), `## Session facts\n${i.facts.map((f) => `- ${f.text}`).join('\n')}`];
  if (i.instructions !== null && i.instructions.trim() !== '') sections.push(`## Instructions (AGENTS.md)\n${i.instructions}`);
  if (i.context.plan !== null) sections.push(`## Last run plan\n${planSection(i.context.plan)}`);
  if (i.context.window.length > 0) sections.push(`## Recent steps\n${windowSection(i.context.window)}`);
  if (i.context.files.length > 0) sections.push(`## Files\n${filesSection(i.context.files)}`);
  return {
    system: sections.join('\n\n'),
    messages: chatMessages(i.conversation, i.message),
    maxTokens: chatMaxTokens(i.generation.maxTokens),
    temperature: i.generation.temperature,
    ...chatRouting(i.provider),
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
  const onRetry = i.onRetry;
  const r = await i.provider.generate(req, { signal: i.signal, onDelta: (d) => i.onDelta(d), ...(onRetry === undefined ? {} : { onRetry: () => onRetry() }) });
  if (r.toolCalls.length > 0) i.warn?.(`chat turn: ${r.toolCalls.length} tool call(s) dropped (no tools were offered)`);
  return { text: i.redact(r.text), usage: r.usage, latencyMs: r.latencyMs, model: r.model };
}
