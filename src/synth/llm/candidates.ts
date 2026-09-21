/**
 * Sample → Candidate (docs/LLM-JEV-DESIGN.md §4.7). Every hunk of a `propose_fix` patch is
 * validated (workspace path, not a test, in the base, ≤ 4 files, ≤ 12 edits, non-empty `old`),
 * anchored to a unique physical span in three tiers (exact → whitespace-normalised → token
 * signature; `near_line` breaks ties within ±20 lines), and the patch becomes one `LlmCandidate`:
 * a block-anchored `Site` whose span is identified by text hash (`Site.span.textSha`) plus
 * `extraEdits` in before-edit numbering for every other hunk. A deletion (`new = ''`) is emitted
 * as `delete` edits for every span line. The candidate is dry-run applied, its post-images are
 * compile-checked through `python3 -c "import ast…"` on a temp file, and identical diffs fold by
 * `sha12(diff)` against the round, the `tried` set and the earlier verdicts (FactGate). The
 * attempt ledger the next prompt shows is built here from `VerifyOutcome`s and dropped hunks.
 *
 * TODO(stage 4, src/synth/verify/apply.ts): `applyCandidate` validates an `llm` site by
 * `site.span.textSha` (and treats `text === ''` as a span deletion) — until then the runner must
 * apply LLM candidates through `applyLlmCandidate` below, which implements exactly that rule.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha12 } from '../../core/hash.js';
import { clip } from '../../core/text.js';
import { deleteLine, indentOf, insertLine, replaceLine, scopeAt, splitPhysicalLines } from '../py/index.js';
import { unifiedDiff } from '../py/edits.js';
import { lineSignature } from '../rank/questions.js';
import { diffHash } from '../search/memory.js';
import { TEST_PATH_RE } from '../search/proposal.js';
import type { VerifyOutcome } from '../search/types.js';
import type { LineEdit, Site, SourceFile } from '../types.js';
import { indentedText } from '../verify/apply.js';
import { VerifyError } from '../verify/types.js';
import type { AttemptRecord, Listing } from './prompt.js';
import { FIX_LIMITS, type PatchSpec } from './schema.js';
import { LLM_SOURCE_NAME, type LlmCandidate, type LlmSite } from './types.js';

// ---------------------------------------------------------------------------------------
// Anchoring (three tiers)
// ---------------------------------------------------------------------------------------

export type AnchorTier = 'exact' | 'whitespace' | 'tokens';
export type AnchorResult = { ok: true; start: number; end: number; tier: AnchorTier } | { ok: false; reason: string };

/** `near_line` breaks ties among several matches only within this distance (the nearest match wins). */
export const NEAR_LINE_WINDOW = 20;

const stripCr = (s: string): string => s.replace(/\r$/, '');
const wsKey = (s: string): string => s.trim().replace(/\s+/g, ' ');

const TIERS: readonly { tier: AnchorTier; key: (s: string) => string }[] = [
  { tier: 'exact', key: stripCr },
  { tier: 'whitespace', key: wsKey },
  { tier: 'tokens', key: (s) => lineSignature(stripCr(s)) },
];

/** `old` as physical lines: CRLF normalised, one trailing newline and surrounding blank lines dropped. */
export function hunkOldLines(old: string): string[] {
  const lines = old.replace(/\r\n/g, '\n').split('\n');
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a]!.trim() === '') a++;
  while (b > a && lines[b - 1]!.trim() === '') b--;
  return lines.slice(a, b);
}

/** `new` normalised the same way, plus trailing whitespace per line (Python is insensitive to it and it makes identical patches hash alike). */
export function hunkNewText(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let a = 0;
  while (a < lines.length && lines[a] === '') a++;
  return lines.slice(a).join('\n');
}

/**
 * Anchor `old` to a unique span of `lines` (1-based `start..end`). Exact match first, then
 * whitespace-normalised, then the code-token signature; a tier with several matches is settled
 * by `near_line` (±20) or the hunk is misanchored — looser tiers can only add matches.
 */
export function anchorHunk(lines: readonly string[], old: string, nearLine = 0): AnchorResult {
  const target = hunkOldLines(old);
  if (target.length === 0) return { ok: false, reason: '`old` is empty' };
  if (target.length > lines.length) return { ok: false, reason: '`old` is longer than the file' };
  for (const { tier, key } of TIERS) {
    const keys = target.map(key);
    if (keys.every((k) => k === '')) continue;
    const matches: number[] = [];
    for (let i = 0; i + target.length <= lines.length; i++) {
      let hit = true;
      for (let j = 0; j < target.length && hit; j++) hit = key(lines[i + j]!) === keys[j];
      if (hit) matches.push(i + 1);
    }
    if (matches.length === 0) continue;
    if (matches.length === 1) return { ok: true, start: matches[0]!, end: matches[0]! + target.length - 1, tier };
    if (nearLine > 0) {
      // the match nearest to near_line wins when it is inside the window and strictly nearer than the runner-up
      const near = matches.filter((m) => Math.abs(m - nearLine) <= NEAR_LINE_WINDOW).sort((a, b) => Math.abs(a - nearLine) - Math.abs(b - nearLine));
      const [best, next] = near;
      if (best !== undefined && (next === undefined || Math.abs(next - nearLine) > Math.abs(best - nearLine))) return { ok: true, start: best, end: best + target.length - 1, tier };
    }
    return { ok: false, reason: `\`old\` matches ${matches.length} places (L${matches.slice(0, 4).join(', L')}${matches.length > 4 ? ', …' : ''})${nearLine > 0 ? ` and near_line ${nearLine} does not single one out` : '; give near_line or add a neighbouring line'}` };
  }
  return { ok: false, reason: '`old` not found' };
}

// ---------------------------------------------------------------------------------------
// Compile check (§4.7 step 4)
// ---------------------------------------------------------------------------------------

export type CompileVerdict = { ok: true } | { ok: false; message: string };
export type CompileCheck = (path: string, source: string) => Promise<CompileVerdict>;

/** The slice of `Sandbox.run` the compile check needs; the wiring binds `ctx.sandbox.run` with its signal and output cap. */
export type CompileRun = (command: string, opts: { timeoutMs: number; cwd?: string }) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

export const COMPILE_TIMEOUT_MS = 10_000;
const COMPILE_SNIPPET = 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])';

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface AstCompileCheck {
  check: CompileCheck;
  /** remove the temp files written so far (called at step end) */
  cleanup(): Promise<void>;
}

/**
 * `python3 -c "import ast,sys; ast.parse(…)" <runDir>/tmp/synth/compile/<sha12>.py` through the
 * sandbox (`Sandbox.run` has no stdin, hence the temp file). The verdict's message is the last
 * stderr line (`SyntaxError: invalid syntax (<sha>.py, line 3)`), bounded.
 */
export function createAstCompileCheck(run: CompileRun, dir: string, python = 'python3'): AstCompileCheck {
  const written = new Set<string>();
  const cache = new Map<string, CompileVerdict>();
  const check: CompileCheck = async (path, source) => {
    const key = sha12(source);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${key}.py`);
    await writeFile(file, source, 'utf8');
    written.add(file);
    const res = await run(`${python} -c ${shellQuote(COMPILE_SNIPPET)} ${shellQuote(file)}`, { timeoutMs: COMPILE_TIMEOUT_MS });
    let verdict: CompileVerdict;
    if (res.exitCode === 0) verdict = { ok: true };
    else {
      const last = `${res.stderr}\n${res.stdout}`.split('\n').map((l) => l.trim()).filter((l) => l !== '').at(-1) ?? `exit ${res.exitCode ?? 'null'}`;
      verdict = { ok: false, message: clip(last.replace(file, path), 200) };
    }
    cache.set(key, verdict);
    return verdict;
  };
  return {
    check,
    cleanup: async () => {
      const files = [...written];
      written.clear();
      await Promise.all(files.map((f) => rm(f, { force: true })));
    },
  };
}

// ---------------------------------------------------------------------------------------
// Sample → Candidate
// ---------------------------------------------------------------------------------------

export type DropReason = 'invalid_path' | 'test_path' | 'not_in_base' | 'too_many_files' | 'too_many_edits' | 'empty_old' | 'misanchored' | 'overlapping' | 'apply_failed' | 'unchanged' | 'syntax_error' | 'compile_failed' | 'duplicate' | 'tried';

export interface DroppedPatch {
  sample: number;
  patch: number;
  reason: DropReason;
  detail: string;
  path?: string;
  /** the diff hash when the patch applied (duplicate / tried / syntax_error / compile_failed) */
  sha?: string;
}

export interface AnchoredHunk {
  path: string;
  start: number;
  end: number;
  tier: AnchorTier;
  /** normalised replacement text; '' deletes the span */
  text: string;
  nearLine: number;
}

/** `AppliedCandidate` for an LLM candidate (structurally the same shape). */
export interface LlmApplied {
  candidate: LlmCandidate;
  files: { path: string; before: string; after: string }[];
  diff: string;
}

export interface ConvertInput {
  sample: number;
  patches: readonly PatchSpec[];
  files: ReadonlyMap<string, SourceFile>;
  /** listing members in rank order; the primary hunk is the one inside the highest-ranked member (§4.7 step 3) */
  listings?: readonly Pick<Listing, 'path' | 'startLine' | 'endLine'>[];
  /** sha12(diff) of every candidate already run this run (`mem.tried`) */
  tried?: ReadonlySet<string>;
  /** the earlier verdict of a tried diff, for the ledger's instant verdict */
  verdictOf?: (sha: string) => string | null;
  /** round-level agreement: sha → the first candidate with that diff; a duplicate bumps its `prior` */
  seen?: Map<string, LlmCandidate>;
  compile?: CompileCheck | null;
}

export interface ConvertResult {
  candidates: LlmCandidate[];
  applied: LlmApplied[];
  dropped: DroppedPatch[];
}

function normalisePath(p: string): string | null {
  const s = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (s === '' || s.startsWith('/') || /^[A-Za-z]:\//.test(s) || s.split('/').includes('..')) return null;
  return s;
}

/** sha12 over the span's physical lines joined by '\n' (CR stripped): the identity `applyLlmCandidate` checks. */
export function llmSpanSha(lines: readonly string[]): string {
  return sha12(lines.map(stripCr).join('\n'));
}

function blockOf(file: SourceFile, line: number): Site['block'] {
  let best: Site['block'] = null;
  let depth = -1;
  for (const b of file.mod.blocks) {
    if (line < b.startLine || line > b.endLine || b.depth <= depth) continue;
    depth = b.depth;
    best = { name: b.name, startLine: b.startLine, endLine: b.endLine };
  }
  return best;
}

/** The block-anchored site for a span of `file` (§4.7 step 3): `currentLine` is the span joined, `span.textSha` its identity. */
export function llmSiteAt(file: SourceFile, start: number, end: number, notes: readonly string[]): LlmSite {
  const lines = file.mod.lines.slice(start - 1, end);
  const first = lines[0] ?? '';
  const site: LlmSite = {
    file,
    line: start,
    kind: 'replace',
    currentLine: lines.join('\n'),
    indent: indentOf(first),
    block: blockOf(file, start),
    scope: scopeAt(file.mod, start),
    evidence: { notes: [...notes] },
    span: { endLine: end, textSha: llmSpanSha(lines) },
  };
  if (end > start) site.endLine = end;
  return site;
}

export function isLlmSite(site: Site): site is LlmSite {
  const span = (site as Partial<LlmSite>).span;
  return typeof span === 'object' && span !== null && typeof span.endLine === 'number' && typeof span.textSha === 'string';
}

/** A non-primary hunk as before-edit `LineEdit`s: replace the first line (multi-line text) and delete the rest, or delete every line. */
export function hunkEdits(h: AnchoredHunk): LineEdit[] {
  const out: LineEdit[] = [];
  if (h.text === '') {
    for (let l = h.start; l <= h.end; l++) out.push({ path: h.path, line: l, kind: 'delete' });
    return out;
  }
  out.push({ path: h.path, line: h.start, kind: 'replace', text: h.text });
  for (let l = h.start + 1; l <= h.end; l++) out.push({ path: h.path, line: l, kind: 'delete' });
  return out;
}

/** The site edit(s) of an LLM candidate in before-edit numbering: a deletion is `delete` for every span line, primary included. */
export function llmSiteEdits(c: LlmCandidate): LineEdit[] {
  const path = c.site.file.path;
  const end = c.site.span.endLine;
  const out: LineEdit[] = [];
  if (c.text === '') {
    for (let l = c.site.line; l <= end; l++) out.push({ path, line: l, kind: 'delete' });
    return out;
  }
  out.push({ path, line: c.site.line, kind: 'replace', text: c.text });
  for (let l = c.site.line + 1; l <= end; l++) out.push({ path, line: l, kind: 'delete' });
  return out;
}

/** Every edit of the candidate (site first), before-edit numbering, as verify/apply.ts applies them. */
export function llmLineEdits(c: LlmCandidate): LineEdit[] {
  return [...llmSiteEdits(c), ...(c.extraEdits ?? [])];
}

function applyOne(src: string, e: LineEdit, indent: string): string {
  switch (e.kind) {
    case 'replace':
      if (e.text === undefined) throw new VerifyError(`replace edit at ${e.path}:${e.line} has no text`);
      return replaceLine(src, e.line, indentedText(e.text, indent));
    case 'insert': {
      if (e.text === undefined) throw new VerifyError(`insert edit at ${e.path}:${e.line} has no text`);
      const full = indentedText(e.text, indent);
      return insertLine(src, e.line - 1, full, indentOf(full.split('\n')[0] ?? ''));
    }
    case 'delete':
      return deleteLine(src, e.line);
  }
}

/**
 * Dry-run / lane application of an LLM candidate over `files` (path → current SourceFile): the
 * span must still hash to `site.span.textSha` (text identity, never the one-statement tokenizer
 * check, which reads a dedenting block as ''), then every edit is applied bottom-up per file in
 * the order verify/apply.ts uses. Throws VerifyError on a stale span or an out-of-range edit.
 */
export function applyLlmCandidate(c: LlmCandidate, files?: ReadonlyMap<string, SourceFile>): LlmApplied {
  const sitePath = c.site.file.path;
  const current = (path: string): string => {
    const f = files?.get(path);
    if (f !== undefined) return f.src;
    if (path === sitePath) return c.site.file.src;
    throw new VerifyError(`extra edit targets ${path}, which is not in the provided files`);
  };
  const before = current(sitePath);
  const lines = splitPhysicalLines(before);
  const span = lines.slice(c.site.line - 1, c.site.span.endLine);
  if (span.length !== c.site.span.endLine - c.site.line + 1 || llmSpanSha(span) !== c.site.span.textSha) {
    throw new VerifyError(`stale llm site: ${sitePath}:${c.site.line}-${c.site.span.endLine} no longer reads the anchored block`);
  }
  for (const e of c.extraEdits ?? []) {
    if (e.path === sitePath && e.line >= c.site.line && e.line <= c.site.span.endLine) throw new VerifyError(`extra edit at ${e.path}:${e.line} lies inside the site span ${c.site.line}-${c.site.span.endLine}`);
  }
  const byPath = new Map<string, { e: LineEdit; k: number; site: boolean }[]>();
  llmLineEdits(c).forEach((e, k) => {
    const list = byPath.get(e.path) ?? [];
    list.push({ e, k, site: k === 0 || (e.path === sitePath && e.line >= c.site.line && e.line <= c.site.span.endLine) });
    byPath.set(e.path, list);
  });
  const touched: LlmApplied['files'] = [];
  let diff = '';
  for (const [path, list] of byPath) {
    const src = current(path);
    const original = splitPhysicalLines(src);
    const rank = (e: LineEdit): number => (e.kind === 'insert' ? 1 : 0);
    const ordered = [...list].sort((a, b) => b.e.line - a.e.line || rank(a.e) - rank(b.e) || (a.e.kind === 'insert' ? b.k - a.k : a.k - b.k));
    let out = src;
    for (const { e, site } of ordered) out = applyOne(out, e, site ? c.site.indent : indentOf(original[e.line - 1] ?? ''));
    touched.push({ path, before: src, after: out });
    const d = unifiedDiff(path, src, out);
    if (d !== '') diff += d.endsWith('\n') ? d : `${d}\n`;
  }
  return { candidate: c, files: touched, diff };
}

/** Re-anchor an LLM site on another base (an improved partial that shifted lines) by the span's text; null when the block is gone or ambiguous. */
export function reanchorLlmSite(site: Site, files: ReadonlyMap<string, SourceFile>): LlmSite | null {
  if (!isLlmSite(site)) return null;
  const f = files.get(site.file.path);
  if (f === undefined) return null;
  if (f === site.file) return site;
  const a = anchorHunk(f.mod.lines, site.currentLine, site.line);
  if (!a.ok) return null;
  return llmSiteAt(f, a.start, a.end, [...site.evidence.notes.filter((n) => !n.startsWith('re-anchored')), `re-anchored ${a.tier} from L${site.line}`]);
}

interface PreparedPatch {
  hunks: AnchoredHunk[];
  rationale: string;
}

function prepare(input: ConvertInput, j: number, patch: PatchSpec): { ok: true; value: PreparedPatch } | { ok: false; drop: DroppedPatch } {
  const drop = (reason: DropReason, detail: string, path?: string): { ok: false; drop: DroppedPatch } => {
    const d: DroppedPatch = { sample: input.sample, patch: j, reason, detail };
    if (path !== undefined) d.path = path;
    return { ok: false, drop: d };
  };
  if (patch.edits.length > FIX_LIMITS.edits) return drop('too_many_edits', `${patch.edits.length} edits, at most ${FIX_LIMITS.edits}`);
  const hunks: AnchoredHunk[] = [];
  const paths = new Set<string>();
  for (const e of patch.edits) {
    const path = normalisePath(e.path);
    if (path === null) return drop('invalid_path', `path ${JSON.stringify(e.path)} is not a workspace-relative path`);
    if (TEST_PATH_RE.test(path)) return drop('test_path', `${path} is a test file`, path);
    const file = input.files.get(path);
    if (file === undefined) return drop('not_in_base', `${path} is not a Python file of the workspace`, path);
    paths.add(path);
    if (paths.size > FIX_LIMITS.files) return drop('too_many_files', `${paths.size} files, at most ${FIX_LIMITS.files}`);
    if (hunkOldLines(e.old).length === 0) return drop('empty_old', `an edit of ${path} has an empty \`old\``, path);
    const a = anchorHunk(file.mod.lines, e.old, e.nearLine);
    if (!a.ok) return drop('misanchored', `${a.reason} in ${path}: ${clip(hunkOldLines(e.old)[0]!.trim(), 80)}`, path);
    hunks.push({ path, start: a.start, end: a.end, tier: a.tier, text: hunkNewText(e.new), nearLine: e.nearLine });
  }
  for (const path of paths) {
    const own = hunks.filter((h) => h.path === path).sort((x, y) => x.start - y.start);
    for (let i = 1; i < own.length; i++) {
      if (own[i]!.start <= own[i - 1]!.end) return drop('overlapping', `two edits of ${path} overlap at L${own[i]!.start}`, path);
    }
  }
  return { ok: true, value: { hunks, rationale: patch.rationale } };
}

/** Index of the highest-ranked listing containing the hunk's first line (Infinity when none). */
function listingRank(h: AnchoredHunk, listings: readonly Pick<Listing, 'path' | 'startLine' | 'endLine'>[]): number {
  const i = listings.findIndex((l) => l.path === h.path && l.startLine <= h.start && h.start <= l.endLine);
  return i === -1 ? Number.POSITIVE_INFINITY : i;
}

/** The primary hunk: highest-ranked listing member, then order; a deletion becomes primary only when every hunk deletes (so the site keeps a replacement text when it can). */
export function primaryHunkIndex(hunks: readonly AnchoredHunk[], listings: readonly Pick<Listing, 'path' | 'startLine' | 'endLine'>[]): number {
  const pool = hunks.some((h) => h.text !== '') ? hunks.map((h, i) => (h.text !== '' ? i : -1)).filter((i) => i >= 0) : hunks.map((_, i) => i);
  let best = pool[0] ?? 0;
  for (const i of pool) if (listingRank(hunks[i]!, listings) < listingRank(hunks[best]!, listings)) best = i;
  return best;
}

/**
 * Turn one parsed sample into candidates (§4.7 steps 1–6). Every drop is reported with its reason
 * so the ledger can feed it back (`misanchored`, `syntax_error`) and the trace can count it.
 */
export async function convertSample(input: ConvertInput): Promise<ConvertResult> {
  const listings = input.listings ?? [];
  const seen = input.seen ?? new Map<string, LlmCandidate>();
  const out: ConvertResult = { candidates: [], applied: [], dropped: [] };
  for (const [j, patch] of input.patches.slice(0, FIX_LIMITS.patches).entries()) {
    const prepared = prepare(input, j, patch);
    if (!prepared.ok) {
      out.dropped.push(prepared.drop);
      continue;
    }
    const { hunks, rationale } = prepared.value;
    const p = primaryHunkIndex(hunks, listings);
    const primary = hunks[p]!;
    const file = input.files.get(primary.path)!;
    const site = llmSiteAt(file, primary.start, primary.end, [`llm sample ${input.sample} patch ${j}`, `anchored ${primary.tier}`]);
    const extra = hunks.flatMap((h, i) => (i === p ? [] : hunkEdits(h)));
    const candidate: LlmCandidate = { id: '', site, text: primary.text, source: LLM_SOURCE_NAME, op: `sample_${input.sample}_${j}`, prior: 1, provenance: rationale };
    if (extra.length > 0) candidate.extraEdits = extra;
    let applied: LlmApplied;
    try {
      applied = applyLlmCandidate(candidate, input.files);
    } catch (e) {
      out.dropped.push({ sample: input.sample, patch: j, reason: 'apply_failed', detail: e instanceof Error ? e.message : String(e), path: primary.path });
      continue;
    }
    if (applied.diff === '') {
      out.dropped.push({ sample: input.sample, patch: j, reason: 'unchanged', detail: 'the patch leaves every file as it is', path: primary.path });
      continue;
    }
    const sha = diffHash(applied.diff);
    candidate.id = `llm:${sha}`;
    if (input.tried?.has(sha)) {
      out.dropped.push({ sample: input.sample, patch: j, reason: 'tried', detail: input.verdictOf?.(sha) ?? 'identical to a candidate already run this run', path: primary.path, sha });
      continue;
    }
    const earlier = seen.get(sha);
    if (earlier !== undefined) {
      earlier.prior = (earlier.prior ?? 1) + 1;
      out.dropped.push({ sample: input.sample, patch: j, reason: 'duplicate', detail: `same diff as ${earlier.op}`, path: primary.path, sha });
      continue;
    }
    if (input.compile) {
      let syntax: string | null = null;
      let failure: string | null = null;
      for (const f of applied.files) {
        let v: CompileVerdict;
        try {
          v = await input.compile(f.path, f.after);
        } catch (e) {
          // the checker itself failed (the sandbox rejects on an engine abort or a spawn failure): the post-image is
          // unverified, so the patch is dropped with the message rather than passed on or left to hang the round
          failure = `compile check failed for ${f.path}: ${e instanceof Error ? e.message : String(e)}`;
          break;
        }
        if (!v.ok) {
          syntax = `${v.message} in ${f.path}`;
          break;
        }
      }
      if (failure !== null) {
        out.dropped.push({ sample: input.sample, patch: j, reason: 'compile_failed', detail: failure, path: primary.path, sha });
        continue;
      }
      if (syntax !== null) {
        out.dropped.push({ sample: input.sample, patch: j, reason: 'syntax_error', detail: syntax, path: primary.path, sha });
        continue;
      }
    }
    seen.set(sha, candidate);
    out.candidates.push(candidate);
    out.applied.push(applied);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Attempt ledger (§4.4 "Earlier attempts this run", §4.9 verdicts from VerifyOutcome only)
// ---------------------------------------------------------------------------------------

export const DIFF_HEAD_LINES = 12;
export const DIFF_HEAD_CHARS = 400;

/** The hunk lines of a unified diff (headers dropped), bounded. */
export function diffHead(diff: string, maxLines = DIFF_HEAD_LINES, maxChars = DIFF_HEAD_CHARS): string {
  const lines = diff.split('\n').filter((l) => l !== '' && !/^(diff --git|index |--- |\+\+\+ )/.test(l));
  const shown = lines.slice(0, maxLines);
  const text = shown.join('\n') + (lines.length > shown.length ? `\n… ${lines.length - shown.length} more lines` : '');
  return clip(text, maxChars);
}

function firstErrorLine(o: VerifyOutcome, testId: string): string {
  const f = [...(o.full?.failures ?? []), ...o.subset.failures].find((x) => x.testId === testId);
  return f === undefined ? '' : clip(f.actual.replace(/\s+/g, ' ').trim(), 160);
}

/** The code verdict sentence of one run outcome, in the ledger's vocabulary. */
export function verdictOf(o: VerifyOutcome): string {
  const p = o.progress;
  const still = o.subset.failing.length > 0 ? o.subset.failing : (o.full?.failing ?? []);
  switch (o.status) {
    case 'plausible':
      return `passed the goal tests${o.full !== undefined ? ' and the regression scope' : ''}`;
    case 'regressed': {
      const first = p.newlyFailing[0];
      const n = p.newlyFailing.length > 0 ? p.newlyFailing.length : Math.max(1, p.before.passed - p.after.passed);
      return `regressed: ${n} newly failing${first !== undefined ? ` (${first}: E ${firstErrorLine(o, first)})` : ''}`;
    }
    case 'partial': {
      const fixed = p.newlyPassing.slice(0, 3).join(', ');
      return `partial: fixed ${fixed}${p.newlyPassing.length > 3 ? ` +${p.newlyPassing.length - 3}` : ''}; ${still[0] ?? 'the rest'} still fails${still[0] !== undefined ? `, actual ${firstErrorLine(o, still[0])}` : ''}`;
    }
    case 'unchanged':
      return `unchanged: ${still[0] ?? 'the goal test'} still fails${still[0] !== undefined ? `, actual ${firstErrorLine(o, still[0])}` : ''}`;
    case 'unstable':
      return 'unstable: passed the reproduction once and failed the confirmation run';
    case 'timeout':
      return 'timeout: the tests did not finish within the lane timeout';
    case 'apply_failed':
      return 'apply failed: the edit no longer applies to the current file';
  }
}

/** Ledger row of a candidate that ran (any source: the LLM must not repeat a seed's failure either). */
export function attemptFromOutcome(o: VerifyOutcome, step: number): AttemptRecord {
  const c = o.job.candidate;
  const source: string = c.source;
  return { op: source === LLM_SOURCE_NAME ? c.op : `${source}:${c.op}`, step, diffHead: diffHead(o.applied.diff), verdict: verdictOf(o), sha: diffHash(o.applied.diff) };
}

/** Ledger row of a hunk that never ran: a syntax error or a misanchored `old`; null for the other drop reasons (nothing to feed back). */
export function attemptFromDrop(d: DroppedPatch, step: number, hunkText = ''): AttemptRecord | null {
  const op = `sample_${d.sample}_${d.patch}`;
  switch (d.reason) {
    case 'syntax_error':
      return { op, step, diffHead: hunkText, verdict: `syntax error: ${d.detail}`, sha: d.sha ?? '' };
    case 'misanchored':
      return { op, step, diffHead: hunkText, verdict: `misanchored: ${d.detail}`, sha: '' };
    case 'tried':
      return { op, step, diffHead: hunkText, verdict: `identical to an earlier patch: ${d.detail}`, sha: d.sha ?? '' };
    default:
      return null;
  }
}

/** The rows the prompt shows: one per diff (latest verdict wins), the most recent `max`. */
export function attemptLedger(records: readonly AttemptRecord[], max = 6): AttemptRecord[] {
  const byKey = new Map<string, AttemptRecord>();
  records.forEach((r, i) => byKey.set(r.sha !== '' ? r.sha : `${r.op}#${i}`, r));
  const rows = [...byKey.values()];
  return rows.slice(Math.max(0, rows.length - max));
}

/** Identity of the ledger for the round cache key (the same context with new verdicts is a new round). */
export function attemptsHash(records: readonly AttemptRecord[]): string {
  return sha12(records.map((r) => [r.sha, r.verdict]));
}
