/** Site construction and fixture loading shared by the template unit tests. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse, blockAt, deleteLine, indentOf, insertLine, replaceLine, scopeAt } from '../../../../../src/jev-modes/synth/py/index.js';
import type { Candidate, EnumerateOptions, Site, SourceFile } from '../../../../../src/jev-modes/synth/types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, '../../../../..');
export const QUIXBUGS = join(REPO, 'bench/data/quixbugs/programs');
export const LADDER = join(REPO, 'bench/data/ladder/tasks');
export const FIXTURES = join(REPO, 'test/fixtures/synth/templates');

export function sourceFile(path: string, absPath = path): SourceFile {
  const src = readFileSync(absPath, 'utf8');
  return { path, src, mod: analyse(src) };
}

export function sourceFromText(path: string, src: string): SourceFile {
  return { path, src, mod: analyse(src) };
}

/** A replace site on `line` of `file` (current text and indent read from the source). */
export function replaceSite(file: SourceFile, line: number): Site {
  const currentLine = file.mod.lines[line - 1] ?? '';
  const b = blockAt(file.mod, line);
  return {
    file,
    line,
    kind: 'replace',
    currentLine,
    indent: indentOf(currentLine),
    block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine },
    scope: scopeAt(file.mod, line),
    evidence: { notes: ['test'] },
  };
}

/** An insert site before `line` of `file` at `indent` columns. */
export function insertSite(file: SourceFile, line: number, indent: number): Site {
  const b = blockAt(file.mod, line);
  return {
    file,
    line,
    kind: 'insert',
    currentLine: '',
    indent: ' '.repeat(indent),
    block: b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine },
    scope: scopeAt(file.mod, line),
    evidence: { notes: ['test'] },
  };
}

export function options(over: Partial<EnumerateOptions> = {}): EnumerateOptions {
  // 254 mirrors the Choice limit: what survives the cap is what Jev can see
  return { cap: 254, testLiterals: [], taskIdentifiers: [], corpus: new Map(), ...over };
}

/** Whitespace-insensitive line comparison (indentation and spacing are not what a template gets wrong). */
export function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Apply a candidate to its file the way the search will: every line number refers to the
 * original file, so edits are applied bottom-up (`insert` at `line` inserts before that line).
 */
export function applyCandidate(c: Candidate): string {
  const edits: { line: number; kind: 'replace' | 'insert' | 'delete'; text: string; indent: string | null }[] = [
    { line: c.site.line, kind: c.site.kind, text: c.text, indent: c.site.kind === 'insert' ? c.site.indent : null },
    ...(c.extraEdits ?? []).map((e) => ({ line: e.line, kind: e.kind, text: e.text ?? '', indent: null })),
  ];
  edits.sort((a, b) => b.line - a.line);
  let src = c.site.file.src;
  for (const e of edits) {
    if (e.kind === 'replace') src = replaceLine(src, e.line, e.text);
    else if (e.kind === 'insert') src = insertLine(src, e.line - 1, e.text, e.indent ?? indentOf(e.text.split('\n')[0] ?? ''));
    else src = deleteLine(src, e.line);
  }
  return src;
}

/** Run CPython's compile() over many sources in one process; returns the ids that fail with the message. */
export function compileFailures(items: { id: string; src: string }[]): { id: string; error: string }[] {
  const out = execFileSync('python3', [join(FIXTURES, 'compile_check.py')], { input: JSON.stringify(items), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out) as { id: string; error: string }[];
}

/** `git apply --check` of `diff` against a fresh repo holding `files` (path -> content). */
export function gitApplyCheck(files: ReadonlyMap<string, string>, diff: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jevcode-tpl-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    for (const [path, content] of files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], { cwd: dir });
    writeFileSync(join(dir, 'cand.diff'), diff);
    try {
      execFileSync('git', ['apply', '--check', 'cand.diff'], { cwd: dir, stdio: 'pipe' });
      return { ok: true, output: '' };
    } catch (e) {
      return { ok: false, output: e instanceof Error ? e.message : String(e) };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
