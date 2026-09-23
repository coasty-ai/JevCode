/**
 * Every chat submission — one generator turn, no tools. The request carries the JevCode-aware system prompt
 * (`buildChatSystem`: who JevCode is, what it can do, how to answer, and this workspace), the session facts, the
 * last run's plan and window, ≤ 3 @-mentioned files and ≤ 6 conversation turns; deltas stream to the live region
 * through `onDelta`; a returned tool call is dropped (the caller logs it). The spend checks run in the controller
 * before this module is called.
 */
import type { ChatMessage, EngineMode, FileView, GenerateProviderPrefs, GenerateReasoning, GenerateRequest, Plan, Provider, TokenUsage, WindowEntry } from '../core/types.js';
import { ADVERTISED_MODES, DEFAULT_MODE, LEGACY_MODES } from '../config/defaults.js';
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
  /** the provider returned (the stream is over): whatever the live region still held back is final now */
  onEnd?: () => void;
  redact: (s: string) => string;
  /** a dropped tool call is reported here (jevcode.log warning) */
  warn?: (message: string) => void;
  /** the session's mode: `agent` takes the agent-era copy (AGENT-LOOP-DESIGN §14.5); absent or a legacy mode keeps today's prompt byte for byte */
  mode?: EngineMode;
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

/**
 * How the work is split — the second paragraph (AGENT-LOOP-DESIGN §14.5; its example per §A1/§A4: no intake routing in agent mode, Jev's
 * only first-turn call is RA0's speed hint). The code model does the work; Jev only makes a few
 * quick routing calls. The verified identity header above stays the FIRST block (§A5); slice S3 leads the agent system prompt with it.
 */
export const CHAT_IDENTITY =
  'The code model, you in this reply, does the work: in a run it reads, searches, edits and runs commands in this workspace through tools, and the workspace\'s tests verify the change. A small decision model (Jev) only makes a few quick routing calls, such as a speed hint for a conversational message.';

/** the paragraph of the Jev-driven modes (llm-jev, jev-on, jev-off chats): unchanged, because there Jev does decide every step */
export const CHAT_IDENTITY_LEGACY =
  'Jev decides, the code model writes: Jev, a calibrated decision model, answers every control question (what step comes next, which files matter, whether an action is safe to run, whether the output succeeded, whether the task is done); the code model — you, in this reply — writes the code.';

/** the modes line of `CHAT_CAPABILITIES` — the advertised modes, the default marked from `DEFAULT_MODE` (never a literal), the legacy ones named as kept */
function modesLine(): string {
  const describe = (m: (typeof ADVERTISED_MODES)[number]): string => (m === 'agent' ? 'agent (the code model works through tools)' : 'jev-only (Jev without a code model)');
  const advertised = ADVERTISED_MODES.map((m) => `${describe(m)}${m === DEFAULT_MODE ? ' — the default' : ''}`);
  return `- Modes: ${advertised.join(' and ')}; ${LEGACY_MODES.join(', ')} are kept for saved configs.`;
}

/** what the human can ask for (AGENT-LOOP-DESIGN §14.5) */
export const CHAT_CAPABILITIES = [
  '## What JevCode can do',
  '- It runs coding tasks in this workspace when the human describes a change: the code model works through tools, shows what it is doing as it goes, and verifies with the tests.',
  modesLine(),
  '- Commands start with `/`: `/help` lists them; `/mode`, `/undo`, `/diff`, `/resume`, `/new`.',
].join('\n');

/** the capabilities of the Jev-driven modes' chat (unchanged) */
export const CHAT_CAPABILITIES_LEGACY = [
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

/**
 * AGENT-LOOP-DESIGN §A1: the voice rules of an agent turn — CHAT_VOICE's warmth and brevity, without the chat-only rules (a chat
 * reply may not act; an agent turn does, through tools). Conversational messages are answered directly and briefly WITHOUT tools;
 * read-only tools may answer questions about the workspace. Exported for slice S3's agent system prompt.
 */
export const AGENT_VOICE = [
  '## How to answer',
  '- Warm, concise, personal, plain prose.',
  '- A greeting or a question about JevCode gets one or two friendly sentences, answered directly, without tools.',
  '- A question about this workspace may use the read-only tools (read_file, grep, glob) before you answer; never guess at code you have not read.',
  '- A change request is work: do it with the tools, then say briefly what changed and how it was verified.',
  '- Never invent facts about the workspace, and never claim to have run anything you did not run.',
].join('\n');

/** identity + capabilities + voice + this workspace; `mode` `agent` takes the agent-era copy, anything else today's prompt byte for byte */
export function buildChatSystem(identity: ChatIdentity, mode?: EngineMode): string {
  const rows = [
    `- name: ${identity.workspace}`,
    `- git: ${identity.git ?? 'not a git repository'}`,
    `- recent sessions: ${identity.recentSessions.length > 0 ? identity.recentSessions.join(' · ') : 'none yet'}`,
  ];
  const agent = mode === 'agent';
  return [chatIdentityHeader(identity.model, identity.provider), agent ? CHAT_IDENTITY : CHAT_IDENTITY_LEGACY, agent ? CHAT_CAPABILITIES : CHAT_CAPABILITIES_LEGACY, agent ? AGENT_VOICE : CHAT_VOICE, `## This workspace\n${rows.join('\n')}`].join('\n\n');
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
 * Every direct adapter maps it per model or leaves it off the wire (openai-compat `pickEffort`, gemini's thinking budget,
 * anthropic ignores it). OpenRouter does not: there an effort alone implies `enabled`, so a model whose reasoning is
 * optional and off by default (Claude, DeepSeek V3.x, the Qwen3 hybrids) would START thinking on every turn and answer
 * later, not sooner — through OpenRouter it goes only to `CHAT_REASONING_OPENROUTER` models.
 */
export const CHAT_REASONING: GenerateReasoning = { effort: 'low' };

/**
 * The OpenRouter models whose reasoning is known to be mandatory or on by default, so `CHAT_REASONING` can only lower it:
 * GLM 5.x (models API: `reasoning.mandatory: true`, default effort `max`; the 956 → 485 ms above). An allow-list, not a
 * deny-list — an unlisted model is sent no `reasoning` and keeps its own default.
 */
export const CHAT_REASONING_OPENROUTER: readonly RegExp[] = [/^z-ai\/glm-5/];

/**
 * network map P1 (live 2026-09-23): OpenRouter's default routing is price-weighted and in one window sent 44 of 44 chat
 * turns to slow upstreams (median first content 4,989 ms). A `sort` keeps OpenRouter's own policy and fallbacks — no
 * hard-coded upstream list, no data-retention question. `latency` ranks by time to first token, which is what a chat
 * turn waits on (`throughput` ranks by tokens/s). UNPROVEN in the slow regime, stated rather than hidden: in the fast
 * windows every request went to Together whatever the sort (327 ms `throughput` / 494 ms `latency`, n = 9 each — the
 * spread is reasoning-token variance, not routing), and in the one slow window neither sort moved the upstream (5,173 /
 * 6,289 ms against 518–1,228 ms pinned). Pinning (order together/friendli/coreweave, fallbacks on) needs the owner's
 * data-retention sign-off and is not sent. A chat turn sends nothing an endpoint could lack, so `requireParameters`
 * stays false (OpenRouter's default).
 */
export const CHAT_PROVIDER_PREFS: GenerateProviderPrefs = { requireParameters: false, sort: 'latency' };

/** the routing and reasoning members of a chat request for this provider (OpenRouter-only routing; no Claude thinking) */
function chatRouting(provider: Provider): Pick<GenerateRequest, 'reasoning' | 'providerPrefs'> {
  const router = provider.name === 'openrouter';
  const claude = provider.name === 'anthropic' || provider.model.startsWith('anthropic/');
  const think = !claude && (!router || CHAT_REASONING_OPENROUTER.some((re) => re.test(provider.model)));
  return {
    ...(think ? { reasoning: CHAT_REASONING } : {}),
    ...(router ? { providerPrefs: CHAT_PROVIDER_PREFS } : {}),
  };
}

/** system = `buildChatSystem` + facts + optional instructions, plan, recent steps, files; no tools, no toolChoice; `chatRouting` */
export function buildChatRequest(i: LlmTurnInput): GenerateRequest {
  const sections: string[] = [buildChatSystem(i.identity, i.mode), `## Session facts\n${i.facts.map((f) => `- ${f.text}`).join('\n')}`];
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
  i.onEnd?.();
  if (r.toolCalls.length > 0) i.warn?.(`chat turn: ${r.toolCalls.length} tool call(s) dropped (no tools were offered)`);
  return { text: i.redact(r.text), usage: r.usage, latencyMs: r.latencyMs, model: r.model };
}
