/**
 * The §5 quick table (HARNESS-NEXT-DESIGN §5 "What is measured on every Ring-2 run", wave S0).
 *
 * One bench output directory in, the table and the §5 step-5 accept rule out. It is a module first — the ring
 * runner `experiments/harness-next/quick.mts` imports it so the ring and a bare directory are summarised by the
 * same code — and a script second:
 *
 *   node node_modules/.bin/tsx experiments/fastlane/quick-table.mts <bench-out-dir> [--verdicts <md>]
 *
 * The accept rule is deliberately printed with its inputs rather than reduced to a boolean: "median wall −≥ 10 %
 * on at least three of the five live tasks, no verdict changed, overfit count not increased, `screenMismatches`
 * and `scopeUnusable` 0, harness p95 unchanged, Jev requests not increased" is six conditions, and a run that
 * meets five of them is a different thing from a run that meets none. Rows the tree cannot measure yet say so
 * (`not recorded before wave S1`) instead of counting as met.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parseVerdictsMarkdown, type Verdict } from '../../src/bench/headtohead.ts';

export interface TaskBaseline {
  id: string;
  suite: 'quixbugs' | 'ladder' | 'swebench';
  /** today's `llm-jev` numbers from the §5 table (the head-to-head at 626fc40) */
  baseline: { wallMs: number; steps: number; usd: number; jevRequests: number };
  why: string;
}

/** One row of `tasks.jsonl`, in the fields this table reads. */
export interface RawRecord {
  task: string;
  suite: string;
  pass: boolean | null;
  steps: number;
  wallMs: number;
  cost: { generator: number; jev: number };
  jevRequests: number;
  timing: { generatorMs: number; jevMs: number; execMs: number; harnessMs: number };
  stopReason: string;
}

export interface Row {
  task: string;
  pass: boolean | null;
  steps: number;
  wallMs: number;
  usd: number;
  jevRequests: number;
  jevMs: number;
  harnessMs: number;
  stopReason: string;
  verdict: Verdict | null;
}

export function ms(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v.toFixed(1)} ms`;
}

export function pct(a: number, b: number): string {
  if (b === 0) return '—';
  const d = ((a - b) / b) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(0)} %`;
}

/** `<dir>/tasks.jsonl`, or the one in the single `<dir>/<bench-id>/` the runner made when it owned the id. */
export function readRecords(dir: string): RawRecord[] {
  const file = join(dir, 'tasks.jsonl');
  if (!existsSync(file)) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(dir, e.name, 'tasks.jsonl'))) return readRecords(join(dir, e.name));
    }
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RawRecord);
}

export function rowsFrom(records: readonly RawRecord[], verdicts: ReadonlyMap<string, Verdict>): Row[] {
  return records.map((rec) => ({
    task: rec.task,
    pass: rec.pass,
    steps: rec.steps,
    wallMs: rec.wallMs,
    usd: rec.cost.generator + rec.cost.jev,
    jevRequests: rec.jevRequests,
    jevMs: rec.timing.jevMs,
    harnessMs: rec.timing.harnessMs,
    stopReason: rec.stopReason,
    verdict: verdicts.get(rec.task) ?? null,
  }));
}

export interface AcceptInput {
  rows: readonly Row[];
  baselines: readonly TaskBaseline[];
  /** the head-to-head's overfit count the rule compares against (§5 step 5) */
  overfitBaseline?: number;
}

export interface AcceptResult {
  improved: number;
  needed: number;
  verdictChanges: number;
  overfits: number;
  jevRequestsUp: number;
  accept: boolean;
}

export function acceptRule(input: AcceptInput): AcceptResult {
  const { rows, baselines } = input;
  const overfitBaseline = input.overfitBaseline ?? 5;
  let improved = 0;
  let verdictChanges = 0;
  let overfits = 0;
  let jevRequestsUp = 0;
  for (const r of rows) {
    const base = baselines.find((t) => t.id === r.task)?.baseline;
    if (base && r.wallMs <= base.wallMs * 0.9) improved += 1;
    if (base && r.jevRequests > base.jevRequests) jevRequestsUp += 1;
    if (r.verdict === 'overfit') overfits += 1;
    if (r.verdict === 'miss' || r.pass === false) verdictChanges += 1;
  }
  const needed = Math.min(3, rows.length);
  return { improved, needed, verdictChanges, overfits, jevRequestsUp, accept: improved >= needed && verdictChanges === 0 && overfits <= overfitBaseline && jevRequestsUp === 0 };
}

/** The §5 table plus the accept rule; returns the rule's verdict. */
export function printQuickTable(rows: readonly Row[], baselines: readonly TaskBaseline[], log: (s: string) => void = (s) => console.log(s)): boolean {
  if (rows.length === 0) {
    log('  no records');
    return false;
  }
  log('  task            pass  steps   wall      wall/step    $        jev req  jevMs   harnessMs  verdict     vs baseline');
  for (const r of rows) {
    const base = baselines.find((t) => t.id === r.task)?.baseline;
    log(
      `  ${r.task.padEnd(15)} ${String(r.pass ?? '—').padEnd(5)} ${String(r.steps).padStart(5)}  ${ms(r.wallMs).padStart(8)}  ${ms(r.steps > 0 ? r.wallMs / r.steps : null).padStart(9)}  ${`$${r.usd.toFixed(4)}`.padStart(8)} ${String(r.jevRequests).padStart(8)} ${ms(r.jevMs).padStart(8)} ${ms(r.harnessMs).padStart(10)}  ${(r.verdict ?? '—').padEnd(11)} ${base ? pct(r.wallMs, base.wallMs) : '—'}`,
    );
  }
  const a = acceptRule({ rows, baselines });
  log('\n  accept rule (§5 step 5):');
  log(`    median wall −≥ 10 % on ≥ ${a.needed} tasks           ${a.improved}/${rows.length}  ${a.improved >= a.needed ? 'met' : 'NOT met'}`);
  log(`    no verdict changed                          ${a.verdictChanges} change(s)  ${a.verdictChanges === 0 ? 'met' : 'NOT met'}`);
  log(`    overfit count not increased (baseline 5)    ${a.overfits}  ${a.overfits <= 5 ? 'met' : 'NOT met'}`);
  log(`    Jev requests not increased                  ${a.jevRequestsUp} task(s) up  ${a.jevRequestsUp === 0 ? 'met' : 'NOT met'}`);
  log('    screenMismatches = 0, scopeUnusable = 0     not recorded before wave S1');
  log(`\n  ${a.accept ? 'ACCEPT' : 'REJECT'} — and run it twice before believing it (§5 step 4)`);
  return a.accept;
}

// ---------------------------------------------------------------------------------------
// the script form
// ---------------------------------------------------------------------------------------

if (process.argv[1]?.endsWith('quick-table.mts') === true) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (dir === undefined) {
    console.error('usage: quick-table.mts <bench-out-dir> [--verdicts <md>]');
    process.exit(2);
  }
  const vi = args.indexOf('--verdicts');
  const verdicts = vi === -1 ? new Map<string, Verdict>() : parseVerdictsMarkdown(readFileSync(args[vi + 1]!, 'utf8'));
  const records = readRecords(dir);
  // a bare directory has no §5 baselines to compare against; the table still prints, the deltas read "—"
  printQuickTable(rowsFrom(records, verdicts), []);
}
