/**
 * L2 — the reproduction writer (docs/LLM-JEV-DESIGN.md §4.10; repository class only, once per
 * run, when the workspace has no failing test and the code oracle is not valid). N = 3 parallel
 * `write_reproduction` samples (temperature 0 / 0.7 / 0.7), as many as the step's dollar counter
 * covers at their full estimate (§4.11). Code then refuses a script that exits, reads stdin,
 * spawns a process or writes files (`scriptProblems`; the network is a runtime tell, §4.10), one
 * whose `issue_quote` is not a verbatim ≥ 6-token substring of the issue (the assertion must be
 * anchored in the issue text, not in the model's reading of it), and a duplicate; the rest run
 * under the sentinel harness **in a scratch copy of the workspace, never the workspace itself**
 * (`ReproScratch`: one lane per concurrent run; by default `git worktree` copies under the
 * sandbox's tmp with the workspace's uncommitted changes replayed, plain `cp -R` copies of a
 * workspace that is not a git checkout) — the first base runs
 * concurrently across the lanes, a confirmation run only for the scripts that failed once, again
 * concurrently — with criterion `{form: 'no_exception'}`, and rejects one that did not run, passes
 * at base, stops on a NameError/ImportError-class exception, needs the network, changed a file of
 * its copy, or gives a different verdict on the second run. Only the survivors reach Jev Q18,
 * graded against `LLM_REPRODUCTION_CRITERIA` (what an LLM-written script must satisfy: it fails
 * now for the issue's reason and asserts only what the issue promises); one survivor is decided on
 * its Noul alone (one option is not a choice), with ≥ 2 the Choice picks and the escape is recorded
 * for routing only — never a gate. The pick becomes a `ReproGoal` with outcome `llm_valid`
 * (Noul ≥ 0.7) or `llm_weak` (0.3 ≤ p < 0.7). An `llm_*` oracle never satisfies the completion
 * fact (§6.6). Every sample is metered (§8.1): a priced result at its cost, a timed-out, cancelled
 * or failed one from what it streamed plus the reasoning allowance (source.ts
 * `unfinishedSampleUsage`), charged to the step's `llmUsdLeft` when a budget is given.
 *
 * TODO(stage 4, src/jev-modes/synth/oracle/search.ts): `OracleOutcome += 'llm_valid' | 'llm_weak'`,
 * `oracleYieldsGoal` and `oracleNeedsArbitration` true for both; `RepositoryMode.repro` persists
 * the pick with `oracleOutcome`. Until then the members are declared here (`LlmOracleOutcome`).
 */
import { dirname } from 'node:path';
import { clip } from '../../../core/text.js';
import type { Answer, CancelledGeneration, GenerateRequest, Json, Question, StageName, SynthesizerGeneration, TokenUsage } from '../../../core/types.js';
import { monotonicNow } from '../../../core/time.js';
import { ESCAPE_KEY, assertQuestionBatch, choice, noul, type NoulCriteriaSpec } from '../../../jev/questions.js';
import { reproductionGoal, type ReproGoal } from '../oracle/goal.js';
import { FAILURE_KINDS, isFailureKind } from '../oracle/questions.js';
import { REPRO_TIMEOUT_MS, detectNetworkUse, evaluateCriterion, evidenceStatements, runRepro, type BuiltCriterion, type ReproRunOptions } from '../oracle/runner.js';
import { snippetIncomplete, venvPython, type OracleAsk } from '../oracle/search.js';
import type { CodeBlock, Extraction, FailureKind, ReproRunResult, Verdict } from '../oracle/types.js';
import { shellQuote } from '../verify/text.js';
import type { VerifyRunFn, VerifyRunResult } from '../verify/types.js';
import { REPRO_LIMITS, WRITE_REPRODUCTION_TOOL, WRITE_REPRODUCTION_TOOL_NAME, isLengthStop, parseWriteReproduction, type ReproductionOutput } from './schema.js';
import { LLM_DEFAULT_GENERATION, affordableSamples, costOf, estimatedSampleUsage, generateWithDeadline, sampleSeed, unfinishedSampleUsage, type LlmBudget, type LlmPricing, type SampleEnd } from './source.js';
import { reasoningEnabled, type GenerateFn } from './types.js';

export type LlmOracleOutcome = 'llm_valid' | 'llm_weak';

/** The `openProblems` note every proposal made under an LLM-written oracle carries. */
export const LLM_ORACLE_OPEN_PROBLEM = 'llm-written reproduction';

export function isLlmOracle(outcome: string): outcome is LlmOracleOutcome {
  return outcome === 'llm_valid' || outcome === 'llm_weak';
}

/** Both outcomes yield a goal and both send a lone passer through the Q16 advisory (§4.10). */
export function llmOracleYieldsGoal(outcome: string): boolean {
  return isLlmOracle(outcome);
}
export function llmOracleNeedsArbitration(outcome: string): boolean {
  return isLlmOracle(outcome);
}

export const REPRO_SAMPLES = 3;
export const REPRO_TEMPERATURES: readonly number[] = [0, 0.7, 0.7];
export const REPRO_DEADLINE_MS = 20_000;
export const REPRO_ISSUE_CHARS = 8000;
export const REPRO_BLOCKS_SHOWN = 6;
export const REPRO_BLOCK_CHARS = 1500;
/** `issue_quote` must share this many consecutive tokens with the issue text */
export const ISSUE_QUOTE_MIN_TOKENS = 6;
export const Q18 = { choiceId: 'reproduction', noulPrefix: 'reproduces_issue_', failureKindId: 'failure_kind', validP: 0.7, weakP: 0.3, tieMargin: 0.05 } as const;

// ---------------------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------------------

export function buildReproSystemPrompt(): string {
  return [
    'You write a reproduction for a bug reported against a Python repository. Return one standalone script of top-level statements as `write_reproduction`.',
    'The script must raise (or fail an `assert`) while the bug exists and complete silently once the bug is fixed. Never call `sys.exit`, never print a verdict, never catch the failure you are demonstrating. No network, no files, no user input.',
    `At most ${REPRO_LIMITS.scriptLines} lines. \`issue_quote\` copies verbatim the sentence of the issue your assertion encodes; \`expected_behaviour\` states in one sentence what the assertion checks.`,
  ].join('\n');
}

export interface ReproPromptInput {
  task: string;
  repository: string;
  packageName: string | null;
  framework: 'django' | null;
  extraction: Extraction;
}

export function buildReproUserMessage(input: ReproPromptInput): string {
  const parts: string[] = [`# Issue (${input.repository})`, clip(input.task.trim(), REPRO_ISSUE_CHARS)];
  parts.push(`## Package\n${input.packageName ?? 'unknown'} — import from it directly.${input.framework === 'django' ? ' The harness configures Django settings (in-memory sqlite, an app for models you define) before your statements run; do not call `django.setup()` or configure settings yourself.' : ''}`);
  const blocks = input.extraction.blocks.filter((b) => b.kind === 'code' || b.kind === 'repl').slice(0, REPRO_BLOCKS_SHOWN);
  if (blocks.length > 0) {
    parts.push('## Code in the issue');
    for (const b of blocks) parts.push(`block ${b.index} (${b.kind}):`, '```', clip(b.text, REPRO_BLOCK_CHARS), '```');
  }
  if (input.extraction.tracebacks.length > 0) {
    parts.push('## Exceptions reported');
    for (const t of input.extraction.tracebacks.slice(0, 4)) parts.push(`- ${t.exceptionType}${t.message === '' ? '' : `: ${clip(t.message, 200)}`}`);
  }
  if (input.extraction.expectations.length > 0) {
    parts.push('## Statements of expected behaviour');
    for (const e of input.extraction.expectations.slice(0, 8)) parts.push(`- ${clip(e.text, 300)}`);
  }
  parts.push('## Reply\nCall `write_reproduction`.');
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------------------
// Code checks
// ---------------------------------------------------------------------------------------

const WORD = /[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;

function tokensOf(s: string): string[] {
  return (s.toLowerCase().match(WORD) ?? []).filter((t) => /[a-z0-9_]/.test(t));
}

/** True when ≥ `minTokens` consecutive word tokens of `quote` appear consecutively in `issue` (case- and whitespace-insensitive). */
export function issueQuoteAnchored(issue: string, quote: string, minTokens = ISSUE_QUOTE_MIN_TOKENS): boolean {
  const q = tokensOf(quote);
  if (q.length < minTokens) return false;
  const text = ` ${tokensOf(issue).join(' ')} `;
  for (let i = 0; i + minTokens <= q.length; i++) {
    if (text.includes(` ${q.slice(i, i + minTokens).join(' ')} `)) return true;
  }
  return false;
}

/**
 * `open(..., 'w' | 'a' | 'x' | '+')` (also `io.open`, `codecs.open`): a mode literal made of mode letters only, in the mode's
 * place — after a comma or `mode=`, or first in a method call (`Path(...).open('w')`) — so a file *name* made of mode letters
 * (`open('a')`) is not one.
 */
const WRITE_OPEN_RE = /(?:\.open\s*\(\s*|\bopen\s*\([^)]*(?:,|\bmode\s*=)\s*)['"][rbtU]*[wax+][rwaxbt+U]*['"]/;
/** `os` calls that create, change or remove files, or spawn / signal processes. */
const OS_WRITE_RE = /\bos\.(?:remove|unlink|rename|renames|replace|makedirs|mkdir|rmdir|removedirs|truncate|chmod|chown|symlink|link|open|write|fdopen|popen|fork|forkpty|exec\w*|spawn\w*|kill|killpg)\s*\(/;
const SHUTIL_RE = /\bshutil\./;
/** pathlib writers whose names no common string / data-frame method shares (`.rename` / `.replace` are left to the scratch copy). */
const PATHLIB_WRITE_RE = /\.(?:write_text|write_bytes|mkdir|unlink|rmdir|touch|symlink_to|hardlink_to)\s*\(/;
const PROCESS_RE = /\bsubprocess\b|\bos\.system\s*\(|\bmultiprocessing\b|\bpty\.(?:spawn|fork)\s*\(/;

/**
 * A script the harness refuses before running it: too long, exits the process, reads stdin, spawns a process, or writes
 * files (write-mode `open`, `os.remove` / `rename` / `makedirs` …, `shutil.*`, pathlib writers). The prompt's "no files" is
 * a code rule here; whatever slips past it runs in a scratch copy and is caught by the copy's status afterwards. "No network"
 * is not a static rule: a repository-class package may be a network library itself (`requests`, `urllib3`, `httpx`), so an
 * import proves nothing; the sandbox has no network and the base run's `detectNetworkUse` (import + URL literal + network
 * error, §4.10) rejects the script that actually needed it.
 */
export function scriptProblems(script: string): string | null {
  const lines = script.split('\n');
  if (lines.length > REPRO_LIMITS.scriptLines) return `${lines.length} lines, at most ${REPRO_LIMITS.scriptLines}`;
  if (/\bsys\.exit\s*\(|\bexit\s*\(|\bquit\s*\(|\bos\._exit\s*\(/.test(script)) return 'calls sys.exit / exit (the harness reads SystemExit as an exception)';
  if (/\binput\s*\(/.test(script)) return 'reads stdin';
  if (PROCESS_RE.test(script)) return 'spawns a process';
  if (WRITE_OPEN_RE.test(script)) return 'opens a file for writing';
  if (OS_WRITE_RE.test(script)) return 'creates, changes or removes files through `os`';
  if (SHUTIL_RE.test(script)) return 'copies, moves or removes files (shutil)';
  if (PATHLIB_WRITE_RE.test(script)) return 'writes files through pathlib';
  if (!/\S/.test(script)) return 'empty';
  return null;
}

function blockFor(k: number, script: string): CodeBlock {
  return { index: 1000 + k, kind: 'code', origin: 'fence', lang: 'python', text: script, startLine: 0, endLine: 0, tracebacks: [] };
}

// ---------------------------------------------------------------------------------------
// Q18
// ---------------------------------------------------------------------------------------

/**
 * What an LLM-written script must satisfy to become the run's oracle (§4.10). The code oracle's `REPRODUCTION_CRITERIA`
 * describe blocks pasted in an issue (its false side — `pip list`, a traceback, the proposed fix — cannot apply to a script
 * code already ran and saw raise); the property code cannot check is on the true side here: the assertion states only what
 * the issue promises, so the script completes once that behaviour is fixed.
 */
export const LLM_REPRODUCTION_CRITERIA: NoulCriteriaSpec = {
  true: {
    definition: 'the script fails at the current commit for the reason the issue describes — the call the reporter names raises the reported exception, or its `assert` compares against the value the issue says is correct — and asserts nothing the issue does not state, so it would complete once the described behaviour is fixed',
    examples: [
      "an `assert` on the return value the issue says the call should produce, made with the reporter's inputs",
      'a bare call the issue says must not raise, with no further check on its result',
      'an `assert result != <the wrong value the issue quotes>` when the issue names the wrong result but not the right one',
    ],
  },
  false: {
    definition: 'the script raises for another reason (a wrong import, a typo, a missing fixture, a call the issue never mentions), asserts a detail the issue does not state (exact message text, `repr` formatting, ordering, a private attribute, a type the issue does not name), or would keep failing after the described fix',
    examples: [
      'an `assert str(e) == "..."` on an error message the issue never quotes, or `assert repr(result) == "..."` where the issue only says the call must not raise',
      'a script that already completes at the current commit, or that crashes on `import` before reaching the library call',
      'an `assert` on the order of a dict or the exact whitespace of a printed value when the issue is about a wrong number',
    ],
  },
};

export interface Q18Script {
  key: string;
  source: string;
  issueQuote: string;
  baseRun: { exceptionType: string; message: string; lastStatement: string };
  lines: number;
}

/**
 * The Q18 request over the survivors: one `reproduces_issue_<k>` Noul per script (`LLM_REPRODUCTION_CRITERIA`), the
 * `failure_kind` Choice, and — only with ≥ 2 scripts — the `reproduction` Choice with its escape. One script is not a
 * choice (guard.ts `adviseLonePasser`): its Noul alone is asked, so no consumed cut sits at 0.5.
 */
export function q18Questions(input: { repository: string; task: string; scripts: readonly Q18Script[] }): { state: Json; questions: Record<string, Question> } {
  const scripts: Record<string, Json> = {};
  const options: Record<string, Json | null> = {};
  for (const s of input.scripts) {
    scripts[s.key] = { source: s.source, issue_quote: s.issueQuote, base_run: { exception_type: s.baseRun.exceptionType, message: clip(s.baseRun.message, 300), last_statement: clip(s.baseRun.lastStatement, 200) } };
    options[s.key] = `${s.lines}-line script raising ${s.baseRun.exceptionType} at \`${clip(s.baseRun.lastStatement, 80)}\`; quotes: "${clip(s.issueQuote, 120)}"`;
  }
  const questions: Record<string, Question> = {};
  if (input.scripts.length >= 2) {
    options[ESCAPE_KEY] = 'No script reproduces the reported bug: each raises for another reason, tests something the issue does not describe, or would keep raising once the bug is fixed.';
    questions[Q18.choiceId] = choice('Which script in `scripts` reproduces the bug `issue.problem_statement` reports: it fails at the current commit for the reason the issue describes and would complete once the described behaviour is fixed? Read each source and its `base_run` literally.', options);
  }
  for (const s of input.scripts) {
    questions[`${Q18.noulPrefix}${s.key}`] = noul(
      `Does \`scripts.${s.key}\` reproduce the reported bug when run against the repository \`issue.repository\`? Read its source, its \`issue_quote\` and \`issue.problem_statement\`; \`base_run\` shows what it raised at the current (buggy) commit. Judge it against \`criteria\`: does it fail for the reason the issue describes, and does its assertion state only what the issue promises, so that it would complete once that behaviour is fixed? Answer literally about this script.`,
      LLM_REPRODUCTION_CRITERIA,
    );
  }
  questions[Q18.failureKindId] = choice('Read `issue.problem_statement`. Which kind of failure does the reporter observe at the current code? Judge the observed behaviour, not the fix.', FAILURE_KINDS);
  assertQuestionBatch(questions);
  const state: Json = {
    issue: { repository: input.repository, problem_statement: clip(input.task, REPRO_ISSUE_CHARS) },
    criteria: {
      reproduces_issue: LLM_REPRODUCTION_CRITERIA.true.definition,
      reproduces_issue_examples: [...LLM_REPRODUCTION_CRITERIA.true.examples],
      not_a_reproduction: LLM_REPRODUCTION_CRITERIA.false.definition,
      not_a_reproduction_examples: [...LLM_REPRODUCTION_CRITERIA.false.examples],
    },
    scripts,
  };
  return { state, questions };
}

export interface Q18Pick {
  key: string | null;
  pChoice: Record<string, number>;
  pEscape: number;
  nouls: Record<string, number>;
  failureKind: FailureKind | null;
  /** ≥ 2 survivors and Jev put more on `none_of_these` than on the top script — recorded for routing (it reaches the note), never a gate */
  escapeAboveTop: boolean;
  outcome: LlmOracleOutcome | 'llm_none';
  reason: string;
}

/**
 * One survivor: its Noul alone decides (no Choice was asked). ≥ 2: the Choice picks — argmax iff it beats the runner-up by
 * > 0.05, else the fewest lines among the near-ties — and the escape is recorded, never consumed; the pick's Noul is the
 * absolute answer: ≥ 0.7 valid, ≥ 0.3 weak, below none.
 */
export function readQ18(answers: Record<string, Answer>, scripts: readonly Q18Script[]): Q18Pick {
  const c = answers[Q18.choiceId];
  const pChoice: Record<string, number> = {};
  let pEscape = 0;
  if (c !== undefined && c.type === 'choice') {
    for (const [k, p] of Object.entries(c.probabilities)) {
      if (k === ESCAPE_KEY) pEscape = p;
      else pChoice[k] = p;
    }
  }
  const nouls: Record<string, number> = {};
  for (const s of scripts) {
    const n = answers[`${Q18.noulPrefix}${s.key}`];
    if (n !== undefined && n.type === 'noul') nouls[s.key] = n.noul;
  }
  const fk = answers[Q18.failureKindId];
  const failureKind: FailureKind | null = fk !== undefined && fk.type === 'choice' && isFailureKind(fk.choice) ? fk.choice : null;
  let escapeAboveTop = false;
  const out = (key: string | null, outcome: Q18Pick['outcome'], reason: string): Q18Pick => ({ key, pChoice, pEscape, nouls, failureKind, escapeAboveTop, outcome, reason });
  const lone = scripts[0];
  if (lone === undefined) return out(null, 'llm_none', 'no script survived the code checks');
  let pick = lone;
  let routing = '';
  if (scripts.length >= 2) {
    const ranked = [...scripts].sort((a, b) => (pChoice[b.key] ?? 0) - (pChoice[a.key] ?? 0));
    const top = ranked[0]!;
    const pTop = pChoice[top.key] ?? 0;
    escapeAboveTop = pEscape > pTop;
    pick = top;
    const runner = ranked[1];
    if (runner !== undefined && pTop - (pChoice[runner.key] ?? 0) <= Q18.tieMargin) {
      const near = ranked.filter((s) => pTop - (pChoice[s.key] ?? 0) <= Q18.tieMargin);
      pick = near.sort((a, b) => a.lines - b.lines || (pChoice[b.key] ?? 0) - (pChoice[a.key] ?? 0))[0]!;
    }
    if (escapeAboveTop) routing = `; Jev put ${pEscape.toFixed(2)} on none_of_these against ${pTop.toFixed(2)} for the best script (recorded, not a gate)`;
  }
  const p = nouls[pick.key] ?? 0;
  if (p >= Q18.validP) return out(pick.key, 'llm_valid', `${pick.key}: reproduces_issue ${p.toFixed(2)} ≥ ${Q18.validP}${routing}`);
  if (p >= Q18.weakP) return out(pick.key, 'llm_weak', `${pick.key}: reproduces_issue ${p.toFixed(2)} in [${Q18.weakP}, ${Q18.validP})${routing}`);
  return out(null, 'llm_none', `${pick.key}: reproduces_issue ${p.toFixed(2)} < ${Q18.weakP}${routing}`);
}

// ---------------------------------------------------------------------------------------
// Scratch copies: the untrusted scripts never run in the workspace
// ---------------------------------------------------------------------------------------

export interface ReproLane {
  /** absolute path of the copy the script runs in: its cwd and `sys.path[0]` */
  root: string;
  /** after a run: the copy's paths the run created, changed or deleted (empty when clean); null when the scratch cannot tell */
  changes(): Promise<string[] | null>;
}

export interface ReproScratch {
  /** concurrent runs (one per lane) */
  readonly lanes: number;
  /** run `fn` on a free lane (waiting when every lane is busy); the lane is restored afterwards */
  withLane<T>(fn: (lane: ReproLane) => Promise<T>): Promise<T>;
  /** remove the copies; idempotent */
  dispose(): Promise<void>;
}

export class ReproScratchError extends Error {
  constructor(message: string) {
    super(`ReproScratchError: ${message}`);
    this.name = 'ReproScratchError';
  }
}

/** Scratch bookkeeping commands (worktree add / remove, the dirt replay, status) are bounded by this. */
export const SCRATCH_COMMAND_TIMEOUT_MS = 120_000;
export const SCRATCH_OUTPUT_BYTES = 256 * 1024;
/** untracked workspace entries replayed into a copy at most (an un-ignored `.venv` lists thousands; tracked changes always replay) */
export const SCRATCH_UNTRACKED_MAX = 200;

export interface WorktreeScratchInput {
  run: VerifyRunFn;
  /** the committed workspace */
  workspace: string;
  /** whether `workspace` is a git checkout (its root has a `.git` entry: worktree copies) or not (`cp -R` copies); probed with `[ -e <workspace>/.git ]` when unset */
  git?: boolean;
  lanes: number;
  /** parent directory of the copies; default `$TMPDIR/jevcode-repro-<tag>` — the sandbox's writable tmp, resolved inside the sandbox shell */
  dir?: string;
  timeoutMs?: number;
}

type ScratchMode = 'worktree' | 'copy';

interface WorktreeLane {
  root: string;
  /** `worktree`: a detached worktree of the workspace's repository; `copy`: `cp -R` of a workspace that is not a git checkout, with a repository of its own for the status / restore */
  mode: ScratchMode;
  /** the workspace's tracked changes against HEAD, as a patch file next to the copy ('' for a plain copy) */
  patch: string;
  /** `git status --porcelain -z` of the copy right after the dirt replay */
  baseline: string;
  /** the last status read by `changes()`, so the restore need not read it again */
  lastStatus: string | null;
  busy: boolean;
}

/** Entries of a `git status --porcelain -z --untracked-files=all` output as `XY path` strings (a rename's original path folded in). */
function statusEntries(out: string): Set<string> {
  const fields = out.split('\0').filter((f) => f !== '');
  const entries = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] ?? '';
    const xy = f.slice(0, 2);
    if (f.slice(3) === '') continue;
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i += 1;
    entries.add(f);
  }
  return entries;
}

/** Paths whose status differs between two porcelain snapshots (created, changed, deleted or restored by the run). */
export function statusDelta(before: string, after: string): string[] {
  const a = statusEntries(before);
  const b = statusEntries(after);
  const paths = new Set<string>();
  for (const e of b) if (!a.has(e)) paths.add(e.slice(3));
  for (const e of a) if (!b.has(e)) paths.add(e.slice(3));
  return [...paths].sort();
}

function runOk(res: VerifyRunResult): boolean {
  return res.exitCode === 0 && res.timedOut !== true && res.killedBy !== 'timeout';
}

function failureTail(res: VerifyRunResult): string {
  const text = `${res.stderr ?? ''}\n${res.stdout}`.trim().split('\n').filter((l) => l.trim() !== '');
  return clip(text.at(-1) ?? `exit ${res.exitCode ?? 'null'}`, 200);
}

/**
 * The default scratch: `git worktree add --detach <copy> HEAD` per lane (created lazily, ≤ `lanes`), the workspace's
 * uncommitted changes replayed into it (tracked ones as a `git diff --binary` patch, untracked files by tar when there are
 * ≤ 200), the copy's status snapshotted, and after every run the status re-read: a difference is what the script wrote,
 * and the copy is restored (`checkout -- . && clean -fdq` + replay). A workspace that is not a git checkout (no `.git`
 * entry at its root — `git: false`, or the probe says so) gets a plain `cp -R` copy per lane instead, with a repository of
 * its own initialised inside (`git init && add -A && commit`) so the same status / restore applies; it is removed with
 * `rm -rf`. Every command goes through `run` — the sandbox — with the workspace as cwd, so the copies live under the
 * sandbox's writable tmp (`$TMPDIR`) unless `dir` says otherwise.
 */
export function createWorktreeScratch(input: WorktreeScratchInput): ReproScratch {
  const max = Math.max(1, Math.floor(input.lanes));
  const timeoutMs = input.timeoutMs ?? SCRATCH_COMMAND_TIMEOUT_MS;
  const ws = shellQuote(input.workspace);
  const tag = Math.random().toString(36).slice(2, 10);
  const lanes: WorktreeLane[] = [];
  const waiters: (() => void)[] = [];
  let created = 0;
  let creating = 0;
  let disposed = false;

  const sh = (command: string, cwd: string = input.workspace): Promise<VerifyRunResult> => input.run(command, { timeoutMs, maxOutputBytes: SCRATCH_OUTPUT_BYTES, cwd });
  const shOk = async (command: string, what: string, cwd?: string): Promise<VerifyRunResult> => {
    const res = await sh(command, cwd);
    if (!runOk(res)) throw new ReproScratchError(`${what} failed (exit ${res.exitCode ?? 'null'}): ${failureTail(res)}`);
    return res;
  };
  /** replay the workspace's dirt into the copy at `$d` (its patch at `$p`); shell fragment, needs `d` and `p` set */
  const replay = `{ [ ! -s "$p" ] || git -C "$d" apply --whitespace=nowarn "$p"; } && n=$(git -C ${ws} ls-files --others --exclude-standard | wc -l | tr -d ' ') && { [ "$n" -eq 0 ] || [ "$n" -gt ${SCRATCH_UNTRACKED_MAX} ] || git -C ${ws} ls-files -z --others --exclude-standard | tar -C ${ws} -c --null -T - -f - | tar -x -C "$d" -f -; }`;
  /** a plain copy gets a repository of its own (no hook templates, no signing) so status / restore work as in a worktree lane; shell fragment, needs `d` set */
  const initCopy = `git -C "$d" init -q --template= && git -C "$d" add -A && git -C "$d" -c user.name=jevcode -c user.email=jevcode@localhost -c commit.gpgsign=false commit -q --allow-empty -m scratch`;
  const statusCmd = (root: string): string => `git -C ${shellQuote(root)} status --porcelain -z --untracked-files=all`;
  /** remove a copy: a worktree through git (falling back to rm + prune), a plain copy with rm */
  const removeCmd = (lane: WorktreeLane): string =>
    lane.mode === 'worktree'
      ? `{ git -C ${ws} worktree remove --force ${shellQuote(lane.root)} || { rm -rf ${shellQuote(lane.root)} && git -C ${ws} worktree prune; }; } && rm -f ${shellQuote(lane.patch)}`
      : `rm -rf ${shellQuote(lane.root)}`;

  let modeKnown: Promise<ScratchMode> | null = null;
  /** `worktree` when the workspace root is a git checkout (a `.git` directory, or the `.git` file of a worktree / submodule), else `copy`; probed once */
  function mode(): Promise<ScratchMode> {
    if (modeKnown === null) {
      modeKnown =
        input.git === undefined
          ? sh(`[ -e ${ws}/.git ] && echo worktree || echo copy`).then((res): ScratchMode => (runOk(res) && res.stdout.trim() === 'worktree' ? 'worktree' : 'copy'))
          : Promise.resolve(input.git ? 'worktree' : 'copy');
    }
    return modeKnown;
  }

  async function create(k: number): Promise<WorktreeLane> {
    const m = await mode();
    const dir = input.dir === undefined ? `"\${TMPDIR:-/tmp}/jevcode-repro-${tag}"` : shellQuote(input.dir);
    const fresh = `d=${dir}/lane${k} && p="$d.dirty.patch" && rm -rf "$d" "$p" && mkdir -p "$(dirname "$d")"`;
    const cmd =
      m === 'worktree'
        ? `${fresh} && git -C ${ws} worktree prune && git -C ${ws} worktree add --detach "$d" HEAD >/dev/null && git -C ${ws} diff --binary HEAD > "$p" && ${replay} && printf '%s\\n%s\\n' "$d" "$p"`
        : `${fresh} && mkdir -p "$d" && cp -R ${ws}/. "$d" && ${initCopy} && printf '%s\\n-\\n' "$d"`;
    const res = await shOk(cmd, `scratch copy lane${k}`);
    const lines = res.stdout.split('\n').filter((l) => l.trim() !== '');
    const root = lines.at(-2)?.trim() ?? '';
    const patch = lines.at(-1)?.trim() ?? '';
    if (!root.startsWith('/') || patch === '') throw new ReproScratchError(`scratch copy lane${k}: the copy path was not reported (${clip(res.stdout.trim(), 120)})`);
    const status = await sh(statusCmd(root), root);
    return { root, mode: m, patch: m === 'worktree' ? patch : '', baseline: runOk(status) ? status.stdout : '', lastStatus: null, busy: true };
  }

  function wake(): void {
    const w = waiters.shift();
    if (w !== undefined) w();
  }

  function acquire(): Promise<WorktreeLane> {
    if (disposed) return Promise.reject(new ReproScratchError('scratch disposed'));
    const free = lanes.find((l) => !l.busy);
    if (free !== undefined) {
      free.busy = true;
      return Promise.resolve(free);
    }
    if (lanes.length + creating < max) {
      creating += 1;
      const k = created++;
      return create(k)
        .then((lane) => {
          lanes.push(lane);
          return lane;
        })
        .finally(() => {
          creating -= 1;
          // a failed creation must not strand the waiters behind it: the next one tries for itself
          wake();
        });
    }
    return new Promise<WorktreeLane>((resolve, reject) => waiters.push(() => acquire().then(resolve, reject)));
  }

  async function statusOf(lane: WorktreeLane): Promise<string | null> {
    const res = await sh(statusCmd(lane.root), lane.root);
    return runOk(res) ? res.stdout : null;
  }

  /** Put the copy back to its baseline when the run changed it. */
  async function restore(lane: WorktreeLane): Promise<void> {
    const status = lane.lastStatus ?? (await statusOf(lane));
    lane.lastStatus = null;
    if (status === lane.baseline) return;
    const back = `d=${shellQuote(lane.root)} && p=${shellQuote(lane.patch)} && git -C "$d" checkout -q -- . && git -C "$d" clean -fdq`;
    await shOk(lane.mode === 'worktree' ? `${back} && ${replay}` : back, `scratch copy restore`);
  }

  async function withLane<T>(fn: (lane: ReproLane) => Promise<T>): Promise<T> {
    const lane = await acquire();
    try {
      return await fn({
        root: lane.root,
        changes: async () => {
          const status = await statusOf(lane);
          if (status === null) return null;
          lane.lastStatus = status;
          return statusDelta(lane.baseline, status);
        },
      });
    } finally {
      try {
        await restore(lane);
        lane.busy = false;
      } catch {
        // a copy that cannot be restored is dropped; the next acquirer creates a fresh one
        lanes.splice(lanes.indexOf(lane), 1);
        void sh(`{ ${removeCmd(lane)}; } >/dev/null 2>&1`).catch(() => undefined);
      }
      wake();
    }
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    const gone = lanes.splice(0);
    const problems: string[] = [];
    for (const lane of gone) {
      const parent = input.dir === undefined ? ` && rm -rf ${shellQuote(dirname(lane.root))}` : '';
      try {
        const res = await sh(`${removeCmd(lane)}${parent}`);
        if (!runOk(res)) problems.push(failureTail(res));
      } catch (e) {
        problems.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (problems.length > 0) throw new ReproScratchError(`dispose: ${problems.join('; ')}`);
  }

  return { lanes: max, withLane, dispose };
}

// ---------------------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------------------

export type ReproTrialStatus = 'accepted' | 'malformed' | 'length' | 'timeout' | 'cancelled' | 'error' | 'rejected';

export interface ReproScriptTrial {
  sample: number;
  status: ReproTrialStatus;
  /** why it was rejected / dropped ('' when accepted) */
  reason: string;
  output: ReproductionOutput | null;
  /** the first base run, when the script ran */
  result: ReproRunResult | null;
  verdict: Verdict | null;
  goal: ReproGoal | null;
  ms: number;
  usage: TokenUsage;
  /** what this sample cost the step's LLM budget (an estimate when `estimated`) */
  usd: number;
  estimated: boolean;
}

export interface ReproWriterInput {
  task: string;
  repository: string;
  packageName: string | null;
  framework: 'django' | null;
  extraction: Extraction;
  /** absolute path of the committed workspace — the scripts never run in it: it is copied (`scratch`) */
  workspace: string;
  /** whether `workspace` is a git checkout (`ctx.workspaceInfo.git`): worktree copies, else `cp -R` copies; the default scratch probes when unset */
  workspaceGit?: boolean;
  run: VerifyRunFn;
  /** interpreter for the scripts; default the workspace's `.venv/bin/python` when present (the copies have no venv of their own) */
  python?: string;
  timeoutMs?: number;
  generate: GenerateFn;
  ask: OracleAsk;
  signal: AbortSignal;
  step?: number;
  deadlineMs?: number;
  n?: number;
  stage?: StageName;
  now?: () => number;
  /** served rate for estimates and for results without a cost; null → estimates cost 0 */
  pricing?: LlmPricing | null;
  /**
   * the step's LLM counters; only `usdLeft` is read and charged (L2 is one round per run, outside the L1 round/sample counters):
   * the round fires as many of its N samples as the counter covers at their full estimate (§4.11) — none when it cannot cover
   * one — and is charged what they cost
   */
  budget?: Pick<LlmBudget, 'usdLeft'> | null;
  /**
   * `reasoning` and the max_tokens base of every sample (§10.1: pinned per bench arm, the object the synthesizer echoes); default
   * `LLM_DEFAULT_GENERATION` — §4.13 / §10.2 finding (a): `{effort: 'low'}` with the reasoning-on base 3,000 (`{enabled: false}` is
   * refused by the z-ai endpoint; the reasoning tokens count against the cap). L2 is one round per run, so the base never doubles.
   */
  generation?: Pick<SynthesizerGeneration, 'reasoning' | 'maxTokens'>;
  /** where the scripts run; default `createWorktreeScratch` over `run` / `workspace` (owned and disposed by the writer) */
  scratch?: ReproScratch | null;
  /** parent directory of the default scratch copies (e.g. `<runDir>/tmp/synth/repro`); default the sandbox's `$TMPDIR` */
  scratchDir?: string;
  /** concurrent base runs of the default scratch (the oracle's lane count); default one per accepted script, ≤ N */
  lanes?: number;
}

export interface ReproWriterResult {
  outcome: LlmOracleOutcome | 'llm_none';
  /** the picked script's goal (its first base run), null without a pick */
  goal: ReproGoal | null;
  pick: Q18Pick | null;
  trials: ReproScriptTrial[];
  requests: number;
  note: string;
  durationMs: number;
  /** the round's cost, estimates included */
  usd: number;
  /** the part of `usd` that is an estimate (samples the provider never priced) */
  estimatedUsd: number;
}

function trialOf(sample: number, status: ReproTrialStatus, reason: string, ms: number, usage: TokenUsage, usd: number, estimated: boolean, output: ReproductionOutput | null = null): ReproScriptTrial {
  return { sample, status, reason, output, result: null, verdict: null, goal: null, ms, usage, usd, estimated };
}

/** One sample's trial row with its cost: the provider's for a result; for a timeout, a cancellation or an error what its stream left plus the allowance (§4.8, §4.13). */
function readSample(k: number, end: SampleEnd, estimate: () => TokenUsage, pricing: LlmPricing | null): ReproScriptTrial {
  if (end.kind !== 'result') {
    const usage = estimate();
    return trialOf(k, end.kind, end.error instanceof Error ? end.error.message : String(end.error), end.ms, usage, usage.costUsd, usage.estimated === true);
  }
  const { result } = end;
  const usd = costOf(result.usage, pricing);
  if (isLengthStop(result.stopReason)) return trialOf(k, 'length', 'finish_reason length', end.ms, result.usage, usd, false);
  const parsed = parseWriteReproduction(result);
  if (!parsed.ok) return trialOf(k, 'malformed', parsed.reason, end.ms, result.usage, usd, false);
  return trialOf(k, 'accepted', '', end.ms, result.usage, usd, false, parsed.value);
}

/** An accepted script past the static checks, on its way to the base runs. */
interface PreparedScript {
  trial: ReproScriptTrial;
  output: ReproductionOutput;
  chunks: string[];
  built: BuiltCriterion;
  goal: ReproGoal | null;
}

type LaneRun = { ok: true; result: ReproRunResult; changed: string[] | null } | { ok: false; reason: string };

/** One base run of a script on a scratch lane: never the workspace; the lane's status afterwards says what the script wrote. */
async function runOnLane(scratch: ReproScratch, run: VerifyRunFn, chunks: readonly string[], options: Omit<ReproRunOptions, 'workspace'>, signal: AbortSignal): Promise<LaneRun> {
  if (signal.aborted) return { ok: false, reason: 'aborted before the base run' };
  try {
    return await scratch.withLane(async (lane) => {
      const result = await runRepro(run, chunks, { ...options, workspace: lane.root });
      const changed = await lane.changes();
      return { ok: true, result, changed };
    });
  } catch (e) {
    return { ok: false, reason: `no scratch copy to run in (${e instanceof Error ? e.message : String(e)})` };
  }
}

function wroteFiles(changed: string[] | null): string | null {
  if (changed === null || changed.length === 0) return null;
  return `wrote to the workspace copy (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? `, +${changed.length - 3} more` : ''})`;
}

/**
 * N samples, the code checks, the base runs on scratch lanes (first runs concurrent, a confirmation run for the scripts that
 * failed once), Q18 over the survivors → an `llm_*` oracle or none. Never throws on a failing script.
 */
export async function writeReproduction(input: ReproWriterInput): Promise<ReproWriterResult> {
  const now = input.now ?? monotonicNow;
  const started = now();
  const system = buildReproSystemPrompt();
  const user = buildReproUserMessage({ task: input.task, repository: input.repository, packageName: input.packageName, framework: input.framework, extraction: input.extraction });
  const gen = input.generation ?? LLM_DEFAULT_GENERATION;
  const pricing = input.pricing ?? null;
  // §4.11: the round fires only as many samples as the step's dollar counter covers at their full estimate (prompt chars / 4 in,
  // max_tokens out at the served rate; 0 without pricing, when any positive counter covers them all) — none when it cannot cover one
  const requested = input.n ?? REPRO_SAMPLES;
  const perSample = estimatedSampleUsage({ siblingInputTokens: null, promptChars: system.length + user.length, maxTokens: gen.maxTokens, pricing }).costUsd;
  const n = input.budget ? Math.min(requested, affordableSamples(input.budget.usdLeft, perSample)) : requested;
  if (n <= 0) {
    const usdLeft = input.budget?.usdLeft ?? 0;
    return { outcome: 'llm_none', goal: null, pick: null, trials: [], requests: 0, note: `no LLM-written script: the step's LLM dollar counter ($${usdLeft.toFixed(4)}) cannot cover one write_reproduction sample ($${perSample.toFixed(4)} estimated)`, durationMs: Math.round(now() - started), usd: 0, estimatedUsd: 0 };
  }
  const partials = new Map<number, CancelledGeneration>();
  const runs = Array.from({ length: n }, (_, k) => {
    const req: GenerateRequest = { system, messages: [{ role: 'user', content: user }], maxTokens: gen.maxTokens, temperature: REPRO_TEMPERATURES[k] ?? REPRO_TEMPERATURES.at(-1) ?? 0.7, tools: [WRITE_REPRODUCTION_TOOL], toolChoice: { name: WRITE_REPRODUCTION_TOOL_NAME }, providerPrefs: { requireParameters: true } };
    // the pinned reasoning verbatim (null = not sent); `{enabled: false}` is HTTP 400 on the GLM endpoint (§10.2 finding (a))
    if (gen.reasoning !== null) req.reasoning = gen.reasoning;
    if (k > 0) req.seed = sampleSeed(input.step ?? 0, k);
    return generateWithDeadline(input.generate, req, { sample: k, purpose: 'write_reproduction', signal: input.signal, deadlineMs: input.deadlineMs ?? REPRO_DEADLINE_MS, now, onCancelled: (partial) => partials.set(k, partial) });
  });
  const ends = await Promise.all(runs.map((r) => r.promise));
  const sibling = ends.find((e): e is Extract<SampleEnd, { kind: 'result' }> => e.kind === 'result' && e.result.usage.inputTokens > 0);
  // a sample that never returned is booked from what it streamed plus the reasoning allowance — the L1 source's estimator (§4.8, §4.13)
  const estimate = (k: number): TokenUsage => unfinishedSampleUsage({ siblingInputTokens: sibling?.result.usage.inputTokens ?? null, promptChars: system.length + user.length, partial: partials.get(k) ?? null, reasoning: reasoningEnabled(gen.reasoning ?? undefined), pricing });
  const trials = ends.map((end, k) => readSample(k, end, () => estimate(k), pricing));
  const usd = trials.reduce((s, t) => s + t.usd, 0);
  const estimatedUsd = trials.filter((t) => t.estimated).reduce((s, t) => s + t.usd, 0);
  if (input.budget && Number.isFinite(usd) && usd > 0) input.budget.usdLeft -= usd;

  const reject = (t: ReproScriptTrial, reason: string): void => {
    t.status = 'rejected';
    t.reason = reason;
  };
  // the static checks, in sample order: what the harness refuses before any run
  const prepared: PreparedScript[] = [];
  const seenScripts = new Set<string>();
  for (const t of trials) {
    if (t.status !== 'accepted' || t.output === null) continue;
    const o = t.output;
    const problem = scriptProblems(o.script);
    if (problem !== null) {
      reject(t, problem);
      continue;
    }
    if (!issueQuoteAnchored(input.task, o.issueQuote)) {
      reject(t, `issue_quote is not a verbatim ≥ ${ISSUE_QUOTE_MIN_TOKENS}-token substring of the issue`);
      continue;
    }
    const norm = o.script.replace(/\s+/g, ' ').trim();
    if (seenScripts.has(norm)) {
      reject(t, 'identical to an earlier sample');
      continue;
    }
    seenScripts.add(norm);
    const built: BuiltCriterion = { criterion: { form: 'no_exception' }, strength: 'weak', expectedText: o.expectedBehaviour === '' ? 'completes without raising' : o.expectedBehaviour, derivation: 'llm write_reproduction: the script raises while the bug exists and completes once it is fixed' };
    prepared.push({ trial: t, output: o, chunks: [o.script], built, goal: null });
  }

  const options: Omit<ReproRunOptions, 'workspace' | 'python'> = { packageName: input.packageName, framework: input.framework, timeoutMs: input.timeoutMs ?? REPRO_TIMEOUT_MS };
  const survivors: Q18Script[] = [];
  const goals = new Map<string, ReproGoal>();
  if (prepared.length > 0) {
    // the copies carry no venv: the workspace's interpreter runs the script with the copy as cwd and sys.path[0]
    const python = input.python ?? (await venvPython(input.workspace));
    const runOptions: Omit<ReproRunOptions, 'workspace'> = python === undefined ? options : { ...options, python };
    const owned = input.scratch === undefined || input.scratch === null;
    const scratch: ReproScratch = input.scratch ?? createWorktreeScratch({ run: input.run, workspace: input.workspace, ...(input.workspaceGit === undefined ? {} : { git: input.workspaceGit }), lanes: Math.max(1, Math.min(input.lanes ?? n, prepared.length)), ...(input.scratchDir === undefined ? {} : { dir: input.scratchDir }), timeoutMs: SCRATCH_COMMAND_TIMEOUT_MS });
    try {
      // first base runs, concurrently across the lanes (the pool bounds them to `scratch.lanes`)
      const first = await Promise.all(prepared.map((c) => runOnLane(scratch, input.run, c.chunks, runOptions, input.signal)));
      const confirm: PreparedScript[] = [];
      prepared.forEach((c, i) => {
        const r = first[i]!;
        if (!r.ok) {
          reject(c.trial, r.reason);
          return;
        }
        const goal = reproductionGoal({ block: blockFor(c.trial.sample, c.output.script), chunks: c.chunks, built: c.built, result: r.result, options });
        c.trial.result = r.result;
        c.trial.verdict = goal.verdict;
        c.trial.goal = goal;
        const wrote = wroteFiles(r.changed);
        if (wrote !== null) {
          reject(c.trial, wrote);
          return;
        }
        if (r.result.status !== 'ran' || evidenceStatements(r.result).length === 0) {
          reject(c.trial, `did not run (${r.result.status}${r.result.outputTail === '' ? '' : `: ${clip(r.result.outputTail.replace(/\s+/g, ' '), 120)}`})`);
          return;
        }
        if (goal.verdict.pass) {
          reject(c.trial, 'completes at the base commit: it does not show the bug');
          return;
        }
        const incomplete = snippetIncomplete(goal);
        if (incomplete !== null) {
          reject(c.trial, `stops on ${incomplete}`);
          return;
        }
        const network = detectNetworkUse(c.chunks, r.result);
        if (network !== null) {
          reject(c.trial, `needs the network (${network.evidence})`);
          return;
        }
        c.goal = goal;
        confirm.push(c);
      });
      // the confirmation run (the `unstable` rule), only for the scripts that failed once — concurrently too
      const again = await Promise.all(confirm.map((c) => runOnLane(scratch, input.run, c.chunks, runOptions, input.signal)));
      confirm.forEach((c, i) => {
        const r = again[i]!;
        const goal = c.goal!;
        if (!r.ok) {
          reject(c.trial, `confirmation run: ${r.reason}`);
          return;
        }
        const wrote = wroteFiles(r.changed);
        if (wrote !== null) {
          reject(c.trial, `${wrote} on the confirmation run`);
          return;
        }
        const againVerdict = evaluateCriterion(c.built.criterion, r.result);
        if (r.result.status === 'ran' && evidenceStatements(r.result).length > 0 && againVerdict.pass) {
          reject(c.trial, `unstable: failed once (${clip(goal.verdict.actual, 60)}) and passed on the second base run`);
          return;
        }
        const raising = goal.verdict.statement;
        const key = `script_${c.trial.sample}`;
        survivors.push({ key, source: c.output.script, issueQuote: c.output.issueQuote, baseRun: { exceptionType: raising?.exception?.type ?? 'exception', message: raising?.exception?.message ?? goal.verdict.actual, lastStatement: raising?.source ?? goal.failure.call }, lines: c.output.script.split('\n').length });
        goals.set(key, goal);
      });
    } finally {
      if (owned) await scratch.dispose().catch(() => undefined);
    }
  }

  const done = (outcome: ReproWriterResult['outcome'], pick: Q18Pick | null, requests: number, note: string): ReproWriterResult => ({ outcome, goal: pick?.key !== null && pick?.key !== undefined ? (goals.get(pick.key) ?? null) : null, pick, trials, requests, note, durationMs: Math.round(now() - started), usd, estimatedUsd });
  if (survivors.length === 0) {
    const reasons = trials.map((t) => `${t.sample}: ${t.status}${t.reason === '' ? '' : ` (${clip(t.reason, 80)})`}`).join('; ');
    return done('llm_none', null, 0, `no LLM-written script survived the code checks — ${reasons}`);
  }
  const q = q18Questions({ repository: input.repository, task: input.task, scripts: survivors });
  const res = await input.ask(input.stage ?? 'propose', q.state, q.questions);
  const pick = readQ18(res.answers, survivors);
  if (pick.outcome === 'llm_none') return done('llm_none', pick, 1, `LLM reproduction refused: ${pick.reason}`);
  const goal = goals.get(pick.key!)!;
  return done(pick.outcome, pick, 1, `${pick.outcome} oracle ${goal.spec.testId} from an LLM-written script (${pick.reason}; failure_kind ${pick.failureKind ?? '-'}): ${clip(goal.failure.call, 60)} -> ${clip(goal.failure.actual, 60)}; ${LLM_ORACLE_OPEN_PROBLEM} — never completes a run`);
}
