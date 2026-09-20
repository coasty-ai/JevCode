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
import { appendFile, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic, writeFileAtomicSync } from '../core/atomic.js';
import { sha256Hex } from '../core/hash.js';
import { isJsonArray, isJsonObject, parseJson } from '../core/json.js';
import type {
  CheckpointState,
  CheckpointStore,
  Decision,
  GeneratorCallRecord,
  JevRequestRecord,
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
} as const;

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

const ENGINE_MODES: readonly string[] = ['jev-on', 'jev-off'];

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
      throw fail(`cannot write checkpoint temp file: ${describe(e)}`, e);
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
        throw fail(`cannot write checkpoint temp file: ${describe(e)}`, e);
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
