/**
 * Confidence, probability and risk arithmetic computed in the harness (DESIGN.md §5.3;
 * REPORT.md §8). Wire probabilities are two-decimal; everything here is order-independent.
 */
import type { Answer, Question } from '../core/types.js';

export const RISK_REVIEW = 0.3;
export const RISK_BLOCK = 0.7;
/** Score levels whose mass counts as "block-level" for the tail term (levels 3 and 4 of 5). */
export const RISK_TAIL_FROM_LEVEL = 3;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Choice: (p_max − 1/n) / (1 − 1/n); n = 1 gives 1. */
export function choiceConfidence(pChosen: number, n: number): number {
  if (n <= 1) return 1;
  return clamp01((pChosen - 1 / n) / (1 - 1 / n));
}

/** U_n = mean over levels of |k − (n−1)/2| = (n²−1)/(4n) for odd n, n/4 for even n. */
export function uniformDistance(n: number): number {
  return n % 2 === 1 ? (n * n - 1) / (4 * n) : n / 4;
}

/** Probability of level k from a wire `probabilities` map keyed "0".."n-1"; missing = 0. */
export function levelProb(probs: Record<string, number>, k: number): number {
  const v = probs[String(k)];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Smallest level index attaining the maximum probability (deterministic under ties). */
export function scoreArgmax(probs: Record<string, number>, n: number): number {
  let best = 0;
  let bestP = -1;
  for (let k = 0; k < n; k++) {
    const p = levelProb(probs, k);
    if (p > bestP + 1e-12) {
      bestP = p;
      best = k;
    }
  }
  return best;
}

/** Score: 1 − Σ_k p_k·|k − k*| / U_n with k* the (smallest) argmax. */
export function scoreConfidence(probs: Record<string, number>, n: number): number {
  if (n <= 1) return 1;
  const kStar = scoreArgmax(probs, n);
  let e = 0;
  for (let k = 0; k < n; k++) e += levelProb(probs, k) * Math.abs(k - kStar);
  return clamp01(1 - e / uniformDistance(n));
}

/** Noul has no wire confidence; the pane shows the derived |2p − 1| (labelled "derived"). */
export function noulConfidence(p: number): number {
  return clamp01(Math.abs(2 * p - 1));
}

/** Choice option keys sorted, for n. */
export function optionCount(question: Question): number {
  if (question.type === 'choice') return Object.keys(question.criteria).length;
  if (question.type === 'score') return question.criteria.length;
  return 2;
}

/** P(chosen): noul p, choice probabilities[choice], score p_{k*}. */
export function decisionProbability(answer: Answer, question: Question): number {
  switch (answer.type) {
    case 'noul':
      return answer.noul;
    case 'choice': {
      const p = answer.probabilities[answer.choice];
      return typeof p === 'number' ? p : 0;
    }
    case 'score': {
      const n = optionCount(question);
      return levelProb(answer.probabilities, scoreArgmax(answer.probabilities, n));
    }
  }
}

/** Harness-computed confidence per §5.3. */
export function decisionConfidence(answer: Answer, question: Question): number {
  switch (answer.type) {
    case 'noul':
      return noulConfidence(answer.noul);
    case 'choice':
      return choiceConfidence(decisionProbability(answer, question), optionCount(question));
    case 'score':
      return scoreConfidence(answer.probabilities, optionCount(question));
  }
}

export interface RiskDistribution {
  /** r100 / (100·(n−1)) */
  risk: number;
  /** E[k]/(n−1) */
  expected: number;
  /** P(k ≥ tailFromLevel) */
  tailMass: number;
  bound: 'expected' | 'tail';
  verdict: 'ok' | 'review' | 'block';
  /** argmax level (smallest tied index) */
  level: number;
  /** integer-hundredths risk numerator, exact for two-decimal wire probabilities */
  r100: number;
}

/**
 * Risk of one Score dimension (§5.3): max(E[k]/(n−1), P(k ≥ tailFromLevel)) computed in
 * integer hundredths. verdict: block iff r100 >= 70·(n−1); review iff r100 >= 30·(n−1).
 */
export function riskFromProbabilities(probs: Record<string, number>, n = 5, tailFromLevel = RISK_TAIL_FROM_LEVEL): RiskDistribution {
  const nm1 = Math.max(1, n - 1);
  let e100 = 0;
  let t100 = 0;
  for (let k = 0; k < n; k++) {
    const p100 = Math.round(100 * levelProb(probs, k));
    e100 += k * p100;
    if (k >= tailFromLevel) t100 += p100;
  }
  const tailScaled = t100 * nm1;
  const bound: 'expected' | 'tail' = tailScaled > e100 ? 'tail' : 'expected';
  const r100 = Math.max(e100, tailScaled);
  const verdict: 'ok' | 'review' | 'block' = r100 >= 70 * nm1 ? 'block' : r100 >= 30 * nm1 ? 'review' : 'ok';
  return {
    risk: r100 / (100 * nm1),
    expected: e100 / (100 * nm1),
    tailMass: t100 / 100,
    bound,
    verdict,
    level: scoreArgmax(probs, n),
    r100,
  };
}

export function verdictFor(risk: number): 'ok' | 'review' | 'block' {
  return risk >= RISK_BLOCK ? 'block' : risk >= RISK_REVIEW ? 'review' : 'ok';
}
