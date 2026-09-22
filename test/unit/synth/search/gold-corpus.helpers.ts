/**
 * The gold corpora of this repository, as before/after patch images: the sweep harness every
 * structural signal has to pass before it may be a `POOL_SUSPECT_SIGNAL`
 * (docs/DECISIONS.md 2026-09-22, ruling 1 of the iteration-3 entry).
 *
 * 198 patches: QuixBugs 41 programs, ladder 65 gold files over 26 tasks, and the 92 Python hunks
 * of the 30 SWE-bench Verified instances in `bench/data/swebench-verified-30.gold.json`. Written
 * for `late-guard.test.ts` in OOS iteration 3 and lifted here in iteration 4 so the data-flow
 * signal, the three unswept signals and the statement-kind prior all sweep the SAME corpus.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './helpers.js';

export const LADDER_TASKS = join(REPO_ROOT, 'bench/data/ladder/tasks');
export const QUIXBUGS_DIR = join(REPO_ROOT, 'bench/data/quixbugs');

const read = (p: string): string => readFileSync(p, 'utf8');

export interface GoldPatch {
  name: string;
  path: string;
  before: string;
  after: string;
}

export function quixbugsGolds(): GoldPatch[] {
  const out: GoldPatch[] = [];
  for (const f of readdirSync(join(QUIXBUGS_DIR, 'programs')).filter((x) => x.endsWith('.py'))) {
    if (!existsSync(join(QUIXBUGS_DIR, 'correct', f))) continue;
    out.push({ name: `quixbugs/${f}`, path: f, before: read(join(QUIXBUGS_DIR, 'programs', f)), after: read(join(QUIXBUGS_DIR, 'correct', f)) });
  }
  return out;
}

export function ladderGolds(): GoldPatch[] {
  const out: GoldPatch[] = [];
  const walk = (dir: string, rel = ''): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), `${rel}${e.name}/`) : e.name.endsWith('.py') ? [`${rel}${e.name}`] : []));
  for (const task of readdirSync(LADDER_TASKS)) {
    const goldDir = join(LADDER_TASKS, task, 'gold');
    const srcDir = join(LADDER_TASKS, task, 'src');
    if (!existsSync(goldDir) || !existsSync(srcDir)) continue;
    for (const f of walk(goldDir)) {
      if (!existsSync(join(srcDir, f))) continue;
      out.push({ name: `ladder/${task}/${f}`, path: `src/${f}`, before: read(join(srcDir, f)), after: read(join(goldDir, f)) });
    }
  }
  return out;
}

/** Every Python hunk of a unified diff, as the before/after image of its own context window. */
export function hunkPatches(id: string, diff: string): GoldPatch[] {
  const out: GoldPatch[] = [];
  let path = '';
  let before: string[] = [];
  let after: string[] = [];
  const flush = (): void => {
    if (path.endsWith('.py') && (before.length > 0 || after.length > 0)) out.push({ name: `${id} ${path}`, path, before: `${before.join('\n')}\n`, after: `${after.join('\n')}\n` });
    before = [];
    after = [];
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('+++ b/')) {
      flush();
      path = line.slice('+++ b/'.length);
      continue;
    }
    if (line.startsWith('@@') || line.startsWith('diff --git') || line.startsWith('index ')) {
      if (line.startsWith('@@')) flush();
      continue;
    }
    if (line.startsWith('-')) before.push(line.slice(1));
    else if (line.startsWith('+')) after.push(line.slice(1));
    else if (line.startsWith(' ')) {
      before.push(line.slice(1));
      after.push(line.slice(1));
    }
  }
  flush();
  return out;
}

export function swebenchGolds(): GoldPatch[] {
  const golds = JSON.parse(read(join(REPO_ROOT, 'bench/data/swebench-verified-30.gold.json'))) as Record<string, string>;
  return Object.entries(golds).flatMap(([id, diff]) => hunkPatches(id, diff));
}

/** The three corpora, named, in sweep order. */
export function goldCorpora(): readonly [string, GoldPatch[]][] {
  return [
    ['quixbugs', quixbugsGolds()],
    ['ladder', ladderGolds()],
    ['swebench-verified-30', swebenchGolds()],
  ];
}

export function allGoldPatches(): GoldPatch[] {
  return goldCorpora().flatMap(([, g]) => g);
}

/** A SWE-bench hunk image starts at the hunk's own indentation; strip the common prefix so it parses. */
export function dedent(src: string): string {
  const lines = src.split('\n');
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === '') continue;
    const w = l.length - l.trimStart().length;
    if (w < min) min = w;
  }
  if (!Number.isFinite(min) || min === 0) return src;
  return lines.map((l) => (l.trim() === '' ? l : l.slice(min))).join('\n');
}

/** LCS alignment; the 1-based BEFORE line numbers the patch removes or rewrites. */
export function removedLines(before: readonly string[], after: readonly string[]): number[] {
  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = before[i] === after[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push(i + 1);
      i += 1;
    } else j += 1;
  }
  while (i < n) {
    out.push(i + 1);
    i += 1;
  }
  return out;
}
