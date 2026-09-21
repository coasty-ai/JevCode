/**
 * The oracle path of the Ledger + Sieve search on a repository workspace (docs/JEV-ONLY-DESIGN.md
 * §2.2 establishing step; measured in experiments/results/oracle-from-issue.md: a valid
 * reproduction on 9/30 SWE-bench Verified instances at one Jev request each).
 *
 * `findIssueOracle` runs the whole pipeline once per run: code extracts the candidate blocks
 * from the task text, ONE Jev request judges them, code builds the criterion and runs the
 * snippet in the committed workspace with its own interpreter; the result is either a
 * reproduction goal (the criterion fails at the base commit) or an honest reason there is none.
 * The rest of this module is the arithmetic around it: which workspaces are repositories (a
 * Django or sympy suite is hours; even a scoped pytest run is minutes), which package the
 * snippet imports, which test files bound the regression run (`chooseRegressionScope`, ≤ 6
 * files: `relatedTestFiles` first, then test apps named after the module's stem, then a
 * last-resort pair so the engine always has a parseable run), the command template that
 * carries the harness's own flags (`regressionCommandTemplate`), and the merge of the scoped
 * run with the one-test reproduction summary that the ledger treats as its baseline
 * (`mergeSummaries`). Nothing here decides a verdict: the criterion is code, the tests are the
 * oracle, Jev only judges which block reproduces the bug.
 */
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import type { Answer, Json, OracleOutcome as CoreOracleOutcome, Question, StageName, TestCommand } from '../../core/types.js';
import type { FailureView, TestRunSummary } from '../types.js';
import { scopedTestCommand } from '../verify/index.js';
import { isTestFile, relatedTestFiles } from '../verify/runners.js';
import type { VerifyRunFn } from '../verify/types.js';
import { extractBlocks } from './extract.js';
import { REPRO_ID_PREFIX, reproductionGoal } from './goal.js';
import type { ReproGoal } from './goal.js';
import { chooseBlocks, isRunnable, oracleQuestions, PICK_THRESHOLD, readOracleAnswers } from './questions.js';
import type { BlockChoice } from './questions.js';
import { buildCriterion, chunksWithContext, detectNetworkUse, evaluateCriterion, evidenceStatements, REPRO_TIMEOUT_MS, runRepro } from './runner.js';
import type { NetworkUse, ReproRunOptions } from './runner.js';
import type { CriterionStrength, Extraction, FrameJudgement, OracleJudgement, ReproRunResult, TracebackFrame } from './types.js';

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

/**
 * A workspace is repository-class before any run is measured when its detected runner is a
 * whole-project suite (Django's runtests.py, sympy's bin/test: hours), or when it has at least
 * this many non-test Python files (requests: 83 with its vendored packages; the ladder's tasks
 * have ≤ 10, QuixBugs 1–2) or this many test files (pytest-dev: 126, pylint: 705).
 */
export const REPOSITORY_MIN_SOURCE_FILES = 40;
export const REPOSITORY_MIN_TEST_FILES = 25;
/** Regression scope size (§4.3 keeps a repository step at minutes of tests; the brief's bound). */
export const REGRESSION_SCOPE_MAX = 6;
/**
 * The stem tier only fills the slots the related tier left empty, never displaces an import-
 * based pick: measured over the 30 SWE-bench gold modules, capping the related tier at 4 to
 * make room for stem picks lost 4 F2P files (Django's `forms/models.py` stems flood `model_*`
 * apps) and gained 1; filling only is 21/30 F2P files in the scope, 3 more partially.
 */
export const RELATED_FILLS_FIRST = true;
/** Module-path tokens shorter than this never match a test path segment (`db`, `sql`, `gis`). */
const STEM_MIN_CHARS = 4;
/** A shared prefix of at least this length between a module stem and a test-path segment counts (`aggregate` ~ `aggregation`). */
const STEM_PREFIX_MIN = 6;
/** Path segments that name nothing about the module. */
const GENERIC_STEMS: ReadonlySet<string> = new Set(['init', 'test', 'tests', 'testing', 'src', 'lib', 'core', 'base', 'util', 'utils', 'main', 'common', 'misc', 'internal', 'impl', 'helpers', 'helper']);
/**
 * Files an editable install generates in the workspace that a fresh worktree lane lacks
 * (setuptools_scm writes pytest's `_version.py` at install time; it is git-ignored, so the lane
 * snapshot never carries it and `import _pytest` fails in the lane without it).
 */
export const INSTALL_GENERATED_FILES: readonly string[] = ['src/_pytest/_version.py'];
/** The synthetic test id of the best-guess goal: `issue::<sha8(task)>`. */
export const BEST_GUESS_ID_PREFIX = 'issue::';
/** The park reason of a best-guess goal after its one commit (§5.3 reasons are human-readable, Jev-visible). */
export const BEST_GUESS_PARK_REASON = 'best-guess fix committed, unverified (no reproduction oracle)';
export const BEST_GUESS_REJECTED_REASON = 'the best-guess fix was rejected by the engine; no second guess is made';
export const BEST_GUESS_NOTE = 'no reproduction oracle: best-guess fix, unverified';

const TEST_PATH = /(^|\/)(tests?|testing)\/|(^|\/)test_[^/]*\.py$|_tests?\.py$|(^|\/)conftest\.py$/;
/**
 * A runnable test module for the regression scope: `test_*.py`, `*_test(s).py`, Django's
 * `tests.py`, pylint's `unittest_*.py`. Everything else under a tests directory is support code
 * (Django's `tests/schema/fields.py` is a models file; `isTestFile` accepts it, the runner cannot).
 */
const TEST_MODULE_BASENAME = /^(test_.*|.*_tests?|tests|unittest_.*)\.py$/;
/**
 * Test directories that need an external service or backend and abort or skip the whole run
 * without it (Django's `gis_tests` aborts runtests.py: "A GIS database backend is required");
 * never in the scope.
 */
const EXTERNAL_BACKEND_SEGMENT = /(^|_)(gis|postgres|postgresql|mysql|oracle|redis|memcached?|selenium|docker)(_|$)/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const INCOMPLETE_SNIPPET_EXCEPTIONS = /^(NameError|ImportError|ModuleNotFoundError|SyntaxError)$/;

// ---------------------------------------------------------------------------------------
// Workspace shape
// ---------------------------------------------------------------------------------------

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

/** A test module the regression scope may run (see TEST_MODULE_BASENAME and EXTERNAL_BACKEND_SEGMENT). */
export function isScopeTestModule(path: string): boolean {
  if (!isTestFile(path)) return false;
  const segs = path.split('/');
  const base = segs.pop() ?? '';
  if (!TEST_MODULE_BASENAME.test(base)) return false;
  return !segs.some((d) => EXTERNAL_BACKEND_SEGMENT.test(d));
}

/** Repository-class by shape (see the constants): a whole-project runner, or many source or test files. */
export function isRepositoryWorkspace(info: Pick<TestCommand, 'runner'> | null, paths: readonly string[]): boolean {
  if (info !== null && (info.runner === 'django' || info.runner === 'sympy_bintest')) return true;
  const py = paths.filter((p) => p.endsWith('.py'));
  const source = py.filter((p) => !isTestPath(p)).length;
  const tests = py.filter((p) => isTestFile(p)).length;
  return source >= REPOSITORY_MIN_SOURCE_FILES || tests >= REPOSITORY_MIN_TEST_FILES;
}

/**
 * The importable top-level package of the checkout: the directory (at the root or under `src/`)
 * with an `__init__.py` and the most Python files under it, test directories excluded. `_pytest`
 * for pytest-dev (its `src/pytest/` is a two-file shim), `django`, `sympy`, `pylint`, `requests`.
 * Null when no package is found (a flat single-module workspace).
 */
export function packageNameOf(paths: readonly string[]): string | null {
  const counts = new Map<string, number>();
  const packages = new Set<string>();
  for (const p of paths) {
    if (!p.endsWith('.py')) continue;
    const segs = p.split('/');
    const top = segs[0] === 'src' ? segs.slice(0, 2).join('/') : (segs[0] ?? '');
    const depth = segs[0] === 'src' ? 2 : 1;
    if (segs.length <= depth) continue;
    if (segs.length === depth + 1 && segs[depth] === '__init__.py') packages.add(top);
    if (!isTestPath(p)) counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const pkg of packages) {
    const n = counts.get(pkg) ?? 0;
    if (n > bestCount || (n === bestCount && best !== null && pkg < best)) {
      best = pkg;
      bestCount = n;
    }
  }
  return best === null ? null : (best.split('/').pop() ?? best);
}

/** The framework preamble the runner needs: Django's settings + in-memory database; nothing for the rest. */
export function frameworkOf(packageName: string | null): 'django' | null {
  return packageName === 'django' ? 'django' : null;
}

/** `<root>/.venv/bin/python` when the workspace carries its own interpreter (the SWE-bench setup builds one), else undefined. */
export async function venvPython(root: string): Promise<string | undefined> {
  const py = join(root, '.venv', 'bin', 'python');
  try {
    await access(py);
    return py;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------
// The best-guess goal (no oracle)
// ---------------------------------------------------------------------------------------

function sha8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

export function isReproTestId(id: string): boolean {
  return id.startsWith(REPRO_ID_PREFIX);
}

export function isBestGuessTestId(id: string): boolean {
  return id.startsWith(BEST_GUESS_ID_PREFIX);
}

/** `issue::<hash8>` over the task text: the one synthetic "test" a best-guess goal is named by (plan grammar `fix issue::… in <path>`). */
export function bestGuessTestId(task: string): string {
  return `${BEST_GUESS_ID_PREFIX}${sha8(task.trim())}`;
}

/** The FailureView the search shows Jev for a best-guess goal: the issue's first line, and the honest fact that nothing reproduces it. */
export function bestGuessFailure(task: string): FailureView {
  const title = task
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('```')) ?? 'the reported issue';
  return { testId: bestGuessTestId(task), call: title.length > 160 ? `${title.slice(0, 157)}...` : title, expected: 'the behaviour the issue reports is fixed', actual: 'no reproduction oracle could be built from the issue text; the fix is a best guess' };
}

// ---------------------------------------------------------------------------------------
// The oracle from the issue
// ---------------------------------------------------------------------------------------

/**
 * `valid` / `valid_weak`: a reproduction goal; `weak_network`: a goal too, but its verdict is the
 * network's as much as the code's (`detectNetworkUse`) — a passer needs the scoped regression
 * run AND the guard's arbitration (Q15/Q16) before a commit, and the evidence carries
 * NETWORK_ORACLE_OPEN_PROBLEM; `unstable`: the base verdict did not repeat (fail/pass or
 * pass/fail across two runs of the same commit) — no goal, the best guess; the rest: no goal.
 * `llm_valid` / `llm_weak` (docs/LLM-JEV-DESIGN.md §4.10) are the LLM-written reproductions of
 * stage 3 (`synth/llm/repro.ts`); this search never produces them. The union itself lives in
 * core/types.ts so the engine's completion evidence (§6.6) names the same members.
 */
export type OracleOutcome = CoreOracleOutcome;

/** The `openProblems` entry every proposal made under a network-dependent oracle must carry. */
export const NETWORK_ORACLE_OPEN_PROBLEM = 'network-dependent reproduction';

/** Outcomes that yield a reproduction goal (the search verifies candidates against it). */
export function oracleYieldsGoal(outcome: string): outcome is 'valid' | 'valid_weak' | 'weak_network' {
  return outcome === 'valid' || outcome === 'valid_weak' || outcome === 'weak_network';
}

/**
 * Whether a lone passer of this oracle must go through the guard's arbitration (Q15/Q16) before
 * a commit rather than being committed on its regression run alone: a network-dependent oracle's
 * `plausible` is one lane run of the network.
 */
export function oracleNeedsArbitration(outcome: string): boolean {
  return outcome === 'weak_network';
}

export type OracleAsk = (stage: StageName, state: Json, questions: Record<string, Question>) => Promise<{ answers: Record<string, Answer> }>;

export interface OracleSearchInput {
  /** the task text (the issue) */
  task: string;
  /** label of the repository for the Jev state (`sympy`, `django`; the package name when nothing better is known) */
  repository: string;
  packageName: string | null;
  framework: 'django' | null;
  /** absolute path of the committed workspace */
  workspace: string;
  ask: OracleAsk;
  run: VerifyRunFn;
  /** interpreter for the snippet (the workspace venv); the runner's own pick otherwise */
  python?: string;
  timeoutMs?: number;
  stage?: StageName;
}

export interface OracleSearch {
  outcome: OracleOutcome;
  /** 'strong' or 'weak' for a valid oracle, null otherwise */
  strength: CriterionStrength | null;
  /** the reproduction goal: present only for `valid` / `valid_weak` / `weak_network` */
  goal: ReproGoal | null;
  /** how the reproduction depends on the network (outcome `weak_network`, or the cause behind an `env_error`); null / absent otherwise */
  network?: NetworkUse | null;
  extraction: Extraction;
  judgement: OracleJudgement | null;
  choice: BlockChoice | null;
  /** traceback frames Jev put ≥ PICK_THRESHOLD on being inside the fix, most probable first */
  anchors: FrameJudgement[];
  /** the anchors and the base run's raising frames as Python traceback lines, for the localizer's `traceback` */
  traceback: string | null;
  requests: number;
  /** one human-readable line for the transcript and openProblems */
  note: string;
  durationMs: number;
}

/** Render frames as CPython prints them so localize/outline.ts `tracebackFrames` reads them back. */
export function tracebackTextFor(anchors: readonly FrameJudgement[], result: ReproRunResult | null): string | null {
  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (f: TracebackFrame): void => {
    if (/^<.*>$/.test(f.file) || f.file === '') return;
    const key = `${f.file}:${f.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(`  File "${f.file}", line ${f.line}, in ${f.fn ?? '<module>'}`);
  };
  for (const a of anchors) push(a.frame);
  if (result !== null) {
    const raising = evidenceStatements(result).find((s) => s.exception !== null);
    for (const f of raising?.exception?.frames ?? []) push(f);
  }
  return lines.length === 0 ? null : `Traceback (most recent call last):\n${lines.join('\n')}`;
}

/** The reporter's snippet stops on a name the library does not export or a module it does not provide: no patch to the library can make it pass. */
export function snippetIncomplete(goal: ReproGoal): string | null {
  const last = goal.verdict.statement ?? evidenceStatements(goal.result).at(-1) ?? null;
  const exc = last?.exception ?? null;
  if (exc === null || !INCOMPLETE_SNIPPET_EXCEPTIONS.test(exc.type)) return null;
  return `${exc.type}: ${exc.message.slice(0, 120)}`;
}

/**
 * The whole oracle pipeline for one task text, once per run. Never throws on a failing snippet:
 * every exit is an `outcome` with a note. One Jev request at most.
 */
export async function findIssueOracle(input: OracleSearchInput): Promise<OracleSearch> {
  const started = Date.now();
  const extraction = extractBlocks(input.task);
  const none = (outcome: OracleOutcome, note: string, partial: Partial<OracleSearch> = {}): OracleSearch => ({
    outcome,
    strength: null,
    goal: null,
    network: null,
    extraction,
    judgement: null,
    choice: null,
    anchors: [],
    traceback: null,
    requests: 0,
    note,
    durationMs: Date.now() - started,
    ...partial,
  });
  if (extraction.blocks.length === 0) return none('no_blocks', 'no code block or transcript in the task text to run');
  const set = oracleQuestions({ repository: input.repository, problemStatement: input.task, extraction });
  const res = await input.ask(input.stage ?? 'propose', set.state, set.questions);
  const judgement = readOracleAnswers(set, res.answers);
  const choice = chooseBlocks(extraction, judgement);
  const anchors = choice.anchors;
  const common = { judgement, choice, anchors, requests: 1, traceback: tracebackTextFor(anchors, null) };
  if (choice.reproduction === null) {
    const best = [...judgement.blocks].sort((a, b) => b.isReproduction - a.isReproduction)[0];
    const bestBlock = best === undefined ? null : (extraction.blocks.find((b) => b.index === best.index) ?? null);
    if (best !== undefined && bestBlock !== null && best.isReproduction >= PICK_THRESHOLD && !isRunnable(bestBlock)) {
      return none('not_runnable', `the reproduction (block ${bestBlock.index}, ${bestBlock.kind}) is a test module or a command, not statements a script runner can execute`, common);
    }
    return none('no_pick', `no block reads as a reproduction (best is_reproduction ${(best?.isReproduction ?? 0).toFixed(2)} on block ${best?.index ?? '-'})`, common);
  }
  const block = choice.reproduction;
  const cwc = chunksWithContext(block, extraction);
  const built = buildCriterion({ failureKind: judgement.failureKind, reproduction: block, expected: choice.expected, actual: choice.actual, expectations: extraction.expectations, chunkOffset: cwc.offset }, extraction.tracebacks);
  if (built === null) return none('no_criterion', `block ${block.index} reproduces but no pass criterion can be stated (failure_kind ${judgement.failureKind})`, common);
  const options: Omit<ReproRunOptions, 'workspace' | 'python'> = { packageName: input.packageName, framework: input.framework, timeoutMs: input.timeoutMs ?? REPRO_TIMEOUT_MS };
  const runOpts: ReproRunOptions = { ...options, workspace: input.workspace };
  if (input.python !== undefined) runOpts.python = input.python;
  const result = await runRepro(input.run, cwc.chunks, runOpts);
  const goal = reproductionGoal({ block, chunks: cwc.chunks, built, result, options });
  const traceback = tracebackTextFor(anchors, result);
  const evidence = evidenceStatements(result);
  if (result.status !== 'ran' || evidence.length === 0) {
    const network = detectNetworkUse(cwc.chunks, result);
    return none('env_error', `the reproduction could not run (${result.status}${result.outputTail === '' ? '' : `: ${result.outputTail.slice(-160).replace(/\s+/g, ' ')}`})${network === null ? '' : `; network: ${network.evidence}`}`, { ...common, traceback, network });
  }
  // A statement that failed on the network is an environment gap the criterion does not see
  // (runner.ts `is_environment`); a "pass" made of the statements around it is no verdict at all
  // (requests-2931 offline: `import requests` ran, the `put` raised ConnectionError, nothing shows the bug).
  const offline = detectNetworkUse([], result);
  if (offline?.kind === 'runtime' && goal.verdict.pass) {
    return none('env_error', `the reproduction's network call failed (${offline.evidence}); the statements that ran show no verdict`, { ...common, traceback, network: detectNetworkUse(cwc.chunks, result) });
  }
  // The verdict must be a fact of the workspace, not of the process: the same script runs once
  // more on the same commit (≈ 0.4–6.5 s) and must give the same verdict. A snippet that fails
  // and then passes with nothing changed (randomness, time, order of an unordered collection —
  // django-15315's `assert f in d`: `hash(None)` is address-based on CPython 3.9, so the seed does
  // not pin it) would make every lane verdict a coin toss and the "passers" dead code; the
  // symmetric pass-then-fail says the base shows a pass rate above zero and below one, which is
  // the same coin seen from the other side (rung 3, §21.4 addendum). Either way the oracle is
  // refused and the run falls back to the best guess. A confirmation run that did not report
  // (timeout, runner error) keeps the first verdict and says so in the note.
  const again = await runRepro(input.run, cwc.chunks, runOpts);
  const againVerdict = evaluateCriterion(built.criterion, again);
  const confirmed = again.status === 'ran' && evidenceStatements(again).length > 0;
  if (goal.verdict.pass) {
    if (confirmed && !againVerdict.pass) {
      return none('unstable', `the reproduction passed once at the base commit (${goal.verdict.actual.slice(0, 60)}) and failed when run again (${againVerdict.actual.slice(0, 60)}): its verdict is a coin, not a fact of the code`, { ...common, traceback });
    }
    return none('passes_on_base', `the criterion (${built.expectedText.slice(0, 80)}) already passes at the base commit${confirmed ? ' (twice)' : ''}: the snippet does not show the bug as run`, { ...common, traceback });
  }
  const incomplete = snippetIncomplete(goal);
  if (incomplete !== null) return none('incomplete_snippet', `the snippet stops on ${incomplete}: a name or module the repository does not provide`, { ...common, traceback });
  if (confirmed && againVerdict.pass) {
    return none('unstable', `the reproduction failed once (${goal.failure.actual.slice(0, 60)}) and passed when run again on the same commit (${againVerdict.actual.slice(0, 60)}): its verdict is not a stable fact of the code`, { ...common, traceback });
  }
  // A reproduction that talks to the network (requests-2931: `requests.put("http://httpbin.org/put", …)`)
  // has a verdict that is the network's as much as the code's: it stays an oracle (it did find the
  // failure at base and can sort candidates), but as `weak_network` — a passer needs the scoped
  // regression run and the guard's arbitration before a commit, and the evidence names the problem.
  const network = detectNetworkUse(cwc.chunks, result) ?? detectNetworkUse([], again);
  const strength: CriterionStrength = network === null ? built.strength : 'weak';
  const outcome: OracleOutcome = network !== null ? 'weak_network' : built.strength === 'weak' ? 'valid_weak' : 'valid';
  const confirmation = confirmed ? `confirmed by a second run in ${again.durationMs} ms` : `confirmation run did not report (${again.status}); first verdict kept`;
  const networkNote = network === null ? '' : `; ${NETWORK_ORACLE_OPEN_PROBLEM} (${network.evidence}): passers need the regression run and Jev's arbitration`;
  return {
    outcome,
    strength,
    goal,
    network,
    extraction,
    judgement,
    choice,
    anchors,
    traceback,
    requests: 1,
    note: `${network === null ? built.strength : 'network-weak'} oracle ${goal.spec.testId} from block ${block.index}: ${goal.failure.call.slice(0, 60)} -> ${goal.failure.actual.slice(0, 60)} (expected ${built.expectedText.slice(0, 60)}; ${built.criterion.form}; ${confirmation}${networkNote})`,
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------------------
// The regression scope and its command
// ---------------------------------------------------------------------------------------

function shellWords(command: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  for (const m of command.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out.filter((w) => w !== '');
}

const PROGRAM_WORD = /(^|\/)(runtests\.py|test|pytest|py\.test|python[0-9.]*)$/;

/**
 * The detector's command (`python tests/runtests.py --parallel 1`, `python bin/test`, `python -m
 * pytest -q`) plus the flags the harness's own `test_cmd` template carries (`--verbosity 2
 * --settings=test_sqlite`, `-C --verbose`, `-rA`): those make the runner print per-test ids,
 * which the regression check compares. The program stays the detector's, so the engine's
 * `isTestCommand` (same program) parses the run's counts; environment assignments and the
 * template's own program words are dropped. No template: the detector's command as is.
 */
export function regressionCommandTemplate(info: Pick<TestCommand, 'command' | 'runner'>, specCmd: string | null): TestCommand {
  const base = info.command.trim();
  if (specCmd === null || specCmd.trim() === '') return { command: base, runner: info.runner };
  const baseWords = new Set(shellWords(base));
  const words = shellWords(specCmd).filter((w) => !ENV_ASSIGNMENT.test(w));
  const flags: string[] = [];
  let i = 0;
  // skip the interpreter and the program (`python -m pytest`, `./tests/runtests.py`, `bin/test`, `pytest`)
  while (i < words.length && (PROGRAM_WORD.test(words[i] ?? '') || words[i] === '-m')) i += 1;
  for (; i < words.length; i++) {
    const w = words[i] ?? '';
    if (baseWords.has(w)) {
      // a flag the base already carries: skip its value too when the next word is not a flag and is also in the base
      const next = words[i + 1];
      if (next !== undefined && !next.startsWith('-') && baseWords.has(next)) i += 1;
      continue;
    }
    flags.push(w);
  }
  return { command: flags.length === 0 ? base : `${base} ${flags.join(' ')}`, runner: info.runner };
}

export type ScopeTier = 'related' | 'stem' | 'fallback' | 'none';

export interface RegressionScopeChoice {
  /** ≤ REGRESSION_SCOPE_MAX test files, best first */
  testFiles: string[];
  /** the scoped command, null when the workspace has no test file at all */
  command: string | null;
  tier: ScopeTier;
  note: string;
}

function singular(s: string): string {
  const w = s.toLowerCase();
  if (w.endsWith('ies') && w.length > 5) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ses') && w.length > 5) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > STEM_MIN_CHARS) return w.slice(0, -1);
  return w;
}

/** The stems a module path names, most specific first: its basename (the directory for `__init__.py`), then its parent directory; singularised, generic ones dropped. */
export function moduleStems(modulePath: string): string[] {
  const segs = modulePath.replace(/\.py$/, '').split('/').filter((s) => s !== '' && s !== 'src');
  let name = segs.pop() ?? '';
  if (name === '__init__') name = segs.pop() ?? '';
  const parent = segs.pop() ?? '';
  const out: string[] = [];
  for (const raw of [name, parent]) {
    const s = singular(raw.replace(/^_+/, ''));
    if (s.length < STEM_MIN_CHARS || GENERIC_STEMS.has(s) || out.includes(s)) continue;
    out.push(s);
  }
  return out;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** How well one test-path segment part names a stem: 3 equal, 2 a shared prefix ≥ STEM_PREFIX_MIN, 1 one contains the other (≥ 5 chars). */
function stemMatch(part: string, stem: string): number {
  if (part === stem) return 3;
  if (commonPrefix(part, stem) >= STEM_PREFIX_MIN) return 2;
  if (part.length >= 5 && stem.length >= 5 && (part.includes(stem) || stem.includes(part))) return 1;
  return 0;
}

/**
 * Test files whose directory or basename is named after the module (the stem tier): Django's
 * `tests/model_fields/tests.py` for `django/db/models/fields/__init__.py`, `tests/aggregation/`
 * for `aggregates.py`, `tests/queries/` for `sql/query.py`. Directory matches outrank basename
 * matches; a file matching several stems outranks one; ties break on the shorter path.
 */
export function stemRelatedTestFiles(paths: readonly string[], moduleFiles: readonly string[], max: number): string[] {
  const stems = [...new Set(moduleFiles.flatMap(moduleStems))];
  if (stems.length === 0 || max <= 0) return [];
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    if (!isScopeTestModule(path) || moduleFiles.includes(path)) continue;
    const segs = path.replace(/\.py$/, '').split('/');
    const base = (segs.pop() ?? '').replace(/^test_?/, '').replace(/_tests?$/, '');
    let score = 0;
    stems.forEach((stem, k) => {
      let best = 0;
      for (const dir of segs) for (const part of dir.split(/[_-]/)) best = Math.max(best, stemMatch(singular(part), stem) * 2);
      for (const part of base.split(/[_-]/)) best = Math.max(best, stemMatch(singular(part), stem));
      // the module's own name weighs double its parent directory's (`aggregates.py` under `models/`: `aggregation` before `model_fields`)
      score += best * (k === 0 ? 2 : 1);
    });
    if (score > 0) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return scored.slice(0, max).map((s) => s.path);
}

export interface ChooseScopeOptions {
  /** test-file contents for the import check (read once; ≤ 130 ms for Django's 1,185 test files) */
  contents?: (path: string) => string | null | undefined;
  max?: number;
}

/**
 * The ≤ 6 test files the regression run covers, in tiers: `relatedTestFiles` (name, directory,
 * imports; finds the F2P file for 20/30 SWE-bench gold modules), then the stem tier when fewer
 * than RELATED_MIN_BEFORE_STEM were found, then — so the engine always has a run to parse — the
 * two shortest test paths under the module's package or the repository's tests directory.
 */
export function chooseRegressionScope(allPaths: readonly string[], moduleFiles: readonly string[], opts: ChooseScopeOptions = {}): Omit<RegressionScopeChoice, 'command'> {
  const max = opts.max ?? REGRESSION_SCOPE_MAX;
  // only runnable test modules compete (support files under tests/ and external-backend suites are out)
  const paths = allPaths.filter((p) => !isTestFile(p) || isScopeTestModule(p));
  const related = relatedTestFiles(paths, moduleFiles, { max, ...(opts.contents === undefined ? {} : { contents: opts.contents }) });
  const stems = related.length >= max ? [] : stemRelatedTestFiles(paths, moduleFiles, max).filter((p) => !related.includes(p)).slice(0, max - related.length);
  const combined = [...related, ...stems];
  if (combined.length > 0) return { testFiles: combined, tier: related.length > 0 ? 'related' : 'stem', note: `${related.length} test file${related.length === 1 ? '' : 's'} import or are named after ${moduleFiles.join(', ')}${stems.length > 0 ? `; ${stems.length} named after the module's stem (${moduleStems(moduleFiles[0] ?? '').join(', ') || '-'})` : ''}` };
  const tests = paths.filter(isScopeTestModule).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  const top = moduleFiles[0]?.split('/')[0] ?? '';
  const near = tests.filter((p) => top !== '' && p.startsWith(`${top}/`));
  const fallback = (near.length > 0 ? near : tests).slice(0, 2);
  if (fallback.length === 0) return { testFiles: [], tier: 'none', note: 'the workspace has no test file: no regression check is possible' };
  return { testFiles: fallback, tier: 'fallback', note: `no test file names ${moduleFiles.join(', ')}; the regression run covers ${fallback.join(', ')} as a smoke check only` };
}

/** The scoped command for the chosen files, or null when there is none (`scopedTestCommand` per runner). */
export function scopeCommand(template: TestCommand, testFiles: readonly string[]): string | null {
  if (testFiles.length === 0) return null;
  return scopedTestCommand(template, testFiles);
}

// ---------------------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------------------

/**
 * The scoped run and the one-test reproduction as one summary: the ledger's baseline on a
 * repository workspace. `command` and `durationMs` are the scoped run's (the engine executes
 * that command; the oracle model reads its duration); the reproduction's test id joins the id
 * lists so `progress()` sees it newly passing after a fix and the guard finds it in `passing`.
 */
export function mergeSummaries(scoped: TestRunSummary, repro: TestRunSummary | null): TestRunSummary {
  if (repro === null) return scoped;
  return {
    ...scoped,
    passed: scoped.passed + repro.passed,
    failed: scoped.failed + repro.failed,
    errors: scoped.errors + repro.errors,
    total: scoped.total + repro.total,
    failing: [...scoped.failing, ...repro.failing],
    passing: [...scoped.passing, ...repro.passing],
    failures: [...scoped.failures, ...repro.failures],
    timedOut: scoped.timedOut || repro.timedOut,
  };
}

/** The merged summary without its reproduction test (the scoped run alone). */
export function scopedPartOf(merged: TestRunSummary): TestRunSummary {
  const keep = (id: string): boolean => !isReproTestId(id);
  const failing = merged.failing.filter(keep);
  const passing = merged.passing.filter(keep);
  const dropped = merged.failing.length - failing.length + (merged.passing.length - passing.length);
  if (dropped === 0) return merged;
  const droppedFailing = merged.failing.length - failing.length;
  const droppedPassing = merged.passing.length - passing.length;
  return { ...merged, failing, passing, failures: merged.failures.filter((f) => keep(f.testId)), failed: Math.max(0, merged.failed - droppedFailing), passed: Math.max(0, merged.passed - droppedPassing), total: Math.max(0, merged.total - dropped) };
}

/** An empty run for a workspace with no regression scope (nothing ran, nothing failed). */
export function emptyScopedSummary(command: string): TestRunSummary {
  return { command, passed: 0, failed: 0, errors: 0, skipped: 0, total: 0, failing: [], passing: [], failures: [], exitCode: 0, timedOut: false, durationMs: 0, outputTail: '' };
}
