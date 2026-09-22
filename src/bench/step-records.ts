/**
 * `<runDir>/steps.jsonl` → the per-run synthesizer facts of docs/LLM-JEV-DESIGN.md §10.4 that the frozen BenchTaskRecord
 * cannot carry: the `synthMs` bucket (§7.5), the `StepRecord.verify` counts (samples, distinct, malformed, timeouts,
 * cancelled, misanchored, candidatesTested, passers, partials, graceMs, localisationMissed) summed over the run's steps,
 * and the steps the generic fallback proposed (§9.4). Rows are read loosely — only the fields summed here are
 * dereferenced — so a run written by an older engine (no `verify`, no `synthMs`) contributes zeros, never an error; a row
 * without `verify` still contributes its proposal evidence's `candidatesTested` (the engines before 2026-09-21 wrote the
 * evidence but never the `verify` block, which is why every head-to-head record's `synth.verify` read all zeros).
 *
 * contract 1.9 (Fastlane), docs/LLM-LOOP-DESIGN.md §5.5: this module is ALSO the only bridge for the wave's own facts —
 * `StepRecord.fastPath`, `StepRecord.router`, `riskSource` and `jevUnavailable`. Without the folding below every one of
 * them is written into the run directory and is invisible to every bench table, and the five blocking rows of §8.3 read
 * zero for a reason that has nothing to do with the fast path.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isFiniteNumber, isJsonObject, parseJson } from '../core/json.js';
import type { JsonObject } from '../core/types.js';
import type { FastPathSummary, StepsSummary } from './types.js';

export const STEPS_FILE = 'steps.jsonl';

export function emptyFastPathSummary(): FastPathSummary {
  return { considered: 0, fired: 0, declined: 0, failed: 0, proposed: 0, refused: 0, timeouts: 0, reasons: {}, stage1Fired: 0, stage2Declined: 0, candidatesTested: 0, testRuns: 0, jevRequests: 0, wallMs: 0, budgetOverruns: 0 };
}

export function emptyStepsSummary(): StepsSummary {
  return {
    steps: 0,
    synthSteps: 0,
    synthMs: 0,
    genericSteps: 0,
    verify: { samples: 0, distinct: 0, malformed: 0, timeouts: 0, cancelled: 0, misanchored: 0, candidatesTested: 0, passers: 0, partials: 0, graceMs: 0, localisationMissed: 0 },
    fastPath: emptyFastPathSummary(),
    routers: { issued: 0, applied: 0, dropped: 0, maxWaitMs: 0 },
    risk: { codeVerdicts: 0, jevUnavailable: 0 },
    s2: { ttfbMs: [], hedges: 0, hedgeWins: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

const VERIFY_COUNTS = ['samples', 'distinct', 'malformed', 'timeouts', 'cancelled', 'misanchored', 'candidatesTested', 'passers', 'partials', 'graceMs'] as const;

/** contract 1.9 (Fastlane) §5.5: the `StepFastPath` counters summed straight across (`reasons` is a histogram, `wallMs` a total). */
const FASTPATH_COUNTS = ['candidatesTested', 'testRuns', 'jevRequests', 'wallMs'] as const;
const FASTPATH_TOTALS = ['considered', 'fired', 'declined', 'failed', 'proposed', 'refused', 'timeouts', 'stage1Fired', 'stage2Declined', 'budgetOverruns'] as const;

/**
 * contract 1.9 (Fastlane) §5.5 / §8.3: one step's `fastPath`, `router`, `riskSource` and `jevUnavailable` folded in. The
 * row is read as loosely as the rest of this module — a run written by an engine without route R9 has no `fastPath` key
 * and contributes nothing, which is the difference between "the arm declined every step" and "the arm was never armed",
 * and `considered` is the counter that tells them apart.
 */
function addWaveMembers(s: StepsSummary, row: JsonObject): void {
  const fp = row['fastPath'];
  if (isJsonObject(fp)) {
    const f = s.fastPath;
    f.considered += 1;
    const decision = fp['decision'];
    if (decision === 'fired') f.fired += 1;
    else if (decision === 'declined') f.declined += 1;
    else if (decision === 'failed') f.failed += 1;
    const outcome = fp['outcome'];
    if (outcome === 'proposed') f.proposed += 1;
    else if (outcome === 'refused') f.refused += 1;
    else if (outcome === 'timeout') f.timeouts += 1;
    // R-c: the ratio is stage-1-fired over stage-2-declined, so each stage is counted where the row says it stopped
    if (fp['stage'] === 1 && decision === 'fired') f.stage1Fired += 1;
    if (fp['stage'] === 2 && decision === 'declined') f.stage2Declined += 1;
    // R-d: the histogram is over INELIGIBLE steps (declined or failed) — a fired row's `reason` is not a decline and
    // counting it would dilute every share the 5 % error bar is measured against. Unknown reasons get their own bucket
    // rather than being dropped, so a `FastPathReason` the table has not heard of shows up as a failure, not as silence.
    const reason = fp['reason'];
    if ((decision === 'declined' || decision === 'failed') && typeof reason === 'string' && reason !== '') f.reasons[reason] = (f.reasons[reason] ?? 0) + 1;
    for (const k of FASTPATH_COUNTS) {
      const v = fp[k];
      if (isFiniteNumber(v)) f[k] += v;
    }
    // R-b: a fired step whose wall exceeded its own budget. Both numbers come off the same row, so a run whose budget
    // arithmetic changed mid-flight is still judged against the budget IT was given.
    const wall = fp['wallMs'];
    const budget = fp['budgetMs'];
    if (decision === 'fired' && isFiniteNumber(wall) && isFiniteNumber(budget) && wall > budget) f.budgetOverruns += 1;
  }
  const router = row['router'];
  if (isJsonObject(router)) {
    for (const k of ['issued', 'applied', 'dropped'] as const) {
      const v = router[k];
      if (isFiniteNumber(v)) s.routers[k] += v;
    }
    // R-a: the p95 of a quantity whose gate is "= 0" is its max; a single blocked step must not average away
    const wait = router['waitMs'];
    if (isFiniteNumber(wait) && wait > s.routers.maxWaitMs) s.routers.maxWaitMs = wait;
  }
  if (row['riskSource'] === 'code') s.risk.codeVerdicts += 1;
  if (row['jevUnavailable'] === true) s.risk.jevUnavailable += 1;
  // contract 1.9 (Fastlane) §3: the S2 members ride on the step's `verify` block (StepVerifySummary), not on a block of
  // their own, so they are folded here rather than in the VERIFY_COUNTS loop, which sums a fixed list of counters.
  const verify = row['verify'];
  if (isJsonObject(verify)) {
    const ttfb = verify['ttfbMs'];
    if (Array.isArray(ttfb)) for (const v of ttfb) if (isFiniteNumber(v)) s.s2.ttfbMs.push(v);
    for (const k of ['hedges', 'hedgeWins', 'cacheRead', 'cacheWrite'] as const) {
      const v = verify[k];
      if (isFiniteNumber(v)) s.s2[k] += v;
    }
  }
}

/** One committed step's contribution (a non-object or field-less row counts as a step and nothing else). */
export function addStepRow(s: StepsSummary, row: JsonObject): void {
  s.steps += 1;
  addWaveMembers(s, row);
  const timing = row['timing'];
  if (isJsonObject(timing) && isFiniteNumber(timing['synthMs'])) {
    s.synthSteps += 1;
    s.synthMs += timing['synthMs'];
  }
  if (row['proposer'] === 'generic') s.genericSteps += 1;
  const verify = row['verify'];
  if (!isJsonObject(verify)) {
    // an older engine's row: the committed decision's candidate count is on the proposal evidence (core/types.ts ProposalEvidence)
    const proposal = row['proposal'];
    const evidence = isJsonObject(proposal) ? proposal['evidence'] : undefined;
    const tested = isJsonObject(evidence) ? evidence['candidatesTested'] : undefined;
    if (isFiniteNumber(tested)) s.verify.candidatesTested += tested;
    return;
  }
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

/**
 * contract 1.9 (Fastlane) §5.5: one `StepsSummary` read back from a `tasks.jsonl`, normalised.
 *
 * The type says every part is there; the FILE is the authority, and every results dir written before this contract
 * carries `synth: { genericSteps, steps, synthMs, synthSteps, verify }` and none of the four wave blocks. `isRecord`
 * (runner.ts) never validates `synth`, so `--resume` parses one of those rows, accepts it, and hands it to the
 * end-of-bench summariser AFTER every run has been paid for — an unguarded `p.fastPath[k]` there is a crash that
 * destroys a finished bench. So each part is filled from the empty summary on the way in, the same way
 * `withTokenSeries` backfills an older token series, and a member that is not a finite number reads 0 rather than
 * poisoning every later sum with NaN.
 */
export function withWaveMembers(part: StepsSummary): StepsSummary {
  const s = emptyStepsSummary();
  if (!isJsonObject(part)) return s;
  const num = (o: JsonObject | undefined, k: string): number => {
    const v = o?.[k];
    return isFiniteNumber(v) ? v : 0;
  };
  const obj = (v: unknown): JsonObject | undefined => (isJsonObject(v) ? v : undefined);
  for (const k of ['steps', 'synthSteps', 'synthMs', 'genericSteps'] as const) s[k] = num(part, k);
  const verify = obj(part['verify']);
  for (const k of VERIFY_COUNTS) s.verify[k] = num(verify, k);
  s.verify.localisationMissed = num(verify, 'localisationMissed');
  const fp = obj(part['fastPath']);
  for (const k of FASTPATH_TOTALS) s.fastPath[k] = num(fp, k);
  for (const k of FASTPATH_COUNTS) s.fastPath[k] = num(fp, k);
  const reasons = obj(fp?.['reasons']);
  if (reasons !== undefined) for (const [reason, n] of Object.entries(reasons)) s.fastPath.reasons[reason] = isFiniteNumber(n) ? n : 0;
  const routers = obj(part['routers']);
  for (const k of ['issued', 'applied', 'dropped', 'maxWaitMs'] as const) s.routers[k] = num(routers, k);
  const risk = obj(part['risk']);
  for (const k of ['codeVerdicts', 'jevUnavailable'] as const) s.risk[k] = num(risk, k);
  const s2 = obj(part['s2']);
  const ttfb = s2?.['ttfbMs'];
  if (Array.isArray(ttfb)) for (const v of ttfb) if (isFiniteNumber(v)) s.s2.ttfbMs.push(v);
  for (const k of ['hedges', 'hedgeWins', 'cacheRead', 'cacheWrite'] as const) s.s2[k] = num(s2, k);
  return s;
}

export function mergeStepsSummaries(parts: readonly StepsSummary[]): StepsSummary {
  const s = emptyStepsSummary();
  for (const raw of parts) {
    // never trust the static type here: see withWaveMembers
    const p = withWaveMembers(raw);
    s.steps += p.steps;
    s.synthSteps += p.synthSteps;
    s.synthMs += p.synthMs;
    s.genericSteps += p.genericSteps;
    for (const k of VERIFY_COUNTS) s.verify[k] += p.verify[k];
    s.verify.localisationMissed += p.verify.localisationMissed;
    // contract 1.9 (Fastlane) §5.5: sums, except `maxWaitMs`, which is a max, and `reasons`, which is a histogram
    for (const k of FASTPATH_TOTALS) s.fastPath[k] += p.fastPath[k];
    for (const k of FASTPATH_COUNTS) s.fastPath[k] += p.fastPath[k];
    for (const [reason, n] of Object.entries(p.fastPath.reasons)) s.fastPath.reasons[reason] = (s.fastPath.reasons[reason] ?? 0) + n;
    s.routers.issued += p.routers.issued;
    s.routers.applied += p.routers.applied;
    s.routers.dropped += p.routers.dropped;
    s.routers.maxWaitMs = Math.max(s.routers.maxWaitMs, p.routers.maxWaitMs);
    s.risk.codeVerdicts += p.risk.codeVerdicts;
    s.risk.jevUnavailable += p.risk.jevUnavailable;
    s.s2.ttfbMs.push(...p.s2.ttfbMs);
    for (const k of ['hedges', 'hedgeWins', 'cacheRead', 'cacheWrite'] as const) s.s2[k] += p.s2[k];
  }
  return s;
}
