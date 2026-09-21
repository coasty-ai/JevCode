/**
 * `<runDir>/generator.jsonl` → the per-call summary of docs/LLM-JEV-DESIGN.md §10.4 (calls, samples, valid, malformed,
 * length stops, cancelled / timed-out, tokens, $, estimated $, latency quantiles). One definition of "valid" for every
 * arm and for the §1.2 baseline table (`experiments/llm-jev/baseline-table.mts` reuses this module): not malformed ∧ not
 * cancelled ∧ `stopReason` neither a length stop nor `timeout`. Raw latencies travel with the summary so a per-condition
 * aggregate takes exact quantiles over the concatenation instead of averaging per-run medians.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isFiniteNumber, isJsonObject, isString, parseJson } from '../core/json.js';
import { percentile } from '../core/time.js';
import type { GeneratorCallRecord } from '../core/types.js';
import { isLengthStop } from '../synth/llm/schema.js';
import type { GeneratorCallsSummary, LatencySummary } from './types.js';

export const GENERATOR_FILE = 'generator.jsonl';

/** Shape check for one generator.jsonl row: the fields the summary dereferences. */
export function isGeneratorCallRecord(v: unknown): v is GeneratorCallRecord {
  if (!isJsonObject(v)) return false;
  if (!isFiniteNumber(v['step']) || !isFiniteNumber(v['latencyMs']) || !isString(v['stopReason']) || typeof v['malformed'] !== 'boolean' || !isString(v['model'])) return false;
  const usage = v['usage'];
  return isJsonObject(usage) && isFiniteNumber(usage['inputTokens']) && isFiniteNumber(usage['outputTokens']) && isFiniteNumber(usage['costUsd']);
}

/** Every well-formed line; malformed or torn lines are skipped (a crash mid-append is not a reason to lose the run). */
export function parseGeneratorRecords(text: string): GeneratorCallRecord[] {
  const out: GeneratorCallRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parsed = parseJson(line);
    if (parsed.ok && isGeneratorCallRecord(parsed.value)) out.push(parsed.value);
  }
  return out;
}

/** The run's rows, `[]` when the run wrote no generator.jsonl (jev-only, or a run that never reached the generator). */
export async function readGeneratorRecords(runDir: string): Promise<GeneratorCallRecord[]> {
  let text: string;
  try {
    text = await readFile(join(runDir, GENERATOR_FILE), 'utf8');
  } catch {
    return [];
  }
  return parseGeneratorRecords(text);
}

export function latencySummary(xs: readonly number[]): LatencySummary {
  return { n: xs.length, p50: percentile(xs, 50), p90: percentile(xs, 90), max: xs.length === 0 ? null : Math.max(...xs) };
}

/** A dropped call: the engine's cancelled estimate (§4.8) or the tuned provider's `timeout` stand-in. */
export function isDroppedCall(r: GeneratorCallRecord): boolean {
  return r.cancelled === true || r.stopReason === 'timeout';
}

/** §1.2: valid = not malformed ∧ not dropped ∧ not a length stop. */
export function isValidCall(r: GeneratorCallRecord): boolean {
  return !r.malformed && !isDroppedCall(r) && !isLengthStop(r.stopReason);
}

export function emptyGeneratorSummary(): GeneratorCallsSummary {
  return {
    calls: 0,
    samples: 0,
    valid: 0,
    malformed: 0,
    lengthStops: 0,
    cancelled: 0,
    timeouts: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    estimatedUsd: 0,
    latencyMs: latencySummary([]),
    validLatencyMs: latencySummary([]),
    latencyRawMs: [],
    validLatencyRawMs: [],
  };
}

export function summariseGeneratorRecords(rows: readonly GeneratorCallRecord[]): GeneratorCallsSummary {
  const s = emptyGeneratorSummary();
  for (const r of rows) {
    s.calls += 1;
    if (r.sample !== undefined) s.samples += 1;
    if (r.malformed) s.malformed += 1;
    if (isLengthStop(r.stopReason)) s.lengthStops += 1;
    if (isDroppedCall(r)) s.cancelled += 1;
    if (r.stopReason === 'timeout') s.timeouts += 1;
    s.inputTokens += r.usage.inputTokens;
    s.outputTokens += r.usage.outputTokens;
    s.reasoningTokens += r.reasoningTokens ?? r.usage.reasoningTokens ?? 0;
    const cost = Number.isFinite(r.usage.costUsd) ? r.usage.costUsd : 0;
    s.costUsd += cost;
    if (r.usage.estimated === true) s.estimatedUsd += cost;
    s.latencyRawMs.push(r.latencyMs);
    if (isValidCall(r)) {
      s.valid += 1;
      s.validLatencyRawMs.push(r.latencyMs);
    }
  }
  s.latencyMs = latencySummary(s.latencyRawMs);
  s.validLatencyMs = latencySummary(s.validLatencyRawMs);
  return s;
}

/** Counts summed, quantiles recomputed over the concatenated raw latencies. */
export function mergeGeneratorSummaries(parts: readonly GeneratorCallsSummary[]): GeneratorCallsSummary {
  const s = emptyGeneratorSummary();
  for (const p of parts) {
    s.calls += p.calls;
    s.samples += p.samples;
    s.valid += p.valid;
    s.malformed += p.malformed;
    s.lengthStops += p.lengthStops;
    s.cancelled += p.cancelled;
    s.timeouts += p.timeouts;
    s.inputTokens += p.inputTokens;
    s.outputTokens += p.outputTokens;
    s.reasoningTokens += p.reasoningTokens;
    s.costUsd += p.costUsd;
    s.estimatedUsd += p.estimatedUsd;
    s.latencyRawMs.push(...p.latencyRawMs);
    s.validLatencyRawMs.push(...p.validLatencyRawMs);
  }
  s.latencyMs = latencySummary(s.latencyRawMs);
  s.validLatencyMs = latencySummary(s.validLatencyRawMs);
  return s;
}

/**
 * §1.2 / §10.2 item 1: the latency fit `latency ≈ a + b × output_tokens` over valid calls by least squares — `a` is the
 * intercept the ladder run says may dominate (≈ 15 s), `b` the ms per output token. Null with fewer than two points or no
 * variance in the output length.
 */
export function latencyFit(rows: readonly GeneratorCallRecord[]): { a: number; b: number; n: number } | null {
  const pts = rows.filter(isValidCall).map((r) => ({ x: r.usage.outputTokens + (r.reasoningTokens ?? r.usage.reasoningTokens ?? 0), y: r.latencyMs }));
  if (pts.length < 2) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b, n: pts.length };
}
