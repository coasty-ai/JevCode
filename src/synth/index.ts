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
import type { Decider, SynthesisContext, Synthesizer } from '../core/types.js';
import { createTokenBeamSource } from './beam/index.js';
import { createDonorSource } from './donor/index.js';
import { fillSketches } from './fill/beam.js';
import { createLocalizer } from './localize/index.js';
import { createMutationSource } from './mutate/index.js';
import { isBestGuessTestId, runRepositoryQueue, venvPython } from './oracle/index.js';
import { SHUFFLE_RERANK_MAX, createRanker, shouldShuffleRerank, shuffleRerank } from './rank/index.js';
import { programRange } from './rank/questions.js';
import { pairsOfPartials } from './search/bases.js';
import { createCompositeSource } from './search/composite.js';
import { decideForSearch } from './search/guard.js';
import { LedgerSieveSynthesizer, REPO_BASELINE_TIMEOUT_MS, defaultSearchDeps } from './search/index.js';
import type { RunMemory, SearchDeps } from './search/index.js';
import { buildGoalSites, captureLineChoiceEscape } from './search/sites.js';
import { EDIT_CLASS_QUESTION_ID, priorFromAnswer, searchBestGuess, searchSubGoal } from './search/subgoal.js';
import type { JevSource, SearchQueue, SubGoalDeps, SubGoalMemory } from './search/subgoal.js';
import type { Goal } from './search/types.js';
import { VerifyQueue, vocabularyOf } from './sieve/queue.js';
import type { Vocabulary } from './sieve/queue.js';
import { runQueue } from './sieve/runner.js';
import { sketchPool } from './sketch/pool.js';
import { keepK, sketchQuestions } from './sketch/questions.js';
import { createTemplateSource } from './templates/index.js';
import type { Candidate, LocalizeResult, Site, SourceFile } from './types.js';

export { LedgerSieveSynthesizer } from './search/index.js';
export type { SearchDeps } from './search/index.js';

export interface SynthesizerOptions {
  /** the run's decider; prefer `ctx.ask` inside synthesize() so usage and decisions are recorded */
  decider: Decider;
  redact: (s: string) => string;
}

/** Token beam (§3 row 6): W = 3, ≤ 25 tokens, expand 1 at p ≥ 0.9 (probe-token-synthesis.md). */
const BEAM_WIDTH = 3;
const BEAM_MAX_TOKENS = 25;
const BEAM_CONFIDENT_EXPAND = 0.9;
/** Jev requests one localisation may spend: Q2 chunks + Q3 + ≤ 5 Q4 + ≤ 5 Q5 fit in the repository-class step cap of 60 (§4.3). */
const LOCALIZE_MAX_REQUESTS = 20;

/** Numbered listing of the site's enclosing function for the ranker's state. */
function functionListing(site: Site): string {
  const { start, end } = programRange(site);
  const lines = site.file.mod.lines;
  const out: string[] = [];
  for (let n = start; n <= end; n++) out.push(`L${n}: ${lines[n - 1] ?? ''}`);
  return out.join('\n');
}

function createQueue(ctx: SynthesisContext, mem: SubGoalMemory, goal: Goal): SearchQueue {
  const committed = mem.bases.find((b) => b.origin === 'committed');
  const vocab = new Map<string, Vocabulary>();
  for (const [path, file] of committed?.files ?? []) vocab.set(path, vocabularyOf(file, goal.failures, ctx.task));
  return new VerifyQueue({ tried: mem.tried, vocab });
}

/**
 * §2.5 for one goal: the localizer's beam (Q2–Q5) then search/sites.ts (Q5n, gaps, Q6, SBFL
 * union, cut 6 + 6). Q5's P(`none_of_these`) is captured off the localizer's own request so the
 * "insert sites first when Q5 put ≥ 0.3 on the escape" rule (§2.5 item 2) has its input; SBFL
 * evidence is not wired yet (it needs a coverage run through src/synth/sbfl on the lanes).
 */
async function locate(ctx: SynthesisContext, mem: SubGoalMemory, goal: Goal): Promise<LocalizeResult> {
  const committed = mem.bases.find((b) => b.origin === 'committed');
  const files = committed?.files ?? new Map<string, SourceFile>();
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
  });
  return { files: localized.files, functions: localized.functions, sites: goalSites.ordered, requests: localized.requests + goalSites.requests };
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

function subGoalDeps(): SubGoalDeps {
  const mutation = createMutationSource();
  const template = createTemplateSource();
  const donor = createDonorSource();
  const ranker = createRanker({ stage: 'propose' });
  return {
    locate,
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
  };
}

export function searchDeps(): SearchDeps {
  const sub = subGoalDeps();
  return { ...defaultSearchDeps(), searchSubGoal: (ctx, mem: RunMemory, goal) => searchSubGoal(ctx, mem, goal, sub), searchBestGuess: (ctx, mem: RunMemory, goal) => searchBestGuess(ctx, mem, goal, sub), locate: (ctx, mem: RunMemory, goal) => locate(ctx, mem, goal) };
}

/** The Ledger + Sieve synthesizer with the real modules wired in. */
export function createSynthesizer(_opts: SynthesizerOptions): Synthesizer {
  return new LedgerSieveSynthesizer(searchDeps());
}
