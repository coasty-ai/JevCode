/**
 * Jev ranker for the jev-only synthesizer (docs/JEV-ONLY.md; contract in ../types.ts).
 *
 * Code enumerates candidate edits at one site; this module asks Jev which one is the fix and
 * returns them best first with a "fix probably not in this set" signal, so the search runs
 * the tests on a few candidates instead of hundreds. Method by candidate count N, chosen from
 * experiments/results/probe-selection.md:
 *   - N ≤ 10          one Choice + `none_of_these`           (top-1 36/40 at N=10)
 *   - 10 < N ≤ 60     the same Choice plus one compact Noul per candidate in the SAME request;
 *                     ranked by the Nouls (absolute, 37-39/40 at N=50 vs 31/40 for the Choice),
 *                     the Choice supplies P(escape) and the fix-absent margin
 *   - N > 60          two-stage: compact Nouls over everything in concurrent chunks of ≤ 254,
 *                     then one Choice over the five highest Nouls (33/40 top-1 at N=254,
 *                     fix shortlisted 39/40, vs 26/40 for a flat Choice)
 * The unchanged line is never an option (probe-question-design §6: +1.25 top-1, 0 confident
 * misses) and duplicate candidates are folded into one option (REPORT §7: duplicates split
 * the mass). Jev never marks a fix correct: tests do.
 */
import type { Answer, Json, Question, StageName } from '../../core/types.js';
import { AbortError } from '../../errors.js';
import { ESCAPE_KEY, assertQuestionBatch } from '../../jev/questions.js';
import { CHARS_PER_TOKEN } from '../localize/budget.js';
import type { Candidate, JevAsk, RankContext, RankResult, RankedCandidate, Ranker, Site } from '../types.js';
import { CHOICE_QUESTION_ID, buildChoiceQuestion, buildCompactNouls, buildRankState, candidateKey, candidateSignature, isUnchanged, programRange, rankMode } from './questions.js';

export {
  CHOICE_INSTRUCTIONS,
  CHOICE_QUESTION_ID,
  CORRECT_FIX_CRITERIA,
  CORRECT_FIX_CRITERIA_STATE,
  ESCAPE_DESCRIPTION,
  LITERAL_SUFFIX,
  MAX_CANDIDATE_CHARS,
  MAX_PROGRAM_LINES,
  MAX_TESTS_IN_STATE,
  MAX_TEST_VALUE_CHARS,
  MAX_USER_TASK_CHARS,
  MODULE_WINDOW_LINES,
  anchorLine,
  buildChoiceQuestion,
  buildCompactNouls,
  buildRankState,
  candidateDescription,
  candidateKey,
  candidateSignature,
  compactNoulInstruction,
  isUnchanged,
  lineSignature,
  programRange,
  rankMode,
  taskSentence,
} from './questions.js';
export type { RankMode, RankStateOptions } from './questions.js';

// ---------------------------------------------------------------------------------------
// Measured thresholds and regime bounds
// ---------------------------------------------------------------------------------------

/** Largest N answered with a single Choice (probe-selection: Choice top-1 falls 90% → 78% from 10 to 50). */
export const CHOICE_MAX_CANDIDATES = 10;
/** Largest N answered in one request (Choice + compact Nouls); above it the Nouls are chunked. */
export const HYBRID_MAX_CANDIDATES = 60;
/** Candidates per Noul request: 254 + `none_of_these` = the 255-option Choice limit the probes used. */
export const CHUNK_MAX_CANDIDATES = 254;
/** Two-stage shortlist: the fix was in the Noul top-5 on 39/40 programs at N=254. */
export const SHORTLIST_SIZE = 5;
/** Fix-absent detector on a Choice: flag when P(escape) − p_max ≥ 0.10 (AUROC 0.916, 82% detection, 13% false alarms). */
export const ESCAPE_MARGIN_THRESHOLD = 0.1;
/** Fix-absent detector on Nouls: flag when the highest Noul is below 0.5 (71-75% detection, 16-21% false alarms). */
export const NOUL_ABSENT_THRESHOLD = 0.5;
/**
 * The measured margin threshold is the data value 0.0999… printed as 0.10 (probe-selection,
 * verification note), and 0.5 − 0.4 is 0.09999999999999998 in floating point; the tolerance
 * makes "0.50 vs 0.40" flag as the probe counted it.
 */
export const DETECTOR_EPSILON = 1e-9;
/** Jev allows 128-way concurrency (REPORT §5); this keeps one site from taking it all. */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
/**
 * Repository states: the probe's 254-candidate request was 18k tokens with a 10-line program
 * listing and the wire cap is 32k for state + longest question; a 25–175-line SWE function
 * listing (~4k+ tokens) leaves room for ~150 candidates per chunk, not 254
 * (experiments/designs/repair-search.md §1.5, docs/JEV-ONLY-DESIGN.md §2.7 Q9).
 */
export const REPO_LISTING_TOKEN_THRESHOLD = 4_000;
export const REPO_CHUNK_MAX_CANDIDATES = 150;
/**
 * Shuffle-and-average re-ask (design Q10r): reordering ~300 near-duplicate candidates moved
 * `kth` 0.48 → 0.14 and `next_permutation` 0.19 → 0.52 (lit-search-based-repair.md verification),
 * so when a test run is expensive (> 20 s) and the top-2 are within 0.10 the shortlist is
 * re-asked once in a shuffled order and the two p's are averaged before a run is spent.
 * Cheap oracles fall through to the tests instead (one extra request ≈ $0.0002 is not worth it).
 */
export const SHUFFLE_RERANK_MIN_T_RUN_MS = 20_000;
export const SHUFFLE_RERANK_MARGIN = 0.1;
/** The re-asked shortlist is at most this long (repair-search §1.5: "≤ 10 candidates"). */
export const SHUFFLE_RERANK_MAX = 10;

/** Estimated input tokens of the `program` listing the rank state shows for `site`. */
export function listingTokens(site: Site): number {
  const { start, end } = programRange(site);
  let chars = 0;
  for (let n = start; n <= end; n++) chars += (site.file.mod.lines[n - 1] ?? '').length + 8; // + the `"L<n>": ""` framing
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Chunk size for stage-one Nouls at `site`: 150 when the listing is repository-sized, else `chunkMax`. */
export function effectiveChunkMax(site: Site, chunkMax: number): number {
  return listingTokens(site) > REPO_LISTING_TOKEN_THRESHOLD ? Math.min(chunkMax, REPO_CHUNK_MAX_CANDIDATES) : chunkMax;
}

export interface RankerOptions {
  choiceMax?: number;
  hybridMax?: number;
  chunkMax?: number;
  shortlistSize?: number;
  maxConcurrentRequests?: number;
  /** stage recorded on the decisions; the probes ran as `propose` */
  stage?: StageName;
}

/** Code-computed signals behind `fixProbablyAbsent`, for the transcript and the search policy. */
export interface RankSignals {
  /** P(none_of_these) on the Choice, null when no Choice was asked */
  pEscape: number | null;
  /** highest non-escape Choice probability */
  pMax: number | null;
  /** highest per-candidate Noul, null when no Nouls were asked */
  maxNoul: number | null;
  choiceFlags: boolean | null;
  noulFlags: boolean | null;
  /** Noul requests in stage one (0 for the pure Choice) */
  chunks: number;
  /** candidates dropped because they equal the current line */
  excludedUnchanged: number;
  /** candidates folded into an identical earlier one */
  duplicatesFolded: number;
  /** distinct options Jev saw */
  optionsAsked: number;
}

export interface RankedCandidateDetail extends RankedCandidate {
  /** per-candidate Noul when one was asked */
  noulProbability?: number;
  /** Choice probability when the candidate was an option of a Choice */
  choiceProbability?: number;
  /** option key the candidate had in its request (stage-one key for two-stage) */
  optionKey: string;
}

export interface RankOutcome extends RankResult {
  ranked: RankedCandidateDetail[];
  signals: RankSignals;
}

/** The contract's Ranker with the richer result type (assignable to `Ranker`). */
export interface JevRanker extends Ranker {
  rank(candidates: readonly Candidate[], ctx: RankContext): Promise<RankOutcome>;
}

// ---------------------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------------------

/** `P(escape) − p_max ≥ 0.10`, with the floating-point tolerance explained on DETECTOR_EPSILON. */
export function choiceFlagsAbsent(pEscape: number, pMax: number): boolean {
  return pEscape - pMax >= ESCAPE_MARGIN_THRESHOLD - DETECTOR_EPSILON;
}

/** `max Noul < 0.5`. */
export function noulsFlagAbsent(maxNoul: number): boolean {
  return maxNoul < NOUL_ABSENT_THRESHOLD;
}

/**
 * Chunk sizes for N candidates with at most `max` per chunk, as even as possible (500 → 250 +
 * 250 rather than 254 + 246) so no chunk is much harder than another.
 */
export function chunkSizes(n: number, max: number): number[] {
  if (n <= 0) return [];
  const chunks = Math.ceil(n / max);
  const base = Math.floor(n / chunks);
  const extra = n % chunks;
  return Array.from({ length: chunks }, (_, i) => base + (i < extra ? 1 : 0));
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

function abortErrorOf(signal: AbortSignal): AbortError {
  return signal.reason instanceof AbortError ? signal.reason : new AbortError('signal');
}

/**
 * One Jev request that honours the abort signal: never started once aborted, and rejected as
 * soon as the signal fires even though `JevAsk` itself takes no signal (the engine's own
 * decider stops on its controller; this keeps rank() from waiting on it).
 */
async function askAbortable(ask: JevAsk, stage: StageName, state: Json, questions: Record<string, Question>, signal: AbortSignal): Promise<Record<string, Answer>> {
  if (signal.aborted) throw abortErrorOf(signal);
  assertQuestionBatch(questions);
  return new Promise<Record<string, Answer>>((resolve, reject) => {
    const onAbort = (): void => reject(abortErrorOf(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    ask(stage, state, questions).then(
      (r) => {
        signal.removeEventListener('abort', onAbort);
        resolve(r.answers);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Run tasks with bounded concurrency, preserving order; the first rejection wins and no
 * further task is started after it (a failed chunk should not fan out more paid requests).
 */
async function runPool<T>(tasks: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array<T>(tasks.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const i = next++;
      if (i >= tasks.length) return;
      const task = tasks[i];
      if (task === undefined) return;
      try {
        out[i] = await task();
      } catch (e: unknown) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return out;
}

function choiceAnswer(answers: Record<string, Answer>, id: string): { choice: string; probabilities: Record<string, number> } {
  const a = answers[id];
  if (a === undefined || a.type !== 'choice') throw new TypeError(`ranker: expected a choice answer for "${id}"`);
  return a;
}

function noulAnswer(answers: Record<string, Answer>, id: string): number {
  const a = answers[id];
  if (a === undefined || a.type !== 'noul') throw new TypeError(`ranker: expected a noul answer for "${id}"`);
  return a.noul;
}

function prob(p: Record<string, number>, key: string): number {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function maxNonEscape(p: Record<string, number>): number {
  let m = 0;
  for (const [k, v] of Object.entries(p)) if (k !== ESCAPE_KEY && v > m) m = v;
  return m;
}

function sameSite(a: Site, b: Site): boolean {
  return a.file.path === b.file.path && a.line === b.line && a.kind === b.kind;
}

interface Unique {
  index: number;
  key: string;
  candidate: Candidate;
  duplicates: Candidate[];
}

/** Stable descending sort by `score`, then by `tiebreak`, then by enumeration order. */
function orderBy<T extends { index: number }>(items: readonly T[], score: (t: T) => number, tiebreak: (t: T) => number = () => 0): T[] {
  return [...items].sort((a, b) => score(b) - score(a) || tiebreak(b) - tiebreak(a) || a.index - b.index);
}

// ---------------------------------------------------------------------------------------
// Ranker
// ---------------------------------------------------------------------------------------

export function createRanker(options: RankerOptions = {}): JevRanker {
  const choiceMax = options.choiceMax ?? CHOICE_MAX_CANDIDATES;
  const hybridMax = options.hybridMax ?? HYBRID_MAX_CANDIDATES;
  const chunkMax = options.chunkMax ?? CHUNK_MAX_CANDIDATES;
  const shortlistSize = options.shortlistSize ?? SHORTLIST_SIZE;
  const concurrency = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
  const stage: StageName = options.stage ?? 'propose';
  if (!(choiceMax >= 1) || !(hybridMax >= choiceMax) || !(chunkMax >= 1) || chunkMax > 254 || !(shortlistSize >= 1) || shortlistSize > 254) {
    throw new RangeError('createRanker: need 1 ≤ choiceMax ≤ hybridMax, 1 ≤ chunkMax ≤ 254, 1 ≤ shortlistSize ≤ 254');
  }

  /** Drop the unchanged line, fold duplicates; keys are assigned per request later. */
  function prepare(candidates: readonly Candidate[], site: Site): { uniques: Unique[]; excludedUnchanged: number; duplicatesFolded: number } {
    const bySig = new Map<string, Unique>();
    const uniques: Unique[] = [];
    let excludedUnchanged = 0;
    let duplicatesFolded = 0;
    for (const c of candidates) {
      if (!sameSite(c.site, site)) throw new RangeError(`ranker: ${c.source} candidate "${c.id}"${c.provenance === undefined ? '' : ` (${c.provenance})`} is at ${c.site.file.path}:${c.site.line} (${c.site.kind}), not at the site being ranked (${site.file.path}:${site.line}, ${site.kind}); the ${c.source} source must emit a candidate only at the site it enumerates`);
      if (isUnchanged(c, site)) {
        excludedUnchanged++;
        continue;
      }
      const sig = candidateSignature(c);
      const seen = bySig.get(sig);
      if (seen !== undefined) {
        seen.duplicates.push(c);
        duplicatesFolded++;
        continue;
      }
      const u: Unique = { index: uniques.length, key: '', candidate: c, duplicates: [] };
      bySig.set(sig, u);
      uniques.push(u);
    }
    return { uniques, excludedUnchanged, duplicatesFolded };
  }

  /** Expand the ordered uniques into the contract's ranked list (duplicates follow their representative). */
  function expand(ordered: readonly Unique[], probabilityOf: (u: Unique) => number, detailOf: (u: Unique) => { noulProbability?: number; choiceProbability?: number }): RankedCandidateDetail[] {
    const out: RankedCandidateDetail[] = [];
    for (const u of ordered) {
      const probability = probabilityOf(u);
      const detail = detailOf(u);
      for (const candidate of [u.candidate, ...u.duplicates]) {
        const row: RankedCandidateDetail = { candidate, probability, rank: out.length + 1, optionKey: u.key };
        if (detail.noulProbability !== undefined) row.noulProbability = detail.noulProbability;
        if (detail.choiceProbability !== undefined) row.choiceProbability = detail.choiceProbability;
        out.push(row);
      }
    }
    return out;
  }

  async function rank(candidates: readonly Candidate[], ctx: RankContext): Promise<RankOutcome> {
    if (ctx.signal.aborted) throw abortErrorOf(ctx.signal);
    const first = candidates[0];
    const baseSignals: RankSignals = { pEscape: null, pMax: null, maxNoul: null, choiceFlags: null, noulFlags: null, chunks: 0, excludedUnchanged: 0, duplicatesFolded: 0, optionsAsked: 0 };
    if (first === undefined) {
      return { ranked: [], escapeProbability: 1, fixProbablyAbsent: true, method: 'choice', requests: 0, signals: baseSignals };
    }
    const site = first.site;
    const mode = rankMode(site);
    const { uniques, excludedUnchanged, duplicatesFolded } = prepare(candidates, site);
    const signals: RankSignals = { ...baseSignals, excludedUnchanged, duplicatesFolded, optionsAsked: uniques.length };
    if (uniques.length === 0) {
      // Nothing Jev could pick: every candidate was the current line (or a duplicate of it).
      return { ranked: [], escapeProbability: 1, fixProbablyAbsent: true, method: 'choice', requests: 0, signals };
    }
    const cands = uniques.map((u) => u.candidate);

    // ---- N ≤ choiceMax: one Choice ------------------------------------------------------
    if (uniques.length <= choiceMax) {
      uniques.forEach((u, i) => (u.key = candidateKey(i)));
      const keys = uniques.map((u) => u.key);
      const state = buildRankState(cands, keys, site, ctx, { withCandidates: false });
      const questions = { [CHOICE_QUESTION_ID]: buildChoiceQuestion(cands, keys, mode) };
      const answers = await askAbortable(ctx.ask, stage, state, questions, ctx.signal);
      const { probabilities } = choiceAnswer(answers, CHOICE_QUESTION_ID);
      const pEscape = prob(probabilities, ESCAPE_KEY);
      const pMax = maxNonEscape(probabilities);
      const flagged = choiceFlagsAbsent(pEscape, pMax);
      const ordered = orderBy(uniques, (u) => prob(probabilities, u.key));
      return {
        ranked: expand(ordered, (u) => prob(probabilities, u.key), (u) => ({ choiceProbability: prob(probabilities, u.key) })),
        escapeProbability: pEscape,
        fixProbablyAbsent: flagged,
        method: 'choice',
        requests: 1,
        signals: { ...signals, pEscape, pMax, choiceFlags: flagged },
      };
    }

    // ---- choiceMax < N ≤ hybridMax: Choice + compact Nouls in one request ---------------
    if (uniques.length <= hybridMax) {
      uniques.forEach((u, i) => (u.key = candidateKey(i)));
      const keys = uniques.map((u) => u.key);
      const state = buildRankState(cands, keys, site, ctx, { withCandidates: true });
      const questions: Record<string, Question> = { ...buildCompactNouls(keys, mode), [CHOICE_QUESTION_ID]: buildChoiceQuestion(cands, keys, mode) };
      const answers = await askAbortable(ctx.ask, stage, state, questions, ctx.signal);
      const { probabilities } = choiceAnswer(answers, CHOICE_QUESTION_ID);
      const nouls = new Map<string, number>(keys.map((k) => [k, noulAnswer(answers, k)]));
      const noulOf = (u: Unique): number => nouls.get(u.key) ?? 0;
      const pEscape = prob(probabilities, ESCAPE_KEY);
      const pMax = maxNonEscape(probabilities);
      const maxNoul = Math.max(0, ...nouls.values());
      const choiceFlags = choiceFlagsAbsent(pEscape, pMax);
      const noulFlags = noulsFlagAbsent(maxNoul);
      // Ranked by the absolute Noul (the better selector above ~10 candidates); the relative
      // Choice breaks ties and carries the escape. Either detector firing flags the set: a
      // false alarm costs one widened enumeration, a miss costs several failed test runs.
      const ordered = orderBy(uniques, noulOf, (u) => prob(probabilities, u.key));
      return {
        ranked: expand(ordered, noulOf, (u) => ({ noulProbability: noulOf(u), choiceProbability: prob(probabilities, u.key) })),
        escapeProbability: pEscape,
        fixProbablyAbsent: choiceFlags || noulFlags,
        method: 'nouls',
        requests: 1,
        signals: { ...signals, pEscape, pMax, maxNoul, choiceFlags, noulFlags, chunks: 1 },
      };
    }

    // ---- N > hybridMax: chunked compact Nouls, then a Choice over the shortlist ----------
    const sizes = chunkSizes(uniques.length, effectiveChunkMax(site, chunkMax));
    const chunks: Unique[][] = [];
    let offset = 0;
    for (const size of sizes) {
      chunks.push(uniques.slice(offset, offset + size));
      offset += size;
    }
    const nouls = new Map<Unique, number>();
    // Keys restart per request: each chunk is its own state with its own `candidates` map.
    const stageOne = chunks.map((chunk) => async (): Promise<void> => {
      chunk.forEach((u, i) => (u.key = candidateKey(i)));
      const keys = chunk.map((u) => u.key);
      const state = buildRankState(chunk.map((u) => u.candidate), keys, site, ctx, { withCandidates: true });
      const answers = await askAbortable(ctx.ask, stage, state, buildCompactNouls(keys, mode), ctx.signal);
      chunk.forEach((u) => nouls.set(u, noulAnswer(answers, u.key)));
    });
    await runPool(stageOne, concurrency);
    const noulOf = (u: Unique): number => nouls.get(u) ?? 0;
    const maxNoul = Math.max(0, ...nouls.values());
    // Noul probabilities are absolute judgments, so merging chunks is a plain sort.
    const byNoul = orderBy(uniques, noulOf);
    const shortlist = byNoul.slice(0, Math.min(shortlistSize, byNoul.length));
    const rest = byNoul.slice(shortlist.length);

    const shortKeys = shortlist.map((_, i) => candidateKey(i));
    const stageTwoState = buildRankState(shortlist.map((u) => u.candidate), shortKeys, site, ctx, { withCandidates: false });
    const stageTwoAnswers = await askAbortable(ctx.ask, stage, stageTwoState, { [CHOICE_QUESTION_ID]: buildChoiceQuestion(shortlist.map((u) => u.candidate), shortKeys, mode) }, ctx.signal);
    const { probabilities } = choiceAnswer(stageTwoAnswers, CHOICE_QUESTION_ID);
    const choiceP = new Map<Unique, number>(shortlist.map((u, i) => [u, prob(probabilities, shortKeys[i] ?? '')]));
    const pEscape = prob(probabilities, ESCAPE_KEY);
    const pMax = maxNonEscape(probabilities);
    const choiceFlags = choiceFlagsAbsent(pEscape, pMax);
    const noulFlags = noulsFlagAbsent(maxNoul);
    const orderedShortlist = orderBy(shortlist, (u) => choiceP.get(u) ?? 0, noulOf);
    // Shortlisted candidates carry the Choice probability (the decision that ordered them);
    // everything below the shortlist keeps its Noul, which is what ordered it.
    const rankedShortlist = expand(orderedShortlist, (u) => choiceP.get(u) ?? 0, (u) => ({ noulProbability: noulOf(u), choiceProbability: choiceP.get(u) ?? 0 }));
    const rankedRest = expand(rest, noulOf, (u) => ({ noulProbability: noulOf(u) }));
    rankedRest.forEach((r) => (r.rank += rankedShortlist.length));
    return {
      ranked: [...rankedShortlist, ...rankedRest],
      escapeProbability: pEscape,
      fixProbablyAbsent: choiceFlags || noulFlags,
      method: 'two_stage',
      requests: chunks.length + 1,
      signals: { ...signals, pEscape, pMax, maxNoul, choiceFlags, noulFlags, chunks: chunks.length },
    };
  }

  return { rank };
}

// ---------------------------------------------------------------------------------------
// Shuffle-and-average re-ask of a shortlist (design Q10r)
// ---------------------------------------------------------------------------------------

/** The probability a re-rank averages against: the Noul when one was asked, else the ranked probability. */
function baseProbability(r: RankedCandidateDetail): number {
  return r.noulProbability ?? r.probability;
}

/**
 * True when the shortlist is worth one more request before a test run: the oracle is slow
 * (`tRunMs` > 20 s) and the top-2 base probabilities are within the measured order-noise band.
 */
export function shouldShuffleRerank(ranked: readonly RankedCandidateDetail[], tRunMs: number): boolean {
  if (tRunMs <= SHUFFLE_RERANK_MIN_T_RUN_MS) return false;
  const [a, b] = ranked;
  if (a === undefined || b === undefined) return false;
  return baseProbability(a) - baseProbability(b) < SHUFFLE_RERANK_MARGIN;
}

/** FNV-1a over a string, for a deterministic shuffle seed. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: a small deterministic PRNG so a re-ask reproduces under `--resume` and in tests. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A permutation of 0..n-1 that differs from the identity whenever n ≥ 2 (a re-ask in the same order measures nothing). */
export function shuffledOrder(n: number, seed: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  const rnd = prng(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  if (n >= 2 && order.every((v, i) => v === i)) order.push(order.shift()!);
  return order;
}

export interface ShuffleRerankOptions {
  stage?: StageName;
  /** shuffle seed; defaults to a hash of the shortlist's candidate ids */
  seed?: number;
}

export interface ShuffleRerankResult {
  /** the shortlist re-ordered by the averaged probability (ties keep the incoming order) */
  ranked: RankedCandidateDetail[];
  /** p from the shuffled request, by candidate id */
  reaskedProbability: Record<string, number>;
  requests: number;
}

/**
 * Re-ask the compact Nouls over `shortlist` (≤ 10, same site) with the candidates shuffled and
 * re-keyed, and average each candidate's re-asked p with the p it already carries. Ordering
 * only: the tests still decide. Returns the shortlist untouched (0 requests) when it has fewer
 * than two entries.
 */
export async function shuffleRerank(shortlist: readonly RankedCandidateDetail[], ctx: RankContext, options: ShuffleRerankOptions = {}): Promise<ShuffleRerankResult> {
  if (shortlist.length > SHUFFLE_RERANK_MAX) throw new RangeError(`shuffleRerank: shortlist of ${shortlist.length} exceeds ${SHUFFLE_RERANK_MAX}`);
  if (shortlist.length < 2) return { ranked: [...shortlist], reaskedProbability: {}, requests: 0 };
  const first = shortlist[0]!;
  const site = first.candidate.site;
  for (const r of shortlist) if (!sameSite(r.candidate.site, site)) throw new RangeError(`shuffleRerank: ${r.candidate.source} candidate "${r.candidate.id}" is at ${r.candidate.site.file.path}:${r.candidate.site.line} (${r.candidate.site.kind}), not at the shortlist's site (${site.file.path}:${site.line}, ${site.kind})`);
  const seed = options.seed ?? fnv1a(shortlist.map((r) => r.candidate.id).join('\u0000'));
  const order = shuffledOrder(shortlist.length, seed);
  const shuffled = order.map((i) => shortlist[i]!);
  const keys = shuffled.map((_, i) => candidateKey(i));
  const mode = rankMode(site);
  const state = buildRankState(shuffled.map((r) => r.candidate), keys, site, ctx, { withCandidates: true });
  const answers = await askAbortable(ctx.ask, options.stage ?? 'propose', state, buildCompactNouls(keys, mode), ctx.signal);
  const reasked: Record<string, number> = {};
  shuffled.forEach((r, i) => {
    reasked[r.candidate.id] = noulAnswer(answers, keys[i]!);
  });
  const averaged = shortlist.map((r, index) => {
    const p = (baseProbability(r) + (reasked[r.candidate.id] ?? 0)) / 2;
    const row: RankedCandidateDetail = { ...r, probability: p, noulProbability: p };
    return { index, row };
  });
  const ordered = orderBy(averaged, (x) => x.row.probability).map((x, k) => ({ ...x.row, rank: k + 1 }));
  return { ranked: ordered, reaskedProbability: reasked, requests: 1 };
}
