/**
 * Grammar-guided token beam: build a fix line as a path of next-token Choices. Code offers only
 * the tokens legal for each prefix (grammar.ts) from the site vocabulary (vocab.ts); Jev picks;
 * the beam keeps the W best prefixes by Σ log p and returns the W best distinct complete lines.
 * Tests decide which one is right (Σ log p prefers short lines; probe §7.4).
 *
 * Measured (probe-token-synthesis.md §3, §7.5): W=3 + grammar filter reconstructs 20/40 fix
 * lines at $0.0037 and 3.3 s per line; positions with p(top) ≥ 0.9 were right 99 %, so a
 * confident position expands one option and an unsure one expands W. All live hypotheses of a
 * depth go in ONE request as independent questions (REPORT §7) so a depth costs one round trip.
 */
import type { Answer, Json, Question, StageName } from '../../../core/types.js';
import { AbortError, JevCodeError } from '../../../errors.js';
import { ESCAPE_KEY, choice } from '../../../jev/questions.js';
import type { BeamResult, FailureView, JevAsk, Site } from '../types.js';
import { END, legalNext, lineKindOf } from './grammar.js';
import type { LineKind } from './grammar.js';
import { HYPOTHESES_KEY, baseState, hypothesisKey, nextTokenQuestion } from './state.js';
import { detokenize, sameTokens, tokenKeyText, toks } from './tokens.js';
import type { Tok } from './tokens.js';
import { END_DESCRIPTION, END_KEY } from './vocab.js';
import type { Vocabulary } from './vocab.js';

/** Every synthesizer question is a propose-stage decision in the engine's records. */
export const BEAM_STAGE: StageName = 'propose';

export class BeamError extends JevCodeError {
  constructor(message: string) {
    super('internal', `BeamError: ${message}`);
  }
}

export interface BeamRunOptions {
  width: number;
  maxTokens: number;
  confidentExpandThreshold: number;
  /** Requests this run may spend; the run stops (keeping what it completed) when reached. */
  maxRequests: number;
  signal: AbortSignal;
}

export interface BeamTask {
  task: string;
  failures: readonly FailureView[];
}

export interface Hypothesis {
  toks: Tok[];
  logProb: number;
}

export interface TokenBeamOutcome extends BeamResult {
  /** Hypotheses still open when `maxTokens` was reached (none with the grammar filter, measured). */
  truncated: number;
  /** Highest P(none_of_these) seen at any position: a vocabulary-coverage signal for the controller. */
  maxEscapeProbability: number;
}

/** Throw the project's AbortError (with the signal's reason as cause) when the signal fired. */
export function checkAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const err = new AbortError('signal');
  Object.defineProperty(err, 'cause', { value: signal.reason, enumerable: false });
  throw err;
}

/** Line kind the grammar enforces at a site. */
export function siteLineKind(site: Site): LineKind {
  return site.kind === 'insert' ? 'simple' : lineKindOf(site.currentLine);
}

/** Options legal after `prefix`: vocabulary tokens that pass the grammar, plus END when the line may end. */
export function filterOptions(vocab: Vocabulary, prefix: readonly Tok[], kind: LineKind): Record<string, Json> {
  const ok = legalNext(prefix, kind);
  const out: Record<string, Json> = {};
  for (const v of vocab.tokens) if (ok(v.tok, v.attributeOnly)) out[v.key] = v.description;
  if (ok(END)) out[END_KEY] = END_DESCRIPTION;
  return out;
}

/** Options by probability, best first; ties broken by key so runs are reproducible. */
export function rankedOptions(answer: Extract<Answer, { type: 'choice' }>): [string, number][] {
  return Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** How many options to expand at a position (probe §7.5: ≥ 0.9 right 99 %, expand 1; else W). */
export function expansionCount(pTop: number, threshold: number, width: number): number {
  return pTop >= threshold ? 1 : width;
}

function expectChoice(answers: Record<string, Answer>, id: string): Extract<Answer, { type: 'choice' }> {
  const a = answers[id];
  if (a === undefined) throw new BeamError(`missing answer for question ${id}`);
  if (a.type !== 'choice') throw new BeamError(`question ${id} answered as ${a.type}, expected choice`);
  return a;
}

/** Keep the best-scoring hypothesis per distinct token sequence. */
export function dedupeHypotheses(hs: readonly Hypothesis[]): Hypothesis[] {
  const best = new Map<string, Hypothesis>();
  for (const h of hs) {
    const k = tokenKeyText(h.toks);
    const cur = best.get(k);
    if (cur === undefined || h.logProb > cur.logProb) best.set(k, h);
  }
  return [...best.values()].sort((a, b) => b.logProb - a.logProb);
}

interface Entry {
  hyp: Hypothesis;
  questionId: string;
  options: Record<string, Json>;
}

/**
 * One request for a depth: a flat measured state when there is one live hypothesis, otherwise
 * `hypotheses.<semantic key>` per hypothesis with each question naming its own path.
 */
export function buildDepthRequest(base: Record<string, Json>, entries: readonly Entry[]): { state: Json; questions: Record<string, Question> } {
  const questions: Record<string, Question> = {};
  const state: Record<string, Json> = { ...base };
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only !== undefined) {
    state['partial_line'] = detokenize(only.hyp.toks);
    state['partial_tokens'] = only.hyp.toks.map((t) => t.text);
    questions[only.questionId] = choice(nextTokenQuestion(null), only.options);
    return { state, questions };
  }
  const hyps: Record<string, Json> = {};
  for (const e of entries) {
    const key = e.questionId.slice('next_token_'.length);
    hyps[key] = { partial_line: detokenize(e.hyp.toks), partial_tokens: e.hyp.toks.map((t) => t.text) };
    questions[e.questionId] = choice(nextTokenQuestion(key), e.options);
  }
  state[HYPOTHESES_KEY] = hyps;
  return { state, questions };
}

/** Run the beam at a site. Never calls tests; never expands `none_of_these`; never returns the current line. */
export async function runTokenBeam(ask: JevAsk, site: Site, vocab: Vocabulary, task: BeamTask, opts: BeamRunOptions): Promise<TokenBeamOutcome> {
  const kind = siteLineKind(site);
  const current = toks(site.currentLine);
  const base = baseState(site, task.task, task.failures);
  let live: Hypothesis[] = [{ toks: [], logProb: 0 }];
  const completed: Hypothesis[] = [];
  let requests = 0;
  let truncated = 0;
  let maxEscape = 0;

  for (let depth = 0; depth < opts.maxTokens && live.length > 0; depth++) {
    checkAborted(opts.signal);
    if (completed.length >= opts.width) {
      // Σ log p only decreases along a path: once W completed lines beat every live prefix, stop.
      const bar = [...completed].sort((a, b) => b.logProb - a.logProb)[opts.width - 1]!.logProb;
      if (Math.max(...live.map((h) => h.logProb)) < bar) break;
    }
    if (requests >= opts.maxRequests) break;

    const taken = new Set<string>();
    const entries: Entry[] = [];
    for (const hyp of live) {
      const options = filterOptions(vocab, hyp.toks, kind);
      if (Object.keys(options).length === 0) continue; // dead prefix: nothing legal can follow
      const questionId = live.length === 1 ? 'next_token' : `next_token_${hypothesisKey('prefix', detokenize(hyp.toks), taken)}`;
      entries.push({ hyp, questionId, options });
    }
    if (entries.length === 0) break;

    const { state, questions } = buildDepthRequest(base, entries);
    const res = await ask(BEAM_STAGE, state, questions);
    requests++;

    const expansions: Hypothesis[] = [];
    for (const e of entries) {
      const answer = expectChoice(res.answers, e.questionId);
      maxEscape = Math.max(maxEscape, answer.probabilities[ESCAPE_KEY] ?? 0);
      const ranked = rankedOptions(answer);
      const top = ranked.find(([k, p]) => k !== ESCAPE_KEY && p > 0);
      if (top === undefined) continue;
      const limit = expansionCount(top[1], opts.confidentExpandThreshold, opts.width);
      let n = 0;
      for (const [key, p] of ranked) {
        if (n >= limit) break;
        if (key === ESCAPE_KEY || p <= 0) continue;
        n++;
        const logProb = e.hyp.logProb + Math.log(p);
        if (key === END_KEY) {
          // Jev closing on the unchanged buggy line is a measured failure mode (anchoring, probe
          // §3); it consumes its expansion slot but never counts as a completed line, so it cannot
          // raise the pruning bar and stop the beam before W real lines exist.
          if (!sameTokens(e.hyp.toks, current)) completed.push({ toks: e.hyp.toks, logProb });
          continue;
        }
        const v = vocab.byKey.get(key);
        if (v === undefined) throw new BeamError(`answer names an option not offered: ${key}`);
        expansions.push({ toks: [...e.hyp.toks, v.tok], logProb });
      }
    }
    live = dedupeHypotheses(expansions).slice(0, opts.width);
    if (depth === opts.maxTokens - 1) truncated = live.length;
  }

  const lines = dedupeHypotheses(completed)
    .filter((h) => h.toks.length > 0)
    .slice(0, opts.width)
    .map((h) => ({ text: site.indent + detokenize(h.toks), logProb: h.logProb }));
  return { lines, requests, truncated, maxEscapeProbability: maxEscape };
}
