/**
 * Pure application of a Candidate to source text: the site edit plus `extraEdits`, and a
 * `git apply`-ready unified diff over every touched file (py/edits.ts does the line work).
 *
 * Line-number convention: every line number (the site's and each extra edit's) refers to the
 * file BEFORE the candidate is applied. Edits are applied bottom-up per file so no edit shifts
 * another's line; two edits on the same line keep list order (the site edit first). This lets a
 * candidate source compute all its numbers from the one analysis it already has.
 */
import { deleteLine, indentOf, insertLine, lineCount, reindent, replaceLine, splitPhysicalLines } from '../py/index.js';
import { unifiedDiff } from '../py/edits.js';
import type { AppliedCandidate, Candidate, LineEdit, SourceFile } from '../types.js';
import { VerifyError } from './types.js';

/**
 * The text to put in the file: when the candidate's text already carries indentation (first
 * line starts with whitespace) it is taken verbatim, otherwise it is re-indented to `indent`
 * (relative indentation of multi-line text is kept). Both forms occur across candidate sources.
 */
export function indentedText(text: string, indent: string): string {
  if (text === '') return text;
  return /^[ \t]/.test(text) ? text : reindent(text, indent);
}

function applyOne(src: string, edit: LineEdit, indent: string): string {
  const count = lineCount(src);
  switch (edit.kind) {
    case 'replace': {
      if (edit.text === undefined) throw new VerifyError(`replace edit at ${edit.path}:${edit.line} has no text`);
      return replaceLine(src, edit.line, indentedText(edit.text, indent));
    }
    case 'insert': {
      if (edit.text === undefined) throw new VerifyError(`insert edit at ${edit.path}:${edit.line} has no text`);
      // `line` is the line BEFORE which to insert; count + 1 appends. insertLine re-indents to
      // the indent it is given, so hand it the text's own first-line indent to keep it as is.
      if (edit.line < 1 || edit.line > count + 1) throw new VerifyError(`insert line ${edit.line} out of range 1..${count + 1} in ${edit.path}`);
      const full = indentedText(edit.text, indent);
      return insertLine(src, edit.line - 1, full, indentOf(full.split('\n')[0] ?? ''));
    }
    case 'delete':
      return deleteLine(src, edit.line);
  }
}

/** Site edit as a LineEdit, so the site and the extras go through one path. */
function siteEdit(c: Candidate): LineEdit {
  return { path: c.site.file.path, line: c.site.line, kind: c.site.kind, text: c.text };
}

/**
 * Apply `candidate` to the current sources. `files` (path → current SourceFile) overrides the
 * snapshot held by the site when the search has already accepted earlier candidates; files not
 * in the map fall back to `candidate.site.file`. Throws VerifyError when the site is stale (the
 * line to replace no longer reads `site.currentLine`) or an edit is out of range.
 */
export function applyCandidate(candidate: Candidate, files?: ReadonlyMap<string, SourceFile>): AppliedCandidate {
  const sitePath = candidate.site.file.path;
  const current = (path: string): string => {
    const f = files?.get(path);
    if (f !== undefined) return f.src;
    if (path === sitePath) return candidate.site.file.src;
    throw new VerifyError(`extra edit targets ${path}, which is not in the provided files`);
  };

  const edits: LineEdit[] = [siteEdit(candidate), ...(candidate.extraEdits ?? [])];
  const byPath = new Map<string, LineEdit[]>();
  for (const e of edits) {
    const list = byPath.get(e.path) ?? [];
    list.push(e);
    byPath.set(e.path, list);
  }

  const before = current(sitePath);
  if (candidate.site.kind === 'replace') {
    const lines = splitPhysicalLines(before);
    const have = lines[candidate.site.line - 1];
    if (have === undefined || have.replace(/\r$/, '') !== candidate.site.currentLine) {
      throw new VerifyError(`stale site: ${sitePath}:${candidate.site.line} reads ${JSON.stringify(have ?? null)}, expected ${JSON.stringify(candidate.site.currentLine)}`);
    }
  }

  const touched: { path: string; before: string; after: string }[] = [];
  let diff = '';
  for (const [path, list] of byPath) {
    const src = current(path);
    const original = splitPhysicalLines(src);
    // The indent bare text is re-indented to: the site's own for the site edit; for extra edits
    // the original line at that position (the replaced line, or the line inserted before), '' when
    // appending past the end. Bottom-up order keeps every original line number valid.
    const indentFor = (e: LineEdit, isSite: boolean): string => (isSite ? candidate.site.indent : indentOf(original[e.line - 1] ?? ''));
    // Same-line order (why): replace/delete act on the ORIGINAL line, so they must run before an
    // insert at that line shifts it; several inserts before one line each land above the previous
    // one, so they run in reverse list order to read in list order (site text first, extras after).
    const rank = (e: LineEdit): number => (e.kind === 'insert' ? 1 : 0);
    const ordered = list.map((e, k) => ({ e, k })).sort((a, b) => b.e.line - a.e.line || rank(a.e) - rank(b.e) || (a.e.kind === 'insert' ? b.k - a.k : a.k - b.k));
    let out = src;
    for (const { e, k } of ordered) out = applyOne(out, e, indentFor(e, path === sitePath && k === 0));
    touched.push({ path, before: src, after: out });
    const d = unifiedDiff(path, src, out);
    if (d !== '') diff += d.endsWith('\n') ? d : `${d}\n`;
  }
  return { candidate, files: touched, diff };
}
