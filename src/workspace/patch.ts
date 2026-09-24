/**
 * Unified-diff application through `git apply` (DESIGN.md §8, §19.3; research 09 §2.2).
 *
 * TUI-DESIGN-4 §6.7 (D-Z): `gitFirstError` kept only the **first** `error:` line, so git's two-line diagnosis
 * (`error: patch failed: f:12` *and* `error: f: patch does not apply`) reached the user as half a sentence.
 * `parsePatchErrors` types the whole thing — `{ file, line, message }` per pair — `patchFailureMessage` builds the
 * one-line `patch failed: <file>:<line> — <message>` the outcome carries, and `patchHunkDetail` the TUI-only body.
 * **Partial apply stays impossible** (`--check` first, never `--reject`), so no message here may suggest a
 * half-applied tree.
 *
 * Header paths are validated with resolveInside(write) before git sees the diff so the
 * generator gets a clear PathEscapeError instead of a stray `tmp/...` directory (git strips
 * a leading `/` under -p1 and re-roots the path). `--check` runs first; only then the real
 * apply, so a failing hunk leaves the tree untouched. Never `--unsafe-paths`, `--3way`
 * or `--reject`.
 */
import { unlink } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';

import type { Sandbox } from '../core/types.js';
import { writeFileAtomic } from '../core/atomic.js';
import { PatchError } from '../errors.js';
import { resolveInside } from '../sandbox/paths.js';
import { apply, applyCheck } from './git.js';

export const MAX_PATCH_BYTES = 4 * 1024 * 1024;

export interface PatchFile {
  /** path after stripping the first component (-p1); null for /dev/null */
  oldPath: string | null;
  newPath: string | null;
}

function unquote(raw: string): string {
  // git quotes paths with unusual bytes as C strings.
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  return raw
    .slice(1, -1)
    .replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\([\\"tnr])/g, (_, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c === 'r' ? '\r' : c));
}

/** Strip the `a/` or `b/` prefix (any single leading component, as -p1 does). */
function stripOne(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('/')) throw new PatchError(`header path "${p}" is absolute`, p);
  const slash = p.indexOf('/');
  if (slash === -1) throw new PatchError(`header path "${p}" has no directory prefix to strip (-p1)`, p);
  return p.slice(slash + 1);
}

function headerPath(line: string, marker: string): string {
  let rest = line.slice(marker.length);
  // `--- a/x\t<timestamp>`: git never emits timestamps, but GNU diff does.
  if (!rest.startsWith('"')) {
    const tab = rest.indexOf('\t');
    if (tab !== -1) rest = rest.slice(0, tab);
  }
  return unquote(rest.trim());
}

/** `diff --git a/x b/y` -> the two paths (quoted or, failing an equal-name split, at the first ` b/`). */
function parseDiffGitLine(line: string): PatchFile | null {
  const rest = line.slice('diff --git '.length).trim();
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/.exec(rest);
    return m ? { oldPath: stripOne(unquote(m[1]!)), newPath: stripOne(unquote(m[2]!)) } : null;
  }
  // Names with spaces are not quoted here, so prefer the split where both names agree.
  let at = rest.indexOf(' b/');
  while (at !== -1) {
    const a = rest.slice(0, at);
    const b = rest.slice(at + 1);
    if (a.length > 2 && a.slice(2) === b.slice(2)) return { oldPath: stripOne(a), newPath: stripOne(b) };
    at = rest.indexOf(' b/', at + 1);
  }
  at = rest.indexOf(' b/');
  if (at === -1) return null;
  return { oldPath: stripOne(rest.slice(0, at)), newPath: stripOne(rest.slice(at + 1)) };
}

/**
 * Files named on `---`/`+++` header pairs, rename-only headers, and `diff --git` headers that
 * carry no text hunks (mode-only or binary changes). Hunk bodies are skipped by counting the
 * lines each `@@` header announces, so a removed `-- comment` line (which reads `--- comment`
 * in the diff) is never mistaken for a file header.
 */
export function parsePatchFiles(diff: string): PatchFile[] {
  const files: PatchFile[] = [];
  const lines = diff.split('\n');
  let pendingOld: string | null | undefined;
  let renameFrom: string | null = null;
  let gitHeader: PatchFile | null = null;
  let gitHeaderUsed = false;
  let oldLeft = 0;
  let newLeft = 0;
  const flushGitHeader = (): void => {
    if (gitHeader && !gitHeaderUsed) files.push(gitHeader);
    gitHeader = null;
    gitHeaderUsed = false;
  };
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      const c = line.charAt(0);
      if (c === ' ' || line.length === 0) {
        oldLeft--;
        newLeft--;
        continue;
      }
      if (c === '-') {
        oldLeft--;
        continue;
      }
      if (c === '+') {
        newLeft--;
        continue;
      }
      if (c === '\\') continue;
      // anything else ends the hunk early (malformed input); git will report it
      oldLeft = 0;
      newLeft = 0;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    if (line.startsWith('diff --git ')) {
      flushGitHeader();
      pendingOld = undefined;
      renameFrom = null;
      gitHeader = parseDiffGitLine(line);
      continue;
    }
    if (line.startsWith('--- ') && pendingOld === undefined) {
      pendingOld = stripOne(headerPath(line, '--- '));
      continue;
    }
    if (line.startsWith('+++ ') && pendingOld !== undefined) {
      files.push({ oldPath: pendingOld, newPath: stripOne(headerPath(line, '+++ ')) });
      gitHeaderUsed = true;
      pendingOld = undefined;
      continue;
    }
    if (line.startsWith('rename from ')) renameFrom = line.slice('rename from '.length);
    else if (line.startsWith('rename to ') && renameFrom !== null) {
      files.push({ oldPath: renameFrom, newPath: line.slice('rename to '.length) });
      gitHeaderUsed = true;
      renameFrom = null;
    }
  }
  flushGitHeader();
  return files;
}

export interface ApplyPatchDeps {
  sandbox: Sandbox;
  ws: string;
  runDir: string;
  assertNotSecret: (relPath: string, canonical: string) => void;
  /** the workspace is a strict subdirectory of its repository: apply as a plain patch (see git.ts) */
  plainApply?: boolean;
}

let patchSeq = 0;

/** Validate every header path, `git apply --check`, then `git apply`; returns changed paths. */
export async function applyPatch(diff: string, deps: ApplyPatchDeps): Promise<{ changedFiles: string[] }> {
  if (typeof diff !== 'string' || diff.trim().length === 0) throw new PatchError('empty diff', '');
  if (Buffer.byteLength(diff, 'utf8') > MAX_PATCH_BYTES) throw new PatchError(`diff exceeds ${MAX_PATCH_BYTES} bytes`, '');
  const files = parsePatchFiles(diff);
  if (files.length === 0) throw new PatchError('no file headers (--- a/x / +++ b/x) found', diff.split('\n').slice(0, 3).join('\n'));

  const changed = new Set<string>();
  for (const f of files) {
    for (const p of [f.oldPath, f.newPath]) {
      if (p === null) continue;
      if (posix.isAbsolute(p) || p.split('/').includes('..')) throw new PatchError(`header path "${p}" is absolute or traverses ..`, p);
      const canonical = await resolveInside(deps.ws, p, 'write');
      deps.assertNotSecret(p, canonical);
    }
    const touched = f.newPath ?? f.oldPath;
    if (touched !== null) changed.add(relative(deps.ws, join(deps.ws, touched)).split('\\').join('/'));
    if (f.oldPath !== null && f.newPath !== null && f.oldPath !== f.newPath) changed.add(f.oldPath);
  }

  const patchFile = join(deps.runDir, 'tmp', `patch-${process.pid}-${++patchSeq}.diff`);
  const text = diff.endsWith('\n') ? diff : `${diff}\n`;
  await writeFileAtomic(patchFile, text, { mkdir: true });
  try {
    const plain = deps.plainApply === true;
    const check = await applyCheck(deps.sandbox, deps.ws, patchFile, { plain });
    // §6.7: git's whole diagnosis, not just its first `error:` line; the raw stderr stays in `hunk` for the detail
    if (!check.ok) throw new PatchError(patchFailureMessage(parsePatchErrors(check.stderr), gitFirstError(check.stderr, 'git apply --check failed')), check.stderr.trim() || check.stdout.trim());
    const applied = await apply(deps.sandbox, deps.ws, patchFile, { plain });
    if (!applied.ok) throw new PatchError(patchFailureMessage(parsePatchErrors(applied.stderr), gitFirstError(applied.stderr, 'git apply failed')), applied.stderr.trim() || applied.stdout.trim());
  } finally {
    await unlink(patchFile).catch(() => undefined);
  }
  return { changedFiles: [...changed] };
}

function gitFirstError(stderr: string, fallback: string): string {
  const line = stderr.split('\n').find((l) => l.startsWith('error:')) ?? stderr.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim() : fallback;
}

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-4 §6.7: git's whole diagnosis, typed
// ---------------------------------------------------------------------------------------

/** One entry of git's diagnosis: the file it names, the line when it gave one, and what it said. */
export interface PatchHunkError {
  readonly file: string;
  readonly line: number | null;
  readonly message: string;
}

/** §6.7 edge 10: 200 failing hunks show the first three rows plus `… +197 more`. */
export const PATCH_HUNK_ROWS_MAX = 3;
/** §6.7: the outcome line carries at most this many of git's messages; the rest go to the TUI-only detail. */
export const PATCH_ERROR_MESSAGES_MAX = 2;

const PATCH_FAILED_RE = /^patch failed: (.+):(\d+)$/;
const FILE_MESSAGE_RE = /^(.+?): (.+)$/;

/**
 * §6.7: git's stderr as a typed list. git normally emits a **pair** — `error: patch failed: <file>:<line>` then
 * `error: <file>: <message>` — and `gitFirstError` threw the second half away. The locale is already pinned
 * (`GIT_ENV` sets `LC_ALL: 'C'`, `src/workspace/git.ts`), so this parse is stable. `[]` for an empty stderr; a
 * stderr with no `error:` line at all yields one entry carrying its first non-empty line.
 */
export function parsePatchErrors(stderr: string): PatchHunkError[] {
  const out: PatchHunkError[] = [];
  let pending: { file: string; line: number } | null = null;
  const flush = (message: string): void => {
    if (pending === null) return;
    out.push({ file: pending.file, line: pending.line, message });
    pending = null;
  };
  let sawError = false;
  for (const raw of stderr.split('\n')) {
    const t = raw.trim();
    if (!t.startsWith('error: ')) continue;
    sawError = true;
    const rest = t.slice('error: '.length).trim();
    const failed = PATCH_FAILED_RE.exec(rest);
    if (failed !== null) {
      flush('patch failed');
      pending = { file: failed[1] ?? '', line: Number(failed[2]) };
      continue;
    }
    const pair = FILE_MESSAGE_RE.exec(rest);
    if (pending !== null && pair !== null && pair[1] === pending.file) {
      flush(pair[2] ?? rest);
      continue;
    }
    if (pending !== null) {
      flush(rest);
      continue;
    }
    if (pair !== null && !pair[1]?.includes(' ')) out.push({ file: pair[1] ?? '', line: null, message: pair[2] ?? rest });
    else out.push({ file: '', line: null, message: rest });
  }
  flush('patch failed');
  if (out.length === 0 && !sawError) {
    const first = stderr.split('\n').find((l) => l.trim().length > 0);
    if (first !== undefined) out.push({ file: '', line: null, message: first.trim() });
  }
  return out;
}

/** `<file>:<line>` · `<file>` · `''` — the place clause of one entry. */
export function patchErrorWhere(h: PatchHunkError): string {
  if (h.file === '') return '';
  return h.line === null ? h.file : `${h.file}:${h.line}`;
}

/**
 * §6.7: the one line the outcome carries — `patch failed: calc/ops.py:12 — patch does not apply`, at most
 * `PATCH_ERROR_MESSAGES_MAX` of git's messages joined by `; `. `fallback` when git said nothing usable.
 */
export function patchFailureMessage(hunks: readonly PatchHunkError[], fallback: string): string {
  if (hunks.length === 0) return fallback;
  const parts = hunks.slice(0, PATCH_ERROR_MESSAGES_MAX).map((h) => {
    const where = patchErrorWhere(h);
    return where === '' ? h.message : `${where} — ${h.message}`;
  });
  return `patch failed: ${parts.join('; ')}`;
}

/** §6.7: the TUI-only detail body — one row per entry, the first three plus `… +N more` (edge 10). */
export function patchHunkDetail(hunks: readonly PatchHunkError[]): string {
  if (hunks.length === 0) return '';
  const rows = hunks.slice(0, PATCH_HUNK_ROWS_MAX).map((h) => {
    const where = patchErrorWhere(h);
    return where === '' ? h.message : `${where}   ${h.message}`;
  });
  if (hunks.length > PATCH_HUNK_ROWS_MAX) rows.push(`… +${hunks.length - PATCH_HUNK_ROWS_MAX} more`);
  return rows.join('\n');
}
