/**
 * Scripted generator for unit tests, perf and the mocked bench (DESIGN.md §4 MockTurn).
 * Deterministic: no network, no retry, no randomness; latency only when a turn asks for it.
 * LLM-JEV-DESIGN stage 3 tests script N samples of one round: a function-form `turns` receives the
 * per-call options as a third argument and keys on `opts.sample`; a turn may set the stop reason
 * (`length`), reasoning tokens and a generation id.
 */
import { ProviderHttpError } from '../errors.js';
import type { GenerateRequest, MockProviderOptions, MockTurn, TokenUsage } from '../core/types.js';
import { monotonicNow, sleep as defaultSleep } from '../core/time.js';
import type { CancelledGeneration, GenerateOptionsExt, GenerateResultExt, ProviderExt, TokenUsageExt } from './types.js';

export const MOCK_DEFAULT_USAGE: TokenUsage = { inputTokens: 1000, outputTokens: 200, costUsd: 0, calls: 1 };

export interface MockProviderDeps {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/**
 * `MockTurn` plus the stage-2 result fields (provider/types.ts contract section). Optional, so every existing
 * `MockTurn` script is one. TODO(llm-jev merge): fold into core/types.ts `MockTurn` with the contract fields.
 */
export interface MockTurnExt extends MockTurn {
  usage?: Partial<TokenUsageExt>;
  /** overrides the derived `tool_use` / `end_turn` — e.g. `length` for a truncated sample (§4.7 drops it) */
  stopReason?: string;
  /** surfaced as `GenerateResult.generationId`, like OpenRouter's chunk id */
  generationId?: string;
}
/** Function-form script: `index` is the call counter, `opts` the caller's options (`opts.sample` keys N samples of one round). */
export type MockTurnFn = (req: GenerateRequest, index: number, opts: GenerateOptionsExt) => MockTurnExt;
export interface MockProviderOptionsExt extends Omit<MockProviderOptions, 'turns'> {
  turns: MockTurnExt[] | MockTurnFn;
}

function nextTurn(opts: MockProviderOptionsExt, req: GenerateRequest, index: number, genOpts: GenerateOptionsExt): MockTurnExt {
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

export function createMockProvider(opts: MockProviderOptionsExt, deps: MockProviderDeps = {}): ProviderExt {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? monotonicNow;
  const model = opts.model ?? 'mock';
  let calls = 0;

  return {
    name: 'mock',
    model,
    async generate(req: GenerateRequest, genOpts: GenerateOptionsExt): Promise<GenerateResultExt> {
      if (genOpts.signal.aborted) throw genOpts.signal.reason;
      const index = calls++;
      const turn = nextTurn(opts, req, index, genOpts);
      const t0 = now();
      if (turn.error) {
        throw new ProviderHttpError(`mock provider: scripted HTTP ${turn.error.status}`, { status: turn.error.status, retryable: turn.error.retryable });
      }
      const text = turn.text ?? '';
      const pieces = chunks(text, opts.deltaChunkSize);
      const latency = turn.latencyMs ?? 0;
      // Spread the scripted latency evenly so the TUI sees a stream, not a burst after a pause.
      const perPiece = pieces.length > 0 ? latency / pieces.length : latency;
      let streamed = '';
      // §4.8 like openrouter.ts: a signal that fires mid-stream hands the chars / 4 estimate to onCancelled, then rethrows its reason.
      const cancel = (): never => {
        const partial: CancelledGeneration = {
          usage: { inputTokens: MOCK_DEFAULT_USAGE.inputTokens, outputTokens: Math.ceil(streamed.length / 4), costUsd: 0, calls: 1, estimated: true },
          text: streamed,
          toolChars: 0,
          model,
          ...(turn.generationId !== undefined ? { generationId: turn.generationId } : {}),
        };
        genOpts.onCancelled?.(partial);
        throw genOpts.signal.reason;
      };
      try {
        if (pieces.length === 0 && latency > 0) await sleep(latency, genOpts.signal);
        for (const piece of pieces) {
          if (perPiece > 0) await sleep(perPiece, genOpts.signal);
          if (genOpts.signal.aborted) throw genOpts.signal.reason;
          streamed += piece;
          genOpts.onDelta?.(piece);
        }
      } catch (e) {
        // one exit for every abort path (the check above, a rejected sleep): onCancelled fires exactly once
        if (genOpts.signal.aborted) cancel();
        throw e;
      }
      const toolCalls = turn.toolCall ? [{ name: turn.toolCall.name, input: turn.toolCall.input, rawJson: turn.toolCall.rawJson || JSON.stringify(turn.toolCall.input) }] : [];
      if (turn.toolCall) genOpts.onToolDelta?.(toolCalls[0]!.rawJson);
      const usage: TokenUsageExt = { ...MOCK_DEFAULT_USAGE, ...turn.usage };
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
