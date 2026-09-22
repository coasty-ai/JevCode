/**
 * Phase 4 — apply, resume, undo (docs/IMPORT-DESIGN.md §4.7, §4.8.2, §4.9; §6 group F).
 *
 * Everything here runs over the injected `ImportWriteFs`: **`src/import/**` performs no writes of its
 * own** (§0, the one-sentence contract), so every write is one the caller granted. The four properties
 * this module exists to hold:
 *
 *   - **[G1.1] the plan is what gets applied.** Every source is re-`stat`ed and re-hashed immediately
 *     before its destination is rendered; a mismatch demotes the row and writes nothing (§4.7.2).
 *   - **[G1.2] destinations are confined.** `confineDestination` re-asserts `isInside` at the seam and
 *     refuses a symlinked final component, after `slugOf` already sanitised the basename (§4.7.3).
 *   - **[G1.4] one lock.** `apply`, `--resume` *and* `--undo` take `~/.jevcode/imports/.lock`, because
 *     all three rewrite `apply.jsonl` and the manifest (§4.7.1). A missing pre-image on undo is a row
 *     outcome, not an exception (§4.7.6).
 *   - **§1 property 16 / §4.8.4 authority never widens.** Only `memory`, `rule`, `command` and `mcp`
 *     rows can reach a write at all; `secret`, `config` (permissions, hooks) and every `skip:*` row is
 *     structurally unwritable here, so "zero bytes of those classes" is a property of the code, not of
 *     the caller's `approved` list.
 */
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

import { sha256Hex } from '../core/hash.js';
import { IMPORT_LIMITS } from '../core/limits.js';
import { isWithin } from '../sandbox/paths.js';
import { mergeMcpFile, parseMcpFile, renderMcpFile } from './mcp.js';
import type { ImportClock, ImportManifest, ImportManifestEntry, ImportPlan, ImportWriteFs, PlanRow } from './types.js';

// ---------------------------------------------------------------------------------------
// §4.7.4: the order, exposed so the test can assert it rather than infer it
// ---------------------------------------------------------------------------------------

/**
 * §4.7.4: the nine steps, in the order they run. Order matters: credentials first so
 * `config.addSecret` registers before anything can print, `MEMORY.md` after the topic files whose
 * slugs it indexes, `AGENTS.md` last because the trust pin is recomputed after it.
 */
export const APPLY_ORDER: readonly string[] = [
  'pre-snapshots',
  'credentials',
  'memory-rules-commands',
  'memory-index',
  'mcp',
  'agents-append',
  'apply-log',
  'manifest',
  'trust-repin',
];

/** The subset of `APPLY_ORDER` that carries plan rows, in the same order. */
const ROW_STEPS: readonly string[] = ['credentials', 'memory-rules-commands', 'memory-index', 'mcp', 'agents-append'];

/** §4.8.4 / §1 property 16: the only four classes a write can come from. */
const WRITABLE_CLASSES: ReadonlySet<PlanRow['class']> = new Set<PlanRow['class']>(['memory', 'rule', 'command', 'mcp']);
const WRITABLE_ACTIONS: ReadonlySet<string> = new Set(['create', 'append', 'update', 'merge']);

/** §4.7.4: which step a row belongs to, from its destination alone. */
function stepOf(row: PlanRow): string {
  if (row.class === 'secret') return 'credentials';
  const name = row.dest === null ? '' : basename(row.dest);
  if (name === 'MEMORY.md') return 'memory-index';
  if (name === 'mcp.json') return 'mcp';
  if (name === 'AGENTS.md' || name === 'CLAUDE.md') return 'agents-append';
  return 'memory-rules-commands';
}

// ---------------------------------------------------------------------------------------
// §4.7.5: markers
// ---------------------------------------------------------------------------------------

/**
 * §4.7.5: the opening marker. A block-level HTML comment, which Claude Code strips when loading — so a
 * `CLAUDE.md` JevCode appended to stays clean for the other tool too. The sha is the source's, clipped
 * to eight characters like every other display form (§8.2 R9).
 */
export function markerOpen(importId: string, tool: string, path: string, sha256: string): string {
  return `<!-- jevcode:import ${importId} source=${tool}:${path} sha256=${sha256.slice(0, 8)} -->`;
}

/** §4.7.5: the closing marker of the pair. */
export function markerClose(importId: string): string {
  return `<!-- /jevcode:import ${importId} -->`;
}

const OPEN_RE = /<!-- jevcode:import (\S+)[^\n]* -->/g;

/**
 * §4.7.5: every complete marker pair in `text`, in order. `interiorStart`/`interiorEnd` bound the
 * imported text without the marker lines or the newlines that separate them, so a block can be
 * compared and replaced without touching a byte outside it. An unterminated opening marker is not a
 * block: the re-run matrix's "the block was edited or removed" cell depends on that.
 */
export function findMarkerBlocks(text: string): readonly { importId: string; start: number; end: number; interiorStart: number; interiorEnd: number }[] {
  const out: { importId: string; start: number; end: number; interiorStart: number; interiorEnd: number }[] = [];
  OPEN_RE.lastIndex = 0;
  let from = 0;
  for (;;) {
    OPEN_RE.lastIndex = from;
    const open = OPEN_RE.exec(text);
    if (open === null) return out;
    const importId = open[1]!;
    const close = markerClose(importId);
    const closeAt = text.indexOf(close, open.index + open[0].length);
    if (closeAt === -1) {
      from = open.index + open[0].length;
      continue;
    }
    const openEnd = open.index + open[0].length;
    const interiorStart = text[openEnd] === '\n' ? openEnd + 1 : openEnd;
    const interiorEnd = closeAt > interiorStart && text[closeAt - 1] === '\n' ? closeAt - 1 : closeAt;
    out.push({ importId, start: open.index, end: closeAt + close.length, interiorStart, interiorEnd });
    from = closeAt + close.length;
  }
}

/** The one rendering of a marker block; `appendBlock` and `replaceMarkerInterior` share it so `reconstructs` cannot drift. */
function renderBlock(header: string, interior: string, importId: string): string {
  return `${header}\n${interior}\n${markerClose(importId)}`;
}

/** §4.7.5: append a block to `base`, separated by exactly one blank line and terminated by one newline. */
function appendBlock(base: string, header: string, interior: string, importId: string): string {
  const sep = base.length === 0 ? '' : base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n';
  return `${base}${sep}${renderBlock(header, interior, importId)}\n`;
}

/**
 * §4.7.5 `update`: replace the named block's interior (and its header, which carries the new sha),
 * leaving every byte outside the block identical. `null` when no such block exists — the re-run
 * matrix's `review — the block was edited or removed; nothing was written`.
 */
export function replaceMarkerInterior(text: string, importId: string, interior: string, header: string): string | null {
  const block = findMarkerBlocks(text).find((b) => b.importId === importId);
  if (block === undefined) return null;
  return `${text.slice(0, block.start)}${renderBlock(header, interior, importId)}${text.slice(block.end)}`;
}

/**
 * §4.7.5 [G1.5]: the reconstruction test the trust re-pin uses. True when `after` is exactly `before`
 * plus these marker-delimited edits — old + the appended blocks, and old with each named block's
 * interior replaced — with every byte outside the blocks identical. Verified by reconstruction, never
 * by diffing prose: the spine's rule covered only `append`, so every changed-source re-import would
 * have re-prompted.
 */
export function reconstructs(before: string, after: string, edits: readonly { importId: string; interior: string; header: string; kind: 'append' | 'update' }[]): boolean {
  let expected = before;
  for (const edit of edits.filter((e) => e.kind === 'update')) {
    const next = replaceMarkerInterior(expected, edit.importId, edit.interior, edit.header);
    if (next === null) return false;
    expected = next;
  }
  for (const edit of edits.filter((e) => e.kind === 'append')) expected = appendBlock(expected, edit.header, edit.interior, edit.importId);
  return expected === after;
}

// ---------------------------------------------------------------------------------------
// §4.7.3 [G1.2]: destination confinement
// ---------------------------------------------------------------------------------------

/**
 * §4.7.3 [G1.2] steps 2 and 3, asserted again at the seam. `slugOf` (`plan.ts`) already sanitised the
 * basename; this refuses anything that still resolves outside `root` — including through a symlinked
 * *parent* directory an earlier row created, which is the real hazard — and refuses a symlinked final
 * component outright, because `writeFileAtomic` renames over the target rather than following it.
 */
export async function confineDestination(fs: ImportWriteFs, dest: string, root: string): Promise<{ ok: true; path: string } | { ok: false; why: string }> {
  if (typeof dest !== 'string' || dest.length === 0 || dest.includes('\0')) return { ok: false, why: 'destination is empty or malformed' };
  if (!isAbsolute(dest)) return { ok: false, why: 'destination is not an absolute path' };
  const resolved = resolve(dest);
  const lexicalRoot = resolve(root);
  if (!isWithin(lexicalRoot, resolved) || resolved === lexicalRoot) return { ok: false, why: 'destination escapes the destination tree' };
  // A project row's destination tree IS the repository (§2.2 puts `AGENTS.md` at its root), so `isInside`
  // alone would let `.jevcode/memory/../../.git/hooks/pre-commit` land an executable file. `.git` is
  // refused outright, the same rule `resolveInside` already applies to every harness write
  // (`paths.ts`), and case-insensitively because APFS and NTFS resolve `.GIT/hooks` to the same directory.
  if (resolved.slice(lexicalRoot.length).split(/[\\/]+/).some((s) => s.toLowerCase() === '.git')) {
    return { ok: false, why: 'destination is inside .git and is never written by JevCode' };
  }
  const realRoot = await fs.realpath(lexicalRoot).catch(() => lexicalRoot);
  // canonicalise the longest existing prefix of the parent, then re-append what does not exist yet
  let dir = dirname(resolved);
  const missing: string[] = [];
  for (;;) {
    const st = await fs.lstat(dir).catch(() => null);
    if (st !== null) break;
    const up = dirname(dir);
    if (up === dir) break;
    missing.unshift(basename(dir));
    dir = up;
  }
  const realDir = await fs.realpath(dir).catch(() => dir);
  const realParent = missing.length > 0 ? resolve(realDir, ...missing) : realDir;
  if (!isWithin(realRoot, realParent)) return { ok: false, why: 'destination directory resolves outside the destination tree' };
  const leaf = await fs.lstat(resolved).catch(() => null);
  if (leaf !== null && leaf.isSymbolicLink()) return { ok: false, why: 'destination is a symlink' };
  return { ok: true, path: resolve(realParent, basename(resolved)) };
}

/**
 * §4.7.4 step 1 / review defect 7: is this buffer exactly what it would be after a UTF-8 round trip?
 * `toString('utf8')` replaces every invalid sequence with U+FFFD, so a latin-1 `AGENTS.md` byte `e9`
 * comes back as `ef bf bd` — three bytes that are not the human's file. A destination that fails this
 * is refused, never corrected: `apply.ts` has no way to know the true encoding, and a rewrite would
 * destroy bytes undo could not restore.
 */
export function isValidUtf8(buf: Buffer): boolean {
  return Buffer.compare(Buffer.from(buf.toString('utf8'), 'utf8'), buf) === 0;
}

/**
 * §4.7.4 step 1 / §1 property 9 / review defect 2: the `pre/` snapshot key is the **destination**,
 * never the row. Two `append` rows can share one `AGENTS.md`; a per-row snapshot recorded row 2's
 * pre-image as "original + row 1's block", so undo matched neither and restored nothing. Hashing the
 * destination also keeps a hostile destination name out of the artefact directory.
 */
export function preKeyFor(dest: string): string {
  return sha256Hex(dest).slice(0, 16);
}

/**
 * One line of `pre/index.jsonl`: what a destination looked like **before** this import touched it.
 * A destination that did not exist is recorded too, with `sha256: null` — the snapshot of an absence
 * is what tells a resumed run that the file on disk is its own earlier write, not the human's, and
 * tells undo to delete rather than restore (review defect 3).
 */
interface PreEntry {
  key: string;
  dest: string;
  sha256: string | null;
  mode: number | null;
  bytes: number;
}

/** Tolerant: a torn last line is simply not an entry, the same rule `apply.jsonl` follows (§4.7.6). */
function parsePreIndex(text: string): Map<string, PreEntry> {
  const out = new Map<string, PreEntry>();
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (typeof v !== 'object' || v === null) continue;
      const o = v as { key?: unknown; dest?: unknown; sha256?: unknown; mode?: unknown; bytes?: unknown };
      if (typeof o.key !== 'string' || typeof o.dest !== 'string') continue;
      out.set(o.key, {
        key: o.key,
        dest: o.dest,
        sha256: typeof o.sha256 === 'string' ? o.sha256 : null,
        mode: typeof o.mode === 'number' ? o.mode & 0o777 : null,
        bytes: typeof o.bytes === 'number' ? o.bytes : 0,
      });
    } catch {
      // a torn line is not an entry
    }
  }
  return out;
}

/**
 * A plan row's `dest` is repo- or `~`-relative (§4.6.1); this joins it onto its scope's absolute root.
 * A leading `~/` is stripped, and so are the leading segments the root already ends with, so both
 * `~/.config/jevcode/AGENTS.md` against `<home>/.config/jevcode` and `.jevcode/memory/x.md` against
 * `<repo>` land where the layout of §2.2 says they do. `..` is never collapsed away — it escapes, and
 * `confineDestination` refuses it.
 */
export function joinDestination(root: string, dest: string): string {
  const rel = dest.startsWith('~/') ? dest.slice(2) : dest;
  const relSegs = rel.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.');
  if (relSegs.length === 0) return resolve(root);
  const rootSegs = resolve(root).split(sep).filter((s) => s.length > 0);
  for (let k = Math.min(relSegs.length - 1, rootSegs.length); k > 0; k--) {
    if (rootSegs.slice(rootSegs.length - k).join('/') === relSegs.slice(0, k).join('/')) return resolve(root, ...relSegs.slice(k));
  }
  return resolve(root, ...relSegs);
}

// ---------------------------------------------------------------------------------------
// §4.7.1 [G1.4]: the lock
// ---------------------------------------------------------------------------------------

/** §4.7.1: what `~/.jevcode/imports/.lock` holds while a mutating operation runs. */
export interface LockInfo {
  pid: number;
  importId: string;
  op: 'apply' | 'resume' | 'undo';
  /** ISO-8601 */
  at: string;
}

function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists and belongs to somebody else — still alive
    return typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'EPERM';
  }
}

function parseLock(text: string): LockInfo | null {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null) return null;
    const o = v as { pid?: unknown; importId?: unknown; op?: unknown; at?: unknown };
    if (typeof o.pid !== 'number' || typeof o.importId !== 'string' || typeof o.at !== 'string') return null;
    if (o.op !== 'apply' && o.op !== 'resume' && o.op !== 'undo') return null;
    return { pid: o.pid, importId: o.importId, op: o.op, at: o.at };
  } catch {
    return null;
  }
}

/**
 * §4.7.1 [G1.4]: take `~/.jevcode/imports/.lock` for a mutating operation — `apply`, `resume` **or**
 * `undo`, because all three rewrite `apply.jsonl` and the manifest. `O_EXCL` create; a held lock is
 * stale when its pid is gone or the entry is older than `lockStaleMs`, and a stale lock is taken over
 * with `tookOver: true` so the caller can print the notice. An unparseable lock file is stale.
 */
export async function takeLock(
  fs: ImportWriteFs,
  clock: ImportClock,
  path: string,
  info: LockInfo,
  pidAlive: (pid: number) => boolean = defaultPidAlive,
): Promise<{ ok: true; tookOver: boolean } | { ok: false; held: LockInfo; ageMs: number }> {
  const payload = `${JSON.stringify(info)}\n`;
  if (await fs.createExclusive(path, payload, 0o600)) return { ok: true, tookOver: false };
  const raw = await fs.readFile(path).then((b) => b.toString('utf8')).catch(() => '');
  const held = parseLock(raw);
  const ageMs = held === null ? Number.POSITIVE_INFINITY : clock.now().getTime() - Date.parse(held.at);
  const stale = held === null || !Number.isFinite(ageMs) || Number.isNaN(ageMs) || ageMs > IMPORT_LIMITS.lockStaleMs || !pidAlive(held.pid);
  if (!stale && held !== null) return { ok: false, held, ageMs };
  await fs.rm(path).catch(() => undefined);
  if (await fs.createExclusive(path, payload, 0o600)) return { ok: true, tookOver: true };
  // somebody else won the takeover race between the rm and the create
  const after = parseLock(await fs.readFile(path).then((b) => b.toString('utf8')).catch(() => ''));
  return { ok: false, held: after ?? { pid: 0, importId: '', op: 'apply', at: new Date(0).toISOString() }, ageMs: Number.isFinite(ageMs) ? ageMs : 0 };
}

/** §4.7.1: release the lock. Never throws — a lock nobody holds is the state we want. */
export async function releaseLock(fs: ImportWriteFs, path: string): Promise<void> {
  await fs.rm(path).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------
// §4.7.6 [G1.4]: retention
// ---------------------------------------------------------------------------------------

/**
 * §4.7.6 [G1.4]: the import ids to GC at the **start** of the next import. The newest `importsKeep`
 * are kept, and an id a live manifest entry still references is **never** a victim, because its `pre/`
 * is the undo source. Ids sort by their `imp_<ISO compact>_<hex>` prefix, so lexical order is time order.
 */
export function retentionVictims(ids: readonly string[], manifest: ImportManifest | null, keep: number = IMPORT_LIMITS.importsKeep): readonly string[] {
  const live = new Set<string>();
  for (const entry of manifest?.user ?? []) live.add(entry.importId);
  for (const entries of Object.values(manifest?.workspaces ?? {})) for (const entry of entries) live.add(entry.importId);
  const newestFirst = [...new Set(ids)].sort().reverse();
  return newestFirst.slice(Math.max(0, keep)).filter((id) => !live.has(id));
}

// ---------------------------------------------------------------------------------------
// §4.7: apply
// ---------------------------------------------------------------------------------------

/** §4.7: everything phase 4 needs, with every root, clock and filesystem call arriving as an argument. */
export interface ApplyOptions {
  plan: ImportPlan;
  fs: ImportWriteFs;
  clock: ImportClock;
  /** absolute roots: the workspace destination tree and the user config destination tree */
  destRoots: { project: string; projectLocal: string; user: string };
  /** absolute `~/.jevcode/imports/<id>/` */
  artifactDir: string;
  /** absolute `~/.jevcode/imports/.lock` */
  lockPath: string;
  manifest: ImportManifest | null;
  /** §4.8.2: only the human's own terminal or their own `--yes`; an agent-, hook- or script-supplied approval is never authority */
  consent: 'tty' | 'flag';
  /** row ids the human approved; rows not listed are not applied */
  approved: readonly string[];
  /**
   * Renders one row's destination bytes from the re-read source; the engine never writes the source's
   * bytes unverified. For `create` the text is the whole file; for `append`/`merge` it is the marker
   * block's interior; for `update` it is the replacement interior; for an `mcp.json` `merge` it is a
   * rendered `McpFile` document, which this module merges into whatever is already on disk.
   *
   * `mode` is **advisory and ignored**: §2.2 fixes the destination mode at `0644`, or `0600` for
   * `memory-local/**` and everything under the config dir, and `modeFor` applies that policy. A
   * render seam that asked for `0o755` used to get it (review, "Lower").
   */
  render(row: PlanRow, sourceText: string): Promise<{ text: string; mode: number; warnings: readonly string[] }>;
  /** resolves a row's source display back to an absolute path, for the re-stat and re-hash of §4.7.2 */
  sourcePath(row: PlanRow): string;
  pid?: number;
  signal?: AbortSignal;
}

/** §4.7.4 step 7: one line of `apply.jsonl`. sha256 and byte counts, never a body and never a value (§4.8.1). */
export interface AppliedRow {
  row: string;
  /** the **absolute** destination, so `--undo` needs nothing but this log */
  dest: string | null;
  /**
   * The row's repo- or `~`-relative destination, **exactly** as the manifest entry records it. Undo
   * matches manifest entries against this key rather than against a path suffix of `dest`: in a
   * monorepo `AGENTS.md` is a suffix of `packages/app/AGENTS.md`, so the suffix rule dropped the root
   * entry whenever a package file was restored (review, "Lower": `entryMatches`).
   */
  destRel: string | null;
  sha256Before: string | null;
  sha256After: string | null;
  mode: number;
  bytes: number;
  at: string;
  ok: boolean;
  error?: string;
}

/** §4.7: what phase 4 returns. `exitCode` is 2 when any row failed or was demoted (§4.9). */
export interface ApplyResult {
  applied: readonly AppliedRow[];
  demoted: readonly { row: string; why: string }[];
  failed: readonly { row: string; error: string }[];
  manifest: ImportManifest;
  notices: readonly string[];
  exitCode: 0 | 2;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * §2.2: workspace files are `0644` — they are meant to be committed — except `memory-local/**`; the
 * config dir is `0600`. The mode is a **policy**, not the render seam's choice: honouring
 * `rendered.mode` let a hostile or buggy renderer ask for `0o755` and get it (review, "Lower":
 * `modeFor`). The two values here are the only two §2.2 allows, and neither is executable.
 */
function modeFor(row: PlanRow): 0o600 | 0o644 {
  if (row.scope !== 'project') return 0o600;
  if (row.dest !== null && /(^|[\\/])memory-local([\\/]|$)/.test(row.dest)) return 0o600;
  return 0o644;
}

function rootFor(row: PlanRow, roots: ApplyOptions['destRoots']): string {
  if (row.scope === 'user') return roots.user;
  if (row.scope === 'project-local') return roots.projectLocal;
  return roots.project;
}

/** §4.7.5 [G1.3]: the manifest is keyed by workspace; a user row lives in `user`, everything else under `workspaceKey`. */
function upsertEntry(manifest: ImportManifest, workspaceKey: string, entry: ImportManifestEntry): ImportManifest {
  const replace = (list: readonly ImportManifestEntry[]): readonly ImportManifestEntry[] => [...list.filter((e) => e.dest !== entry.dest), entry];
  if (entry.scope === 'user') return { ...manifest, user: replace(manifest.user) };
  return { ...manifest, workspaces: { ...manifest.workspaces, [workspaceKey]: replace(manifest.workspaces[workspaceKey] ?? []) } };
}

interface RowOutcome {
  applied?: AppliedRow;
  demoted?: { row: string; why: string };
  failed?: { row: string; error: string };
  entry?: ImportManifestEntry;
  notices: readonly string[];
}

/**
 * §4.7.2 [G1.1] + §4.7.3 [G1.2] + §4.7.4: one row, end to end. Never throws — a failure is an outcome.
 * `resumed` is true under `--resume`, where the row may already be on disk: a SIGKILL can land between
 * the write and the `apply.jsonl` append, so the row is re-evaluated against the **live** destination
 * instead of replaying `row.action` (review defect 3).
 */
async function applyRow(row: PlanRow, opts: ApplyOptions, appendLog: (line: AppliedRow) => Promise<void>, resumed: boolean): Promise<RowOutcome> {
  const notices: string[] = [];
  const at = opts.clock.now().toISOString();
  const fail = async (error: string): Promise<RowOutcome> => {
    const line: AppliedRow = { row: row.id, dest: null, destRel: row.dest, sha256Before: null, sha256After: null, mode: 0, bytes: 0, at, ok: false, error };
    await appendLog(line);
    return { failed: { row: row.id, error }, notices };
  };

  // §4.8.4 / §1 property 16: structurally unwritable classes never reach a seam call
  if (!WRITABLE_CLASSES.has(row.class) || !WRITABLE_ACTIONS.has(row.action) || row.dest === null) {
    return { demoted: { row: row.id, why: `${row.action} — report-only; nothing was written` }, notices };
  }

  // ----- §4.7.2 [G1.1] source re-verification -----
  const sourceAbs = opts.sourcePath(row);
  let sourceText: string;
  let sourceSha = row.source.sha256;
  try {
    const st = await opts.fs.stat(sourceAbs);
    // Both sides at whole-millisecond precision: `stat` returns a fractional `mtimeMs` (APFS and ext4
    // keep nanoseconds) while a `PlanRow` carries `Date.parse(ISO-8601)`, which cannot express one.
    // Comparing them raw made the pre-filter unfireable, so every row re-hashed (review, "Lower").
    const unchanged = Math.floor(st.mtimeMs) === Math.floor(row.source.mtimeMs) && st.size === row.source.bytes;
    const buf = await opts.fs.readFile(sourceAbs);
    sourceText = buf.toString('utf8');
    // `mtimeMs` is carried purely as a cheap pre-filter: unchanged mtime AND unchanged size skips the
    // re-hash; anything else re-hashes (§4.7.2).
    if (!unchanged) {
      sourceSha = sha256Hex(buf);
      if (sourceSha !== row.source.sha256) {
        return {
          demoted: { row: row.id, why: `review — source changed since the plan (${row.source.sha256.slice(0, 8)} → ${sourceSha.slice(0, 8)}); nothing was written` },
          notices,
        };
      }
    }
  } catch (e) {
    return await fail(`could not re-read the source: ${errorText(e)}`);
  }

  // ----- §4.7.3 [G1.2] destination confinement -----
  const root = rootFor(row, opts.destRoots);
  const confined = await confineDestination(opts.fs, joinDestination(root, row.dest), root);
  if (!confined.ok) return { demoted: { row: row.id, why: `review — ${confined.why}; nothing was written` }, notices };
  const dest = confined.path;

  // ----- render (never the source's bytes unverified) -----
  let rendered: { text: string; mode: number; warnings: readonly string[] };
  try {
    rendered = await opts.render(row, sourceText);
  } catch (e) {
    return await fail(`could not render: ${errorText(e)}`);
  }
  notices.push(...rendered.warnings.map((w) => `${row.dest}: ${w}`));

  const existingBuf = await opts.fs.readFile(dest).catch(() => null);
  // Review defect 7: a destination that is not valid UTF-8 is refused, never corrected. Rendering it
  // through `toString('utf8')` would replace the human's bytes with U+FFFD — a corruption undo could
  // not reverse, because the snapshot would carry the same replacement characters.
  if (existingBuf !== null && !isValidUtf8(existingBuf)) {
    return { demoted: { row: row.id, why: `review — ${row.dest} is not valid UTF-8; nothing was written` }, notices };
  }
  const existing = existingBuf === null ? null : existingBuf.toString('utf8');
  const sha256Before = existingBuf === null ? null : sha256Hex(existingBuf);
  const header = markerOpen(opts.plan.importId, row.source.tools[0] ?? 'pasted', row.source.display, sourceSha);

  let text: string;
  if (basename(dest) === 'mcp.json') {
    // §4.7.4 step 5: `mcp.json` is never markered — it is a document merge, whatever the action says
    const merged = mergedMcp(existing, rendered.text, row.dest);
    if (!merged.ok) return { demoted: { row: row.id, why: `review — ${merged.why}; nothing was written` }, notices };
    text = merged.text;
  } else if (row.action === 'create' || existing === null) {
    text = rendered.text;
  } else if (row.action === 'update') {
    const replaced = replaceMarkerInterior(existing, opts.plan.importId, rendered.text, header);
    if (replaced === null) return { demoted: { row: row.id, why: 'review — the block was edited or removed; nothing was written' }, notices };
    text = replaced;
  } else {
    // append / merge: a marker block below whatever is already there (a second block for `merge`)
    text = appendBlock(existing, header, rendered.text, opts.plan.importId);
  }

  // §4.7.6 / review defect 3: under `--resume` the destination may already hold this row's write — a
  // SIGKILL between the write and the `apply.jsonl` append leaves exactly that state. Re-evaluated
  // against the live destination: the row's own marker header is already there (an `append`/`merge`
  // would add a second identical block), or the bytes it would write are already the bytes on disk.
  const alreadyApplied = resumed && existing !== null && (existing === text || existing.includes(header));
  const finalText = alreadyApplied && existing !== null ? existing : text;
  const mode = modeFor(row);
  try {
    if (!alreadyApplied) await opts.fs.writeFile(dest, finalText, { mode, mkdir: true });
    await opts.fs.chmod(dest, mode);
  } catch (e) {
    return await fail(`could not write ${row.dest}: ${errorText(e)}`);
  }
  if (alreadyApplied) notices.push(`${row.dest}: already written before the interruption; not applied twice`);
  const bytes = Buffer.byteLength(finalText, 'utf8');
  const sha256After = sha256Hex(finalText);
  const line: AppliedRow = { row: row.id, dest, destRel: row.dest, sha256Before, sha256After, mode, bytes, at, ok: true };
  await appendLog(line);
  return {
    applied: line,
    entry: { importId: opts.plan.importId, dest: row.dest, sourceSha256: sourceSha, destSha256: sha256After, scope: row.scope, at, by: opts.consent },
    notices,
  };
}

/**
 * §4.7.4 step 5: existing servers untouched, new ones added `enabled: false`, name collision →
 * `<name>-<tool>`. **An existing file that does not parse is never merged** (review defect 10):
 * `parseMcpFile` returns `null` for anything that is not a `v: 1` document — a hand-written
 * `{"mcpServers": …}`, a newer version, a file with a typo — and merging into `null` silently dropped
 * every server the human had. The row is demoted to `review` instead; a human's MCP configuration is
 * not ours to discard.
 */
function mergedMcp(existing: string | null, incoming: string, label: string): { ok: true; text: string } | { ok: false; why: string } {
  const incomingFile = parseMcpFile(incoming);
  if (existing === null) {
    if (incomingFile === null) return { ok: true, text: incoming };
    return { ok: true, text: renderMcpFile(mergeMcpFile(null, incomingFile.servers).file) };
  }
  const existingFile = parseMcpFile(existing);
  if (existingFile === null) return { ok: false, why: `${label} exists but could not be parsed, and its servers are not ours to drop` };
  if (incomingFile === null) return { ok: false, why: `${label} could not be rendered as an mcp.json` };
  return { ok: true, text: renderMcpFile(mergeMcpFile(existingFile, incomingFile.servers).file) };
}

/** The shared core of `applyPlan` and `resumeImport`; `skip` holds the row ids `apply.jsonl` already records as `ok`. */
async function runApply(opts: ApplyOptions, skip: ReadonlySet<string>, op: 'apply' | 'resume', carried: readonly AppliedRow[]): Promise<ApplyResult> {
  const notices: string[] = [];
  const lock = await takeLock(opts.fs, opts.clock, opts.lockPath, {
    pid: opts.pid ?? process.pid,
    importId: opts.plan.importId,
    op,
    at: opts.clock.now().toISOString(),
  });
  if (!lock.ok) {
    return {
      applied: [],
      demoted: [],
      failed: [],
      manifest: opts.manifest ?? { v: 1, user: [], workspaces: {} },
      notices: [`an import is applying (pid ${lock.held.pid}, ${Math.round(lock.ageMs / 1000)} s ago) — try again when it finishes`],
      exitCode: 2,
    };
  }
  if (lock.tookOver) notices.push('replaced a stale import lock');

  const applyLogPath = `${opts.artifactDir}${opts.artifactDir.endsWith(sep) ? '' : sep}apply.jsonl`;
  const preDir = `${opts.artifactDir}${opts.artifactDir.endsWith(sep) ? '' : sep}pre`;
  // §4.7.6 / §6 row 73: a SIGKILL can leave the last line torn and unterminated. Close it before the
  // first append, so a resumed run's records are whole lines a tolerant reader can still recover.
  const tail = await opts.fs.readFile(applyLogPath).catch(() => null);
  if (tail !== null && tail.byteLength > 0 && tail[tail.byteLength - 1] !== 0x0a) {
    await opts.fs.appendFile(applyLogPath, '\n', { mode: 0o600, mkdir: true });
  }
  const appendLog = async (line: AppliedRow): Promise<void> => {
    await opts.fs.appendFile(applyLogPath, `${JSON.stringify(line)}\n`, { mode: 0o600, mkdir: true });
  };

  const applied: AppliedRow[] = [...carried];
  const demoted: { row: string; why: string }[] = [];
  const failed: { row: string; error: string }[] = [];
  let manifest: ImportManifest = opts.manifest ?? { v: 1, user: [], workspaces: {} };

  try {
    const approved = new Set(opts.approved);
    const rows = opts.plan.rows.filter((r) => approved.has(r.id) && !skip.has(r.id));
    const ordered = ROW_STEPS.flatMap((step) => rows.filter((r) => stepOf(r) === step));

    // ----- step 1: `pre/` snapshots, one per DESTINATION, byte for byte, with modes -----
    // Keyed by destination rather than by row (review defect 2): two `append` rows can share one
    // `AGENTS.md`, and a per-row snapshot recorded row 2's pre-image as "original + row 1's block".
    // An existing `pre/<key>` is **never** overwritten (review defect 3): after a SIGKILL the
    // destination on disk is this import's own write, so re-snapshotting it would replace the human's
    // bytes with ours and make undo a no-op. Every snapshot happens before any row is written, so
    // "the index already knows this destination" is exactly "we already know its true pre-state".
    const preIndexPath = `${preDir}${sep}index.jsonl`;
    const preIndex = parsePreIndex(await opts.fs.readFile(preIndexPath).then((b) => b.toString('utf8')).catch(() => ''));
    for (const row of ordered) {
      if (row.dest === null) continue;
      const root = rootFor(row, opts.destRoots);
      // confined first: a snapshot is a copy, and a hostile destination must not copy a file from
      // outside the tree into `~/.jevcode/imports/<id>/pre/` (§4.7.3 [G1.2], Appendix A.3)
      const confined = await confineDestination(opts.fs, joinDestination(root, row.dest), root);
      if (!confined.ok) continue;
      const dest = confined.path;
      const key = preKeyFor(dest);
      if (preIndex.has(key)) continue;
      const buf = await opts.fs.readFile(dest).catch(() => null);
      const st = buf === null ? null : await opts.fs.stat(dest).catch(() => null);
      // an absent destination is recorded too: undo deletes what the import created, and a resumed
      // run must not mistake its own earlier write for a file the human had
      const entry: PreEntry =
        buf === null
          ? { key, dest, sha256: null, mode: null, bytes: 0 }
          : { key, dest, sha256: sha256Hex(buf), mode: st === null ? 0o644 : st.mode & 0o777, bytes: buf.byteLength };
      if (buf !== null) await opts.fs.writeFile(`${preDir}${sep}${key}`, buf, { mode: 0o600, mkdir: true });
      await opts.fs.appendFile(preIndexPath, `${JSON.stringify(entry)}\n`, { mode: 0o600, mkdir: true });
      preIndex.set(key, entry);
    }

    // ----- steps 2–6, in order, with step 7 (`apply.jsonl`) appended after each write -----
    for (const row of ordered) {
      if (opts.signal?.aborted === true) {
        notices.push(`applied ${applied.length} of ${ordered.length} — jevcode import --resume ${opts.plan.importId}`);
        break;
      }
      const outcome = await applyRow(row, opts, appendLog, op === 'resume');
      notices.push(...outcome.notices);
      if (outcome.applied !== undefined) applied.push(outcome.applied);
      if (outcome.demoted !== undefined) demoted.push(outcome.demoted);
      if (outcome.failed !== undefined) failed.push(outcome.failed);
      // ----- step 8: manifest merge -----
      if (outcome.entry !== undefined) manifest = upsertEntry(manifest, opts.plan.workspaceKey, outcome.entry);
    }
    manifest = { ...manifest, lastRun: opts.clock.now().toISOString() };
  } finally {
    await releaseLock(opts.fs, opts.lockPath);
  }

  // ----- step 9 (trust re-pin) is the caller's: only it knows the stored decision (§4.7.5 [G1.5]) -----
  return { applied, demoted, failed, manifest, notices, exitCode: failed.length > 0 || demoted.length > 0 ? 2 : 0 };
}

/**
 * §4.7: apply exactly the rows the human approved, in the order of §4.7.4. A failure on one row is
 * recorded and the loop continues; the command exits 2 if any row failed or was demoted, 0 otherwise.
 */
export async function applyPlan(opts: ApplyOptions): Promise<ApplyResult> {
  return await runApply(opts, new Set<string>(), 'apply', []);
}

/**
 * §4.7.6: re-reads `plan.json` (the caller hands it back as `opts.plan`), skips every row already
 * `ok: true` in `apply.jsonl`, re-verifies each remaining source (§4.7.2) and continues. Takes the
 * lock [G1.4]. `applied` carries the whole import, prior rows included, each row exactly once.
 */
export async function resumeImport(opts: ApplyOptions & { applyLog: readonly AppliedRow[] }): Promise<ApplyResult> {
  const done = new Map<string, AppliedRow>();
  for (const line of opts.applyLog) if (line.ok) done.set(line.row, line);
  const result = await runApply(opts, new Set(done.keys()), 'resume', [...done.values()]);
  return done.size === 0 ? result : { ...result, notices: [`resumed ${opts.plan.importId}: ${done.size} rows were already applied`, ...result.notices] };
}

// ---------------------------------------------------------------------------------------
// §4.7.6: undo
// ---------------------------------------------------------------------------------------

/** §4.7.6: `--undo <id>`. Everything it needs is in `apply.jsonl` and `pre/` — no plan, no destination roots. */
export interface UndoOptions {
  fs: ImportWriteFs;
  clock: ImportClock;
  artifactDir: string;
  lockPath: string;
  importId: string;
  applyLog: readonly AppliedRow[];
  manifest: ImportManifest | null;
  /** [G1.3] `realpath(gitRoot ?? workspace)`, so the right workspace's entries are removed */
  workspaceKey: string;
  pid?: number;
}

/** §4.7.6: what undo restored, and every destination it deliberately left alone with the reason. */
export interface UndoResult {
  restored: readonly string[];
  left: readonly { dest: string; why: string }[];
  manifest: ImportManifest;
  exitCode: 0 | 2;
}

/**
 * §4.7.6: restore every DESTINATION whose current sha256 still equals the `sha256After` of the last
 * write this import made to it, from `pre/` (or by deleting it, when the import created it), mode
 * included. Anything else is `review — modified since the import; left alone`. **A missing pre-image
 * is a ROW OUTCOME, not an exception** [G1.4]. A credential is never touched — `jevcode logout`
 * already removes keys, and undoing a key the human then started using would break the next run.
 * Takes the lock [G1.4]. Manifest entries are removed only for destinations actually restored.
 *
 * Per destination, not per row (review defect 2): two `append` rows can share one `AGENTS.md`, and
 * unwinding them one row at a time compared row 2's log line against a pre-image that never existed.
 * The destination has exactly one pre-image, so it has exactly one unwind.
 */
export async function undoImport(opts: UndoOptions): Promise<UndoResult> {
  const lock = await takeLock(opts.fs, opts.clock, opts.lockPath, {
    pid: opts.pid ?? process.pid,
    importId: opts.importId,
    op: 'undo',
    at: opts.clock.now().toISOString(),
  });
  let manifest: ImportManifest = opts.manifest ?? { v: 1, user: [], workspaces: {} };
  if (!lock.ok) {
    return { restored: [], left: [{ dest: '', why: `an import is applying (pid ${lock.held.pid}, ${Math.round(lock.ageMs / 1000)} s ago) — try again when it finishes` }], manifest, exitCode: 2 };
  }
  const preDir = `${opts.artifactDir}${opts.artifactDir.endsWith(sep) ? '' : sep}pre`;
  // §4.7.6 "restoring the mode" means the **pre-image's** mode, which is not always the one apply
  // wrote: a `0640` file that apply rewrote `0644` must come back `0640`. `pre/index.jsonl` records
  // it, along with the sha256 the snapshot must still hash to and whether the destination existed at
  // all — the three facts undo needs and the apply log cannot carry once two rows share a file.
  const preIndex = parsePreIndex(await opts.fs.readFile(`${preDir}${sep}index.jsonl`).then((b) => b.toString('utf8')).catch(() => ''));

  // one group per destination, in log order; the groups themselves unwind in reverse order of their
  // last write, so `AGENTS.md` (appended last, §4.7.4 step 6) is undone first
  const groups = new Map<string, AppliedRow[]>();
  for (const line of opts.applyLog) {
    if (!line.ok || line.dest === null) continue;
    const group = groups.get(line.dest);
    if (group === undefined) groups.set(line.dest, [line]);
    else group.push(line);
  }

  const restored: string[] = [];
  /** the relative destinations of every row whose destination really was restored (manifest keys) */
  const restoredKeys = new Set<string>();
  const left: { dest: string; why: string }[] = [];
  try {
    for (const [dest, lines] of [...groups.entries()].reverse()) {
      const first = lines[0]!;
      const last = lines[lines.length - 1]!;
      const pre = preIndex.get(preKeyFor(dest));
      // the snapshot is the authority on what was there before; the log line is the fallback for a
      // `pre/index.jsonl` that is gone or was never written
      const existedBefore = pre === undefined ? first.sha256Before !== null : pre.sha256 !== null;
      const done = (): void => {
        restored.push(dest);
        for (const line of lines) if (typeof line.destRel === 'string') restoredKeys.add(line.destRel);
      };
      const current = await opts.fs.readFile(dest).catch(() => null);
      if (current === null) {
        // §4.7.6: a destination the human deleted is **left alone** — undo never re-creates one. When
        // the import created it, its absence is already the state undo wants.
        if (!existedBefore) {
          done();
          continue;
        }
        left.push({ dest, why: 'review — the destination was deleted since the import; left alone' });
        continue;
      }
      if (sha256Hex(current) !== last.sha256After) {
        left.push({ dest, why: 'review — modified since the import; left alone' });
        continue;
      }
      if (!existedBefore) {
        try {
          await opts.fs.rm(dest);
          done();
        } catch (e) {
          left.push({ dest, why: `could not remove: ${errorText(e)}` });
        }
        continue;
      }
      const image = pre === undefined ? null : await opts.fs.readFile(`${preDir}${sep}${pre.key}`).catch(() => null);
      if (pre === undefined || image === null) {
        left.push({ dest, why: `review — pre-image unavailable (${preDir} removed); left alone` });
        continue;
      }
      if (sha256Hex(image) !== pre.sha256) {
        left.push({ dest, why: 'review — the pre-image does not match what was recorded; left alone' });
        continue;
      }
      const mode = pre.mode ?? last.mode;
      try {
        // the raw Buffer: a destination that is not valid UTF-8 never reaches a write at all, and the
        // one that is must come back byte for byte, not through a lossy round trip (review defect 7)
        await opts.fs.writeFile(dest, image, { mode, mkdir: true });
        await opts.fs.chmod(dest, mode);
        done();
      } catch (e) {
        left.push({ dest, why: `could not restore: ${errorText(e)}` });
      }
    }
  } finally {
    await releaseLock(opts.fs, opts.lockPath);
  }

  // exact key, never a path suffix: `AGENTS.md` is a suffix of `packages/app/AGENTS.md`, so the old
  // suffix rule dropped a root entry whenever a package file was restored (review, "Lower")
  const keep = (entry: ImportManifestEntry): boolean => entry.importId !== opts.importId || !restoredKeys.has(entry.dest);
  const workspaces: Record<string, readonly ImportManifestEntry[]> = {};
  for (const [key, entries] of Object.entries(manifest.workspaces)) workspaces[key] = entries.filter(keep);
  manifest = { ...manifest, user: manifest.user.filter(keep), workspaces };
  return { restored, left, manifest, exitCode: left.length > 0 ? 2 : 0 };
}
