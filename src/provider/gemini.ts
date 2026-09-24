/**
 * Google Gemini client over raw fetch + SSE — `POST /v1beta/models/{model}:streamGenerateContent?alt=sse`, the
 * generateContent surface (ai.google.dev/api/generate-content; the top-level guides now document the newer stateful
 * Interactions API, but the wire format below is the one the "legacy, fully supported" reference specifies).
 *
 * Shape differences from every other provider here, all of them handled in this file:
 *  - the system prompt is the top-level `systemInstruction`, and `contents[].role` may only be `user` or `model`
 *    (an `assistant` turn is renamed; a `system` role inside `contents` is a 400).
 *  - ONE `tools` entry holds MANY `functionDeclarations`, and the tool choice lives in
 *    `toolConfig.functionCallingConfig` (`ANY` + `allowedFunctionNames` is the forced call).
 *  - there is no `strict` flag: `mode: ANY` is the schema-adherence mechanism. `parametersJsonSchema` takes standard
 *    JSON Schema, but `oneOf` is silently ignored, so the schema goes through `geminiToolSchema` (oneOf → anyOf).
 *  - tool arguments arrive as a JSON OBJECT in one part (`functionCall.args`), not as a string of streamed fragments:
 *    `onToolDelta` therefore fires once with the serialised object.
 *  - thinking is configured by `thinkingConfig.thinkingLevel` (Gemini 3+) or `thinkingBudget` (2.5), never both, and
 *    cannot be switched off on a Gemini 3 model — `{enabled: false}` becomes the lowest level the family accepts.
 *  - a blocked prompt comes back as HTTP 200 with `promptFeedback.blockReason` and no candidates; usage lives in
 *    `usageMetadata` (`thoughtsTokenCount` is billed as output but is NOT inside `candidatesTokenCount`).
 *  - `?alt=sse` is mandatory: without it the endpoint streams a JSON array instead of SSE. There is no `[DONE]` line.
 *
 * NOT VERIFIED LIVE: this project's `GEMINI_API_KEY` answers 403 `PERMISSION_DENIED` / `API_KEY_SERVICE_BLOCKED` for
 * `generativelanguage.googleapis.com` (the API is disabled for its project), for both the native and the OpenAI-compat
 * shim, so every shape here comes from the reference docs and the unit fixtures are hand-built to them. The error path,
 * by contrast, IS live-verified: `test/fixtures/provider/gemini-403-blocked.json` is that recorded 403.
 */
import { ProviderHttpError } from '../errors.js';
import { isJsonObject } from '../core/json.js';
import type { AgentRequest, GenerateOptions, GenerateReasoning, GenerateRequest, GenerateResult, JsonObject, ToolCall, ToolChoice } from '../core/types.js';
import { geminiToolSchema } from './schema.js';
import { EMPTY_TURN_TEXT, SYNTH_CALL_PREFIX, agentCallId, agentReasoning, assistantParts, createCaller, emitToolCall, getJson, googleErrorFields, joinUrl, objectInput, replayData, runGeneration, userParts, validateGenerateRequest, withUniqueCallIds } from './http.js';
import type { ConsumeContext, HeldPartial } from './http.js';
import type { EffortWord } from './openai-compat.js';
import { effortOf, pickEffort } from './openai-compat.js';
import { TransportError, clipMessage, countOf, getArr, getNum, getObj, getStr, isRateLimit, notify, parseJsonObject, parseSse, resolveDeps, sanitiseRequestId } from './sse.js';
import type { GenerationProvider, ModelInfo, ProviderConfig, ProviderDeps, ProviderOutcome, StreamPartial, TokenBreakdown } from './types.js';

import { PROVIDER_BASE_URL, PROVIDER_DEFAULT_MODEL } from './ids.js';
export const GEMINI_BASE_URL = PROVIDER_BASE_URL.gemini;
/** ai.google.dev/gemini-api/docs/models: GA since Sep 2026, 1,048,576 in / 65,536 out, $0.75/$3.75 per 1M. */
export const GEMINI_DEFAULT_MODEL = PROVIDER_DEFAULT_MODEL.gemini;

// ---------------------------------------------------------------------------------------
// Wire types (request side)
// ---------------------------------------------------------------------------------------

export type GeminiTextPart = { text: string; thoughtSignature?: string };
/** AGENT-LOOP-DESIGN §6.2: a model turn's call (id and `thoughtSignature` resent exactly) and a user turn's result by id */
export type GeminiFunctionCallPart = { functionCall: { id?: string; name: string; args: JsonObject }; thoughtSignature?: string };
export type GeminiFunctionResponsePart = { functionResponse: { id?: string; name: string; response: JsonObject } };
export type GeminiContent = { role: 'user' | 'model'; parts: (GeminiTextPart | GeminiFunctionCallPart | GeminiFunctionResponsePart)[] };
export type GeminiFunctionDeclaration = { name: string; description: string; parametersJsonSchema: JsonObject };
export type GeminiToolWire = { functionDeclarations: GeminiFunctionDeclaration[] };
export type GeminiFunctionCallingMode = 'AUTO' | 'ANY' | 'NONE';
export type GeminiToolConfig = { functionCallingConfig: { mode: GeminiFunctionCallingMode; allowedFunctionNames?: string[] } };
/** Mutually exclusive: a level (Gemini 3+) or a budget (2.5, and accepted on 3.x for backward compatibility). */
export type GeminiThinkingConfig = { thinkingLevel: string } | { thinkingBudget: number };
export type GeminiGenerationConfig = {
  maxOutputTokens: number;
  temperature?: number;
  seed?: number;
  /** agent requests on a thinking family add `includeThoughts: true`: the `thought: true` summary parts `onReasoning` streams */
  thinkingConfig?: GeminiThinkingConfig | (Partial<GeminiThinkingConfig> & { includeThoughts: true });
};
export type GeminiRequestBody = {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiTextPart[] };
  tools?: GeminiToolWire[];
  toolConfig?: GeminiToolConfig;
  generationConfig: GeminiGenerationConfig;
};

// ---------------------------------------------------------------------------------------
// Thinking configuration per family
// ---------------------------------------------------------------------------------------

const LEVELS_38: readonly EffortWord[] = ['low', 'medium', 'high'];
const LEVELS_35: readonly EffortWord[] = ['minimal', 'low', 'medium', 'high'];

/** The `thinkingLevel` words a Gemini 3 id accepts, or null for a 2.5-era id (which takes a `thinkingBudget` instead). */
export function geminiThinkingLevels(model: string): readonly EffortWord[] | null {
  if (/^gemini-3\.(8|7)/.test(model)) return LEVELS_38;
  if (/^gemini-3\.1-pro/.test(model)) return LEVELS_38;
  if (/^gemini-3/.test(model)) return LEVELS_35;
  return null;
}

/** ai.google.dev/gemini-api/docs/openai: the shim's own effort → budget mapping, reused for the 2.5 family. */
type BudgetWord = 'none' | 'minimal' | 'low' | 'medium' | 'high';
const BUDGET_BY_EFFORT: Readonly<Record<BudgetWord, number>> = { none: 0, minimal: 1024, low: 1024, medium: 8192, high: 24_576 };
/** The words that table prices, as an `allowed` set: a requested effort it lacks (`xhigh`, `max`) resolves through `EFFORT_CHAINS` like everywhere else — down to `high`, never up to a near-minimum budget. */
const BUDGET_LEVELS: readonly BudgetWord[] = ['none', 'minimal', 'low', 'medium', 'high'];

/** The 2.5-family thinking budget for a requested effort word, resolved through the shared substitution chain. Exported for the test that pins the chain (core's `ReasoningEffort` cannot spell `xhigh` / `max` yet). */
export function geminiThinkingBudget(wanted: EffortWord): number {
  return BUDGET_BY_EFFORT[pickEffort(wanted, BUDGET_LEVELS) ?? 'low'];
}

/**
 * LLM-JEV-DESIGN §4.12 → `thinkingConfig`. Gemini 3: a level, with `{enabled: false}` becoming the lowest the family
 * accepts (thinking cannot be disabled there). Gemini 2.5: a budget — 0 disables it on flash / flash-lite, while
 * gemini-2.5-pro has a floor of 128. `{maxTokens}` is always a budget, and never sent together with a level.
 */
export function geminiThinkingConfig(r: GenerateReasoning, model: string): GeminiThinkingConfig | null {
  if ('maxTokens' in r) return { thinkingBudget: r.maxTokens };
  const wanted = effortOf(r);
  if (wanted === null) return null;
  const levels = geminiThinkingLevels(model);
  if (levels !== null) {
    const level = pickEffort(wanted, levels);
    return level === null ? null : { thinkingLevel: level };
  }
  const budget = geminiThinkingBudget(wanted);
  if (/^gemini-2\.5-pro/.test(model)) return { thinkingBudget: Math.max(128, budget) };
  return { thinkingBudget: budget };
}

/** Exported so tests can assert the exact wire body. */
export function buildGeminiBody(cfg: ProviderConfig, req: GenerateRequest): GeminiRequestBody {
  const a = req.agent;
  const body: GeminiRequestBody = {
    contents: a !== undefined ? agentContents(cfg, a) : req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: req.maxTokens },
  };
  if (req.system.length > 0) body.systemInstruction = { parts: [{ text: req.system }] };
  if (req.tools && req.tools.length > 0) {
    body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: geminiToolSchema(t.inputSchema) })) }];
    if (req.toolChoice !== undefined) body.toolConfig = { functionCallingConfig: geminiToolChoice(req.toolChoice) };
  }
  if (req.temperature !== null) body.generationConfig.temperature = req.temperature;
  if (req.seed !== undefined) body.generationConfig.seed = req.seed;
  const reasoning = a !== undefined ? agentReasoning(req) : req.reasoning;
  const thinking = reasoning === undefined ? null : geminiThinkingConfig(reasoning, cfg.model);
  // AGENT-LOOP-DESIGN §6.2: without `includeThoughts` the API sends no thought summaries, and `onReasoning` would never fire
  if (a !== undefined && geminiThinks(cfg.model)) body.generationConfig.thinkingConfig = { ...thinking, includeThoughts: true };
  else if (thinking !== null) body.generationConfig.thinkingConfig = thinking;
  return body;
}

/** The families with thinking (2.5 and 3.x), which accept `thinkingConfig.includeThoughts`. */
export function geminiThinks(model: string): boolean {
  return /^gemini-(2\.5|[3-9])/.test(model);
}

/**
 * Google's documented stand-in for a missing `thoughtSignature` (ai.google.dev/gemini-api/docs/thought-signatures, "if you
 * inject function calls … use the dummy signature"). Gemini 3 validates the first `functionCall` of every model turn of the
 * current turn, and a replay without the model's own signature — replay off after §6.5's fallback, a resume on another
 * model — is otherwise a 400.
 */
export const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator';

/** A call id as the wire knows it: none for an id this harness made up (the model sent none), else the model's own. */
function wireId(id: string): { id?: string } {
  return id.startsWith(SYNTH_CALL_PREFIX) ? {} : { id };
}

/**
 * AGENT-LOOP-DESIGN §6.2, Gemini row: a model turn is its text and a `functionCall {id, name, args}` per call, each with the
 * `thoughtSignature` it came with (replay state of the same configured model: `data.calls[i]` for the i-th call,
 * `data.text` for the prose) — Gemini 3 answers a function-calling turn replayed without them with a 400, so a turn with
 * none gets `GEMINI_SKIP_SIGNATURE` on its first call there; an empty turn is `EMPTY_TURN_TEXT`. A user turn is
 * a `functionResponse {id, name, response}` per result, then its texts; `response` is `{output}` or, for a failed call,
 * `{error}` (the API reference's convention: "if the function call failed … the response can have an error key").
 */
function agentContents(cfg: ProviderConfig, a: AgentRequest): GeminiContent[] {
  const validated = geminiThinkingLevels(cfg.model) !== null;
  return a.messages.map((m): GeminiContent => {
    if (m.role === 'user') {
      const { results, texts } = userParts(m.content);
      return {
        role: 'user',
        parts: [
          ...results.map((r) => ({ functionResponse: { ...wireId(r.toolUseId), name: r.name, response: r.isError === true ? { error: r.content } : { output: r.content } } })),
          ...texts.map((text) => ({ text })),
        ],
      };
    }
    const { text, calls } = assistantParts(m.content);
    const data = replayData(a, m, 'gemini', cfg.model);
    const sigs = isJsonObject(data) && Array.isArray(data['calls']) ? data['calls'] : [];
    const textSig = isJsonObject(data) ? getStr(data, 'text') : null;
    const parts: GeminiContent['parts'] = [];
    if (text.length > 0) parts.push({ text, ...(textSig !== null ? { thoughtSignature: textSig } : {}) });
    // parallel calls: only the first carries a signature, so the stand-in goes there, and only when no call has its own
    const signed = calls.some((_, i) => typeof sigs[i] === 'string');
    for (const [i, c] of calls.entries()) {
      const stored = sigs[i];
      const sig = typeof stored === 'string' ? stored : validated && !signed && i === 0 ? GEMINI_SKIP_SIGNATURE : null;
      parts.push({ functionCall: { ...wireId(c.id), name: c.name, args: objectInput(c.input) }, ...(sig !== null ? { thoughtSignature: sig } : {}) });
    }
    if (parts.length === 0) parts.push({ text: EMPTY_TURN_TEXT });
    return { role: 'model', parts };
  });
}

function geminiToolChoice(tc: ToolChoice): GeminiToolConfig['functionCallingConfig'] {
  if (tc === 'auto') return { mode: 'AUTO' };
  if (tc === 'required') return { mode: 'ANY' };
  // ANY + allowedFunctionNames is the forced single call (there is no `strict`: ANY provides the schema adherence)
  return { mode: 'ANY', allowedFunctionNames: [tc.name] };
}

// ---------------------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------------------

interface GeminiState {
  text: string;
  reasoningChars: number;
  toolChars: number;
  model: string | null;
  generationId: string | null;
  finishReason: string | null;
  toolCalls: ToolCall[];
  tokens: TokenBreakdown;
  reasoningTokens: number | null;
  sawUsage: boolean;
  /** AGENT-LOOP-DESIGN §6.1: the configured model when this is an agent request (ids kept, signatures captured); null for legacy */
  agentModel: string | null;
  /** agent: each call's `thoughtSignature` by ordinal, and the prose's */
  callSigs: (string | null)[];
  textSig: string | null;
}

function newState(agentModel: string | null): GeminiState {
  return {
    agentModel,
    callSigs: [],
    textSig: null,
    text: '',
    reasoningChars: 0,
    toolChars: 0,
    model: null,
    generationId: null,
    finishReason: null,
    toolCalls: [],
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    reasoningTokens: null,
    sawUsage: false,
  };
}

/** `promptFeedback.blockReason` on a 200 with no candidates: a terminal, non-retryable refusal to run the prompt. */
function blockedError(reason: string, redact: (s: string) => string, requestId: string | null): ProviderHttpError {
  return new ProviderHttpError(clipMessage(redact(`gemini: prompt blocked (${reason})`)), { status: 400, retryable: false, requestId });
}

/** `usageMetadata` is repeated on several chunks; the latest reading wins (the final one is complete). */
function readUsage(usage: JsonObject, st: GeminiState): void {
  st.sawUsage = true;
  const prompt = countOf(usage['promptTokenCount']);
  const cached = Math.min(countOf(usage['cachedContentTokenCount']), prompt);
  st.tokens.cacheRead = cached;
  // explicit cache creation is billed per hour, not per token: there is no cache-write token count on this API
  st.tokens.cacheWrite = 0;
  // `toolUsePromptTokenCount` is prompt-side (the tokens a built-in tool's prompt added, e.g. grounding) and is billed
  // at the input rate; it is NOT part of promptTokenCount, so it is added there rather than to the output.
  st.tokens.input = prompt - cached + countOf(usage['toolUsePromptTokenCount']);
  const thoughts = countOf(usage['thoughtsTokenCount']);
  st.reasoningTokens = thoughts;
  // candidatesTokenCount EXCLUDES thoughts, and both are billed at the output rate
  st.tokens.output = countOf(usage['candidatesTokenCount']) + thoughts;
}

function applyChunk(chunk: JsonObject, st: GeminiState, ctx: ConsumeContext): void {
  const blocked = getStr(getObj(chunk, 'promptFeedback'), 'blockReason');
  if (blocked !== null) throw blockedError(blocked, ctx.redact, ctx.requestId);
  st.model = getStr(chunk, 'modelVersion') ?? st.model;
  if (st.generationId === null) st.generationId = sanitiseRequestId(getStr(chunk, 'responseId'), ctx.redact);
  const usage = getObj(chunk, 'usageMetadata');
  if (usage) readUsage(usage, st);

  const candidates = getArr(chunk, 'candidates') ?? [];
  for (const c of candidates) {
    if (!isJsonObject(c)) continue;
    if ((getNum(c, 'index') ?? 0) !== 0) continue; // candidateCount is never raised above 1
    const finish = getStr(c, 'finishReason');
    if (finish !== null) st.finishReason = finish;
    const parts = getArr(getObj(c, 'content'), 'parts') ?? [];
    for (const p of parts) {
      if (!isJsonObject(p)) continue;
      const call = getObj(p, 'functionCall');
      const sig = st.agentModel !== null ? getStr(p, 'thoughtSignature') : null;
      if (call) {
        const name = getStr(call, 'name') ?? '';
        const args = getObj(call, 'args') ?? {};
        const rawJson = JSON.stringify(args);
        st.toolChars += rawJson.length;
        notify(ctx.opts.onToolDelta, rawJson);
        // A legacy request keeps neither `functionCall.id` nor the sibling `thoughtSignature` (its history is replayed as
        // text). AGENT-LOOP-DESIGN §6.2: an agent request keeps both and resends them exactly (ai.google.dev/.../thinking).
        const ordinal = st.toolCalls.length;
        const id = getStr(call, 'id') ?? '';
        emitToolCall(ctx.opts, ordinal, id, name, rawJson);
        st.toolCalls.push(st.agentModel !== null ? { name, input: args, rawJson, id: agentCallId(id, ordinal) } : { name, input: args, rawJson });
        if (st.agentModel !== null) st.callSigs.push(sig);
        continue;
      }
      if (sig !== null && p['thought'] !== true) st.textSig = sig;
      const text = getStr(p, 'text');
      if (text === null || text.length === 0) continue;
      if (p['thought'] === true) {
        st.reasoningChars += text.length; // a thought summary: measured for §4.8, never rendered (agent: streamed to `onReasoning`)
        notify(ctx.opts.onReasoning, text);
        continue;
      }
      st.text += text;
      notify(ctx.opts.onDelta, text);
    }
  }
}

/** STOP with a call is a tool stop; MAX_TOKENS is the vocabulary `isLengthStop` reads; anything else stays verbatim (lower-cased). */
function stopReasonOf(st: GeminiState): string {
  const raw = st.finishReason;
  if (raw === null || raw === 'STOP' || raw === 'FINISH_REASON_UNSPECIFIED') return st.toolCalls.length > 0 ? 'tool_calls' : 'stop';
  if (raw === 'MAX_TOKENS') return 'length';
  return raw.toLowerCase();
}

function heldOf(st: GeminiState): StreamPartial {
  return {
    text: st.text,
    toolChars: st.toolChars,
    reasoningChars: st.reasoningChars,
    model: st.model,
    generationId: st.generationId,
    servedProvider: null,
    tokens: st.sawUsage ? st.tokens : null,
    cost: null,
    reasoningTokens: st.reasoningTokens,
  };
}

async function consumeGemini(stream: ReadableStream<Uint8Array>, ctx: ConsumeContext, agentModel: string | null): Promise<ProviderOutcome> {
  const st = newState(agentModel);
  try {
    for await (const rec of parseSse(stream, { signal: ctx.opts.signal, firstByteTimeoutMs: ctx.firstByteTimeoutMs, ...(ctx.onFirstByte === undefined ? {} : { onFirstByte: ctx.onFirstByte }) })) {
      if (ctx.opts.signal.aborted) throw ctx.opts.signal.reason;
      const data = rec.data.trim();
      if (data.length === 0) continue;
      const parsed = parseJsonObject(data);
      if (parsed === null) throw new TransportError('invalid', clipMessage(ctx.redact('gemini: malformed sse data: not a JSON object')));
      applyChunk(parsed, st, ctx);
    }
  } catch (e) {
    if (ctx.opts.signal.aborted) {
      ctx.held.partial = heldOf(st);
      throw ctx.opts.signal.reason;
    }
    // A 429 delivered as a mid-stream error frame cut a stream that had already been served: keep its facts so the
    // chain's rate-limited record is what streamed, not zeros (http.ts `HeldPartial.streamed`).
    if (isRateLimit(e)) ctx.held.streamed = heldOf(st);
    throw e;
  }
  // There is no [DONE] sentinel: the stream simply ends. A stream that ended without the accounting frame was cut.
  if (!st.sawUsage) throw new TransportError('stream', 'gemini: stream ended without usageMetadata');
  return {
    text: st.text,
    toolCalls: st.toolCalls,
    tokens: st.tokens,
    cost: null,
    reasoningTokens: st.reasoningTokens,
    model: st.model,
    generationId: st.generationId,
    servedProvider: null,
    stopReason: stopReasonOf(st),
    ...(st.agentModel !== null && (st.textSig !== null || st.callSigs.some((s) => s !== null))
      ? { providerState: { provider: 'gemini', model: st.agentModel, data: { calls: st.callSigs, text: st.textSig } } }
      : {}),
  };
}

// ---------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------

export function createGeminiProvider(cfg: ProviderConfig, deps: ProviderDeps): GenerationProvider {
  const d = resolveDeps(deps);
  const caller = createCaller(d);
  // `models/x` is the resource path and `:streamGenerateContent` the RPC verb; `alt=sse` is what makes it Server-Sent Events.
  const url = `${joinUrl(cfg.baseUrl, '/models/')}${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`;

  return {
    name: 'gemini',
    model: cfg.model,
    async generate(req: GenerateRequest, opts: GenerateOptions): Promise<GenerateResult> {
      validateGenerateRequest('gemini', req);
      const body = JSON.stringify(buildGeminiBody(cfg, req));
      const agentModel = req.agent === undefined ? null : cfg.model;
      const attempt = (held: HeldPartial): Promise<ProviderOutcome> =>
        caller.attempt({ label: 'gemini', url, headers: { 'x-goog-api-key': cfg.apiKey }, body, readError: googleErrorFields, consume: (stream, ctx) => consumeGemini(stream, ctx, agentModel) }, opts, held);
      const res = await runGeneration(d, cfg, opts, attempt);
      return req.agent === undefined ? res : withUniqueCallIds(res, req.agent);
    },
  };
}

// ---------------------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------------------

/** ids on the text endpoint that are not text generators. */
const GEMINI_NON_TEXT = /(embedding|aqa|imagen|veo|tts|image|native-audio|live|learnlm|gemma)/;

export function geminiModelInfo(row: JsonObject): ModelInfo | null {
  const name = getStr(row, 'name');
  if (name === null) return null;
  const id = getStr(row, 'baseModelId') ?? (name.startsWith('models/') ? name.slice('models/'.length) : name);
  const methods = (getArr(row, 'supportedGenerationMethods') ?? []).filter((m): m is string => typeof m === 'string');
  if (!methods.includes('generateContent') || GEMINI_NON_TEXT.test(id)) return null;
  const display = getStr(row, 'displayName');
  const ctx = getNum(row, 'inputTokenLimit');
  const out = getNum(row, 'outputTokenLimit');
  const thinking = row['thinking'];
  return {
    id,
    ...(display !== null ? { displayName: display } : {}),
    ...(ctx !== null ? { contextTokens: Math.round(ctx) } : {}),
    ...(out !== null ? { maxOutputTokens: Math.round(out) } : {}),
    ...(typeof thinking === 'boolean' ? { reasoning: thinking } : {}),
  };
}

/** Paginated (`pageSize` ≤ 1000, `nextPageToken`); the page cap keeps a runaway token from looping forever. */
export async function listGeminiModels(apiKey: string, deps: ProviderDeps, baseUrl = GEMINI_BASE_URL, maxPages = 5): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `${joinUrl(baseUrl, '/models')}?pageSize=1000${pageToken === null ? '' : `&pageToken=${encodeURIComponent(pageToken)}`}`;
    const json = await getJson({ label: 'gemini', url, headers: { 'x-goog-api-key': apiKey }, deps, readError: googleErrorFields });
    for (const row of getArr(json, 'models') ?? []) {
      if (!isJsonObject(row)) continue;
      const info = geminiModelInfo(row);
      if (info) out.push(info);
    }
    pageToken = getStr(json, 'nextPageToken');
    if (pageToken === null || pageToken.length === 0) break;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
