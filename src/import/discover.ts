/**
 * docs/IMPORT-DESIGN.md §4.2 — detect and read.
 *
 * The bounded walk (§4.2.2), realpath identity (§4.2.3), the capped read (§4.2.4), the
 * `SourceItem` output (§4.2.5) and the metadata-only transcript pass (§4.2.6). Every filesystem
 * call goes through the injected `ImportFs` seam and every timestamp through `ImportClock`, so the
 * whole wave is unit-testable over a temp directory and `nodeImportFs()` is the only place
 * `node:fs` is touched. **Nothing here writes, executes or fetches anything** (§0 principle 1):
 * discovery is read-only, a secret-named path is never opened for content, and a transcript is
 * never read at all unless `--source` names it.
 *
 * Exceeding a cap is never an abort: the rows found so far are returned together with a
 * `<root> walk stopped at <cap>` notice (§4.2.2).
 */
import { open, readdir, realpath as nodeRealpath, lstat as nodeLstat, readFile as nodeReadFile, stat as nodeStat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { basename, join, resolve as resolvePath } from 'node:path';
import { sha256Hex } from '../core/hash.js';
import { IMPORT_LIMITS, type ImportLimits } from '../core/limits.js';
import { isSecretBasename, isWithin } from '../sandbox/paths.js';
import { ALWAYS_EXCLUDED, displayIn, displayRoot, globCanDescend, matchGlob, rootFor, SOURCES } from './sources.js';
import { parseJsonc } from './parse/jsonc.js';
import { parseJsonl, transcriptMeta } from './parse/jsonl.js';
import { looksBinary, parseMarkdown, redactSecrets } from './parse/markdown.js';
import { parseMdc } from './parse/mdc.js';
import { parseSqlite } from './parse/sqlite.js';
import { parseToml } from './parse/toml.js';
import type {
  ImportClock,
  ImportEnvironment,
  ImportFs,
  ImportProbe,
  ImportSkipAction,
  MarkdownDoc,
  ResolvedRoot,
  SourceItem,
  SourceParse,
  SourceSpec,
  SourceTool,
} from './types.js';

/** §4.2: everything discovery needs, all of it injectable. */
export interface DiscoverOptions {
  env: ImportEnvironment;
  fs: ImportFs;
  clock: ImportClock;
  /** default `SOURCES` */
  sources?: readonly SourceSpec[];
  /** `--source` values; a transcript row stays `skip:transcript` unless it is named (§4.2.6) */
  optIn?: readonly string[];
  /** default: on for repo roots, off for home roots */
  respectGitignore?: boolean;
  /** `--all` (promotes `skip:unrelated` later; the always-exclusions still apply) */
  all?: boolean;
  limits?: ImportLimits;
  /** absolute destination paths, for `skip:self` (§4.2.3) */
  destinations?: readonly string[];
  /**
   * §2.9: the **exact** layer only — the session redactor's `SecretSet` pass, threaded from
   * `planImport({ redact })`. Discovery always additionally scans all fifteen families
   * (`redactSecrets`), so a caller that has no configured secrets passes nothing rather than
   * `patternRedact`; passing a pattern-only redactor here would not be wrong, merely redundant.
   */
  redact?: (s: string) => string;
  signal?: AbortSignal;
}

/** §4.2.5: the discovery result — items, the roots as the report names them, and the walk notices. */
export interface DiscoverResult {
  items: readonly SourceItem[];
  roots: readonly ResolvedRoot[];
  notices: readonly string[];
  /**
   * §1 property 14: the `md` / `mdc` parse `buildItem` already performed, keyed by
   * `SourceItem.id`, so the facade does not read and parse the same body a second time
   * (review defect 6b).
   *
   * **Best-effort and bounded** — `docBudget` caps it, `format: 'text'` rows are not markdown
   * -parsed by discovery and so are never in it, and `probeImport` parses nothing at all, so a
   * miss is ordinary and the caller must keep its own parse path for one.
   */
  docs: ReadonlyMap<string, MarkdownDoc>;
}

/**
 * §1 property 14 / §2.8: what `DiscoverResult.docs` may retain. Following `items` is not an
 * option — `planRows` is 2,000 and `sourceReadCapBytes` is 4 MiB, so the unbounded map's worst
 * case is 8 GiB of live bodies. A quarter of `planRows` documents and twice the read cap of
 * body text (500 entries / 8 MiB at the default bounds, so the two largest readable files
 * always fit) is the whole budget; past either, an item keeps its `SourceParse` summary, loses
 * only its doc, and the caller re-parses that one body.
 */
export function docBudget(limits: ImportLimits): Readonly<{ maxEntries: number; maxBytes: number }> {
  return { maxEntries: Math.floor(limits.planRows / 4), maxBytes: 2 * limits.sourceReadCapBytes };
}

// ---------------------------------------------------------------------------------------
// the production seams
// ---------------------------------------------------------------------------------------

/** §4.2: the one place `node:fs` is touched. Read-only by construction — there is no write method. */
export function nodeImportFs(): ImportFs {
  return {
    readdir: (p: string) => readdir(p, { withFileTypes: true }),
    stat: (p: string) => nodeStat(p),
    lstat: (p: string) => nodeLstat(p),
    realpath: (p: string) => nodeRealpath(p),
    readFile: (p: string) => nodeReadFile(p),
    readPrefix: async (p: string, bytes: number): Promise<Buffer> => {
      const fh = await open(p, 'r');
      try {
        const buf = Buffer.alloc(Math.max(0, bytes));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
  };
}

/** §4.2: the wall clock, for artefact timestamps, `walkMs` and the probe deadline. */
export function systemClock(): ImportClock {
  return { now: () => new Date(), monotonicMs: () => performance.now() };
}

// ---------------------------------------------------------------------------------------
// §4.2.4 the read
// ---------------------------------------------------------------------------------------

function errnoCode(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : 'error';
}

interface ReadFailure {
  ok: false;
  reason: ImportSkipAction;
  error: string;
}

/**
 * §4.2.4 / §6 rows 29 and 31: `stat().isFile()` before any open, the cap checked against the
 * stat'd size, and the read itself capped at that size + `readSlackBytes` so a file that grows
 * under us is `skip:oversize (grew during read)` rather than an unbounded read. A secret-named
 * path is refused here, not later: it is never opened for content at all (§4.2.2).
 */
async function readRaw(path: string, fs: ImportFs, limits: ImportLimits): Promise<{ ok: true; buf: Buffer } | ReadFailure> {
  if (isSecretBasename(basename(path))) return { ok: false, reason: 'skip:secret', error: 'secret-named path: existence only, never content' };
  let size: number;
  try {
    const st = await fs.stat(path);
    if (!st.isFile()) return { ok: false, reason: 'skip:not-a-file', error: 'not a regular file' };
    size = st.size;
  } catch (e) {
    return { ok: false, reason: 'skip:unsupported', error: `cannot stat: ${errnoCode(e)}` };
  }
  if (size > limits.sourceReadCapBytes) {
    return { ok: false, reason: 'skip:oversize', error: `${size.toLocaleString('en-US')} bytes; larger than ${limits.sourceReadCapBytes / (1024 * 1024)} MiB` };
  }
  let buf: Buffer;
  try {
    buf = await fs.readPrefix(path, size + limits.readSlackBytes + 1);
  } catch (e) {
    return { ok: false, reason: 'skip:unsupported', error: `cannot read: ${errnoCode(e)}` };
  }
  if (buf.length > size + limits.readSlackBytes) return { ok: false, reason: 'skip:oversize', error: 'grew during read' };
  if (looksBinary(buf, limits.binarySniffBytes)) return { ok: false, reason: 'skip:not-text', error: 'not text (NUL or invalid UTF-8 in the first 8 KiB)' };
  return { ok: true, buf };
}

/** §4.2.4: read one item's body under `sourceReadCapBytes`. Total — it never throws. */
export async function readSource(
  item: SourceItem,
  fs: ImportFs,
  limits: ImportLimits = IMPORT_LIMITS,
): Promise<{ ok: true; text: string } | { ok: false; reason: ImportSkipAction; error: string }> {
  try {
    const r = await readRaw(item.realpath, fs, limits);
    if (!r.ok) return { ok: false, reason: r.reason, error: r.error };
    return { ok: true, text: r.buf.toString('utf8') };
  } catch (e) {
    return { ok: false, reason: 'skip:unsupported', error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------------------
// §3.2 / §6 row 15 — Claude's project slug
// ---------------------------------------------------------------------------------------

/** Claude's slug: the absolute path with `/` and `.` both folded to `-`, so `/x/.claude/y` carries a doubled dash. */
export function slugOfPath(path: string): string {
  // Claude folds BOTH separators: `/Users/x/JevCode/.claude/worktrees/w` → `-Users-x-JevCode--claude-worktrees-w`
  // (the doubled dash in the real observed slug is `/` + `.`, §6 row 15). Hence two replacements, not one.
  return path.split('/').join('-').split('.').join('-');
}

/**
 * §3.2 / §6 row 15: a slug is **not reversible** when the path contains `-`
 * (`-Users-…-JevCode--claude-worktrees-llm-jev-int` is one real example). Resolution order:
 * the `projects` keys of `~/.claude.json` (absolute paths) → a transcript record's `cwd` →
 * `unmapped`, which the report renders with "pick a path". Pure.
 */
export function slugToPath(slug: string, claudeJsonProjects: readonly string[], transcriptCwd?: string | null): { path: string; via: 'claude-json' | 'transcript' | 'unmapped' } {
  for (const p of claudeJsonProjects) if (slugOfPath(p) === slug) return { path: p, via: 'claude-json' };
  if (transcriptCwd !== undefined && transcriptCwd !== null && transcriptCwd.length > 0) return { path: transcriptCwd, via: 'transcript' };
  return { path: '', via: 'unmapped' };
}

/**
 * §3.2 / §6 row 15: auto memory is derived from the **git repository**, so the 25 worktree slugs
 * under `<repo>/.claude/worktrees/<name>` all share one memory dir — they merge into the resolved
 * repo root, and the notice says so rather than silently folding them.
 */
export function mergeWorktreeRoot(path: string): { root: string; merged: boolean; notice: string | null } {
  const marker = '/.claude/worktrees/';
  const at = path.indexOf(marker);
  if (at === -1) return { root: path, merged: false, notice: null };
  const root = path.slice(0, at);
  return { root, merged: true, notice: `${path} is a worktree of ${root}; auto memory is merged into the repository root` };
}

// ---------------------------------------------------------------------------------------
// §4.2.2 the walk
// ---------------------------------------------------------------------------------------

interface GitignoreRule {
  negate: boolean;
  dirOnly: boolean;
  pattern: string;
}

const MAX_GITIGNORE_RULES = 1_000;

function parseGitignore(text: string): GitignoreRule[] {
  const out: GitignoreRule[] = [];
  for (const raw of text.split('\n')) {
    if (out.length >= MAX_GITIGNORE_RULES) break;
    let line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    if (line.length === 0) continue;
    out.push({ negate, dirOnly, pattern: anchored ? line : `**/${line}` });
  }
  return out;
}

function gitignored(rules: readonly GitignoreRule[], rel: string, isDir: boolean): boolean {
  let hit = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (!matchGlob(r.pattern, rel) && !matchGlob(`${r.pattern}/**`, rel)) continue;
    hit = !r.negate;
  }
  return hit;
}

/** §4.2.2: the always-exclusions, applied before any `stat` — `.claude/worktrees` is 50 000 entries (§3.12). */
function excluded(rel: string, isDir: boolean): boolean {
  for (const g of ALWAYS_EXCLUDED) {
    if (matchGlob(g, rel, true)) return true;
    if (isDir && g.endsWith('/**') && matchGlob(g.slice(0, -3), rel, true)) return true;
  }
  return false;
}

function flipCase(name: string): string {
  let out = '';
  for (const ch of name) {
    const lower = ch.toLowerCase();
    out += ch === lower ? ch.toUpperCase() : lower;
  }
  return out;
}

/**
 * §4.2.2 / §6 row 16 **[G1.6]**: is this volume case-insensitive? Decided by a **probe**, cached
 * per root, never by `platform`. The probe is read-only (discovery writes nothing, §0): it takes
 * an existing entry, stats the case-flipped name, and compares `dev:ino`. A case-sensitive APFS
 * volume therefore keeps `CLAUDE.md` and `claude.md` as two distinct rows.
 */
async function probeCaseInsensitive(fs: ImportFs, root: string, names: readonly string[]): Promise<boolean> {
  for (const name of names.slice(0, 16)) {
    const flipped = flipCase(name);
    if (flipped === name) continue;
    try {
      const a = await fs.stat(join(root, name));
      const b = await fs.stat(join(root, flipped));
      return a.dev === b.dev && a.ino === b.ino;
    } catch {
      return false;
    }
  }
  return false;
}

interface Found {
  rel: string;
  abs: string;
  real: string;
  size: number;
  mtimeMs: number;
  isFile: boolean;
  symlinkOut: boolean;
  patterns: number[];
}

interface WalkResult {
  found: Found[];
  notices: string[];
  caseInsensitive: boolean;
}

interface PatternRef {
  specIndex: number;
  pattern: string;
}

interface WalkContext {
  fs: ImportFs;
  clock: ImportClock;
  limits: ImportLimits;
  home: string;
  deadlineMs: number | null;
  signal: AbortSignal | undefined;
  respectGitignore: boolean;
}

async function realOrSelf(fs: ImportFs, p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return resolvePath(p);
  }
}

/** §4.2.2: one bounded, pruned, cycle-safe walk of one root. Never throws, never aborts on a cap. */
async function walkRoot(root: string, patterns: readonly PatternRef[], ctx: WalkContext): Promise<WalkResult> {
  const { fs, limits } = ctx;
  const display = displayRoot(root, ctx.home);
  const notices: string[] = [];
  const found: Found[] = [];
  const started = ctx.clock.monotonicMs();
  const rootReal = await realOrSelf(fs, root);
  let caseInsensitive = false;

  let rootIsFile = false;
  try {
    const st = await fs.stat(root);
    rootIsFile = st.isFile();
    if (rootIsFile) {
      found.push({ rel: '', abs: root, real: rootReal, size: st.size, mtimeMs: st.mtimeMs, isFile: true, symlinkOut: false, patterns: patterns.filter((p) => p.pattern === '.').map((p) => p.specIndex) });
      return { found: found.filter((f) => f.patterns.length > 0), notices, caseInsensitive };
    }
  } catch (e) {
    const code = errnoCode(e);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') notices.push(`cannot read ${display}: ${code}`);
    return { found, notices, caseInsensitive };
  }

  let gitignore: readonly GitignoreRule[] = [];
  if (ctx.respectGitignore) {
    try {
      gitignore = parseGitignore((await fs.readFile(join(root, '.gitignore'))).toString('utf8'));
    } catch {
      gitignore = [];
    }
  }

  const visited = new Set<string>();
  try {
    const st = await fs.stat(root);
    visited.add(`${st.dev}:${st.ino}`);
  } catch {
    // the root was stat'd above; an error here only costs the cycle seed
  }
  const stack: { dir: string; rel: string; depth: number; alive: readonly number[] }[] = [{ dir: root, rel: '', depth: 0, alive: patterns.map((_, i) => i) }];
  let entries = 0;
  let stop: string | null = null;
  let depthHit = false;
  let cycleHit = false;
  let first = true;

  while (stack.length > 0 && stop === null) {
    const cur = stack.pop()!;
    if (ctx.signal?.aborted === true) {
      stop = 'aborted';
      break;
    }
    const elapsed = ctx.clock.monotonicMs() - started;
    if (elapsed > limits.walkMs) {
      stop = `walkMs ${limits.walkMs}`;
      break;
    }
    if (ctx.deadlineMs !== null && ctx.clock.monotonicMs() > ctx.deadlineMs) {
      stop = 'the probe deadline';
      break;
    }
    let dirents: readonly { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }[];
    try {
      dirents = await ctx.fs.readdir(cur.dir);
    } catch (e) {
      notices.push(`cannot read ${displayRoot(cur.dir, ctx.home)}: ${errnoCode(e)}`);
      continue;
    }
    if (first) {
      first = false;
      caseInsensitive = await probeCaseInsensitive(fs, root, dirents.map((d) => d.name));
    }
    for (const d of dirents) {
      entries++;
      if (entries > limits.walkEntries) {
        stop = `walkEntries ${limits.walkEntries}`;
        break;
      }
      const rel = cur.rel.length > 0 ? `${cur.rel}/${d.name}` : d.name;
      const abs = join(cur.dir, d.name);
      let isDir = d.isDirectory();
      let isFile = d.isFile();
      let real = abs;
      let symlinkOut = false;
      if (d.isSymbolicLink()) {
        real = await realOrSelf(fs, abs);
        symlinkOut = !isWithin(rootReal, real);
        try {
          const st = await fs.stat(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // a dangling symlink is not an artefact
        }
      }
      if (excluded(rel, isDir)) continue;
      if (gitignore.length > 0 && gitignored(gitignore, rel, isDir)) continue;
      if (isDir) {
        // §6 row 13: a directory where a file is expected is `skip:not-a-file`, never an open
        const asFile = cur.alive.filter((i) => matchGlob(patterns[i]!.pattern, rel, true));
        if (asFile.length > 0) found.push({ rel, abs, real: await realOrSelf(fs, abs), size: 0, mtimeMs: 0, isFile: false, symlinkOut, patterns: asFile.map((i) => patterns[i]!.specIndex) });
        if (symlinkOut) continue; // §4.2.2: never followed out of the root that found it
        if (cur.depth + 1 > limits.walkDepth) {
          depthHit = true;
          continue;
        }
        const alive = cur.alive.filter((i) => globCanDescend(patterns[i]!.pattern, rel, true));
        if (alive.length === 0) continue;
        try {
          // the **followed** identity, so a symlink back to an ancestor is caught as the cycle it is
          const st = await fs.stat(abs);
          const key = `${st.dev}:${st.ino}`;
          if (visited.has(key)) {
            cycleHit = true;
            continue;
          }
          visited.add(key);
        } catch {
          continue;
        }
        stack.push({ dir: abs, rel, depth: cur.depth + 1, alive });
        continue;
      }
      const matched = cur.alive.filter((i) => matchGlob(patterns[i]!.pattern, rel, true));
      if (matched.length === 0) continue;
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = await fs.stat(abs);
        size = st.size;
        mtimeMs = st.mtimeMs;
        isFile = st.isFile();
      } catch (e) {
        notices.push(`cannot read ${displayRoot(abs, ctx.home)}: ${errnoCode(e)}`);
        continue;
      }
      if (!d.isSymbolicLink()) real = await realOrSelf(fs, abs);
      found.push({ rel, abs, real, size, mtimeMs, isFile, symlinkOut, patterns: matched.map((i) => patterns[i]!.specIndex) });
    }
  }
  if (stop !== null) notices.push(stop === 'aborted' ? `${display} walk stopped (aborted)` : `${display} walk stopped at ${stop}`);
  if (depthHit) notices.push(`${display} walk stopped at walkDepth ${limits.walkDepth}`);
  if (cycleHit) notices.push(`${display} walk stopped (cycle)`);
  return { found, notices, caseInsensitive };
}

// ---------------------------------------------------------------------------------------
// §4.2.5 output
// ---------------------------------------------------------------------------------------

/** The `skip:*` an atlas row's notes declare (`skip:third-party`, `skip:tool-managed`, …). */
function declaredSkip(spec: SourceSpec): ImportSkipAction {
  for (const n of spec.notes ?? []) {
    const m = /^(skip:[a-z-]+)/.exec(n);
    if (m !== null) return m[1] as ImportSkipAction;
  }
  return 'skip:unsupported';
}

/**
 * §4.3: the parse summary one row carries, and — for the two markdown formats — the
 * `MarkdownDoc` it came from, so `DiscoverResult.docs` can hand the facade the parse instead of
 * making it repeat one (review defect 6b). `redact` is the heading redactor, already composed
 * from the exact layer (§2.9).
 */
function parseFor(format: SourceSpec['format'], text: string, path: string, limits: ImportLimits, redact: (s: string) => string): { parse: SourceParse; doc: MarkdownDoc | null } {
  const clipHeadings = (h: readonly string[]): readonly string[] => h.slice(0, limits.jevHeadings).map((s) => s.slice(0, limits.jevHeadingCells));
  const mdOptions = { headingLimit: limits.jevHeadings, headingCells: limits.jevHeadingCells, redact };
  switch (format) {
    case 'md': {
      const doc = parseMarkdown(text, mdOptions);
      return { parse: { ok: true, headings: clipHeadings(doc.headings), lines: doc.lines, fences: doc.fences, ...(doc.frontmatter !== null ? { frontmatterKeys: doc.frontmatter.keys } : {}) }, doc };
    }
    case 'mdc': {
      const r = parseMdc(text, mdOptions);
      if (!r.ok) return { parse: { ok: false, error: r.error }, doc: null };
      const { doc, frontmatter } = r.value;
      return { parse: { ok: true, headings: clipHeadings(doc.headings), lines: doc.lines, fences: doc.fences, ...(frontmatter !== null ? { frontmatterKeys: frontmatter.keys } : {}) }, doc };
    }
    case 'json':
    case 'jsonc': {
      const r = parseJsonc(text);
      const lines = text.split('\n').length;
      if (!r.ok) return { parse: { ok: false, error: r.error, lines }, doc: null };
      const keys = r.value !== null && typeof r.value === 'object' && !Array.isArray(r.value) ? Object.keys(r.value) : [];
      return { parse: { ok: true, lines, frontmatterKeys: keys }, doc: null };
    }
    case 'toml': {
      const r = parseToml(text);
      const lines = text.split('\n').length;
      if (!r.ok) return { parse: { ok: false, error: r.error, lines }, doc: null };
      return { parse: { ok: true, lines, frontmatterKeys: r.value.slice(0, 64).map((l) => l.dotted) }, doc: null };
    }
    case 'jsonl': {
      const r = parseJsonl(text, { maxBytes: limits.transcriptScanBytes });
      if (!r.ok) return { parse: { ok: false, error: r.error }, doc: null };
      return { parse: { ok: true, lines: r.value.length }, doc: null };
    }
    case 'sqlite': {
      const r = parseSqlite(path);
      return { parse: { ok: false, error: r.ok ? 'skip:unsupported: sqlite (no reader)' : r.error }, doc: null };
    }
    default:
      return { parse: { ok: true, lines: text.split('\n').length }, doc: null };
  }
}

interface ItemDraft {
  item: SourceItem;
  tools: Set<SourceTool>;
}

function isDestination(real: string, destinations: readonly string[]): boolean {
  return destinations.some((d) => real === d || isWithin(d, real));
}

interface CollectOptions extends DiscoverOptions {
  /** probe mode: stat only, no read, no parse, and the opt-in rows are dropped entirely */
  probe?: boolean;
  deadlineMs?: number;
}

interface Collected {
  items: SourceItem[];
  roots: ResolvedRoot[];
  notices: string[];
  docs: Map<string, MarkdownDoc>;
  partial: boolean;
}

async function collect(opts: CollectOptions): Promise<Collected> {
  const limits = opts.limits ?? IMPORT_LIMITS;
  const optIn = opts.optIn ?? [];
  const destinations = (opts.destinations ?? []).map((d) => resolvePath(d));
  const probe = opts.probe === true;
  // §4.2.5: items are keyed by realpath, so the workspace they are displayed against must be the
  // realpath too (macOS `/var` -> `/private/var`). Resolved once; falls back to the given path.
  const wsReal = await opts.fs.realpath(opts.env.workspace).catch(() => resolvePath(opts.env.workspace));
  // …and for exactly the same reason the **home** must be canonical too: `displayIn` folds to
  // `~/…` by prefix, so a `$HOME` reached through a symlink (every macOS `mkdtemp`: `/var/…`
  // against a `/private/var/…` realpath) silently produced an absolute display, which
  // `ApplyOptions.sourcePath` cannot invert to re-read the source (§4.7.2) and which would be
  // baked into `MemoryProvenance.path` and `sources.jsonl`.
  const homeReal = await opts.fs.realpath(opts.env.home).catch(() => resolvePath(opts.env.home));
  // §2.9: headings go through the exact layer first, then all fifteen families (§1 property 4)
  const exact = opts.redact === undefined ? undefined : { redact: opts.redact };
  const redactHeading = (s: string): string => redactSecrets(s, exact);
  const specs = (opts.sources ?? SOURCES).filter((s) => {
    if (s.optIn !== undefined && !optIn.includes(s.optIn)) return !probe;
    if (probe && (s.class === 'skip' || s.class === 'secret')) return false;
    return true;
  });
  const deadline = opts.deadlineMs === undefined ? null : opts.clock.monotonicMs() + opts.deadlineMs;

  // group the atlas by root path: one walk per path, however many rows point at it
  const byRoot = new Map<string, { roots: ResolvedRoot[]; patterns: PatternRef[] }>();
  const orderedRoots: ResolvedRoot[] = [];
  specs.forEach((spec, specIndex) => {
    for (const root of rootFor(spec, opts.env.env, opts.env.home, opts.env.platform, { workspace: opts.env.workspace, gitRoot: opts.env.gitRoot, extraRoots: opts.env.extraRoots })) {
      let slot = byRoot.get(root.path);
      if (slot === undefined) {
        slot = { roots: [], patterns: [] };
        byRoot.set(root.path, slot);
      }
      if (!slot.roots.some((r) => r.tool === root.tool && r.env === root.env)) {
        slot.roots.push(root);
        orderedRoots.push(root);
      }
      slot.patterns.push({ specIndex, pattern: spec.pattern });
    }
  });

  const notices: string[] = [];
  const drafts = new Map<string, ItemDraft>();
  const docs = new Map<string, MarkdownDoc>();
  const budget = docBudget(limits);
  let docBytes = 0;
  const perSpec = new Map<number, number>();
  const rootExists = new Map<string, boolean>();
  let partial = false;

  for (const [path, slot] of byRoot) {
    if (opts.signal?.aborted === true) {
      partial = true;
      break;
    }
    if (deadline !== null && opts.clock.monotonicMs() > deadline) {
      partial = true;
      break;
    }
    const repoRoot = slot.roots.some((r) => r.kind === 'repo');
    const ctx: WalkContext = {
      fs: opts.fs,
      clock: opts.clock,
      limits,
      home: opts.env.home,
      deadlineMs: deadline,
      signal: opts.signal,
      respectGitignore: opts.respectGitignore ?? repoRoot,
    };
    let exists = false;
    try {
      await opts.fs.stat(path);
      exists = true;
    } catch {
      exists = false;
    }
    rootExists.set(path, exists);
    if (!exists) continue;
    const walk = await walkRoot(path, slot.patterns, ctx);
    notices.push(...walk.notices);
    if (walk.notices.some((n) => n.includes('walk stopped'))) partial = true;

    for (const f of walk.found) {
      for (const specIndex of f.patterns) {
        const spec = specs[specIndex]!;
        const used = perSpec.get(specIndex) ?? 0;
        if (used >= limits.filesPerRow) {
          if (used === limits.filesPerRow) {
            notices.push(`${spec.id} stopped at filesPerRow ${limits.filesPerRow}`);
            perSpec.set(specIndex, used + 1);
            partial = true;
          }
          continue;
        }
        perSpec.set(specIndex, used + 1);
        const key = walk.caseInsensitive ? f.real.toLowerCase() : f.real;
        const existing = drafts.get(key);
        if (existing !== undefined) {
          if (!existing.tools.has(spec.tool)) {
            existing.tools.add(spec.tool);
            existing.item = { ...existing.item, tools: [...existing.tools] };
            drafts.set(key, existing);
          }
          continue;
        }
        const built = await buildItem(f, spec, { ...opts, limits, destinations, probe, optIn, wsReal, homeReal, redactHeading, rootDisplay: displayRoot(path, opts.env.home) });
        drafts.set(key, { item: built.item, tools: new Set(built.item.tools) });
        if (built.doc !== null && docs.size < budget.maxEntries && docBytes + built.doc.text.length <= budget.maxBytes) {
          docs.set(built.item.id, built.doc);
          docBytes += built.doc.text.length;
        }
      }
    }
  }

  const items = [...drafts.values()].map((d) => d.item);
  const roots = orderedRoots.map((r) => ({ ...r, exists: rootExists.get(r.path) ?? false }));
  return { items, roots, notices, docs, partial };
}

interface BuildContext extends DiscoverOptions {
  limits: ImportLimits;
  destinations: readonly string[];
  probe: boolean;
  optIn: readonly string[];
  /** the `~/…` form of the root that found this item — the symlink notice names it (§6 row 10) */
  rootDisplay: string;
  /**
   * realpath of the workspace. Items are keyed by realpath, so `display` must be measured against
   * the canonical workspace too: on macOS `/var` is a symlink to `/private/var`, and comparing a
   * realpath'd item against the given workspace path silently produces an absolute display that
   * `ApplyOptions.sourcePath` cannot invert (every row then fails its §4.7.2 re-read).
   */
  wsReal: string;
  /** realpath of the home, for the same reason and with the same consequence */
  homeReal: string;
  /** §2.9: the exact layer composed with all fifteen families, applied to every heading */
  redactHeading: (s: string) => string;
}

/** One discovered file: the row, and the markdown parse behind it when there was one. */
interface Built {
  item: SourceItem;
  doc: MarkdownDoc | null;
}

/**
 * `~/…` measured against the canonical home, falling back to the one the caller gave: a path
 * this module did not `realpath` itself (a `cwd` another tool recorded in a transcript) may be
 * in either form.
 */
function displayHome(path: string, ctx: BuildContext): string {
  const real = displayRoot(path, ctx.homeReal);
  return real.startsWith('~') ? real : displayRoot(path, ctx.env.home);
}

async function buildItem(f: Found, spec: SourceSpec, ctx: BuildContext): Promise<Built> {
  const limits = ctx.limits;
  const notices: string[] = [];
  const base: SourceItem = {
    id: sha256Hex(f.real).slice(0, 12),
    realpath: f.real,
    display: displayIn(f.real, ctx.wsReal, ctx.homeReal),
    tools: [spec.tool],
    artefact: spec.id,
    format: spec.format,
    scope: spec.scope,
    bytes: f.size,
    sha256: '',
    mtime: new Date(f.mtimeMs).toISOString(),
    parse: { ok: true },
    notices,
  };
  const bare = (item: SourceItem): Built => ({ item, doc: null });
  if (!f.isFile) {
    notices.push('skip:not-a-file');
    return bare(base);
  }
  if (f.symlinkOut) {
    notices.push(`skip:symlink — resolves outside ${ctx.rootDisplay}`);
    return bare(base);
  }
  if (isDestination(f.real, ctx.destinations)) {
    notices.push('skip:self');
    return bare(base);
  }
  if (spec.class === 'secret' || isSecretBasename(basename(f.real))) {
    notices.push('skip:secret — named, never read');
    return bare(base);
  }
  if (spec.class === 'skip') {
    notices.push(`${declaredSkip(spec)}${spec.notes !== undefined && spec.notes.length > 0 ? ` — ${spec.notes[0]!.replace(/^skip:[a-z-]+\s*—?\s*/, '')}` : ''}`);
    return bare(base);
  }
  if (spec.class === 'transcript') {
    if (spec.optIn === undefined || !ctx.optIn.includes(spec.optIn)) {
      notices.push('skip:transcript');
      return bare(base);
    }
    if (ctx.probe) return bare(base);
    try {
      const head = await ctx.fs.readPrefix(f.real, limits.transcriptScanBytes);
      // §2.9 / §1 property 4: the first user message is source text, so it needs all fifteen
      // families and the exact layer — `patternRedact` would have let a warn-only one through
      const meta = transcriptMeta(head, { redact: ctx.redactHeading });
      notices.push(
        `transcript: session ${meta.sessionId ?? 'unknown'} · cwd ${meta.cwd === null ? 'unknown' : displayHome(meta.cwd, ctx)} · branch ${meta.gitBranch ?? 'unknown'} · ${meta.records} records${
          meta.startedAt !== null ? ` · ${meta.startedAt}` : ''
        }${meta.firstUserMessage !== null ? ` · "${meta.firstUserMessage}"` : ''}`,
      );
      return bare({ ...base, sha256: sha256Hex(head), parse: { ok: true, lines: meta.records } });
    } catch (e) {
      notices.push(`skip:parse-error — ${e instanceof Error ? e.message : String(e)}`);
      return bare(base);
    }
  }
  if (ctx.probe) return bare(base);
  const read = await readRaw(f.real, ctx.fs, limits);
  if (!read.ok) {
    notices.push(`${read.reason} — ${read.error}`);
    return bare({ ...base, parse: { ok: false, error: `${read.reason}: ${read.error}` } });
  }
  const text = read.buf.toString('utf8');
  const { parse, doc } = parseFor(spec.format, text, f.real, limits, ctx.redactHeading);
  if (!parse.ok) notices.push(`skip:parse-error — ${parse.error ?? 'unparsable'}`);
  return { item: { ...base, sha256: sha256Hex(read.buf), parse }, doc };
}

// ---------------------------------------------------------------------------------------
// the two entry points
// ---------------------------------------------------------------------------------------

/**
 * §4.2: discover every artefact the atlas knows about on the local machine. Read-only, bounded, and
 * total: a cap, an `EACCES` or a malformed file is a notice or a `skip:*`, never an exception and
 * never an early return that loses the rows found so far.
 */
export async function discover(opts: DiscoverOptions): Promise<DiscoverResult> {
  const r = await collect(opts);
  return { items: r.items, roots: r.roots, notices: r.notices, docs: r.docs };
}

/**
 * §5.1: the ≤ 50 ms wizard probe — stat only. It never opens a body, never runs a parser, and
 * drops every opt-in, secret and skip row before the walk, so "3 tools, 61 items" costs a few
 * directory listings. `partial` is true when a cap or the deadline stopped it early.
 */
export async function probeImport(opts: DiscoverOptions & { deadlineMs?: number }): Promise<ImportProbe> {
  const started = opts.clock.monotonicMs();
  const r = await collect({ ...opts, probe: true, deadlineMs: opts.deadlineMs ?? 50 });
  const counts = new Map<SourceTool, number>();
  for (const item of r.items) {
    if (item.notices.some((n) => n.startsWith('skip:'))) continue;
    for (const t of item.tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const tools = [...counts.entries()].map(([tool, items]) => ({
    tool,
    display: r.roots.find((root) => root.tool === tool && root.exists)?.display ?? r.roots.find((root) => root.tool === tool)?.display ?? '',
    items,
  }));
  const total = tools.reduce((n, t) => n + t.items, 0);
  return { tools, total, ms: Math.round(opts.clock.monotonicMs() - started), partial: r.partial };
}
