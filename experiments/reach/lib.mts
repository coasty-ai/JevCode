/**
 * Shared helpers of the reach study (experiments/reach/*.mts): gold-diff hunk parsing with old-file
 * numbering, code-token line normalisation, the Site builders that mirror localize/sites.ts, and a
 * private worktree per instance so the shared /tmp/jevonly/repos checkouts are never written to.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { indentOf } from '../../src/synth/py/edits.ts';
import { analyse, blockAt, scopeAt, statementAt } from '../../src/synth/py/structure.ts';
import type { PyModule } from '../../src/synth/py/structure.ts';
import { tokenizeFragment } from '../../src/synth/py/tokenize.ts';
import type { Site, SourceFile } from '../../src/synth/types.ts';

export const REPOS = '/tmp/jevonly/repos';
export const BARE = '/tmp/jevonly/repos/.bare';
export const REACH_WORKTREES = '/tmp/jevonly/reach';

export interface Hunk {
  file: string;
  /** 1-based old line of the first removed line, or the old line before which the insertion goes */
  oldLine: number;
  removed: string[];
  added: string[];
  addedCode: string[];
  removedCode: string[];
  kind: 'single_line_modification' | 'multi_line_modification' | 'pure_insertion' | 'deletion' | 'new_function' | 'non_code_only';
}

export function isCodeLine(text: string): boolean {
  const t = text.trim();
  return t !== '' && !t.startsWith('#');
}

/** Contiguous runs of changed lines of a unified diff, with old-file numbering. */
export function parseHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  let file = '';
  let oldNo = 0;
  let run: { start: number; removed: string[]; added: string[] } | null = null;
  const flush = (): void => {
    if (run === null) return;
    const removedCode = run.removed.filter(isCodeLine);
    const addedCode = run.added.filter(isCodeLine);
    let kind: Hunk['kind'];
    if (removedCode.length === 0 && addedCode.length === 0) kind = 'non_code_only';
    else if (removedCode.length === 0) kind = /^\s*(def|class)\b/.test(addedCode[0] ?? '') ? 'new_function' : 'pure_insertion';
    else if (addedCode.length === 0) kind = 'deletion';
    else if (removedCode.length === 1 && addedCode.length === 1) kind = 'single_line_modification';
    else kind = 'multi_line_modification';
    out.push({ file, oldLine: run.start, removed: run.removed, added: run.added, addedCode, removedCode, kind });
    run = null;
  };
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) {
      flush();
      const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(raw);
      file = m?.[2] ?? '';
      continue;
    }
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('index ')) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h !== null) {
      flush();
      oldNo = Number(h[1]);
      continue;
    }
    if (raw.startsWith('-')) {
      if (run === null) run = { start: oldNo, removed: [], added: [] };
      run.removed.push(raw.slice(1));
      oldNo += 1;
    } else if (raw.startsWith('+')) {
      if (run === null) run = { start: oldNo, removed: [], added: [] };
      run.added.push(raw.slice(1));
    } else {
      flush();
      if (raw.startsWith(' ') || raw === '') oldNo += 1;
    }
  }
  flush();
  return out;
}

/** Code tokens of one physical line joined by one space; '' for blank / comment / untokenizable. */
export function normLine(text: string): string {
  const t = text.trim();
  if (t === '' || t.startsWith('#')) return '';
  try {
    return tokenizeFragment(text)
      .filter((k) => k.type === 'NAME' || k.type === 'NUMBER' || k.type === 'STRING' || k.type === 'OP')
      .map((k) => k.text)
      .join(' ');
  } catch {
    return t.replace(/\s+/g, ' ');
  }
}

export function normLines(lines: readonly string[]): string[] {
  return lines.map(normLine).filter((l) => l !== '');
}

export function splitLines(src: string): string[] {
  const lines = src.split(/\r?\n/);
  if (lines[lines.length - 1] === '' && /\r?\n$/.test(src)) lines.pop();
  return lines;
}

/** `lines` with the given hunks of one file applied (any subset; applied bottom-up so old numbers stay valid). */
export function applyHunksToLines(lines: readonly string[], hunks: readonly Hunk[]): string[] {
  let out = [...lines];
  for (const h of [...hunks].sort((a, b) => b.oldLine - a.oldLine)) {
    out = [...out.slice(0, h.oldLine - 1), ...h.added, ...out.slice(h.oldLine - 1 + h.removed.length)];
  }
  return out;
}

/**
 * A hunk whose changed lines all sit inside a string statement (a docstring edit) is not code: the
 * text-only classifier above cannot see that, the analysed module can.
 */
export function refineKinds(hunks: readonly Hunk[], modOf: (path: string) => PyModule | null): Hunk[] {
  return hunks.map((h) => {
    if (h.kind === 'non_code_only' || h.removed.length === 0) return h;
    const mod = modOf(h.file);
    if (mod === null) return h;
    const inString = (line: number): boolean => {
      const st = statementAt(mod, line);
      return st !== undefined && st.tokens.length > 0 && st.tokens.every((t) => t.type === 'STRING') && st.startLine < line;
    };
    const all = Array.from({ length: h.removed.length }, (_, k) => h.oldLine + k).every(inString);
    return all ? { ...h, kind: 'non_code_only', addedCode: [], removedCode: [] } : h;
  });
}

export function blockOf(mod: PyModule, line: number): Site['block'] {
  const b = blockAt(mod, line);
  return b === undefined ? null : { name: b.name, startLine: b.startLine, endLine: b.endLine };
}

/** A replace site the way localize/sites.ts replaceSite builds one. */
export function replaceSiteAt(file: SourceFile, line: number): Site {
  const text = file.mod.lines[line - 1] ?? '';
  return { file, line, kind: 'replace', currentLine: text, indent: indentOf(text), block: blockOf(file.mod, line), scope: scopeAt(file.mod, line), evidence: { notes: ['gold site'] } };
}

/** An insert site before `line` at `indent` (localize/sites.ts insertSite 'after': scope of the line before the gap). */
export function insertSiteAt(file: SourceFile, line: number, indent: string): Site {
  return { file, line, kind: 'insert', currentLine: '', indent, block: blockOf(file.mod, Math.max(1, line - 1)), scope: scopeAt(file.mod, Math.max(1, line - 1)), evidence: { notes: ['gold gap'] } };
}

export function loadFile(workspace: string, path: string): SourceFile {
  const src = readFileSync(join(workspace, path), 'utf8');
  return { path, src, mod: analyse(src) };
}

export function sh(cmd: string, args: string[], cwd: string, timeoutMs = 600_000): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, timeout: timeoutMs });
}

/** Bare clone name of a repo ("sympy/sympy" → "sympy__sympy.git"). */
export function bareOf(repo: string): string {
  return join(BARE, `${repo.replace('/', '__')}.git`);
}

/** A private detached worktree of `instanceId` at `baseCommit` under /tmp/jevonly/reach (created once, reset to clean on every call). */
export function privateWorktree(instanceId: string, repo: string, baseCommit: string, suffix = ''): string {
  const dir = join(REACH_WORKTREES, `${instanceId}${suffix}`);
  if (!existsSync(dir)) sh('git', ['-C', bareOf(repo), 'worktree', 'add', '--detach', dir, baseCommit], '/tmp');
  sh('git', ['checkout', '--', '.'], dir);
  sh('git', ['clean', '-fdq', '-e', '.venv', '-e', '*.pyc', '-e', '__pycache__'], dir);
  const head = sh('git', ['rev-parse', 'HEAD'], dir).trim();
  if (!head.startsWith(baseCommit.slice(0, 10))) throw new Error(`${dir}: HEAD ${head} is not ${baseCommit}`);
  return dir;
}

/** The newest bench venv python for an instance that starts (`import sys`). */
export function venvPython(instanceId: string): string | null {
  try {
    const out = sh('/bin/sh', ['-c', `ls -d ${process.env['HOME']}/.jevcode/runs/bench-work/*/${instanceId}/*/workspace/.venv/bin/python 2>/dev/null | sort -r | head -5`], '/tmp').trim();
    for (const py of out.split('\n').filter((l) => l !== '')) {
      try {
        execFileSync(py, ['-c', 'import sys'], { timeout: 30_000 });
        return py;
      } catch {
        // next
      }
    }
  } catch {
    // none
  }
  return null;
}

// ---------------------------------------------------------------------------------------- F2P test runs

export interface F2PRecord {
  instance_id: string;
  repo: string;
  fail_to_pass: string[];
  test_patch: string;
}

/** The instance's FAIL_TO_PASS test command with the bench venv python, from the worktree root (PYTHONPATH puts the worktree first). */
export function f2pCommand(rec: F2PRecord, python: string): string {
  if (rec.repo === 'sympy/sympy') {
    const files = [...new Set((rec.test_patch.match(/^\+\+\+ b\/(\S+)/gm) ?? []).map((m) => m.slice('+++ b/'.length)))];
    const kw = rec.fail_to_pass.map((t) => t.split(' ')[0] ?? t);
    return `PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' '${python}' bin/test -C ${files.map((f) => `'${f}'`).join(' ')} ${kw.map((k) => `-k '${k}'`).join(' ')}`;
  }
  if (rec.repo === 'django/django') {
    const labels = rec.fail_to_pass.map((t) => {
      const m = /^(\S+) \(([^)]+)\)$/.exec(t);
      return m === null ? t : `${m[2]}.${m[1]}`;
    });
    return `'${python}' tests/runtests.py --settings=test_sqlite --parallel 1 ${labels.map((l) => `'${l}'`).join(' ')}`;
  }
  return `'${python}' -m pytest -q -p no:cacheprovider ${rec.fail_to_pass.map((t) => `'${t}'`).join(' ')}`;
}

/** Run the F2P tests in `ws`; pass = the runner's own summary says so (sympy "tests finished: N passed", django "OK", pytest "N passed"). */
export function runF2P(rec: F2PRecord, ws: string, python: string): { pass: boolean; ms: number; tail: string } {
  const t0 = Date.now();
  let out = '';
  try {
    out = sh('/bin/sh', ['-c', `cd '${ws}' && PYTHONPATH='${ws}' PYTHONDONTWRITEBYTECODE=1 ${f2pCommand(rec, python)} 2>&1`], ws, 600_000);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    out = `${err.stdout ?? ''}${err.stderr ?? ''}` || (err.message ?? '');
  }
  let pass: boolean;
  if (rec.repo === 'sympy/sympy') pass = /tests finished: \d+ passed/.test(out) && !/\d+ (failed|exceptions?|expected to fail but passed)/.test(out);
  else if (rec.repo === 'django/django') pass = /^OK\b/m.test(out) && !/^FAILED/m.test(out);
  else pass = /\b\d+ passed\b/.test(out) && !/\b\d+ (failed|error)/.test(out);
  return { pass, ms: Date.now() - t0, tail: out.slice(-400) };
}
