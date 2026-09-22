/**
 * The head-to-head report of docs/LLM-JEV-DESIGN.md §10.4 / §10.6 over two or more results dirs: the paired table across
 * every arm present, discordant counts with the one-sided exact sign test, Wilson intervals on every pass rate, the
 * median-wall Wilcoxon test, $ per task / per solved, correct-by-verdict when a verdicts.md is beside the records (or
 * given with --verdicts), and the pre-registered criteria 1–5 with the failed ones named in the first paragraph.
 *
 * Usage:
 *   node_modules/.bin/tsx experiments/llm-jev/headtohead.mts <resultsDir> <resultsDir>... \
 *     [--suite quixbugs|ladder|swebench] [--candidate llm-jev] [--baseline jev-off] \
 *     [--verdicts <arm>=<verdicts.md>]... [--out <file.md>] \
 *     [--control jev-on-next-nofast] [--long2 a,b,c] [--gates green|red]
 *
 * Records are merged by (suite, task, condition) with later dirs winning, so a jev-off baseline dir and an llm-jev dir
 * (and the attribution arms' dirs) pair up without re-running anything. Nothing here calls a model.
 *
 * contract 1.9 (Fastlane), docs/LLM-LOOP-DESIGN.md §8: when the records contain the wave's arm, three sections are
 * added after the verdict — the recorded iteration-1 reference the arm is read against (§8.2, NOT re-run and NOT a
 * same-build baseline), the five blocking rows R-a…R-e (§8.3), the pre-registered predictions (a)…(f) (§8.4) and the
 * accept rule (§8.5). The paired control `--control` is what clause 4 rests on: pass the `jev-on-next-nofast` dir
 * alongside the arm's, or the clause reads `n/a` and the wave is not accepted. Example:
 *
 *   node_modules/.bin/tsx experiments/llm-jev/headtohead.mts \
 *     bench/results/next-fresh-jev-on-next-* bench/results/next-fresh-jev-on-next-nofast-* \
 *     bench/results/iter1-fresh-jev-off-tuned-* \
 *     --candidate jev-on-next --baseline jev-off-tuned --long2 deadline_queue,dep_order,hunk_merge,token_bucket,csv_schema,route_match
 */
import { writeFileSync } from 'node:fs';
import { isBenchCondition, isNextArm } from '../../src/bench/conditions.ts';
import { criteriaLines, evaluateAttribution, suiteHeadToHead, suiteHeadToHeadLines, verdictParagraph } from '../../src/bench/headtohead.ts';
import { acceptLines, evaluateAcceptRule, evaluatePredictions, measurementLines, measurementRows, predictionLines, recordedReferenceLines } from '../../src/bench/next-arms.ts';
import { suiteTitle } from '../../src/bench/report.ts';
import type { BenchSuite } from '../../src/core/types.ts';
import { armsPresent, asVerdicts, flag, limitsKey, loadResults, parseArgs, suitesPresent } from './results.ts';

const { positional, flags } = parseArgs(process.argv.slice(2));
if (positional.length === 0) {
  process.stderr.write('usage: headtohead.mts <resultsDir>... [--suite s] [--candidate arm] [--baseline arm] [--verdicts arm=file]... [--out file]\n');
  process.exit(2);
}
const candidate = flag(flags, 'candidate') ?? 'llm-jev';
const baseline = flag(flags, 'baseline') ?? 'jev-off';
if (!isBenchCondition(candidate) || !isBenchCondition(baseline)) throw new Error(`unknown arm: --candidate ${candidate} --baseline ${baseline}`);
const onlySuite = flag(flags, 'suite');
// contract 1.9 (Fastlane) §8.5 clause 4: the paired same-build control. It is a flag rather than a constant so the
// control can be named when the arms are renamed, and so a run that deliberately has no control says so in the table.
const control = flag(flags, 'control') ?? 'jev-on-next-nofast';
if (!isBenchCondition(control)) throw new Error(`unknown arm: --control ${control}`);
const long2 = (flag(flags, 'long2') ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter((t) => t !== '');
const gatesFlag = flag(flags, 'gates');
if (gatesFlag !== undefined && gatesFlag !== 'green' && gatesFlag !== 'red') throw new Error(`--gates must be green or red (got ${gatesFlag})`);
// §8.5 clause 1 is a tree fact — the §7 gates including Ring 1 under `--jev off` — and this script cannot observe it.
// Unset is `null`, which reads "not measured here" and does NOT accept: a wave accepted because nobody said otherwise
// is the failure this clause exists to prevent.
const gatesGreen = gatesFlag === undefined ? null : gatesFlag === 'green';

const loaded = await loadResults(positional, flags.get('verdicts') ?? []);
const arms = armsPresent(loaded.records);
const suites = suitesPresent(loaded.records).filter((s): s is BenchSuite => (onlySuite === undefined || s === onlySuite) && s !== 'terminal-bench');
const verdicts = asVerdicts(loaded.verdicts);
const perSuite = suites.map((suite) => suiteHeadToHead(suite, loaded.records, arms, { candidate, baseline, verdicts }));
const attribution = evaluateAttribution(perSuite.map((h) => h.attribution));

const out: string[] = [];
out.push(`# llm-jev head-to-head — ${candidate} vs ${baseline}`, '');
out.push(`Sources: ${loaded.dirs.map((d) => `\`${d}\``).join(', ')}. Arms present: ${arms.join(', ')}. Verdict files for: ${[...loaded.verdicts.keys()].join(', ') || 'none'}. Records: ${loaded.records.length}.`, '');
out.push('## Verdict (§10.6)', '', verdictParagraph(perSuite, attribution), '');
out.push('### Attribution (criterion 5, secondary)', '', ...criteriaLines(attribution), '');
// contract 1.9 (Fastlane) §8: only when the wave's arm is actually in the records. A section of `n/a` rows on an
// llm-jev-vs-tuned report would be noise, and worse, would make the wave look measured when it was not.
if (isNextArm(candidate) || arms.some(isNextArm)) {
  const arm = isNextArm(candidate) ? candidate : arms.find(isNextArm)!;
  const rows = measurementRows(loaded.records, arm, suites);
  const predictions = evaluatePredictions({ records: loaded.records, arm, control, ladderLong2: long2 });
  const verdict = evaluateAcceptRule({ records: loaded.records, arm, control, ladderLong2: long2, rows, predictions, gatesGreen });
  out.push(`## The LLM-loop wave — \`${arm}\` (docs/LLM-LOOP-DESIGN.md §8)`, '');
  out.push(...recordedReferenceLines(), '');
  out.push('### Blocking rows (§8.3)', '', ...measurementLines(rows), '');
  out.push('### Pre-registered predictions (§8.4)', '', ...predictionLines(predictions), '');
  out.push('### Accept rule (§8.5)', '', ...acceptLines(verdict), '');
}
for (const h of perSuite) {
  out.push(`## ${suiteTitle(h.suite)}`, '');
  const lim = loaded.limits.get(limitsKey(h.suite, candidate)) ?? loaded.limits.get(limitsKey(h.suite, baseline));
  if (lim !== undefined) out.push(`Limits (summary.json): ${lim.maxSteps} steps / ${Math.round(lim.maxWallMs / 60_000)} min / $${lim.taskSpendCapUsd} per task.`, '');
  out.push(...suiteHeadToHeadLines(h, loaded.records, { perTask: true }));
}
const text = `${out.join('\n')}\n`;
const outFile = flag(flags, 'out');
if (outFile !== undefined) {
  writeFileSync(outFile, text);
  process.stderr.write(`wrote ${outFile}\n`);
}
process.stdout.write(text);
