/**
 * §3.2 / §3.4 (COORDINATION-DESIGN design revision 5): THIS BOOT'S IDENTITY — the single producer of
 * `SelfIdentity.bootId` / `OpenLedgerOptions.bootId` in the tree.
 *
 * Every other file in `src/coordination/**` says the boot id is "resolved by the CALLER (this module spawns nothing)",
 * and until this module existed there was no caller: no `sysctl` and no `/proc` read lived anywhere in `src/`, so
 * `bootId` was always absent and three revision-5 rules were dead letters — `lockReplaceVerdict`'s `other-boot`
 * branch (`records.ts`), the `duplicate-identity` clause (ii) that separates a live clone from a previous boot of this
 * machine (§3.2), and the `bootId` disqualifier on a local control message (§5.4 rule 5, §10.3).
 *
 * The rules this module keeps, in order:
 *   · the OS read is INJECTED (`BootProbe`). `bootIdOf` itself imports nothing that can spawn, so the "spawns nothing"
 *     property of `src/coordination/**` is unchanged for every caller that passes a probe, and the ONE production
 *     spawn is quarantined in `nodeBootProbe`, which loads `node:child_process` lazily — importing this module, or the
 *     facade that re-exports it, still pulls no process-spawning module into the graph and starts no child.
 *   · BOUNDED: one 200 ms deadline over the whole probe (`BOOT_ID_DEADLINE_MS`), enforced here and not only by the
 *     child's own timeout, because an injected probe may never settle. A machine that cannot answer in 200 ms must
 *     not delay the first frame; §3.5's budget rule applies to identity too.
 *   · MEMOISED per process: the id cannot change while the process lives, and the §3.4 comparison runs on every
 *     record. Only the DEFAULT probe is memoised — an injected one always re-runs, so a test never reads another
 *     test's answer and a caller with its own probe is never served a stale one.
 *   · `null` ON ANY FAILURE, never a throw and never a guess. `null` is "unknown", which stays PERMISSIVE exactly as
 *     an unknown `hostKey` does (§3.2): a boot id denies, it never grants — so a missing one can only cost a refusal
 *     the reader would otherwise have been able to make, never a wrong replacement of a live lock.
 */
import { withTimeout } from './fs.js';

/** §3.4: the darwin read — `sysctl -n kern.bootsessionuuid`, no shell, no arguments from any caller. */
export const BOOT_ID_SYSCTL_CMD = 'sysctl';
export const BOOT_ID_SYSCTL_ARGS: readonly string[] = ['-n', 'kern.bootsessionuuid'];
/** §3.4: the linux read — a 37-byte pseudo-file, no spawn at all. */
export const BOOT_ID_PATH_LINUX = '/proc/sys/kernel/random/boot_id';
/** the whole probe's budget; a machine that cannot answer in this long has no boot id as far as the fold is concerned */
export const BOOT_ID_DEADLINE_MS = 200;
/** a boot id is a UUID on both supported platforms; the bound is generous and exists only to refuse a page of output */
export const BOOT_ID_MAX_CHARS = 64;
/** what an answer must look like to be recorded: one token of id characters, never a sentence and never a path */
const BOOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * The two OS reads a boot id needs, injected. A caller that has neither (a sandbox with no `sysctl` and no `/proc`)
 * passes one that rejects, and `bootIdOf` answers `null`.
 */
export interface BootProbe {
  /** run a bounded LOCAL command with no shell and resolve its stdout; reject on any failure */
  exec(cmd: string, args: readonly string[], timeoutMs: number): Promise<string>;
  /** read a small pseudo-file; reject on any failure */
  read(path: string): Promise<string>;
}

export interface BootIdOptions {
  /** default `nodeBootProbe`; an injected probe is never memoised */
  probe?: BootProbe;
  /** default `process.platform`; only `'darwin'` and `'linux'` have a boot identity JevCode can read */
  platform?: NodeJS.Platform;
  /** default `BOOT_ID_DEADLINE_MS` */
  timeoutMs?: number;
}

/**
 * The production probe. `node:child_process` is imported LAZILY and only on darwin, so nothing in
 * `src/coordination/**` pulls a spawning module into the import graph and no child starts until a caller asks for a
 * boot id. `maxBuffer` is small on purpose: `sysctl` answers one line, and a hostile PATH entry answering megabytes
 * must fail rather than be read.
 */
export const nodeBootProbe: BootProbe = {
  async exec(cmd, args, timeoutMs) {
    const { execFile } = await import('node:child_process');
    return await new Promise<string>((resolve, reject) => {
      execFile(cmd, [...args], { timeout: timeoutMs, maxBuffer: 4_096, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        if (err !== null) reject(err);
        else resolve(stdout);
      });
    });
  },
  async read(path) {
    const { readFile } = await import('node:fs/promises');
    return await readFile(path, 'utf8');
  },
};

/** The first line, trimmed; `null` unless it is one id token within the bound (an error page is not a boot id). */
export function normaliseBootId(raw: string): string | null {
  const line = (raw.split('\n')[0] ?? '').trim();
  if (line === '' || line.length > BOOT_ID_MAX_CHARS) return null;
  return BOOT_ID_RE.test(line) ? line : null;
}

let memoised: Promise<string | null> | null = null;

/**
 * This boot's identity, or `null` when it cannot be read. Never throws, never blocks longer than the deadline, and
 * never spawns on a platform that has no boot identity to read.
 */
export function bootIdOf(o: BootIdOptions = {}): Promise<string | null> {
  const injected = o.probe !== undefined || o.platform !== undefined;
  if (!injected && memoised !== null) return memoised;
  const p = resolveBootId(o.probe ?? nodeBootProbe, o.platform ?? process.platform, o.timeoutMs ?? BOOT_ID_DEADLINE_MS);
  if (!injected) memoised = p;
  return p;
}

async function resolveBootId(probe: BootProbe, platform: NodeJS.Platform, timeoutMs: number): Promise<string | null> {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : BOOT_ID_DEADLINE_MS;
  const read = platform === 'darwin' ? () => probe.exec(BOOT_ID_SYSCTL_CMD, BOOT_ID_SYSCTL_ARGS, ms) : platform === 'linux' ? () => probe.read(BOOT_ID_PATH_LINUX) : null;
  if (read === null) return null;
  try {
    return normaliseBootId(await withTimeout(read(), ms, 'bootId'));
  } catch {
    // every failure is the same answer: unknown, which is permissive (§3.2). A probe that throws synchronously,
    // one that rejects, one that never settles and a platform without the read are one case for the reader.
    return null;
  }
}
