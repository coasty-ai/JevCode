/**
 * The head-to-head report of docs/LLM-JEV-DESIGN.md §10.4 / §10.6 over two or more results dirs: the paired table across
 * every arm present, discordant counts with the one-sided exact sign test, Wilson intervals on every pass rate, the
 * median-wall Wilcoxon test, $ per task / per solved, correct-by-verdict when a verdicts.md is beside the records (or
 * given with --verdicts), and the pre-registered criteria 1–5 with the failed ones named in the first paragraph.
 *
 * Usage:
 *   node_modules/.bin/tsx experiments/llm-jev/headtohead.mts <resultsDir> <resultsDir>... \
 *     [--suite quixbugs|ladder|swebench] [--candidate llm-jev] [--baseline jev-off] \
 *     [--verdicts <arm>=<verdicts.md>]... [--out <file.md>]
 *
 * Records are merged by (suite, task, condition) with later dirs winning, so a jev-off baseline dir and an llm-jev dir
 * (and the attribution arms' dirs) pair up without re-running anything. Nothing here calls a model.
 */
import { writeFileSync } from 'node:fs';
import { isBenchCondition } from '../../src/bench/conditions.ts';
import { criteriaLines, evaluateAttribution, suiteHeadToHead, suiteHeadToHeadLines, verdictParagraph } from '../../src/bench/headtohead.ts';
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
