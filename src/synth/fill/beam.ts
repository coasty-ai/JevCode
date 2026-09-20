/**
 * Slot beam over holed sketch hypotheses (docs/JEV-ONLY-DESIGN.md §3 source 5, §6
 * `fill/beam.ts`; measured in experiments/results/lit-guided-synthesis.md §5): every kept sketch
 * is filled left to right, one Q13 prefix-mode Choice per hole, all K × B live items of a depth
 * as independent questions in ONE request (REPORT §7). A position with p(top) ≥ 0.9 expands one
 * option, any other expands B = 3 (probe-token-synthesis §7.5: ≥ 0.9 right 99 %); partials pass
 * the tokenizer gate; same-family identifier pairs are permuted in code (probe-donor §6); the
 * complete lines come back as Candidates ordered by Σ log p, which orders test runs and nothing
 * else — the controller re-ranks them concretely (Q9) and the tests decide.
 *
 * Measured: slots 90–93 % top-1; S2 diff-fill 23/25 lines (92 %) at B = 3 (the shape known,
 * holes only where the fix differs), S1 full-fill 22/29 (76 %); 1.7 requests per S2 line.
 */
import type { Answer, Json, Question, StageName } from '../../core/types.js';
import { JevCodeError } from '../../errors.js';
import { ESCAPE_KEY, assertQuestionBatch, choice } from '../../jev/questions.js';
import { checkAborted, expansionCount, rankedOptions } from '../beam/beam.js';
import { detokenize, sameTokens, toks } from '../beam/tokens.js';
import type { Tok } from '../beam/tokens.js';
import { isFamilyPair } from '../donor/names.js';
import { indentOf } from '../py/edits.js';
import type { SketchHypothesis } from '../search/types.js';
import { hypothesisToks, isHoleText } from '../sketch/productions.js';
import type { Candidate, EnumerateOptions, FailureView, JevAsk, LineEdit, Site } from '../types.js';
import { HYPOTHESES_KEY, LATER_MARK, buildSlotVocabulary, compileGate, fillBaseState, hypothesisKeyAt, partialLine, slotClassAt, slotOptionsFor, slotQuestion } from './state.js';
import type { SlotOption, SlotVocabulary } from './state.js';

/** Beam width B (lit-guided §5.3: B = 3 gives 92 % S2 / 76 % S1; B = 5 adds ≤ 2 lines for 5/3 the options). */
export const DEFAULT_FILL_WIDTH = 3;
/** Expand one option when p(top) ≥ this (probe-token-synthesis §7.5: right 99 %). */
export const CONFIDENT_EXPAND_THRESHOLD = 0.9;
/** Slot requests per site (design §2.3 SKETCH phase: "≤ 12 slot requests per site"; 35/36 fixed lines have ≤ 10 slots). */
export const DEFAULT_MAX_FILL_REQUESTS = 12;
/** K × B live items per request (K ≤ 5 sketches × B = 3). */
export const MAX_ITEMS_PER_REQUEST = 15;
/** Family-pair permutations added per complete line (probe-donor §6: `i`/`j`, `a`/`b` pairs). */
export const MAX_PERMUTATIONS_PER_LINE = 3;
/** Σ log p handicap of a permuted line against the line Jev filled: ordering only (ln 2 = "half as likely"). */
export const PERMUTATION_LOG_PENALTY = Math.LN2;
/** Every synthesizer question is a propose-stage decision in the engine's records. */
export const FILL_STAGE: StageName = 'propose';

export class FillError extends JevCodeError {
  constructor(message: string) {
    super('internal', `FillError: ${message}`);
  }
}

export interface FillContext {
  site: Site;
  task: string;
  failures: readonly FailureView[];
  enumerate: EnumerateOptions;
  signal: AbortSignal;
  /** requests this fill may spend (default 12); unfinished items are dropped when reached */
  maxRequests?: number;
  width?: number;
  confidentExpandThreshold?: number;
  stage?: StageName;
}

/** A complete line produced by the fill, with the hypothesis it came from (`logP` = Σ log p over its slots). */
export interface FilledLine {
  hypothesis: SketchHypothesis;
  candidate: Candidate;
  /** the beam permuted two same-family identifiers of a filled line to make this one */
  permuted: boolean;
}

export interface FillOutcome {
  /** complete lines as Candidates, best Σ log p first (source 'template', op `sketch_<Pn>`) */
  candidates: Candidate[];
  lines: FilledLine[];
  requests: number;
  /** live items dropped because the request budget ran out */
  truncated: number;
  /** items dropped by the compile gate */
  gated: number;
  /** highest P(none_of_these) seen at any slot: a vocabulary-coverage signal for the controller */
  maxEscapeProbability: number;
}

// ---------------------------------------------------------------------------------------
// Items: a hypothesis with its lines (site line + extra edits) and the slots left to fill
// ---------------------------------------------------------------------------------------

interface Slot {
  line: number;
  index: number;
}

interface Item {
  hyp: SketchHypothesis;
  /** which kept hypothesis this item descends from (the beam keeps B per hypothesis) */
  origin: number;
  /** line 0 is the site line; lines 1… are the extra edits' texts */
  lines: Tok[][];
  slots: Slot[];
  next: number;
  logP: number;
}

function slotsOf(lines: readonly Tok[][]): Slot[] {
  const out: Slot[] = [];
  lines.forEach((line, l) => line.forEach((t, i) => {
    if (isHoleText(t.text)) out.push({ line: l, index: i });
  }));
  return out;
}

function itemOf(hyp: SketchHypothesis, origin: number): Item {
  const lines: Tok[][] = [hypothesisToks(hyp.toks), ...(hyp.extraEdits ?? []).map((e) => toks(e.text ?? ''))];
  return { hyp, origin, lines, slots: slotsOf(lines), next: 0, logP: 0 };
}

function tokenKey(item: Item): string {
  return item.lines.map((l) => l.map((t) => t.text).join('\u0000')).join('\u0001');
}

/**
 * The partial view Jev sees for an item's next slot: the site line, then any body lines (P12) at
 * their indentation relative to the site, joined by newlines; the slot is `<HOLE>`, every other
 * unfilled hole `?`.
 */
function partialView(item: Item): string {
  const slot = item.slots[item.next];
  const laterOnly = (l: readonly Tok[]): string => detokenize(l.map((t) => (isHoleText(t.text) ? { text: LATER_MARK, cls: 'identifier' } : t)));
  return item.lines
    .map((l, i) => {
      const relative = i === 0 ? '' : indentOf(item.hyp.extraEdits?.[i - 1]?.text ?? '').slice(item.hyp.site.indent.length);
      const body = slot !== undefined && i === slot.line ? partialLine(l, slot.index) : laterOnly(l);
      return `${relative}${body}`;
    })
    .join('\n');
}

function expectChoice(answers: Record<string, Answer>, id: string): Extract<Answer, { type: 'choice' }> {
  const a = answers[id];
  if (a === undefined) throw new FillError(`missing answer for question ${id}`);
  if (a.type !== 'choice') throw new FillError(`question ${id} answered as ${a.type}, expected choice`);
  return a;
}

// ---------------------------------------------------------------------------------------
// Completion → Candidate
// ---------------------------------------------------------------------------------------

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function extraEditsOf(hyp: SketchHypothesis, lines: readonly Tok[][]): LineEdit[] | undefined {
  const extras = hyp.extraEdits;
  if (extras === undefined || extras.length === 0) return undefined;
  return extras.map((e, k) => {
    const filled = lines[k + 1];
    if (filled === undefined) return { ...e };
    return { ...e, text: indentOf(e.text ?? '') + detokenize(filled) };
  });
}

function toCandidate(site: Site, hyp: SketchHypothesis, lines: readonly Tok[][], permuted: boolean): Candidate {
  const text = site.indent + detokenize(lines[0] ?? []);
  const extraEdits = extraEditsOf(hyp, lines);
  const op = `sketch_${hyp.production}${permuted ? '_perm' : ''}`;
  const c: Candidate = {
    id: `sketch:${hyp.production}:${fnv1a(`${site.file.path}:${site.line}:${site.kind}:${text}:${(extraEdits ?? []).map((e) => e.text ?? '').join('|')}`)}`,
    site,
    text,
    source: 'template',
    op,
    prior: Math.max(0, Math.min(1, hyp.pSketch)),
  };
  if (extraEdits !== undefined) c.extraEdits = extraEdits;
  return c;
}

/**
 * Same-family permutations of a complete site line: for every pair of distinct identifiers that
 * `isFamilyPair` accepts and of which at least one was filled by the beam, swap the two names
 * everywhere on the line. Bounded, deterministic, and marked `_perm` so the trace can tell.
 */
export function familyPermutations(line: readonly Tok[], filledIndices: readonly number[], site: Site): Tok[][] {
  const filled = new Set(filledIndices.map((i) => line[i]?.text).filter((t): t is string => t !== undefined));
  const names: string[] = [];
  line.forEach((t, i) => {
    if (t.cls === 'identifier' && line[i - 1]?.text !== '.' && !names.includes(t.text)) names.push(t.text);
  });
  const out: Tok[][] = [];
  for (let i = 0; i < names.length && out.length < MAX_PERMUTATIONS_PER_LINE; i++) {
    for (let j = i + 1; j < names.length && out.length < MAX_PERMUTATIONS_PER_LINE; j++) {
      const a = names[i]!;
      const b = names[j]!;
      if (!(filled.has(a) || filled.has(b)) || !isFamilyPair(a, b, site.scope)) continue;
      const swapped = line.map((t, k) => (t.cls === 'identifier' && line[k - 1]?.text !== '.' ? (t.text === a ? { text: b, cls: 'identifier' as const } : t.text === b ? { text: a, cls: 'identifier' as const } : t) : t));
      if (!sameTokens(swapped, line)) out.push(swapped);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The beam
// ---------------------------------------------------------------------------------------

interface Entry {
  item: Item;
  questionId: string;
  hypothesisKey: string;
  options: Map<string, SlotOption>;
}

function buildRequest(base: Record<string, Json>, entries: readonly Entry[], siteKind: Site['kind']): { state: Json; questions: Record<string, Question> } {
  const hyps: Record<string, Json> = {};
  const questions: Record<string, Question> = {};
  for (const e of entries) {
    hyps[e.hypothesisKey] = partialView(e.item);
    const criteria: Record<string, Json> = {};
    for (const o of e.options.values()) criteria[o.key] = o.description;
    questions[e.questionId] = choice(slotQuestion(e.hypothesisKey, siteKind), criteria);
  }
  const state: Record<string, Json> = { ...base, [HYPOTHESES_KEY]: hyps };
  assertQuestionBatch(questions);
  return { state, questions };
}

/** Best-Σ log p first; ties by token key so runs are reproducible. */
function byScore(a: Item, b: Item): number {
  return b.logP - a.logP || (tokenKey(a) < tokenKey(b) ? -1 : tokenKey(a) > tokenKey(b) ? 1 : 0);
}

/** Keep the best item per distinct token sequence, then at most `width` per origin hypothesis. */
function prune(items: readonly Item[], width: number): Item[] {
  const best = new Map<string, Item>();
  for (const it of items) {
    const k = `${it.origin}\u0002${tokenKey(it)}`;
    const cur = best.get(k);
    if (cur === undefined || it.logP > cur.logP) best.set(k, it);
  }
  const perOrigin = new Map<number, number>();
  const out: Item[] = [];
  for (const it of [...best.values()].sort(byScore)) {
    const n = perOrigin.get(it.origin) ?? 0;
    if (n >= width) continue;
    perOrigin.set(it.origin, n + 1);
    out.push(it);
  }
  return out;
}

/**
 * Fill the kept hypotheses at `ctx.site`. Never calls tests; never expands `none_of_these`;
 * never returns the current line. Throws AbortError when `ctx.signal` fires between requests.
 */
export async function fillSketches(hyps: readonly SketchHypothesis[], ctx: FillContext, ask: JevAsk): Promise<FillOutcome> {
  const width = ctx.width ?? DEFAULT_FILL_WIDTH;
  const threshold = ctx.confidentExpandThreshold ?? CONFIDENT_EXPAND_THRESHOLD;
  const maxRequests = ctx.maxRequests ?? DEFAULT_MAX_FILL_REQUESTS;
  const stage = ctx.stage ?? FILL_STAGE;
  const site = ctx.site;
  const current = toks(site.currentLine);
  const vocab: SlotVocabulary = buildSlotVocabulary(site, ctx.enumerate);
  const base = fillBaseState(site, ctx.task, ctx.failures);

  let live: Item[] = [];
  const completed: Item[] = [];
  let gated = 0;
  hyps.forEach((h, origin) => {
    const item = itemOf(h, origin);
    if (!item.lines.every((l, i) => compileGate(l, site, i === 0))) {
      gated++;
      return;
    }
    (item.slots.length === 0 ? completed : live).push(item);
  });

  let requests = 0;
  let maxEscape = 0;
  let truncated = 0;
  while (live.length > 0) {
    checkAborted(ctx.signal);
    if (requests >= maxRequests) {
      // adds to the items already dropped at the per-request cap, so the trace sees every loss
      truncated += live.length;
      break;
    }
    const entries: Entry[] = [];
    const batch = live.slice(0, MAX_ITEMS_PER_REQUEST);
    truncated += live.length - batch.length;
    batch.forEach((item, i) => {
      const slot = item.slots[item.next]!;
      const line = item.lines[slot.line]!;
      const options = slotOptionsFor(slotClassAt(line, slot.index), vocab);
      if (options.length === 0) return; // nothing to offer: the item dies here
      const key = hypothesisKeyAt(i);
      entries.push({ item, questionId: `slot_${key}`, hypothesisKey: key, options: new Map(options.map((o) => [o.key, o])) });
    });
    if (entries.length === 0) break;

    const { state, questions } = buildRequest(base, entries, site.kind);
    const res = await ask(stage, state, questions);
    requests++;

    const expansions: Item[] = [];
    for (const e of entries) {
      const answer = expectChoice(res.answers, e.questionId);
      maxEscape = Math.max(maxEscape, answer.probabilities[ESCAPE_KEY] ?? 0);
      const ranked = rankedOptions(answer);
      const top = ranked.find(([k, p]) => k !== ESCAPE_KEY && p > 0);
      if (top === undefined) continue;
      const limit = expansionCount(top[1], threshold, width);
      let n = 0;
      for (const [key, p] of ranked) {
        if (n >= limit) break;
        if (key === ESCAPE_KEY || p <= 0) continue;
        const option = e.options.get(key);
        if (option === undefined) throw new FillError(`answer names an option not offered: ${key}`);
        n++;
        const slot = e.item.slots[e.item.next]!;
        const lines = e.item.lines.map((l, li) => (li === slot.line ? l.map((t, ti) => (ti === slot.index ? option.tok : t)) : l));
        if (!compileGate(lines[slot.line]!, site, slot.line === 0)) {
          gated++;
          continue;
        }
        expansions.push({ ...e.item, lines, next: e.item.next + 1, logP: e.item.logP + Math.log(p) });
      }
    }
    const kept = prune(expansions, width);
    live = [];
    for (const it of kept) (it.next >= it.slots.length ? completed : live).push(it);
  }

  // Complete lines → candidates (+ family permutations of the site line), deduped, best first.
  const lines: FilledLine[] = [];
  const seen = new Set<string>();
  const push = (item: Item, siteLine: Tok[], permuted: boolean, logP: number): void => {
    if (site.kind === 'replace' && sameTokens(siteLine, current)) return;
    const all = [siteLine, ...item.lines.slice(1)];
    const key = all.map((l) => l.map((t) => t.text).join('\u0000')).join('\u0001');
    if (seen.has(key)) return;
    seen.add(key);
    const hypothesis: SketchHypothesis = { ...item.hyp, toks: siteLine.map((t) => t.text), holes: [], logP };
    lines.push({ hypothesis, candidate: toCandidate(site, hypothesis, all, permuted), permuted });
  };
  for (const item of completed.sort(byScore)) {
    const siteLine = item.lines[0] ?? [];
    push(item, siteLine, false, item.logP);
    const filledIndices = item.slots.filter((s) => s.line === 0).map((s) => s.index);
    for (const swapped of familyPermutations(siteLine, filledIndices, site)) push(item, swapped, true, item.logP - PERMUTATION_LOG_PENALTY);
  }
  lines.sort((a, b) => b.hypothesis.logP - a.hypothesis.logP || b.hypothesis.pSketch - a.hypothesis.pSketch || (a.candidate.text < b.candidate.text ? -1 : a.candidate.text > b.candidate.text ? 1 : 0));
  return { candidates: lines.map((l) => l.candidate), lines, requests, truncated, gated, maxEscapeProbability: maxEscape };
}
