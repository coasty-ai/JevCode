/**
 * QuixBugs loading shared by the prototype: programs, tests, and the ground-truth fix line
 * (computed from correct_python_programs, used only for measurement, never shown to Jev).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../../src/core/types.ts';

import { fileURLToPath } from 'node:url';
/** Self-contained copy of QuixBugs at a pinned commit (bench/data/quixbugs/README.md); override with QUIXBUGS_ROOT. */
export const QUIX_ROOT = process.env['QUIXBUGS_ROOT'] ?? fileURLToPath(new URL('../../bench/data/quixbugs/', import.meta.url));

export const GRAPH_PROGRAMS = new Set([
  'breadth_first_search', 'depth_first_search', 'detect_cycle', 'minimum_spanning_tree', 'reverse_linked_list',
  'shortest_path_length', 'shortest_path_lengths', 'shortest_paths', 'topological_ordering',
]);

export type FixKind = 'replace' | 'insert' | 'delete' | 'multi' | 'none';

export interface Truth {
  kind: FixKind;
  /** 0-based index into `buggyLines` of the line that must change (for insert: the line the new line goes before). -1 if unknown. */
  buggyLineIndex: number;
  buggyLine: string;
  /** the correct replacement line (replace), the inserted line (insert), null otherwise */
  fixedLine: string | null;
}

export interface QuixProgram {
  name: string;
  kind: 'json' | 'pytest';
  /** code-only source (trailing docstring stripped), blank lines kept */
  buggySource: string;
  buggyLines: string[];
  correctSource: string;
  correctLines: string[];
  /** indices into buggyLines that are code (non-blank, not comment-only) */
  codeLineIndices: number[];
  /** JSON tests as [inputArgs[], expected] pairs (inputs normalised to an argument list); null for pytest programs */
  tests: [Json[], Json][] | null;
  /** per-test flags (slow tests are skipped by the runner, mirroring QuixBugs' pytest suite) */
  testMeta: { slow: boolean; timeout: number | null }[] | null;
  testsPath: string | null;
  /** python_testcases/test_<name>.py source, for pytest programs (also exists for json ones) */
  pytestSource: string;
  pytestPath: string;
  nodeSource: string | null;
  truth: Truth;
}

/** Lines of the program up to the trailing docstring QuixBugs appends (and, for correct files, before the alternative versions). */
export function codeOnly(src: string): string[] {
  const i = src.indexOf('\n"""');
  return (i > 0 ? src.slice(0, i) : src).replace(/\s+$/, '').split('\n');
}

/** Remove a trailing `# comment` (naive: a `#` outside quotes). */
export function stripComment(line: string): string {
  let inS: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inS) { if (ch === inS) inS = null; else if (ch === '\\') i++; continue; }
    if (ch === '"' || ch === "'") inS = ch;
    else if (ch === '#') return line.slice(0, i).replace(/\s+$/, '');
  }
  return line;
}

/** Comparison key: comment-free, trimmed, whitespace collapsed. */
export function normLine(line: string): string {
  return stripComment(line).trim().replace(/\s+/g, ' ');
}

export function isCodeLine(line: string): boolean {
  const t = line.trim();
  return t !== '' && !t.startsWith('#');
}

function computeTruth(buggyLines: string[], correctLines: string[]): Truth {
  const bi = buggyLines.map((l, i) => i).filter((i) => isCodeLine(buggyLines[i]!));
  const ci = correctLines.map((l, i) => i).filter((i) => isCodeLine(correctLines[i]!));
  const b = bi.map((i) => normLine(buggyLines[i]!));
  const c = ci.map((i) => normLine(correctLines[i]!));
  const none: Truth = { kind: 'none', buggyLineIndex: -1, buggyLine: '', fixedLine: null };
  if (b.length === c.length) {
    const d = b.map((_, i) => i).filter((i) => b[i] !== c[i]);
    if (d.length === 0) return none;
    const k = d[0]!;
    return { kind: d.length === 1 ? 'replace' : 'multi', buggyLineIndex: bi[k]!, buggyLine: buggyLines[bi[k]!]!, fixedLine: correctLines[ci[k]!]! };
  }
  if (c.length === b.length + 1) {
    for (let k = 0; k <= b.length; k++) {
      const cc = [...c.slice(0, k), ...c.slice(k + 1)];
      if (cc.every((l, i) => l === b[i])) {
        const idx = k < bi.length ? bi[k]! : buggyLines.length - 1;
        return { kind: 'insert', buggyLineIndex: idx, buggyLine: buggyLines[idx]!, fixedLine: correctLines[ci[k]!]! };
      }
    }
  }
  if (b.length === c.length + 1) {
    for (let k = 0; k < b.length; k++) {
      const bb = [...b.slice(0, k), ...b.slice(k + 1)];
      if (bb.every((l, i) => l === c[i])) return { kind: 'delete', buggyLineIndex: bi[k]!, buggyLine: buggyLines[bi[k]!]!, fixedLine: null };
    }
  }
  const k = b.findIndex((l, i) => l !== c[i]);
  return { kind: 'multi', buggyLineIndex: k >= 0 && k < bi.length ? bi[k]! : -1, buggyLine: k >= 0 && k < bi.length ? buggyLines[bi[k]!]! : '', fixedLine: null };
}

export function listPrograms(): string[] {
  return readdirSync(join(QUIX_ROOT, 'programs'))
    .filter((f) => f.endsWith('.py') && f !== 'node.py')
    .map((f) => f.slice(0, -3))
    .sort();
}

export function loadProgram(name: string): QuixProgram {
  const buggyLines = codeOnly(readFileSync(join(QUIX_ROOT, 'programs', `${name}.py`), 'utf8'));
  const correctLines = codeOnly(readFileSync(join(QUIX_ROOT, 'correct', `${name}.py`), 'utf8'));
  const kind = GRAPH_PROGRAMS.has(name) ? 'pytest' : 'json';
  const testsPath = join(QUIX_ROOT, 'tests', `${name}.json`);
  let tests: [Json[], Json][] | null = null;
  let testMeta: { slow: boolean; timeout: number | null }[] | null = null;
  if (kind === 'json' && existsSync(testsPath)) {
    const cases = JSON.parse(readFileSync(testsPath, 'utf8')) as { input: Json[]; expected: Json; slow?: boolean; timeout?: number }[];
    tests = cases.map((c) => [Array.isArray(c.input) ? c.input : [c.input], c.expected]);
    testMeta = cases.map((c) => ({ slow: c.slow === true, timeout: typeof c.timeout === 'number' ? c.timeout : null }));
  }
  const pytestPath = join(QUIX_ROOT, 'tests', `${name}_test.py`);
  const nodePath = join(QUIX_ROOT, 'programs', 'node.py');
  return {
    name, kind,
    buggySource: buggyLines.join('\n') + '\n', buggyLines,
    correctSource: correctLines.join('\n') + '\n', correctLines,
    codeLineIndices: buggyLines.map((_, i) => i).filter((i) => isCodeLine(buggyLines[i]!)),
    tests, testMeta, testsPath: tests ? testsPath : null,
    pytestSource: existsSync(pytestPath) ? readFileSync(pytestPath, 'utf8') : '', pytestPath,
    nodeSource: kind === 'pytest' ? readFileSync(nodePath, 'utf8') : null,
    truth: computeTruth(buggyLines, correctLines),
  };
}

/** Program source with line `index` (into buggyLines) replaced by `newLine`. */
export function applyReplacement(lines: string[], index: number, newLine: string): string {
  const out = lines.slice();
  out[index] = newLine;
  return out.join('\n') + '\n';
}

/** The function name QuixBugs calls: the program name. */
export function entryFunction(p: QuixProgram): string {
  return p.name;
}

if (process.argv[1]?.endsWith('quixbugs.mts')) {
  for (const n of listPrograms()) {
    const p = loadProgram(n);
    console.log(`${n.padEnd(28)} ${p.kind.padEnd(6)} tests=${p.tests ? p.tests.length : '-'} code=${p.codeLineIndices.length} truth=${p.truth.kind.padEnd(7)} L${p.truth.buggyLineIndex + 1} ${JSON.stringify(p.truth.buggyLine.trim())} -> ${JSON.stringify(p.truth.fixedLine?.trim() ?? null)}`);
  }
}
