/**
 * `/why` blocks (TUI-DESIGN §7.6, A47, 11 §4h; jev-native's worked text is the reference rendering):
 * one `Decision` → the head line `why s7.risk.plan_mismatch  request a1b2c3d4  244ms  <model>` and a
 * ≤ 60-line body — Scores print one bar per level, argmax / E[k] / tail / bound / risk, the confidence
 * formula and the consumer; Nouls print instructions, both criteria definitions and examples, p and
 * |2p−1|; Choices print one bar per option (none_of_these included), the paired Noul beside each and
 * the resolution rule that fired. Pure; the `[ui]` label is the item's, not the block's.
 */
import { RISK_DIMENSIONS, type Decision, type Json, type StageName } from '../core/types.js';
import { choiceConfidence, levelProb, riskFromProbabilities, scoreArgmax, uniformDistance } from '../jev/confidence.js';
import { PAIRED_PREFIX } from '../jev/questions.js';
import { PAIRED_NOUL_FLOOR } from '../loop/stages/choose.js';
import { RISK_TAIL_FROM_LEVEL } from '../jev/confidence.js';
import { clip } from '../core/text.js';
import { eighthBar } from './bars.js';
import { GLYPHS, oneLineCells, padEndCells, padStartCells, type GlyphSet } from './glyphs.js';
import { p2 } from './plain.js';
import { RISK_BLOCK_THRESHOLD, RISK_REVIEW_THRESHOLD, consumerRule, criteriaText, riskDimensionMode, type DecisionThresholds } from './pane/model.js';
import { reviewRowForDigit } from './review/lines.js';
// TUI-DESIGN-2 §3.11: `/why intake` re-derives the reading from the rows in hand and names the intake's consumers
import { INTAKE_RUN_FLOOR, answersOfRows, resolveIntake } from '../chat/intake.js';
import { FACT_QUESTION_PREFIX, FACT_SELECT_FLOOR } from '../chat/facts.js';

/** §7.6: a `/why` item's `detail` is ≤ 60 lines. */
export const WHY_MAX_LINES = 60;
/** Instructions and criteria texts are clipped to one line of this many characters. */
const WHY_TEXT_CHARS = 160;
/** Two-decimal wire probabilities: the noise floor quoted beside the risk band (§7.6). */
const WIRE_NOISE_SD = 0.02;

export interface WhyContext extends Partial<DecisionThresholds> {
  /** the other decisions of the same step (paired Nouls beside a Choice's options) */
  siblings?: readonly Decision[];
  /** the resolved Jev model when the decision carries no `servedModel` */
  model?: string | null;
}

export type WhyRef =
  | { kind: 'ref'; step: number | null; stage: StageName | null; id: string }
  | { kind: 'digit'; digit: number }
  /** TUI-DESIGN-2 §3.11: `intake` (the Choice), `intake.reply`, `intake.about_<key>`, `intake.can_<kind>` — the last intake's step-0 rows */
  | { kind: 'intake'; id: string };

const STAGES: ReadonlySet<string> = new Set<StageName>(['replan', 'intent', 'context', 'propose', 'risk', 'execute', 'judge', 'complete']);

/** TUI-DESIGN-2 §3.11: the `/why` argument grammar of the intake rows — `intake` alone is the Choice itself */
const INTAKE_REF_RE = /^intake(?:\.([a-z][a-z0-9_]*))?$/;

/**
 * TUI-DESIGN §7.6 ref grammar: `s<step>.<stage>.<id>`, `<stage>.<id>` (current step) or a pane digit `1`–`5`; TUI-DESIGN-2 §3.11
 * adds `intake[.<id>]` for the last intake's rows. Null when it parses as none.
 */
export function parseWhyRef(text: string): WhyRef | null {
  const t = text.trim();
  if (/^[1-5]$/.test(t)) return { kind: 'digit', digit: Number(t) };
  const intake = INTAKE_REF_RE.exec(t);
  if (intake) return { kind: 'intake', id: intake[1] ?? 'intake' };
  const m = /^(?:s(\d+)\.)?([a-z_]+)\.(.+)$/.exec(t);
  if (!m) return null;
  const [, step, stage, id] = m;
  if (stage === undefined || id === undefined || !STAGES.has(stage) || id.length === 0) return null;
  return { kind: 'ref', step: step === undefined ? null : Number(step), stage: stage as StageName, id };
}

/** TUI-DESIGN §7.6: `s7.risk.plan_mismatch` for a decision. */
export function whyRef(d: Pick<Decision, 'step' | 'stage' | 'id'>): string {
  return `s${d.step}.${d.stage}.${d.id}`;
}

/** TUI-DESIGN-2 §3.11: the intake row `ref.id` names among the last intake's step-0 `intent` rows (`intake`, `reply`, `about_*`, `can_*`); null when absent */
export function findIntakeDecision(rows: readonly Decision[], ref: Extract<WhyRef, { kind: 'intake' }>): Decision | null {
  return rows.find((d) => d.step === 0 && d.stage === 'intent' && d.id === ref.id) ?? null;
}

/**
 * TUI-DESIGN-2 §3.11 `consumedBy` of the intake rows: `resolveChoice → run floor 0.60 → <kind>` (the Choice, `<kind>` re-derived
 * from the rows in hand), `argmax → catalogue` (the reply Choice), `≥ 0.5 → answer line` (a fact Noul); null for every other row
 * (the paired `can_*` Nouls keep the §7.1 `paired ≥ 0.50` rule).
 */
export function intakeConsumedBy(d: Decision, siblings: readonly Decision[], g: GlyphSet = GLYPHS.unicode): string | null {
  if (d.step !== 0 || d.stage !== 'intent') return null;
  if (d.id === 'intake') {
    const kind = resolveIntake(answersOfRows([d, ...siblings.filter((s) => s !== d)])).kind;
    return `resolveChoice ${g.arrow} run floor ${INTAKE_RUN_FLOOR.toFixed(2)} ${g.arrow} ${kind}`;
  }
  if (d.id === 'reply') return `argmax ${g.arrow} catalogue`;
  if (d.id.startsWith(FACT_QUESTION_PREFIX)) return `${g.ge} ${FACT_SELECT_FLOOR.toFixed(1)} ${g.arrow} answer line`;
  return null;
}

/** TUI-DESIGN §7.6: the decision a ref names among `decisions` (a digit = the current step's risk row `w`+digit names); null when absent. */
export function findDecision(decisions: readonly Decision[], ref: WhyRef, currentStep: number | null): Decision | null {
  if (ref.kind === 'intake') return findIntakeDecision(decisions, ref);
  if (ref.kind === 'digit') {
    const key = reviewRowForDigit(ref.digit);
    if (key === null || currentStep === null) return null;
    return decisions.find((d) => d.step === currentStep && d.stage === 'risk' && d.id === key) ?? null;
  }
  const step = ref.step ?? currentStep;
  if (step === null) return null;
  return decisions.find((d) => d.step === step && d.stage === ref.stage && d.id === ref.id) ?? null;
}

function text(v: Json | undefined | null): string {
  return clip(oneLineCells(criteriaText(v)).replace(/\s+/g, ' ').trim(), WHY_TEXT_CHARS);
}

function examples(v: Json | undefined | null): string[] {
  if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v)) return [];
  const ex = v['examples'];
  if (!Array.isArray(ex)) return [];
  return ex.map((e) => text(e)).filter((e) => e.length > 0);
}

/** TUI-DESIGN §7.6 head line: `why s7.risk.plan_mismatch  request a1b2c3d4  244ms  typesafe/jev-1.13-20260917`. */
export function whyHead(d: Decision, ctx: WhyContext = {}): string {
  const model = d.servedModel ?? ctx.model ?? null;
  const ms = Number.isFinite(d.latencyMs) ? `${Math.round(d.latencyMs)}ms` : '?ms';
  return `why ${whyRef(d)}  request ${d.requestHash.slice(0, 8)}  ${ms}${model ? `  ${model}` : ''}`;
}

/** TUI-DESIGN §7.6 consumer line: `risk band (review ≥ 0.30, block ≥ 0.70); wire two-decimal, noise sd ≈ 0.02` for risk dimensions, the §7.1 rule otherwise; drawn with the glyph set (`≥` / `≈` / `→` have `--ascii` twins). */
export function whyConsumedBy(d: Decision, ctx: WhyContext = {}, g: GlyphSet = GLYPHS.unicode): string {
  const intake = intakeConsumedBy(d, ctx.siblings ?? [], g);
  if (intake !== null) return intake;
  if (d.stage === 'risk' && (RISK_DIMENSIONS as readonly string[]).includes(d.id)) {
    return `risk band (review ${g.ge} ${RISK_REVIEW_THRESHOLD.toFixed(2)}, block ${g.ge} ${RISK_BLOCK_THRESHOLD.toFixed(2)}); wire two-decimal, noise sd ${g.approx} ${WIRE_NOISE_SD.toFixed(2)}`;
  }
  return consumerRule(d, ctx, g).text;
}

function scoreBody(d: Decision, ctx: WhyContext, g: GlyphSet): string[] {
  const q = d.question;
  const a = d.answer;
  const levels = q.type === 'score' ? q.criteria : [];
  const probs = a.type === 'score' ? a.probabilities : {};
  const n = Math.max(2, levels.length || Object.keys(probs).length || 5);
  const isRisk = d.stage === 'risk' && (RISK_DIMENSIONS as readonly string[]).includes(d.id);
  const mode = riskDimensionMode(d.id);
  const dist = riskFromProbabilities(probs, n, RISK_TAIL_FROM_LEVEL, mode);
  const kStar = scoreArgmax(probs, n);
  let ek = 0;
  let dev = 0;
  for (let k = 0; k < n; k++) {
    const p = levelProb(probs, k);
    ek += k * p;
    dev += p * Math.abs(k - kStar);
  }
  const u = uniformDistance(n);
  const conf = Math.max(0, Math.min(1, 1 - dev / u));
  const lines: string[] = [text(q.instructions), isRisk ? `score, ${n} levels; ${mode} dimension ${g.arrow} ${dist.bound} bound` : `score, ${n} levels`];
  for (let k = 0; k < n; k++) {
    const p = levelProb(probs, k);
    lines.push(`L${k} ${eighthBar(p, 10, g)}  ${p2(p)}  ${text(levels[k])}`.trimEnd());
  }
  lines.push(
    `argmax L${kStar} p=${p2(levelProb(probs, kStar))}  E[k]=${p2(ek)}${g.arrow}${p2(ek / (n - 1))}  P(k${g.ge}${RISK_TAIL_FROM_LEVEL})=${p2(dist.tailMass)}  bound=${dist.bound}  risk=${p2(dist.risk)} [${dist.verdict}]`,
    `confidence = 1 ${g.minus} ${g.sigma} p_k${g.dot}|k${g.minus}k*| / U_${n} = 1 ${g.minus} ${p2(dev)}/${u.toFixed(1)} = ${p2(conf)}`,
    `consumed by: ${whyConsumedBy(d, ctx, g)}`,
  );
  return lines;
}

function noulBody(d: Decision, ctx: WhyContext, g: GlyphSet): string[] {
  const q = d.question;
  const criteria = q.type === 'noul' ? q.criteria : undefined;
  const p = d.answer.type === 'noul' ? d.answer.noul : d.probability;
  const lines: string[] = [text(q.instructions)];
  if (criteria) {
    lines.push(`noul; true: ${text(criteria.true)}`);
    const te = examples(criteria.true);
    if (te.length) lines.push(`      examples: ${te.join('; ')}`);
    lines.push(`      false: ${text(criteria.false)}`);
    const fe = examples(criteria.false);
    if (fe.length) lines.push(`      examples: ${fe.join('; ')}`);
  } else {
    lines.push('noul (context: the shared criteria.context of the request)');
  }
  lines.push(`p=${p2(p)}  |2p${g.minus}1|=${p2(Math.abs(2 * p - 1))} (derived confidence)`, `consumed by: ${whyConsumedBy(d, ctx, g)}`);
  return lines;
}

function choiceBody(d: Decision, ctx: WhyContext, g: GlyphSet): string[] {
  const q = d.question;
  const a = d.answer;
  const probs = a.type === 'choice' ? a.probabilities : {};
  const chosen = a.type === 'choice' ? a.choice : null;
  const options = q.type === 'choice' ? Object.keys(q.criteria) : Object.keys(probs);
  for (const o of Object.keys(probs)) if (!options.includes(o)) options.push(o);
  if (!options.includes('none_of_these')) options.push('none_of_these');
  const siblings = (ctx.siblings ?? []).filter((s) => s.step === d.step && s.stage === d.stage);
  const paired = (o: string): Decision | undefined => siblings.find((s) => s.id === `${PAIRED_PREFIX}${o}`);
  const resolved = siblings.find((s) => s.id.startsWith(PAIRED_PREFIX) && s.verdict === 'chosen')?.id.slice(PAIRED_PREFIX.length) ?? null;
  const n = Math.max(1, options.length);
  const nameW = Math.min(20, Math.max(...options.map((o) => o.length), 8));
  const lines: string[] = [text(q.instructions), `choice, ${n} options; paired Nouls ${PAIRED_PREFIX}<option>`];
  for (const o of options) {
    const p = typeof probs[o] === 'number' && Number.isFinite(probs[o]) ? (probs[o] as number) : 0;
    const pr = paired(o);
    const pairedText = pr ? `${padEndCells(pr.id, nameW + PAIRED_PREFIX.length)} ${p2(pr.probability)}` : padEndCells(g.dash, nameW + PAIRED_PREFIX.length + 5);
    const marks: string[] = [];
    if (o === chosen) marks.push('answer');
    if (d.verdict === 'overridden' && o === resolved) marks.push('resolved');
    lines.push(`${padEndCells(o, nameW)} ${eighthBar(p, 10, g)}  ${p2(p)}  ${pairedText}${marks.length ? `  ${g.arrow} ${marks.join(', ')}` : ''}`.trimEnd());
  }
  const floor = p2(PAIRED_NOUL_FLOOR);
  const pChosen = chosen ? paired(chosen) : undefined;
  let rule: string;
  switch (d.verdict) {
    case 'chosen':
      rule = `chosen ${g.dash} Jev's answer \`${chosen ?? '?'}\` with paired ${PAIRED_PREFIX}${chosen ?? '?'} ${pChosen ? p2(pChosen.probability) : '?'} ${g.ge} ${floor}`;
      break;
    case 'overridden':
      rule = `overridden ${g.dash} paired ${PAIRED_PREFIX}${chosen ?? '?'} ${pChosen ? p2(pChosen.probability) : '?'} < ${floor}; the highest paired Noul${resolved ? ` ${PAIRED_PREFIX}${resolved}` : ''} ${g.ge} ${floor} won`;
      break;
    case 'fallback':
      rule = `fallback ${g.dash} no paired Noul ${g.ge} ${floor} (answer \`${chosen ?? 'none_of_these'}\`) ${g.arrow} the stage's safe default`;
      break;
    default:
      rule = `${d.verdict ?? 'unresolved'} ${g.dash} answer \`${chosen ?? '?'}\``;
  }
  lines.push(`resolution: ${rule}`, `confidence = (p_max ${g.minus} 1/n)/(1 ${g.minus} 1/n) = ${p2(choiceConfidence(d.probability, n))}`, `consumed by: ${whyConsumedBy(d, ctx, g)}`);
  return lines;
}

/** TUI-DESIGN §7.6 `/why`: the head line followed by the two-space-indented body, ≤ WHY_MAX_LINES lines in total. */
export function whyBlock(d: Decision, ctx: WhyContext = {}, g: GlyphSet = GLYPHS.unicode): string[] {
  let body: string[];
  switch (d.answer.type) {
    case 'score':
      body = scoreBody(d, ctx, g);
      break;
    case 'noul':
      body = noulBody(d, ctx, g);
      break;
    case 'choice':
      body = choiceBody(d, ctx, g);
      break;
  }
  const lines = [whyHead(d, ctx), ...body.map((l) => `  ${oneLineCells(l)}`)];
  if (lines.length <= WHY_MAX_LINES) return lines;
  return [...lines.slice(0, WHY_MAX_LINES - 1), `  ${g.ellipsis}[${lines.length - WHY_MAX_LINES + 1} lines omitted]`];
}

/** TUI-DESIGN §7.7 Ctrl+O: one `/why`-style block per stage of `step` (probabilities and criteria), in stage order. */
export function stepWhyBlocks(decisions: readonly Decision[], step: number, g: GlyphSet = GLYPHS.unicode): string[][] {
  const order: readonly StageName[] = ['replan', 'intent', 'context', 'propose', 'risk', 'execute', 'judge', 'complete'];
  const mine = decisions.filter((d) => d.step === step);
  const blocks: string[][] = [];
  for (const stage of order) {
    const rows = mine.filter((d) => d.stage === stage);
    if (rows.length === 0) continue;
    const head = `why s${step}.${stage}  ${rows.length} decision${rows.length === 1 ? '' : 's'}`;
    const body: string[] = [];
    for (const d of rows) {
      const bar = g.mode === 'sr' ? '' : `${eighthBar(d.probability, 10, g)}  `;
      body.push(`  ${padEndCells(oneLineCells(d.id), 16)} ${bar}${padStartCells(p2(d.probability), 4)}  c ${p2(d.confidence)}${d.answer.type === 'noul' ? '~' : ' '}  ${clip(d.answer.type === 'choice' ? `choice ${d.answer.choice}` : d.answer.type === 'score' ? `L${d.answer.score}` : 'noul', 24)}`.trimEnd());
    }
    blocks.push([head, ...body].slice(0, WHY_MAX_LINES));
  }
  return blocks;
}
