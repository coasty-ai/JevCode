/** Candidate-set construction for probe-select: deterministic, seeded, nested by size, fix at a seeded position. */
import { mutateLine, mutateLineSecondOrder, normLine, statementTemplates, type Mutant } from './mutators.ts';
import { compilable, type Program } from './quixbugs.ts';

export const MAX_CANDIDATES = 254; // + none_of_these = 255 options

/** xorshift32 seeded PRNG */
export function rng(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  let x = h >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}
export function shuffled<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

export interface CandidatePool {
  /** ordered distractors (fix excluded, compilable, unique); index < firstOrder are mutants of the buggy line */
  pool: Mutant[];
  firstOrder: number;
  neighbour: number;
  /** was the gold fix produced by the library (first order / second order / not at all)? */
  fixGenerated: 'first' | 'second' | 'donor' | 'none';
}

function indentOf(l: string): string { return l.match(/^\s*/)?.[0] ?? ''; }

export function buildPool(p: Program): CandidatePool {
  const rand = rng(`pool:${p.name}`);
  const target = normLine(p.fixLine);
  const seen = new Set<string>([target, normLine(p.buggyLine)]);
  const take = (ms: Mutant[]): Mutant[] => ms.filter((m) => { const k = normLine(m.text); if (seen.has(k)) return false; seen.add(k); return true; });
  let firstRaw: Mutant[];
  let fixGenerated: CandidatePool['fixGenerated'] = 'none';
  let pool: Mutant[] = [];
  if (p.mode === 'insert') {
    const indent = indentOf(p.buggyLine) + (p.buggyLine.trimEnd().endsWith(':') ? '    ' : '');
    firstRaw = [];
    for (const l of p.lines) { const t = indent + l.trim(); firstRaw.push({ text: t, op: 'donor_line' }); firstRaw.push(...mutateLine(t, p.ctx)); }
    firstRaw.push(...statementTemplates(p.ctx, indent));
    const hit = firstRaw.find((m) => normLine(m.text) === target);
    if (hit) fixGenerated = hit.op === 'donor_line' ? 'donor' : 'first';
    pool = shuffled(take(firstRaw), rand);
  } else {
    firstRaw = mutateLine(p.buggyLine, p.ctx);
    const hit = firstRaw.find((m) => normLine(m.text) === target);
    if (hit) fixGenerated = 'first';
    pool = [{ text: p.buggyLine, op: 'unchanged' }, ...shuffled(take(firstRaw), rand)];
  }
  const ok = compilable(p, pool.map((m) => m.text));
  pool = pool.filter((_, i) => ok[i]);
  const firstOrder = pool.length;
  // neighbours by distance, re-indented to the buggy line
  const neigh: Mutant[] = [];
  const indent = indentOf(p.buggyLine);
  for (let d = 1; d < p.lines.length && pool.length + neigh.length < MAX_CANDIDATES * 2; d++) {
    for (const j of [p.index - d, p.index + d]) {
      const l = p.lines[j];
      if (l === undefined || /^\s*def\b/.test(l)) continue;
      const t = indent + l.trim();
      const ms = take([{ text: t, op: `neighbour${d}_line` }, ...mutateLine(t, p.ctx).map((m) => ({ text: m.text, op: `neighbour${d}_${m.op}` }))]);
      neigh.push(...shuffled(ms, rand).slice(0, 40));
    }
  }
  const okN = compilable(p, neigh.map((m) => m.text));
  pool.push(...neigh.filter((_, i) => okN[i]));
  const neighbour = pool.length - firstOrder;
  if (fixGenerated === 'none' && p.mode === 'replace' && mutateLineSecondOrder(p.buggyLine, p.ctx, firstRaw, 20000).some((m) => normLine(m.text) === target)) fixGenerated = 'second';
  if (pool.length < MAX_CANDIDATES && p.mode === 'replace') {
    const second = take(mutateLineSecondOrder(p.buggyLine, p.ctx, firstRaw, 3000));
    const okS = compilable(p, second.map((m) => m.text));
    pool.push(...shuffled(second.filter((_, i) => okS[i]), rand));
  }
  return { pool: pool.slice(0, MAX_CANDIDATES), firstOrder, neighbour, fixGenerated };
}

export interface CandidateSet {
  size: number;
  withFix: boolean;
  /** option key -> code text, in presentation order */
  options: [string, string][];
  fixKey: string | null;
}

export function keyFor(i: number): string {
  return `cand_${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;
}

/** Nested sets: the first `size` (or size-1 + fix) pool entries. Fix position seeded per program+size. */
export function buildSet(p: Program, pool: CandidatePool, size: number, withFix: boolean): CandidateSet {
  const n = Math.min(size, pool.pool.length + (withFix ? 1 : 0));
  const texts = pool.pool.slice(0, withFix ? n - 1 : n).map((m) => m.text);
  let fixKey: string | null = null;
  if (withFix) {
    const pos = Math.floor(rng(`fixpos:${p.name}:${size}`)() * n);
    texts.splice(pos, 0, p.fixLine);
    fixKey = keyFor(pos);
  }
  return { size: texts.length, withFix, options: texts.map((t, i) => [keyFor(i), t] as [string, string]), fixKey };
}

/** Same texts, different presentation order (keys reassigned by position). */
export function permuteSet(set: CandidateSet, order: 'reversed' | 'shuffled', seed: string): CandidateSet {
  const texts = set.options.map(([, t]) => t);
  const fixText = set.fixKey ? set.options.find(([k]) => k === set.fixKey)![1] : null;
  const perm = order === 'reversed' ? [...texts].reverse() : shuffled(texts, rng(seed));
  const options = perm.map((t, i) => [keyFor(i), t] as [string, string]);
  const fixKey = fixText === null ? null : options.find(([, t]) => t === fixText)![0];
  return { ...set, options, fixKey };
}
