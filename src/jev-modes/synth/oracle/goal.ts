/**
 * Present a reproduction as a failing test to the search (docs/JEV-ONLY-DESIGN.md §2.1: goals
 * are clusters of failing tests with FailureViews; §2.2 the baseline is a TestRunSummary). One
 * synthetic test id `repro::<sha8>` (sha256 of the chunks + criterion) names the goal; the
 * FailureView's `call` is the snippet's last statement, `expected` the code-built expected text,
 * `actual` what the run produced. `verifyRepro` re-runs the same script in a candidate workspace
 * (a shadow lane) and `regressionScope` picks the repository's test files that import or name the
 * localised module (≤ 6) for the regression check, with the spec's `test_cmd` template when given.
 */
import { createHash } from 'node:crypto';
import type { FailureView, TestRunSummary } from '../types.js';
import type { VerifyRunFn } from '../verify/types.js';
import type { BuiltCriterion, ReproRunOptions } from './runner.js';
import { evaluateCriterion, evidenceStatements, runRepro } from './runner.js';
import type { CodeBlock, Criterion, ReproRunResult, Verdict } from './types.js';

export const REPRO_ID_PREFIX = 'repro::';
export const REGRESSION_FILES_MAX = 6;
const TAIL_BOUND = 4000;

/** Everything needed to run the reproduction again anywhere: the chunks, the criterion and the interpreter options. */
export interface ReproSpec {
  testId: string;
  chunks: string[];
  criterion: Criterion;
  /** `FailureView.expected` */
  expectedText: string;
  /** the block index the chunks came from, for the transcript */
  blockIndex: number;
  options: Omit<ReproRunOptions, 'workspace' | 'python'>;
}

export interface ReproGoal {
  spec: ReproSpec;
  failure: FailureView;
  /** one-test summary: failing when the verdict fails (a valid oracle on the base workspace) */
  summary: TestRunSummary;
  verdict: Verdict;
  result: ReproRunResult;
}

function sha8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

/** `repro::<sha8>` over the chunks and the criterion (the same snippet with another criterion is another goal). */
export function reproTestId(chunks: readonly string[], criterion: Criterion): string {
  return `${REPRO_ID_PREFIX}${sha8(JSON.stringify({ chunks, criterion }))}`;
}

/** The statement the goal is about: the one the verdict rests on, else the last statement that ran. */
export function callOf(result: ReproRunResult, verdict: Verdict): string {
  const s = verdict.statement ?? evidenceStatements(result).at(-1) ?? result.statements.at(-1) ?? null;
  if (s === null) return '<repro>';
  const src = s.source.trim().split('\n').at(-1) ?? s.source;
  return src.length > 200 ? `${src.slice(0, 197)}...` : src;
}

export function summaryOf(spec: ReproSpec, failure: FailureView, result: ReproRunResult, verdict: Verdict): TestRunSummary {
  const failing = verdict.pass ? [] : [spec.testId];
  return {
    command: `python <${spec.testId}>`,
    passed: verdict.pass ? 1 : 0,
    failed: verdict.pass ? 0 : 1,
    errors: 0,
    skipped: 0,
    total: 1,
    failing,
    passing: verdict.pass ? [spec.testId] : [],
    failures: verdict.pass ? [] : [failure],
    exitCode: result.exitCode,
    timedOut: result.status === 'timeout',
    durationMs: result.durationMs,
    outputTail: result.outputTail.length > TAIL_BOUND ? result.outputTail.slice(-TAIL_BOUND) : result.outputTail,
  };
}

export interface ReproductionGoalInput {
  block: CodeBlock;
  chunks: readonly string[];
  built: BuiltCriterion;
  result: ReproRunResult;
  options: Omit<ReproRunOptions, 'workspace' | 'python'>;
}

/** The goal for a snippet that has been run once (on the committed workspace); the summary fails when the criterion fails. */
export function reproductionGoal(input: ReproductionGoalInput): ReproGoal {
  const verdict = evaluateCriterion(input.built.criterion, input.result);
  const chunks = [...input.chunks];
  const spec: ReproSpec = { testId: reproTestId(chunks, input.built.criterion), chunks, criterion: input.built.criterion, expectedText: input.built.expectedText, blockIndex: input.block.index, options: input.options };
  const failure: FailureView = { testId: spec.testId, call: callOf(input.result, verdict), expected: input.built.expectedText, actual: verdict.actual.length > 240 ? `${verdict.actual.slice(0, 237)}...` : verdict.actual };
  return { spec, failure, summary: summaryOf(spec, failure, input.result, verdict), verdict, result: input.result };
}

export interface VerifyReproResult {
  result: ReproRunResult;
  verdict: Verdict;
  summary: TestRunSummary;
  failure: FailureView;
}

/** Re-run the reproduction in another workspace (a candidate lane, or the gold-patched checkout in the experiment). */
export async function verifyRepro(run: VerifyRunFn, candidateWorkspace: string, spec: ReproSpec, python?: string): Promise<VerifyReproResult> {
  const opts: ReproRunOptions = { ...spec.options, workspace: candidateWorkspace };
  if (python !== undefined) opts.python = python;
  const result = await runRepro(run, spec.chunks, opts);
  const verdict = evaluateCriterion(spec.criterion, result);
  const failure: FailureView = { testId: spec.testId, call: callOf(result, verdict), expected: spec.expectedText, actual: verdict.actual.length > 240 ? `${verdict.actual.slice(0, 237)}...` : verdict.actual };
  return { result, verdict, summary: summaryOf(spec, failure, result, verdict), failure };
}

// ---------------------------------------------------------------------------------------
// Regression scope
// ---------------------------------------------------------------------------------------

const TEST_PATH = /(^|\/)(test_[^/]*\.py|[^/]*_tests?\.py)$|(^|\/)(tests?|testing)\/.*\.py$/;
const NOT_A_TEST = /(^|\/)(__init__|conftest)\.py$/;

export interface RegressionScopeOptions {
  /** the spec's `test_cmd` template; the chosen files are appended, shell-quoted */
  testCmd?: string;
  max?: number;
}

export interface RegressionScope {
  /** the repository's test files most tied to the localised modules, best first, ≤ max */
  testFiles: string[];
  /** `<test_cmd> <files>` when a template was given, else `python -m pytest -q <files>`; null when no file qualified */
  command: string | null;
  /** per file, why it was chosen */
  reasons: Record<string, string>;
}

function moduleOf(path: string): { dotted: string; base: string; dir: string } {
  const noExt = path.replace(/\.py$/, '');
  const parts = noExt.split('/').filter((p) => p !== '' && p !== 'src');
  const base = parts.at(-1) ?? noExt;
  return { dotted: parts.join('.'), base, dir: path.split('/').slice(0, -1).join('/') };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Test files that import or name the localised modules: `import a.b.mod` / `from a.b import mod`
 * / `from a.b.mod import …` score 3, a `tests/test_<mod>.py` beside the module scores 4, the bare
 * module name used as an identifier in a test file under the module's package scores 1. Bounded
 * to `max` (default 6) so the regression run stays affordable on repository suites (§4.3).
 */
export function regressionScope(localizedFiles: readonly string[], workspaceFiles: ReadonlyMap<string, string>, opts: RegressionScopeOptions = {}): RegressionScope {
  const max = opts.max ?? REGRESSION_FILES_MAX;
  const scores = new Map<string, { score: number; reason: string }>();
  const bump = (path: string, score: number, reason: string): void => {
    const cur = scores.get(path);
    if (cur === undefined || cur.score < score) scores.set(path, { score, reason });
  };
  for (const loc of localizedFiles) {
    const { dotted, base, dir } = moduleOf(loc);
    const parentDotted = dotted.split('.').slice(0, -1).join('.');
    const importRe = new RegExp(`^\\s*(?:import\\s+${dotted.replace(/\./g, '\\.')}\\b|from\\s+${dotted.replace(/\./g, '\\.')}\\s+import\\b|from\\s+${parentDotted.replace(/\./g, '\\.')}\\s+import\\b[^\\n]*\\b${base}\\b)`, 'm');
    const wordRe = new RegExp(`\\b${base}\\b`);
    for (const [path, src] of workspaceFiles) {
      if (!TEST_PATH.test(path) || NOT_A_TEST.test(path) || path === loc) continue;
      const testBase = path.split('/').at(-1) ?? '';
      const nearby = dir !== '' && path.startsWith(`${dir}/`);
      if (nearby && (testBase === `test_${base}.py` || testBase === `${base}_test.py`)) bump(path, 4, `tests/test_${base}.py beside ${loc}`);
      else if (importRe.test(src)) bump(path, 3, `imports ${dotted}`);
      else if (nearby && wordRe.test(src)) bump(path, 1, `names ${base} under ${dir}`);
    }
  }
  const testFiles = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([p]) => p);
  const reasons: Record<string, string> = {};
  for (const p of testFiles) reasons[p] = scores.get(p)?.reason ?? '';
  const command = testFiles.length === 0 ? null : `${opts.testCmd?.trim() ?? 'python -m pytest -q'} ${testFiles.map(shellQuote).join(' ')}`;
  return { testFiles, command, reasons };
}
