/** Site construction and QuixBugs loading shared by the synth/mutate unit tests (offline, no Jev, no Python). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse, blockAt, scopeAt } from '../../../../src/synth/py/structure.js';
import type { EnumerateOptions, Site, SourceFile } from '../../../../src/synth/types.js';
import type { MutationContext } from '../../../../src/synth/mutate/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const QUIXBUGS = join(here, '../../../../bench/data/quixbugs');

export function sourceFile(path: string, src: string): SourceFile {
  return { path, src, mod: analyse(src) };
}

/** A replace site on `line` of `src`, or an insert site before `line` with the given indent. */
export function siteFor(src: string, line: number, kind: 'replace' | 'insert' = 'replace', indent?: string, path = 'prog.py'): Site {
  const file = sourceFile(path, src);
  const lineText = file.mod.lines[line - 1] ?? '';
  const b = blockAt(file.mod, line);
  return {
    file,
    line,
    kind,
    currentLine: kind === 'insert' ? '' : lineText,
    indent: indent ?? /^\s*/.exec(lineText)![0],
    block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine },
    scope: scopeAt(file.mod, line),
    evidence: { notes: [] },
  };
}

export function options(over: Partial<EnumerateOptions> = {}): EnumerateOptions {
  return { cap: 400, testLiterals: [], taskIdentifiers: [], corpus: new Map(), ...over };
}

/** A small hand-written context for operator-level tests. */
export function ctx(over: Partial<MutationContext> = {}): MutationContext {
  return {
    valueNames: ['a', 'b', 'n', 'lo', 'hi'],
    callNames: ['f', 'len', 'max', 'min', 'any', 'all'],
    attrNames: ['successor', 'successors', 'append', 'add'],
    methodNames: ['append', 'add'],
    intLiterals: ['0', '1', '2', '-1', '10'],
    floatLiterals: ['0.5', '2.0'],
    strLiterals: ["''", "'x'"],
    comparisons: ['k < n'],
    ...over,
  };
}

export interface QuixBugsRecord {
  name: string;
  bugLine: number;
  buggyLine: string | null;
  fixedLine: string;
  hasJsonTests: boolean;
}

export function quixbugsIndex(): QuixBugsRecord[] {
  return JSON.parse(readFileSync(join(QUIXBUGS, 'index.json'), 'utf8')) as QuixBugsRecord[];
}

/** Integer and short string literals from the first three JSON test cases, as the loop's test-value extractor would pass them. */
export function quixbugsTestLiterals(r: QuixBugsRecord): string[] {
  if (!r.hasJsonTests) return [];
  const cases = JSON.parse(readFileSync(join(QUIXBUGS, 'tests', `${r.name}.json`), 'utf8')) as { input: unknown; expected: unknown }[];
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) < 1000) out.add(String(v));
    else if (typeof v === 'string' && v.length <= 12) out.add(`'${v.replace(/'/g, "\\'")}'`);
    else if (Array.isArray(v)) v.slice(0, 20).forEach(walk);
  };
  for (const c of cases.slice(0, 3)) {
    walk(c.input);
    walk(c.expected);
  }
  return [...out].slice(0, 10);
}

/** The site for a QuixBugs record: replace on `bugLine`, or insert before it with the gold line's indent. */
export function quixbugsSite(r: QuixBugsRecord): Site {
  const src = readFileSync(join(QUIXBUGS, 'programs', `${r.name}.py`), 'utf8');
  if (r.buggyLine !== null) return siteFor(src, r.bugLine, 'replace', undefined, `${r.name}.py`);
  const correct = readFileSync(join(QUIXBUGS, 'correct', `${r.name}.py`), 'utf8').split('\n');
  const gold = correct.find((l) => l.trim() === r.fixedLine) ?? r.fixedLine;
  return siteFor(src, r.bugLine, 'insert', /^\s*/.exec(gold)![0], `${r.name}.py`);
}
