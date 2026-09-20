/**
 * Run identifiers and run-directory resolution (DESIGN.md §9).
 *
 * `<YYYYMMDD>-<HHMMSS>-<8 base32 chars>` in UTC: sortable, filesystem-safe on
 * case-insensitive volumes (lowercase alphabet only), 40 random bits so concurrent bench
 * workers practically never collide; the non-recursive mkdir + EEXIST retry makes a collision
 * harmless anyway.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { CheckpointError, ConfigError, JevCodeError } from '../errors.js';

/** RFC 4648 base32 alphabet, lowercased. */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const SUFFIX_BYTES = 5;
const SUFFIX_CHARS = 8;
/** Bounded so a pathological `random` stub (or a full disk pretending EEXIST) cannot spin forever. */
const MAX_MKDIR_ATTEMPTS = 16;

export const RUN_ID_RE = /^\d{8}-\d{6}-[a-z2-7]{8}$/;

export type RandomBytes = () => Uint8Array;

function defaultRandom(): Uint8Array {
  return randomBytes(SUFFIX_BYTES);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** Encode the first `chars * 5` bits of `bytes` as lowercase base32 (no padding). */
export function encodeBase32(bytes: Uint8Array, chars: number): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += BASE32_ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
      // keep only the unconsumed low bits so `acc` never exceeds 32 bits
      acc &= (1 << bits) - 1;
    }
    if (out.length >= chars) break;
  }
  return out;
}

/** UTC `YYYYMMDD-HHMMSS` prefix for `now`. */
export function runIdTimestamp(now: Date): string {
  if (Number.isNaN(now.getTime())) throw new JevCodeError('internal', 'newRunId: invalid Date');
  return (
    `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}` +
    `-${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}`
  );
}

export function newRunId(now: Date, random: RandomBytes = defaultRandom): string {
  const bytes = random();
  if (bytes.length < SUFFIX_BYTES) {
    throw new JevCodeError('internal', `newRunId: random source returned ${bytes.length} bytes, need ${SUFFIX_BYTES}`);
  }
  return `${runIdTimestamp(now)}-${encodeBase32(bytes, SUFFIX_CHARS)}`;
}

export function isValidRunId(id: string): boolean {
  return typeof id === 'string' && RUN_ID_RE.test(id);
}

function errnoCode(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Create a fresh run directory under `runsDir`. The runs dir is `mkdir -p`'d once; the run
 * dir itself uses a non-recursive mkdir so EEXIST is reliable and regenerates the suffix.
 */
export async function createRunDir(
  runsDir: string,
  now: Date,
  random: RandomBytes = defaultRandom,
): Promise<{ runId: string; runDir: string }> {
  try {
    await mkdir(runsDir, { recursive: true });
  } catch (e) {
    throw new CheckpointError(`cannot create runs directory ${runsDir}: ${e instanceof Error ? e.message : String(e)}`, runsDir, { cause: e });
  }
  for (let attempt = 0; attempt < MAX_MKDIR_ATTEMPTS; attempt++) {
    const runId = newRunId(now, random);
    const runDir = join(runsDir, runId);
    try {
      await mkdir(runDir);
      return { runId, runDir };
    } catch (e) {
      if (errnoCode(e) === 'EEXIST') continue;
      throw new CheckpointError(`cannot create run directory ${runDir}: ${e instanceof Error ? e.message : String(e)}`, runDir, { cause: e });
    }
  }
  throw new CheckpointError(`could not create a unique run directory under ${runsDir} after ${MAX_MKDIR_ATTEMPTS} attempts`, runsDir);
}

/**
 * Resolve `--resume <run-id>` to a directory. Format and containment failures are
 * ConfigError (exit 2) because a hostile id must never widen the sandbox's writable set;
 * a well-formed id with no directory is CheckpointError (exit 3).
 */
export async function resolveRunDir(runsDir: string, runId: string): Promise<string> {
  if (!isValidRunId(runId)) {
    throw new ConfigError(`--resume: "${runId}" is not a run id (expected YYYYMMDD-HHMMSS-xxxxxxxx)`, { setting: 'resume' });
  }
  const candidate = join(runsDir, runId);
  let realRuns: string;
  try {
    realRuns = await realpath(runsDir);
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') throw new CheckpointError(`runs directory ${runsDir} does not exist`, candidate, { cause: e });
    throw new CheckpointError(`cannot resolve runs directory ${runsDir}: ${e instanceof Error ? e.message : String(e)}`, candidate, { cause: e });
  }
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') throw new CheckpointError(`run ${runId} not found in ${runsDir}`, candidate, { cause: e });
    throw new CheckpointError(`cannot resolve run directory ${candidate}: ${e instanceof Error ? e.message : String(e)}`, candidate, { cause: e });
  }
  if (!real.startsWith(realRuns + sep)) {
    throw new ConfigError(`--resume: run ${runId} resolves outside the runs directory ${runsDir}`, { setting: 'resume' });
  }
  let st;
  try {
    st = await stat(real);
  } catch (e) {
    throw new CheckpointError(`cannot stat run directory ${real}`, candidate, { cause: e });
  }
  if (!st.isDirectory()) throw new CheckpointError(`run ${runId} is not a directory`, candidate);
  return real;
}
