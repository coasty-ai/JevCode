/**
 * Fakes for the controller (search/index.ts) and sub-goal (search/subgoal.ts) tests: a
 * SynthesisContext with a scripted `ask`, a run memory built the way the controller builds it,
 * fake collaborators that record every call, and VerifyOutcome builders with code-computed
 * progress. Nothing here touches Jev, the sandbox or the file system.
 */
import { sha12 } from '../../../../../src/core/hash.js';
import type { Answer, Json, Question, StepVerifySummary, SynthesisContext, WindowEntry } from '../../../../../src/core/types.js';
import { defaultOverrides } from '../../../../../src/jev-modes/synth/search/directive.js';
import type { RunMemory, SearchDeps } from '../../../../../src/jev-modes/synth/search/index.js';
import { committedBase } from '../../../../../src/jev-modes/synth/search/index.js';
import { createMemory } from '../../../../../src/jev-modes/synth/search/memory.js';
import type { LlmFireOptions, LlmRound, SubGoalLlm } from '../../../../../src/jev-modes/synth/search/llm.js';
import type { CancelReason, LlmRoundSummary, SampleArrival } from '../../../../../src/jev-modes/synth/llm/source.js';
import type { DroppedPatch, LlmApplied } from '../../../../../src/jev-modes/synth/llm/candidates.js';
import type { OracleClass } from '../../../../../src/jev-modes/synth/llm/types.js';
import type { GuardVerdict, JevEnumeration, JevSource, SearchQueue, SubGoalDeps } from '../../../../../src/jev-modes/synth/search/subgoal.js';
import type { Base, Goal, VerifyJob, VerifyOutcome, VerifyStatus } from '../../../../../src/jev-modes/synth/search/types.js';
import type { Candidate, CandidateSource, CandidateSourceName, FunctionCandidate, LocalizeResult, RankResult, Site, SourceFile, TestRunSummary } from '../../../../../src/jev-modes/synth/types.js';
import { applyCandidate, progress } from '../../../../../src/jev-modes/synth/verify/index.js';
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

/** A ctx whose `ask` answers from `script` and records; `synthState` sets and `reportVerify` calls are recorded too. */
export function fakeCtx(o: CtxOptions & { ask?: AskScript; runId?: string; synthState?: Json | null; task?: string } = {}): SynthesisContext & { askCalls: AskCall[]; synthStates: (Json | null)[]; verifyReports: Partial<StepVerifySummary>[]; events: ReturnType<typeof makeCtx>['events'] } {
  const base = makeCtx(o);
  const askCalls: AskCall[] = [];
  const synthStates: (Json | null)[] = [];
  // docs/LLM-JEV-DESIGN.md §9.3: what the controller reports for `StepRecord.verify` (the engine merges it over its own tallies)
  const verifyReports: Partial<StepVerifySummary>[] = [];
  const script = o.ask;
  return {
    ...base,
    runId: o.runId ?? base.runId,
    task: o.task ?? base.task,
    synthState: o.synthState ?? null,
    askCalls,
    synthStates,
    verifyReports,
    reportVerify: (counts) => {
      verifyReports.push(counts);
    },
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

export function fakeBudget(over: { jev?: number; runs?: number; wallMs?: number; llmRounds?: number; llmSamples?: number; llmUsd?: number } = {}): RunMemory['stepBudget'] {
  const b: RunMemory['stepBudget'] = {
    jevRequestsLeft: over.jev ?? 30,
    testRunsLeft: over.runs ?? 1500,
    testWallLeftMs: over.wallMs ?? 90_000,
    startedMs: 0,
    recursed: false,
    llmRoundsLeft: over.llmRounds ?? 0,
    llmSamplesLeft: over.llmSamples ?? 0,
    llmUsdLeft: over.llmUsd ?? 0,
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
  /** the goal-subset summary of a job's run (default: `outcomeOf`'s per status — a `partial` needs one that still fails a goal test) */
  subsetOf?: (job: VerifyJob, batch: number) => TestRunSummary | undefined;
  /** the guard's verdict per batch (default: `continue`) */
  decide?: (results: readonly VerifyOutcome[], batch: number, mem: RunMemory) => GuardVerdict;
  /** charged per run by the fake runner (default 1 run, 0 ms) */
  runCost?: { runs: number; wallMs: number };
  /** the pairs of partials of the goal: a fixed list, or a function of the memory (e.g. the real bases.ts pairsOfPartials) */
  pairs?: Candidate[] | ((mem: RunMemory, goal: Goal) => Candidate[]);
  /**
   * The full-suite regression run of a held partial before its progress commit (subgoal.ts
   * commitProgress). Default: the partial's own subset run stands for the suite (a clean partial).
   * `null` from the fake means the run could not be made (the partial stays held).
   */
  regressionRun?: (outcome: VerifyOutcome, goal: Goal) => TestRunSummary | null;
}

/** A SearchQueue with the awaitable `open/next/close` of sieve/queue.ts (the LLM round streams into it): FIFO, or ordered by `p` descending (stable) like the real queue when `ordered`. */
export function fakeQueue(o: { ordered?: boolean } = {}): SearchQueue & { items: VerifyJob[]; streaming: boolean } {
  const items: VerifyJob[] = [];
  const waiters: ((j: VerifyJob | null) => void)[] = [];
  const q = {
    items,
    streaming: false,
    get size() {
      return items.length;
    },
    addAll(jobs: Iterable<VerifyJob>) {
      const queued = [...jobs];
      for (const j of queued) {
        const at = o.ordered === true ? items.findIndex((x) => x.p < j.p) : -1;
        if (at === -1) items.push(j);
        else items.splice(at, 0, j);
      }
      while (waiters.length > 0 && items.length > 0) waiters.shift()!(items.shift()!);
      return { queued };
    },
    pop: (n: number) => items.splice(0, n),
    open() {
      q.streaming = true;
    },
    close() {
      q.streaming = false;
      for (const w of waiters.splice(0)) w(null);
    },
    next(signal?: AbortSignal): Promise<VerifyJob | null> {
      const head = items.shift();
      if (head !== undefined) return Promise.resolve(head);
      if (!q.streaming || signal?.aborted === true) return Promise.resolve(null);
      return new Promise((resolve) => {
        const waiter = (j: VerifyJob | null): void => {
          signal?.removeEventListener('abort', release);
          resolve(j);
        };
        const release = (): void => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1);
          resolve(null);
        };
        signal?.addEventListener('abort', release, { once: true });
        waiters.push(waiter);
      });
    },
  };
  return q;
}

/** The next job: popped while the queue holds one, awaited through `next()` while it streams (sieve/runner.ts's worker); null when there is none. */
async function takeJob(queue: SearchQueue): Promise<VerifyJob | null> {
  const head = queue.pop(1)[0];
  if (head !== undefined) return head;
  if (queue.next === undefined) return null;
  return queue.next();
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
      const jobs: VerifyJob[] = [];
      rec.runBatches.push(jobs);
      const batch = rec.runBatches.length;
      const cost = o.runCost ?? { runs: 1, wallMs: 0 };
      // like sieve/runner.ts: a batch begun while the queue streams (an LLM round landing samples) ends on its first plausible outcome
      const streamed = queue.streaming === true;
      const outcomes: VerifyOutcome[] = [];
      while (jobs.length < runsAllowed) {
        const j = await takeJob(queue);
        if (j === null) break;
        jobs.push(j);
        mem.stepBudget.testRunsLeft -= cost.runs;
        mem.stepBudget.testWallLeftMs -= cost.wallMs;
        const subset = o.subsetOf?.(j, batch);
        const out = outcomeOf(j, o.statusOf?.(j, batch) ?? 'unchanged', subset === undefined ? {} : { subset });
        // like sieve/runner.ts: only a completed (classified) candidate is `tried`
        mem.tried.add(sha12(out.applied.diff));
        outcomes.push(out);
        if (streamed && out.status === 'plausible') break;
      }
      return outcomes;
    },
    decide: async (_ctx, mem, _goal, results) => {
      rec.decideCalls.push([...results]);
      return o.decide?.(results, rec.decideCalls.length, mem) ?? { kind: 'continue' };
    },
    pairsOfPartials: (mem, goal) => (typeof o.pairs === 'function' ? o.pairs(mem as RunMemory, goal) : (o.pairs ?? [])),
    regressionRun: async (_ctx, mem, goal, outcome) => {
      mem.stepBudget.testRunsLeft -= 1;
      return o.regressionRun === undefined ? outcome.subset : o.regressionRun(outcome, goal);
    },
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

// ---------------------------------------------------------------------------------------
// A fake LLM source (docs/LLM-JEV-DESIGN.md §4): scripted rounds whose arrivals land on timers
// ---------------------------------------------------------------------------------------

export interface FakeArrival {
  candidates: Candidate[];
  /** ms after the sample is started (sample 0 at fire; the rest at release on a staggered round) */
  delayMs?: number;
  /** hunks the source dropped on arrival (their ledger rows must reach the attempt ledger even when the sample is not queued) */
  dropped?: DroppedPatch[];
  need?: { paths: string[]; symbols: string[] } | null;
}

export interface FakeRoundScript {
  arrivals: FakeArrival[];
  klass?: OracleClass;
  /** default: staggered unless the class is `repository` */
  staggered?: boolean;
  deadlineMs?: number;
  /** the round never closes on its own (a sample past its deadline); `cancel()` closes it */
  hang?: boolean;
  /** dollars each fired sample holds against the step's counter until it lands (source.ts `reservedUsd`, §4.11); default 0 */
  holdUsd?: number;
  /** contract 1.9 (Fastlane) §3.1 / §3.2 / §3.4: the generator-path figures this round reports on its summary */
  fastlane?: Pick<LlmRoundSummary, 'ttfbMs' | 'hedges' | 'hedgeWins' | 'hedgesRefused' | 'cacheRead' | 'cacheWrite' | 'cacheInputTokens'>;
}

export interface FakeLlmRecord {
  fires: LlmFireOptions[];
  released: number;
  cancelled: CancelReason[];
  /** candidate ids handed to `order`, per call */
  orders: string[][];
  /** the rounds handed out, in fire order (tests read their state while the loop runs) */
  rounds: LlmRound[];
}

class FakeRound implements LlmRound {
  readonly goalId: string;
  readonly round: number;
  readonly klass: OracleClass;
  readonly n: number;
  readonly staggered: boolean;
  readonly startedMs: number;
  readonly deadlineMs: number;
  private readonly script: FakeRoundScript;
  private readonly rec: FakeLlmRecord;
  private readonly buffer: SampleArrival[] = [];
  private waiters: (() => void)[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private delivered = 0;
  private ended = false;
  private wasReleased: boolean;
  private cancelledAs: CancelReason | null = null;
  /** like search/llm.ts PumpedRound: the deadline runs from the release once samples 1..N−1 fired */
  private releasedMs: number | null = null;

  constructor(goalId: string, round: number, script: FakeRoundScript, rec: FakeLlmRecord) {
    this.goalId = goalId;
    this.round = round;
    this.script = script;
    this.rec = rec;
    this.klass = script.klass ?? 'quixbugs';
    this.n = Math.max(1, script.arrivals.length);
    this.staggered = script.staggered ?? this.klass !== 'repository';
    this.startedMs = Date.now();
    this.deadlineMs = script.deadlineMs ?? 20_000;
    this.wasReleased = !this.staggered;
    if (script.arrivals.length === 0 && !(script.hang ?? false)) this.end();
    else {
      this.schedule(0);
      if (!this.staggered) for (let k = 1; k < script.arrivals.length; k++) this.schedule(k);
      // a hanging round is closed by its deadline (the source's per-sample deadline, §4.8)
      if (script.hang ?? false) this.timers.push(setTimeout(() => this.end(), this.deadlineMs));
    }
  }

  private schedule(k: number): void {
    const a = this.script.arrivals[k];
    if (a === undefined) return;
    const t = setTimeout(() => {
      if (this.ended) return;
      const applied: LlmApplied[] = a.candidates.map((c) => applyCandidate(c) as LlmApplied);
      this.buffer.push({ sample: k, status: 'valid', ms: a.delayMs ?? 0, candidates: a.candidates as LlmApplied['candidate'][], applied, dropped: a.dropped ?? [], need: a.need ?? null, analysis: null, usage: null, usd: 0.001, estimated: false, rateLimited: false, generationId: null, detail: '' });
      this.delivered += 1;
      if (this.delivered >= this.script.arrivals.length && !(this.script.hang ?? false)) this.end();
      else this.wake();
    }, a.delayMs ?? 0);
    this.timers.push(t);
  }

  private end(): void {
    this.ended = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.wake();
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  private untilChange(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    if (this.wasReleased) return;
    this.wasReleased = true;
    this.releasedMs = Date.now();
    this.rec.released += 1;
    for (let k = 1; k < this.script.arrivals.length; k++) this.schedule(k);
  }

  released(): boolean {
    return this.wasReleased;
  }

  ready(): SampleArrival[] {
    return this.buffer.splice(0, this.buffer.length);
  }

  async next(): Promise<SampleArrival | null> {
    for (;;) {
      const a = this.buffer.shift();
      if (a !== undefined) return a;
      if (this.ended) return null;
      await this.untilChange();
    }
  }

  async rest(): Promise<SampleArrival[]> {
    const out: SampleArrival[] = [];
    for (;;) {
      const a = await this.next();
      if (a === null) return out;
      out.push(a);
    }
  }

  async waitFirst(ms: number): Promise<boolean> {
    const until = Date.now() + Math.max(0, ms);
    for (;;) {
      if (this.buffer.length > 0 || this.ended) return true;
      const left = until - Date.now();
      if (left <= 0) return false;
      await Promise.race([this.untilChange(), new Promise<void>((resolve) => setTimeout(resolve, left))]);
    }
  }

  cancel(reason: CancelReason): Promise<void> {
    if (!this.ended) {
      this.cancelledAs = reason;
      this.rec.cancelled.push(reason);
      this.end();
    }
    return Promise.resolve();
  }

  closed(): boolean {
    return this.ended;
  }

  deadlineLeftMs(): number {
    return Math.max(0, (this.releasedMs ?? this.startedMs) + this.deadlineMs - Date.now());
  }

  summary(): LlmRoundSummary | null {
    const fired = this.staggered && !this.wasReleased ? Math.min(1, this.script.arrivals.length) : this.script.arrivals.length;
    const cancelled = this.cancelledAs === null ? 0 : Math.max(0, fired - this.delivered);
    // like the source: every fired sample holds `holdUsd` until it lands; a closed round holds nothing
    const inFlight = this.ended ? 0 : Math.max(0, fired - this.delivered);
    return { goalId: this.goalId, round: this.round, klass: this.klass, n: this.n, fired, valid: this.delivered, empty: 0, malformed: 0, length: 0, timeouts: 0, cancelled, errors: 0, misanchored: 0, syntaxErrors: 0, compileFailed: 0, duplicates: 0, tried: 0, distinct: this.delivered, needs: 0, wallMs: Date.now() - this.startedMs, usd: this.delivered * 0.001, estimatedUsd: 0, reservedUsd: inFlight * (this.script.holdUsd ?? 0), deadlineMs: this.deadlineMs, closed: this.ended, ...(this.script.fastlane ?? {}) };
  }
}

export interface FakeLlmOptions {
  /** the round for a fire (by round number and goal); null = skipped */
  rounds: (opts: LlmFireOptions, goal: Goal) => FakeRoundScript | null;
  graceMs?: number;
  /** Q17: the candidate ids in the order Jev prefers (default: arrival order) */
  order?: (ids: readonly string[]) => string[];
}

/** A `SubGoalLlm` whose rounds are scripted; records fires, releases, cancellations, Q17 calls and spends. */
export function fakeLlm(o: FakeLlmOptions): SubGoalLlm & { rec: FakeLlmRecord; spent: number } {
  const rec: FakeLlmRecord = { fires: [], released: 0, cancelled: [], orders: [], rounds: [] };
  const llm: SubGoalLlm & { rec: FakeLlmRecord; spent: number } = {
    rec,
    spent: 0,
    graceMs: o.graceMs ?? 0,
    deadlineGrowth: 'always',
    now: () => Date.now(),
    fire: (_ctx, _mem, goal, _loc, opts) => {
      rec.fires.push(opts);
      const script = o.rounds(opts, goal);
      if (script === null) return null;
      const round = new FakeRound(goal.id, opts.round, script, rec);
      rec.rounds.push(round);
      return round;
    },
    order: async (_ctx, _goal, applied) => {
      const ids = applied.map((a) => a.candidate.id);
      rec.orders.push(ids);
      const order = o.order === undefined ? [...ids] : o.order(ids);
      const pChoice: Record<string, number> = {};
      order.forEach((id, i) => (pChoice[id] = 0.8 - i * 0.1));
      return { order, pChoice, pEscape: 0.05, pMax: 0.8, nouls: {}, maxNoul: 0.7, strong: false, weak: false, requests: 1 };
    },
    spentUsd: () => llm.spent,
    recordSpend: (_ctx, usd) => {
      llm.spent += usd;
    },
    exportCache: () => null,
    stepEnd: async () => undefined,
  };
  return llm;
}
