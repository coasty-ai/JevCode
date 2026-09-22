/**
 * The `own` sub-language (docs/ORCHESTRATION-DESIGN.md §3.4 rule 2, §8.2 D1 item 7).
 *
 * Exactly four forms are legal, and nothing else:
 *
 *   path/to/file.ext   one file
 *   dir/               everything under `dir`, recursively
 *   dir/**             the same, written the other way
 *   dir/*.ext          the files directly in `dir` whose name ends `.ext` (NOT recursive)
 *
 * No `!`, no braces, no `?`, no character class, no leading `/`, no absolute path, no `..`, no NUL.
 * Everything is NFC-normalised on the way in, because two spellings of the same name must not read as
 * two disjoint owners. Case is folded **for overlap only** and only when the caller says the volume
 * folds: on APFS `src/A.ts` and `src/a.ts` are one file, and two agents that each "own" one of them
 * would both write it.
 *
 * Disjointness (rule 3) is the whole safety argument of the design, so it is computed here, once,
 * under glob-prefix containment: `dir/**` contains `dir/a.ts`, `dir/` contains `dir/sub/**`, and
 * `dir/*.ts` contains `dir/a.ts` but not `dir/sub/a.ts`.
 *
 * Pure: no I/O, no clock, no imports outside `src/core/**`.
 */
import { OWN_GLOBS_MAX, OWN_GLOB_CHARS } from '../../core/limits.js';

export type OwnGlobKind = 'file' | 'tree' | 'ext';

export interface OwnGlob {
  /** the input, NFC-normalised and with a `dir/**` spelling preserved as written */
  raw: string;
  kind: OwnGlobKind;
  /**
   * `file`: the whole path. `tree`: the directory, no trailing slash ('' is refused, the repo root is
   * never ownable). `ext`: the directory, no trailing slash ('' means the repo root's own files).
   */
  dir: string;
  /** `ext` only: the suffix including the dot, e.g. `.ts` */
  ext: string | null;
}

export type ParseResult = { ok: true; glob: OwnGlob } | { ok: false; reason: string };

/** Characters a path segment may hold. Deliberately narrow: no `*`, `?`, `[`, `{`, `!`, `\`, NUL. */
const SEGMENT_RE = /^[A-Za-z0-9._@+~¡-￿-]+$/u;
const EXT_RE = /^\*(\.[A-Za-z0-9_-]+)+$/u;

function nfc(s: string): string {
  return s.normalize('NFC');
}

function badSegments(segments: readonly string[]): string | null {
  for (const s of segments) {
    if (s === '') return 'empty path segment';
    if (s === '.' || s === '..') return `"${s}" is not allowed in an own glob`;
    if (!SEGMENT_RE.test(s)) return `segment "${s}" holds a character the own sub-language does not allow`;
  }
  return null;
}

/**
 * Parse one glob of the sub-language. Every rejection carries the reason verbatim into
 * `Manifest.rejected`, so the strings are written for a human reading the card.
 */
export function parseOwnGlob(input: string): ParseResult {
  if (typeof input !== 'string') return { ok: false, reason: 'own glob is not a string' };
  const raw = nfc(input).trim();
  if (raw.length === 0) return { ok: false, reason: 'own glob is empty' };
  if (raw.length > OWN_GLOB_CHARS) return { ok: false, reason: `own glob is longer than ${OWN_GLOB_CHARS} characters` };
  if (raw.includes('\0')) return { ok: false, reason: 'own glob holds a NUL' };
  if (raw.startsWith('/')) return { ok: false, reason: `own glob "${raw}" is absolute` };
  if (/^[A-Za-z]:[\\/]/.test(raw)) return { ok: false, reason: `own glob "${raw}" is absolute` };
  if (raw.includes('\\')) return { ok: false, reason: `own glob "${raw}" holds a backslash` };
  if (raw.startsWith('!')) return { ok: false, reason: `own glob "${raw}" is a negation` };
  if (raw.includes('{') || raw.includes('}')) return { ok: false, reason: `own glob "${raw}" holds a brace expansion` };
  if (raw.includes('//')) return { ok: false, reason: `own glob "${raw}" holds an empty path segment` };

  // dir/** — everything under dir
  if (raw.endsWith('/**')) {
    const dir = raw.slice(0, -3);
    if (dir.length === 0) return { ok: false, reason: 'own glob "/**" would own the whole repository' };
    const segs = dir.split('/');
    const bad = badSegments(segs);
    if (bad !== null) return { ok: false, reason: `${bad} (in "${raw}")` };
    return { ok: true, glob: { raw, kind: 'tree', dir, ext: null } };
  }

  // dir/ — the same tree, written the other way
  if (raw.endsWith('/')) {
    const dir = raw.slice(0, -1);
    if (dir.length === 0) return { ok: false, reason: 'own glob "/" would own the whole repository' };
    const bad = badSegments(dir.split('/'));
    if (bad !== null) return { ok: false, reason: `${bad} (in "${raw}")` };
    return { ok: true, glob: { raw, kind: 'tree', dir, ext: null } };
  }

  const segs = raw.split('/');
  const last = segs[segs.length - 1] ?? '';

  // dir/*.ext — one directory level only
  if (last.startsWith('*')) {
    if (!EXT_RE.test(last)) return { ok: false, reason: `own glob "${raw}" is not one of path/to/file.ext, dir/, dir/**, dir/*.ext` };
    const dirSegs = segs.slice(0, -1);
    const bad = badSegments(dirSegs);
    if (bad !== null) return { ok: false, reason: `${bad} (in "${raw}")` };
    return { ok: true, glob: { raw, kind: 'ext', dir: dirSegs.join('/'), ext: last.slice(1) } };
  }

  if (raw.includes('*')) return { ok: false, reason: `own glob "${raw}" is not one of path/to/file.ext, dir/, dir/**, dir/*.ext` };
  const bad = badSegments(segs);
  if (bad !== null) return { ok: false, reason: `${bad} (in "${raw}")` };
  if (!last.includes('.')) return { ok: false, reason: `own glob "${raw}" names no file extension and no directory — write "${raw}/" for the directory` };
  return { ok: true, glob: { raw, kind: 'file', dir: raw, ext: null } };
}

function key(s: string, fold: boolean): string {
  return fold ? s.toLowerCase() : s;
}

/** True when `path` (a repo-relative file path) is owned by `glob`. */
export function matchesOwn(glob: OwnGlob, path: string, fold = false): boolean {
  const p = key(nfc(path), fold);
  const d = key(glob.dir, fold);
  if (glob.kind === 'file') return p === d;
  if (glob.kind === 'tree') return p.startsWith(`${d}/`);
  const parent = p.lastIndexOf('/');
  const dirOf = parent === -1 ? '' : p.slice(0, parent);
  const base = parent === -1 ? p : p.slice(parent + 1);
  return dirOf === d && base.endsWith(key(glob.ext ?? '', fold)) && base.length > (glob.ext ?? '').length;
}

/** True when any glob of the list owns `path`. */
export function ownsPath(globs: readonly OwnGlob[], path: string, fold = false): boolean {
  for (const g of globs) if (matchesOwn(g, path, fold)) return true;
  return false;
}

/**
 * True when every file `b` can own is also owned by `a` — the containment rule 3 tests pairwise.
 * `dir/**` ⊇ `dir/a.ts`, `dir/**` ⊇ `dir/sub/**`, `dir/*.ts` ⊇ `dir/a.ts`, and a tree contains itself.
 */
export function containsGlob(a: OwnGlob, b: OwnGlob, fold = false): boolean {
  const ad = key(a.dir, fold);
  const bd = key(b.dir, fold);
  if (a.kind === 'tree') return bd === ad || bd.startsWith(`${ad}/`);
  if (a.kind === 'ext') {
    if (b.kind === 'file') return matchesOwn(a, b.dir, fold);
    if (b.kind === 'ext') return ad === bd && key(a.ext ?? '', fold) === key(b.ext ?? '', fold);
    return false;
  }
  return b.kind === 'file' && ad === bd;
}

/** True when the two globs can both own at least one file. */
export function overlaps(a: OwnGlob, b: OwnGlob, fold = false): boolean {
  if (containsGlob(a, b, fold) || containsGlob(b, a, fold)) return true;
  // two `ext` globs over the same directory with different suffixes: `*.test.ts` and `*.ts` overlap
  if (a.kind === 'ext' && b.kind === 'ext') {
    const ad = key(a.dir, fold);
    const bd = key(b.dir, fold);
    if (ad !== bd) return false;
    const ae = key(a.ext ?? '', fold);
    const be = key(b.ext ?? '', fold);
    return ae.endsWith(be) || be.endsWith(ae);
  }
  return false;
}

export type DisjointResult = { ok: true } | { ok: false; left: string; right: string };

/** §3.4 rule 3: pairwise intersection empty under glob-prefix containment. */
export function disjoint(a: readonly OwnGlob[], b: readonly OwnGlob[], fold = false): DisjointResult {
  for (const x of a) for (const y of b) if (overlaps(x, y, fold)) return { ok: false, left: x.raw, right: y.raw };
  return { ok: true };
}

/** Drop every glob another glob of the same list already contains; stable in input order. */
export function dedupeContained(globs: readonly OwnGlob[], fold = false): OwnGlob[] {
  const out: OwnGlob[] = [];
  for (const g of globs) {
    if (out.some((k) => containsGlob(k, g, fold))) continue;
    for (let i = out.length - 1; i >= 0; i--) if (containsGlob(g, out[i]!, fold)) out.splice(i, 1);
    out.push(g);
  }
  return out;
}

function parentDir(g: OwnGlob): string {
  if (g.kind === 'file') {
    const i = g.dir.lastIndexOf('/');
    return i === -1 ? '' : g.dir.slice(0, i);
  }
  const i = g.dir.lastIndexOf('/');
  return g.kind === 'tree' ? (i === -1 ? '' : g.dir.slice(0, i)) : g.dir;
}

/**
 * Prefix-collapse to at most `max` globs (§3.4 rule 2's "prefix-collapsed above that"). Contained
 * globs go first; if that is not enough, the deepest sibling group is replaced by its parent tree,
 * repeatedly. A group whose parent would be the repository root is left alone — `**` is never a
 * legal `own` — so the result can still exceed `max`, which rule 2 then rejects.
 */
export function collapseOwn(globs: readonly OwnGlob[], max: number = OWN_GLOBS_MAX, fold = false): OwnGlob[] {
  let out = dedupeContained(globs, fold);
  while (out.length > max) {
    const groups = new Map<string, OwnGlob[]>();
    for (const g of out) {
      const p = parentDir(g);
      if (p === '') continue;
      const list = groups.get(p);
      if (list === undefined) groups.set(p, [g]);
      else list.push(g);
    }
    let best: string | null = null;
    let bestDepth = -1;
    let bestSize = 0;
    for (const [p, list] of groups) {
      const depth = p.split('/').length;
      if (list.length < 2 && groups.size > 1) continue;
      if (depth > bestDepth || (depth === bestDepth && list.length > bestSize)) {
        best = p;
        bestDepth = depth;
        bestSize = list.length;
      }
    }
    if (best === null) break;
    const keep = out.filter((g) => parentDir(g) !== best);
    const merged: OwnGlob = { raw: `${best}/**`, kind: 'tree', dir: best, ext: null };
    const next = dedupeContained([...keep, merged], fold);
    if (next.length >= out.length) break;
    out = next;
  }
  return out;
}

export interface ValidateOwnOptions {
  /** OWN_GLOBS_MAX unless the caller is collapsing first */
  max?: number;
  /** repo-relative prefixes the glob may never touch: `.git`, every submodule path, every secretPath */
  deny?: readonly string[];
  /** the volume folds case (APFS / NTFS): overlap is computed case-insensitively */
  fold?: boolean;
}

export type ValidateOwnResult = { ok: true; globs: OwnGlob[] } | { ok: false; reason: string };

/**
 * Parse, deny-check, collapse and bound one agent's `own` list. The caller supplies `deny` because
 * `.gitmodules`, `--show-superproject-working-tree` and `secretPaths` are I/O and configuration, and
 * this module has neither.
 */
export function validateOwnList(raws: readonly string[], opts: ValidateOwnOptions = {}): ValidateOwnResult {
  const max = opts.max ?? OWN_GLOBS_MAX;
  const fold = opts.fold ?? false;
  if (raws.length === 0) return { ok: false, reason: 'own is empty: every agent must own something' };
  const globs: OwnGlob[] = [];
  for (const raw of raws) {
    const p = parseOwnGlob(raw);
    if (!p.ok) return { ok: false, reason: p.reason };
    globs.push(p.glob);
  }
  for (const g of globs) {
    const head = key(g.dir, fold);
    if (head === '.git' || head.startsWith('.git/')) return { ok: false, reason: `own glob "${g.raw}" names the git directory` };
    for (const d of opts.deny ?? []) {
      const dk = key(nfc(d).replace(/\/+$/, ''), fold);
      if (dk.length === 0) continue;
      if (head === dk || head.startsWith(`${dk}/`) || dk.startsWith(`${head}/`)) return { ok: false, reason: `own glob "${g.raw}" overlaps "${d}", which an agent may never own` };
    }
  }
  const collapsed = collapseOwn(globs, max, fold);
  if (collapsed.length > max) return { ok: false, reason: `own holds ${collapsed.length} globs after prefix-collapse; the limit is ${max}` };
  return { ok: true, globs: collapsed };
}

/** The raw strings of a parsed list, for `AgentSpec.own`. */
export function ownStrings(globs: readonly OwnGlob[]): string[] {
  return globs.map((g) => g.raw);
}
