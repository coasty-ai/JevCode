/**
 * `/undo [n]` and `/rewind` application (TUI-DESIGN §12.4, §12.5, D8) — the I/O half over plan.ts's pure table.
 *
 * `prepareUndo` reads the step's post image, the later steps' post images and the current facts of every recorded
 * path (lstat, streamed sha256, realpath escape, hard-link count, submodule membership) and hands them to `planUndo`.
 * `applyUndo` resolves the plan's ask rows (pre-seeded answers → the per-file callback → default `n`) **before its
 * first write**, re-reads every restore row against the plan's `expected` snapshot (the asks are human-paced; a
 * file that changed meanwhile is asked again once or kept), then restores in the §12.4 source order — pre-image
 * (`writeFileAtomic` + `chmod` to the recorded mode) → unlink of created files plus the recorded empty directories →
 * `git restore --source=HEAD --worktree` with literal pathspecs for clean tracked files a command changed while HEAD
 * is unchanged — renames `post/<N>.json` to `post/<N>.undone.json` and returns the §24 item text, the seed note and
 * the `UndoLogEntry` (§15 item 9; null when nothing was restored). A plan with a refusal writes nothing. Every git
 * call goes through `runGit` with the neutralising flags; never `checkout --`, `--staged`, `stash`, `reset`, `clean`
 * (C40).
 */
import type { Stats } from 'node:fs';
import { chmod, lstat, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { hashFileStreaming, listPostImages, markPostImageUndone, normaliseRelPath, readPostImages, readPreDirs, readPreImage, type PostImage } from '../checkpoint/images.js';
import { writeFileAtomic } from '../core/atomic.js';
import type { Sandbox, UiLabel, UndoLogEntry, UndoSkipReason } from '../core/types.js';
import { restoreFromHead, runGit } from '../workspace/git.js';
import { LITERAL_PATHSPECS_ENV } from './diff.js';
import {
  CHANGED_DURING_UNDO,
  KEPT_DECLINED,
  askPrompt,
  currentAsk,
  expectedState,
  planUndo,
  reduceUndoAsk,
  resolveAsks,
  skipsFromDecisions,
  startUndoAsks,
  stillExpected,
  undoAsksDone,
  undoLogEntry,
  undoNote,
  undoSummaryLine,
  type CurrentFileState,
  type UndoAskKey,
  type UndoDecision,
  type UndoPlan,
  type UndoSkip,
} from './plan.js';

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §12.4: files larger than this are not hashed when the current state is read (`sha256: null` → the ask row). */
export const CURRENT_HASH_MAX_BYTES = 64 * 1024 * 1024;
/** TUI-DESIGN §24: the label of every undo item (`[ui] undo step N: …`); the formatter prints it, the text carries none. */
export const UNDO_ITEM_LABEL: UiLabel = '[ui]';
/** TUI-DESIGN §12.4 / §24: the `<reasons>` text of `no files restored (…)` after Esc in the ask row. */
export const UNDO_ABORTED_REASON = 'undo aborted';
/** The restore source when neither `restoreFromHead` nor a sandbox is available (§12.4 row "git restore"). */
export const NO_GIT_RUNNER = 'not recoverable — no git runner for restore from HEAD';
/**
 * TUI-DESIGN §12.4 "all checks before the first write": verification passes over the restore rows — the plan's
 * snapshot, then a re-read right before the write. A row whose file changed while an ask was open is asked again
 * once (when an ask channel exists); a row that changes yet again — or has no channel — is kept.
 */
export const UNDO_VERIFY_ROUNDS = 2;
const GIT_TIMEOUT_MS = 30_000;
const OID_RE = /^[0-9a-f]{40,64}$/;
const MISSING: CurrentFileState = { exists: false, sha256: null };

// ---------------------------------------------------------------------------------------
// Current file state (TUI-DESIGN §12.4: "current file vs post[N].files[p]")
// ---------------------------------------------------------------------------------------

export interface ReadCurrentOptions {
  /** submodule paths from the status entries (`sub[0] === 'S'`); a path at or under one is a `submodule` row */
  submodules?: ReadonlySet<string> | readonly string[];
  /** files larger than this keep `sha256: null` (the ask row) instead of being hashed */
  hashMaxBytes?: number;
  /** called between hashing chunks (default: setImmediate through hashFileStreaming) */
  yieldBetweenChunks?: () => Promise<void>;
}

function errnoCode(e: unknown): string | null {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function insideRoot(root: string, abs: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep;
  return abs === root || abs.startsWith(r);
}

/** The workspace root as a realpath (macOS `/var` → `/private/var`); every escape check compares realpaths against it. */
async function realRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return resolve(root);
  }
}

/**
 * TUI-DESIGN §12.4 `escape`: the realpath of `abs` (or, when it does not exist yet, of its nearest existing
 * ancestor) must stay inside `root` and must not enter `.git`; a symlinked directory on the way counts as an escape
 * because a restore would write through it.
 */
async function escapesRoot(root: string, abs: string): Promise<boolean> {
  let p = abs;
  for (let i = 0; i < 64; i++) {
    try {
      const real = await realpath(p);
      if (!insideRoot(root, real)) return true;
      const relParts = real.slice(root.length).split(sep);
      return relParts.includes('.git');
    } catch (e) {
      const code = errnoCode(e);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return true;
      if (p === root || !insideRoot(root, p)) return false;
      p = dirname(p);
    }
  }
  return true;
}

function submoduleSet(s: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> {
  if (s === undefined) return new Set<string>();
  return s instanceof Set ? s : new Set<string>(s as readonly string[]);
}

function underSubmodule(rel: string, subs: ReadonlySet<string>): boolean {
  if (subs.size === 0) return false;
  if (subs.has(rel)) return true;
  for (const s of subs) {
    const prefix = s.endsWith('/') ? s : `${s}/`;
    if (rel.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * TUI-DESIGN §12.4: what is on disk now for every recorded path — lstat, streamed sha256 (files ≤ `hashMaxBytes`),
 * realpath escape, hard-link count and submodule membership — in the shape `planUndo` compares against the post
 * image. A path that fails `normaliseRelPath` (absolute, `..`, `.git`) is reported as an escape without touching
 * the disk. Never throws for a single path: an unreadable file reads as `{ exists: true, sha256: null }`.
 */
export async function readCurrentFiles(root: string, paths: readonly string[], opts: ReadCurrentOptions = {}): Promise<Record<string, CurrentFileState>> {
  const out: Record<string, CurrentFileState> = {};
  const real = await realRoot(root);
  const subs = submoduleSet(opts.submodules);
  const max = opts.hashMaxBytes ?? CURRENT_HASH_MAX_BYTES;
  for (const path of paths) {
    const rel = normaliseRelPath(path);
    if (rel === null) {
      out[path] = { exists: false, sha256: null, escapes: true };
      continue;
    }
    const abs = resolve(real, rel);
    const state: CurrentFileState = { exists: false, sha256: null };
    if (underSubmodule(rel, subs)) state.submodule = true;
    if (!insideRoot(real, abs) || (await escapesRoot(real, abs))) state.escapes = true;
    let st: Stats;
    try {
      st = await lstat(abs);
    } catch (e) {
      const code = errnoCode(e);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') state.exists = true;
      out[path] = state;
      continue;
    }
    state.exists = true;
    if (st.isSymbolicLink()) state.symlink = true;
    if (st.nlink > 1) state.nlink = st.nlink;
    if (!st.isSymbolicLink() && st.isFile() && st.nlink <= 1 && state.escapes !== true && st.size <= max) {
      try {
        state.sha256 = opts.yieldBetweenChunks ? await hashFileStreaming(abs, undefined, opts.yieldBetweenChunks) : await hashFileStreaming(abs);
      } catch {
        state.sha256 = null;
      }
    }
    out[path] = state;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// prepareUndo: images → current facts → plan
// ---------------------------------------------------------------------------------------

export interface PrepareUndoOptions extends ReadCurrentOptions {
  /** realpath of the workspace */
  root: string;
  /** the current HEAD oid (null: unborn or no repository); `readHeadOid` or O5's in-process reader */
  headOid: string | null;
  /** the workspace is a git repository */
  git: boolean;
}

export type PrepareUndoResult =
  | { ok: true; plan: UndoPlan; post: PostImage; later: PostImage[] }
  | { ok: false; reason: 'missing' | 'corrupt' | 'undone'; message: string };

/**
 * TUI-DESIGN §12.4: read `post/<step>.json`, the post images of the committed, not-undone steps after it, and the
 * current facts of every recorded path, then run the pure decision table. `ok: false` names why there is nothing to
 * undo (no image, a corrupt one, or a step already undone).
 */
export async function prepareUndo(runDir: string, step: number, opts: PrepareUndoOptions): Promise<PrepareUndoResult> {
  const read = await readPostImages(runDir, step);
  if (!read.ok) {
    return read.reason === 'missing'
      ? { ok: false, reason: 'missing', message: `step ${step} recorded no file changes` }
      : { ok: false, reason: 'corrupt', message: `step ${step}: post image unusable (${read.detail})` };
  }
  if (read.undone) return { ok: false, reason: 'undone', message: `step ${step} was already undone` };
  const later: PostImage[] = [];
  for (const entry of await listPostImages(runDir)) {
    if (entry.step <= step || entry.undone) continue;
    const r = await readPostImages(runDir, entry.step);
    if (r.ok && !r.undone) later.push(r.image);
  }
  const current = await readCurrentFiles(opts.root, Object.keys(read.image.files), opts);
  const plan = planUndo({ step, post: read.image, current, later, headOid: opts.headOid, git: opts.git });
  return { ok: true, plan, post: read.image, later };
}

// ---------------------------------------------------------------------------------------
// git restore from HEAD (TUI-DESIGN §12.4 restore source 3; C40)
// ---------------------------------------------------------------------------------------

export interface RestoreFromHeadResult {
  restored: string[];
  failed: { path: string; reason: string }[];
}

export interface GitRestoreOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const t = line.trim();
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

/**
 * TUI-DESIGN §12.4: O5's `restoreFromHead` (`git restore --source=HEAD --worktree -- <paths>` through `runGit`
 * with the neutralising flags) as a per-path result. One batch first; when git refuses the batch (one unmatched
 * pathspec fails the whole command without restoring anything — verified on git 2.50) every path is retried alone
 * so the good ones are restored and the bad one is reported. Pathspecs are literal (`GIT_LITERAL_PATHSPECS=1`, C40):
 * a recorded `pages/[id].tsx` restores that file and never `pages/i.tsx`. Nothing here touches the index, refs or
 * the stash.
 */
export async function gitRestoreFromHead(sandbox: Sandbox, ws: string, paths: readonly string[], opts: GitRestoreOptions = {}): Promise<RestoreFromHeadResult> {
  const restored: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  const clean: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0 || p.includes('\0') || p.startsWith('/') || p.split('/').includes('..')) failed.push({ path: String(p), reason: 'invalid path' });
    else clean.push(p);
  }
  if (clean.length === 0) return { restored, failed };
  const runOpts = { timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS, env: { ...LITERAL_PATHSPECS_ENV }, ...(opts.signal ? { signal: opts.signal } : {}) };
  const attempt = async (list: readonly string[]): Promise<{ ok: boolean; reason: string }> => {
    try {
      const r = await restoreFromHead(sandbox, ws, list, runOpts);
      if (r.ok) return { ok: true, reason: '' };
      return { ok: false, reason: firstLine(r.stderr) || `git exited ${r.exitCode ?? 'by signal'}` };
    } catch (e) {
      return { ok: false, reason: describe(e) };
    }
  };
  const batch = await attempt(clean);
  if (batch.ok) return { restored: [...clean], failed };
  if (clean.length === 1) {
    failed.push({ path: clean[0]!, reason: batch.reason });
    return { restored, failed };
  }
  for (const p of clean) {
    const one = await attempt([p]);
    if (one.ok) restored.push(p);
    else failed.push({ path: p, reason: one.reason });
  }
  return { restored, failed };
}

/** TUI-DESIGN §12.4: the current HEAD commit oid through one sandboxed `rev-parse` (null when unborn or not a repository). */
export async function readHeadOid(sandbox: Sandbox, ws: string, opts: GitRestoreOptions = {}): Promise<string | null> {
  try {
    const r = await runGit(sandbox, ws, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS, ...(opts.signal ? { signal: opts.signal } : {}) });
    const oid = r.stdout.trim();
    return r.ok && OID_RE.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// applyUndo
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §12.4 / §24: the per-file ask (`y` · `n`/Enter · `a` all · `s` skip rest · Esc abort); the overlay or the readline twin answers it. */
export type UndoAsk = (ask: Extract<UndoDecision, { kind: 'ask' }>, position: { index: number; total: number }) => Promise<UndoAskKey> | UndoAskKey;

/**
 * What apply.ts needs injected: the run directory (images), the workspace root, a HEAD restorer and the ask channel.
 * The `ReadCurrentOptions` (submodules, hashing bound) feed the re-verification read right before the write.
 */
export interface ApplyUndoDeps extends ReadCurrentOptions {
  runDir: string;
  runId: string;
  /** realpath of the workspace */
  root: string;
  /** `git restore --source=HEAD --worktree -- <paths>` (O5's `restoreFromHead` when it lands); default: `gitRestoreFromHead` over `sandbox` */
  restoreFromHead?: (paths: readonly string[]) => Promise<RestoreFromHeadResult>;
  /** the run's sandbox for the default HEAD restorer; without either, git-restore rows are skipped as not recoverable */
  sandbox?: Sandbox;
  /** ISO clock for the undoLog entry (default: now) */
  nowIso?: () => string;
  /** answers already collected for the plan's ask rows (path → overwrite); the rest go to `ask`, then default `n` */
  answers?: Readonly<Record<string, boolean>>;
  /** the per-file ask; absent = every unanswered ask keeps the file (default `n`) */
  ask?: UndoAsk;
  signal?: AbortSignal;
}

export interface ApplyUndoResult {
  step: number;
  restored: string[];
  skipped: UndoSkip[];
  /** the seed-carried entry (§15 item 9); null when nothing was restored (a refusal, Esc, or every row skipped) so no-op entries never reach the next seed's `undoLog` */
  entry: UndoLogEntry | null;
  /** `undo step N: restored …` / `no files restored (…)` (§24) — the item text; `label` is the item's label */
  summary: string;
  label: UiLabel;
  /** `human reverted step N: …` for the next run's seed (§12.4); null when nothing was restored */
  note: string | null;
  /** the plan had a refusal: nothing was written (§12.4 row 3) */
  refused: boolean;
  /** Esc in the ask row: nothing was written */
  aborted: boolean;
  /** `post/<N>.json` was renamed to `post/<N>.undone.json` */
  undone: boolean;
  /** non-fatal problems after the restores (the rename failed, a recorded directory could not be removed) */
  warnings: string[];
}

const ASK_KEYS: readonly UndoAskKey[] = ['y', 'n', 'a', 's', 'esc', 'enter'];

function normaliseKey(k: unknown): UndoAskKey {
  return typeof k === 'string' && (ASK_KEYS as readonly string[]).includes(k) ? (k as UndoAskKey) : 'n';
}

type AskRow = Extract<UndoDecision, { kind: 'ask' }>;

/**
 * Resolve the given ask rows before the first write: pre-seeded answers (only for the plan's own asks — a re-ask
 * is about content nobody answered for), then the callback, then default `n` (§12.4).
 */
async function resolveAskRows(step: number, asks: readonly AskRow[], deps: ApplyUndoDeps, useSeeded: boolean): Promise<{ answers: Readonly<Record<string, boolean>>; aborted: boolean }> {
  let state = startUndoAsks({ step, decisions: [...asks], refusals: [], asks: [...asks] });
  const total = asks.length;
  while (!undoAsksDone(state)) {
    const cur = currentAsk(state);
    if (cur === null) break;
    const seeded = useSeeded ? deps.answers?.[cur.path] : undefined;
    let key: UndoAskKey;
    if (seeded !== undefined) key = seeded ? 'y' : 'n';
    else if (deps.ask) {
      try {
        key = normaliseKey(await deps.ask(cur, { index: state.index, total }));
      } catch {
        key = 'esc';
      }
    } else key = 'n';
    state = reduceUndoAsk(state, key);
  }
  return { answers: state.answers, aborted: state.aborted };
}

function skip(path: string, reason: UndoSkipReason, message: string): UndoSkip {
  return { path, reason, message };
}

/** The safety rows of §12.4 over a fresh read of one path (link / escape / submodule), or null when none applies. */
function safetySkip(path: string, cur: CurrentFileState): UndoSkip | null {
  if (cur.symlink === true || (cur.nlink !== undefined && cur.nlink > 1)) return skip(path, 'link', 'symlink or hard link');
  if (cur.escapes === true) return skip(path, 'escape', 'resolves outside the workspace or into .git');
  if (cur.submodule === true) return skip(path, 'submodule', 'submodule');
  return null;
}

/**
 * TUI-DESIGN §12.4 "all checks before the first write": the ask overlay is human-paced, so the plan's disk snapshot
 * is re-read for every restore row after the asks resolve. A row that turned into a link / escape / submodule is
 * skipped with that reason; a row whose bytes differ from what the plan (or the answered ask) saw is asked again
 * once through the same channel — or kept when there is none or it changed yet again — and an Esc still aborts
 * the whole undo with nothing written. Returns the final decisions (restore rows only where the disk still matches).
 */
async function verifyRestoreRows(plan: UndoPlan, initial: readonly UndoDecision[], root: string, deps: ApplyUndoDeps): Promise<{ decisions: UndoDecision[]; aborted: boolean }> {
  let decisions: UndoDecision[] = [...initial];
  for (let round = 1; round <= UNDO_VERIFY_ROUNDS; round++) {
    const rows = decisions.filter((d): d is Extract<UndoDecision, { kind: 'restore' }> => d.kind === 'restore');
    if (rows.length === 0) break;
    const current = await readCurrentFiles(root, rows.map((r) => r.path), deps);
    const changed = new Map<string, AskRow>();
    decisions = decisions.map((d): UndoDecision => {
      if (d.kind !== 'restore') return d;
      const cur = current[d.path] ?? MISSING;
      const unsafe = safetySkip(d.path, cur);
      if (unsafe !== null) return { kind: 'skip', path: d.path, reason: unsafe.reason, message: unsafe.message };
      if (stillExpected(d.expected, cur)) return d;
      changed.set(d.path, { kind: 'ask', path: d.path, via: d.via, prompt: askPrompt(d.path, plan.step), expected: expectedState(cur) });
      return d;
    });
    if (changed.size === 0) break;
    const canReask = deps.ask !== undefined && round < UNDO_VERIFY_ROUNDS;
    if (!canReask) {
      decisions = decisions.map((d) => (changed.has(d.path) ? { kind: 'skip', path: d.path, reason: 'declined', message: CHANGED_DURING_UNDO } : d));
      break;
    }
    const reask = await resolveAskRows(plan.step, [...changed.values()], deps, false);
    if (reask.aborted) return { decisions, aborted: true };
    decisions = decisions.map((d): UndoDecision => {
      const fresh = changed.get(d.path);
      if (fresh === undefined) return d;
      return reask.answers[d.path] === true ? { kind: 'restore', path: d.path, via: fresh.via, expected: fresh.expected } : { kind: 'skip', path: d.path, reason: 'declined', message: KEPT_DECLINED };
    });
  }
  return { decisions, aborted: false };
}

function buildResult(input: { step: number; runId: string; by: 'undo' | 'rewind'; at: string; restored: string[]; skipped: UndoSkip[]; refused: boolean; aborted: boolean; undone: boolean; warnings: string[] }): ApplyUndoResult {
  const summary = input.aborted && input.restored.length === 0 ? `no files restored (${UNDO_ABORTED_REASON})` : undoSummaryLine(input.step, input.restored, input.skipped);
  // a no-op undo (refused, aborted, nothing restored) leaves no undoLog entry: the next seed carries only real reverts (§15 item 9)
  const entry = input.restored.length > 0 && !input.refused && !input.aborted ? undoLogEntry({ runId: input.runId, step: input.step, at: input.at, by: input.by, restored: input.restored, skipped: input.skipped }) : null;
  return {
    step: input.step,
    restored: input.restored,
    skipped: input.skipped,
    entry,
    summary,
    label: UNDO_ITEM_LABEL,
    note: input.restored.length > 0 ? undoNote(input.step, input.restored) : null,
    refused: input.refused,
    aborted: input.aborted,
    undone: input.undone,
    warnings: input.warnings,
  };
}

async function applyOne(plan: UndoPlan, deps: ApplyUndoDeps, by: 'undo' | 'rewind'): Promise<ApplyUndoResult> {
  const at = (deps.nowIso ?? (() => new Date().toISOString()))();
  const base = { step: plan.step, runId: deps.runId, by, at, undone: false, warnings: [] as string[] };
  // §12.4 row 3: a refusal blocks the whole undo — nothing is written, nothing is asked
  if (plan.refusals.length > 0) return buildResult({ ...base, restored: [], skipped: skipsFromDecisions(plan.decisions), refused: true, aborted: false });
  // every ask answered before the first write; an Esc keeps the plan's skips for the item text, restores nothing
  const asks = await resolveAskRows(plan.step, plan.asks, deps, true);
  if (asks.aborted) return buildResult({ ...base, restored: [], skipped: skipsFromDecisions(plan.decisions), refused: false, aborted: true });
  const root = await realRoot(deps.root);
  // the last check before the first write: the disk is re-read for every restore row (the asks were human-paced)
  const verified = await verifyRestoreRows(plan, resolveAsks(plan, asks.answers), root, deps);
  if (verified.aborted) return buildResult({ ...base, restored: [], skipped: skipsFromDecisions(plan.decisions), refused: false, aborted: true });
  const decisions = verified.decisions;
  const restored: string[] = [];
  const skipped: UndoSkip[] = [];
  const viaPre: { path: string; abs: string }[] = [];
  const viaUnlink: { path: string; abs: string }[] = [];
  const viaGit: string[] = [];
  for (const d of decisions) {
    if (d.kind !== 'restore') {
      if (d.kind === 'skip') skipped.push(skip(d.path, d.reason, d.message));
      else if (d.kind === 'ask') skipped.push(skip(d.path, 'declined', KEPT_DECLINED));
      else skipped.push(skip(d.path, 'refused', d.message));
      continue;
    }
    // defence in depth: the plan already refused escapes; the abs path is re-derived and re-checked here
    const rel = normaliseRelPath(d.path);
    const abs = rel === null ? null : resolve(root, rel);
    if (rel === null || abs === null || !insideRoot(root, abs)) {
      skipped.push(skip(d.path, 'escape', 'resolves outside the workspace or into .git'));
      continue;
    }
    if (d.via === 'pre-image') viaPre.push({ path: d.path, abs });
    else if (d.via === 'unlink') viaUnlink.push({ path: d.path, abs });
    else viaGit.push(d.path);
  }

  // source 1: the pre-image bytes with the recorded mode, atomically
  for (const f of viaPre) {
    let pre: { bytes: Buffer; mode: number | null } | null;
    try {
      pre = await readPreImage(deps.runDir, plan.step, f.path);
    } catch (e) {
      skipped.push(skip(f.path, 'not-recoverable', `pre-image unreadable (${describe(e)})`));
      continue;
    }
    if (pre === null) {
      skipped.push(skip(f.path, 'not-recoverable', 'pre-image missing'));
      continue;
    }
    try {
      await writeFileAtomic(f.abs, pre.bytes, { mkdir: true, ...(pre.mode !== null ? { mode: pre.mode } : {}) });
      // `open(tmp, 'w', mode)` is subject to the process umask; the recorded mode is applied explicitly after the rename
      if (pre.mode !== null) await chmod(f.abs, pre.mode & 0o7777).catch(() => undefined);
      restored.push(f.path);
    } catch (e) {
      skipped.push(skip(f.path, 'not-recoverable', `write failed (${errnoCode(e) ?? describe(e)})`));
    }
  }

  // source 2: created files are unlinked; a file already gone is the wanted end state
  for (const f of viaUnlink) {
    try {
      await unlink(f.abs);
      restored.push(f.path);
    } catch (e) {
      const code = errnoCode(e);
      if (code === 'ENOENT') restored.push(f.path);
      else skipped.push(skip(f.path, 'not-recoverable', `unlink failed (${code ?? describe(e)})`));
    }
  }

  // source 3: clean tracked files a command changed, from an unchanged HEAD (C40: restore, never checkout --)
  if (viaGit.length > 0) {
    const restorer = deps.restoreFromHead ?? (deps.sandbox ? (paths: readonly string[]) => gitRestoreFromHead(deps.sandbox!, root, paths, deps.signal ? { signal: deps.signal } : {}) : null);
    if (restorer === null) {
      for (const p of viaGit) skipped.push(skip(p, 'not-recoverable', NO_GIT_RUNNER));
    } else {
      let r: RestoreFromHeadResult;
      try {
        r = await restorer(viaGit);
      } catch (e) {
        r = { restored: [], failed: viaGit.map((p) => ({ path: p, reason: describe(e) })) };
      }
      const ok = new Set(r.restored);
      for (const p of viaGit) {
        if (ok.has(p)) restored.push(p);
        else {
          const f = r.failed.find((x) => x.path === p);
          skipped.push(skip(p, 'not-recoverable', `git restore failed${f ? ` (${f.reason})` : ''}`));
        }
      }
    }
  }

  // the recorded empty directories a step created go with its created files (deepest first, as recorded) — also when
  // every created file was already gone (ENOENT counts as restored): the directories are the step's too
  if (viaUnlink.length > 0) {
    let dirs: string[] = [];
    try {
      dirs = await readPreDirs(deps.runDir, plan.step);
    } catch (e) {
      base.warnings.push(`could not read the created-directory list: ${describe(e)}`);
    }
    for (const d of dirs) {
      const rel = normaliseRelPath(d);
      if (rel === null) continue;
      const abs = resolve(root, rel);
      if (!insideRoot(root, abs) || abs === root) continue;
      try {
        await rmdir(abs);
      } catch {
        /* not empty, already gone, or not ours to remove: the files were restored either way */
      }
    }
  }

  // the step is undone once anything was restored: post/<N>.json → post/<N>.undone.json (§12.4)
  let undone = false;
  if (restored.length > 0) {
    try {
      undone = await markPostImageUndone(deps.runDir, plan.step);
    } catch (e) {
      base.warnings.push(`could not mark step ${plan.step} undone: ${describe(e)}`);
    }
  }
  // the item lists restored files in the post image's order
  const order = new Map(plan.decisions.map((d, i) => [d.path, i] as const));
  restored.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  skipped.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
  return buildResult({ ...base, restored, skipped, refused: false, aborted: false, undone });
}

/**
 * TUI-DESIGN §12.4: restore the files of one planned step. All checks (the plan, then every ask row) happen before
 * the first write; a refusal or Esc writes nothing. Resolves for every outcome — per-file failures become skips
 * with their reason — and rejects only when the run directory itself is unusable.
 */
export function applyUndo(plan: UndoPlan, deps: ApplyUndoDeps): Promise<ApplyUndoResult> {
  return applyOne(plan, deps, 'undo');
}

/**
 * TUI-DESIGN §12.5: undo the given steps in the given order (last first, from `planRewind().order`), stopping at
 * the first refusal or Esc — that step's result is the last one returned. Entries carry `by: 'rewind'`.
 */
export async function applyRewind(steps: readonly UndoPlan[], deps: ApplyUndoDeps): Promise<ApplyUndoResult[]> {
  const out: ApplyUndoResult[] = [];
  for (const plan of steps) {
    const r = await applyOne(plan, deps, 'rewind');
    out.push(r);
    if (r.refused || r.aborted) break;
  }
  return out;
}
