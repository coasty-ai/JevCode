/**
 * L2 — the reproduction writer (docs/LLM-JEV-DESIGN.md §4.10; repository class only, once per
 * run, when the workspace has no failing test and the code oracle is not valid). N = 3 parallel
 * `write_reproduction` samples (temperature 0 / 0.7 / 0.7); code then runs every script under
 * the sentinel harness twice at base with criterion `{form: 'no_exception'}` and rejects one that
 * did not run, passes at base, stops on a NameError/ImportError-class exception, needs the
 * network, or gives a different verdict on the second run, and — before any of that — one whose
 * `issue_quote` is not a verbatim ≥ 6-token substring of the issue (the assertion must be
 * anchored in the issue text, not in the model's reading of it). Only the survivors reach Jev
 * Q18; the pick becomes a `ReproGoal` with outcome `llm_valid` (Noul ≥ 0.7) or `llm_weak`
 * (0.3 ≤ p < 0.7). An `llm_*` oracle never satisfies the completion fact (§6.6). Every sample is
 * metered (§8.1 books the round at ≈ $0.0024): a priced result at its cost, a timed-out, cancelled
 * or failed one at the estimated full cost, charged to the step's `llmUsdLeft` when a budget is given.
 *
 * TODO(stage 4, src/synth/oracle/search.ts): `OracleOutcome += 'llm_valid' | 'llm_weak'`,
 * `oracleYieldsGoal` and `oracleNeedsArbitration` true for both; `RepositoryMode.repro` persists
 * the pick with `oracleOutcome`. Until then the members are declared here (`LlmOracleOutcome`).
 */
import { clip } from '../../core/text.js';
import type { Answer, GenerateRequest, Json, Question, StageName, SynthesizerGeneration, TokenUsage } from '../../core/types.js';
import { monotonicNow } from '../../core/time.js';
import { ESCAPE_KEY, assertQuestionBatch, choice, noul } from '../../jev/questions.js';
import { reproductionGoal, type ReproGoal } from '../oracle/goal.js';
import { FAILURE_KINDS, REPRODUCTION_CRITERIA, isFailureKind } from '../oracle/questions.js';
import { REPRO_TIMEOUT_MS, detectNetworkUse, evaluateCriterion, evidenceStatements, runRepro, type BuiltCriterion, type ReproRunOptions } from '../oracle/runner.js';
import { snippetIncomplete, type OracleAsk } from '../oracle/search.js';
import type { CodeBlock, Extraction, FailureKind, ReproRunResult, Verdict } from '../oracle/types.js';
import type { VerifyRunFn } from '../verify/types.js';
import { REPRO_LIMITS, WRITE_REPRODUCTION_TOOL, WRITE_REPRODUCTION_TOOL_NAME, isLengthStop, parseWriteReproduction, type ReproductionOutput } from './schema.js';
import { LLM_DEFAULT_GENERATION, costOf, estimatedSampleUsage, generateWithDeadline, sampleSeed, type LlmBudget, type LlmPricing, type SampleEnd } from './source.js';
import type { GenerateFn } from './types.js';

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

/** A script the harness refuses before running it: too long, exits the process, reads stdin, or is not top-level Python-looking text. */
export function scriptProblems(script: string): string | null {
  const lines = script.split('\n');
  if (lines.length > REPRO_LIMITS.scriptLines) return `${lines.length} lines, at most ${REPRO_LIMITS.scriptLines}`;
  if (/\bsys\.exit\s*\(|\bexit\s*\(|\bquit\s*\(|\bos\._exit\s*\(/.test(script)) return 'calls sys.exit / exit (the harness reads SystemExit as an exception)';
  if (/\binput\s*\(/.test(script)) return 'reads stdin';
  if (/\bsubprocess\b|\bos\.system\s*\(/.test(script)) return 'spawns a process';
  if (!/\S/.test(script)) return 'empty';
  return null;
}

function blockFor(k: number, script: string): CodeBlock {
  return { index: 1000 + k, kind: 'code', origin: 'fence', lang: 'python', text: script, startLine: 0, endLine: 0, tracebacks: [] };
}

// ---------------------------------------------------------------------------------------
// Q18
// ---------------------------------------------------------------------------------------

export interface Q18Script {
  key: string;
  source: string;
  issueQuote: string;
  baseRun: { exceptionType: string; message: string; lastStatement: string };
  lines: number;
}

export function q18Questions(input: { repository: string; task: string; scripts: readonly Q18Script[] }): { state: Json; questions: Record<string, Question> } {
  const scripts: Record<string, Json> = {};
  const options: Record<string, Json | null> = {};
  for (const s of input.scripts) {
    scripts[s.key] = { source: s.source, issue_quote: s.issueQuote, base_run: { exception_type: s.baseRun.exceptionType, message: clip(s.baseRun.message, 300), last_statement: clip(s.baseRun.lastStatement, 200) } };
    options[s.key] = `${s.lines}-line script raising ${s.baseRun.exceptionType} at \`${clip(s.baseRun.lastStatement, 80)}\`; quotes: "${clip(s.issueQuote, 120)}"`;
  }
  options[ESCAPE_KEY] = 'No script reproduces the reported bug: each raises for another reason, tests something the issue does not describe, or would keep raising once the bug is fixed.';
  const questions: Record<string, Question> = {};
  questions[Q18.choiceId] = choice('Which script in `scripts` reproduces the bug `issue.problem_statement` reports: it fails at the current commit for the reason the issue describes and would complete once the described behaviour is fixed? Read each source and its `base_run` literally.', options);
  for (const s of input.scripts) {
    questions[`${Q18.noulPrefix}${s.key}`] = noul(`Does \`scripts.${s.key}\` reproduce the reported bug when run against the repository \`issue.repository\`? Read its source, its \`issue_quote\` and \`issue.problem_statement\`; \`base_run\` shows what it raised at the current (buggy) commit. Answer literally about this script.`, REPRODUCTION_CRITERIA);
  }
  questions[Q18.failureKindId] = choice('Read `issue.problem_statement`. Which kind of failure does the reporter observe at the current code? Judge the observed behaviour, not the fix.', FAILURE_KINDS);
  assertQuestionBatch(questions);
  const state: Json = {
    issue: { repository: input.repository, problem_statement: clip(input.task, REPRO_ISSUE_CHARS) },
    criteria: { reproduces_issue: REPRODUCTION_CRITERIA.true.definition, reproduces_issue_examples: [...REPRODUCTION_CRITERIA.true.examples], not_a_reproduction: REPRODUCTION_CRITERIA.false.definition, not_a_reproduction_examples: [...REPRODUCTION_CRITERIA.false.examples] },
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
  outcome: LlmOracleOutcome | 'llm_none';
  reason: string;
}

/** argmax iff it beats the runner-up by > 0.05, else the fewest lines among the near-ties; escape above the top → none; Noul ≥ 0.7 valid, ≥ 0.3 weak. */
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
  const ranked = [...scripts].sort((a, b) => (pChoice[b.key] ?? 0) - (pChoice[a.key] ?? 0));
  const top = ranked[0];
  const none = (reason: string): Q18Pick => ({ key: null, pChoice, pEscape, nouls, failureKind, outcome: 'llm_none', reason });
  if (top === undefined) return none('no script survived the code checks');
  const pTop = pChoice[top.key] ?? 0;
  if (pEscape > pTop) return none(`Jev put ${pEscape.toFixed(2)} on none_of_these against ${pTop.toFixed(2)} for the best script`);
  const runner = ranked[1];
  let pick = top;
  if (runner !== undefined && pTop - (pChoice[runner.key] ?? 0) <= Q18.tieMargin) {
    const near = ranked.filter((s) => pTop - (pChoice[s.key] ?? 0) <= Q18.tieMargin);
    pick = near.sort((a, b) => a.lines - b.lines || (pChoice[b.key] ?? 0) - (pChoice[a.key] ?? 0))[0]!;
  }
  const p = nouls[pick.key] ?? 0;
  if (p >= Q18.validP) return { key: pick.key, pChoice, pEscape, nouls, failureKind, outcome: 'llm_valid', reason: `${pick.key}: reproduces_issue ${p.toFixed(2)} ≥ ${Q18.validP}` };
  if (p >= Q18.weakP) return { key: pick.key, pChoice, pEscape, nouls, failureKind, outcome: 'llm_weak', reason: `${pick.key}: reproduces_issue ${p.toFixed(2)} in [${Q18.weakP}, ${Q18.validP})` };
  return none(`${pick.key}: reproduces_issue ${p.toFixed(2)} < ${Q18.weakP}`);
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
  /** absolute path of the committed workspace */
  workspace: string;
  run: VerifyRunFn;
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
  /** the step's LLM counters; only `usdLeft` is charged (L2 is one round per run, outside the L1 round/sample counters) */
  budget?: Pick<LlmBudget, 'usdLeft'> | null;
  /** `reasoning` and the max_tokens base of every sample (§10.1: pinned per bench arm); default `LLM_DEFAULT_GENERATION` */
  generation?: Pick<SynthesizerGeneration, 'reasoning' | 'maxTokens'>;
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

/** One sample's trial row with its cost: the provider's for a result, the estimated full cost for a timeout, a cancellation or an error (§4.8). */
function readSample(k: number, end: SampleEnd, estimate: () => TokenUsage, pricing: LlmPricing | null): ReproScriptTrial {
  if (end.kind !== 'result') {
    const usage = estimate();
    return trialOf(k, end.kind, end.error instanceof Error ? end.error.message : String(end.error), end.ms, usage, usage.costUsd, true);
  }
  const { result } = end;
  const usd = costOf(result.usage, pricing);
  if (isLengthStop(result.stopReason)) return trialOf(k, 'length', 'finish_reason length', end.ms, result.usage, usd, false);
  const parsed = parseWriteReproduction(result);
  if (!parsed.ok) return trialOf(k, 'malformed', parsed.reason, end.ms, result.usage, usd, false);
  return trialOf(k, 'accepted', '', end.ms, result.usage, usd, false, parsed.value);
}

/** N samples, the code checks, two base runs each, Q18 over the survivors → an `llm_*` oracle or none. Never throws on a failing script. */
export async function writeReproduction(input: ReproWriterInput): Promise<ReproWriterResult> {
  const now = input.now ?? monotonicNow;
  const started = now();
  const n = input.n ?? REPRO_SAMPLES;
  const system = buildReproSystemPrompt();
  const user = buildReproUserMessage({ task: input.task, repository: input.repository, packageName: input.packageName, framework: input.framework, extraction: input.extraction });
  const gen = input.generation ?? LLM_DEFAULT_GENERATION;
  const runs = Array.from({ length: n }, (_, k) => {
    const req: GenerateRequest = { system, messages: [{ role: 'user', content: user }], maxTokens: gen.maxTokens, temperature: REPRO_TEMPERATURES[k] ?? REPRO_TEMPERATURES.at(-1) ?? 0.7, tools: [WRITE_REPRODUCTION_TOOL], toolChoice: { name: WRITE_REPRODUCTION_TOOL_NAME }, providerPrefs: { requireParameters: true } };
    // the pinned reasoning verbatim (null = not sent); `{enabled: false}` is HTTP 400 on the GLM endpoint (§10.2 finding (a))
    if (gen.reasoning !== null) req.reasoning = gen.reasoning;
    if (k > 0) req.seed = sampleSeed(input.step ?? 0, k);
    return generateWithDeadline(input.generate, req, { sample: k, purpose: 'write_reproduction', signal: input.signal, deadlineMs: input.deadlineMs ?? REPRO_DEADLINE_MS, now });
  });
  const ends = await Promise.all(runs.map((r) => r.promise));
  const pricing = input.pricing ?? null;
  const sibling = ends.find((e): e is Extract<SampleEnd, { kind: 'result' }> => e.kind === 'result' && e.result.usage.inputTokens > 0);
  const estimate = (): TokenUsage => estimatedSampleUsage({ siblingInputTokens: sibling?.result.usage.inputTokens ?? null, promptChars: system.length + user.length, maxTokens: gen.maxTokens, pricing });
  const trials = ends.map((end, k) => readSample(k, end, estimate, pricing));
  const usd = trials.reduce((s, t) => s + t.usd, 0);
  const estimatedUsd = trials.filter((t) => t.estimated).reduce((s, t) => s + t.usd, 0);
  if (input.budget && Number.isFinite(usd) && usd > 0) input.budget.usdLeft -= usd;

  const options: Omit<ReproRunOptions, 'workspace' | 'python'> = { packageName: input.packageName, framework: input.framework, timeoutMs: input.timeoutMs ?? REPRO_TIMEOUT_MS };
  const runOpts: ReproRunOptions = { ...options, workspace: input.workspace };
  if (input.python !== undefined) runOpts.python = input.python;
  const survivors: Q18Script[] = [];
  const goals = new Map<string, ReproGoal>();
  const seenScripts = new Set<string>();
  for (const t of trials) {
    if (t.status !== 'accepted' || t.output === null) continue;
    const o = t.output;
    const reject = (reason: string): void => {
      t.status = 'rejected';
      t.reason = reason;
    };
    const problem = scriptProblems(o.script);
    if (problem !== null) {
      reject(problem);
      continue;
    }
    if (!issueQuoteAnchored(input.task, o.issueQuote)) {
      reject(`issue_quote is not a verbatim ≥ ${ISSUE_QUOTE_MIN_TOKENS}-token substring of the issue`);
      continue;
    }
    const norm = o.script.replace(/\s+/g, ' ').trim();
    if (seenScripts.has(norm)) {
      reject('identical to an earlier sample');
      continue;
    }
    seenScripts.add(norm);
    if (input.signal.aborted) {
      reject('aborted before the base run');
      continue;
    }
    const chunks = [o.script];
    const result = await runRepro(input.run, chunks, runOpts);
    const built: BuiltCriterion = { criterion: { form: 'no_exception' }, strength: 'weak', expectedText: o.expectedBehaviour === '' ? 'completes without raising' : o.expectedBehaviour, derivation: 'llm write_reproduction: the script raises while the bug exists and completes once it is fixed' };
    const goal = reproductionGoal({ block: blockFor(t.sample, o.script), chunks, built, result, options });
    t.result = result;
    t.verdict = goal.verdict;
    t.goal = goal;
    if (result.status !== 'ran' || evidenceStatements(result).length === 0) {
      reject(`did not run (${result.status}${result.outputTail === '' ? '' : `: ${clip(result.outputTail.replace(/\s+/g, ' '), 120)}`})`);
      continue;
    }
    if (goal.verdict.pass) {
      reject('completes at the base commit: it does not show the bug');
      continue;
    }
    const incomplete = snippetIncomplete(goal);
    if (incomplete !== null) {
      reject(`stops on ${incomplete}`);
      continue;
    }
    const network = detectNetworkUse(chunks, result);
    if (network !== null) {
      reject(`needs the network (${network.evidence})`);
      continue;
    }
    const again = await runRepro(input.run, chunks, runOpts);
    const againVerdict = evaluateCriterion(built.criterion, again);
    if (again.status === 'ran' && evidenceStatements(again).length > 0 && againVerdict.pass) {
      reject(`unstable: failed once (${clip(goal.verdict.actual, 60)}) and passed on the second base run`);
      continue;
    }
    const raising = goal.verdict.statement;
    const key = `script_${t.sample}`;
    survivors.push({ key, source: o.script, issueQuote: o.issueQuote, baseRun: { exceptionType: raising?.exception?.type ?? 'exception', message: raising?.exception?.message ?? goal.verdict.actual, lastStatement: raising?.source ?? goal.failure.call }, lines: o.script.split('\n').length });
    goals.set(key, goal);
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
