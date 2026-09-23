/**
 * Sampling one model turn (docs/AGENT-LOOP-DESIGN.md §3.1 steps 4-7, §6.1, §6.3, §6.5, §9.3).
 *
 * The request carries the byte-stable system prompt and tool list, the transcript as native agent messages, parallel
 * tool calls, the session as the cache key, reasoning replay unless the provider rejected it, and Anthropic's
 * server-side result clearing. Prose streams through the shaper. A provider 400 that names reasoning, thinking, a
 * signature or a tool-call id is retried once in the same step without any reasoning state, and replay stays off for
 * the run. The reply is parsed into calls — native, else recovered from GLM/Qwen XML or fenced JSON — with unique ids,
 * at most 32 kept; an empty reply is a stage failure.
 */
import type { AgentContext, GenerateRequest, GenerateResult, Json, ToolSpec } from '../core/types.js';
import { GeneratorResponseError, ProviderHttpError } from '../errors.js';
import { AGENT_ANTHROPIC_CLEAR_AT_LEAST_TOKENS, AGENT_MAX_CALLS_PER_TURN, AGENT_MAX_OUTPUT_TOKENS } from './limits.js';
import { NOT_EXECUTED_TOO_MANY } from './prompt.js';
import { agentReasoning, agentTemperature, lowEffortReasoning, type MaskingMode } from './providers.js';
import { assignIds, extractTextToolCalls, normaliseCall, resolveToolName, type NormalisedCall, type RawCall } from './repair.js';
import { clearToolResultsFor, type Budget, type ContextEstimate } from './context.js';
import type { AgentStateV1 } from './state.js';
import { createProseShaper } from './stream.js';
import { isCutOff } from './stop.js';
import { messageChars, type AssistantRecord, type RecordedCall, type Transcript } from './transcript.js';

/** §6.5: the rejection a replayed prefix can earn. */
export const REJECTED_REPLAY_RE = /reasoning|thinking|signature|tool_call|tool_use/i;
export const REJECTED_REPLAY_WARNING = 'the provider rejected replayed reasoning; continuing without it';

export interface TurnSetup {
  ctx: AgentContext;
  state: AgentStateV1;
  transcript: Transcript;
  system: string;
  systemHash: string;
  tools: ToolSpec[];
  budget: Budget;
  maskingMode: MaskingMode;
  estimate: ContextEstimate;
  /** RA0 said the message is conversational: this one turn goes at the provider's low effort (§A4) */
  lowEffort: boolean;
  /** provider warnings already surfaced this run (one transcript line each) */
  warned: Set<string>;
}

export interface SampledTurn {
  turn: number;
  record: AssistantRecord;
  /** the kept calls, normalised, in order */
  calls: NormalisedCall[];
}

/** The request of the next turn (also what the meter measures). */
export function buildRequest(s: TurnSetup, replay: boolean): GenerateRequest {
  const { ctx } = s;
  const messages = s.transcript.messages({ provider: ctx.provider.name, model: ctx.provider.model, systemHash: s.systemHash, replay });
  const reasoning = s.lowEffort ? (lowEffortReasoning(ctx.provider.name) ?? agentReasoning(ctx.provider.name)) : agentReasoning(ctx.provider.name);
  return {
    system: s.system,
    messages: [],
    maxTokens: Math.max(ctx.generation.maxTokens, AGENT_MAX_OUTPUT_TOKENS),
    temperature: agentTemperature(ctx.provider.name, ctx.generation.temperature),
    tools: s.tools,
    toolChoice: 'auto',
    reasoning,
    agent: {
      messages,
      parallelToolCalls: true,
      cacheKey: ctx.sessionId,
      replayReasoning: replay,
      ...(s.maskingMode === 'server' ? { clearToolResults: clearToolResultsFor(s.budget, AGENT_ANTHROPIC_CLEAR_AT_LEAST_TOKENS) } : {}),
    },
  };
}

/** Characters of a request (system + tools + messages): the estimate's measure. */
export function requestChars(req: GenerateRequest): number {
  return req.system.length + JSON.stringify(req.tools ?? []).length + messageChars(req.agent?.messages ?? []);
}

/** A call's arguments with every string redacted (the transcript records redacted text, §10). */
function redactInput(ctx: AgentContext, input: RecordedCall['input']): RecordedCall['input'] {
  const walk = (v: Json): Json => {
    if (typeof v === 'string') return ctx.redact(v);
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(input) as RecordedCall['input'];
}

function isRejectedReplay(e: unknown): boolean {
  return e instanceof ProviderHttpError && e.status === 400 && REJECTED_REPLAY_RE.test(`${e.message} ${e.body}`);
}

async function generate(s: TurnSetup, turn: number): Promise<{ result: GenerateResult; req: GenerateRequest }> {
  const { ctx } = s;
  let req = buildRequest(s, !s.state.replayDisabled);
  for (let attempt = 0; ; attempt += 1) {
    const shaper = createProseShaper({ step: ctx.step, turn, emit: (e) => ctx.emit(e), redact: ctx.redact });
    try {
      const result = await ctx.generate(req, { turn, onText: (t) => shaper.push(t), onAttemptReset: (a) => shaper.reset(a) });
      shaper.finish();
      return { result, req };
    } catch (e) {
      // §6.5: one retry in the same step with every providerState stripped; replay stays off for the rest of the run
      if (attempt > 0 || s.state.replayDisabled || !isRejectedReplay(e)) throw e;
      s.state.replayDisabled = true;
      ctx.emit({ type: 'transcript', step: ctx.step, level: 'warn', text: REJECTED_REPLAY_WARNING });
      req = buildRequest(s, false);
    }
  }
}

/** Sample the next turn and append its assistant record (plus NOT_EXECUTED_TOO_MANY results past the cap). */
export async function sampleTurn(s: TurnSetup): Promise<SampledTurn> {
  const { ctx, state, transcript } = s;
  const turn = state.turns + 1;
  const { result, req } = await generate(s, turn);
  state.turns = turn;
  s.estimate.observe(result.usage, result.contextEdits?.clearedInputTokens ?? 0, requestChars(req));
  for (const w of result.warnings ?? []) {
    if (s.warned.has(w)) continue;
    s.warned.add(w);
    ctx.emit({ type: 'transcript', step: ctx.step, level: 'warn', text: ctx.redact(w) });
  }

  let raw: RawCall[] = result.toolCalls.map((c) => ({ ...(c.id !== undefined ? { id: c.id } : {}), name: c.name, input: c.input, rawJson: c.rawJson }));
  let prose = result.text;
  if (raw.length === 0) {
    const x = extractTextToolCalls(result.text);
    if (x.calls.length > 0) {
      raw = x.calls;
      prose = x.prose;
    }
  }
  // §3.1 step 7: nothing to say and nothing to do is a malformed reply (a stage failure; three in a row stop the run)
  if (raw.length === 0 && prose.trim() === '') throw new GeneratorResponseError('empty reply', result.text);

  const cut = isCutOff(result.stopReason);
  const ids = assignIds(raw, turn, transcript.usedIds());
  const calls: NormalisedCall[] = [];
  const recorded: RecordedCall[] = [];
  raw.forEach((r, i) => {
    const n = normaliseCall(r, { root: ctx.workspace.root, cutOff: cut && i === raw.length - 1, maxTokens: req.maxTokens });
    const id = ids[i]!;
    // calls are recorded under the tool's own name (an alias like `Read` → read_file, a call extracted from the prose), so
    // the next request shows the model the native form and the tool_result carries the same name as its tool_use
    const name = resolveToolName(r.name) ?? r.name;
    recorded.push({ id, name, input: n.replayInput, ...(n.error !== null ? { error: n.error } : {}) });
    if (i < AGENT_MAX_CALLS_PER_TURN) calls.push({ id, ...n });
  });
  const record = (await transcript.append({
    kind: 'assistant',
    turn,
    text: ctx.redact(prose),
    calls: recorded.map((c) => ({ ...c, input: redactInput(ctx, c.input) })),
    ...(result.providerState !== undefined ? { providerState: result.providerState } : {}),
    stopReason: result.stopReason,
    sys: s.systemHash,
  })) as AssistantRecord;
  for (const c of recorded.slice(AGENT_MAX_CALLS_PER_TURN)) {
    await transcript.append({ kind: 'result', turn, toolUseId: c.id, name: c.name, content: NOT_EXECUTED_TOO_MANY, isError: true, summary: `${c.name} (not executed)` });
  }
  return { turn, record, calls };
}
