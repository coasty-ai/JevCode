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
import { OUTPUTS_DIR_MAX_BYTES, OUTPUT_FILE_MAX_CHARS } from '../core/limits.js';
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

// ---------------------------------------------------------------------------------------
// Disk-error classification (TUI-DESIGN §13.3, §13.5: `checkpoint degraded: <code> on <file>`)
// ---------------------------------------------------------------------------------------

/** The errno codes that make a checkpoint write a degraded-but-not-fatal condition (TUI-DESIGN §13.3). */
export const DISK_ERROR_CODES = ['ENOSPC', 'EACCES', 'EROFS', 'EDQUOT', 'EIO', 'EMFILE'] as const;
export type DiskErrorCode = (typeof DISK_ERROR_CODES)[number];

export interface DiskError {
  code: DiskErrorCode;
  /** the checkpoint artefact the write was for, when known (`state.json`, `steps.jsonl`, …) */
  file: string | null;
  /** `checkpoint degraded: <code> on <file>` (TUI-DESIGN §24); `<file>` falls back to `run dir` */
  text: string;
  /** stable identity for the engine's once-per-(file, code) rule */
  key: string;
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
  return { code, file: named, text: `checkpoint degraded: ${code} on ${shown}`, key: `${shown}:${code}` };
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

export type EnvelopeParse = { ok: true; state: CheckpointState } | { ok: false; reason: string };

/** Parse and verify one envelope file's text: JSON, version, checksum over the re-serialised state, shape. */
export function parseEnvelope(text: string): EnvelopeParse {
  const parsed = parseJson(text);
  if (!parsed.ok) return { ok: false, reason: `not JSON (${parsed.error})` };
  const env = parsed.value;
  if (!isJsonObject(env)) return { ok: false, reason: 'envelope is not an object' };
  if (env['version'] !== CHECKPOINT_VERSION) return { ok: false, reason: `unsupported version ${JSON.stringify(env['version'])}` };
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

export function createCheckpointStore(runDir: string, redact: Redactor): DiskCheckpointStore {
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

  function fail(message: string, cause?: unknown): CheckpointError {
    return new CheckpointError(`${message} (${dir})`, dir, cause === undefined ? {} : { cause });
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
        throw fail(`append to ${file} failed: ${describe(e)}`, e);
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
      throw fail(`cannot write ${CHECKPOINT_FILES.meta}: ${describe(e)}`, e);
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
      throw fail(`cannot write ${CHECKPOINT_FILES.state} temp file: ${describe(e)}`, e);
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
      throw fail(`cannot rotate ${CHECKPOINT_FILES.state}: ${describe(e)}`, e);
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
        throw fail(`cannot write ${CHECKPOINT_FILES.state} temp file: ${describe(e)}`, e);
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
        throw fail(`cannot rotate ${CHECKPOINT_FILES.state}: ${describe(e)}`, e);
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
          throw fail(`cannot write ${CHECKPOINT_FILES.ui}: ${describe(e)}`, e);
        }
      });
    },

    /**
     * contract 1.4 (COORDINATION-DESIGN §7.2, §6.4): `<runDir>/cache/<rel>` — redacted like every artefact, tmp + rename (no
     * fsync: a lost cache file costs one replay, never the run), the parent created on demand, serialised per file.
     */
    writeCache(rel: string, json: Json) {
      const norm = cacheRelPath(rel);
      if (norm === null) return Promise.reject(fail(`cache path ${JSON.stringify(rel)} is not a relative path inside ${CHECKPOINT_FILES.cache}/`));
      const file = `${CHECKPOINT_FILES.cache}/${norm}`;
      return enqueue(file, async () => {
        const text = JSON.stringify(redactDeep(json, redact));
        if (text === undefined) throw fail(`cannot serialise ${file}`);
        try {
          await writeFileAtomic(join(dir, CHECKPOINT_FILES.cache, ...norm.split('/')), `${text}\n`, { mkdir: true });
        } catch (e) {
          throw fail(`cannot write ${file}: ${describe(e)}`, e);
        }
      });
    },

    /**
     * contract 1.4 (§7.3 step 3): rename one cache file — `step-<n>.json` → `step-<n>.superseded.json` when step n runs fresh,
     * so the bytes stay for the audit trail and no `--replay` can read them again. A missing source is not an error (nothing
     * to supersede); both names are validated like every cache path and the rename rides the source file's chain.
     */
    renameCache(from: string, to: string) {
      const a = cacheRelPath(from);
      const b = cacheRelPath(to);
      if (a === null || b === null) return Promise.reject(fail(`cache path ${JSON.stringify(a === null ? from : to)} is not a relative path inside ${CHECKPOINT_FILES.cache}/`));
      const file = `${CHECKPOINT_FILES.cache}/${a}`;
      return enqueue(file, async () => {
        try {
          await rename(join(dir, CHECKPOINT_FILES.cache, ...a.split('/')), join(dir, CHECKPOINT_FILES.cache, ...b.split('/')));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw fail(`cannot rename ${file}: ${describe(e)}`, e);
        }
      });
    },

    /** contract 1.4 (§7.3 step 3): the cache file back as JSON; null when missing, unreadable or not JSON (the replay is then simply unavailable). */
    async readCache(rel: string) {
      const norm = cacheRelPath(rel);
      if (norm === null) return null;
      const path = join(dir, CHECKPOINT_FILES.cache, ...norm.split('/'));
      // defence in depth: the joined path must stay under <runDir>/cache (normalise() folds any separator the platform accepts)
      const base = join(dir, CHECKPOINT_FILES.cache) + sep;
      if (!normalize(path).startsWith(base)) return null;
      let text: string;
      try {
        const st = await stat(path);
        if (st.size > MAX_FILE_BYTES) return null;
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
          throw fail(`cannot write ${CHECKPOINT_FILES.outputs}/${name}: ${describe(e)}`, e);
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
          throw fail(`cannot write ${CHECKPOINT_FILES.context}/${CONTEXT_SUMMARY_FILE}: ${describe(e)}`, e);
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
  };
  return store;
}
