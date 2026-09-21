/**
 * `<runDir>/steps.jsonl` → the per-run synthesizer facts of docs/LLM-JEV-DESIGN.md §10.4 that the frozen BenchTaskRecord
 * cannot carry: the `synthMs` bucket (§7.5), the `StepRecord.verify` counts (samples, distinct, malformed, timeouts,
 * cancelled, misanchored, candidatesTested, passers, partials, graceMs, localisationMissed) summed over the run's steps,
 * and the steps the generic fallback proposed (§9.4). Rows are read loosely — only the fields summed here are
 * dereferenced — so a run written by an older engine (no `verify`, no `synthMs`) contributes zeros, never an error.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isFiniteNumber, isJsonObject, parseJson } from '../core/json.js';
import type { JsonObject } from '../core/types.js';
import type { StepsSummary } from './types.js';

export const STEPS_FILE = 'steps.jsonl';

export function emptyStepsSummary(): StepsSummary {
  return { steps: 0, synthSteps: 0, synthMs: 0, genericSteps: 0, verify: { samples: 0, distinct: 0, malformed: 0, timeouts: 0, cancelled: 0, misanchored: 0, candidatesTested: 0, passers: 0, partials: 0, graceMs: 0, localisationMissed: 0 } };
}

const VERIFY_COUNTS = ['samples', 'distinct', 'malformed', 'timeouts', 'cancelled', 'misanchored', 'candidatesTested', 'passers', 'partials', 'graceMs'] as const;

/** One committed step's contribution (a non-object or field-less row counts as a step and nothing else). */
export function addStepRow(s: StepsSummary, row: JsonObject): void {
  s.steps += 1;
  const timing = row['timing'];
  if (isJsonObject(timing) && isFiniteNumber(timing['synthMs'])) {
    s.synthSteps += 1;
    s.synthMs += timing['synthMs'];
  }
  if (row['proposer'] === 'generic') s.genericSteps += 1;
  const verify = row['verify'];
  if (!isJsonObject(verify)) return;
  for (const k of VERIFY_COUNTS) {
    const v = verify[k];
    if (isFiniteNumber(v)) s.verify[k] += v;
  }
  if (verify['localisationMissed'] === true) s.verify.localisationMissed += 1;
}

/** Every well-formed line of a steps.jsonl (a torn last line is skipped). */
export function summariseStepRows(text: string): StepsSummary {
  const s = emptyStepsSummary();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parsed = parseJson(line);
    if (parsed.ok && isJsonObject(parsed.value)) addStepRow(s, parsed.value);
  }
  return s;
}

/** The run's summary, or null when the run wrote no steps.jsonl. */
export async function readStepsSummary(runDir: string): Promise<StepsSummary | null> {
  let text: string;
  try {
    text = await readFile(join(runDir, STEPS_FILE), 'utf8');
  } catch {
    return null;
  }
  return summariseStepRows(text);
}

export function mergeStepsSummaries(parts: readonly StepsSummary[]): StepsSummary {
  const s = emptyStepsSummary();
  for (const p of parts) {
    s.steps += p.steps;
    s.synthSteps += p.synthSteps;
    s.synthMs += p.synthMs;
    s.genericSteps += p.genericSteps;
    for (const k of VERIFY_COUNTS) s.verify[k] += p.verify[k];
    s.verify.localisationMissed += p.verify.localisationMissed;
  }
  return s;
}
