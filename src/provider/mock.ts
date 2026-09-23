/**
 * Scripted generator for unit tests, perf and the mocked bench (DESIGN.md §4 MockTurn).
 * Deterministic: no network, no retry, no randomness; latency only when a turn asks for it.
 * LLM-JEV-DESIGN stage 3 tests script N samples of one round: a function-form `turns` receives the
 * per-call options as a third argument and keys on `opts.sample`; a turn may set the stop reason
 * (`length`), reasoning tokens and a generation id. Text and then the tool-argument JSON stream in
 * `deltaChunkSize` pieces, so a signal can land mid-arguments and `onCancelled` reports the streamed
 * facts exactly as the HTTP providers do (§4.8; the estimate itself is the engine's).
 */
import { ProviderHttpError } from '../errors.js';
import type { CancelledGeneration, GenerateOptions, GenerateRequest, GenerateResult, MockProviderOptions, MockTurn, Provider, TokenUsage } from '../core/types.js';
import { monotonicNow, sleep as defaultSleep } from '../core/time.js';

export const MOCK_DEFAULT_USAGE: TokenUsage = { inputTokens: 1000, outputTokens: 200, costUsd: 0, calls: 1 };

/** the deterministic answer a `--mock` chat turn gets (a chat request offers no tools, so it is never a step of the trajectory) */
export const MOCK_CHAT_REPLY = "Hi. I'm JevCode (mock reply).";

/**
 * `--mock` turns: the scripted trajectory for the run loop, `MOCK_CHAT_REPLY` for a chat request (no tools offered),
 * which consumes no scripted turn — so a conversation before or between runs leaves the trajectory where it was.
 */
export function withMockChat(turns: readonly MockTurn[], reply: string = MOCK_CHAT_REPLY): (req: GenerateRequest) => MockTurn {
  let i = 0;
  return (req: GenerateRequest): MockTurn => {
    if (req.tools === undefined || req.tools.length === 0) return { text: reply };
    const turn = turns[i++];
    if (turn === undefined) throw new ProviderHttpError(`mock provider: no scripted turn for call ${i} (have ${turns.length})`, { status: 0, retryable: false });
    return turn;
  };
}

export interface MockProviderDeps {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
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

export function createMockProvider(opts: MockProviderOptions, deps: MockProviderDeps = {}): Provider {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? monotonicNow;
  const model = opts.model ?? 'mock';
  let calls = 0;

  return {
    name: 'mock',
    model,
    async generate(req: GenerateRequest, genOpts: GenerateOptions): Promise<GenerateResult> {
      if (genOpts.signal.aborted) throw genOpts.signal.reason;
      const index = calls++;
      const turn = nextTurn(opts, req, index, genOpts);
      const t0 = now();
      if (turn.error) {
        throw new ProviderHttpError(`mock provider: scripted HTTP ${turn.error.status}`, { status: turn.error.status, retryable: turn.error.retryable });
      }
      const text = turn.text ?? '';
      const rawJson = turn.toolCall ? turn.toolCall.rawJson || JSON.stringify(turn.toolCall.input) : '';
      const textPieces = chunks(text, opts.deltaChunkSize);
      const latency = turn.latencyMs ?? 0;
      // Spread the scripted latency evenly over the text deltas so the TUI sees a stream, not a burst after a pause; the
      // tool-argument pieces follow the text without delay (the wire order), chunked so a signal can land inside them.
      const perPiece = textPieces.length > 0 ? latency / textPieces.length : latency;
      let streamedText = '';
      let toolChars = 0;
      try {
        if (textPieces.length === 0 && latency > 0) await sleep(latency, genOpts.signal);
        for (const piece of textPieces) {
          if (perPiece > 0) await sleep(perPiece, genOpts.signal);
          if (genOpts.signal.aborted) throw genOpts.signal.reason;
          streamedText += piece;
          genOpts.onDelta?.(piece);
        }
        for (const piece of chunks(rawJson, opts.deltaChunkSize)) {
          if (genOpts.signal.aborted) throw genOpts.signal.reason;
          toolChars += piece.length;
          genOpts.onToolDelta?.(piece);
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
      const toolCalls = turn.toolCall ? [{ name: turn.toolCall.name, input: turn.toolCall.input, rawJson }] : [];
      const usage: TokenUsage = { ...MOCK_DEFAULT_USAGE, ...turn.usage };
      return {
        text,
        toolCalls,
        usage,
        model,
        stopReason: turn.stopReason ?? (turn.toolCall ? 'tool_use' : 'end_turn'),
        latencyMs: Math.max(latency, Math.round(now() - t0)),
        ...(turn.generationId !== undefined ? { generationId: turn.generationId } : {}),
      };
    },
  };
}
