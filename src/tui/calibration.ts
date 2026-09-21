/**
 * `/calibration` (TUI-DESIGN §7.6, A47, 11 §4i): reliability bins, ECE, near-threshold counts and
 * sharpness over the decisions of past runs. The statistics and the block are pure over the
 * extracted records; `scanCalibration` is the I/O twin the command and `jevcode calibration` share —
 * newest 50 runs or 32 MB of input, whichever comes first, `decisions.jsonl` read whole and
 * `steps.jsonl` line by line through `readline` over a 64 KiB `createReadStream`, extracting only
 * the ≤ 20 label fields so the event loop never stalls.
 */
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DEFAULT_COMPLETE_THRESHOLD } from '../config/defaults.js';
import { RUN_ID_RE } from '../checkpoint/run-id.js';
import { RISK_DIMENSIONS, type RiskDimension } from '../core/types.js';
import { eighthBar } from './bars.js';
import { GLYPHS, padEndCells, padStartCells, type GlyphSet } from './glyphs.js';
import { CONTEXT_SELECT_THRESHOLD, NEAR_THRESHOLD_DELTA, RISK_BLOCK_THRESHOLD, RISK_REVIEW_THRESHOLD } from './pane/model.js';
import { PLAN_ACCEPT_THRESHOLD } from '../loop/plan.js';

/** §7.6: the scan is capped at the newest 50 runs … */
export const CALIBRATION_MAX_RUNS = 50;
/** … or 32 MB of input, whichever comes first. */
export const CALIBRATION_MAX_BYTES = 32 * 1024 * 1024;
/** `steps.jsonl` is streamed in 64 KiB chunks (≈ 0.2 ms each). */
export const CALIBRATION_CHUNK_BYTES = 64 * 1024;
/** 10 equal-width bins (§7.6). */
export const CALIBRATION_BINS = 10;
const FILES = { decisions: 'decisions.jsonl', steps: 'steps.jsonl' } as const;

// ---------------------------------------------------------------------------------------
// Records (the ≤ 20 label fields)
// ---------------------------------------------------------------------------------------

export interface CalibrationDecision {
  step: number;
  stage: string;
  id: string;
  probability: number;
}

export type StepTests = { source: 'parsed'; allPassed: boolean; passed: number; failed: number; errors: number } | { source: 'judged'; allPassed: number } | null;

/** The label fields extracted from one `steps.jsonl` row: `step`, `outcome.status`, `outcome.exec.ok`, `judge.succeeded`, `judge.tests.*`, `risk.verdict`, `risk.dims.<dim>.risk`, `completion`, `decisions[].{id,probability,stage}`. */
export interface StepLabelFields {
  step: number;
  outcomeStatus: string | null;
  execOk: boolean | null;
  judgeSucceeded: number | null;
  tests: StepTests;
  riskVerdict: 'ok' | 'review' | 'block' | null;
  riskDims: Partial<Record<RiskDimension, number>>;
  completion: number | null;
  decisions: CalibrationDecision[];
}

export interface CalibrationRunInput {
  runId: string;
  decisions: readonly CalibrationDecision[];
  steps: readonly StepLabelFields[];
  /** the bench verdict for `task_complete vs bench pass`; absent for cli runs */
  benchPass?: boolean | null;
}

type Obj = Record<string, unknown>;
function obj(v: unknown): Obj | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** One `decisions.jsonl` row (or a `decisions[]` entry of a step) reduced to `{ step, stage, id, probability }`; null when malformed. */
export function extractDecision(v: unknown): CalibrationDecision | null {
  const o = obj(v);
  if (!o) return null;
  const step = num(o['step']);
  const id = str(o['id']);
  const probability = num(o['probability']);
  if (step === null || id === null || probability === null) return null;
  return { step, stage: str(o['stage']) ?? '', id, probability };
}

/** One `steps.jsonl` row reduced to the ≤ 20 label fields; null when it has no integer `step`. */
export function extractStepFields(v: unknown): StepLabelFields | null {
  const o = obj(v);
  if (!o) return null;
  const step = num(o['step']);
  if (step === null || !Number.isInteger(step)) return null;
  const outcome = obj(o['outcome']);
  const exec = outcome ? obj(outcome['exec']) : null;
  const judge = obj(o['judge']);
  const testsRaw = judge ? obj(judge['tests']) : null;
  let tests: StepTests = null;
  if (testsRaw) {
    if (testsRaw['source'] === 'parsed') tests = { source: 'parsed', allPassed: testsRaw['allPassed'] === true, passed: num(testsRaw['passed']) ?? 0, failed: num(testsRaw['failed']) ?? 0, errors: num(testsRaw['errors']) ?? 0 };
    else if (testsRaw['source'] === 'judged') tests = { source: 'judged', allPassed: num(testsRaw['allPassed']) ?? 0 };
  }
  const risk = obj(o['risk']);
  const dims = risk ? obj(risk['dims']) : null;
  const riskDims: Partial<Record<RiskDimension, number>> = {};
  if (dims) {
    for (const dim of RISK_DIMENSIONS) {
      const d = obj(dims[dim]);
      const r = d ? num(d['risk']) : null;
      if (r !== null) riskDims[dim] = r;
    }
  }
  const verdictRaw = risk ? str(risk['verdict']) : null;
  const riskVerdict = verdictRaw === 'ok' || verdictRaw === 'review' || verdictRaw === 'block' ? verdictRaw : null;
  const decisionsRaw = Array.isArray(o['decisions']) ? o['decisions'] : [];
  const decisions: CalibrationDecision[] = [];
  for (const d of decisionsRaw) {
    const x = extractDecision(d);
    if (x) decisions.push(x);
  }
  return {
    step,
    outcomeStatus: outcome ? str(outcome['status']) : null,
    execOk: exec && typeof exec['ok'] === 'boolean' ? exec['ok'] : null,
    judgeSucceeded: judge ? num(judge['succeeded']) : null,
    tests,
    riskVerdict,
    riskDims,
    completion: num(o['completion']),
    decisions,
  };
}

// ---------------------------------------------------------------------------------------
// Labels (§7.6 "label sources")
// ---------------------------------------------------------------------------------------

export type LabelSource = 'review' | 'done' | 'complete' | 'succeeded';

export const LABEL_SOURCE_TEXT: Readonly<Record<LabelSource, string>> = {
  review: 'review verdict vs reviewer answer',
  done: 'done_<j> vs a later parsed test result',
  complete: 'task_complete vs bench pass',
  succeeded: 'succeeded vs exec.ok/tests.allPassed',
};

export interface CalibrationSample {
  runId: string;
  step: number;
  id: string;
  p: number;
  label: boolean;
  source: LabelSource;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * TUI-DESIGN §7.6 label sources over one run: `risk.<dim>` at a reviewed step — the dimension's
 * risk vs the reviewer declining; `done_<j>` vs the first later parsed test result; `task_complete`
 * vs the bench `pass`; judge `succeeded` vs the step's `exec.ok` / `tests.allPassed`.
 */
export function labelRun(run: CalibrationRunInput): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  const steps = [...run.steps].sort((a, b) => a.step - b.step);
  const byStep = new Map<number, StepLabelFields>();
  for (const s of steps) byStep.set(s.step, s);
  const decisions = run.decisions.length > 0 ? run.decisions : steps.flatMap((s) => s.decisions);
  const laterParsed = (after: number): boolean | null => {
    for (const s of steps) {
      if (s.step > after && s.tests && s.tests.source === 'parsed') return s.tests.allPassed;
    }
    return null;
  };
  for (const d of decisions) {
    const s = byStep.get(d.step);
    if (d.stage === 'risk' && (RISK_DIMENSIONS as readonly string[]).includes(d.id)) {
      if (!s || s.riskVerdict !== 'review' || s.outcomeStatus === null || s.outcomeStatus === 'blocked') continue;
      const risk = s.riskDims[d.id as RiskDimension];
      if (risk === undefined) continue;
      out.push({ runId: run.runId, step: d.step, id: d.id, p: clamp01(risk), label: s.outcomeStatus === 'declined', source: 'review' });
      continue;
    }
    if (/^done_\d+$/.test(d.id)) {
      const label = laterParsed(d.step);
      if (label === null) continue;
      out.push({ runId: run.runId, step: d.step, id: d.id, p: clamp01(d.probability), label, source: 'done' });
      continue;
    }
    if (d.id === 'task_complete') {
      if (run.benchPass === undefined || run.benchPass === null) continue;
      out.push({ runId: run.runId, step: d.step, id: d.id, p: clamp01(d.probability), label: run.benchPass, source: 'complete' });
      continue;
    }
    if (d.id === 'succeeded' && s) {
      const label = s.tests && s.tests.source === 'parsed' ? s.tests.allPassed : s.execOk;
      if (label === null) continue;
      out.push({ runId: run.runId, step: d.step, id: d.id, p: clamp01(d.probability), label, source: 'succeeded' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  meanP: number | null;
  observed: number | null;
}

export interface NearThresholdCount {
  name: string;
  threshold: number;
  count: number;
}

export interface CalibrationStats {
  runs: number;
  decisions: number;
  labelled: number;
  sources: Record<LabelSource, number>;
  bins: CalibrationBin[];
  /** expected calibration error over the equal-width bins; null without labels */
  ece: number | null;
  near: { total: number; byThreshold: NearThresholdCount[] };
  /** fraction of decision probabilities outside 0.2–0.8; null without decisions */
  sharpness: number | null;
}

export interface CalibrationOptions {
  completeThreshold?: number;
  bins?: number;
}

/** TUI-DESIGN §7.6 per-threshold counts `risk@.30 risk@.70 complete@.85 plan@.70 context@.50` over every decision (the risk dimensions on their risk, from `steps.jsonl`). */
export function nearThresholdCounts(runs: readonly CalibrationRunInput[], completeThreshold = DEFAULT_COMPLETE_THRESHOLD): NearThresholdCount[] {
  const counts: NearThresholdCount[] = [
    { name: 'risk', threshold: RISK_REVIEW_THRESHOLD, count: 0 },
    { name: 'risk', threshold: RISK_BLOCK_THRESHOLD, count: 0 },
    { name: 'complete', threshold: completeThreshold, count: 0 },
    { name: 'plan', threshold: PLAN_ACCEPT_THRESHOLD, count: 0 },
    { name: 'context', threshold: CONTEXT_SELECT_THRESHOLD, count: 0 },
  ];
  const near = (q: number, t: number): boolean => Math.abs(q - t) <= NEAR_THRESHOLD_DELTA + 1e-12;
  for (const run of runs) {
    const byStep = new Map<number, StepLabelFields>();
    for (const s of run.steps) byStep.set(s.step, s);
    const decisions = run.decisions.length > 0 ? run.decisions : run.steps.flatMap((s) => s.decisions);
    for (const d of decisions) {
      if (d.stage === 'risk' && (RISK_DIMENSIONS as readonly string[]).includes(d.id)) {
        const r = byStep.get(d.step)?.riskDims[d.id as RiskDimension];
        if (r === undefined) continue;
        if (near(r, RISK_REVIEW_THRESHOLD)) counts[0]!.count++;
        if (near(r, RISK_BLOCK_THRESHOLD)) counts[1]!.count++;
      } else if (d.id === 'task_complete') {
        if (near(d.probability, completeThreshold)) counts[2]!.count++;
      } else if (/^done_\d+$/.test(d.id)) {
        if (near(d.probability, PLAN_ACCEPT_THRESHOLD)) counts[3]!.count++;
      } else if (d.stage === 'context') {
        if (near(d.probability, CONTEXT_SELECT_THRESHOLD)) counts[4]!.count++;
      }
    }
  }
  return counts;
}

/** TUI-DESIGN §7.6: bins, ECE, near-threshold counts and sharpness over the runs' decisions and labels. */
export function calibrationStats(runs: readonly CalibrationRunInput[], opts: CalibrationOptions = {}): CalibrationStats {
  const nBins = Math.max(1, Math.floor(opts.bins ?? CALIBRATION_BINS));
  const samples = runs.flatMap(labelRun);
  const sources: Record<LabelSource, number> = { review: 0, done: 0, complete: 0, succeeded: 0 };
  for (const s of samples) sources[s.source]++;
  const bins: CalibrationBin[] = [];
  const sumP = new Array<number>(nBins).fill(0);
  const sumY = new Array<number>(nBins).fill(0);
  const cnt = new Array<number>(nBins).fill(0);
  for (const s of samples) {
    const b = Math.min(nBins - 1, Math.floor(s.p * nBins));
    sumP[b]! += s.p;
    sumY[b]! += s.label ? 1 : 0;
    cnt[b]! += 1;
  }
  let ece = 0;
  for (let b = 0; b < nBins; b++) {
    const n = cnt[b]!;
    const meanP = n > 0 ? sumP[b]! / n : null;
    const observed = n > 0 ? sumY[b]! / n : null;
    if (n > 0 && meanP !== null && observed !== null) ece += (n / samples.length) * Math.abs(meanP - observed);
    bins.push({ lo: b / nBins, hi: (b + 1) / nBins, n, meanP, observed });
  }
  let decisions = 0;
  let sharp = 0;
  for (const run of runs) {
    const ds = run.decisions.length > 0 ? run.decisions : run.steps.flatMap((s) => s.decisions);
    for (const d of ds) {
      decisions++;
      if (d.probability < 0.2 || d.probability > 0.8) sharp++;
    }
  }
  const byThreshold = nearThresholdCounts(runs, opts.completeThreshold ?? DEFAULT_COMPLETE_THRESHOLD);
  return {
    runs: runs.length,
    decisions,
    labelled: samples.length,
    sources,
    bins,
    ece: samples.length > 0 ? ece : null,
    near: { total: byThreshold.reduce((a, c) => a + c.count, 0), byThreshold },
    sharpness: decisions > 0 ? sharp / decisions : null,
  };
}

function shortT(t: number): string {
  const s = t.toFixed(2);
  return s.startsWith('0') ? s.slice(1) : s;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(x * 100 < 10 && x > 0 ? 1 : 0)}%`;
}

/**
 * TUI-DESIGN §7.6 `/calibration` block (the `[ui]` label is the item's): `calibration  N runs  N decisions  N with a label`,
 * the label sources, the 10 bins `bin  n  mean p  observed  bar`, `ECE 0.031 (10 equal-width bins)   near-threshold (|p−t| ≤ 0.03): 57 (1.2%)`,
 * the per-threshold counts and `sharpness: 71% outside 0.2–0.8` (ranges use the en dash, `-` under `--ascii`).
 */
export function calibrationBlock(stats: CalibrationStats, g: GlyphSet = GLYPHS.unicode): string[] {
  const lines: string[] = [`calibration  ${stats.runs} runs  ${stats.decisions} decisions  ${stats.labelled} with a label`];
  const sources = (Object.keys(LABEL_SOURCE_TEXT) as LabelSource[]).map((k) => `${LABEL_SOURCE_TEXT[k]} ${stats.sources[k]}`);
  lines.push(`  labels: ${sources.slice(0, 2).join(` ${g.dot} `)}`, `          ${sources.slice(2).join(` ${g.dot} `)}`);
  lines.push(`  ${padEndCells('bin', 9)} ${padStartCells('n', 5)}  mean p  observed  bar`);
  for (const b of stats.bins) {
    const range = `${b.lo.toFixed(1)}${g.range}${b.hi.toFixed(1)}`;
    const meanP = b.meanP === null ? padStartCells(g.dash, 6) : padStartCells(b.meanP.toFixed(2), 6);
    const observed = b.observed === null ? padStartCells(g.dash, 8) : padStartCells(b.observed.toFixed(2), 8);
    const bar = b.observed === null || g.mode === 'sr' ? '' : `  ${eighthBar(b.observed, 10, g)}`;
    lines.push(`  ${padEndCells(range, 9)} ${padStartCells(String(b.n), 5)}  ${meanP}  ${observed}${bar}`.trimEnd());
  }
  const eceText = stats.ece === null ? `ECE ${g.dash} (no labels)` : `ECE ${stats.ece.toFixed(3)} (${stats.bins.length} equal-width bins)`;
  const nearPct = stats.decisions > 0 ? pct(stats.near.total / stats.decisions) : '0%';
  lines.push(`  ${eceText}   near-threshold (|p${g.minus}t| ${g.le} ${NEAR_THRESHOLD_DELTA.toFixed(2)}): ${stats.near.total} (${nearPct})`);
  lines.push(`  ${stats.near.byThreshold.map((t) => `${t.name}@${shortT(t.threshold)} ${t.count}`).join('  ')}`);
  lines.push(`  sharpness: ${stats.sharpness === null ? g.dash : `${Math.round(stats.sharpness * 100)}%`} outside 0.2${g.range}0.8`);
  return lines;
}

// ---------------------------------------------------------------------------------------
// The scan (I/O twin; §7.6 caps)
// ---------------------------------------------------------------------------------------

export interface ScanOptions {
  maxRuns?: number;
  maxBytes?: number;
  /** progress: called before each run is read (`calibration: scanning N runs…` toast) */
  onRun?: (index: number, total: number, runId: string) => void;
  /** bench verdicts by run id, when the caller has them */
  benchPass?: ReadonlyMap<string, boolean>;
}

export interface ScanResult {
  runs: CalibrationRunInput[];
  /** run directories considered (after the run cap) */
  candidates: number;
  skipped: { runId: string; reason: string }[];
  bytes: number;
  /** which cap ended the scan early, if any */
  truncated: 'runs' | 'bytes' | null;
}

function errnoCode(e: unknown): string {
  const o = obj(e);
  return (o && str(o['code'])) ?? (e instanceof Error ? e.name : 'error');
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return null;
    throw e;
  }
}

async function readDecisions(path: string): Promise<CalibrationDecision[]> {
  const text = await readFile(path, 'utf8');
  const out: CalibrationDecision[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const d = extractDecision(JSON.parse(line));
      if (d) out.push(d);
    } catch {
      // a torn line is skipped, never fatal
    }
  }
  return out;
}

async function readSteps(path: string): Promise<StepLabelFields[]> {
  const out: StepLabelFields[] = [];
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: CALIBRATION_CHUNK_BYTES });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      try {
        const s = extractStepFields(JSON.parse(line));
        if (s) out.push(s);
      } catch {
        // torn line
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return out;
}

/** TUI-DESIGN §7.6: scan `runsDir` for the newest ≤ 50 runs or ≤ 32 MB of input (whichever comes first), reading only the label fields; missing files and unreadable runs are skipped, never fatal. */
export async function scanCalibration(runsDir: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const maxRuns = Math.max(0, Math.floor(opts.maxRuns ?? CALIBRATION_MAX_RUNS));
  const maxBytes = Math.max(0, Math.floor(opts.maxBytes ?? CALIBRATION_MAX_BYTES));
  const result: ScanResult = { runs: [], candidates: 0, skipped: [], bytes: 0, truncated: null };
  let names: string[];
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name)).map((e) => e.name);
  } catch (e) {
    result.skipped.push({ runId: runsDir, reason: errnoCode(e) });
    return result;
  }
  names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // ids start with the UTC timestamp: newest first
  if (names.length > maxRuns) result.truncated = 'runs';
  const chosen = names.slice(0, maxRuns);
  result.candidates = chosen.length;
  for (let i = 0; i < chosen.length; i++) {
    const runId = chosen[i]!;
    opts.onRun?.(i, chosen.length, runId);
    const dir = join(runsDir, runId);
    try {
      const decisionsPath = join(dir, FILES.decisions);
      const stepsPath = join(dir, FILES.steps);
      const dSize = await sizeOf(decisionsPath);
      const sSize = await sizeOf(stepsPath);
      if (dSize === null && sSize === null) {
        result.skipped.push({ runId, reason: 'no decisions.jsonl or steps.jsonl' });
        continue;
      }
      const need = (dSize ?? 0) + (sSize ?? 0);
      if (result.bytes + need > maxBytes) {
        result.truncated = 'bytes';
        break;
      }
      result.bytes += need;
      const decisions = dSize === null ? [] : await readDecisions(decisionsPath);
      const steps = sSize === null ? [] : await readSteps(stepsPath);
      const bench = opts.benchPass?.get(runId);
      result.runs.push({ runId, decisions, steps, ...(bench !== undefined ? { benchPass: bench } : {}) });
    } catch (e) {
      result.skipped.push({ runId, reason: errnoCode(e) });
    }
  }
  return result;
}
