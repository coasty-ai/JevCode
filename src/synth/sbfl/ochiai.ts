/**
 * SBFL formulas (Ochiai, Tarantula, DStar) over per-test line coverage, a deterministic
 * ranking (score desc, then file asc, then line asc) and a function-level roll-up (max over the
 * covered lines of each span).
 *
 * Failing = fail | error | timeout (the test did not pass); passing = pass; skip is excluded
 * from both totals. Module-level lines never appear because the tracer only records the test
 * body, so every ranked line was executed by at least one counted test.
 */
import type { Formula, FunctionSpan, LineScores, PerTestResult, RankedFunction, RankedLine, TestOutcome } from './types.js';

export interface LineCounts {
  file: string;
  line: number;
  ef: number;
  ep: number;
}

export interface Spectrum {
  totalFailed: number;
  totalPassed: number;
  lines: LineCounts[];
}

export function isFailing(outcome: TestOutcome): boolean {
  return outcome === 'fail' || outcome === 'error' || outcome === 'timeout';
}

/** Per-line (ef, ep) counts plus the totals; a test counts a line once however often it ran it. */
export function buildSpectrum(perTest: readonly PerTestResult[]): Spectrum {
  const counts = new Map<string, LineCounts>();
  let totalFailed = 0;
  let totalPassed = 0;
  for (const t of perTest) {
    if (t.outcome === 'skip') continue;
    const failing = isFailing(t.outcome);
    if (failing) totalFailed += 1;
    else totalPassed += 1;
    for (const [file, lines] of Object.entries(t.lines)) {
      for (const line of new Set(lines)) {
        const key = `${file}\u0000${line}`;
        let c = counts.get(key);
        if (c === undefined) {
          c = { file, line, ef: 0, ep: 0 };
          counts.set(key, c);
        }
        if (failing) c.ef += 1;
        else c.ep += 1;
      }
    }
  }
  return { totalFailed, totalPassed, lines: [...counts.values()] };
}

/** ef / sqrt(F * (ef + ep)); 0 when nothing failed or the line never ran. */
export function ochiai(ef: number, ep: number, totalFailed: number): number {
  const denominator = Math.sqrt(totalFailed * (ef + ep));
  return denominator === 0 ? 0 : ef / denominator;
}

/** (ef/F) / (ef/F + ep/P); a ratio with a zero total counts as 0. */
export function tarantula(ef: number, ep: number, totalFailed: number, totalPassed: number): number {
  const failRatio = totalFailed === 0 ? 0 : ef / totalFailed;
  const passRatio = totalPassed === 0 ? 0 : ep / totalPassed;
  const sum = failRatio + passRatio;
  return sum === 0 ? 0 : failRatio / sum;
}

/**
 * ef^star / (ep + nf) with nf = F - ef. A zero denominator with ef > 0 (executed by every
 * failing test and by no passing test) is the formula's maximum and is returned as Infinity;
 * JSON.stringify turns that into null, so serialise `scores.ochiai` if a number is needed.
 */
export function dstar(ef: number, ep: number, totalFailed: number, star = 2): number {
  const nf = totalFailed - ef;
  const denominator = ep + nf;
  if (denominator === 0) return ef > 0 ? Number.POSITIVE_INFINITY : 0;
  return ef ** star / denominator;
}

export function lineScores(c: LineCounts, spectrum: Spectrum): LineScores {
  return {
    ochiai: ochiai(c.ef, c.ep, spectrum.totalFailed),
    tarantula: tarantula(c.ef, c.ep, spectrum.totalFailed, spectrum.totalPassed),
    dstar: dstar(c.ef, c.ep, spectrum.totalFailed),
  };
}

interface Sortable {
  score: number;
  file: string;
  line: number;
}

/** Score desc, file asc, line asc. Infinity compares correctly; no NaN is ever produced. */
function compareRanked(a: Sortable, b: Sortable): number {
  if (a.score !== b.score) return a.score > b.score ? -1 : 1;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
}

/** All executed lines, ranked by `formula` (all three scores are kept on each row). */
export function scoreSpectrum(spectrum: Spectrum, formula: Formula = 'ochiai'): RankedLine[] {
  const rows: RankedLine[] = spectrum.lines.map((c) => {
    const scores = lineScores(c, spectrum);
    return { rank: 0, file: c.file, line: c.line, ef: c.ef, ep: c.ep, score: scores[formula], scores };
  });
  rows.sort(compareRanked);
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  return rows;
}

export function rankLines(perTest: readonly PerTestResult[], formula: Formula = 'ochiai'): RankedLine[] {
  return scoreSpectrum(buildSpectrum(perTest), formula);
}

export function top<T>(ranked: readonly T[], k: number): T[] {
  return ranked.slice(0, Math.max(0, Math.floor(k)));
}

/** 1-based rank of (file, line), or null when the line was never executed. */
export function rankOf(ranked: readonly RankedLine[], file: string, line: number): number | null {
  const hit = ranked.find((r) => r.file === file && r.line === line);
  return hit === undefined ? null : hit.rank;
}

/**
 * Function-level suspiciousness: for each span, the max score over its covered lines (ties to
 * the lowest line). Spans with no covered line are omitted; lines outside every span are
 * dropped. Nested spans (class and method) each get their own row.
 */
export function functionSuspiciousness(ranked: readonly RankedLine[], spans: readonly FunctionSpan[]): RankedFunction[] {
  const out: RankedFunction[] = [];
  for (const span of spans) {
    let best: RankedLine | undefined;
    let covered = 0;
    for (const r of ranked) {
      if (r.file !== span.file || r.line < span.startLine || r.line > span.endLine) continue;
      covered += 1;
      if (best === undefined || compareRanked(r, best) < 0) best = r;
    }
    if (best === undefined) continue;
    out.push({
      rank: 0,
      file: span.file,
      name: span.name,
      startLine: span.startLine,
      endLine: span.endLine,
      score: best.score,
      bestLine: best.line,
      coveredLines: covered,
    });
  }
  out.sort((a, b) => {
    if (a.score !== b.score) return a.score > b.score ? -1 : 1;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  out.forEach((f, i) => {
    f.rank = i + 1;
  });
  return out;
}
