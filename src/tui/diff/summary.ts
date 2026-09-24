/**
 * `editSummary(action)` — the one function that names the files, letters and line counts of **every** edit action
 * (TUI-DESIGN-4 §6.1, D-Z). Before round 4 a `patch` proposal never named a file at all: `describeAction('patch')`
 * read `18 line unified diff` in the title, the `[step N]` row, `transcript.log`, `--plain` and `/copy proposal`
 * (A6-1). This module is pure and ink-free; it is on `plain.ts`'s import path, so it opens no file and spawns
 * nothing.
 *
 * The patch scanner is a **tolerant** sibling of `src/workspace/patch.ts`'s `parsePatchFiles`, not a call into it:
 * that one throws `PatchError` on an absolute or prefix-less header path (it gates `git apply`) and pulls
 * `node:fs/promises` + `sandbox/paths.ts` in with it, while a summary must degrade to "no summary" and never throw
 * on the first-frame path (§6.1 edge 1). Hunk bodies are skipped by counting the lines each `@@` header announces,
 * so a removed `-- comment` line is never read as a header and a diff-of-a-diff body line is never read as one
 * either (§6.2 edge 13).
 */
import type { Action } from '../../core/types.js';
// §14.2 review item 13: the pure line diff and the one git-header parser — `undo/diff.ts` would pull
// `node:fs/promises`, `checkpoint/images.ts`, `sandbox/paths.ts` and `workspace/git.ts` in behind `lineDiffCounts`
import { headerPath, lineDiffCounts, parseDiffGitLine, safePath, sectionPath } from './text.js';
import { GLYPHS, cellWidth, truncateCells, type GlyphSet } from '../glyphs.js';

/** `M`odified · `A`dded · `D`eleted · `R`enamed · `B`inary (§6.1, §6.3 edge 7). */
export type TouchLetter = 'M' | 'A' | 'D' | 'R' | 'B';

export interface FileTouch {
  /** the path after the change (the `+++` side, which is what `git apply` uses — §6.1 edge 11) */
  path: string;
  /** the rename / copy source, else null */
  from: string | null;
  letter: TouchLetter;
  added: number;
  deleted: number;
  /** §6.1 edge 5: a header that changed only the mode — the row reads `M <path> +0 −0 (mode)` */
  modeOnly?: true;
  /** §6.1 edge 6: `GIT binary patch` / `Binary files … differ` — counts are suppressed, sizes come from the `literal <n>` headers */
  binary?: true;
  /** the `literal <n>` sizes of a binary hunk pair, when git emitted them */
  bytesFrom?: number;
  bytesTo?: number;
}

export interface EditSummary {
  files: FileTouch[];
  added: number;
  deleted: number;
  /** files past `EDIT_SUMMARY_FILE_MAX` whose counts are in the totals but which carry no `FileTouch` row */
  truncatedFiles: number;
}

/** §6.1 edge 7 / edge 12: a patch with more files than this keeps its totals but stops building rows (a 4 MiB patch stays ≤ 5 ms). */
export const EDIT_SUMMARY_FILE_MAX = 200;
/** Names printed inside the `(…)` of the ≥ 3-file form. */
export const EDIT_SUMMARY_NAMES = 3;

// ---------------------------------------------------------------------------------------
// Header parsing (tolerant)
// ---------------------------------------------------------------------------------------

/**
 * The per-file-section accumulator. Exported so `diff/rows.ts` builds its `file` rows through the **same** letter,
 * rename and binary rules: the two parsers used to disagree (a rename with hunks produced one `R` touch here and
 * two `file` rows there, the first with letter `A` and `+0 −0`), which is §14.2 review items 3 and 4.
 */
export interface TouchDraft {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  added: number;
  deleted: number;
  created: boolean;
  deletedFile: boolean;
  binary: boolean;
  bytes: number[];
  modeSeen: boolean;
  bodySeen: boolean;
}

export function newTouchDraft(): TouchDraft {
  return { oldPath: null, newPath: null, renameFrom: null, renameTo: null, added: 0, deleted: 0, created: false, deletedFile: false, binary: false, bytes: [], modeSeen: false, bodySeen: false };
}

export function finishTouch(d: TouchDraft): FileTouch | null {
  // §6.1 edge 9: a header path is one line and carries no control byte before it leaves this module. git quotes a
  // path containing a newline or an ESC, `unquote` turns the escape back into the real byte, and a raw `\n` in the
  // card's title or a summary row tears the box open while `cellWidth` still scores the row as fitting. Every
  // producer above already ran `safePath`; this is the one place that guarantees it for a path from anywhere.
  const from = safePathOrNull(d.renameFrom ?? (d.oldPath !== null && d.newPath !== null && d.oldPath !== d.newPath ? d.oldPath : null));
  const path = safePathOrNull(d.renameTo ?? d.newPath ?? d.oldPath ?? d.renameFrom);
  if (path === null || path === '') return null;
  let letter: TouchLetter;
  if (d.binary) letter = 'B';
  else if (d.created || (d.oldPath === null && d.newPath !== null)) letter = 'A';
  else if (d.deletedFile || (d.newPath === null && d.oldPath !== null)) letter = 'D';
  else if (from !== null) letter = 'R';
  else letter = 'M';
  const touch: FileTouch = { path, from, letter, added: d.binary ? 0 : d.added, deleted: d.binary ? 0 : d.deleted };
  if (d.binary) {
    touch.binary = true;
    if (d.bytes[0] !== undefined) touch.bytesFrom = d.bytes[0];
    if (d.bytes[1] !== undefined) touch.bytesTo = d.bytes[1];
  } else if (d.modeSeen && !d.bodySeen && d.added === 0 && d.deleted === 0 && from === null) {
    touch.modeOnly = true;
  }
  return touch;
}

function safePathOrNull(p: string | null): string | null {
  return p === null ? null : safePath(p);
}

const HUNK_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * §6.1: every file a unified diff touches, with its letter and `+`/`-` counts. Tolerant: an unparseable stretch
 * simply contributes nothing, and nothing here throws. `[]` for a diff with no recognisable header.
 */
export function patchTouches(diff: string): { files: FileTouch[]; truncated: number; added: number; deleted: number } {
  const out: FileTouch[] = [];
  let truncated = 0;
  let added = 0;
  let deleted = 0;
  let draft: TouchDraft | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  const flush = (): void => {
    if (draft === null) return;
    const t = finishTouch(draft);
    draft = null;
    if (t === null) return;
    added += t.added;
    deleted += t.deleted;
    if (out.length < EDIT_SUMMARY_FILE_MAX) out.push(t);
    else truncated += 1;
  };
  const need = (): TouchDraft => (draft ??= newTouchDraft());
  // read through a call: the assignments to `draft` all happen inside these closures, so the outer flow analysis
  // would otherwise narrow the variable to `null` at every use site
  const peek = (): TouchDraft | null => draft;
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      const ch = line.charAt(0);
      if (ch === ' ' || line.length === 0) {
        oldLeft--;
        newLeft--;
        continue;
      }
      if (ch === '-') {
        oldLeft--;
        need().deleted++;
        continue;
      }
      if (ch === '+') {
        newLeft--;
        need().added++;
        continue;
      }
      if (ch === '\\') continue;
      // anything else ends the hunk early (malformed input); git reports it, we keep counting headers
      oldLeft = 0;
      newLeft = 0;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      need().bodySeen = true;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      flush();
      const paths = parseDiffGitLine(line);
      const d = need();
      if (paths !== null) {
        d.oldPath = paths.oldPath;
        d.newPath = paths.newPath;
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      // a `---` after a body is the next file's header only when no `diff --git` announced it
      const open = peek();
      if (open !== null && open.bodySeen) flush();
      need().oldPath = headerPath(line, '--- ');
      continue;
    }
    if (line.startsWith('+++ ')) {
      need().newPath = headerPath(line, '+++ ');
      continue;
    }
    if (line.startsWith('new file mode ')) need().created = true;
    else if (line.startsWith('deleted file mode ')) need().deletedFile = true;
    else if (line.startsWith('old mode ') || line.startsWith('new mode ')) need().modeSeen = true;
    else if (line.startsWith('rename from ')) need().renameFrom = sectionPath(line.slice('rename from '.length));
    else if (line.startsWith('rename to ')) need().renameTo = sectionPath(line.slice('rename to '.length));
    // §6.1 edge 4: a copy is a new file at the destination
    else if (line.startsWith('copy to ')) {
      const d = need();
      d.renameTo = sectionPath(line.slice('copy to '.length));
      d.created = true;
    } else if (line === 'GIT binary patch' || line.startsWith('Binary files ') || line.startsWith('Binary file ')) need().binary = true;
    else {
      const open = peek();
      if (open !== null && open.binary) {
        const lit = /^(?:literal|delta) (\d+)$/.exec(line);
        if (lit) open.bytes.push(Number(lit[1]));
      }
    }
  }
  flush();
  return { files: out, truncated, added, deleted };
}

// ---------------------------------------------------------------------------------------
// editSummary
// ---------------------------------------------------------------------------------------

const EMPTY: unique symbol = Symbol('no-edit-summary');
/** §6.1 edge 12: counting a 5 000-line diff is O(lines) and happens once per `Action`. */
const memo = new WeakMap<object, EditSummary | typeof EMPTY>();

function contentLines(s: string): number {
  if (s.length === 0) return 0;
  const n = s.split('\n').length;
  return s.endsWith('\n') ? n - 1 : n;
}

/**
 * §6.1: the files, letters and counts of an edit action — `null` for `read` / `run` / `done` and for a `patch`
 * whose headers do not parse (the caller then keeps today's `"<N> line unified diff"`). Memoised per `Action`.
 */
export function editSummary(a: Action): EditSummary | null {
  const cached = memo.get(a);
  if (cached !== undefined) return cached === EMPTY ? null : cached;
  const built = build(a);
  memo.set(a, built ?? EMPTY);
  return built;
}

function build(a: Action): EditSummary | null {
  switch (a.kind) {
    case 'read':
    case 'run':
    case 'done':
      return null;
    case 'edit': {
      const { added, deleted } = lineDiffCounts(a.old, a.new);
      return { files: [{ path: safePath(a.path), from: null, letter: 'M', added, deleted }], added, deleted, truncatedFiles: 0 };
    }
    case 'write': {
      const added = contentLines(a.content);
      return { files: [{ path: safePath(a.path), from: null, letter: 'A', added, deleted: 0 }], added, deleted: 0, truncatedFiles: 0 };
    }
    case 'patch': {
      const { files, truncated, added, deleted } = patchTouches(a.diff);
      if (files.length === 0) return null;
      return { files, added, deleted, truncatedFiles: truncated };
    }
  }
}

/** `+12 −3` with the typographic minus (`--ascii` substitutes `-` through `glyphTwin`); `''` for a binary row. */
export function countsText(added: number, deleted: number, g: GlyphSet = GLYPHS.unicode): string {
  return `+${added} ${g.minus}${deleted}`;
}

/** §6.3 item 1 / §6.10: one summary row per file — `M calc/ops.py   +12 −3`, `R old.py → new.py  +0 −0`, `B assets/logo.png  binary (4.1 KiB → 5.0 KiB)`. */
export function fileTouchText(t: FileTouch, cells: number, g: GlyphSet = GLYPHS.unicode): string {
  const name = t.from !== null && t.from !== t.path ? `${t.from} ${g.arrow} ${t.path}` : t.path;
  const tail = t.binary ? `binary${binarySizes(t, g)}` : `${countsText(t.added, t.deleted, g)}${t.modeOnly === true ? ' (mode)' : ''}`;
  return truncateCells(`${t.letter} ${name}  ${tail}`, Math.max(0, cells), g);
}

function binarySizes(t: FileTouch, g: GlyphSet): string {
  if (t.bytesFrom === undefined && t.bytesTo === undefined) return '';
  const a = t.bytesFrom === undefined ? '?' : kib(t.bytesFrom);
  const b = t.bytesTo === undefined ? '?' : kib(t.bytesTo);
  return ` (${a} ${g.arrow} ${b})`;
}

function kib(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '? B';
  if (n < 1024) return `${Math.floor(n)} B`;
  const v = n / 1024;
  return `${v < 10 ? v.toFixed(1) : String(Math.round(v))} KiB`;
}

/**
 * §6.1: the action's target text — one or two files named with their counts (`calc/ops.py +12 −3, README.md +2 −0`),
 * three or more folded to `3 files +14 −3 (calc/ops.py, README.md, other.py)` with a trailing `+N` past three names
 * (edge 7). Cut to `cells`, names dropped before the counts are.
 */
export function editTargetText(s: EditSummary, cells: number, g: GlyphSet = GLYPHS.unicode): string {
  const w = Math.max(0, Math.floor(Number.isFinite(cells) ? cells : 0));
  const total = s.files.length + s.truncatedFiles;
  if (total === 0) return '';
  if (total <= 2) {
    const one = s.files.map((f) => `${f.from !== null && f.from !== f.path ? `${f.from} ${g.arrow} ${f.path}` : f.path} ${f.binary === true ? 'binary' : countsText(f.added, f.deleted, g)}`).join(', ');
    // §14.2 review item 12: the named two-file form is ~45 cells and the card title's target budget is 30, so it
    // used to be hard-truncated — which ate the whole quoted goal after it and left the title ending in `… …`
    // (and, with no quote left in the cut, `closeTitleQuote`'s A6-22 repair could not fire). F-E1 draws the
    // folded form: `patch 2 files +14 −3 "fix the off-by…"`. One file has no folded form worth having.
    if (total === 1 || cellWidth(one) <= w) return truncateCells(one, w, g);
  }
  const head = `${total} files ${countsText(s.added, s.deleted, g)}`;
  const names = s.files.slice(0, EDIT_SUMMARY_NAMES).map((f) => f.path);
  const rest = total - names.length;
  for (let take = names.length; take > 0; take--) {
    const shown = names.slice(0, take);
    const more = total - take;
    const line = `${head} (${shown.join(', ')}${more > 0 ? `, +${more}` : ''})`;
    if (cellWidth(line) <= w) return line;
  }
  void rest;
  return truncateCells(head, w, g);
}

/**
 * §6.2 / §14.2 review item 8: are `diffRows`' two number columns **file** line numbers? For a `patch` and a `write`
 * yes — git's hunk headers are absolute, and a `write` starts at line 1 of a new file. For an `edit` **no**:
 * `Action.edit` is `{ path, old, new }`, an "exact, unique match" snippet, and `actionDiffText` runs
 * `unifiedDiff(a.old, a.new)`, which always numbers from 1. A card that printed `1` for a change at line 400 of the
 * file — with the `old  new` heading standing where the `@@ -400,7 +400,7 @@` row would have been — would be
 * telling the reviewer something untrue about where the change lands, which is §6.2's whole stated rationale for
 * the two columns. So an `edit` keeps its `@@` row, which is honest about being snippet-relative, and drops the
 * columns.
 */
export function diffNumbersAbsolute(a: Action): boolean {
  return a.kind !== 'edit';
}
