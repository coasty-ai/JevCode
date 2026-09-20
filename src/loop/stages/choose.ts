/**
 * Choice resolution (DESIGN.md §6), shared by intent and replan: the response's `choice` is
 * taken when its paired Noul is >= PAIRED_NOUL_FLOOR; otherwise the option with the highest
 * paired Noul >= floor; otherwise the stage's safe default. Verdicts are written onto the
 * Decision rows so the pane shows chosen / overridden / fallback.
 */
import { PAIRED_PREFIX } from '../../jev/questions.js';
import type { Answer, Decision } from '../../core/types.js';

export const PAIRED_NOUL_FLOOR = 0.5;

export type ChoiceVerdict = 'chosen' | 'overridden' | 'fallback';

export interface ChoiceResolution<O extends string> {
  option: O;
  verdict: ChoiceVerdict;
  /** the raw Choice answer */
  answer: string;
  /** Choice probability of the resolved option */
  probability: number;
  /** paired Noul of the resolved option (0 when none exists, e.g. the fallback) */
  pairedNoul: number;
}

export interface ChoiceInput<O extends string> {
  choiceId: string;
  answers: Record<string, Answer>;
  options: readonly O[];
  escape: string;
  fallback: O;
}

export function pairedId(option: string): string {
  return `${PAIRED_PREFIX}${option}`;
}

function noulValue(answers: Record<string, Answer>, id: string): number {
  const a = answers[id];
  return a && a.type === 'noul' ? a.noul : 0;
}

export function resolveChoice<O extends string>(input: ChoiceInput<O>): ChoiceResolution<O> {
  const choiceAnswer = input.answers[input.choiceId];
  if (!choiceAnswer || choiceAnswer.type !== 'choice') {
    return { option: input.fallback, verdict: 'fallback', answer: input.escape, probability: 0, pairedNoul: noulValue(input.answers, pairedId(input.fallback)) };
  }
  const c = choiceAnswer.choice;
  const probs = choiceAnswer.probabilities;
  const pOf = (o: string): number => {
    const p = probs[o];
    return typeof p === 'number' && Number.isFinite(p) ? p : 0;
  };
  const isOption = (input.options as readonly string[]).includes(c);
  if (c !== input.escape && isOption) {
    const paired = noulValue(input.answers, pairedId(c));
    if (paired >= PAIRED_NOUL_FLOOR) return { option: c as O, verdict: 'chosen', answer: c, probability: pOf(c), pairedNoul: paired };
  }
  let best: O | null = null;
  let bestP = -1;
  for (const o of input.options) {
    const p = noulValue(input.answers, pairedId(o));
    if (p > bestP + 1e-12) {
      bestP = p;
      best = o;
    }
  }
  if (best !== null && bestP >= PAIRED_NOUL_FLOOR) return { option: best, verdict: 'overridden', answer: c, probability: pOf(best), pairedNoul: bestP };
  return { option: input.fallback, verdict: 'fallback', answer: c, probability: pOf(c), pairedNoul: noulValue(input.answers, pairedId(input.fallback)) };
}

/** Write verdicts: the Choice row gets the resolution verdict; on override the winning Noul row gets 'chosen'. */
export function annotateChoiceRows(rows: Decision[], choiceId: string, res: ChoiceResolution<string>): void {
  for (const r of rows) {
    if (r.id === choiceId) r.verdict = res.verdict;
    else if (res.verdict === 'overridden' && r.id === pairedId(res.option)) r.verdict = 'chosen';
  }
}
