/**
 * On-disk checkpoint store for one run directory (DESIGN.md §9, §9.1, §11).
 *
 * Durability split: `state.json` is the only artefact read back as truth, so it is written
 * tmp + fsync + rename with the previous copy rotated to `state.prev.json` by rename (never a
 * copy). The JSONL logs are plain appends serialised per file so lines never interleave, and
 * readers tolerate a torn trailing line. Every string leaf passes `redact()` before it is
 * serialised, so a secret can never reach disk through any artefact.
 */
import { randomBytes } from 'node:crypto';
import { renameSync, unlinkSync } from 'node:fs';
import { appendFile, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, normalize, posix, sep } from 'node:path';
import { writeFileAtomic, writeFileAtomicSync } from '../core/atomic.js';
import { sha256Hex } from '../core/hash.js';
import { isJsonArray, isJsonObject, parseJson } from '../core/json.js';
import { MAX_CLAIMS_PER_RUN, OUTPUTS_DIR_MAX_BYTES, OUTPUT_FILE_MAX_CHARS } from '../core/limits.js';
import { headTail } from '../core/text.js';
import type {
  CheckpointState,
  CheckpointStore,
  Decision,
  GeneratorCallRecord,
  JevRequestRecord,
  Json,
  RunMeta,
  StepRecord,
} from '../core/types.js';
import { CheckpointError } from '../errors.js';

export const CHECKPOINT_FILES = {
  meta: 'run.json',
  state: 'state.json',
  prev: 'state.prev.json',
  steps: 'steps.jsonl',
  decisions: 'decisions.jsonl',
  jev: 'jev.jsonl',
  generator: 'generator.jsonl',
  transcript: 'transcript.log',
  // TUI-DESIGN §15 item 19: session-era artefacts under the same run directory
  /** renderer settings snapshot (§8.8), written by writeUi() */
  ui: 'ui.json',
  /** the run log (§13.6) */
  log: 'jevcode.log',
  /** liveness lock (§8.5) */
  lock: 'run.lock',
  /** pre-images directory: pre/<step>/<sha256(relpath)> (§12.3) */
  pre: 'pre',
  /** post-images directory: post/<step>.json (§12.3) */
  post: 'post',
  /** scratch files such as /diff --full patches (§12.6) */
  tmp: 'tmp',
  /** cleared composer drafts, redacted (§10.7) */
  drafts: 'drafts',
  /** contract 1.4 (COORDINATION-DESIGN §7.2, §6.4): pause-now snapshots `cache/step-<n>.json` and the LLM round cache, written by writeCache() */
  cache: 'cache',
  /**
   * contract 1.5 (docs/ORCHESTRATION-DESIGN.md §8.2 D0 item 4, §3.7, §2.5): the delegation's artefacts —
   * `manifest-<step>.json`, `agent-<slug>.task`, `agent-<slug>.seed.json`, `review-<n>.json` / `.used`, `land.jsonl`,
   * `land.lock`. Written through the SAME `writeCache` / `readCache` / `renameCache` triple as `cache/`, selected by an
   * `orchestrate/`-prefixed rel, so there is one validated, redacted, per-file-serialised writer and not two.
   */
  orchestrate: 'orchestrate',
  // docs/COORDINATION-DESIGN.md §8.3 / §8.6 (W2 item 20): the context policy's artefacts under the same run directory
  /** whole step outputs: outputs/step-<n>.txt (≤ 1 MiB each, ≤ 64 MiB per run) */
  outputs: 'outputs',
  /** the rolling summary: context/summary.json */
  context: 'context',
} as const;

/** `context/summary.json` (docs/COORDINATION-DESIGN.md §8.6). */
export const CONTEXT_SUMMARY_FILE = 'summary.json';
const OUTPUT_FILE_RE = /^step-([1-9]\d{0,8})\.txt$/;

/** `outputs/step-<n>.txt`, run-relative. */
export function outputFileName(step: number): string {
  if (!Number.isInteger(step) || step < 1) throw new RangeError(`output step must be a positive integer, got ${String(step)}`);
  return `step-${step}.txt`;
}

/**
 * contract 1.4: a `cache/` relative path is validated, never trusted — relative, normalised, no `..`, no empty component,
 * `/` separators only (the same containment rule as the run id). Returns the posix-normalised rel or null.
 */
export function cacheRelPath(rel: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 256) return null;
  if (isAbsolute(rel) || rel.includes('\\') || rel.includes('\0')) return null;
  const norm = posix.normalize(rel);
  if (norm === '.' || norm.startsWith('../') || norm === '..' || norm.startsWith('/')) return null;
  if (norm.split('/').some((c) => c.length === 0 || c === '.' || c === '..')) return null;
  return norm;
}

/**
 * contract 1.5 (§3.7): one `orchestrate/` artefact is at most this many bytes after redaction. The manifest's own bound
 * is `MANIFEST_BYTES` (32 KiB, `src/core/limits.ts`) and is enforced by `src/orchestrate/manifest.ts`; this is the
 * store's floor-to-ceiling guard for every artefact under the directory, in the same spirit as `MAX_FILE_BYTES` above:
 * a checkpoint artefact larger than this is not something JevCode produced.
 */
export const ORCHESTRATE_FILE_BYTES = 256 * 1024;

const ORCHESTRATE_PREFIX = `${CHECKPOINT_FILES.orchestrate}/`;

/**
 * contract 1.5: which of the two cache-shaped roots a rel names. `orchestrate/<x>` goes to `<runDir>/orchestrate/<x>`;
 * everything else keeps contract 1.4's `<runDir>/cache/<rel>`. `file` is the run-relative path — the error text, and the
 * per-file chain key, so the two roots can never share a queue even when they hold the same leaf name.
 */
interface CacheTarget {
  root: string;
  /** the path under `root`, already normalised */
  rel: string;
  /** `<root>/<rel>`, run-relative */
  file: string;
  /** the byte ceiling for a write to this root */
  maxBytes: number;
}

export function cacheTarget(rel: string): CacheTarget | null {
  const norm = cacheRelPath(rel);
  if (norm === null) return null;
  if (norm.startsWith(ORCHESTRATE_PREFIX)) {
    const sub = norm.slice(ORCHESTRATE_PREFIX.length);
    if (sub.length === 0) return null;
    return { root: CHECKPOINT_FILES.orchestrate, rel: sub, file: norm, maxBytes: ORCHESTRATE_FILE_BYTES };
  }
  return { root: CHECKPOINT_FILES.cache, rel: norm, file: `${CHECKPOINT_FILES.cache}/${norm}`, maxBytes: MAX_FILE_BYTES };
}

// ---------------------------------------------------------------------------------------
// Disk-error classification (TUI-DESIGN §13.3, §13.5: `checkpoint degraded: <code> on <file>`)
// ---------------------------------------------------------------------------------------

/**
 * The errno codes that make a checkpoint write a degraded-but-not-fatal condition (TUI-DESIGN §13.3).
 *
 * TUI-DESIGN-4 §7.2 edge 2 adds **ENOENT**: with the runs directory removed 0.9 s into a 40-step run every write
 * fails with ENOENT, and before round 4 that was completely silent — the run reported `complete`, exit 0, and the
 * epilogue advertised a resume for a directory that no longer existed. Classification is only ever applied to
 * **write** failures (`failWrite` below, and the engine's `noteDiskError`), so a read of an absent file is
 * unaffected.
 */
export const DISK_ERROR_CODES = ['ENOSPC', 'EACCES', 'EROFS', 'EDQUOT', 'EIO', 'EMFILE', 'ENOENT'] as const;
export type DiskErrorCode = (typeof DISK_ERROR_CODES)[number];

export interface DiskError {
  code: DiskErrorCode;
  /** the checkpoint artefact the write was for, when known (`state.json`, `steps.jsonl`, …) */
  file: string | null;
  /** `checkpoint degraded: <code> on <file>` (TUI-DESIGN §24); `<file>` falls back to `run dir` */
  text: string;
  /**
   * TUI-DESIGN-4 §7.2 edge 6 / §12: `text` plus the consequence —
   * `checkpoint degraded: EACCES on state.json — the run directory is not writable; this run cannot be resumed`.
   * The notice never prints the raw `open '<path>'` suffix an errno message carries. `text` is kept beside it so
   * existing consumers and captures are unchanged; the engine's `checkpoint:degraded` emit uses `sentence`.
   */
  sentence: string;
  /** stable identity for the engine's once-per-(file, code) rule */
  key: string;
}

/**
 * TUI-DESIGN-4 §7.2 edge 6: the clause after the em dash — what the errno means for this run, in the user's terms.
 * Every branch ends with the same consequence, because every disk class has it: the checkpoint did not land.
 */
export function degradedConsequence(code: DiskErrorCode): string {
  switch (code) {
    case 'EACCES':
    case 'EROFS':
      return 'the run directory is not writable; this run cannot be resumed';
    case 'ENOSPC':
    case 'EDQUOT':
      return 'the disk is full; this run cannot be resumed';
    case 'ENOENT':
      return 'the run directory was removed during the run; this run cannot be resumed';
    case 'EMFILE':
      return 'too many open files; this run cannot be resumed';
    case 'EIO':
      return 'the device reported an I/O error; this run cannot be resumed';
  }
}

/** TUI-DESIGN-4 §7.2 edge 6 / §12: the whole sentence the `checkpoint:degraded` notice carries. */
export function checkpointDegradedSentence(code: DiskErrorCode, file: string): string {
  return `checkpoint degraded: ${code} on ${file} — ${degradedConsequence(code)}`;
}

function isDiskErrorCode(v: unknown): v is DiskErrorCode {
  return typeof v === 'string' && (DISK_ERROR_CODES as readonly string[]).includes(v);
}

/** Walk `cause` chains (CheckpointError wraps the errno error) up to a small bound; cycles end at the bound. */
function findErrnoCode(e: unknown): DiskErrorCode | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 8 && typeof cur === 'object' && cur !== null; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (isDiskErrorCode(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The artefact the error text names first (by position), so `fail()` messages like "cannot rotate state.json: …"
 * and errno texts like "ENOSPC: write '<run>/state.json.tmp-…'" name the file. Every occurrence of the run
 * directory is removed first, so a run-dir path that happens to contain an artefact name never counts.
 */
function fileNamedIn(message: string, runDir: string | null): string | null {
  const text = runDir !== null && runDir.length > 0 ? message.split(runDir).join('<run>') : message;
  let best: { name: string; at: number } | null = null;
  for (const name of Object.values(CHECKPOINT_FILES)) {
    if (!name.includes('.')) continue;
    const at = text.indexOf(name);
    if (at >= 0 && (best === null || at < best.at)) best = { name, at };
  }
  return best?.name ?? null;
}

/**
 * TUI-DESIGN §13.3: classify a write failure by errno. Returns null for anything that is not one of the
 * six disk conditions (those keep today's fatal path). `file` (the artefact the caller was writing: pass it at
 * every engine call site) overrides the name inferred from the message; a CheckpointError's `runDir` is
 * stripped from the text before the inference.
 */
export function classifyDiskError(e: unknown, file?: string): DiskError | null {
  const code = findErrnoCode(e);
  if (code === null) return null;
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const runDir = e instanceof CheckpointError ? e.runDir : null;
  const named = file ?? fileNamedIn(message, runDir);
  const shown = named ?? 'run dir';
  return { code, file: named, text: `checkpoint degraded: ${code} on ${shown}`, sentence: checkpointDegradedSentence(code, shown), key: `${shown}:${code}` };
}

/**
 * Where an unreadable state.json is parked when the next write lands after load() had to
 * fall back to state.prev.json. Renaming it over state.prev.json (the normal rotation) would
 * replace the only valid envelope with garbage and leave a window with no loadable state.
 */
export const CORRUPT_STATE_FILE = 'state.corrupt.json';

export const CHECKPOINT_VERSION = 1 as const;

/**
 * A checkpoint artefact larger than this is not something JevCode produced; refuse rather
 * than buffer it. Kept under V8's ~512 MiB string cap so the bound is what fires, not
 * ERR_STRING_TOO_LONG.
 */
const MAX_FILE_BYTES = 256 * 1024 * 1024;
/** Records never nest this deep; the bound only guards a hostile or cyclic-looking value. */
const MAX_REDACT_DEPTH = 128;

export type Redactor = (s: string) => string;

export interface DiskCheckpointStore extends CheckpointStore {
  /** Warnings collected by the most recent load() or readStepsAfter() (torn lines, prev fallback). */
  lastWarnings(): readonly string[];
  /**
   * TUI-DESIGN-4 §7.2 P-D2 item 1, the second entry point to `CheckpointStoreOptions.onDegrade`: the ENGINE cannot
   * pass constructor options (its `CheckpointStoreFactory` is `(runsDir, runId, redact)`, `engine.ts:173`, and a
   * resume REPLACES the store with the one `loadForResume` built), so it registers here instead and detaches at
   * `run:end`. One listener slot, two ways in. `null` detaches.
   */
  setDegradeListener(cb: ((info: DiskError) => void) | null): void;
  /** TUI-DESIGN §15 item 10: ui.json (required on the disk store; optional on the contract so fakes type-check). */
  writeUi(ui: Json): Promise<void>;
  /** contract 1.4 (COORDINATION-DESIGN §7.2, §6.4): the cache files (required on the disk store; optional on the contract). */
  writeCache(rel: string, json: Json): Promise<void>;
  readCache(rel: string): Promise<Json | null>;
  renameCache(from: string, to: string): Promise<void>;
  /** contract 1.4 (COORDINATION-DESIGN §8.3, §8.6, W2 item 20): the context artefacts (required here, optional on the contract) */
  writeOutput(step: number, text: string): Promise<number[]>;
  readOutput(step: number): Promise<string | null>;
  writeContextSummary(summary: Json): Promise<void>;
  readContextSummary(): Promise<Json | null>;
}

// ---------------------------------------------------------------------------------------
// Redaction and serialisation
// ---------------------------------------------------------------------------------------

/** Deep map over string leaves; keys are structural and never carry secrets (§8.4). */
export function redactDeep(value: unknown, redact: Redactor, depth = 0): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_REDACT_DEPTH) return '[redaction depth limit]';
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // JSON.stringify drops undefined properties anyway; dropping here keeps the checksum text identical
    if (v !== undefined) out[k] = redactDeep(v, redact, depth + 1);
  }
  return out;
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

/** Envelope text with the checksum computed over the exact `state` bytes embedded in it. */
export function serialiseEnvelope(state: CheckpointState, redact: Redactor): string {
  const stateText = JSON.stringify(redactDeep(state, redact));
  const checksum = sha256Hex(stateText);
  return `{"version":${CHECKPOINT_VERSION},"checksum":${JSON.stringify(checksum)},"state":${stateText}}`;
}

const ENGINE_MODES: readonly string[] = ['jev-on', 'jev-off', 'jev-only', 'llm-jev'];

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** Structural check of the fields the engine dereferences on resume; not a full schema. */
export function isCheckpointState(v: unknown): v is CheckpointState {
  if (!isJsonObject(v)) return false;
  return (
    typeof v['runId'] === 'string' &&
    typeof v['mode'] === 'string' &&
    ENGINE_MODES.includes(v['mode']) &&
    isNonNegInt(v['step']) &&
    isJsonObject(v['plan']) &&
    isJsonArray(v['window']) &&
    isJsonObject(v['loopDetector']) &&
    isJsonObject(v['spend']) &&
    typeof v['wallMsUsed'] === 'number' &&
    isJsonObject(v['timing']) &&
    isJsonArray(v['jevLatencyMs']) &&
    isJsonArray(v['tokensPerStep']) &&
    isJsonObject(v['counters']) &&
    (v['stopReason'] === null || typeof v['stopReason'] === 'string') &&
    (v['interrupted'] === null || isJsonObject(v['interrupted'])) &&
    isNonNegInt(v['consecutiveStageFailures']) &&
    isNonNegInt(v['resumes']) &&
    typeof v['updatedAt'] === 'string'
  );
}

/**
 * contract 1.4 (COORDINATION-DESIGN §3.2 / §4.6 row 1 as amended): `RunMeta.claims[]` keeps the FIRST row — the
 * origin incarnation, which is the provenance — and the newest `MAX_CLAIMS_PER_RUN - 1`. Only the origin and the
 * maximum are ever read, so pruning the middle is lossless.
 *
 * The same rule as `src/coordination/claims.ts capClaims`, computed here because `src/checkpoint/**` must not import
 * the ledger to write a bounded array; `src/core/limits.ts` holds the one number both read.
 */
export function capRunClaims<T>(rows: readonly T[]): T[] {
  if (rows.length <= MAX_CLAIMS_PER_RUN) return [...rows];
  return [rows[0] as T, ...rows.slice(rows.length - (MAX_CLAIMS_PER_RUN - 1))];
}

export function isRunMeta(v: unknown): v is RunMeta {
  if (!isJsonObject(v)) return false;
  return (
    typeof v['runId'] === 'string' &&
    typeof v['task'] === 'string' &&
    typeof v['workspace'] === 'string' &&
    typeof v['mode'] === 'string' &&
    ENGINE_MODES.includes(v['mode']) &&
    isJsonObject(v['config']) &&
    isJsonObject(v['versions']) &&
    typeof v['createdAt'] === 'string' &&
    isJsonArray(v['overrides']) &&
    isJsonArray(v['resumes'])
  );
}

/** Minimal shape check for a steps.jsonl row: everything the folder dereferences is optional-safe except `step`. */
function isStepRecord(v: unknown): v is StepRecord {
  return isJsonObject(v) && typeof v['step'] === 'number' && Number.isInteger(v['step']) && v['step'] >= 1 && isJsonArray(v['decisions']);
}

// ---------------------------------------------------------------------------------------
// Forward-version refusal (TUI-DESIGN-4 §7.9, P-D9)
// ---------------------------------------------------------------------------------------

/**
 * TUI-DESIGN-4 §7.9: `isRunMeta` "checks v1 fields only, so old files load unchanged" — right for *older* files,
 * wrong for *newer* ones. Reads the artefact's declared version: a number, `'corrupt'` when `v` is present but is
 * not a number (edge: treat as corrupt, never as newer), or null when absent (a v1 file that predates the field).
 */
export function artefactVersion(v: unknown, key = 'v'): number | 'corrupt' | null {
  if (!isJsonObject(v)) return null;
  if (!(key in v)) return null;
  const raw = v[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 'corrupt';
  return raw;
}

/** TUI-DESIGN-4 §7.9 / §12: `run <id> was written by a newer JevCode (run.json v<n>; this build reads v<m>) — upgrade with jevcode upgrade`. */
export function newerArtefactMessage(runId: string, file: string, found: number, reads: number = CHECKPOINT_VERSION): string {
  return `run ${runId} was written by a newer JevCode (${file} v${found}; this build reads v${reads}) — upgrade with jevcode upgrade`;
}

/**
 * TUI-DESIGN-4 §7.9: the refusal message when `run.json` declares a version this build cannot read, else null.
 * `v < CHECKPOINT_VERSION` and an absent `v` keep loading; `v` present but not a number is corrupt, not newer, so
 * it falls through to the existing shape check. The caller throws `ConfigError` (exit 2) — the refusal applies to
 * **resume**, never to `jevcode report`, which must still bundle an unreadable run.
 */
export function refuseNewerRunMeta(meta: unknown, runId: string): string | null {
  const v = artefactVersion(meta);
  if (typeof v !== 'number' || v <= CHECKPOINT_VERSION) return null;
  return newerArtefactMessage(runId, CHECKPOINT_FILES.meta, v);
}

export type EnvelopeParse = { ok: true; state: CheckpointState } | { ok: false; reason: string };

/** Parse and verify one envelope file's text: JSON, version, checksum over the re-serialised state, shape. */
export function parseEnvelope(text: string): EnvelopeParse {
  const parsed = parseJson(text);
  if (!parsed.ok) return { ok: false, reason: `not JSON (${parsed.error})` };
  const env = parsed.value;
  if (!isJsonObject(env)) return { ok: false, reason: 'envelope is not an object' };
  // TUI-DESIGN-4 §7.9: a *newer* envelope says so by name, so the caller can print the upgrade sentence rather
  // than "corrupt checkpoint"; anything else (older, non-numeric) keeps today's wording.
  if (env['version'] !== CHECKPOINT_VERSION) {
    const v = env['version'];
    if (typeof v === 'number' && Number.isFinite(v) && v > CHECKPOINT_VERSION)
      return { ok: false, reason: `written by a newer JevCode (${CHECKPOINT_FILES.state} v${v}; this build reads v${CHECKPOINT_VERSION})` };
    return { ok: false, reason: `unsupported version ${JSON.stringify(v)}` };
  }
  const checksum = env['checksum'];
  if (typeof checksum !== 'string') return { ok: false, reason: 'checksum missing' };
  const state = env['state'];
  if (!isJsonObject(state)) return { ok: false, reason: 'state is not an object' };
  // JSON.parse -> JSON.stringify is byte-stable for JSON produced by JSON.stringify, so a
  // mismatch here means the bytes changed after they were written.
  const actual = sha256Hex(JSON.stringify(state));
  if (actual !== checksum) return { ok: false, reason: 'checksum mismatch' };
  if (!isCheckpointState(state)) return { ok: false, reason: 'state shape invalid' };
  return { ok: true, state };
}

// ---------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN-4 §7.2 (P-D2): how the store reports a degraded write to its owner. */
export interface CheckpointStoreOptions {
  /**
   * Called **once per `<file>:<code>` key** the moment a write path classifies its failure, *in addition* to the
   * throw. Before round 4 every write failure only threw, and the fire-and-forget append paths dropped it on the
   * floor; the engine then never emitted `checkpoint:degraded`, `exitCodeFor` never saw `degraded` and the
   * epilogue advertised a resume that could not work. Never throws out of the store: the callback is guarded.
   */
  onDegrade?: (info: DiskError) => void;
}

/** The one member of `DiskCheckpointStore` the engine needs; a fake store without it is simply not wired. */
interface DegradeAware {
  setDegradeListener(cb: ((info: DiskError) => void) | null): void;
}

function isDegradeAware(store: object): store is DegradeAware {
  return typeof (store as { setDegradeListener?: unknown }).setDegradeListener === 'function';
}

/**
 * TUI-DESIGN-4 §7.2 item 1: point a store's own disk-error classification at a listener. Returns false when the
 * store does not report (an old fake), so the caller keeps today's behaviour instead of failing to construct.
 */
export function attachDegradeListener(store: CheckpointStore, cb: ((info: DiskError) => void) | null): boolean {
  if (!isDegradeAware(store)) return false;
  store.setDegradeListener(cb);
  return true;
}

export function createCheckpointStore(runDir: string, redact: Redactor, opts: CheckpointStoreOptions = {}): DiskCheckpointStore {
  const dir = runDir;
  const pathOf = (name: string): string => join(dir, name);
  /** Per-key promise chains; the stored tail is always handled so one failure never stalls the queue. */
  const tails = new Map<string, Promise<void>>();
  let warnings: string[] = [];
  /**
   * Set when load() found state.json present but unusable. The next rotation must not rename
   * it over state.prev.json (the copy load() actually returned), or a crash between the two
   * renames would leave no valid envelope at all.
   */
  let primaryUnusable = false;
  /** §7.2 item 1: the current sink. Seeded from the constructor option; the engine replaces it with `setDegradeListener`. */
  let degradeListener: ((info: DiskError) => void) | null = opts.onDegrade ?? null;

  function fail(message: string, cause?: unknown): CheckpointError {
    return new CheckpointError(`${message} (${dir})`, dir, cause === undefined ? {} : { cause });
  }

  /** TUI-DESIGN-4 §7.2 item 1: the `<file>:<code>` keys already reported, so the callback fires once per key. */
  const degradedKeys = new Set<string>();

  /**
   * TUI-DESIGN-4 §7.2 item 1: every **write** path's failure — the classification the store already computes,
   * routed to `onDegrade` as well as thrown. Read paths keep `fail()`: an absent file is not a degradation.
   * `artefact` is the checkpoint file the write was for, so the key is stable even when the errno text is not.
   */
  function failWrite(artefact: string, message: string, cause: unknown): CheckpointError {
    const err = fail(message, cause);
    const info = classifyDiskError(err, artefact);
    if (info !== null && !degradedKeys.has(info.key)) {
      degradedKeys.add(info.key);
      try {
        degradeListener?.(info);
      } catch {
        /* a broken reporter never breaks the write path: the notice is best effort, the throw is not */
      }
    }
    return err;
  }

  function toFail(e: unknown, message: string): CheckpointError {
    return e instanceof CheckpointError ? e : fail(`${message}: ${describe(e)}`, e);
  }

  /** readFile with a size guard; the caller maps ENOENT. */
  async function readBounded(file: string): Promise<string> {
    const path = pathOf(file);
    const st = await stat(path);
    if (st.size > MAX_FILE_BYTES) throw fail(`${file} is ${st.size} bytes; refusing to read more than ${MAX_FILE_BYTES}`);
    return readFile(path, 'utf8');
  }

  /** Where the current state.json goes when a new one lands: prev normally, the corrupt slot after a failed load. */
  function rotationTarget(): string {
    return pathOf(primaryUnusable ? CORRUPT_STATE_FILE : CHECKPOINT_FILES.prev);
  }

  function enqueue(key: string, op: () => Promise<void>): Promise<void> {
    const prev = tails.get(key) ?? Promise.resolve();
    const next = prev.then(op);
    tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  function toLine(record: unknown): string {
    const text = JSON.stringify(redactDeep(record, redact));
    if (text === undefined) throw fail('cannot serialise a non-JSON record');
    return `${text}\n`;
  }

  function appendLine(file: string, line: string): Promise<void> {
    return enqueue(file, async () => {
      try {
        await appendFile(pathOf(file), line, 'utf8');
      } catch (e) {
        throw failWrite(file, `append to ${file} failed: ${describe(e)}`, e);
      }
    });
  }

  /**
   * Serialise at call time (the record is a snapshot of what the caller committed) but surface
   * a serialisation failure as a rejection: this is a Promise API and callers fire-and-forget it.
   */
  function appendRecords(file: string, records: readonly unknown[]): Promise<void> {
    let text: string;
    try {
      text = records.map((r) => toLine(r)).join('');
    } catch (e) {
      return Promise.reject(toFail(e, `cannot serialise a ${file} row`));
    }
    return appendLine(file, text);
  }

  async function readMeta(): Promise<RunMeta> {
    let text: string;
    try {
      text = await readBounded(CHECKPOINT_FILES.meta);
    } catch (e) {
      throw toFail(e, `cannot read ${CHECKPOINT_FILES.meta}`);
    }
    const parsed = parseJson(text);
    if (!parsed.ok) throw fail(`${CHECKPOINT_FILES.meta} is not JSON: ${parsed.error}`);
    if (!isRunMeta(parsed.value)) throw fail(`${CHECKPOINT_FILES.meta} has an invalid shape`);
    return parsed.value;
  }

  async function writeMeta(meta: RunMeta): Promise<void> {
    const text = JSON.stringify(redactDeep(meta, redact), null, 2);
    try {
      await writeFileAtomic(pathOf(CHECKPOINT_FILES.meta), `${text}\n`, { fsync: true });
    } catch (e) {
      throw failWrite(CHECKPOINT_FILES.meta, `cannot write ${CHECKPOINT_FILES.meta}: ${describe(e)}`, e);
    }
  }

  function tmpStatePath(): string {
    return pathOf(`${CHECKPOINT_FILES.state}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  }

  async function rotateAndWriteState(state: CheckpointState): Promise<void> {
    const text = serialiseEnvelope(state, redact);
    const tmp = tmpStatePath();
    try {
      await writeFileAtomic(tmp, text, { fsync: true });
    } catch (e) {
      throw failWrite(CHECKPOINT_FILES.state, `cannot write ${CHECKPOINT_FILES.state} temp file: ${describe(e)}`, e);
    }
    try {
      // Rotation order is the durability contract: the old state becomes prev by rename
      // before the new one lands, so at every instant at least one valid envelope exists.
      try {
        await rename(pathOf(CHECKPOINT_FILES.state), rotationTarget());
      } catch (e) {
        if (errnoCode(e) !== 'ENOENT') throw e;
      }
      primaryUnusable = false;
      await rename(tmp, pathOf(CHECKPOINT_FILES.state));
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw failWrite(CHECKPOINT_FILES.state, `cannot rotate ${CHECKPOINT_FILES.state}: ${describe(e)}`, e);
    }
  }

  async function tryLoadEnvelope(file: string): Promise<EnvelopeParse> {
    let text: string;
    try {
      text = await readBounded(file);
    } catch (e) {
      return { ok: false, reason: errnoCode(e) === 'ENOENT' ? 'missing' : `unreadable (${describe(e)})` };
    }
    return parseEnvelope(text);
  }

  /**
   * docs/COORDINATION-DESIGN.md §8.3: the `outputs/` directory holds ≤ 64 MiB per run; past the bound the oldest step files go
   * first (never the one just written). The size ledger is seeded from the directory once per process, then kept in memory.
   */
  let outputsLedger: Map<number, number> | null = null;
  async function boundOutputsDir(outputsDir: string, justWritten: string, bytes: number): Promise<number[]> {
    if (outputsLedger === null) {
      const ledger = new Map<number, number>();
      let names: string[] = [];
      try {
        names = await readdir(outputsDir);
      } catch {
        names = [];
      }
      for (const n of names) {
        const m = OUTPUT_FILE_RE.exec(n);
        if (!m) continue;
        try {
          ledger.set(Number(m[1]), (await stat(join(outputsDir, n))).size);
        } catch {
          /* gone between readdir and stat */
        }
      }
      outputsLedger = ledger;
    }
    const written = OUTPUT_FILE_RE.exec(justWritten);
    if (written) outputsLedger.set(Number(written[1]), bytes);
    let total = 0;
    for (const b of outputsLedger.values()) total += b;
    if (total <= OUTPUTS_DIR_MAX_BYTES) return [];
    // §8.5 / review D12: the caller is told which steps lost their file, so the history entry stops pointing at nothing
    const evicted: number[] = [];
    for (const step of [...outputsLedger.keys()].sort((a, b) => a - b)) {
      if (total <= OUTPUTS_DIR_MAX_BYTES) break;
      const name = outputFileName(step);
      if (name === justWritten) continue;
      const size = outputsLedger.get(step) ?? 0;
      try {
        await unlink(join(outputsDir, name));
      } catch (e) {
        if (errnoCode(e) !== 'ENOENT') continue;
      }
      outputsLedger.delete(step);
      total -= size;
      evicted.push(step);
    }
    return evicted;
  }

  const store: DiskCheckpointStore = {
    dir,

    async create(meta) {
      const metaPath = pathOf(CHECKPOINT_FILES.meta);
      let exists = false;
      try {
        await stat(metaPath);
        exists = true;
      } catch (e) {
        if (errnoCode(e) !== 'ENOENT') throw fail(`cannot stat ${CHECKPOINT_FILES.meta}: ${describe(e)}`, e);
      }
      // A run dir is created once; a second create() would silently disown an existing run.
      if (exists) throw fail(`${CHECKPOINT_FILES.meta} already exists; refusing to overwrite an existing run`);
      await enqueue(CHECKPOINT_FILES.meta, () => writeMeta(meta));
    },

    async load() {
      const collected: string[] = [];
      const meta = await readMeta();
      const primary = await tryLoadEnvelope(CHECKPOINT_FILES.state);
      if (primary.ok && primary.state.runId === meta.runId) {
        primaryUnusable = false;
        warnings = collected;
        return { meta, state: primary.state, recoveredFrom: 'state' };
      }
      // A missing primary rotates harmlessly (ENOENT is ignored); a present-but-bad one must not land on prev.
      primaryUnusable = !(primary.ok === false && primary.reason === 'missing');
      const primaryReason = primary.ok ? `runId ${primary.state.runId} does not match ${CHECKPOINT_FILES.meta}` : primary.reason;
      collected.push(`${CHECKPOINT_FILES.state}: ${primaryReason}; falling back to ${CHECKPOINT_FILES.prev}`);
      const fallback = await tryLoadEnvelope(CHECKPOINT_FILES.prev);
      if (fallback.ok && fallback.state.runId === meta.runId) {
        warnings = collected;
        return { meta, state: fallback.state, recoveredFrom: 'prev' };
      }
      const fallbackReason = fallback.ok ? `runId ${fallback.state.runId} does not match ${CHECKPOINT_FILES.meta}` : fallback.reason;
      warnings = collected;
      throw fail(`no usable checkpoint: ${CHECKPOINT_FILES.state} ${primaryReason}; ${CHECKPOINT_FILES.prev} ${fallbackReason}`);
    },

    updateMeta(patch) {
      // Arrays append (§9: overrides/resumes are appended on resume); scalars replace.
      return enqueue(CHECKPOINT_FILES.meta, async () => {
        const current = await readMeta();
        const next: RunMeta = {
          ...current,
          overrides: patch.overrides ? [...current.overrides, ...patch.overrides] : current.overrides,
          resumes: patch.resumes ? [...current.resumes, ...patch.resumes] : current.resumes,
          resolvedJevModel: patch.resolvedJevModel !== undefined ? patch.resolvedJevModel : current.resolvedJevModel,
          jevModelDrift: patch.jevModelDrift !== undefined ? patch.jevModelDrift : current.jevModelDrift,
          // TUI-DESIGN §15 item 10: title / instructions / git replace as scalars (git: run:end re-probe, resumedOn);
          // conditional spreads keep exactOptionalPropertyTypes happy and never write `undefined`.
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
          ...(patch.git !== undefined ? { git: patch.git } : {}),
          // contract 1.4 (COORDINATION-DESIGN §7.4): `ended` replaces as a scalar; null (a --force reopen) clears it
          ...(patch.ended !== undefined ? { ended: patch.ended } : {}),
          // contract 1.4 (W0 item 1, §3.2 / §4.6 row 1 as amended): `claims` APPENDS like `overrides`/`resumes` and is
          // then capped at the first row plus the newest 63; `claimEpochHigh` is a monotonic MAX, never a replace — a
          // late write from an older incarnation must not lower a mark a newer one already raised.
          ...(patch.claims === undefined ? {} : { claims: capRunClaims([...(current.claims ?? []), ...patch.claims]) }),
          ...(patch.claimEpochHigh === undefined ? {} : { claimEpochHigh: Math.max(current.claimEpochHigh ?? 0, patch.claimEpochHigh) }),
          // contract 1.5 (ORCHESTRATION-DESIGN §5.7 / §5.8): `landed` APPENDS one row per landed agent (like overrides/resumes);
          // `undoUnavailableBelow` is a monotonic MAX — the undo floor only rises as more agents land, and a late write from an
          // older incarnation must not lower a floor a newer one already raised.
          ...(patch.landed === undefined ? {} : { landed: [...(current.landed ?? []), ...patch.landed] }),
          ...(patch.undoUnavailableBelow === undefined ? {} : { undoUnavailableBelow: Math.max(current.undoUnavailableBelow ?? 0, patch.undoUnavailableBelow) }),
        };
        await writeMeta(next);
      });
    },

    writeState(state) {
      return enqueue(CHECKPOINT_FILES.state, () => rotateAndWriteState(state));
    },

    writeStateSync(state) {
      const text = serialiseEnvelope(state, redact);
      const tmp = tmpStatePath();
      try {
        writeFileAtomicSync(tmp, text, { fsync: true });
      } catch (e) {
        throw failWrite(CHECKPOINT_FILES.state, `cannot write ${CHECKPOINT_FILES.state} temp file: ${describe(e)}`, e);
      }
      try {
        try {
          renameSync(pathOf(CHECKPOINT_FILES.state), rotationTarget());
        } catch (e) {
          if (errnoCode(e) !== 'ENOENT') throw e;
        }
        primaryUnusable = false;
        renameSync(tmp, pathOf(CHECKPOINT_FILES.state));
      } catch (e) {
        try {
          unlinkSync(tmp);
        } catch {
          /* best effort */
        }
        throw failWrite(CHECKPOINT_FILES.state, `cannot rotate ${CHECKPOINT_FILES.state}: ${describe(e)}`, e);
      }
    },

    appendStep(r: StepRecord) {
      return appendRecords(CHECKPOINT_FILES.steps, [r]);
    },

    appendDecisions(d: readonly Decision[]) {
      if (d.length === 0) return Promise.resolve();
      // One append call for the batch so a Jev call's rows are contiguous on disk.
      return appendRecords(CHECKPOINT_FILES.decisions, d);
    },

    appendJevRequest(r: JevRequestRecord) {
      return appendRecords(CHECKPOINT_FILES.jev, [r]);
    },

    appendGenerator(g: GeneratorCallRecord) {
      return appendRecords(CHECKPOINT_FILES.generator, [g]);
    },

    appendTranscript(line: string) {
      let text: string;
      try {
        text = redact(line).replace(/[\r\n]+$/, '');
      } catch (e) {
        return Promise.reject(toFail(e, `cannot redact a ${CHECKPOINT_FILES.transcript} line`));
      }
      return appendLine(CHECKPOINT_FILES.transcript, `${text}\n`);
    },

    async readStepsAfter(step) {
      const collected: string[] = [];
      let text: string;
      try {
        text = await readBounded(CHECKPOINT_FILES.steps);
      } catch (e) {
        if (errnoCode(e) === 'ENOENT') {
          warnings = collected;
          return [];
        }
        throw toFail(e, `cannot read ${CHECKPOINT_FILES.steps}`);
      }
      const lines = text.split('\n');
      const lastIndex = text.endsWith('\n') ? lines.length - 2 : lines.length - 1;
      const byStep = new Map<number, StepRecord>();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.trim().length === 0) continue;
        const parsed = parseJson(line);
        if (!parsed.ok || !isStepRecord(parsed.value)) {
          const where = i === lastIndex ? 'trailing line (torn write?)' : `line ${i + 1}`;
          collected.push(`${CHECKPOINT_FILES.steps}: skipped corrupt ${where}`);
          continue;
        }
        // last row per step wins: a re-run step (§9.1 rule 1) supersedes an earlier row
        byStep.set(parsed.value.step, parsed.value);
      }
      warnings = collected;
      return [...byStep.values()].filter((r) => r.step > step).sort((a, b) => a.step - b.step);
    },

    /** TUI-DESIGN §15 item 10 / §8.8: ui.json, redacted like every other artefact, atomic, serialised per file. */
    writeUi(ui: Json) {
      return enqueue(CHECKPOINT_FILES.ui, async () => {
        const text = JSON.stringify(redactDeep(ui, redact), null, 2);
        try {
          await writeFileAtomic(pathOf(CHECKPOINT_FILES.ui), `${text}\n`);
        } catch (e) {
          throw failWrite(CHECKPOINT_FILES.ui, `cannot write ${CHECKPOINT_FILES.ui}: ${describe(e)}`, e);
        }
      });
    },

    /**
     * contract 1.4 (COORDINATION-DESIGN §7.2, §6.4): `<runDir>/cache/<rel>` — redacted like every artefact, tmp + rename (no
     * fsync: a lost cache file costs one replay, never the run), the parent created on demand, serialised per file.
     */
    writeCache(rel: string, json: Json) {
      // contract 1.5 (§8.2 D0 item 4): an `orchestrate/`-prefixed rel lands under <runDir>/orchestrate/ instead; everything
      // else is contract 1.4's <runDir>/cache/<rel>, byte for byte.
      const target = cacheTarget(rel);
      if (target === null) return Promise.reject(fail(`cache path ${JSON.stringify(rel)} is not a relative path inside ${CHECKPOINT_FILES.cache}/ or ${CHECKPOINT_FILES.orchestrate}/`));
      const { root, rel: norm, file, maxBytes } = target;
      return enqueue(file, async () => {
        const text = JSON.stringify(redactDeep(json, redact));
        if (text === undefined) throw fail(`cannot serialise ${file}`);
        if (Buffer.byteLength(text, 'utf8') + 1 > maxBytes) throw fail(`${file} is ${Buffer.byteLength(text, 'utf8') + 1} bytes; refusing to write more than ${maxBytes}`);
        try {
          await writeFileAtomic(join(dir, root, ...norm.split('/')), `${text}\n`, { mkdir: true });
        } catch (e) {
          // review 2026-09-22 finding 9: the degrade is keyed against the ARTEFACT, not the directory. An
          // `orchestrate/` write keyed as `cache` named the wrong file in the notice AND let a later real
          // `cache` failure of the same code be swallowed as a duplicate of it.
          throw failWrite(file, `cannot write ${file}: ${describe(e)}`, e);
        }
      });
    },

    /**
     * contract 1.4 (§7.3 step 3): rename one cache file — `step-<n>.json` → `step-<n>.superseded.json` when step n runs fresh,
     * so the bytes stay for the audit trail and no `--replay` can read them again. A missing source is not an error (nothing
     * to supersede); both names are validated like every cache path and the rename rides the source file's chain.
     */
    renameCache(from: string, to: string) {
      const a = cacheTarget(from);
      const b = cacheTarget(to);
      if (a === null || b === null) return Promise.reject(fail(`cache path ${JSON.stringify(a === null ? from : to)} is not a relative path inside ${CHECKPOINT_FILES.cache}/ or ${CHECKPOINT_FILES.orchestrate}/`));
      // contract 1.5: a rename stays inside ONE root — `review-<n>.json` → `review-<n>.used` (§2.5), `step-<n>.json` →
      // `step-<n>.superseded.json` (§7.3). Crossing the two would move an artefact out from under its own chain key.
      if (a.root !== b.root) return Promise.reject(fail(`cannot rename ${a.file} to ${b.file}: a cache rename never crosses ${CHECKPOINT_FILES.cache}/ and ${CHECKPOINT_FILES.orchestrate}/`));
      const file = a.file;
      return enqueue(file, async () => {
        try {
          await rename(join(dir, a.root, ...a.rel.split('/')), join(dir, b.root, ...b.rel.split('/')));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw failWrite(file, `cannot rename ${file}: ${describe(e)}`, e);
        }
      });
    },

    /** contract 1.4 (§7.3 step 3): the cache file back as JSON; null when missing, unreadable or not JSON (the replay is then simply unavailable). */
    async readCache(rel: string) {
      const target = cacheTarget(rel);
      if (target === null) return null;
      const path = join(dir, target.root, ...target.rel.split('/'));
      // defence in depth: the joined path must stay under <runDir>/<root> (normalise() folds any separator the platform accepts)
      const base = join(dir, target.root) + sep;
      if (!normalize(path).startsWith(base)) return null;
      let text: string;
      try {
        const st = await stat(path);
        if (st.size > target.maxBytes) return null;
        text = await readFile(path, 'utf8');
      } catch {
        return null;
      }
      const parsed = parseJson(text);
      return parsed.ok ? parsed.value : null;
    },

    // docs/COORDINATION-DESIGN.md §8.3: whole outputs under outputs/, one file per step, on the directory's chain so the
    // per-run byte bound (oldest deleted first) is applied by one writer at a time; redacted like every other artefact.
    writeOutput(step: number, text: string) {
      let name: string;
      let body: string;
      try {
        name = outputFileName(step);
        body = redact(text.length > OUTPUT_FILE_MAX_CHARS ? headTail(text, OUTPUT_FILE_MAX_CHARS - 4_096, 4_000) : text);
      } catch (e) {
        return Promise.reject(toFail(e, `cannot prepare ${CHECKPOINT_FILES.outputs}/step-${step}.txt`));
      }
      let evicted: number[] = [];
      return enqueue(CHECKPOINT_FILES.outputs, async () => {
        const dir = pathOf(CHECKPOINT_FILES.outputs);
        try {
          await writeFileAtomic(join(dir, name), body, { mkdir: true });
        } catch (e) {
          throw failWrite(CHECKPOINT_FILES.outputs, `cannot write ${CHECKPOINT_FILES.outputs}/${name}: ${describe(e)}`, e);
        }
        evicted = await boundOutputsDir(dir, name, Buffer.byteLength(body, 'utf8'));
      }).then(() => evicted);
    },

    async readOutput(step: number) {
      const name = outputFileName(step);
      try {
        return await readFile(join(pathOf(CHECKPOINT_FILES.outputs), name), 'utf8');
      } catch (e) {
        if (errnoCode(e) === 'ENOENT' || errnoCode(e) === 'ENOTDIR') return null;
        throw fail(`cannot read ${CHECKPOINT_FILES.outputs}/${name}: ${describe(e)}`, e);
      }
    },

    /** docs/COORDINATION-DESIGN.md §8.6: context/summary.json, redacted, atomic, serialised on its own chain. */
    writeContextSummary(summary: Json) {
      return enqueue(`${CHECKPOINT_FILES.context}/${CONTEXT_SUMMARY_FILE}`, async () => {
        const text = JSON.stringify(redactDeep(summary, redact));
        try {
          await writeFileAtomic(join(pathOf(CHECKPOINT_FILES.context), CONTEXT_SUMMARY_FILE), `${text}\n`, { mkdir: true });
        } catch (e) {
          throw failWrite(CHECKPOINT_FILES.context, `cannot write ${CHECKPOINT_FILES.context}/${CONTEXT_SUMMARY_FILE}: ${describe(e)}`, e);
        }
      });
    },

    async readContextSummary() {
      let text: string;
      try {
        text = await readFile(join(pathOf(CHECKPOINT_FILES.context), CONTEXT_SUMMARY_FILE), 'utf8');
      } catch (e) {
        if (errnoCode(e) === 'ENOENT' || errnoCode(e) === 'ENOTDIR') return null;
        throw fail(`cannot read ${CHECKPOINT_FILES.context}/${CONTEXT_SUMMARY_FILE}: ${describe(e)}`, e);
      }
      const parsed = parseJson(text);
      return parsed.ok ? parsed.value : null;
    },

    async flush() {
      // Snapshot first: an append enqueued during the await belongs to the next flush.
      await Promise.all([...tails.values()]);
    },

    lastWarnings() {
      return [...warnings];
    },

    setDegradeListener(cb: ((info: DiskError) => void) | null) {
      degradeListener = cb;
    },
  };
  return store;
}
