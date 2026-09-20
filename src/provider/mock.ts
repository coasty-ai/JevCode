/**
 * Scripted generator for unit tests, perf and the mocked bench (DESIGN.md §4 MockTurn).
 * Deterministic: no network, no retry, no randomness; latency only when a turn asks for it.
 */
import { ProviderHttpError } from '../errors.js';
import type { GenerateOptions, GenerateRequest, GenerateResult, MockProviderOptions, MockTurn, Provider, TokenUsage } from '../core/types.js';
import { monotonicNow, sleep as defaultSleep } from '../core/time.js';

export const MOCK_DEFAULT_USAGE: TokenUsage = { inputTokens: 1000, outputTokens: 200, costUsd: 0, calls: 1 };

export interface MockProviderDeps {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

function nextTurn(opts: MockProviderOptions, req: GenerateRequest, index: number): MockTurn {
  if (typeof opts.turns === 'function') return opts.turns(req, index);
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
      const turn = nextTurn(opts, req, index);
      const t0 = now();
      if (turn.error) {
        throw new ProviderHttpError(`mock provider: scripted HTTP ${turn.error.status}`, { status: turn.error.status, retryable: turn.error.retryable });
      }
      const text = turn.text ?? '';
      const pieces = chunks(text, opts.deltaChunkSize);
      const latency = turn.latencyMs ?? 0;
      // Spread the scripted latency evenly so the TUI sees a stream, not a burst after a pause.
      const perPiece = pieces.length > 0 ? latency / pieces.length : latency;
      if (pieces.length === 0 && latency > 0) await sleep(latency, genOpts.signal);
      for (const piece of pieces) {
        if (perPiece > 0) await sleep(perPiece, genOpts.signal);
        if (genOpts.signal.aborted) throw genOpts.signal.reason;
        genOpts.onDelta?.(piece);
      }
      const toolCalls = turn.toolCall ? [{ name: turn.toolCall.name, input: turn.toolCall.input, rawJson: turn.toolCall.rawJson || JSON.stringify(turn.toolCall.input) }] : [];
      if (turn.toolCall) genOpts.onToolDelta?.(toolCalls[0]!.rawJson);
      const usage: TokenUsage = { ...MOCK_DEFAULT_USAGE, ...turn.usage };
      return {
        text,
        toolCalls,
        usage,
        model,
        stopReason: turn.toolCall ? 'tool_use' : 'end_turn',
        latencyMs: Math.max(latency, Math.round(now() - t0)),
      };
    },
  };
}
