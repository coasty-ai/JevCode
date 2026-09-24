/**
 * Pure application of a Candidate to source text: the site edit plus `extraEdits`, and a
 * `git apply`-ready unified diff over every touched file (py/edits.ts does the line work).
 *
 * Line-number convention: every line number (the site's and each extra edit's) refers to the
 * file BEFORE the candidate is applied. Edits are applied bottom-up per file so no edit shifts
 * another's line; two edits on the same line keep list order (the site edit first). This lets a
 * candidate source compute all its numbers from the one analysis it already has.
 *
 * Statement-level sites (`Site.endLine`, localize/sites.ts `statementSiteAt`): the site text
 * replaces the whole physical span `line..endLine` (the first line is replaced, the continuation
 * lines deleted), and the site is stale when the span's code tokens no longer read as the joined
 * `currentLine` (comments and line breaks are not part of the identity). An extra edit that lands
 * inside the span would race the deletion, so it is refused.
 *
 * Block-anchored sites (`Site.span`, docs/LLM-JEV-DESIGN.md §4.7 step 3; llm/candidates.ts): an LLM
 * hunk replaces an arbitrary physical block, whose code tokens may read as '' (a dedenting block),
 * so the site is validated by the sha12 of the span's text (`spanTextSha`) instead, and `text === ''`
 * deletes every span line (the first included: `replaceLine('')` would leave a blank line).
 */
import { sha12 } from '../../../core/hash.js';
import { deleteLine, indentOf, insertLine, lineCount, reindent, replaceLine, splitPhysicalLines } from '../py/index.js';
import { unifiedDiff } from '../py/edits.js';
import { codeTokens, tokenizeFragment } from '../py/tokenize.js';
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

/** Site edit as a LineEdit, so the site and the extras go through one path; a block-anchored deletion (`span`, `text === ''`) deletes the first span line instead of replacing it. */
function siteEdit(c: Candidate): LineEdit {
  if (c.site.span !== undefined && c.site.kind === 'replace' && c.text === '') return { path: c.site.file.path, line: c.site.line, kind: 'delete' };
  return { path: c.site.file.path, line: c.site.line, kind: c.site.kind, text: c.text };
}

/** Last physical line the site edit covers: `span.endLine` of a block-anchored site, `endLine` of a statement-level site, else the site line. */
export function siteSpanEnd(site: Pick<Candidate['site'], 'line' | 'kind' | 'endLine' | 'span'>): number {
  const end = site.span?.endLine ?? site.endLine;
  return site.kind === 'replace' && end !== undefined && end > site.line ? end : site.line;
}

/** sha12 over a span's physical lines joined by '\n' (CR stripped): the identity of a block-anchored site (`Site.span.textSha`). */
export function spanTextSha(lines: readonly string[]): string {
  return sha12(lines.map((l) => l.replace(/\r$/, '')).join('\n'));
}

/**
 * Code tokens of a (possibly multi-line) text joined by one space, a trailing comma before a
 * closing bracket dropped (the joined statement of a site drops it too); '' when it does not tokenize.
 */
function codeTokenKey(text: string): string {
  try {
    const toks = codeTokens(tokenizeFragment(text));
    return toks
      .filter((t, k) => !(t.type === 'OP' && t.text === ',' && toks[k + 1]?.type === 'OP' && /^[)\]}]$/.test(toks[k + 1]!.text)))
      .map((t) => t.text)
      .join(' ');
  } catch {
    return '';
  }
}

/** The continuation lines of a statement-level site as delete edits (before-candidate numbering). */
function spanDeletes(c: Candidate): LineEdit[] {
  const end = siteSpanEnd(c.site);
  const out: LineEdit[] = [];
  for (let l = c.site.line + 1; l <= end; l++) out.push({ path: c.site.file.path, line: l, kind: 'delete' });
  return out;
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

  const spanEnd = siteSpanEnd(candidate.site);
  for (const e of candidate.extraEdits ?? []) {
    if (e.path === sitePath && e.line > candidate.site.line && e.line <= spanEnd) throw new VerifyError(`extra edit at ${e.path}:${e.line} lies inside the statement span ${candidate.site.line}-${spanEnd} the site replaces`);
  }
  const edits: LineEdit[] = [siteEdit(candidate), ...spanDeletes(candidate), ...(candidate.extraEdits ?? [])];
  const byPath = new Map<string, LineEdit[]>();
  for (const e of edits) {
    const list = byPath.get(e.path) ?? [];
    list.push(e);
    byPath.set(e.path, list);
  }

  const before = current(sitePath);
  if (candidate.site.kind === 'replace' && candidate.site.span !== undefined) {
    // a block-anchored (LLM) site: the span must still read the anchored text, byte for byte (§4.7 step 3)
    const lines = splitPhysicalLines(before);
    const span = lines.slice(candidate.site.line - 1, spanEnd);
    if (span.length !== spanEnd - candidate.site.line + 1 || spanTextSha(span) !== candidate.site.span.textSha) {
      throw new VerifyError(`stale llm site: ${sitePath}:${candidate.site.line}-${spanEnd} no longer reads the anchored block`);
    }
  } else if (candidate.site.kind === 'replace') {
    const lines = splitPhysicalLines(before);
    if (spanEnd > candidate.site.line) {
      // a statement-level site: the span's code tokens must still read as the joined statement
      const span = lines.slice(candidate.site.line - 1, spanEnd).map((l) => l.replace(/\r$/, ''));
      const have = span.length === spanEnd - candidate.site.line + 1 ? codeTokenKey(span.join('\n')) : '';
      if (have === '' || have !== codeTokenKey(candidate.site.currentLine)) {
        throw new VerifyError(`stale site: ${sitePath}:${candidate.site.line}-${spanEnd} no longer reads as ${JSON.stringify(candidate.site.currentLine)}`);
      }
    } else {
      const have = lines[candidate.site.line - 1];
      if (have === undefined || have.replace(/\r$/, '') !== candidate.site.currentLine) {
        throw new VerifyError(`stale site: ${sitePath}:${candidate.site.line} reads ${JSON.stringify(have ?? null)}, expected ${JSON.stringify(candidate.site.currentLine)}`);
      }
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
