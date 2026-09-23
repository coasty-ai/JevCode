/**
 * Scripted generator for unit tests, perf and the mocked bench (DESIGN.md §4 MockTurn).
 * Deterministic: no network, no retry, no randomness; latency only when a turn asks for it.
 * LLM-JEV-DESIGN stage 3 tests script N samples of one round: a function-form `turns` receives the
 * per-call options as a third argument and keys on `opts.sample`; a turn may set the stop reason
 * (`length`), reasoning tokens and a generation id. Text and then the tool-argument JSON stream in
 * `deltaChunkSize` pieces, so a signal can land mid-arguments and `onCancelled` reports the streamed
 * facts exactly as the HTTP providers do (§4.8; the estimate itself is the engine's).
 *
 * A turn with `deltas` streams exactly those pieces, one per `deltaGapMs`, paced against deadlines (`t0 + latencyMs +
 * (i + 1) · gap`): a late wake-up (macOS timer coalescing, a busy loop) shortens the next wait instead of pushing every
 * later delta back, and nothing spins — this runs inside the TUI process whose paint latency the stream probe measures
 * (`src/perf/stream-latency.ts`). `onEmit` sees each timed delta's `process.hrtime.bigint()` just before `onDelta`; an
 * untimed turn (the run trajectory, the default chat reply) never reaches it, so one `i === 0` is one timed stream.
 */
import { ProviderHttpError } from '../errors.js';
import type { CancelledGeneration, GenerateOptions, GenerateRequest, GenerateResult, MockProviderOptions, MockTurn, Provider, TokenUsage, ToolCall } from '../core/types.js';
import { monotonicNow, sleep as defaultSleep } from '../core/time.js';

export const MOCK_DEFAULT_USAGE: TokenUsage = { inputTokens: 1000, outputTokens: 200, costUsd: 0, calls: 1 };

/** the deterministic answer a `--mock` chat turn gets (a chat request offers no tools, so it is never a step of the trajectory) */
export const MOCK_CHAT_REPLY = "Hi. I'm JevCode (mock reply).";

/** one `MockProviderOptions.onEmit` record: the delta's index in its turn, its length, `process.hrtime.bigint()` at emission */
export type MockEmit = Parameters<NonNullable<MockProviderOptions['onEmit']>>[0];

/**
 * `--mock` turns: the scripted trajectory for the run loop, `MOCK_CHAT_REPLY` for a chat request (no tools offered),
 * which consumes no scripted turn — so a conversation before or between runs leaves the trajectory where it was.
 * `reply` may be a whole turn (the stream probe's timed `deltas`, `src/cli/mock-trajectory.ts` `mockChatReplyFromEnv`).
 */
export function withMockChat(turns: readonly MockTurn[], reply: string | MockTurn = MOCK_CHAT_REPLY): (req: GenerateRequest) => MockTurn {
  let i = 0;
  return (req: GenerateRequest): MockTurn => {
    if (req.tools === undefined || req.tools.length === 0) return typeof reply === 'string' ? { text: reply } : reply;
    const turn = turns[i++];
    if (turn === undefined) throw new ProviderHttpError(`mock provider: no scripted turn for call ${i} (have ${turns.length})`, { status: 0, retryable: false });
    return turn;
  };
}

export interface MockProviderDeps {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** the emission clock handed to `onEmit` (default `process.hrtime.bigint`, which shares a base with the typist's CLOCK_MONOTONIC_RAW record) */
  hrtimeNs?: () => bigint;
  /**
   * AGENT-LOOP-DESIGN §6.2 Mock: keep a copy of every request in `requests` (tests). Off by default, so a long `--mock`
   * session, the bench and the perf harness hold no transcripts and pay no copy.
   */
  recordRequests?: boolean;
}

function nextTurn(opts: MockProviderOptions, req: GenerateRequest, index: number, genOpts: GenerateOptions): MockTurn {
  if (typeof opts.turns === 'function') return opts.turns(req, index, genOpts);
  const turn = opts.turns[index];
  if (turn === undefined) {
    throw new ProviderHttpError(`mock provider: no scripted turn for call ${index + 1} (have ${opts.turns.length})`, { status: 0, retryable: false });
  }
  return turn;
}

function chunks(text: string, size: number | undefined): string[] {
  if (text.length === 0) return [];
  if (size === undefined || size <= 0 || size >= text.length) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * The mock with its request log (AGENT-LOOP-DESIGN §6.2 Mock: every request it was sent, in order, for assertions) — filled
 * only under `MockProviderDeps.recordRequests`, with a deep copy taken at the call, so a caller that keeps appending to
 * one `agent.messages` array cannot rewrite what an earlier call was sent.
 */
export type MockProvider = Provider & { readonly requests: readonly GenerateRequest[] };

export function createMockProvider(opts: MockProviderOptions, deps: MockProviderDeps = {}): MockProvider {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? monotonicNow;
  const hrtimeNs = deps.hrtimeNs ?? ((): bigint => process.hrtime.bigint());
  const model = opts.model ?? 'mock';
  let calls = 0;
  const requests: GenerateRequest[] = [];
  const record = deps.recordRequests === true;

  return {
    name: 'mock',
    model,
    requests,
    async generate(req: GenerateRequest, genOpts: GenerateOptions): Promise<GenerateResult> {
      if (record) requests.push(structuredClone(req));
      if (genOpts.signal.aborted) throw genOpts.signal.reason;
      const index = calls++;
      const turn = nextTurn(opts, req, index, genOpts);
      const t0 = now();
      if (turn.error) {
        throw new ProviderHttpError(`mock provider: scripted HTTP ${turn.error.status}`, { status: turn.error.status, retryable: turn.error.retryable });
      }
      const timed = turn.deltas !== undefined;
      const text = timed ? (turn.deltas ?? []).join('') : (turn.text ?? '');
      const rawJson = turn.toolCall ? turn.toolCall.rawJson || JSON.stringify(turn.toolCall.input) : '';
      // AGENT-LOOP-DESIGN §6.2 Mock: an agent turn's calls, each streamed per index after the legacy `toolCall`; ids kept on agent requests
      const agent = req.agent !== undefined;
      const many = (turn.toolCalls ?? []).map((c, i) => ({ ...c, rawJson: c.rawJson ?? JSON.stringify(c.input), id: c.id ?? `mock_call_${index + 1}_${i}` }));
      const offset = turn.toolCall ? 1 : 0;
      const textPieces = timed ? [...(turn.deltas ?? [])] : chunks(text, opts.deltaChunkSize);
      const latency = turn.latencyMs ?? 0;
      // Spread the scripted latency evenly over the text deltas so the TUI sees a stream, not a burst after a pause; the
      // tool-argument pieces follow the text without delay (the wire order), chunked so a signal can land inside them.
      // A timed turn (`deltas`) instead waits for each delta's deadline, `latencyMs` being its time to first byte.
      const perPiece = timed ? 0 : textPieces.length > 0 ? latency / textPieces.length : latency;
      const gap = timed ? Math.max(0, turn.deltaGapMs ?? 0) : 0;
      let deadline = t0 + latency;
      let streamedText = '';
      let toolChars = 0;
      try {
        if (textPieces.length === 0 && latency > 0) await sleep(latency, genOpts.signal);
        // §6.2 Mock: the scripted reasoning streams through `onReasoning` before the text
        for (const piece of chunks(turn.reasoning ?? '', opts.deltaChunkSize)) {
          if (genOpts.signal.aborted) throw genOpts.signal.reason;
          genOpts.onReasoning?.(piece);
        }
        for (const [i, piece] of textPieces.entries()) {
          if (timed) {
            deadline += gap;
            const wait = deadline - now();
            if (wait > 0) await sleep(wait, genOpts.signal);
          } else if (perPiece > 0) await sleep(perPiece, genOpts.signal);
          if (genOpts.signal.aborted) throw genOpts.signal.reason;
          streamedText += piece;
          if (timed) opts.onEmit?.({ i, chars: piece.length, ns: hrtimeNs() });
          genOpts.onDelta?.(piece);
        }
        for (const piece of chunks(rawJson, opts.deltaChunkSize)) {
          if (genOpts.signal.aborted) throw genOpts.signal.reason;
          toolChars += piece.length;
          genOpts.onToolDelta?.(piece);
        }
        for (const [i, c] of many.entries()) {
          for (const piece of chunks(c.rawJson, opts.deltaChunkSize)) {
            if (genOpts.signal.aborted) throw genOpts.signal.reason;
            toolChars += piece.length;
            genOpts.onToolDelta?.(piece);
            genOpts.onToolCall?.({ index: offset + i, id: c.id, name: c.name, fragment: piece });
          }
        }
      } catch (e) {
        if (genOpts.signal.aborted) {
          // §4.8 like the HTTP providers: the facts streamed so far (no estimate — that is the engine's), then the reason. One
          // exit for every abort path (the check above, a rejected sleep), so onCancelled fires exactly once; a throwing
          // callback propagates in place of the reason.
          const partial: CancelledGeneration = { text: streamedText, toolChars, reasoningChars: 0, model, ...(turn.generationId !== undefined ? { generationId: turn.generationId } : {}) };
          genOpts.onCancelled?.(partial);
          throw genOpts.signal.reason;
        }
        throw e;
      }
      const toolCalls: ToolCall[] = turn.toolCall ? [{ name: turn.toolCall.name, input: turn.toolCall.input, rawJson }] : [];
      for (const c of many) toolCalls.push(agent ? { name: c.name, input: c.input, rawJson: c.rawJson, id: c.id } : { name: c.name, input: c.input, rawJson: c.rawJson });
      const usage: TokenUsage = { ...MOCK_DEFAULT_USAGE, ...turn.usage };
      return {
        text,
        toolCalls,
        usage,
        model,
        stopReason: turn.stopReason ?? (toolCalls.length > 0 ? 'tool_use' : 'end_turn'),
        latencyMs: Math.max(latency, Math.round(now() - t0)),
        ...(turn.generationId !== undefined ? { generationId: turn.generationId } : {}),
        // §6.2 Mock: the scripted reasoning state, echoed under the mock's name and configured model (agent requests only)
        ...(agent && turn.providerState !== undefined ? { providerState: { provider: 'mock' as const, model, data: turn.providerState } } : {}),
      };
    },
  };
}
