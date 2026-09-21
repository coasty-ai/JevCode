/**
 * Pre/post images for `/undo`, `/rewind` and `/diff <step>` (TUI-DESIGN §12.3, D8).
 *
 * Layout under `<runDir>`:
 *
 *   pre/<step>/<sha256(relpath)>   bytes before the step (edit|write|patch targets; the dirty set before `run`);
 *                                  files > 1 MiB are skipped and recorded, never copied
 *   pre/<step>/dirs.json           ["src/new/"] directories the step will create (for unlink of created files)
 *   pre/<step>/index.json          per-target facts (existed, bytes, mode, skip reason) so the post image can tell
 *                                  `created` from `preImage: false` without a second stat
 *   post/<step>.json               { v, step, at, headOid, files: { <rel>: { sha256, bytes, mode, source, preImage,
 *                                  cleanAtStart | created | deleted } }, skipped, hashSkipped }
 *   post/<step>.undone.json        the same file, renamed by /undo (§12.4)
 *
 * Every write goes through core/atomic.ts (temp + rename). Post-image hashing streams each file in 4 MiB chunks
 * with a `setImmediate` yield between chunks and stops at a 16 MiB per-step budget (the first file that does not
 * fit and every file after it is recorded with `sha256: null`), so the event loop never blocks for more than one
 * chunk while the composer is live (§18). Time spent here is returned as `ms` for
 * `StepTiming.imagesMs`; the clock is injected so tests are deterministic.
 */
import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { writeFileAtomic } from '../core/atomic.js';
import { sha256Hex } from '../core/hash.js';
import { isJsonArray, isJsonObject, parseJson } from '../core/json.js';
import type { Json, UndoSkipReason } from '../core/types.js';
import { CheckpointError } from '../errors.js';
import { CHECKPOINT_FILES } from './store.js';

// ---------------------------------------------------------------------------------------
// Constants (TUI-DESIGN §12.3, D8)
// ---------------------------------------------------------------------------------------

/** A pre-image is never taken of a file larger than this; the file is recorded as skipped `size`. */
export const PRE_IMAGE_MAX_FILE_BYTES = 1024 * 1024;
/** Dirty-set copy cap before a `run` (TUI-DESIGN §12.3): at most this many files are copied; edit|write|patch targets are uncapped by default. */
export const PRE_IMAGE_MAX_FILES = 200;
/** Dirty-set copy cap before a `run` (TUI-DESIGN §12.3): at most this many bytes are copied in one step; edit|write|patch targets are uncapped by default. */
export const PRE_IMAGE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** Per-step streamed hashing budget for post images; files past it get `sha256: null`. */
export const POST_IMAGE_HASH_CAP_BYTES = 16 * 1024 * 1024;
/** Read-stream chunk size: ≈ 2.4 ms of sha256 per chunk on the main thread (A143). */
export const POST_IMAGE_CHUNK_BYTES = 4 * 1024 * 1024;
export const POST_IMAGE_VERSION = 1 as const;
export const PRE_INDEX_FILE = 'index.json';
export const PRE_DIRS_FILE = 'dirs.json';

/** Which stage produced the change; `run` files have no pre-image unless they were dirty before the command. */
export type ImageSource = 'edit' | 'write' | 'patch' | 'run';

export interface ImageSkip {
  path: string;
  reason: UndoSkipReason;
  bytes?: number;
}

export interface PreImageEntry {
  path: string;
  /** the file existed (as anything) before the step */
  existed: boolean;
  /** size before the step; null when it did not exist or could not be stat'ed */
  bytes: number | null;
  /** st_mode & 0o7777 before the step; null when unknown */
  mode: number | null;
  /** bytes were copied to pre/<step>/<sha256(path)> */
  copied: boolean;
  /** why the copy was not taken (size / cap / link / escape / not-recoverable for an unreadable file) */
  skipped: UndoSkipReason | null;
}

export interface PreImageIndex {
  v: 1;
  step: number;
  source: ImageSource;
  entries: PreImageEntry[];
}

export interface PreImageResult {
  step: number;
  entries: PreImageEntry[];
  /** directories the step will create, deepest first, with a trailing slash (`dirs.json`) */
  dirs: string[];
  skipped: ImageSkip[];
  /** bytes copied */
  copiedBytes: number;
  /** wall time of this call (part of StepTiming.imagesMs) */
  ms: number;
}

export interface PostImageFile {
  /** null = hashing budget exhausted (`hashSkipped`); /undo treats it as the "ask" row (§12.4) */
  sha256?: string | null;
  bytes?: number;
  mode?: number;
  source: ImageSource;
  /** a pre-image copy exists under pre/<step>/ */
  preImage?: boolean;
  /** tracked and unmodified at run start (recoverable from HEAD while HEAD is unchanged) */
  cleanAtStart?: boolean;
  /** the file did not exist before the step */
  created?: boolean;
  /** the file existed before the step and is gone after it */
  deleted?: boolean;
}

export interface PostImage {
  v: 1;
  step: number;
  /** ISO timestamp */
  at: string;
  /** HEAD oid when the step ran (null: unborn or no repository); the /undo HEAD-moved rule compares against it */
  headOid: string | null;
  files: Record<string, PostImageFile>;
  skipped: ImageSkip[];
  hashSkipped: boolean;
}

export interface PreImageOptions {
  /** realpath of the workspace root; every target is relative to it */
  root: string;
  source: ImageSource;
  maxFileBytes?: number;
  /** copy cap (files); default 200 for `run` (the dirty set, §12.3), unbounded for edit|write|patch targets */
  maxFiles?: number;
  /** copy cap (bytes); default 16 MiB for `run`, unbounded for edit|write|patch targets */
  maxTotalBytes?: number;
  /** monotonic clock for `ms` (default performance.now) */
  now?: () => number;
}

export interface PostImageOptions {
  root: string;
  source: ImageSource;
  headOid: string | null;
  /** tracked and unmodified at run start */
  cleanAtStart: (relPath: string) => boolean;
  /** the result of writePreImages for the same step; read back from pre/<step>/index.json when absent */
  pre?: PreImageResult | PreImageIndex | null;
  hashCapBytes?: number;
  chunkBytes?: number;
  /** ISO timestamp for `at` (default: now) */
  at?: string;
  now?: () => number;
  /** called between chunks (default: setImmediate); injectable so tests can count yields */
  yieldBetweenChunks?: () => Promise<void>;
}

export interface PostImageResult {
  image: PostImage;
  ms: number;
}

export type PostImageRead = { ok: true; image: PostImage; undone: boolean } | { ok: false; reason: 'missing' | 'corrupt'; detail: string };

// ---------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------

function assertStep(step: number): void {
  if (!Number.isInteger(step) || step < 1) throw new RangeError(`image step must be a positive integer, got ${String(step)}`);
}

/** `pre/<step>/` (TUI-DESIGN §12.3). */
export function preImageDir(runDir: string, step: number): string {
  assertStep(step);
  return join(runDir, CHECKPOINT_FILES.pre, String(step));
}

/** `pre/<step>/<sha256(relpath)>`: the hash keeps the copy name flat and traversal-free (TUI-DESIGN §12.3). */
export function preImagePath(runDir: string, step: number, relPath: string): string {
  return join(preImageDir(runDir, step), sha256Hex(relPath));
}

/** `post/<step>.json` or `post/<step>.undone.json` (TUI-DESIGN §12.3, §12.4). */
export function postImagePath(runDir: string, step: number, undone = false): string {
  assertStep(step);
  return join(runDir, CHECKPOINT_FILES.post, `${step}${undone ? '.undone' : ''}.json`);
}

/** Backslash is a path separator on Windows only; on POSIX it is an ordinary file-name character. */
const SEPARATOR_RE = sep === '\\' ? /[\\/]+/ : /\/+/;

/**
 * Normalise a workspace-relative path: `./` prefix and `.` segments dropped, posix separators (`\\` counts as one
 * on Windows only); null when the path is empty, absolute, contains `..`, a NUL, or enters `.git` (TUI-DESIGN
 * §12.4 `escape`).
 */
export function normaliseRelPath(rel: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) return null;
  if (isAbsolute(rel) || rel.startsWith('/') || (sep === '\\' && rel.startsWith('\\'))) return null;
  const parts = rel.split(SEPARATOR_RE).filter((p) => p.length > 0 && p !== '.');
  if (parts.length === 0) return null;
  for (const p of parts) if (p === '..' || p === '.git') return null;
  return parts.join('/');
}

function insideRoot(root: string, abs: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep;
  return abs === root || abs.startsWith(r);
}

function errnoCode(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fail(runDir: string, message: string, cause?: unknown): CheckpointError {
  return new CheckpointError(`${message} (${runDir})`, runDir, cause === undefined ? {} : { cause });
}

const defaultNow = (): number => performance.now();

/** The workspace root as a realpath (macOS `/var` → `/private/var`); the escape checks compare realpaths against it. */
async function realRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return resolve(root);
  }
}

/** Unique, normalised targets in first-seen order; escapes are reported through `skipped`. */
function normaliseTargets(targets: readonly string[], skipped: ImageSkip[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of targets) {
    const rel = normaliseRelPath(t);
    if (rel === null) {
      if (!seen.has(`\0${t}`)) {
        seen.add(`\0${t}`);
        skipped.push({ path: t, reason: 'escape' });
      }
      continue;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/**
 * The parent's realpath must stay inside the root: a symlinked directory would otherwise read (and later
 * restore) a file outside the workspace (TUI-DESIGN §12.4 `escape`). ENOENT parents are fine: they are the
 * directories the step is about to create.
 */
async function parentEscapes(root: string, abs: string): Promise<boolean> {
  let dir = dirname(abs);
  for (let i = 0; i < 64; i++) {
    try {
      const real = await realpath(dir);
      return !insideRoot(root, real);
    } catch (e) {
      if (errnoCode(e) !== 'ENOENT' && errnoCode(e) !== 'ENOTDIR') return true;
      if (!insideRoot(root, dir) || dir === root) return false;
      dir = dirname(dir);
    }
  }
  return true;
}

/** Directories under `root` that do not exist yet on the way to `rel`, deepest first, with a trailing slash. */
async function missingDirs(root: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  let dir = posix.dirname(rel);
  while (dir !== '.' && dir !== '') {
    try {
      await lstat(join(root, dir));
      break;
    } catch (e) {
      if (errnoCode(e) !== 'ENOENT' && errnoCode(e) !== 'ENOTDIR') break;
      out.push(`${dir}/`);
      dir = posix.dirname(dir);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// writePreImages
// ---------------------------------------------------------------------------------------

/**
 * TUI-DESIGN §12.3: copy the bytes of every target that exists before the step to `pre/<step>/<sha256(relpath)>`
 * (≤ 1 MiB each; the `run` dirty set capped at 200 files / 16 MiB, overflow `cap`), record the directories the
 * step will create in `dirs.json`, and write `index.json`. Symlinks, hard links, non-regular files and paths that
 * escape the root are recorded as skipped and never copied. A re-run of the same step (DESIGN §9.1 rule 1)
 * replaces the previous attempt's directory, so no stale copy survives. Throws CheckpointError when the run
 * directory cannot be written.
 */
export async function writePreImages(runDir: string, step: number, targets: readonly string[], opts: PreImageOptions): Promise<PreImageResult> {
  assertStep(step);
  const now = opts.now ?? defaultNow;
  const t0 = now();
  const maxFileBytes = opts.maxFileBytes ?? PRE_IMAGE_MAX_FILE_BYTES;
  const capped = opts.source === 'run';
  const maxFiles = opts.maxFiles ?? (capped ? PRE_IMAGE_MAX_FILES : Number.POSITIVE_INFINITY);
  const maxTotalBytes = opts.maxTotalBytes ?? (capped ? PRE_IMAGE_MAX_TOTAL_BYTES : Number.POSITIVE_INFINITY);
  const skipped: ImageSkip[] = [];
  const rels = normaliseTargets(targets, skipped);
  const root = await realRoot(opts.root);
  const dir = preImageDir(runDir, step);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (e) {
    throw fail(runDir, `cannot clear the previous pre-images of step ${step}: ${describe(e)}`, e);
  }
  const entries: PreImageEntry[] = [];
  const dirs: string[] = [];
  const dirSeen = new Set<string>();
  let copied = 0;
  let copiedBytes = 0;

  for (const rel of rels) {
    const abs = resolve(root, rel);
    if (!insideRoot(root, abs) || (await parentEscapes(root, abs))) {
      entries.push({ path: rel, existed: false, bytes: null, mode: null, copied: false, skipped: 'escape' });
      skipped.push({ path: rel, reason: 'escape' });
      continue;
    }
    let st: Stats;
    try {
      st = await lstat(abs);
    } catch (e) {
      if (errnoCode(e) === 'ENOENT' || errnoCode(e) === 'ENOTDIR') {
        entries.push({ path: rel, existed: false, bytes: null, mode: null, copied: false, skipped: null });
        for (const d of await missingDirs(root, rel)) {
          if (!dirSeen.has(d)) {
            dirSeen.add(d);
            dirs.push(d);
          }
        }
        continue;
      }
      entries.push({ path: rel, existed: true, bytes: null, mode: null, copied: false, skipped: 'not-recoverable' });
      skipped.push({ path: rel, reason: 'not-recoverable' });
      continue;
    }
    const mode = st.mode & 0o7777;
    if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) {
      entries.push({ path: rel, existed: true, bytes: st.size, mode, copied: false, skipped: 'link' });
      skipped.push({ path: rel, reason: 'link' });
      continue;
    }
    if (st.size > maxFileBytes) {
      entries.push({ path: rel, existed: true, bytes: st.size, mode, copied: false, skipped: 'size' });
      skipped.push({ path: rel, reason: 'size', bytes: st.size });
      continue;
    }
    if (copied >= maxFiles || copiedBytes + st.size > maxTotalBytes) {
      entries.push({ path: rel, existed: true, bytes: st.size, mode, copied: false, skipped: 'cap' });
      skipped.push({ path: rel, reason: 'cap', bytes: st.size });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
    } catch (e) {
      entries.push({ path: rel, existed: true, bytes: st.size, mode, copied: false, skipped: 'not-recoverable' });
      skipped.push({ path: rel, reason: 'not-recoverable' });
      continue;
    }
    try {
      await writeFileAtomic(preImagePath(runDir, step, rel), bytes, { mkdir: true });
    } catch (e) {
      throw fail(runDir, `cannot write pre-image for ${rel}: ${describe(e)}`, e);
    }
    copied += 1;
    copiedBytes += bytes.length;
    entries.push({ path: rel, existed: true, bytes: bytes.length, mode, copied: true, skipped: null });
  }

  const index: PreImageIndex = { v: 1, step, source: opts.source, entries };
  try {
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, PRE_DIRS_FILE), `${JSON.stringify(dirs)}\n`);
    await writeFileAtomic(join(dir, PRE_INDEX_FILE), `${JSON.stringify(index)}\n`);
  } catch (e) {
    throw fail(runDir, `cannot write pre-image index for step ${step}: ${describe(e)}`, e);
  }
  return { step, entries, dirs, skipped, copiedBytes, ms: Math.max(0, now() - t0) };
}

// ---------------------------------------------------------------------------------------
// Streaming hash
// ---------------------------------------------------------------------------------------

/**
 * TUI-DESIGN §12.3: sha256 of a file streamed in `chunkBytes` chunks with a yield between chunks, so one call
 * never holds the event loop longer than one chunk's hashing.
 */
export async function hashFileStreaming(abs: string, chunkBytes = POST_IMAGE_CHUNK_BYTES, yieldBetweenChunks: () => Promise<void> = () => yieldToLoop()): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(abs, { highWaterMark: Math.max(1, Math.floor(chunkBytes)) });
  let first = true;
  for await (const chunk of stream) {
    if (!first) await yieldBetweenChunks();
    first = false;
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------
// writePostImages
// ---------------------------------------------------------------------------------------

function preEntries(pre: PreImageResult | PreImageIndex | null | undefined): Map<string, PreImageEntry> {
  const m = new Map<string, PreImageEntry>();
  if (pre) for (const e of pre.entries) m.set(e.path, e);
  return m;
}

/**
 * TUI-DESIGN §12.3: after execute, record every changed file's sha256 (streamed; once a file would exceed the
 * 16 MiB per-step budget, `hashSkipped: true` and it and every remaining file carry `sha256: null`), bytes, mode,
 * `source`, `preImage`, `cleanAtStart` / `created` / `deleted`, the step's `headOid` and the pre-image skips,
 * atomically as `post/<step>.json`.
 */
export async function writePostImages(runDir: string, step: number, changedFiles: readonly string[], opts: PostImageOptions): Promise<PostImageResult> {
  assertStep(step);
  const now = opts.now ?? defaultNow;
  const t0 = now();
  const hashCap = opts.hashCapBytes ?? POST_IMAGE_HASH_CAP_BYTES;
  const chunkBytes = opts.chunkBytes ?? POST_IMAGE_CHUNK_BYTES;
  const yieldFn = opts.yieldBetweenChunks ?? (() => yieldToLoop());
  const pre = opts.pre === undefined ? await readPreIndex(runDir, step) : opts.pre;
  const preByPath = preEntries(pre);
  const skipped: ImageSkip[] = [];
  const rels = normaliseTargets(changedFiles, skipped);
  const root = await realRoot(opts.root);
  const files: Record<string, PostImageFile> = {};
  let remaining = hashCap;
  let hashSkipped = false;

  for (const rel of rels) {
    const before = preByPath.get(rel);
    const preImage = before?.copied === true;
    const abs = resolve(root, rel);
    if (!insideRoot(root, abs) || (await parentEscapes(root, abs))) {
      skipped.push({ path: rel, reason: 'escape' });
      continue;
    }
    let st: Stats;
    try {
      st = await lstat(abs);
    } catch (e) {
      if (errnoCode(e) === 'ENOENT' || errnoCode(e) === 'ENOTDIR') {
        // gone after the step: a deletion when it existed before, nothing to record otherwise; `cleanAtStart` is kept so
        // /undo can bring a clean tracked file a command deleted back from HEAD (TUI-DESIGN §12.4 restore source 3)
        if (before === undefined || before.existed) files[rel] = { deleted: true, preImage, source: opts.source, cleanAtStart: opts.cleanAtStart(rel) };
        continue;
      }
      skipped.push({ path: rel, reason: 'not-recoverable' });
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) {
      skipped.push({ path: rel, reason: 'link' });
      continue;
    }
    let sha256: string | null = null;
    if (!hashSkipped && st.size <= remaining) {
      try {
        sha256 = await hashFileStreaming(abs, chunkBytes, yieldFn);
        remaining -= st.size;
      } catch (e) {
        skipped.push({ path: rel, reason: 'not-recoverable' });
        continue;
      }
    } else {
      // §12.3: the budget is spent — this and each remaining file is recorded unhashed (/undo asks for them)
      hashSkipped = true;
    }
    const base = { sha256, bytes: st.size, mode: st.mode & 0o7777, source: opts.source };
    if (before !== undefined && !before.existed) {
      files[rel] = { ...base, created: true };
    } else {
      files[rel] = { ...base, preImage, cleanAtStart: opts.cleanAtStart(rel) };
    }
  }

  // pre-image skips (size / cap) travel with the post image so /undo can explain the missing source
  if (pre) for (const e of pre.entries) if (e.skipped === 'size' || e.skipped === 'cap') skipped.push({ path: e.path, reason: e.skipped, ...(e.bytes !== null ? { bytes: e.bytes } : {}) });

  const image: PostImage = {
    v: POST_IMAGE_VERSION,
    step,
    at: opts.at ?? new Date().toISOString(),
    headOid: opts.headOid,
    files,
    skipped,
    hashSkipped,
  };
  try {
    await writeFileAtomic(postImagePath(runDir, step), `${JSON.stringify(image)}\n`, { mkdir: true });
  } catch (e) {
    throw fail(runDir, `cannot write post-image for step ${step}: ${describe(e)}`, e);
  }
  return { image, ms: Math.max(0, now() - t0) };
}

// ---------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------

const IMAGE_SOURCES: readonly string[] = ['edit', 'write', 'patch', 'run'];
const SKIP_REASONS: readonly string[] = ['link', 'escape', 'submodule', 'not-recoverable', 'head-moved', 'refused', 'declined', 'cap', 'size'];

function isImageSkip(v: Json): v is ImageSkip & Json {
  return isJsonObject(v) && typeof v['path'] === 'string' && typeof v['reason'] === 'string' && SKIP_REASONS.includes(v['reason']) && (v['bytes'] === undefined || typeof v['bytes'] === 'number');
}

function isPostImageFile(v: Json): v is PostImageFile & Json {
  if (!isJsonObject(v)) return false;
  if (typeof v['source'] !== 'string' || !IMAGE_SOURCES.includes(v['source'])) return false;
  const opt = (k: string, t: 'string' | 'number' | 'boolean', nullable = false): boolean => {
    const x = v[k];
    return x === undefined || typeof x === t || (nullable && x === null);
  };
  return opt('sha256', 'string', true) && opt('bytes', 'number') && opt('mode', 'number') && opt('preImage', 'boolean') && opt('cleanAtStart', 'boolean') && opt('created', 'boolean') && opt('deleted', 'boolean');
}

/** Structural check of a post image (TUI-DESIGN §12.3 shape). */
export function isPostImage(v: unknown): v is PostImage {
  if (!isJsonObject(v)) return false;
  if (v['v'] !== POST_IMAGE_VERSION || typeof v['step'] !== 'number' || typeof v['at'] !== 'string') return false;
  if (!(v['headOid'] === null || typeof v['headOid'] === 'string')) return false;
  if (typeof v['hashSkipped'] !== 'boolean') return false;
  const files = v['files'];
  if (!isJsonObject(files)) return false;
  for (const f of Object.values(files)) if (!isPostImageFile(f)) return false;
  const skipped = v['skipped'];
  return isJsonArray(skipped) && skipped.every(isImageSkip);
}

function isPreImageEntry(v: Json): v is PreImageEntry & Json {
  return (
    isJsonObject(v) &&
    typeof v['path'] === 'string' &&
    typeof v['existed'] === 'boolean' &&
    (v['bytes'] === null || typeof v['bytes'] === 'number') &&
    (v['mode'] === null || typeof v['mode'] === 'number') &&
    typeof v['copied'] === 'boolean' &&
    (v['skipped'] === null || (typeof v['skipped'] === 'string' && SKIP_REASONS.includes(v['skipped'])))
  );
}

/** Structural check of `pre/<step>/index.json` (TUI-DESIGN §12.3 layout). */
export function isPreImageIndex(v: unknown): v is PreImageIndex {
  if (!isJsonObject(v)) return false;
  if (v['v'] !== 1 || typeof v['step'] !== 'number' || typeof v['source'] !== 'string' || !IMAGE_SOURCES.includes(v['source'])) return false;
  const entries = v['entries'];
  return isJsonArray(entries) && entries.every(isPreImageEntry);
}

async function readJsonFile(path: string): Promise<{ ok: true; value: Json } | { ok: false; reason: 'missing' | 'corrupt'; detail: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    const code = errnoCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing', detail: 'missing' };
    return { ok: false, reason: 'corrupt', detail: `unreadable (${describe(e)})` };
  }
  const parsed = parseJson(text);
  if (!parsed.ok) return { ok: false, reason: 'corrupt', detail: `not JSON (${parsed.error})` };
  return { ok: true, value: parsed.value };
}

/** TUI-DESIGN §12.3: `post/<step>.json`, falling back to the `.undone.json` twin left by /undo (§12.4). */
export async function readPostImages(runDir: string, step: number): Promise<PostImageRead> {
  assertStep(step);
  for (const undone of [false, true]) {
    const r = await readJsonFile(postImagePath(runDir, step, undone));
    if (!r.ok) {
      if (r.reason === 'missing') continue;
      return { ok: false, reason: 'corrupt', detail: r.detail };
    }
    if (!isPostImage(r.value)) return { ok: false, reason: 'corrupt', detail: 'shape invalid' };
    if (r.value.step !== step) return { ok: false, reason: 'corrupt', detail: `step ${r.value.step} does not match file ${step}` };
    return { ok: true, image: r.value, undone };
  }
  return { ok: false, reason: 'missing', detail: 'missing' };
}

/** Every recorded post image under `post/`, ascending by step, with its undone flag (TUI-DESIGN §12.4, §12.5). */
export async function listPostImages(runDir: string): Promise<{ step: number; undone: boolean }[]> {
  let names: string[];
  try {
    names = await readdir(join(runDir, CHECKPOINT_FILES.post));
  } catch (e) {
    if (errnoCode(e) === 'ENOENT' || errnoCode(e) === 'ENOTDIR') return [];
    throw fail(runDir, `cannot list post images: ${describe(e)}`, e);
  }
  const out: { step: number; undone: boolean }[] = [];
  for (const n of names) {
    const m = /^(\d+)(\.undone)?\.json$/.exec(n);
    if (!m) continue;
    const step = Number(m[1]);
    if (!Number.isSafeInteger(step) || step < 1) continue;
    out.push({ step, undone: m[2] !== undefined });
  }
  out.sort((a, b) => a.step - b.step || Number(a.undone) - Number(b.undone));
  return out;
}

/** `pre/<step>/index.json` (TUI-DESIGN §12.3); null when absent or unusable. */
export async function readPreIndex(runDir: string, step: number): Promise<PreImageIndex | null> {
  assertStep(step);
  const r = await readJsonFile(join(preImageDir(runDir, step), PRE_INDEX_FILE));
  return r.ok && isPreImageIndex(r.value) ? r.value : null;
}

/** `pre/<step>/dirs.json`: directories the step created, deepest first; [] when absent (TUI-DESIGN §12.3). */
export async function readPreDirs(runDir: string, step: number): Promise<string[]> {
  assertStep(step);
  const r = await readJsonFile(join(preImageDir(runDir, step), PRE_DIRS_FILE));
  if (!r.ok || !isJsonArray(r.value)) return [];
  return r.value.filter((d): d is string => typeof d === 'string' && normaliseRelPath(d) !== null);
}

/**
 * The bytes (and recorded mode) of one pre-image; null when the step's index does not record a copy for the path
 * (TUI-DESIGN §12.4 restore source 1). The index is the authority: a copy file without an index entry is a
 * leftover, never a restore source.
 */
export async function readPreImage(runDir: string, step: number, relPath: string): Promise<{ bytes: Buffer; mode: number | null } | null> {
  const rel = normaliseRelPath(relPath);
  if (rel === null) return null;
  const index = await readPreIndex(runDir, step);
  const entry = index?.entries.find((e) => e.path === rel);
  if (entry === undefined || !entry.copied) return null;
  let bytes: Buffer;
  try {
    bytes = await readFile(preImagePath(runDir, step, rel));
  } catch (e) {
    if (errnoCode(e) === 'ENOENT' || errnoCode(e) === 'ENOTDIR') return null;
    throw fail(runDir, `cannot read pre-image for ${rel}: ${describe(e)}`, e);
  }
  return { bytes, mode: entry.mode };
}

/** TUI-DESIGN §12.4: `post/<step>.json` → `post/<step>.undone.json` after a successful /undo; false when there was none. */
export async function markPostImageUndone(runDir: string, step: number): Promise<boolean> {
  assertStep(step);
  try {
    await rename(postImagePath(runDir, step), postImagePath(runDir, step, true));
    return true;
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return false;
    throw fail(runDir, `cannot mark step ${step} undone: ${describe(e)}`, e);
  }
}
