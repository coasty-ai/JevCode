/**
 * Re-derives the baseline table of docs/LLM-JEV-DESIGN.md §1.2 from `tasks.jsonl` + the runs' `generator.jsonl`, with
 * the one estimator §10.4 uses for every arm (nearest-rank median, `bench/metrics.ts`): per (suite, condition) — pass,
 * correct-by-verdict (from the verdicts.md beside the records), steps-to-solve, wall (median over all tasks / mean, and
 * the median over solved), $ per task and per solved, wall-stopped runs, the limits; then the GLM per-call table —
 * calls, all-calls p50 / p90 / max, valid p50 / p90 ("valid" = not malformed ∧ not dropped ∧ stopReason ≠ length),
 * length stops, malformed, the latency fit a + b × output_tokens, input p50, output mean, served $.
 *
 * Usage:
 *   node_modules/.bin/tsx experiments/llm-jev/baseline-table.mts [resultsDir...] [--runs-dir ~/.jevcode/runs] [--out file.md]
 *   default dirs: bench/results/glm-jev-off-{quixbugs,ladder,swebench}
 *
 * Nothing here calls a model; python is not needed.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { latencyFit, readGeneratorRecords, summariseGeneratorRecords } from '../../src/bench/generator-records.ts';
import { armSuiteSummary, tableLines } from '../../src/bench/headtohead.ts';
import { isNotRun, median } from '../../src/bench/metrics.ts';
import { formatDuration, percentile } from '../../src/core/time.ts';
import type { GeneratorCallRecord } from '../../src/core/types.ts';
import { DEFAULT_RUNS_DIR, armsPresent, flag, limitsKey, loadResults, parseArgs, suitesPresent } from './results.ts';

const { positional, flags } = parseArgs(process.argv.slice(2));
const dirs = positional.length > 0 ? positional : ['bench/results/glm-jev-off-quixbugs', 'bench/results/glm-jev-off-ladder', 'bench/results/glm-jev-off-swebench'].filter((d) => existsSync(d));
const runsDir = flag(flags, 'runs-dir') ?? DEFAULT_RUNS_DIR;
const loaded = await loadResults(dirs);

const usd = (x: number | null, digits = 4): string => (x === null ? 'n/a' : `$${x.toFixed(digits)}`);
const ms = (x: number | null): string => (x === null ? 'n/a' : `${formatDuration(x)} (${Math.round(x / 1000)} s)`);
const num = (x: number | null, digits = 1): string => (x === null ? 'n/a' : x.toFixed(digits));

const out: string[] = [];
out.push('# §1.2 baseline table, re-derived', '', `Sources: ${loaded.dirs.map((d) => `\`${d}\``).join(', ')}; run dirs under \`${runsDir}\`. Median = nearest-rank (bench/metrics.ts), the same estimator for every arm.`, '');

// ---- per (suite, condition) rows ----------------------------------------------------------
const rows: string[][] = [];
for (const suite of suitesPresent(loaded.records)) {
  for (const arm of armsPresent(loaded.records.filter((r) => r.suite === suite))) {
    const own = loaded.records.filter((r) => r.suite === suite && r.condition === arm);
    const s = armSuiteSummary(suite, loaded.records, arm, loaded.verdicts.get(arm) ?? null);
    const v = loaded.verdicts.get(arm);
    const counts = { gold: 0, equivalent: 0, overfit: 0, unverified: 0 };
    if (v !== undefined) {
      for (const r of own.filter((x) => x.pass === true)) {
        const verdict = v.get(r.task);
        if (verdict === 'gold-identical') counts.gold += 1;
        else if (verdict === 'equivalent') counts.equivalent += 1;
        else if (verdict === 'overfit') counts.overfit += 1;
        else counts.unverified += 1;
      }
    }
    const ran = own.filter((r) => !isNotRun(r));
    const solved = ran.filter((r) => r.pass === true);
    const wallStopped = ran.filter((r) => r.stopReason === 'wall_time').length;
    const lim = loaded.limits.get(limitsKey(suite, arm));
    rows.push([
      arm,
      suite,
      `${s.passed}/${s.evaluated}${own.length !== s.evaluated ? ` (${own.length} records)` : ''}`,
      s.correct === null ? 'no verdicts.md' : `${s.correct}/${s.passed} (${counts.gold} gold-identical, ${counts.equivalent} equivalent, ${counts.overfit} overfit${counts.unverified ? `, ${counts.unverified} unverified` : ''})`,
      `median ${num(s.stepsToSolve.median, 0)}, mean ${num(s.stepsToSolve.mean)}`,
      `${ms(s.wallMs.median)} / ${ms(s.wallMs.mean)}; over solved ${ms(median(solved.map((r) => r.wallMs)))}; ${wallStopped} stopped at the wall`,
      `${usd(s.cost.perTask)} / ${usd(s.cost.perSolved)}`,
      lim === undefined ? 'n/a' : `${lim.maxSteps} steps / ${Math.round(lim.maxWallMs / 60_000)} min / $${lim.taskSpendCapUsd}`,
    ]);
  }
}
out.push('## Per condition and suite', '', ...tableLines(['condition', 'suite', 'pass', 'correct-by-verdict', 'steps-to-solve', 'wall median / mean', '$ per task / $ per solved', 'limits'], rows), '');

// ---- GLM per-call table -----------------------------------------------------------------
out.push('## Generator per-call behaviour (generator.jsonl of every run that ran)', '');
const callRows: string[][] = [];
for (const suite of suitesPresent(loaded.records)) {
  for (const arm of armsPresent(loaded.records.filter((r) => r.suite === suite))) {
    const own = loaded.records.filter((r) => r.suite === suite && r.condition === arm && !isNotRun(r) && r.runId !== null);
    const all: GeneratorCallRecord[] = [];
    let missing = 0;
    for (const r of own) {
      const rows_ = await readGeneratorRecords(join(runsDir, r.runId!));
      if (rows_.length === 0) missing += 1;
      all.push(...rows_);
    }
    if (all.length === 0) {
      callRows.push([arm, suite, `0 (${missing} runs without generator.jsonl)`, '', '', '', '', '', '', '', '']);
      continue;
    }
    const s = summariseGeneratorRecords(all);
    const fit = latencyFit(all);
    const inputs = all.map((r) => r.usage.inputTokens);
    const outputs = all.map((r) => r.usage.outputTokens);
    const models = [...new Set(all.map((r) => r.model))];
    callRows.push([
      arm,
      suite,
      `${s.calls}${missing > 0 ? ` (${missing} runs without generator.jsonl)` : ''}`,
      `${num(s.latencyMs.p50, 0)} / ${num(s.latencyMs.p90, 0)} / ${num(s.latencyMs.max, 0)}`,
      `${num(s.validLatencyMs.p50, 0)} / ${num(s.validLatencyMs.p90, 0)} (n=${s.valid})`,
      `${s.lengthStops}/${s.calls} (${((100 * s.lengthStops) / s.calls).toFixed(0)} %)`,
      `${s.malformed}/${s.calls} (${((100 * s.malformed) / s.calls).toFixed(0)} %)${s.cancelled > 0 ? `; ${s.cancelled} dropped` : ''}`,
      fit === null ? 'n/a' : `${(fit.a / 1000).toFixed(1)} s + ${fit.b.toFixed(1)} ms/token (n=${fit.n})`,
      `${num(percentile(inputs, 50), 0)} tok`,
      `${num(outputs.reduce((a, b) => a + b, 0) / outputs.length, 0)} tok${s.reasoningTokens > 0 ? ` (+${s.reasoningTokens} reasoning)` : ''}`,
      `${usd(s.costUsd)} (${usd(s.costUsd / s.calls, 5)} per call${s.estimatedUsd > 0 ? `, ${usd(s.estimatedUsd)} estimated` : ''}); ${models.join(', ')}`,
    ]);
  }
}
out.push(...tableLines(['condition', 'suite', 'calls', 'all p50 / p90 / max ms', 'valid p50 / p90 ms', 'length stops', 'malformed', 'latency fit a + b × output tokens', 'input p50', 'output mean', 'served $'], callRows), '');
out.push('Valid = not malformed ∧ not dropped (cancelled / timeout) ∧ stopReason ≠ length (§1.2). The fit is least squares over valid calls; `a` is the intercept the ladder run says may dominate. Its x is output + reasoning tokens (both generated and billed as output; §1.2 says `output_tokens`, the same number on these runs, which sent no `reasoning`).', '');

const text = `${out.join('\n')}\n`;
const outFile = flag(flags, 'out');
if (outFile !== undefined) writeFileSync(outFile, text);
process.stdout.write(text);
