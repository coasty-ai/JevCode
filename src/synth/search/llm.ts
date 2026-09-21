/**
 * The search-facing side of the LLM candidate source (docs/LLM-JEV-DESIGN.md §4.2–§4.6, §4.9,
 * §6.1–§6.2, §9.2 stage 4). llm/source.ts fires rounds and parses samples; this module is what
 * search/subgoal.ts injects as `SubGoalDeps.llm`: it assembles the prompt from what the search
 * already holds (the committed base's files, the localisation's sites and beam, the traceback, the
 * reproduction, the held partial, the attempt ledger), sizes the round from the oracle class and
 * the step's LLM counters (budget.ts `decideLlmN`), wraps a fired round as an `LlmRound` whose
 * arrivals are pumped into a buffer (so the grace of §6.2 can wait on the first one and the LLM
 * phase can drain the rest), asks Q17 for an order in RANK mode, and keeps one `LlmSource` per run
 * (its cache, running p50 and doubled `max_tokens` outlive a step). Default request shape per the
 * §10.2 live findings: `reasoning: {effort: 'low'}` (OpenRouter refuses `{enabled: false}` on the
 * z-ai endpoint) and estimates at the served GLM rate ($0.15/$0.50 per M).
 *
 * Nothing here decides: the loop runs every candidate and the guard commits; Jev is asked once at
 * most (Q17), and only to order.
 */
import { join } from 'node:path';
import type { Json, SynthesisContext } from '../../core/types.js';
import { monotonicNow } from '../../core/time.js';
import { attemptFromDrop, attemptLedger, attemptsHash, createAstCompileCheck, type AstCompileCheck, type CompileCheck, type LlmApplied } from '../llm/candidates.js';
import { buildFixSystemPrompt, buildFixUserMessage, hintSchedule, listingSet, PROMPT_LIMITS_FIX, type AttemptRecord, type HintAnchor, type Listing, type ListingMember, type LocalisationLine, type OutlineView } from '../llm/prompt.js';
import { orderByQ17, type Q17Order } from '../llm/rank.js';
import { createLlmSource, samplesFor, type CancelReason, type LlmBudget, type LlmFireInput, type LlmPricing, type LlmRoundSummary, type LlmSource, type SampleArrival } from '../llm/source.js';
import type { OracleClass } from '../llm/types.js';
import { outline, tracebackFrames } from '../localize/outline.js';
import type { LocalizeResult, SourceFile } from '../types.js';
import { heldPartialOutcome } from './bases.js';
import { decideLlmN, llmClassOf } from './budget.js';
import type { SearchMemory } from './memory.js';
import type { Goal, StepBudget } from './types.js';

// ---------------------------------------------------------------------------------------
// Constants (docs/LLM-JEV-DESIGN.md §6.2, §4.12, §10.2)
// ---------------------------------------------------------------------------------------

/** The seed-vs-LLM grace (§6.2): a seed passer alone waits this long at most for sample 0. Priced by the `LLM_GRACE_MS = 0` repeat run (§10.3). */
export const LLM_GRACE_MS = 6000;
/** The served GLM 5.3 Flash rate (§10.2 live finding: $0.15/$0.50 per M, 5/3× the models table) for estimates and unpriced results. */
export const LLM_SERVED_PRICING: LlmPricing = { inputPerM: 0.15, outputPerM: 0.5 };
/** The feedback round widens `## Code` by this many listing members (§4.9); a strong fix-absent signal doubles it (routing, §5). */
export const LLM_FEEDBACK_WIDEN = 3;
/** Feedback rounds per goal per run (§4.9: "twice per goal per run"). */
export const LLM_FEEDBACK_ROUNDS_PER_GOAL = 2;
/** The attempt ledger kept per goal (the prompt shows the latest PROMPT_LIMITS_FIX.attempts). */
export const LLM_ATTEMPTS_KEPT = 60;
/** Compile-check temp files live under `<runDir>/tmp/synth/compile` (§4.7 step 4). */
export const LLM_COMPILE_DIR = 'tmp/synth/compile';
/** A cache replay has no provider deadline; its re-anchoring and compile check run through the sandbox, so the loop's waits on it are bounded by this. */
export const LLM_REPLAY_DEADLINE_MS = 10_000;
const COMPILE_OUTPUT_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------------------

/** The `llm` slot of the run memory (memory.ts `SearchMemory.llm`, §4.11 "plus the llm key"). */
export interface LlmMemory {
  /** goal id → the attempt ledger rows (every classified run of any source and the fed-back drops), oldest first, ≤ LLM_ATTEMPTS_KEPT */
  attempts: Map<string, AttemptRecord[]>;
  /** goal id → feedback rounds (L1′) taken this run */
  feedbackRounds: Map<string, number>;
  /** goal id → a round fired before the search reached the goal (the repository step-1 overlap, §7.1), taken by the first search of that goal */
  early: Map<string, LlmRound>;
}

export function llmMemory(mem: { llm?: LlmMemory }): LlmMemory {
  if (mem.llm === undefined) mem.llm = { attempts: new Map(), feedbackRounds: new Map(), early: new Map() };
  return mem.llm;
}

/** Append ledger rows for a goal, keeping the most recent LLM_ATTEMPTS_KEPT. */
export function recordAttempts(mem: { llm?: LlmMemory }, goalId: string, rows: readonly AttemptRecord[]): void {
  if (rows.length === 0) return;
  const m = llmMemory(mem);
  const all = [...(m.attempts.get(goalId) ?? []), ...rows];
  m.attempts.set(goalId, all.slice(Math.max(0, all.length - LLM_ATTEMPTS_KEPT)));
}

/** What the adapter reads from the run memory (structural: the tests hand it a plain memory). */
export type LlmSearchMemory = Pick<SearchMemory, 'bases' | 'baseline' | 'oracle' | 'stepBudget' | 'tried' | 'goals' | 'repository'> & { llm?: LlmMemory };

// ---------------------------------------------------------------------------------------
// A fired round as the loop consumes it
// ---------------------------------------------------------------------------------------

export interface LlmRound {
  readonly goalId: string;
  readonly round: number;
  readonly klass: OracleClass;
  readonly n: number;
  readonly staggered: boolean;
  readonly startedMs: number;
  readonly deadlineMs: number;
  /** stagger: fire samples 1..N−1 (the top-site seed batch returned without a passer, or the site set has no seeds) */
  release(): void;
  released(): boolean;
  /** arrivals that landed and were not taken yet (synchronous; empties the buffer) */
  ready(): SampleArrival[];
  /** the next arrival, null once the round has ended */
  next(): Promise<SampleArrival | null>;
  /** every remaining arrival of the round */
  rest(): Promise<SampleArrival[]>;
  /** wait at most `ms` for an arrival (the grace, §6.2): true when one is ready or the round ended, false on the timeout */
  waitFirst(ms: number): Promise<boolean>;
  /** abort the in-flight samples; resolves once every cancelled sample is metered */
  cancel(reason: CancelReason): Promise<void>;
  closed(): boolean;
  /** ms until the per-sample deadline of the round's latest-fired samples passes (0 once it has; a stagger release restarts it) */
  deadlineLeftMs(): number;
  summary(): LlmRoundSummary | null;
}

/** A round whose arrivals are pumped from the source into a buffer the loop reads at its own pace. */
interface RoundMeta {
  goalId: string;
  round: number;
  klass: OracleClass;
  n: number;
  staggered: boolean;
  startedMs: number;
  deadlineMs: number;
}

class PumpedRound implements LlmRound {
  readonly goalId: string;
  readonly round: number;
  readonly klass: OracleClass;
  readonly n: number;
  readonly staggered: boolean;
  readonly startedMs: number;
  readonly deadlineMs: number;
  private readonly src: LlmSource;
  private readonly now: () => number;
  private readonly buffer: SampleArrival[] = [];
  private waiters: (() => void)[] = [];
  private ended = false;
  private wasReleased: boolean;
  /** when `release()` fired samples 1..N−1: their deadline runs from here, not from the round's start */
  private releasedMs: number | null = null;

  constructor(src: LlmSource, meta: RoundMeta, now: () => number) {
    this.src = src;
    this.now = now;
    this.goalId = meta.goalId;
    this.round = meta.round;
    this.klass = meta.klass;
    this.n = meta.n;
    this.staggered = meta.staggered;
    this.startedMs = meta.startedMs;
    this.deadlineMs = meta.deadlineMs;
    this.wasReleased = !meta.staggered;
    void this.pump();
  }

  private mine(): boolean {
    const cur = this.src.round();
    return cur !== null && cur.goalId === this.goalId && cur.round === this.round;
  }

  private async pump(): Promise<void> {
    for (;;) {
      // the source's `collect()` reads its current round; once another round took over, this one is over for us
      if (!this.mine()) break;
      const a = await this.src.collect();
      if (a === null) break;
      this.buffer.push(a);
      this.wake();
    }
    this.ended = true;
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
    if (!this.wasReleased) this.releasedMs = this.now();
    this.wasReleased = true;
    this.src.release();
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
    const until = this.now() + Math.max(0, ms);
    for (;;) {
      if (this.buffer.length > 0 || this.ended) return true;
      const left = until - this.now();
      if (left <= 0) return false;
      // the timer is cleared when an arrival wins the race, so a grace leaves nothing dangling
      let handle: ReturnType<typeof setTimeout> | null = null;
      const timer = new Promise<void>((resolve) => {
        handle = setTimeout(resolve, left);
      });
      try {
        await Promise.race([this.untilChange(), timer]);
      } finally {
        if (handle !== null) clearTimeout(handle);
      }
    }
  }

  cancel(reason: CancelReason): Promise<void> {
    if (!this.mine()) return Promise.resolve();
    return this.src.cancel(reason);
  }

  closed(): boolean {
    return this.ended;
  }

  deadlineLeftMs(): number {
    return Math.max(0, (this.releasedMs ?? this.startedMs) + this.deadlineMs - this.now());
  }

  summary(): LlmRoundSummary | null {
    return this.mine() ? this.src.round() : null;
  }
}

// ---------------------------------------------------------------------------------------
// The adapter contract (what subgoal.ts injects)
// ---------------------------------------------------------------------------------------

export interface LlmFireOptions {
  /** 1 = L1, 2 = the feedback round L1′ (§4.9) */
  round: 1 | 2;
  /** listing members beyond PROMPT_LIMITS_FIX.listings (the feedback round's widened `## Code`) */
  widen?: number;
  /** the `need` paths of the previous round, resolved to their listings first (§4.9) */
  needPaths?: readonly string[];
  /** the Q7 top edit class when it was asked (hint h4) */
  editClass?: string | null;
  /** override the class's stagger (tests) */
  stagger?: boolean;
}

export interface SubGoalLlm {
  /** the seed-vs-LLM grace window (§6.2), ms */
  readonly graceMs: number;
  /** the clock the rounds' deadlines run on (the loop measures the grace with it) */
  readonly now: () => number;
  /** start a round for the goal at its located sites; null when skipped (§4.2: counters spent, no `generate`, nothing to list) */
  fire(ctx: SynthesisContext, mem: LlmSearchMemory, goal: Goal, loc: LocalizeResult, opts: LlmFireOptions): LlmRound | null;
  /** Q17 over the distinct arrived candidates: an order, never a gate (§4g) */
  order(ctx: SynthesisContext, goal: Goal, applied: readonly LlmApplied[], files: ReadonlyMap<string, SourceFile>): Promise<Q17Order>;
  /** dollars the run's rounds have spent so far (estimates included), for the step cap (§4.11) */
  spentUsd(runId: string): number;
  /** an LLM spend made outside the rounds (the L2 reproduction writer, §4.10) joins the run's total so `(spendCap − spent) / stepsLeft` sees it */
  recordSpend(ctx: SynthesisContext, usd: number): void;
  /** the persisted round cache for `synthState` (≤ 4 KB), null before the first round */
  exportCache(runId: string): Json | null;
  /** step end: the compile temp files are removed (§4.7 step 4) */
  stepEnd(ctx: SynthesisContext): Promise<void>;
}

export interface SearchLlmOptions {
  pricing?: LlmPricing | null;
  graceMs?: number;
  /** the probe's p90, the first round's deadline (§4.8) */
  probeP90Ms?: number | null;
  now?: () => number;
}

interface RunLlm {
  source: LlmSource;
  /** dollars spent by the run's rounds (estimates included) */
  spentUsd: number;
  /** the step's compile check (temp files removed at step end) */
  compile: AstCompileCheck | null;
  /** the compile check bound to the step's sandbox/signal (rebound at every fire); the source delegates to it */
  current: CompileCheck | null;
}

/** The `llm` cache a resumed run persisted (memory.ts writes it under `synthState.llm`). */
function persistedLlmCache(state: Json | null): Json | null {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return null;
  const v = (state as { llm?: Json })['llm'];
  return v === undefined ? null : v;
}

function committedFiles(mem: LlmSearchMemory): ReadonlyMap<string, SourceFile> | null {
  return mem.bases.find((b) => b.origin === 'committed')?.files ?? null;
}

/**
 * The step's LLM counters as the source charges them (`LlmBudget` over `StepBudget`). The view reads `mem.stepBudget`
 * at every access, never a captured object: a re-baseline within the step installs a fresh budget (the repository
 * step-1 overlap fires the round before the scoped baseline replaces it), and the samples that land afterwards must
 * decrement the counters the rest of the step reads.
 */
function budgetView(mem: Pick<LlmSearchMemory, 'stepBudget'>): LlmBudget {
  const sb = (): StepBudget => mem.stepBudget;
  return {
    get roundsLeft() {
      return sb().llmRoundsLeft;
    },
    set roundsLeft(v: number) {
      sb().llmRoundsLeft = v;
    },
    get samplesLeft() {
      return sb().llmSamplesLeft;
    },
    set samplesLeft(v: number) {
      sb().llmSamplesLeft = v;
    },
    get usdLeft() {
      return sb().llmUsdLeft;
    },
    set usdLeft(v: number) {
      sb().llmUsdLeft = v;
    },
  };
}

/** The listing set of §4.3: the traceback frames' functions (code) ∪ the localisation's anchors (jev), `need` paths first when given. */
export function listingsFor(files: ReadonlyMap<string, SourceFile>, loc: LocalizeResult, traceback: string | null, opts: { widen?: number; needPaths?: readonly string[] } = {}): { listings: Listing[]; frames: ListingMember[]; anchors: ListingMember[] } {
  const frames: ListingMember[] = tracebackFrames(traceback ?? undefined, files).map((f) => ({ path: f.path, line: f.line, fn: f.fn }));
  const anchors: ListingMember[] = [];
  for (const p of opts.needPaths ?? []) {
    const f = files.get(p);
    if (f !== undefined) anchors.push({ path: p, line: 1, fn: null });
  }
  for (const s of loc.sites) anchors.push({ path: s.file.path, line: s.line, fn: s.block?.name ?? null });
  for (const fn of loc.functions) anchors.push({ path: fn.file.path, line: fn.startLine, fn: fn.name });
  const listings = listingSet({ files, frames, anchors, maxListings: PROMPT_LIMITS_FIX.listings + Math.max(0, opts.widen ?? 0) });
  return { listings, frames, anchors };
}

/** The `## Localisation` rows: the deepest frames, then the Jev-ranked sites with their probabilities. */
function localisationOf(frames: readonly ListingMember[], loc: LocalizeResult): LocalisationLine[] {
  const out: LocalisationLine[] = frames.map((f) => ({ path: f.path, line: f.line, fn: f.fn ?? null, origin: 'traceback' }));
  for (const s of loc.sites.slice(0, PROMPT_LIMITS_FIX.jevLines)) {
    const row: LocalisationLine = { path: s.file.path, line: s.line, fn: s.block?.name ?? null, origin: 'jev' };
    if (s.evidence.jevProbability !== undefined) row.probability = s.evidence.jevProbability;
    out.push(row);
  }
  return out;
}

/** The h1 anchor: the top replace site's Q5 line and probability (the gate is `hintSchedule`'s). */
function anchorOf(loc: LocalizeResult): HintAnchor | null {
  const top = loc.sites.find((s) => s.kind === 'replace' && s.evidence.jevProbability !== undefined);
  return top === undefined || top.evidence.jevProbability === undefined ? null : { path: top.file.path, line: top.line, probability: top.evidence.jevProbability };
}

export function createSearchLlm(opts: SearchLlmOptions = {}): SubGoalLlm {
  const now = opts.now ?? monotonicNow;
  const pricing = opts.pricing === undefined ? LLM_SERVED_PRICING : opts.pricing;
  const graceMs = opts.graceMs ?? LLM_GRACE_MS;
  const runs = new Map<string, RunLlm>();

  function runOf(ctx: SynthesisContext): RunLlm | null {
    const generate = ctx.generate;
    if (generate === undefined) return null;
    const existing = runs.get(ctx.runId);
    if (existing !== undefined) return existing;
    const holder: { run: RunLlm | null } = { run: null };
    // the source's compile check is fixed at creation; it delegates to the check bound to the current step's sandbox
    const compile: CompileCheck = (path, source) => (holder.run?.current ? holder.run.current(path, source) : Promise.resolve({ ok: true }));
    const source = createLlmSource({
      generate,
      compile,
      pricing,
      emit: (phase, detail) => ctx.emit({ type: 'synth', step: ctx.step, phase, detail }),
      onSample: (a) => {
        if (holder.run !== null) holder.run.spentUsd += a.usd;
      },
      now,
      cache: persistedLlmCache(ctx.synthState),
      probeP90Ms: opts.probeP90Ms ?? null,
    });
    const run: RunLlm = { source, spentUsd: 0, compile: null, current: null };
    holder.run = run;
    runs.set(ctx.runId, run);
    return run;
  }

  /** The compile check of this step: `python3 -c "import ast…"` through the step's sandbox on a temp file. */
  function bindCompile(run: RunLlm, ctx: SynthesisContext): void {
    const check = createAstCompileCheck((command, o) => ctx.sandbox.run(command, { timeoutMs: o.timeoutMs, maxOutputBytes: COMPILE_OUTPUT_BYTES, signal: ctx.signal, ...(o.cwd === undefined ? {} : { cwd: o.cwd }) }), join(ctx.runDir, LLM_COMPILE_DIR));
    run.compile = check;
    run.current = check.check;
  }

  function fire(ctx: SynthesisContext, mem: LlmSearchMemory, goal: Goal, loc: LocalizeResult, o: LlmFireOptions): LlmRound | null {
    const run = runOf(ctx);
    const skip = (why: string): null => {
      ctx.emit({ type: 'synth', step: ctx.step, phase: 'llm:fire', detail: `${goal.id} round ${o.round}: skipped (${why})` });
      return null;
    };
    if (run === null) return skip('no generator channel');
    const files = committedFiles(mem);
    if (files === null) return skip('no committed base');
    const repo = mem.repository;
    const repository = repo !== undefined;
    const tReproMs = repository ? mem.oracle.tRunMs.goalSubset : null;
    const klass = llmClassOf(mem.oracle, mem.goals.length, repository);
    const n = decideLlmN(mem.oracle, mem.stepBudget, klass, tReproMs);
    // §4.2: spent counters skip the generation, not the site cache — the source still re-queues the cached untried candidates
    // of an earlier step first; it refuses to generate on the same counters itself
    const spent = n <= 0;
    const spentNote = `LLM counters spent: ${mem.stepBudget.llmRoundsLeft} rounds, ${mem.stepBudget.llmSamplesLeft} samples, $${mem.stepBudget.llmUsdLeft.toFixed(4)} left`;
    const traceback = repo?.traceback ?? mem.baseline?.outputTail ?? null;
    const { listings, frames } = listingsFor(files, loc, traceback, { ...(o.widen === undefined ? {} : { widen: o.widen }), ...(o.needPaths === undefined ? {} : { needPaths: o.needPaths }) });
    if (listings.length === 0) return skip('no listing member (no located site, no workspace traceback frame)');
    const attempts = attemptLedger(llmMemory(mem).attempts.get(goal.id) ?? [], PROMPT_LIMITS_FIX.attempts);
    const outlines: OutlineView[] = repository ? loc.files.slice(0, PROMPT_LIMITS_FIX.outlines).flatMap((f) => (files.has(f.path) ? [{ path: f.path, symbols: outline(files.get(f.path)!.mod, PROMPT_LIMITS_FIX.outlineSymbols) }] : [])) : [];
    const held = heldPartialOutcome(mem, goal);
    const repro = repo?.repro ?? null;
    const hints = hintSchedule(klass, n, { anchor: anchorOf(loc), editClass: o.editClass ?? null, tReproMs });
    const localisation = localisationOf(frames, loc);
    const goalPath = goal.suspectedFiles[0] ?? loc.sites[0]?.file.path ?? 'the workspace';
    const userFor = (k: number): string =>
      buildFixUserMessage({
        goal: { tests: goal.tests, path: goalPath },
        task: ctx.task,
        failures: goal.failures,
        traceback,
        repro: repro === null ? null : { script: repro.spec.chunks.join('\n'), output: repo?.lastRepro?.verdict.actual ?? '' },
        localisation,
        listings,
        outlines,
        attempts,
        partial: held === null ? null : { diff: held.applied.diff },
        hint: hints[k] ?? hints[hints.length - 1] ?? { tiers: [] },
      });
    const verdicts = new Map<string, string>();
    for (const a of llmMemory(mem).attempts.get(goal.id) ?? []) if (a.sha !== '') verdicts.set(a.sha, a.verdict);
    bindCompile(run, ctx);
    const input: LlmFireInput = {
      goalId: goal.id,
      step: ctx.step,
      round: o.round,
      klass,
      // the class's N stands when the counters are spent: it is only compared with the cache size then
      n: spent ? samplesFor(klass, tReproMs) : n,
      tReproMs,
      system: buildFixSystemPrompt(),
      userFor,
      files,
      listings,
      tried: mem.tried,
      verdictOf: (sha) => verdicts.get(sha) ?? null,
      // §10.2 live finding (a): OpenRouter answers 400 to `reasoning: {enabled: false}` on z-ai/glm-5.3*; low effort is the default
      reasoning: { effort: 'low' },
      signal: ctx.signal,
      budget: budgetView(mem),
      attemptHash: attemptsHash(attempts),
    };
    // the feedback round fires whole (§4.6: "all"); the class decides otherwise unless a test overrides it
    if (o.stagger !== undefined) input.stagger = o.stagger;
    else if (o.round === 2) input.stagger = false;
    const startedMs = now();
    const fired = run.source.fire(input);
    const meta = { goalId: goal.id, round: o.round, klass, n: input.n ?? n, startedMs };
    if (fired.fired) return new PumpedRound(run.source, { ...meta, staggered: input.stagger ?? klass !== 'repository', deadlineMs: fired.deadlineMs }, now);
    // a cache replay is a round of its own (its candidates arrive through the queue and the round closes after them)
    if (fired.cached > 0 && fired.key !== null) return new PumpedRound(run.source, { ...meta, n: fired.cached, staggered: false, deadlineMs: LLM_REPLAY_DEADLINE_MS }, now);
    return skip(spent ? spentNote : fired.reason);
  }

  return {
    graceMs,
    now,
    fire,
    order: (ctx, goal, applied, files) => orderByQ17({ task: ctx.task, failures: goal.failures, candidates: applied, files }, ctx.ask, ctx.signal, 'propose'),
    spentUsd: (runId) => runs.get(runId)?.spentUsd ?? 0,
    recordSpend: (ctx, usd) => {
      const run = runOf(ctx);
      if (run !== null && Number.isFinite(usd) && usd > 0) run.spentUsd += usd;
    },
    exportCache: (runId) => runs.get(runId)?.source.exportCache() ?? null,
    stepEnd: async (ctx) => {
      const run = runs.get(ctx.runId);
      if (run === undefined || run.compile === null) return;
      const c = run.compile;
      run.compile = null;
      run.current = null;
      await c.cleanup();
    },
  };
}

// ---------------------------------------------------------------------------------------
// Ledger rows from arrivals (what the loop records beside the run outcomes)
// ---------------------------------------------------------------------------------------

/** The ledger rows an arrival's dropped hunks contribute (`syntax_error`, `misanchored`, `tried`; the rest feed back nothing). */
export function attemptsFromArrival(a: SampleArrival, step: number): AttemptRecord[] {
  const out: AttemptRecord[] = [];
  for (const d of a.dropped) {
    const row = attemptFromDrop(d, step);
    if (row !== null) out.push(row);
  }
  return out;
}

/** The `need` paths of a round's arrivals (≤ 3, first seen first), for the feedback round's widened listing (§4.9). */
export function needPathsOf(arrivals: readonly SampleArrival[], max = 3): string[] {
  const out: string[] = [];
  for (const a of arrivals) for (const p of a.need?.paths ?? []) if (!out.includes(p) && out.length < max) out.push(p);
  return out;
}
