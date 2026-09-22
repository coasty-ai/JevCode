/**
 * Jev-only synthesizer entry point (docs/JEV-ONLY.md, design in docs/JEV-ONLY-DESIGN.md). In
 * `jev-only` mode the engine's propose stage calls `synthesize(ctx)` instead of the generator:
 * `ctx.ask` routes every Jev question through the engine (metered, jev.jsonl, decisions.jsonl,
 * the pane, the REPORT question rules) and `ctx.emit` reports progress as `synth` events. Tests,
 * not Jev, are the oracle: the returned Proposal goes through risk, execute and judge like any
 * generator proposal.
 *
 * This file is the one place that names the real modules of the design's §6 table and hands
 * them to the Ledger + Sieve controller (search/index.ts) and the sub-goal search
 * (search/subgoal.ts), whose collaborators are injected so they are unit-tested with fakes.
 */
import type { Decider, SynthesisContext, Synthesizer, SynthesizerArmMode, SynthesizerGeneration, WorkspaceInfo } from '../core/types.js';
import { createTokenBeamSource } from './beam/index.js';
import { createDonorSource } from './donor/index.js';
import { fillSketches } from './fill/beam.js';
import { createHistorySource, sameSpan } from './history/index.js';
import { runFacts, vocabularyAdditions } from './introspect/index.js';
import type { RunFacts } from './introspect/index.js';
import { LLM_DEFAULT_GENERATION } from './llm/source.js';
import { createLocalizer } from './localize/index.js';
import { createMutationSource } from './mutate/index.js';
import { isBestGuessTestId, isRepositoryWorkspace, runRepositoryQueue, venvPython } from './oracle/index.js';
import { SHUFFLE_RERANK_MAX, createRanker, shouldShuffleRerank, shuffleRerank } from './rank/index.js';
import { programRange } from './rank/questions.js';
import { pairsOfPartials } from './search/bases.js';
import { createCompositeSource } from './search/composite.js';
import { decideForSearch } from './search/guard.js';
import { LedgerSieveSynthesizer, REPO_BASELINE_TIMEOUT_MS, defaultSearchDeps, detectLayout } from './search/index.js';
import type { RunMemory, SearchDeps } from './search/index.js';
import { createSearchLlm } from './search/llm.js';
import type { SearchLlmOptions, SubGoalLlm } from './search/llm.js';
import { buildGoalSites, captureLineChoiceEscape, historySites, mergeIntrospectionSites } from './search/sites.js';
import { EDIT_CLASS_QUESTION_ID, isTestPath, priorFromAnswer, searchBestGuess, searchSubGoal } from './search/subgoal.js';
import type { JevSource, SearchQueue, SubGoalDeps, SubGoalMemory } from './search/subgoal.js';
import type { Goal } from './search/types.js';
import { VerifyQueue, vocabularyOf } from './sieve/queue.js';
import type { Vocabulary } from './sieve/queue.js';
import { runQueue } from './sieve/runner.js';
import { sketchPool } from './sketch/pool.js';
import { keepK, sketchQuestions } from './sketch/questions.js';
import { createTemplateSource } from './templates/index.js';
import type { Candidate, CandidateSource, EnumerateOptions, LocalizeResult, Site, SourceFile } from './types.js';

export { LedgerSieveSynthesizer } from './search/index.js';
export type { SearchDeps } from './search/index.js';

export interface SynthesizerOptions {
  /** the run's decider; prefer `ctx.ask` inside synthesize() so usage and decisions are recorded */
  decider: Decider;
  redact: (s: string) => string;
  /**
   * docs/LLM-JEV-DESIGN.md §9.2 stage 4 / §10.1: the arm the synthesizer is built for (default `jev-only`, the CLI's call).
   * `'llm-jev'` wires the LLM candidate source (search/llm.ts over `SynthesisContext.generate`), the controller's llm-jev
   * switches and `handles()`; `'jev-only'` is the unchanged Ledger + Sieve. The returned synthesizer echoes the mode it
   * implements (`Synthesizer.mode`); the bench refuses an arm whose echo differs, and an arm that is not wired yet
   * (`'llm-sieve'`) throws instead of running as another one.
   */
  mode?: SynthesizerArmMode;
  /** llm-jev knobs (pricing, grace, the probe's p90); defaults per the §10.2 live findings */
  llm?: SearchLlmOptions;
  /**
   * the generation parameters the LLM source sends on every sample and the L2 writer reuses (§10.1: pinned per bench arm);
   * default `LLM_DEFAULT_GENERATION`; echoed as `Synthesizer.generation` in `llm-jev`
   */
  generation?: SynthesizerGeneration;
}

/** Token beam (§3 row 6): W = 3, ≤ 25 tokens, expand 1 at p ≥ 0.9 (probe-token-synthesis.md). */
const BEAM_WIDTH = 3;
const BEAM_MAX_TOKENS = 25;
const BEAM_CONFIDENT_EXPAND = 0.9;
/** Jev requests one localisation may spend: Q2 chunks + Q3 + ≤ 5 Q4 + ≤ 5 Q5 fit in the repository-class step cap of 60 (§4.3). */
const LOCALIZE_MAX_REQUESTS = 20;

/**
 * The options a source sees: the plain ones plus the run's introspection, history and the names the
 * vocabulary must accept for this file (`extraNames`: the flat introspected names ∪ the alias names
 * the file's own dispatch prefix composes from them). Unchanged when nothing was harvested. The facts
 * are the run's own — `opts.runId` (search/subgoal.ts enumerateOptions) looked up in introspect/facts.ts —
 * never a process-wide "current run": a bench process searches several runs at once, and a cell refreshed
 * by whichever run's `createQueue`/`locate` ran last handed one run's names and history to another's seeds.
 */
export function enrichEnumerateOptions(site: Site, opts: EnumerateOptions, facts: RunFacts | null = opts.runId === undefined ? null : runFacts(opts.runId)): EnumerateOptions {
  if (facts === null) return opts;
  const out: EnumerateOptions = { ...opts };
  if (facts.introspected !== null) {
    out.introspected = facts.introspected;
    out.extraNames = vocabularyAdditions(facts.introspected, site.file);
  }
  if (facts.history !== null) out.history = facts.history;
  return out;
}

/** Numbered listing of the site's enclosing function for the ranker's state. */
function functionListing(site: Site): string {
  const { start, end } = programRange(site);
  const lines = site.file.mod.lines;
  const out: string[] = [];
  for (let n = start; n <= end; n++) out.push(`L${n}: ${lines[n - 1] ?? ''}`);
  return out.join('\n');
}

/**
 * The verification queue of one sub-goal search: `tried` exclusion and the vocabulary pre-check
 * per file. With introspected names the vocabulary of every file is `vocabularyOf(...) ∪
 * vocabularyAdditions(introspected, file)` — the flat names (classes, `is_*` predicates,
 * attributes, module names of the failing call's objects) and the `<prefix><Class>` alias names
 * the file's own dispatch prefix composes — so the pre-check (sieve/queue.ts missingFromVocab)
 * accepts exactly what templates/introspect.ts writes and nothing else new.
 */
export function createQueue(ctx: SynthesisContext, mem: SubGoalMemory, goal: Goal): SearchQueue {
  const committed = mem.bases.find((b) => b.origin === 'committed');
  const introspected = runFacts(ctx.runId)?.introspected ?? null;
  const vocab = new Map<string, Vocabulary>();
  for (const [path, file] of committed?.files ?? []) {
    const base = vocabularyOf(file, goal.failures, ctx.task);
    vocab.set(path, introspected === null ? base : new Set([...base, ...vocabularyAdditions(introspected, file)]));
  }
  return new VerifyQueue({ tried: mem.tried, vocab });
}

/**
 * §2.5 for one goal: the localizer's beam (Q2–Q5) then search/sites.ts (Q5n, gaps, Q6, SBFL
 * union, cut 6 + 6). Q5's P(`none_of_these`) is captured off the localizer's own request so the
 * "insert sites first when Q5 put ≥ 0.3 on the escape" rule (§2.5 item 2) has its input; SBFL
 * evidence is not wired yet (it needs a coverage run through src/synth/sbfl on the lanes).
 */
async function locate(ctx: SynthesisContext, mem: SubGoalMemory, goal: Goal, opts: { batchQ6Fallback?: boolean } = {}): Promise<LocalizeResult> {
  const committed = mem.bases.find((b) => b.origin === 'committed');
  const files = committed?.files ?? new Map<string, SourceFile>();
  // this run's facts, read before the awaits below: another run's search may start in between (bench concurrency)
  const facts = runFacts(ctx.runId);
  const captured = captureLineChoiceEscape(ctx.ask);
  // repository mode: the issue's traceback (the frames Jev judged inside the fix, and the reproduction's raising frames) anchors the goal
  const traceback = mem.repository !== undefined && mem.repository.goalId === goal.id ? mem.repository.traceback : null;
  const localized = await createLocalizer({ stage: 'propose', fileBeam: mem.overrides.fileBeam }).localize({ ask: captured.ask, task: ctx.task, files, failures: goal.failures, signal: ctx.signal, budget: { maxRequests: Math.min(LOCALIZE_MAX_REQUESTS, Math.max(1, mem.stepBudget.jevRequestsLeft)) }, ...(traceback === null ? {} : { traceback }) });
  const q5Escape = captured.escape();
  const goalSites = await buildGoalSites({ ask: ctx.ask, task: ctx.task, signal: ctx.signal, files }, goal, localized, undefined, {
    maxReplaceSites: mem.overrides.siteBeam,
    maxInsertSites: mem.overrides.siteBeam,
    stage: 'propose',
    ...(q5Escape === null ? {} : { q5EscapeProbability: q5Escape }),
    // llm-jev: the Q6 fallback's statements go in one request over one state (docs/LLM-JEV-DESIGN.md §9.2 stage 4)
    ...(opts.batchQ6Fallback === true ? { batchQ6Fallback: true } : {}),
  });
  // the introspected names' sites (≤ 3, after the Jev-ranked list): the gap before the statement an operand
  // was read in, the class-body gap of the class the failing call's objects point at, when a localised file
  // defines it, and that file's import gap; one that collides with a located site is merged onto it
  const localised = [...new Set([...goal.suspectedFiles, ...localized.files.map((f) => f.path), ...goalSites.ordered.map((s) => s.file.path)])];
  let sites: Site[] = goalSites.ordered;
  const describe = (s: Site): string => `${s.file.path}:${s.line} (${s.kind === 'insert' ? `gap, indent ${s.indent.length}` : `replace${s.endLine === undefined ? '' : `, span L${s.line}-${s.endLine}`}`}; ${s.evidence.notes.find((n) => n.startsWith('introspection:') || n.startsWith('history:')) ?? s.evidence.notes[0] ?? ''})`;
  const introspected = facts?.introspected ?? null;
  if (introspected !== null) {
    const m = mergeIntrospectionSites(sites, introspected, files, localised);
    sites = m.sites;
    if (m.added.length + m.merged.length > 0) ctx.emit({ type: 'synth', step: ctx.step, phase: 'localize', detail: `${goal.id}: ${m.added.length} introspection site${m.added.length === 1 ? '' : 's'} after the ${goalSites.ordered.length} located${m.merged.length === 0 ? '' : `, ${m.merged.length} merged onto located site${m.merged.length === 1 ? '' : 's'}`}: ${[...m.added, ...m.merged].map(describe).join('; ')}` });
  }
  // the history reversals' own sites (≤ 2, after those): history/source.ts emits a reversal only at the site it
  // is located at, so a reversal elsewhere than the located sites is reachable through these alone
  const history = facts?.history ?? null;
  if (history !== null) {
    const hs = historySites(history, files, localised, sites);
    if (hs.length > 0) {
      ctx.emit({ type: 'synth', step: ctx.step, phase: 'localize', detail: `${goal.id}: ${hs.length} history site${hs.length === 1 ? '' : 's'} after the ${sites.length} located: ${hs.map(describe).join('; ')}` });
      sites = [...sites, ...hs];
    }
  }
  return { files: localized.files, functions: localized.functions, sites, requests: localized.requests + goalSites.requests };
}

/** SKETCH phase (§3 row 5): one Q12 + Q7 request, keep K, slot-fill (Q13), concrete candidates. */
const sketchSource: JevSource = {
  async enumerate({ ctx, mem, goal, site, opts }) {
    const pool = sketchPool(site, opts);
    if (pool.length === 0) return { candidates: [], requests: 0 };
    const request = sketchQuestions(site, pool, { task: ctx.task, failures: goal.failures });
    const res = await ctx.ask('propose', request.state, request.questions);
    const kept = keepK(res.answers, request);
    const filled = await fillSketches(kept.kept, { site, task: ctx.task, failures: goal.failures, enumerate: opts, signal: ctx.signal, maxRequests: Math.max(1, Math.min(12, mem.stepBudget.jevRequestsLeft - 1)), stage: 'propose' }, ctx.ask);
    const editClass = priorFromAnswer(res.answers[EDIT_CLASS_QUESTION_ID]);
    const out = { candidates: filled.candidates, requests: 1 + filled.requests };
    return editClass === null ? out : { ...out, editClass };
  },
};

/** BEAM phase (§3 row 6): grammar-guided token beam over the site; its top-3 distinct completions become candidates. */
const beamSource: JevSource = {
  async enumerate({ ctx, goal, site, opts }) {
    const src = createTokenBeamSource(ctx.ask, { width: BEAM_WIDTH, maxTokens: BEAM_MAX_TOKENS, confidentExpandThreshold: BEAM_CONFIDENT_EXPAND });
    const synthesis = await src.synthesizeLine(site, { task: ctx.task, failures: goal.failures, signal: ctx.signal, enumerate: opts });
    return { candidates: src.enumerate(site, opts), requests: synthesis.requests };
  },
};

/** History's share of a site's donor seed: at most this many reversals … */
export const HISTORY_SEED_MAX = 16;
/** … and at most this fraction of `opts.cap`, whichever is smaller (254 → 16; 60 → 15; 1 → 0). */
export const HISTORY_SEED_SHARE = 0.25;

/** The number of history reversals a donor seed of cap `cap` may carry. */
export function historySeedCap(cap: number): number {
  return Math.max(0, Math.min(HISTORY_SEED_MAX, Math.floor(cap * HISTORY_SEED_SHARE)));
}

/**
 * The donor seed of `site` with its history reversals spliced in AFTER the donors' top half — ≤
 * `historySeedCap(cap)` of them, only those at the site (`sameSpan`; the history source emits no
 * others, this is the enumerator's own check) — the union cut at `cap`. Exactly the donors when
 * there is no reversal: history never displaces a donor it does not sit beside (§21.5 measured
 * reversals going FIRST and the union cut at the cap; §18 counted 10 noise reversals on one site).
 */
export function seedWithHistory(donors: readonly Candidate[], reversals: readonly Candidate[], site: Site, cap: number): Candidate[] {
  const limit = Math.max(0, cap);
  const own = reversals.filter((c) => sameSpan(c.site, site)).slice(0, historySeedCap(cap));
  if (own.length === 0) return donors.slice(0, limit);
  const half = Math.ceil(donors.length / 2);
  return [...donors.slice(0, half), ...own, ...donors.slice(half)].slice(0, limit);
}

/**
 * The sub-goal search's collaborators with the real modules. The template and donor seeds are
 * wrapped so they enumerate with the run's harvested facts (`enrichEnumerateOptions`): the
 * introspection-fed productions of templates/introspect.ts fire only with `opts.introspected`, and
 * the history source rides with the donor seed (subgoal.ts orderSources has no slot of its own for
 * design §3's last row and `SubGoalDeps.seeds` is a fixed record): its reversals AT the site follow
 * the donors' top half (`seedWithHistory`, share-capped), the union cut at `opts.cap`; both keep
 * their own `source` name for the trace and the queue's prior. Composite pairs over the wrapped
 * seeds, so pairs are pairs of what SEEDS ran. `over` replaces a source (tests).
 */
export function createSubGoalDeps(over: Partial<{ history: CandidateSource; donor: CandidateSource }> = {}, wiring: { llm?: SubGoalLlm } = {}): SubGoalDeps {
  const llmJev = wiring.llm !== undefined;
  const mutation = createMutationSource();
  const plainTemplate = createTemplateSource();
  const plainDonor = over.donor ?? createDonorSource();
  const history = over.history ?? createHistorySource();
  const template: CandidateSource = { name: 'template', enumerate: (site, opts) => plainTemplate.enumerate(site, enrichEnumerateOptions(site, opts)) };
  const donor: CandidateSource = {
    name: 'donor',
    enumerate: (site, opts) => {
      const o = enrichEnumerateOptions(site, opts);
      const donors = plainDonor.enumerate(site, o);
      return seedWithHistory(donors, o.history === undefined ? [] : history.enumerate(site, o), site, opts.cap);
    },
  };
  // llm-jev: full-criteria Nouls in chunks ≤ 50 for 11–150 candidates (docs/LLM-JEV-DESIGN.md §9.2 stage 4); the measured compact hybrid otherwise
  const ranker = createRanker({ stage: 'propose', ...(llmJev ? { fullCriteriaNouls: true } : {}) });
  return {
    locate: (ctx, mem, goal) => locate(ctx, mem, goal, llmJev ? { batchQ6Fallback: true } : {}),
    // Source 4 (§3 row 4): depth-2 pairs of the top-10 single edits, the signature + call-site unit and
    // the multi-line donor body unit, over the same three seed sources so pairs are pairs of what SEEDS ran.
    seeds: { mutation, template, donor, composite: createCompositeSource({ singles: [mutation, template, donor] }) },
    sketch: sketchSource,
    beam: beamSource,
    rank: async (ctx: SynthesisContext, mem: SubGoalMemory, cands: readonly Candidate[], site: Site, goal: Goal) => {
      const rankCtx = { ask: ctx.ask, task: ctx.task, failures: goal.failures, functionListing: functionListing(site), signal: ctx.signal };
      const out = await ranker.rank(cands, rankCtx);
      // Q10r (§2.7): shuffle-and-average re-ask on slow oracles (t_run > 20 s) when the top-2 margin is inside the noise band.
      if (!shouldShuffleRerank(out.ranked, mem.oracle.tRunMs.goalSubset)) return out;
      const shortlist = out.ranked.slice(0, SHUFFLE_RERANK_MAX);
      const re = await shuffleRerank(shortlist, rankCtx, { stage: 'propose' });
      return { ...out, ranked: [...re.ranked, ...out.ranked.slice(SHUFFLE_RERANK_MAX)], requests: out.requests + re.requests };
    },
    createQueue,
    // Repository mode (search/index.ts rebaselineRepository): the goal-subset run is the issue's
    // reproduction and the full-suite run the scoped regression command, on worktree lanes with the
    // workspace venv (oracle/verify.ts); the best-guess goal runs the regression scope only.
    runQueue: async (ctx, mem, queue, goal, runsAllowed) => {
      const repo = mem.repository;
      if (repo === undefined) return runQueue(ctx, mem, queue, goal, runsAllowed);
      const bestGuess = goal.tests[0] !== undefined && isBestGuessTestId(goal.tests[0]);
      const python = await venvPython(ctx.workspaceInfo.root);
      const timeoutMs = Math.max(1000, Math.min(mem.oracle.runTimeoutMs, ctx.limits.maxCommandTimeoutMs, REPO_BASELINE_TIMEOUT_MS));
      return runRepositoryQueue(ctx, mem, queue, goal, runsAllowed, { spec: bestGuess ? null : (repo.repro?.spec ?? null), regression: { command: repo.scope.command, timeoutMs }, ...(python === undefined ? {} : { python }) });
    },
    decide: decideForSearch,
    pairsOfPartials,
    ...(wiring.llm === undefined ? {} : { llm: wiring.llm }),
  };
}

export function searchDeps(wiring: { llm?: SubGoalLlm } = {}): SearchDeps {
  const sub = createSubGoalDeps({}, wiring);
  return {
    ...defaultSearchDeps(),
    searchSubGoal: (ctx, mem: RunMemory, goal) => searchSubGoal(ctx, mem, goal, sub),
    searchBestGuess: (ctx, mem: RunMemory, goal) => searchBestGuess(ctx, mem, goal, sub),
    locate: (ctx, mem: RunMemory, goal) => locate(ctx, mem, goal, wiring.llm === undefined ? {} : { batchQ6Fallback: true }),
    ...(wiring.llm === undefined ? {} : { llm: wiring.llm }),
  };
}

/**
 * docs/LLM-JEV-DESIGN.md §9.4: the synthesizer covers a workspace with Python source files and either a pytest/QuixBugs layout
 * whose runner the workspace detected (`info.testCommand`) or a repository (a whole-project suite or a large package). A non-Python,
 * test-less, runner-less or feature-work workspace is the engine's generic per-step fallback — outside the dominance claim.
 */
export function synthesizerHandles(info: Pick<WorkspaceInfo, 'testCommand'>, files: readonly string[]): boolean {
  if (!files.some((p) => p.endsWith('.py') && !isTestPath(p))) return false;
  if (detectLayout(files) !== 'other') return info.testCommand !== null;
  return isRepositoryWorkspace(info.testCommand, files);
}

/**
 * The Ledger + Sieve synthesizer with the real modules wired in, echoing the arm it implements (§10.1). In `llm-jev` the
 * LLM candidate source rides in (`SynthesisContext.generate`, when the engine exposes it) with the pinned generation
 * parameters (`opts.generation`, default `LLM_DEFAULT_GENERATION`: the L1 rounds and the L2 writer send them, and the
 * synthesizer echoes the very object), the controller takes its llm-jev switches and `handles()` answers the engine's §9.4
 * question. `jev-only` is the unchanged synthesizer.
 *
 * `llm-sieve` is built as `llm-jev` and echoes its OWN mode (F06). The arm is not a different search: §10.1 defines it
 * as llm-jev with "every Jev question replaced by its code default", and the substitution is made in the DECIDER slot,
 * not here — `bench/conditions.ts usesStubDecider` puts `bench/stub-decider.ts` there, whose inert answers are exactly
 * those defaults (a Noul at 0.5 sits under every yes-cut and above every no-cut so no gate fires and rankings fall
 * through to the code order; all Choice mass on the first non-escape option IS arrival order; Score level 0) and which
 * COUNTS what it absorbed as `stubbedJevRequests`. Nothing in this factory's `mode` would issue a Jev request the stub
 * has not already taken, so constructing the arm as llm-jev runs the arm rather than a different one.
 *
 * It is the only construction path: `--mode` (`src/cli/args.ts MODES`) has no `llm-sieve`, so the arm is reachable only
 * through `jevcode bench --conditions`, where the runner always pairs it with the stub. Before this, the throw here
 * turned `--conditions llm-sieve` into one `engine_create_failed` record per task — a whole run directory of failures
 * for a typeable flag — and left head-to-head criterion 5a permanently `not_evaluable`.
 *
 * Residual, recorded rather than hidden: §10.1's row also says "no L2 (code oracle only)", and the L2 reproduction
 * writer is an llm-jev mechanism the stub does not switch off (it only stubs L2's Jev judgement). docs/LLM-LOOP-DESIGN.md
 * §9.1 carries it as F17's sibling; an `l2: false` controller switch is a mechanism change, not a finishing fix.
 */
export function createSynthesizer(opts: SynthesizerOptions): Synthesizer {
  const mode: SynthesizerArmMode = opts.mode ?? 'jev-only';
  if (mode === 'jev-only') return Object.assign(new LedgerSieveSynthesizer(searchDeps()), { mode });
  const generation = opts.generation ?? LLM_DEFAULT_GENERATION;
  const llm = createSearchLlm({ ...(opts.llm ?? {}), generation });
  const inner = new LedgerSieveSynthesizer(searchDeps({ llm }), { llmJev: true, generation });
  return { name: inner.name, mode, generation, synthesize: (ctx) => inner.synthesize(ctx), handles: synthesizerHandles };
}
