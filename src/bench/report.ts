/**
 * comparison.md (DESIGN.md §13): a Conditions paragraph, per-suite pass rates, the paired
 * comparison, the solve and tokens-per-step curves as tables with inline bars and n columns,
 * stop-reason histograms, per-task rows. Terminal-Bench numbers carry the non-comparable label.
 */
import { formatDuration } from '../core/time.js';
import type { BenchSuite, BenchTaskRecord, EngineMode } from '../core/types.js';
import type { ConditionMetrics, Summary } from './types.js';

export const TB_LABEL = 'local shim, non-comparable to the tbench.ai leaderboard';
export const BAR_WIDTH = 20;

/** Inline bar of █ scaled to `max` over BAR_WIDTH cells (empty when max is 0). */
export function bar(value: number | null, max: number, width = BAR_WIDTH): string {
  if (value === null || max <= 0 || !Number.isFinite(value)) return '';
  const cells = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return '█'.repeat(cells);
}

export function fmt(x: number | null, digits = 2): string {
  if (x === null) return 'null';
  return Number.isInteger(x) ? String(x) : x.toFixed(digits);
}

export function fmtUsd(x: number): string {
  return `$${x.toFixed(4)}`;
}

function pct(x: number | null): string {
  return x === null ? 'null' : `${(x * 100).toFixed(1)}%`;
}

const CELL_MAX = 300;

/** Markdown cell text: pipes escaped, newlines collapsed, bounded (reasons carry sandbox output tails). */
export function cell(text: string): string {
  const flat = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return flat.length > CELL_MAX ? `${flat.slice(0, CELL_MAX - 1)}…` : flat;
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]): string => `| ${cells.map(cell).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

function suiteTitle(suite: BenchSuite): string {
  return suite === 'swebench' ? 'SWE-bench Verified (local subset)' : `Terminal-Bench 4.0 (${TB_LABEL})`;
}

export const CONDITIONS_PARAGRAPH =
  'Both conditions run the same generator, system prompt, user-message layout, limits and sandbox. ' +
  'They differ structurally in context delivery: **jev-on** receives Jev-selected file contents each step ' +
  '(the context stage) plus intent, risk gating, judging and replanning; **jev-off** receives only the ' +
  'code-computed candidate list (paths and sizes) and must spend `read` steps to see file contents, has no ' +
  'risk stage (nothing is blocked or reviewed), no judge, and stops on its own `done`. `read`-action counts ' +
  'are therefore reported beside steps-to-solve, and steps-to-solve is defined over passed tasks only.';

function conditionRows(summary: Summary): string[][] {
  return summary.conditionOrder.map((c) => {
    const cfg = summary.conditions[c]!;
    return [
      c,
      cfg.generatorModel,
      cfg.deciderModel ?? '—',
      cfg.temperature === null ? 'not sent' : String(cfg.temperature),
      String(cfg.maxTokens),
      String(cfg.maxSteps),
      formatDuration(cfg.maxWallMs),
      fmtUsd(cfg.taskSpendCapUsd),
      cfg.sandboxProfile,
      formatDuration(cfg.commandTimeoutMs),
      `${Math.round(cfg.maxOutputBytes / 1024)} KB`,
    ];
  });
}

function metricRows(conds: readonly EngineMode[], m: Record<string, ConditionMetrics>): string[][] {
  const get = (c: EngineMode): ConditionMetrics => m[c]!;
  const row = (label: string, f: (x: ConditionMetrics) => string): string[] => [label, ...conds.map((c) => f(get(c)))];
  return [
    row('pass rate (passed/evaluated)', (x) => `${x.passRateText} ${pct(x.passRate)}`),
    row('steps-to-solve mean (n passed)', (x) => `${fmt(x.stepsToSolve.mean)} (n=${x.stepsToSolve.n})`),
    row('steps-to-solve median', (x) => fmt(x.stepsToSolve.median)),
    row('steps used mean (n runs)', (x) => `${fmt(x.stepsUsed.mean)} (n=${x.stepsUsed.n})`),
    row('steps used median', (x) => fmt(x.stepsUsed.median)),
    row('read actions total / mean per run', (x) => `${x.reads.total} / ${fmt(x.reads.meanPerRun)}`),
    row('blocked / reviews / declined', (x) => `${x.blocked} / ${x.reviews} / ${x.declined}`),
    row('loops / replans', (x) => `${x.loops} / ${x.replans}`),
    row('Jev requests / questions', (x) => `${x.jevRequests} / ${x.jevQuestions}`),
    row('Jev latency p50 / p95 ms (n)', (x) => `${fmt(x.jevLatencyMs.p50)} / ${fmt(x.jevLatencyMs.p95)} (n=${x.jevLatencyMs.n})`),
    row('mean tokens/step (steps)', (x) => `${fmt(x.meanTokensPerStep.mean, 0)} (n=${x.meanTokensPerStep.steps})`),
    row('wall time mean', (x) => (x.wallMs.mean === null ? 'null' : formatDuration(x.wallMs.mean))),
    row('cost generator / Jev / total', (x) => `${fmtUsd(x.cost.generator)} / ${fmtUsd(x.cost.jev)} / ${fmtUsd(x.cost.total)}`),
  ];
}

function solveCurveTable(conds: readonly EngineMode[], m: Record<string, ConditionMetrics>): string {
  const longest = Math.max(0, ...conds.map((c) => m[c]!.solveCurve.length));
  if (longest === 0) return '_no evaluated runs_';
  const header = ['k', ...conds.flatMap((c) => [`${c} solved(k)`, `${c} fraction`, `${c}`])];
  const rows: string[][] = [];
  for (let i = 0; i < longest; i++) {
    const cells = [String(i + 1)];
    for (const c of conds) {
      const p = m[c]!.solveCurve[i];
      if (!p) {
        cells.push('', '', '');
        continue;
      }
      cells.push(`${p.solved}/${m[c]!.evaluated}`, pct(p.fraction), bar(p.fraction, 1));
    }
    rows.push(cells);
  }
  return table(header, rows);
}

function tokensCurveTable(conds: readonly EngineMode[], m: Record<string, ConditionMetrics>): string {
  const longest = Math.max(0, ...conds.map((c) => m[c]!.tokensPerStepCurve.length));
  if (longest === 0) return '_no executed steps_';
  const max = Math.max(1, ...conds.flatMap((c) => m[c]!.tokensPerStepCurve.map((p) => p.mean)));
  const header = ['step', ...conds.flatMap((c) => [`${c} mean tokens (n)`, `${c}`])];
  const rows: string[][] = [];
  for (let i = 0; i < longest; i++) {
    const cells = [String(i + 1)];
    for (const c of conds) {
      const p = m[c]!.tokensPerStepCurve[i];
      if (!p) {
        cells.push('', '');
        continue;
      }
      cells.push(`${Math.round(p.mean)} (n=${p.n})`, bar(p.mean, max));
    }
    rows.push(cells);
  }
  return table(header, rows);
}

function stopReasonTable(conds: readonly EngineMode[], m: Record<string, ConditionMetrics>): string {
  const reasons = new Set<string>();
  for (const c of conds) for (const k of Object.keys(m[c]!.stopReasons)) reasons.add(k);
  if (reasons.size === 0) return '_no runs_';
  const max = Math.max(1, ...conds.flatMap((c) => Object.values(m[c]!.stopReasons)));
  return table(
    ['stop reason', ...conds.flatMap((c) => [c, ''])],
    [...reasons].sort().map((r) => [r, ...conds.flatMap((c) => [String(m[c]!.stopReasons[r] ?? 0), bar(m[c]!.stopReasons[r] ?? 0, max)])]),
  );
}

function list(ids: readonly string[]): string {
  return ids.length === 0 ? '—' : ids.map((x) => `\`${x.replace(/`/g, "'")}\``).join(', ');
}

export function renderComparison(summary: Summary, records: readonly BenchTaskRecord[]): string {
  const conds = summary.conditionOrder;
  const out: string[] = [];
  out.push(`# JevCode bench ${summary.benchId}`);
  out.push('');
  if (summary.mocked) out.push('> **Mocked bench** (`mocked: true`): the provider replayed gold trajectories and Jev was mocked; costs are zero and pass/fail only exercises the pipeline.');
  out.push(`Generated ${summary.finishedAt}. Generator model \`${summary.generatorModel}\`. ${summary.records} task records, suites: ${summary.suites.join(', ')}.`);
  out.push('');
  out.push('## Conditions');
  out.push('');
  out.push(CONDITIONS_PARAGRAPH);
  out.push('');
  out.push(table(['condition', 'generator', 'decider', 'temperature', 'maxTokens', 'max steps', 'max wall', 'per-run cap', 'sandbox', 'command timeout', 'output cap'], conditionRows(summary)));
  out.push('');
  out.push('## Spend');
  out.push('');
  out.push(`Bench cap ${fmtUsd(summary.spendCapUsd)}, per-run cap ${fmtUsd(summary.taskSpendCapUsd)}; spent generator ${fmtUsd(summary.spentUsd.generator)} + Jev ${fmtUsd(summary.spentUsd.jev)} = ${fmtUsd(summary.spentUsd.total)}. Bench cap fired: ${summary.capFired === 'bench' ? '**yes**' : 'no'}. Pairs not run: ${summary.notRun.count}${summary.notRun.count ? ` (${list(summary.notRun.tasks)})` : ''}.`);
  out.push('');
  for (const suite of summary.suites) {
    const sm = summary.perSuite[suite];
    if (!sm) continue;
    out.push(`## ${suiteTitle(suite)}`);
    out.push('');
    if (suite === 'terminal-bench') out.push(`> Every number in this section is **${TB_LABEL}** (Python 3.9 venv instead of the task images, path-rewritten verifier, no container isolation, 10-task subset).`);
    out.push('');
    out.push('### Pass rate per condition (all records)');
    out.push('');
    out.push(
      table(
        ['condition', 'tasks', 'evaluated', 'passed', 'pass rate', 'unevaluated', 'unsupported', 'not run', 'model drift'],
        conds.map((c) => {
          const m = sm.perCondition[c]!;
          return [c, String(m.tasks), String(m.evaluated), String(m.passed), `${m.passRateText} ${pct(m.passRate)}`, list(m.unevaluated), list(m.unsupported), list(m.notRun), list(m.modelDrift)];
        }),
      ),
    );
    out.push('');
    const cmp = sm.comparison;
    out.push(`### Paired comparison (n = ${cmp.pairedTasks.length} tasks evaluated in every condition)`);
    out.push('');
    out.push(`Paired tasks: ${list(cmp.pairedTasks)}. Excluded for model drift: ${list(cmp.excludedForDrift)}. Incomplete pairs: ${list(cmp.incompletePairs)}.${suite === 'terminal-bench' ? ` (${TB_LABEL}.)` : ''}`);
    out.push('');
    out.push(table(['metric', ...conds], metricRows(conds, cmp.perCondition)));
    out.push('');
    out.push('### Solve curve (paired; solved(k) = passed with steps ≤ k over evaluated)');
    out.push('');
    out.push(solveCurveTable(conds, cmp.perCondition));
    out.push('');
    out.push('### Tokens per step (paired; mean generator+Jev tokens over runs that reached the step)');
    out.push('');
    out.push(tokensCurveTable(conds, cmp.perCondition));
    out.push('');
    out.push('### Stop reasons (all records)');
    out.push('');
    out.push(stopReasonTable(conds, sm.perCondition));
    out.push('');
    out.push('### Per task (paired)');
    out.push('');
    if (cmp.rows.length === 0) out.push('_no paired tasks_');
    else {
      out.push(
        table(
          ['task', ...conds.flatMap((c) => [`${c} pass`, `${c} steps`, `${c} reads`, `${c} cost`])],
          cmp.rows.map((r) => [r.task, ...conds.flatMap((c) => [r.pass[c] === true ? 'pass' : r.pass[c] === false ? 'fail' : 'null', String(r.steps[c] ?? ''), String(r.reads[c] ?? ''), fmtUsd(r.cost[c] ?? 0)])]),
        ),
      );
    }
    out.push('');
    const incomplete = records.filter((r) => r.suite === suite && cmp.incompletePairs.includes(r.task));
    if (incomplete.length > 0) {
      out.push('### Incomplete pairs');
      out.push('');
      out.push(table(['task', 'condition', 'pass', 'evaluator', 'stop reason', 'reason'], incomplete.map((r) => [r.task, r.condition, String(r.pass), r.evaluator, r.stopReason, r.reason ?? ''])));
      out.push('');
    }
  }
  return `${out.join('\n')}\n`;
}
