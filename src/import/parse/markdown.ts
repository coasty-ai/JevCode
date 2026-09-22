/**
 * docs/IMPORT-DESIGN.md §4.3 `markdown.ts` — normalisation, the fence/span map, the executable
 * scanner (§2.6), the `@import` resolver (§4.3, §6 rows 32–36) and the dedupe keys (§4.5).
 *
 * Everything here is total and pure: `parseMarkdown` never throws, and `resolveImports` is pure
 * apart from the `readFile` seam it is handed — `src/import/**` never touches `node:fs` outside
 * `discover.ts nodeImportFs()`. No path is ever expanded outside the root it was found in, and a
 * secret-named target is refused independently of the root check (§6 row 33).
 */
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { sha256Hex } from '../../core/hash.js';
import { PATTERN_MARKER, detectSecrets, redactSpans, type ExactDetector } from '../../core/redact.js';
import { IMPORT_LIMITS } from '../../core/limits.js';
import { isWithin } from '../../sandbox/paths.js';
import type { ExecutableSegment, Frontmatter, ImportRef, MarkdownDoc } from '../types.js';
import { parseFrontmatter } from './frontmatter.js';

/** §2.9: the bidi controls of `session/index.ts:47`, reused rather than re-derived. */
const BIDI_RE = /[\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;
/** CSI / OSC escape sequences. */
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
/** C0 and DEL, keeping `\n` and `\t`. */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** A heading line, outside fences. */
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
/** The most tokens one document contributes to the O(N²) Jaccard pass. */
const MAX_TOKENS = 4096;

/**
 * §2.9 / §1 property 4: the **pattern layer**, all fifteen families.
 *
 * `patternRedact` masks only the six *redacting* families, so a heading carrying one of the nine
 * **warn-only** ones (`AKIA…`, `xox…`, a PEM header, a JWT, `sk_live_…`, `npm_…`, `hf_…`,
 * `glpat-…`, a Slack webhook) went through it untouched and reached `sources.jsonl` and the
 * group-II Jev request body. §1 property 4 counts all fifteen, so every seam that can carry
 * source text uses this instead — the same `redactSpans(s, detectSecrets(s, exact))` shape
 * `test/unit/import/leak.test.ts` pins for the write seam.
 *
 * `exact` is the session redactor's exact `SecretSet` layer, threaded from
 * `planImport({ redact })` (§2.9 puts the configured layer first, because a bare password like
 * `hunter2-…` matches no family). With none, the fifteen families are still scanned.
 *
 * It lives here because `parseMarkdown` is its first consumer — the heading default — and
 * `src/import/**` may not add to `src/core/redact.ts`.
 */
export function redactSecrets(s: string, exact?: ExactDetector): string {
  return redactSpans(s, detectSecrets(s, exact), PATTERN_MARKER);
}

/** §4.3: knobs `parseMarkdown` takes; the defaults are the §2.8 bounds and `redactSecrets`. */
export interface MarkdownOptions {
  headingLimit?: number;
  headingCells?: number;
  /** §2.9: applied to every heading before it can reach an artefact or Jev; defaults to `redactSecrets` */
  redact?: (s: string) => string;
}

interface CodeRegion {
  start: number;
  end: number;
  kind: 'fence' | 'span';
  /** the fence info string, e.g. `sh` or `!` */
  info: string;
}

function decode(raw: string | Buffer): { text: string; bom: boolean } {
  if (typeof raw === 'string') return raw.charCodeAt(0) === 0xfeff ? { text: raw.slice(1), bom: true } : { text: raw, bom: false };
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return { text: raw.subarray(3).toString('utf8'), bom: true };
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return { text: raw.subarray(2).toString('utf16le'), bom: true };
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    const swapped = Buffer.from(raw.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), bom: true };
  }
  return { text: raw.toString('utf8'), bom: false };
}

/**
 * §2.9 / §6 row 25: BOM stripped (UTF-8 and both UTF-16 orders decoded), CRLF and lone CR → LF,
 * ANSI escapes, bidi controls, C0 and `U+2028`/`U+2029` removed, with the removal count.
 */
export function normaliseText(raw: string | Buffer): { text: string; controlsRemoved: number; bom: boolean; crlf: boolean } {
  const { text: decoded, bom } = decode(raw);
  const crlf = decoded.includes('\r\n');
  const lf = decoded.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let removed = 0;
  const noAnsi = lf.replace(ANSI_RE, (m) => {
    removed += m.length;
    return '';
  });
  const noSeparators = noAnsi.replace(/[\u{2028}\u{2029}]/gu, '\n');
  const noBidi = noSeparators.replace(BIDI_RE, () => {
    removed += 1;
    return '';
  });
  const text = noBidi.replace(CONTROL_RE, () => {
    removed += 1;
    return '';
  });
  return { text, controlsRemoved: removed, bom, crlf };
}

/** §6 row 24: a NUL in the first `binarySniffBytes`, or a prefix that is not valid UTF-8, means "not text". */
export function looksBinary(buf: Buffer, sniffBytes: number = IMPORT_LIMITS.binarySniffBytes): boolean {
  const head = buf.subarray(0, Math.max(0, sniffBytes));
  if (head.includes(0)) return true;
  // a cut multi-byte sequence at the boundary is not corruption: retry without the last few bytes
  for (let trim = 0; trim <= 3 && head.length - trim > 0; trim++) {
    try {
      new TextDecoder('utf8', { fatal: true }).decode(head.subarray(0, head.length - trim));
      return false;
    } catch {
      continue;
    }
  }
  return head.length > 0;
}

/** JS line terminators, so `^` and `$` under the `m` flag are reproduced exactly. */
function isLineTerminator(c: string | undefined): boolean {
  return c === '\n' || c === '\r' || c === ' ' || c === ' ';
}

/**
 * `[ \t]*(?:\r?\n|$)` starting at `from`: the index the comment's match ends at, or -1 when the
 * tail does not match. `[ \t]*` is greedy and never usefully backtracks, because neither
 * alternative can consume a space or a tab. Under `m`, `$` also holds *before* a line
 * terminator, which is how a lone `\r` (or `U+2028`) ends a match without being consumed.
 */
function commentTailEnd(text: string, from: number): number {
  let t = from;
  while (t < text.length && (text[t] === ' ' || text[t] === '\t')) t++;
  if (t >= text.length) return t;
  if (text[t] === '\r' && text[t + 1] === '\n') return t + 2;
  if (text[t] === '\n') return t + 1;
  return isLineTerminator(text[t]) ? t : -1;
}

/** The first `^` position (under `m`) at or after `from`, or -1 when there is none left. */
function nextLineStart(text: string, from: number): number {
  if (from <= 0) return 0;
  if (from > text.length) return -1;
  if (isLineTerminator(text[from - 1])) return from;
  for (let i = from; i < text.length; i++) if (isLineTerminator(text[i])) return i + 1;
  return -1;
}

/**
 * §4.3: drop HTML comments that own their lines, before hashing (Claude's own loader rule) —
 * `BLOCK_COMMENT_RE`'s replacement, one index pass instead of a backtracking regex.
 *
 * The lazy `[\s\S]*?` re-scanned to the end of the body for **every** line-leading `<!--` whose
 * `-->` candidates all failed the end-of-line tail, which is quadratic: 665 ms for 400 KiB with
 * no `-->` at all, 11.4 s for 400 KiB of `<!-- open` over `--> x`, and about twenty minutes at
 * the 4 MiB `sourceReadCapBytes` (the third quadratic of review defect 6's family, and the
 * worst). Whether a `-->` can close a comment depends only on what follows it, never on where
 * the comment opened, so the valid closers are found once up front and a monotone cursor walks
 * them: one pass over the text, one over the closers.
 */
export function stripBlockHtmlComments(text: string): string {
  if (!text.includes('<!--')) return text;
  const closers: number[] = [];
  const closerEnds: number[] = [];
  for (let p = text.indexOf('-->'); p !== -1; p = text.indexOf('-->', p + 1)) {
    const end = commentTailEnd(text, p + 3);
    if (end >= 0) {
      closers.push(p);
      closerEnds.push(end);
    }
  }
  if (closers.length === 0) return text;

  let out = '';
  let copied = 0;
  let pos = 0;
  let ci = 0;
  while (pos <= text.length) {
    const start = nextLineStart(text, pos);
    if (start === -1) break;
    let open = start;
    while (open < text.length && (text[open] === ' ' || text[open] === '\t')) open++;
    // the body is lazy, so the comment closes at the first *valid* `-->` at or after its body
    let end = -1;
    if (text.startsWith('<!--', open)) {
      while (ci < closers.length && closers[ci]! < open + 4) ci++;
      if (ci < closers.length) end = closerEnds[ci]!;
    }
    if (end === -1) {
      pos = start + 1;
      continue;
    }
    out += text.slice(copied, start);
    copied = end;
    pos = end;
  }
  return out + text.slice(copied);
}

/** Fenced blocks and inline code spans, in source order and never overlapping. */
function codeRegions(text: string): CodeRegion[] {
  const out: CodeRegion[] = [];
  let pos = 0;
  let fence: { char: string; len: number; start: number; info: string } | null = null;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === null) {
      if (opener !== null) {
        fence = { char: opener[1]![0]!, len: opener[1]!.length, start: pos, info: opener[2]!.trim() };
      } else {
        // inline spans on this line only (a span that crosses lines is rare and not worth the risk)
        let i = 0;
        while (i < line.length) {
          if (line[i] !== '`') {
            i++;
            continue;
          }
          let run = 0;
          while (i + run < line.length && line[i + run] === '`') run++;
          const marker = '`'.repeat(run);
          const close = line.indexOf(marker, i + run);
          if (close === -1) {
            i += run;
            continue;
          }
          out.push({ start: pos + i, end: pos + close + run, kind: 'span', info: '' });
          i = close + run;
        }
      }
    } else if (opener !== null && opener[1]![0] === fence.char && opener[1]!.length >= fence.len && opener[2]!.trim() === '') {
      out.push({ start: fence.start, end, kind: 'fence', info: fence.info });
      fence = null;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (fence !== null) out.push({ start: fence.start, end: text.length, kind: 'fence', info: fence.info });
  return out.sort((a, b) => a.start - b.start);
}

/**
 * §1 property 14: the region holding `index`, by binary search.
 *
 * `codeRegions` emits regions that are sorted by `start` and never overlap — a span is only
 * scanned while no fence is open — so the containing region is unique and the rightmost region
 * whose `start <= index` is the only candidate. The linear `Array.some` this replaces ran once
 * per line, once per `@ref` and once per plain executable form, which made a fence-heavy 400 KiB
 * body cost 26 s (`review-engine-2026-09-22.md` defect 6): the heading loop's 5-heading
 * short-circuit cannot fire when the headings are inside the fences.
 */
function regionAt(regions: readonly CodeRegion[], index: number): CodeRegion | null {
  let lo = 0;
  let hi = regions.length - 1;
  let best: CodeRegion | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = regions[mid]!;
    if (r.start <= index) {
      best = r;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best !== null && index < best.end ? best : null;
}

function inRegion(regions: readonly CodeRegion[], index: number, kinds: readonly CodeRegion['kind'][]): boolean {
  const r = regionAt(regions, index);
  return r !== null && kinds.includes(r.kind);
}

/** §4.3 / §6 row 35: `@path` references outside every fence and code span. */
function findRefs(text: string, regions: readonly CodeRegion[]): ImportRef[] {
  const out: ImportRef[] = [];
  const re = /(^|[^\w`@])@([^\s`'"()[\]{},;@]+)/g;
  for (;;) {
    const m = re.exec(text);
    if (m === null) break;
    const start = m.index + m[1]!.length;
    if (inRegion(regions, start, ['fence', 'span'])) continue;
    let target = m[2]!;
    // trailing sentence punctuation is not part of the path
    const trimmed = target.replace(/[.,;:!?]+$/, '');
    if (trimmed.length === 0) continue;
    target = trimmed;
    out.push({ raw: `@${target}`, target, start, end: start + 1 + target.length });
  }
  return out;
}

/**
 * Is `seg` already covered by a segment recorded in `stream`?
 *
 * Each stream is discovered strictly left to right — the code regions are sorted and do not
 * overlap, and one regex's matches never nest — so `start` and `end` both increase along it and
 * the rightmost entry starting at or before `seg.start` carries that prefix's largest `end`.
 * One binary search therefore gives the same verdict as scanning the whole list. The
 * `Array.some` this replaces was the sibling of review defect 6: it made a body dense in
 * *unfenced* `$(…)` forms quadratic (400 KiB cost 1.2 s, and minutes at the 4 MiB
 * `sourceReadCapBytes`). §2.6 cannot be satisfied by recording fewer segments — a segment that
 * is not recorded is not fenced inert either.
 */
function coveredBy(stream: readonly ExecutableSegment[], seg: ExecutableSegment): boolean {
  let lo = 0;
  let hi = stream.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (stream[mid]!.start <= seg.start) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best >= 0 && stream[best]!.end >= seg.end;
}

function pushIfFree(streams: readonly (readonly ExecutableSegment[])[], into: ExecutableSegment[], seg: ExecutableSegment): void {
  for (const s of streams) if (coveredBy(s, seg)) return;
  into.push(seg);
}

/**
 * §2.6: every executable segment in a body — the six forms that must become inert fences.
 *
 * The segments are collected in one stream per source (the code regions, then each plain form)
 * so `pushIfFree` can binary-search instead of rescanning; `streams.flat()` restores the
 * original push order, and the final sort is stable, so the output is unchanged.
 */
function findExecutables(text: string, regions: readonly CodeRegion[]): ExecutableSegment[] {
  const fromRegions: ExecutableSegment[] = [];
  const streams: ExecutableSegment[][] = [fromRegions];
  for (const r of regions) {
    if (r.kind === 'fence' && r.info.startsWith('!')) fromRegions.push({ form: 'fence-bang', start: r.start, end: r.end, text: text.slice(r.start, r.end) });
    if (r.kind === 'span') {
      const inner = text.slice(r.start, r.end).replace(/^`+/, '').replace(/`+$/, '');
      const bang = r.start > 0 && text[r.start - 1] === '!';
      if (bang) pushIfFree(streams, fromRegions, { form: 'backtick-bang', start: r.start - 1, end: r.end, text: inner });
      else if (inner.startsWith('!')) pushIfFree(streams, fromRegions, { form: 'backtick-cmd', start: r.start, end: r.end, text: inner.slice(1) });
    }
  }
  const plain: readonly { re: RegExp; form: ExecutableSegment['form'] }[] = [
    { re: /!\{([^}\n]*)\}/g, form: 'brace-bang' },
    { re: /@\{([^}\n]*)\}/g, form: 'at-brace' },
    { re: /\$\(([^)\n]*)\)/g, form: 'dollar-paren' },
  ];
  for (const { re, form } of plain) {
    const into: ExecutableSegment[] = [];
    streams.push(into);
    re.lastIndex = 0;
    for (;;) {
      const m = re.exec(text);
      if (m === null) break;
      if (inRegion(regions, m.index, ['fence'])) continue;
      pushIfFree(streams, into, { form, start: m.index, end: m.index + m[0]!.length, text: m[1]! });
    }
  }
  return streams.flat().sort((a, b) => a.start - b.start);
}

/** §4.4.3 group III: the normalised token set — lowercase, punctuation dropped, frontmatter stripped. */
function tokenise(body: string): string[] {
  const seen = new Set<string>();
  for (const t of body.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length < 2) continue;
    seen.add(t);
    if (seen.size >= MAX_TOKENS) break;
  }
  return [...seen].sort();
}

/**
 * §4.3: the normalised document the classifier, the deduper and Jev see. Total — a malformed
 * frontmatter block costs a `frontmatter: null` and nothing else.
 */
export function parseMarkdown(text: string, opts: MarkdownOptions = {}): MarkdownDoc {
  const limit = opts.headingLimit ?? IMPORT_LIMITS.jevHeadings;
  const cells = opts.headingCells ?? IMPORT_LIMITS.jevHeadingCells;
  const redact = opts.redact ?? redactSecrets;
  const norm = normaliseText(text);
  const body = stripBlockHtmlComments(norm.text);
  const fmResult = parseFrontmatter(body);
  const frontmatter: Frontmatter | null = fmResult.ok ? fmResult.value : null;
  const regions = codeRegions(body);

  const headings: string[] = [];
  let pos = 0;
  let fences = 0;
  for (const r of regions) if (r.kind === 'fence') fences++;
  while (pos <= body.length && headings.length < limit) {
    const nl = body.indexOf('\n', pos);
    const end = nl === -1 ? body.length : nl;
    if (pos >= (frontmatter?.bodyOffset ?? 0) && !inRegion(regions, pos, ['fence'])) {
      const m = HEADING_RE.exec(body.slice(pos, end));
      if (m !== null) {
        const t = redact(m[2]!).slice(0, cells);
        if (t.trim().length > 0) headings.push(t);
      }
    }
    if (nl === -1) break;
    pos = nl + 1;
  }

  const afterFm = body.slice(frontmatter?.bodyOffset ?? 0);
  const tokens = tokenise(afterFm);
  const lines = body.length === 0 ? 0 : body.split('\n').length - (body.endsWith('\n') ? 1 : 0);
  return {
    text: body,
    controlsRemoved: norm.controlsRemoved,
    frontmatter,
    headings,
    lines,
    fences,
    executables: findExecutables(body, regions),
    refs: findRefs(body, regions),
    tokens,
    normalisedSha256: sha256Hex(body),
    bands: minhashBands(tokens),
  };
}

/** §4.5 pass 2: |A ∩ B| / |A ∪ B|; two empty token sets score 0, the conservative answer (§0 principle 4). */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function fnv1a(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** [G1.6]: `bands` 32-bit min-hash signatures — the near-dedupe bucket key, so the pass is not O(N²) over bodies. */
export function minhashBands(tokens: readonly string[], bands: number = IMPORT_LIMITS.minhashBands): readonly string[] {
  if (tokens.length === 0 || bands <= 0) return [];
  const out: string[] = [];
  for (let b = 0; b < bands; b++) {
    let min = 0xffffffff;
    for (const t of tokens) {
      const h = fnv1a(t, b * 0x9e3779b1);
      if (h < min) min = h;
    }
    out.push(`${b}:${min.toString(16).padStart(8, '0')}`);
  }
  return out;
}

function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** §2.6: every executable segment becomes a ```` ```text (not run) ```` fence. Inert on arrival (§0 principle 8). */
export function fenceExecutables(text: string, segments: readonly ExecutableSegment[]): { text: string; stripped: number } {
  const ordered = [...segments].sort((a, b) => b.start - a.start);
  let out = text;
  let stripped = 0;
  for (const seg of ordered) {
    if (seg.start < 0 || seg.end > out.length || seg.end < seg.start) continue;
    const fence = fenceFor(seg.text);
    const before = seg.start > 0 && out[seg.start - 1] !== '\n' ? '\n' : '';
    const after = seg.end < out.length && out[seg.end] !== '\n' ? '\n' : '';
    out = `${out.slice(0, seg.start)}${before}${fence}text (not run)\n${seg.text}\n${fence}${after}${out.slice(seg.end)}`;
    stripped++;
  }
  return { text: out, stripped };
}

/** §4.3: the two seams the resolver needs — reading a candidate, and the secret-basename refusal. */
export interface ResolveImportsDeps {
  readFile(path: string): Promise<string | null>;
  isDenied(basename: string): boolean;
}

function unresolvedComment(raw: string, reason: string): string {
  return `<!-- jevcode: unresolved ${raw} (${reason}) -->`;
}

/**
 * §4.3 / §6 rows 32–36: inline `@path` imports. Relative to the **containing** file, confined to
 * `root`, depth 4, cycle-detected, never inside a fence or code span, and never a secret-named
 * target. An unresolved reference is preserved verbatim as
 * `<!-- jevcode: unresolved @x (outside <root>) -->` so nothing is silently dropped; `<root>` is
 * literal, because an artefact never carries an absolute home path (§4.2.5).
 */
export async function resolveImports(
  text: string,
  opts: { file: string; root: string; depth?: number; deps: ResolveImportsDeps },
): Promise<{ text: string; resolved: number; unresolved: readonly string[] }> {
  const maxDepth = opts.depth ?? 4;
  const root = resolvePath(opts.root);
  const unresolved: string[] = [];
  let resolved = 0;

  const expand = async (body: string, file: string, level: number, stack: readonly string[]): Promise<string> => {
    const norm = normaliseText(body).text;
    const refs = findRefs(norm, codeRegions(norm));
    if (refs.length === 0) return norm;
    let out = '';
    let cursor = 0;
    for (const ref of refs) {
      out += norm.slice(cursor, ref.start);
      cursor = ref.end;
      const fail = (reason: string): void => {
        unresolved.push(`${ref.raw} (${reason})`);
        out += unresolvedComment(ref.raw, reason);
      };
      if (ref.target.startsWith('~')) {
        fail('outside <root>');
        continue;
      }
      const abs = isAbsolute(ref.target) ? resolvePath(ref.target) : resolvePath(dirname(file), ref.target);
      if (!isWithin(root, abs)) {
        fail('outside <root>');
        continue;
      }
      if (opts.deps.isDenied(basename(abs))) {
        fail('refused: secret path');
        continue;
      }
      if (stack.includes(abs)) {
        fail(`cycle at ${basename(file)}`);
        continue;
      }
      if (level >= maxDepth) {
        fail(`depth ${maxDepth} reached at ${basename(file)}`);
        continue;
      }
      let content: string | null = null;
      try {
        content = await opts.deps.readFile(abs);
      } catch {
        content = null;
      }
      if (content === null) {
        fail('not found');
        continue;
      }
      resolved++;
      out += await expand(content, abs, level + 1, [...stack, abs]);
    }
    out += norm.slice(cursor);
    return out;
  };

  const file = resolvePath(opts.file);
  const out = await expand(text, file, 0, [file]);
  return { text: out, resolved, unresolved };
}
