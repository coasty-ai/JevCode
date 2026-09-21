/**
 * The statistics of the head-to-head (docs/LLM-JEV-DESIGN.md §1.3, §10.4): Wilson intervals on every pass rate,
 * discordant pairs with the one-sided exact sign test, the one-sided Wilcoxon signed-rank test on paired wall times
 * (exact, by dynamic programming over the rank sums — n = 20–40 needs no normal approximation), and the ratio helper
 * the cost criteria read. Pure arithmetic; nothing here reads a record.
 */

/** Wilson score interval for k successes in n trials (z = 1.96 → 95 %); null when n = 0. */
export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } | null {
  if (n <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** C(n, k) in doubles (exact to n ≈ 50, adequate far beyond the bench's sizes). */
export function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let out = 1;
  for (let i = 1; i <= kk; i++) out = (out * (n - kk + i)) / i;
  return out;
}

/** P(X ≥ b) for X ~ Binomial(n, 1/2): the one-sided exact sign test on b wins out of n discordant pairs. */
export function binomialTailOneSided(b: number, n: number): number {
  if (n <= 0) return 1;
  let sum = 0;
  for (let i = Math.max(0, b); i <= n; i++) sum += binomial(n, i);
  return Math.min(1, sum / 2 ** n);
}

/** One-sided exact sign test on (b = candidate wins, c = baseline wins); null with no discordant pair. */
export function signTestOneSided(b: number, c: number): number | null {
  const n = b + c;
  return n === 0 ? null : binomialTailOneSided(b, n);
}

export interface DiscordantPairs {
  /** candidate passes, baseline fails */
  b: number;
  /** baseline passes, candidate fails */
  c: number;
  both: number;
  neither: number;
  n: number;
  /** one-sided exact sign test P(X ≥ b | b + c, ½); null without discordant pairs */
  p: number | null;
}

/** Discordant counts over paired verdicts (candidate, baseline). */
export function discordantPairs(pairs: readonly { candidate: boolean; baseline: boolean }[]): DiscordantPairs {
  let b = 0;
  let c = 0;
  let both = 0;
  let neither = 0;
  for (const p of pairs) {
    if (p.candidate && !p.baseline) b += 1;
    else if (!p.candidate && p.baseline) c += 1;
    else if (p.candidate) both += 1;
    else neither += 1;
  }
  return { b, c, both, neither, n: pairs.length, p: signTestOneSided(b, c) };
}

export interface WilcoxonResult {
  /** non-zero differences */
  n: number;
  /** rank sum of the positive differences (candidate slower) */
  wPlus: number;
  /** exact one-sided P(W+ ≤ observed) under H0 — small when the candidate is faster */
  p: number | null;
}

/**
 * One-sided Wilcoxon signed-rank test on `diffs = candidate − baseline` with H1 "candidate smaller" (wall, steps).
 * Zeros are dropped, ties take average ranks, and the null distribution of W+ is computed exactly by DP over the
 * doubled ranks (integers), so n = 20–40 is exact rather than approximated.
 */
export function wilcoxonSignedRankOneSided(diffs: readonly number[]): WilcoxonResult {
  const nz = diffs.filter((d) => d !== 0 && Number.isFinite(d));
  const n = nz.length;
  if (n === 0) return { n: 0, wPlus: 0, p: null };
  const order = nz.map((d, i) => ({ abs: Math.abs(d), i })).sort((a, b) => a.abs - b.abs);
  // average ranks for ties, doubled so every rank is an integer
  const rank2 = new Array<number>(n).fill(0);
  let k = 0;
  while (k < order.length) {
    let j = k;
    while (j + 1 < order.length && order[j + 1]!.abs === order[k]!.abs) j++;
    const avg2 = k + 1 + (j + 1); // 2 × mean of ranks k+1..j+1
    for (let t = k; t <= j; t++) rank2[order[t]!.i] = avg2;
    k = j + 1;
  }
  let wPlus2 = 0;
  for (let i = 0; i < n; i++) if (nz[i]! > 0) wPlus2 += rank2[i]!;
  const total = rank2.reduce((a, b) => a + b, 0);
  // counts[w] = number of sign assignments with doubled positive rank sum w
  let counts = new Float64Array(total + 1);
  counts[0] = 1;
  for (const r of rank2) {
    const next = new Float64Array(total + 1);
    for (let w = 0; w <= total; w++) {
      const c = counts[w]!;
      if (c === 0) continue;
      next[w] = (next[w] ?? 0) + c;
      next[w + r] = (next[w + r] ?? 0) + c;
    }
    counts = next;
  }
  let below = 0;
  for (let w = 0; w <= wPlus2; w++) below += counts[w]!;
  return { n, wPlus: wPlus2 / 2, p: Math.min(1, below / 2 ** n) };
}

/** a / b, null when either side is unknown or b is 0. */
export function ratio(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0 || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a / b;
}
