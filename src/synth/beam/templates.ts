/**
 * Template → slot route (probe-token-synthesis.md §4): mask every identifier/literal of the
 * current line, of its mutants and of near-duplicate donor lines to `_`; one Choice over the
 * shapes (paired with a Noul "is `buggy_line` already correct", because the escape option
 * alone missed 18/23 wrong pools); then fill slots sequentially, one Choice per slot with
 * earlier slots filled (35/40 exact on the true template, 3 better than parallel). The route
 * costs ~8 requests and $0.0010 per line when the pool covers the fix, so it runs first.
 *
 * Several templates are filled side by side: request k fills slot k of every chosen template,
 * each question naming its own `hypotheses.<shape key>` (REPORT §7, §14).
 */
import type { Answer, Json, Question } from '../../core/types.js';
import { ESCAPE_KEY, choice } from '../../jev/questions.js';
import { nearDuplicates } from '../py/index.js';
import type { PyModule } from '../py/index.js';
import type { BeamResult, EnumerateOptions, Site } from '../types.js';
import type { JevAsk } from '../types.js';
import { BEAM_STAGE, BeamError, checkAborted, rankedOptions } from './beam.js';
import type { BeamRunOptions, BeamTask } from './beam.js';
import { CURRENT_LINE_CORRECT_ID, HYPOTHESES_KEY, TEMPLATE_QUESTION, baseState, buggyLine, currentLineCorrectNoul, slotQuestion } from './state.js';
import { OP_NAMES, detokenize, sameTokens, toks } from './tokens.js';
import type { Tok } from './tokens.js';
import { slotTokens } from './vocab.js';
import type { VocabToken, Vocabulary } from './vocab.js';

export const SLOT = '_';
const SLOT_TOK: Tok = { text: SLOT, cls: 'identifier' };
export const MAX_TEMPLATES = 40;
/** Normalised-token similarity a donor line needs to enter the pool (levenshtein on ID/NUM/STR-normalised tokens). */
export const DONOR_THRESHOLD = 0.5;
export const MAX_CORPUS_DONORS = 20;
/** Template keys are snake_case ≤ 64 chars (questions.ts KEY_SHAPE). */
const KEY_MAX = 60;

export interface TemplateEntry {
  key: string;
  toks: Tok[];
  text: string;
  /** `buggy_line`, `mutant_of_buggy_line`, `<path>:<line>` for donors. */
  source: string;
  slots: number;
}

export function isSlotTok(t: Tok): boolean {
  return t.cls === 'identifier' || t.cls === 'number' || t.cls === 'string' || t.cls === 'literal';
}

/** The shape of a line: identifiers and literals become `_`; keywords, operators and punctuation stay. */
export function templateOf(ts: readonly Tok[]): Tok[] {
  return ts.map((t) => (isSlotTok(t) ? SLOT_TOK : t));
}

export function templateText(tpl: readonly Tok[]): string {
  return detokenize(tpl);
}

/** `shape_return_x_open_paren_x_comma_x_modulo_x_close_paren`: the shape spelled out (measured key style). */
export function templateKey(tpl: readonly Tok[]): string {
  const parts = tpl.map((t) => {
    if (t.text === SLOT) return 'x';
    if (t.cls === 'keyword' || t.cls === 'literal') return t.text.toLowerCase();
    const named = OP_NAMES[t.text];
    return named !== undefined ? named[0].replace(/^(op|punct)_/, '') : 'sym';
  });
  return `shape_${parts.join('_')}`.slice(0, KEY_MAX).replace(/_+$/, '');
}

/** First-order mutations of a line (anchor-probe list): operator swaps, ±1, any↔all, argument swap. */
export const MUTATIONS: readonly (readonly [RegExp, string])[] = [
  [/<=/g, '<'], [/>=/g, '>'], [/(?<![<>=!])<(?!=)/g, '<='], [/(?<![<>=!])>(?!=)/g, '>='], [/==/g, '!='], [/!=/g, '=='],
  [/\+ 1\b/g, '- 1'], [/- 1\b/g, '+ 1'], [/\band\b/g, 'or'], [/\bor\b/g, 'and'], [/\+/g, '-'], [/(?<!\*)\*(?!\*)/g, '/'],
  [/\bTrue\b/g, 'False'], [/\bnot /g, ''], [/\[0\]/g, '[-1]'], [/\/\//g, '/'], [/(?<!\/)\/(?!\/)/g, '//'], [/\^=/g, '&='], [/\bany\b/g, 'all'],
];

export function mutants(line: string): string[] {
  const out = new Set<string>();
  for (const [re, rep] of MUTATIONS) {
    const m = line.replace(re, rep);
    if (m !== line) out.add(m);
  }
  const swapped = line.replace(/\(([^(),]+), ([^(),]+)\)/, '($2, $1)');
  if (swapped !== line) out.add(swapped);
  return [...out];
}

/**
 * Statements of a file that can serve as donors: single-line statements that are not def/class
 * headers, decorators or docstrings. Physical lines of multi-line statements and docstring
 * continuation lines are skipped: their shapes (`_ : _ _ _`, `_[_, _],`) can never be a whole
 * fix line and would crowd real donors out of the capped pool.
 */
function donorLines(mod: PyModule): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  for (const s of mod.statements) {
    if (s.startLine !== s.endLine || s.tokens.length === 0) continue;
    if (s.kind === 'def' || s.kind === 'class' || s.kind === 'decorator') continue;
    if (s.tokens.length === 1 && s.tokens[0]!.type === 'STRING') continue;
    out.push({ line: s.startLine, text: s.text.trim() });
  }
  return out;
}

class Pool {
  readonly entries: TemplateEntry[] = [];
  private readonly seen = new Set<string>();
  private readonly keys = new Set<string>();
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  push(line: string, source: string): void {
    if (this.entries.length >= this.max) return;
    const tpl = templateOf(toks(line));
    if (tpl.length === 0) return;
    const text = templateText(tpl);
    if (this.seen.has(text)) return;
    this.seen.add(text);
    const base = templateKey(tpl);
    let key = base;
    let n = 2;
    while (this.keys.has(key)) key = `${base.slice(0, KEY_MAX - 4)}_${n++}`;
    this.keys.add(key);
    this.entries.push({ key, toks: tpl, text, source, slots: tpl.filter((t) => t.text === SLOT).length });
  }
}

/**
 * Template pool for a site: the current line's shape, its mutants' shapes, then donor shapes
 * from the enclosing block, the rest of the file (near-duplicates first) and the corpus
 * (near-duplicates only). Deduplicated by shape, capped, deterministic.
 */
export function templatePool(site: Site, opts: EnumerateOptions, max = MAX_TEMPLATES): TemplateEntry[] {
  const pool = new Pool(max);
  const current = buggyLine(site);
  if (current !== null) {
    pool.push(current, 'buggy_line');
    for (const m of mutants(current)) pool.push(m, 'mutant_of_buggy_line');
  }
  // the line being replaced is the buggy line, not a donor; an insert site's anchor line still is one
  const own = donorLines(site.file.mod).filter((d) => site.kind === 'insert' || d.line !== site.line);
  const inBlock = own.filter((d) => site.block !== null && d.line >= site.block.startLine && d.line <= site.block.endLine);
  const outside = own.filter((d) => !inBlock.includes(d));
  const near = (cands: { line: number; text: string }[]): { line: number; text: string }[] => {
    if (current === null) return [];
    return nearDuplicates(current, cands.map((c) => c.text), DONOR_THRESHOLD, { excludeExact: true }).map((d) => cands[d.index]!);
  };
  for (const d of [...near(inBlock), ...inBlock]) pool.push(d.text, `${site.file.path}:${d.line}`);
  for (const d of near(outside)) pool.push(d.text, `${site.file.path}:${d.line}`);
  if (current !== null) {
    let taken = 0;
    for (const [path, file] of opts.corpus) {
      if (path === site.file.path || taken >= MAX_CORPUS_DONORS) continue;
      for (const d of near(donorLines(file.mod))) {
        if (taken >= MAX_CORPUS_DONORS) break;
        pool.push(d.text, `${path}:${d.line}`);
        taken++;
      }
    }
  }
  return pool.entries;
}

/** Render a template with the slots filled so far; the rest show as `<SLOT_n>` (1-based). */
export function fillText(tpl: readonly Tok[], fills: readonly Tok[]): string {
  let k = 0;
  return detokenize(tpl.map((t) => (t.text === SLOT ? (fills[k++] ?? { text: `<SLOT_${k}>`, cls: 'identifier' }) : t)));
}

/** Slot candidates legal at slot `slotIndex` of a template: names after `.`/before `(`/after binding keywords, everything otherwise. */
export function slotOptions(tpl: readonly Tok[], slotIndex: number, vocab: Vocabulary): VocabToken[] {
  let seen = -1;
  let pos = -1;
  for (let i = 0; i < tpl.length; i++) {
    if (tpl[i]!.text === SLOT && ++seen === slotIndex) {
      pos = i;
      break;
    }
  }
  const prev = pos > 0 ? tpl[pos - 1] : undefined;
  const next = tpl[pos + 1];
  const afterDot = prev?.text === '.';
  const namesOnly = afterDot || next?.text === '(' || (prev !== undefined && prev.cls === 'keyword' && ['for', 'as', 'lambda', 'def', 'global', 'nonlocal', 'import', 'class'].includes(prev.text));
  return slotTokens(vocab).filter((v) => {
    if (v.attributeOnly && !afterDot) return false;
    if (namesOnly) return v.tok.cls === 'identifier';
    return true;
  });
}

export interface TemplateOutcome extends BeamResult {
  /** P(`buggy_line` already correct) from the paired Noul, null when the site is an insert. */
  currentLineCorrectProbability: number | null;
  /** P(none_of_these) on the template Choice. */
  templateEscapeProbability: number;
  /** Shapes that were filled, best first. */
  chosenTemplates: string[];
  poolSize: number;
}

function expectChoice(answers: Record<string, Answer>, id: string): Extract<Answer, { type: 'choice' }> {
  const a = answers[id];
  if (a === undefined) throw new BeamError(`missing answer for question ${id}`);
  if (a.type !== 'choice') throw new BeamError(`question ${id} answered as ${a.type}, expected choice`);
  return a;
}

interface Filling {
  entry: TemplateEntry;
  fills: Tok[];
  logProb: number;
  alive: boolean;
}

/**
 * Template Choice (+ paired Noul) in one request, then sequential slot filling of the top
 * `width` templates batched per slot index. Returns filled lines that differ from the current line.
 */
export async function runTemplateRoute(ask: JevAsk, site: Site, vocab: Vocabulary, task: BeamTask, enumerateOpts: EnumerateOptions, opts: BeamRunOptions): Promise<TemplateOutcome> {
  const empty: TemplateOutcome = { lines: [], requests: 0, currentLineCorrectProbability: null, templateEscapeProbability: 0, chosenTemplates: [], poolSize: 0 };
  const pool = templatePool(site, enumerateOpts);
  if (pool.length === 0 || opts.maxRequests < 1) return empty;
  checkAborted(opts.signal);

  const base = baseState(site, task.task, task.failures);
  const tplOptions: Record<string, Json> = {};
  for (const e of pool) tplOptions[e.key] = { shape: e.text, from: e.source };
  const questions: Record<string, Question> = { line_shape: choice(TEMPLATE_QUESTION, tplOptions) };
  const hasCurrent = buggyLine(site) !== null;
  if (hasCurrent) questions[CURRENT_LINE_CORRECT_ID] = currentLineCorrectNoul();
  const first = await ask(BEAM_STAGE, base, questions);
  let requests = 1;

  const shapeAnswer = expectChoice(first.answers, 'line_shape');
  const noulAnswer = first.answers[CURRENT_LINE_CORRECT_ID];
  const currentLineCorrect = noulAnswer !== undefined && noulAnswer.type === 'noul' ? noulAnswer.noul : null;
  const escapeP = shapeAnswer.probabilities[ESCAPE_KEY] ?? 0;
  const byKey = new Map(pool.map((e) => [e.key, e]));
  const fillings: Filling[] = [];
  for (const [key, p] of rankedOptions(shapeAnswer)) {
    if (fillings.length >= opts.width) break;
    if (key === ESCAPE_KEY || p <= 0) continue;
    const entry = byKey.get(key);
    if (entry === undefined) throw new BeamError(`answer names a template not offered: ${key}`);
    fillings.push({ entry, fills: [], logProb: Math.log(p), alive: true });
  }

  const maxSlots = Math.max(0, ...fillings.map((f) => f.entry.slots));
  for (let k = 0; k < maxSlots; k++) {
    checkAborted(opts.signal);
    if (requests >= opts.maxRequests) {
      for (const f of fillings) if (f.entry.slots > k) f.alive = false; // out of budget: unfinished templates yield nothing
      break;
    }
    const active = fillings.filter((f) => f.alive && f.entry.slots > k);
    if (active.length === 0) break;
    const state: Record<string, Json> = { ...base };
    const qs: Record<string, Question> = {};
    const optionsFor = new Map<Filling, Map<string, VocabToken>>();
    const single = active.length === 1 ? active[0] : undefined;
    const hyps: Record<string, Json> = {};
    for (const f of active) {
      const opts_ = slotOptions(f.entry.toks, k, vocab);
      if (opts_.length === 0) {
        f.alive = false;
        continue;
      }
      const map = new Map(opts_.map((v) => [v.key, v]));
      optionsFor.set(f, map);
      const criteria: Record<string, Json> = {};
      for (const v of opts_) criteria[v.key] = v.description;
      const view: Record<string, Json> = { line_shape: f.entry.text, line_with_slots: fillText(f.entry.toks, f.fills), slot_to_fill: `<SLOT_${k + 1}>` };
      if (single !== undefined) {
        Object.assign(state, view);
        qs['slot'] = choice(slotQuestion(null), criteria);
      } else {
        hyps[f.entry.key] = view;
        qs[`slot_${f.entry.key}`] = choice(slotQuestion(f.entry.key), criteria);
      }
    }
    if (Object.keys(qs).length === 0) break;
    if (single === undefined) state[HYPOTHESES_KEY] = hyps;
    const res = await ask(BEAM_STAGE, state, qs);
    requests++;
    for (const f of active) {
      const map = optionsFor.get(f);
      if (map === undefined) continue;
      const answer = expectChoice(res.answers, single !== undefined ? 'slot' : `slot_${f.entry.key}`);
      const pick = rankedOptions(answer).find(([key, p]) => key !== ESCAPE_KEY && p > 0);
      const v = pick === undefined ? undefined : map.get(pick[0]);
      if (pick === undefined || v === undefined) {
        f.alive = false;
        continue;
      }
      f.fills.push(v.tok);
      f.logProb += Math.log(pick[1]);
    }
  }

  const current = toks(site.currentLine);
  const seen = new Set<string>();
  const lines: { text: string; logProb: number }[] = [];
  const chosen: string[] = [];
  for (const f of fillings) {
    if (!f.alive || f.fills.length !== f.entry.slots) continue;
    let n = 0;
    const filled = f.entry.toks.map((t) => (t.text === SLOT ? f.fills[n++]! : t));
    if (sameTokens(filled, current)) continue;
    const text = site.indent + detokenize(filled);
    if (seen.has(text)) continue;
    seen.add(text);
    lines.push({ text, logProb: f.logProb });
    chosen.push(f.entry.text);
  }
  lines.sort((a, b) => b.logProb - a.logProb);
  return { lines, requests, currentLineCorrectProbability: currentLineCorrect, templateEscapeProbability: escapeP, chosenTemplates: chosen, poolSize: pool.length };
}
