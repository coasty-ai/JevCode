/**
 * Fakes for the controller (search/index.ts) and sub-goal (search/subgoal.ts) tests: a
 * SynthesisContext with a scripted `ask`, a run memory built the way the controller builds it,
 * fake collaborators that record every call, and VerifyOutcome builders with code-computed
 * progress. Nothing here touches Jev, the sandbox or the file system.
 */
import { sha12 } from '../../../../src/core/hash.js';
import type { Answer, Json, Question, SynthesisContext, WindowEntry } from '../../../../src/core/types.js';
import { defaultOverrides } from '../../../../src/synth/search/directive.js';
import type { RunMemory, SearchDeps } from '../../../../src/synth/search/index.js';
import { committedBase } from '../../../../src/synth/search/index.js';
import { createMemory } from '../../../../src/synth/search/memory.js';
import type { GuardVerdict, JevEnumeration, JevSource, SearchQueue, SubGoalDeps } from '../../../../src/synth/search/subgoal.js';
import type { Base, Goal, VerifyJob, VerifyOutcome, VerifyStatus } from '../../../../src/synth/search/types.js';
import type { Candidate, CandidateSource, CandidateSourceName, FunctionCandidate, LocalizeResult, RankResult, Site, SourceFile, TestRunSummary } from '../../../../src/synth/types.js';
import { applyCandidate, progress } from '../../../../src/synth/verify/index.js';
import { summary } from '../verify/helpers.js';
import { choiceAnswer, siteAt, sourceFile } from './helpers.js';
import { makeCtx } from './proposal-helpers.js';
import type { CtxOptions } from './proposal-helpers.js';

export { siteAt, sourceFile } from './helpers.js';
export { summary } from '../verify/helpers.js';

export const GCD_BUGGY = 'def gcd(a, b):\n    if b == 0:\n        return a\n    else:\n        return gcd(a % b, b)\n';
export const GCD_TEST = 'tests/test_gcd.py::test_gcd';
export const GCD_OTHER_TEST = 'tests/test_gcd.py::test_other';

// ---------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------

export interface AskCall {
  state: Json;
  questions: Record<string, Question>;
}

export type AskScript = (questions: Record<string, Question>, state: Json, call: number) => Record<string, Answer>;

/** A ctx whose `ask` answers from `script` and records; `synthState` set calls are recorded too. */
export function fakeCtx(o: CtxOptions & { ask?: AskScript; runId?: string; synthState?: Json | null; task?: string } = {}): SynthesisContext & { askCalls: AskCall[]; synthStates: (Json | null)[]; events: ReturnType<typeof makeCtx>['events'] } {
  const base = makeCtx(o);
  const askCalls: AskCall[] = [];
  const synthStates: (Json | null)[] = [];
  const script = o.ask;
  return {
    ...base,
    runId: o.runId ?? base.runId,
    task: o.task ?? base.task,
    synthState: o.synthState ?? null,
    askCalls,
    synthStates,
    ask: async (_stage, state, questions) => {
      askCalls.push({ state, questions });
      if (script === undefined) throw new Error('ctx.ask was not scripted for this test');
      const answers = script(questions, state, askCalls.length);
      for (const id of Object.keys(questions)) if (!(id in answers)) throw new Error(`script did not answer ${id}`);
      return { answers, rows: [], latencyMs: 1 };
    },
    setSynthState: (s) => {
      synthStates.push(s);
    },
  };
}

/** A Choice answer putting `p` on `key` and the rest spread over the other options. */
export function choiceOn(q: Question, key: string, p = 0.8): Answer {
  if (q.type !== 'choice') throw new Error('choiceOn needs a choice question');
  const weights: Record<string, number> = {};
  const others = Object.keys(q.criteria).filter((k) => k !== key);
  for (const k of others) weights[k] = (1 - p) / Math.max(1, others.length);
  weights[key] = p;
  return choiceAnswer(q, weights);
}

// ---------------------------------------------------------------------------------------
// Repository-mode collaborators a QuixBugs/ladder-shaped test never reaches
// ---------------------------------------------------------------------------------------

/** The repository-mode deps (oracle, localiser, scope, reproduction re-run, best guess, the introspection and history harvests) as no-ops: a small pytest workspace never enters that mode. */
export function unusedRepositoryDeps(): Pick<SearchDeps, 'searchBestGuess' | 'locate' | 'findOracle' | 'regressionScope' | 'verifyRepro' | 'introspect' | 'harvestHistory'> {
  return {
    introspect: async () => null,
    harvestHistory: async () => null,
    searchBestGuess: async () => {
      throw new Error('searchBestGuess is not scripted for this test');
    },
    locate: async () => ({ files: [], functions: [], sites: [], requests: 0 }),
    findOracle: async (ctx) => ({ outcome: 'no_blocks', strength: null, goal: null, extraction: { blocks: [], tracebacks: [], expectations: [] }, judgement: null, choice: null, anchors: [], traceback: null, requests: 0, note: `no code block in ${ctx.task.slice(0, 20)}`, durationMs: 0 }),
    regressionScope: async () => ({ testFiles: [], command: null, tier: 'none', note: 'no test file' }),
    verifyRepro: async () => {
      throw new Error('verifyRepro is not scripted for this test');
    },
  };
}

// ---------------------------------------------------------------------------------------
// Memory, goals, bases
// ---------------------------------------------------------------------------------------

let nextRun = 0;

/** A fresh RunMemory (unique run id) with the committed base over `files` and `baseline`. */
export function fakeMemory(files: readonly SourceFile[], baseline: TestRunSummary, over: Partial<Pick<RunMemory, 'oracle' | 'stepBudget'>> = {}): RunMemory {
  const mem = createMemory(`test-run-${nextRun++}`) as RunMemory;
  mem.overrides = defaultOverrides();
  mem.baseline = baseline;
  mem.bases = [committedBase(new Map(files.map((f) => [f.path, f])), baseline)];
  if (over.oracle !== undefined) mem.oracle = over.oracle;
  if (over.stepBudget !== undefined) mem.stepBudget = over.stepBudget;
  return mem;
}

export function fastOracle(): RunMemory['oracle'] {
  return { runner: 'pytest', lanes: 8, tRunMs: { goalSubset: 300, fullSuite: 300 }, perTestTimeoutMs: null, runTimeoutMs: 10_000, baselineDurationMs: 300 };
}

export function slowOracle(): RunMemory['oracle'] {
  return { runner: 'pytest', lanes: 4, tRunMs: { goalSubset: 30_000, fullSuite: 30_000 }, perTestTimeoutMs: null, runTimeoutMs: 100_000, baselineDurationMs: 30_000 };
}

export function fakeBudget(over: { jev?: number; runs?: number; wallMs?: number } = {}): RunMemory['stepBudget'] {
  const b: RunMemory['stepBudget'] = {
    jevRequestsLeft: over.jev ?? 30,
    testRunsLeft: over.runs ?? 1500,
    testWallLeftMs: over.wallMs ?? 90_000,
    startedMs: 0,
    recursed: false,
    exhausted: () => b.testRunsLeft <= 0 || b.testWallLeftMs <= 0 || b.jevRequestsLeft <= 0,
  };
  return b;
}

export function fakeGoal(over: Partial<Goal> = {}): Goal {
  const tests = over.tests ?? [GCD_TEST];
  return {
    id: over.id ?? 'g1',
    tests,
    failures: over.failures ?? tests.map((t) => ({ testId: t, call: 'gcd(13, 13)', expected: '13', actual: 'RecursionError: maximum recursion depth exceeded' })),
    suspectedFiles: over.suspectedFiles ?? ['gcd.py'],
    status: over.status ?? 'open',
    attempts: over.attempts ?? 0,
    budgetHits: over.budgetHits ?? 0,
    exhausted: over.exhausted ?? new Map(),
    phase: over.phase ?? 'SEEDS',
    planItem: over.planItem ?? `fix ${tests[0] ?? '?'} in gcd.py`,
    ...(over.parkedReason !== undefined ? { parkedReason: over.parkedReason } : {}),
  };
}

/** The gcd file, its buggy line as a replace site and the gap after it as an insert site. */
export function gcdFixture(): { file: SourceFile; replace: Site; insert: Site; fn: FunctionCandidate } {
  const file = sourceFile('gcd.py', GCD_BUGGY);
  return { file, replace: siteAt(file, 5), insert: siteAt(file, 6, 'insert'), fn: { file, name: 'gcd', startLine: 1, endLine: 5, probability: 0.9 } };
}

let nextCand = 0;
export function cand(site: Site, text: string, over: Partial<Pick<Candidate, 'source' | 'op' | 'prior'>> = {}): Candidate {
  const c: Candidate = { id: `cand-${nextCand++}`, site, text, source: over.source ?? 'mutation', op: over.op ?? 'relational_swap' };
  if (over.prior !== undefined) c.prior = over.prior;
  return c;
}

// ---------------------------------------------------------------------------------------
// Verify outcomes
// ---------------------------------------------------------------------------------------

export function outcomeOf(job: VerifyJob, status: VerifyStatus, o: { subset?: TestRunSummary; full?: TestRunSummary } = {}): VerifyOutcome {
  const applied = applyCandidate(job.candidate, job.base.files);
  const before = job.base.summary;
  const subset = o.subset ?? (status === 'plausible' || status === 'partial' ? summary({ passing: [...before.passing, ...before.failing], failing: [] }) : summary({ failing: [...before.failing], passing: [...before.passing] }));
  const full = o.full ?? (status === 'plausible' ? subset : undefined);
  const out: VerifyOutcome = { job, applied, subset, progress: progress(before, full ?? subset), status };
  if (full !== undefined) out.full = full;
  return out;
}

// ---------------------------------------------------------------------------------------
// Sub-goal collaborators that record every call
// ---------------------------------------------------------------------------------------

export interface Recorded {
  /** (phase-agnostic) source name → site line, in call order */
  enumerations: { source: CandidateSourceName; line: number; kind: Site['kind'] }[];
  rankCalls: { line: number; n: number }[];
  runBatches: VerifyJob[][];
  decideCalls: VerifyOutcome[][];
  sketchCalls: number[];
  beamCalls: number[];
  locateCalls: number;
}

export interface FakeSubGoalOptions {
  sites: Site[];
  functions?: FunctionCandidate[];
  /** candidates a seed source yields at a site (default: none) */
  seed?: (source: CandidateSourceName, site: Site) => Candidate[];
  sketch?: (site: Site) => JevEnumeration;
  beam?: (site: Site) => JevEnumeration;
  rank?: (cands: readonly Candidate[], site: Site) => RankResult;
  /** status per job (default: 'unchanged') */
  statusOf?: (job: VerifyJob, batch: number) => VerifyStatus;
  /** the guard's verdict per batch (default: `continue`) */
  decide?: (results: readonly VerifyOutcome[], batch: number, mem: RunMemory) => GuardVerdict;
  /** charged per run by the fake runner (default 1 run, 0 ms) */
  runCost?: { runs: number; wallMs: number };
  pairs?: Candidate[];
}

export function fakeQueue(): SearchQueue & { items: VerifyJob[] } {
  const items: VerifyJob[] = [];
  return {
    items,
    get size() {
      return items.length;
    },
    addAll(jobs) {
      const queued = [...jobs];
      items.push(...queued);
      return { queued };
    },
    pop: (n) => items.splice(0, n),
  };
}

export function fakeSubGoalDeps(o: FakeSubGoalOptions): SubGoalDeps & { rec: Recorded } {
  const rec: Recorded = { enumerations: [], rankCalls: [], runBatches: [], decideCalls: [], sketchCalls: [], beamCalls: [], locateCalls: 0 };
  const seedSource = (name: CandidateSourceName): CandidateSource => ({
    name,
    enumerate: (site) => {
      rec.enumerations.push({ source: name, line: site.line, kind: site.kind });
      return o.seed?.(name, site) ?? [];
    },
  });
  const jev = (which: 'sketch' | 'beam'): JevSource => ({
    enumerate: async ({ site }) => {
      (which === 'sketch' ? rec.sketchCalls : rec.beamCalls).push(site.line);
      rec.enumerations.push({ source: 'token_beam', line: site.line, kind: site.kind });
      const r = which === 'sketch' ? o.sketch?.(site) : o.beam?.(site);
      return r ?? { candidates: [], requests: 1 };
    },
  });
  const loc: LocalizeResult = { files: [], functions: o.functions ?? [], sites: o.sites, requests: 2 };
  return {
    rec,
    locate: async () => {
      rec.locateCalls += 1;
      return loc;
    },
    seeds: { mutation: seedSource('mutation'), template: seedSource('template'), donor: seedSource('donor'), composite: seedSource('composite') },
    sketch: jev('sketch'),
    beam: jev('beam'),
    rank: async (_ctx, _mem, cands, site) => {
      rec.rankCalls.push({ line: site.line, n: cands.length });
      return o.rank?.(cands, site) ?? { ranked: cands.map((c, i) => ({ candidate: c, probability: 0.9 - i * 0.05, rank: i + 1 })), escapeProbability: 0.05, fixProbablyAbsent: false, method: 'choice', requests: 1 };
    },
    createQueue: () => fakeQueue(),
    runQueue: async (_ctx, mem, queue, _goal, runsAllowed) => {
      const jobs = queue.pop(runsAllowed);
      rec.runBatches.push(jobs);
      const batch = rec.runBatches.length;
      const cost = o.runCost ?? { runs: 1, wallMs: 0 };
      mem.stepBudget.testRunsLeft -= cost.runs * jobs.length;
      mem.stepBudget.testWallLeftMs -= cost.wallMs * jobs.length;
      const outcomes = jobs.map((j) => outcomeOf(j, o.statusOf?.(j, batch) ?? 'unchanged'));
      // like sieve/runner.ts: only a completed (classified) candidate is `tried`
      for (const out of outcomes) mem.tried.add(sha12(out.applied.diff));
      return outcomes;
    },
    decide: async (_ctx, mem, _goal, results) => {
      rec.decideCalls.push([...results]);
      return o.decide?.(results, rec.decideCalls.length, mem) ?? { kind: 'continue' };
    },
    pairsOfPartials: () => o.pairs ?? [],
  };
}

/** A job of `c` on `base` for outcome builders. */
export function jobOf(c: Candidate, base: Base, p = 0.5): VerifyJob {
  return { candidate: c, base, p, sourcePrior: 0.9, key: [base.summary.passed, p, 0.9] };
}

/** The window entry of an executed `patch` on `paths` (provider/actions.ts label shape). */
export function executedPatch(step: number, paths: string[] = ['gcd.py']): WindowEntry {
  return { step, intent: 'edit', action: `patch ${paths.join(' ')}`, outcome: 'executed', shownFiles: [], notes: [] };
}

/** The window entry of an engine-executed test run with parsed counts. */
export function executedRun(step: number, command: string, counts: { passed: number; failed: number; errors?: number }): WindowEntry {
  const errors = counts.errors ?? 0;
  const allPassed = counts.failed === 0 && errors === 0 && counts.passed > 0;
  return {
    step,
    intent: 'verify',
    action: `run ${command}`,
    outcome: 'executed',
    judge: { succeeded: 0.9, errorPresent: 0.1, newInfo: 0.5, tests: { source: 'parsed', allPassed, passed: counts.passed, failed: counts.failed, errors }, doneClaims: [] },
    shownFiles: [],
    notes: [],
  };
}
