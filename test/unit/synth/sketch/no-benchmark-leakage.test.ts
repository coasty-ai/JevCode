/**
 * No benchmark gold text inside the Jev question wordings (experiments/results/jev-only-audit.md
 * §3.2: the measured Q7 option examples quoted ten QuixBugs gold fixes verbatim). The corpus is
 * built from bench/data at test time: every line of bench/data/quixbugs/{correct,programs}/<name>.py,
 * every `buggyLine` / `fixedLine` of its index.json (plus the fixed fragment that differs between
 * the two), every gold-only line of bench/data/ladder/tasks/<task>/gold/<file>.py (absent from src/), every
 * added line of the SWE-bench gold patches (bench/data/swebench-verified-30.gold.json) and every
 * line of the Terminal-Bench gold solutions (bench/data/terminal-bench/gold/<task>/**).
 * Lines are whitespace-normalised and must be ≥ 12 chars (fragments ≥ 8); a trailing `:` is
 * also tried without the colon so `while lo < hi` matches `while lo < hi:`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EDIT_CLASSES, EDIT_CLASS_INSTRUCTIONS, SKETCH_INSTRUCTIONS, editClassQuestion } from '../../../../src/synth/sketch/questions.js';
import { TEMPLATE_QUESTION, currentLineCorrectNoul, nextTokenQuestion, slotQuestion } from '../../../../src/synth/beam/state.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const QUIXBUGS = join(ROOT, 'bench/data/quixbugs');
const LADDER = join(ROOT, 'bench/data/ladder/tasks');
const SWEBENCH_GOLD = join(ROOT, 'bench/data/swebench-verified-30.gold.json');
const TERMINAL_BENCH_GOLD = join(ROOT, 'bench/data/terminal-bench/gold');
const MIN_LINE_CHARS = 12;
const MIN_FRAGMENT_CHARS = 8;

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** A normalised line and, when it ends with a colon, the same line without it. */
function variants(line: string): string[] {
  const n = norm(line);
  return n.endsWith(':') ? [n, n.slice(0, -1).trimEnd()] : [n];
}

function addLines(into: Map<string, string>, text: string, origin: string, min: number): void {
  text.split('\n').forEach((raw, i) => {
    for (const v of variants(raw)) if (v.length >= min && !into.has(v)) into.set(v, `${origin}:${i + 1}`);
  });
}

/** The tail of `fixed` after the space-separated tokens it shares with `buggy` (`enumerate(counts)`, `gcd(b, a % b)`, `perm[i] < perm[j]`). */
export function fixedFragment(buggy: string, fixed: string): string {
  const b = norm(buggy).split(' ');
  const f = norm(fixed).split(' ');
  let i = 0;
  while (i < b.length && i < f.length && b[i] === f[i]) i++;
  return f.slice(i).join(' ').replace(/:$/, '').trim();
}

function pyFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.py')).map((f) => join(dir, f)) : [];
}

/** normalised text → where it comes from */
export function benchmarkCorpus(): Map<string, string> {
  const corpus = new Map<string, string>();
  for (const sub of ['correct', 'programs']) for (const file of pyFiles(join(QUIXBUGS, sub))) addLines(corpus, readFileSync(file, 'utf8'), `quixbugs/${sub}/${file.split('/').pop()}`, MIN_LINE_CHARS);
  const indexPath = join(QUIXBUGS, 'index.json');
  if (existsSync(indexPath)) {
    const entries: unknown = JSON.parse(readFileSync(indexPath, 'utf8'));
    if (Array.isArray(entries)) {
      for (const e of entries) {
        if (typeof e !== 'object' || e === null) continue;
        const rec = e as Record<string, unknown>;
        const name = typeof rec['name'] === 'string' ? rec['name'] : '?';
        const buggy = typeof rec['buggyLine'] === 'string' ? rec['buggyLine'] : null;
        const fixed = typeof rec['fixedLine'] === 'string' ? rec['fixedLine'] : null;
        if (buggy !== null) addLines(corpus, buggy, `index.json/${name}.buggyLine`, MIN_LINE_CHARS);
        if (fixed !== null) addLines(corpus, fixed, `index.json/${name}.fixedLine`, MIN_LINE_CHARS);
        if (buggy !== null && fixed !== null) {
          const frag = fixedFragment(buggy, fixed);
          if (frag.length >= MIN_FRAGMENT_CHARS && !corpus.has(frag)) corpus.set(frag, `index.json/${name}.fixedFragment`);
        }
      }
    }
  }
  if (existsSync(LADDER)) {
    for (const task of readdirSync(LADDER)) {
      for (const goldFile of pyFiles(join(LADDER, task, 'gold'))) {
        const base = goldFile.split('/').pop() ?? '';
        const srcFile = join(LADDER, task, 'src', base);
        const srcLines = new Set(existsSync(srcFile) ? readFileSync(srcFile, 'utf8').split('\n').map(norm) : []);
        const goldOnly = readFileSync(goldFile, 'utf8')
          .split('\n')
          .filter((l) => !srcLines.has(norm(l)))
          .join('\n');
        addLines(corpus, goldOnly, `ladder/${task}/gold/${base}`, MIN_LINE_CHARS);
      }
    }
  }
  if (existsSync(SWEBENCH_GOLD)) {
    const gold: unknown = JSON.parse(readFileSync(SWEBENCH_GOLD, 'utf8'));
    if (typeof gold === 'object' && gold !== null) {
      for (const [id, patch] of Object.entries(gold)) {
        if (typeof patch !== 'string') continue;
        const added = patch
          .split('\n')
          .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
          .map((l) => l.slice(1))
          .join('\n');
        addLines(corpus, added, 'swebench/' + id, MIN_LINE_CHARS);
      }
    }
  }
  for (const file of walk(TERMINAL_BENCH_GOLD)) addLines(corpus, readFileSync(file, 'utf8'), 'terminal-bench/' + file.slice(TERMINAL_BENCH_GOLD.length + 1), MIN_LINE_CHARS);
  return corpus;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Every string leaf of a question object (instructions, option descriptions, criteria, examples). */
function stringLeaves(v: unknown, into: string[] = []): string[] {
  if (typeof v === 'string') into.push(v);
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, into);
  else if (typeof v === 'object' && v !== null) for (const x of Object.values(v)) stringLeaves(x, into);
  return into;
}

/** The static question texts of src/synth/sketch/questions.ts and src/synth/beam/state.ts. */
export function questionTexts(): { origin: string; text: string }[] {
  const out: { origin: string; text: string }[] = [];
  const push = (origin: string, v: unknown): void => {
    for (const s of stringLeaves(v)) out.push({ origin, text: norm(s) });
  };
  push('sketch/questions.ts SKETCH_INSTRUCTIONS', SKETCH_INSTRUCTIONS);
  push('sketch/questions.ts EDIT_CLASS_INSTRUCTIONS', EDIT_CLASS_INSTRUCTIONS);
  for (const [k, v] of Object.entries(EDIT_CLASSES)) push(`sketch/questions.ts EDIT_CLASSES.${k}`, v);
  push('sketch/questions.ts editClassQuestion()', editClassQuestion());
  push('beam/state.ts TEMPLATE_QUESTION', TEMPLATE_QUESTION);
  push('beam/state.ts nextTokenQuestion(null)', nextTokenQuestion(null));
  push('beam/state.ts nextTokenQuestion(h)', nextTokenQuestion('h'));
  push('beam/state.ts slotQuestion(null)', slotQuestion(null));
  push('beam/state.ts slotQuestion(h)', slotQuestion('h'));
  push('beam/state.ts currentLineCorrectNoul()', currentLineCorrectNoul());
  return out;
}

export function leaks(texts: readonly { origin: string; text: string }[], corpus: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const { origin, text } of texts) for (const [line, from] of corpus) if (text.includes(line)) found.push(`${origin} contains "${line}" (${from})`);
  return found;
}

describe('no benchmark gold text in the Jev question wordings', () => {
  const corpus = benchmarkCorpus();

  it('builds a non-trivial corpus from bench/data (QuixBugs correct + programs + index, ladder gold-only lines)', () => {
    const origins = [...corpus.values()];
    expect(origins.filter((o) => o.startsWith('quixbugs/correct/')).length).toBeGreaterThan(300);
    expect(origins.filter((o) => o.startsWith('quixbugs/programs/')).length).toBeGreaterThan(20);
    expect(origins.filter((o) => o.startsWith('index.json/')).length).toBeGreaterThan(10);
    expect(origins.filter((o) => o.startsWith('ladder/')).length).toBeGreaterThan(10);
    expect(origins.filter((o) => o.startsWith('swebench/')).length).toBeGreaterThan(30);
    expect(origins.filter((o) => o.startsWith('terminal-bench/')).length).toBeGreaterThan(100);
    // the fragments the audit matched are in the corpus
    expect(corpus.has('enumerate(counts)')).toBe(true);
    expect(corpus.has('gcd(b, a % b)')).toBe(true);
    expect(corpus.has('perm[i] < perm[j]')).toBe(true);
    expect(corpus.has('while lo < hi')).toBe(true);
  });

  it('would have flagged the measured (contaminated) Q7 wording', () => {
    const old = [
      { origin: 'old substitute_one_token', text: norm('Example: `while lo <= hi` -> `while lo < hi`; `enumerate(arr)` -> `enumerate(counts)`') },
      { origin: 'old reorder_tokens', text: norm('Example: `gcd(a % b, b)` -> `gcd(b, a % b)`; `perm[j] < perm[i]` -> `perm[i] < perm[j]`') },
      { origin: 'old delete_fragment', text: norm('Example: `return 1 + f(x)` -> `return f(x)`; `yield flatten(x)` -> `yield x`') },
      { origin: 'old Q5 example', text: norm('`return gcd(a % b, b)` recurses forever where `tests` expect `gcd(b, a % b)`') },
    ];
    const found = leaks(old, corpus);
    expect(found.length).toBeGreaterThanOrEqual(5);
    expect(found.some((f) => f.includes('old substitute_one_token'))).toBe(true);
    expect(found.some((f) => f.includes('old reorder_tokens'))).toBe(true);
    expect(found.some((f) => f.includes('old delete_fragment'))).toBe(true);
    expect(found.some((f) => f.includes('old Q5 example'))).toBe(true);
  });

  it('finds none of the corpus in the current question texts', () => {
    const texts = questionTexts();
    expect(texts.length).toBeGreaterThanOrEqual(12);
    expect(leaks(texts, corpus)).toEqual([]);
  });

  it('every Q7 option keeps the REPORT.md form: a definition and at least two examples', () => {
    for (const [k, v] of Object.entries(EDIT_CLASSES)) {
      const [definition, examples] = v.split('Example:');
      expect(definition?.trim().length ?? 0, k).toBeGreaterThan(20);
      expect((examples ?? '').split(';').filter((e) => e.trim() !== '').length, k).toBeGreaterThanOrEqual(2);
    }
  });
});
