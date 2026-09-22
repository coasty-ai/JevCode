/**
 * Identity facts and validators (§3.1 path components, §3.2 identity table, W0 item 4). Everything is code: ids by regex,
 * keys by sha256, the device id minted once and re-adopted from a restored `~/.jevcode`, the per-run Lamport stamp
 * `(n, deviceId, runId)`, the per-workspace case-sensitivity probe. No spawns here: the git facts (`root oids`, shallow,
 * origin URL, superproject) arrive as arguments from the workspace probe that already runs after `run:ready`.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { RUN_ID_RE, encodeBase32 } from '../checkpoint/run-id.js';
import { sha256Hex } from '../core/hash.js';
import { isJsonObject, parseJson } from '../core/json.js';
import { ConfigError } from '../errors.js';
import { checksumOf, withChecksum } from './checksum.js';
import { COMMONS_KEY_BYTES, COMMONS_KEY_RE } from './claims.js';
import type { CoordFs } from './fs.js';
import { FILE_MODE, DIR_MODE, errnoCode } from './fs.js';
import type { DeviceRecord, Stamp } from './types.js';

// ── validators (§3.1) ──────────────────────────────────────────────────────────────────────────────────────────────────

export { RUN_ID_RE };
export const DEVICE_ID_RE = /^[a-z2-7]{8}$/;
export const SESSION_ID_RE = RUN_ID_RE;
export const REPO_KEY_RE = /^(ws:|rm:)?[0-9a-f]{16}$/;
export const SEQ_RE = /^\d{1,9}$/;
export const MSG_ID_RE = /^[a-z2-7]{8}-[a-z2-7]{8}-\d{1,9}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const LEASE_ID_RE = /^\d{8}-\d{6}-[a-z2-7]{8}-\d{1,9}$/;
/** the `<t>` of a message file name: epoch milliseconds */
export const MSG_T_RE = /^\d{1,16}$/;
export const ACTOR8_RE = /^[a-z2-7]{8}$/;
/**
 * + review major 8: the id of one CONSUMER PROCESS — `${sessionId ?? 'tui'}-${actor8}`. It names the ack file and the
 * `seen` file, both of which must have exactly one writer: a session can be held by two processes (`jevcode -c` twice on a
 * paused session) and a TUI has no session at all before its first run.
 */
export const CONSUMER_ID_RE = /^(tui|\d{8}-\d{6}-[a-z2-7]{8})-[a-z2-7]{8}$/;
/**
 * §3.2 (design revision 4): `hostKey = sha8(hostname(), userInfo().username, machineId)` — eight hex chars over THREE
 * inputs. The machine identifier is the OS's own (`IOPlatformUUID` on macOS, `/etc/machine-id` on Linux), read once by the
 * CALLER (this module spawns nothing) and kept private.
 */
export const HOST_KEY_RE = /^[0-9a-f]{8}$/;
export const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const BROADCAST_ALL = '@all';
/** review #37: the ONLY shape a `laneDir` may take — the sweep `rm -rf`s what this names, so `.`, `post` and `tmp/../..` must fail */
export const LANE_DIR_RE = /^tmp\/synth\/lane\d{1,3}$/;
export const BRANCH_MAX_CHARS = 200;

/**
 * review #36: a branch name from a peer's record is passed to `git`. `git check-ref-format --branch`'s rules, in code: no
 * leading `-` (git would read it as an option), no `..`, `@{`, `//`, control characters, space, `~ ^ : ? * [ \`, no
 * trailing `.` or `.lock`, ≤ 200 chars.
 */
export function isValidBranch(b: string): boolean {
  if (typeof b !== 'string' || b.length === 0 || b.length > BRANCH_MAX_CHARS) return false;
  if (b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock')) return false;
  if (b.includes('..') || b.includes('@{') || b.includes('//')) return false;
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(b)) return false;
  return b !== '@';
}

/** `'<sessionId>' | '@<repoKey>' | '@all'` (§5.1) */
export function isValidTarget(t: string): boolean {
  if (t === BROADCAST_ALL) return true;
  if (t.startsWith('@')) return REPO_KEY_RE.test(t.slice(1));
  return SESSION_ID_RE.test(t);
}

export const REL_PATH_MAX_CHARS = 512;
export const LEASE_PATHS_MAX = 64;
export const TOUCHED_RECENT_MAX = 96;
/**
 * review #35: the bound every integer field of a record must stay inside (a `stamp.n` of 2^60 poisons a Lamport clock for
 * good). Declared here, beside the other id facts, because `createStampClock` saturates at it and `records.ts` imports
 * this module (never the other way round).
 */
export const COUNTER_MAX = 1_000_000_000;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * §2.1 rule 6 / §11 row 26: a lease or touched path is toplevel-relative, NFC, without `.`/`..` segments, drive letters or
 * control characters; a trailing `/` marks a subtree. Anything else is skipped, never joined into a path.
 */
export function isValidRelPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > REL_PATH_MAX_CHARS) return false;
  if (CONTROL_RE.test(p)) return false;
  if (p !== p.normalize('NFC')) return false;
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) return false;
  const segs = p.split('/');
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s === '' && i === segs.length - 1 && segs.length > 1) continue; // subtree marker
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

// ── minting ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type RandomBytes = (n: number) => Uint8Array;
const defaultRandom: RandomBytes = (n) => randomBytes(n);

/** 8 base32 chars from 40 random bits (the run-id suffix alphabet). */
export function mintBase32(random: RandomBytes = defaultRandom): string {
  return encodeBase32(random(5), 8);
}
export function mintDeviceId(random?: RandomBytes): string {
  return mintBase32(random);
}
/** §5.1: the random base32 id a CLI sender mints per invocation (a run uses its own id's trailing 8 chars). */
export function mintActor8(random?: RandomBytes): string {
  return mintBase32(random);
}
/** The `actor8` of a sender: the run id's trailing 8 chars, or a minted id for a CLI twin. */
export function actor8Of(runId: string | null, random?: RandomBytes): string {
  return runId !== null && RUN_ID_RE.test(runId) ? runId.slice(-8) : mintActor8(random);
}

/**
 * §3.2: `sha8(hostname, user, machineId)`. `machineId` omitted falls back to the two-input form — the caller shows
 * `machine id unavailable — two machines sharing this home would share one device id` once, per the design.
 */
export function hostKeyOf(hostname: string, username: string, machineId?: string | null): string {
  const parts = machineId === undefined || machineId === null || machineId === '' ? [hostname, username] : [hostname, username, machineId];
  return sha256Hex(parts.map((x) => x.trim()).join('\u0000')).slice(0, 8);
}

/** §3.1 (design revision 5): the PER-HOST identity subtree — `coordination/devices/<hostKey>/`. */
export const DEVICES_DIR = 'devices';

/**
 * §3.1 (design revision 5): `coordination/devices/<hostKey>/` — PER-MACHINE LOCAL TRUTH. `device.json`, `machine.json`,
 * `device.key`, `trusted-devices.json`, `ignored-devices.json`, `repokeys/`, `worktrees/` and `claims/` live here and
 * nowhere else, so a `~/.jevcode` that is itself inside a synced folder still has exactly one writer per file: a second
 * machine has a different `hostKey`, therefore a different subtree, therefore it can never rewrite the first machine's
 * `device.json`, the adopt prompt cannot ping-pong and no identity file is ever co-written into a "conflicted copy"
 * (§11 row 3). Never mirrored — `sync-shared-dir.ts` copies the per-DEVICE kinds only.
 */
export function hostRoot(root: string, hostKey: string): string {
  return join(root, DEVICES_DIR, hostKey);
}

// ── keys (§3.2) ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** `'ws:' + sha256(realpath(toplevel ?? workspace))[0:16]` — known at startup with zero spawns. */
export function wsKeyOf(realpathRoot: string): string {
  return `ws:${sha256Hex(realpathRoot).slice(0, 16)}`;
}

/** What the workspace probe learnt about the repository (spawned off the critical path, §3.2). */
export interface RepoFacts {
  /** `git rev-list --max-parents=0 HEAD`; empty when HEAD is unborn */
  rootOids: readonly string[];
  /** `git rev-parse --is-shallow-repository` */
  shallow: boolean;
  /** the `origin` URL, or null */
  originUrl: string | null;
}
export interface RepoKeys {
  repoKey: string | null;
  remoteKey: string | null;
  kind: 'roots' | 'remote' | 'none';
}

/** Scheme, credentials, `.git`, trailing slashes and host case stripped; `git@host:path` → `host/path`. */
export function normaliseOriginUrl(url: string): string {
  let u = url.trim();
  const scp = /^([^@/:]+@)?([^:/]+):(?!\/\/)(.*)$/.exec(u);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `${scp[2]}/${scp[3]}`;
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  u = u.replace(/^[^@/]+@/, '');
  const slash = u.indexOf('/');
  const host = (slash === -1 ? u : u.slice(0, slash)).toLowerCase().replace(/:\d+$/, '');
  let path = slash === -1 ? '' : u.slice(slash);
  path = path.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return `${host}${path}`;
}

/** root commits (`kind:'roots'`), or the normalised origin (`kind:'remote'`) for shallow / unborn clones; both when computable. */
export function repoKeyOf(f: RepoFacts): RepoKeys {
  const roots = [...f.rootOids].filter((o) => OID_RE.test(o)).sort();
  const repoKey = !f.shallow && roots.length > 0 ? sha256Hex(roots.join('\n')).slice(0, 16) : null;
  const remoteKey = f.originUrl !== null && f.originUrl.trim() !== '' ? `rm:${sha256Hex(normaliseOriginUrl(f.originUrl)).slice(0, 16)}` : null;
  return { repoKey, remoteKey, kind: repoKey !== null ? 'roots' : remoteKey !== null ? 'remote' : 'none' };
}

/** §3.2: two repo identities meet when either key matches, or by `wsKey` when neither side has a key. */
export function sameRepo(a: { repoKey: string | null; remoteKey: string | null; wsKey: string }, b: { repoKey: string | null; remoteKey: string | null; wsKey: string }): boolean {
  if (a.repoKey !== null && a.repoKey === b.repoKey) return true;
  if (a.remoteKey !== null && a.remoteKey === b.remoteKey) return true;
  const aNone = a.repoKey === null && a.remoteKey === null;
  const bNone = b.repoKey === null && b.remoteKey === null;
  return (aNone || bNone) && a.wsKey === b.wsKey;
}

// ── repoKey cache (`coordination/repokeys/<sha16(realpath ws)>.json`, §3.2) ───────────────────────────────────────────

export interface RepoKeyCacheEntry {
  v: 1;
  repoKey: string | null;
  remoteKey: string | null;
  kind: 'roots' | 'remote' | 'none';
  commonDir60: string;
  at: string;
}

export function repoKeyCachePath(hostDir: string, wsRealpath: string): string {
  return join(hostDir, 'repokeys', `${sha256Hex(wsRealpath).slice(0, 16)}.json`);
}

const CACHE_MAX_BYTES = 4096;

/** null on a missing, malformed or regex-failing entry — the caller recomputes. */
export async function readRepoKeyCache(fs: CoordFs, hostDir: string, wsRealpath: string): Promise<RepoKeyCacheEntry | null> {
  let text: string;
  try {
    const r = await fs.readBounded(repoKeyCachePath(hostDir, wsRealpath), CACHE_MAX_BYTES);
    if (r.overflow) return null;
    text = r.text;
  } catch {
    return null;
  }
  const parsed = parseJson(text);
  if (!parsed.ok || !isJsonObject(parsed.value)) return null;
  const o = parsed.value;
  const repoKey = o['repoKey'];
  const remoteKey = o['remoteKey'];
  const kind = o['kind'];
  if (o['v'] !== 1) return null;
  if (!(repoKey === null || (typeof repoKey === 'string' && REPO_KEY_RE.test(repoKey)))) return null;
  if (!(remoteKey === null || remoteKey === undefined || (typeof remoteKey === 'string' && REPO_KEY_RE.test(remoteKey)))) return null;
  if (kind !== 'roots' && kind !== 'remote' && kind !== 'none') return null;
  if (typeof o['commonDir60'] !== 'string' || typeof o['at'] !== 'string') return null;
  return { v: 1, repoKey: repoKey as string | null, remoteKey: (remoteKey ?? null) as string | null, kind, commonDir60: o['commonDir60'], at: o['at'] };
}

export async function writeRepoKeyCache(fs: CoordFs, hostDir: string, wsRealpath: string, entry: Omit<RepoKeyCacheEntry, 'v'>): Promise<void> {
  const path = repoKeyCachePath(hostDir, wsRealpath);
  await fs.mkdir(join(hostDir, 'repokeys'), DIR_MODE);
  const rec: RepoKeyCacheEntry = { v: 1, ...entry, commonDir60: entry.commonDir60.slice(0, 60) };
  await fs.writeAtomic(path, `${JSON.stringify(rec)}\n`, { fsync: false, mode: FILE_MODE });
}

// ── labels ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const LABEL_MAX_CHARS = 24;

/** `label#<id4>` wherever another device in view shares the label (§3.2; §11 row 42). */
export function labelFor(deviceId: string, label: string, devices: Iterable<{ deviceId: string; label: string }>): string {
  for (const d of devices) if (d.deviceId !== deviceId && d.label === label) return `${label}#${deviceId.slice(0, 4)}`;
  return label;
}

// ── stamps (§3.2) ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface StampClock {
  readonly deviceId: string;
  readonly runId: string;
  /** the last value issued or adopted */
  current(): Stamp;
  /** `n + 1`, returned; strictly greater than everything observed */
  issue(): Stamp;
  /** `n = max(n, observed)`: the next issue exceeds the observation */
  observe(observed: Stamp | number): void;
}

/**
 * The per-run Lamport counter: `n` starts at the largest stamp the fold holds (own subtree included, gone records included)
 * and every issue is `max(n, observed) + 1`. Nothing is persisted but the records that carry it, so a crash cannot re-issue
 * a lower stamp: a new run's first stamp exceeds everything it can see. `runId` is the tiebreak among equal `n`.
 */
export function createStampClock(deviceId: string, runId: string, seed = 0): StampClock {
  let n = Number.isFinite(seed) && seed > 0 ? Math.min(COUNTER_MAX, Math.floor(seed)) : 0;
  return {
    deviceId,
    runId,
    current: () => ({ n, deviceId, runId }),
    // + review major 16 (rollover): the counter SATURATES at `COUNTER_MAX` — it never wraps and never leaves the range
    // `isCount` accepts, so a saturated clock still writes parseable records. At the cap the Lamport order degenerates to
    // the `(deviceId, runId)` tiebreak, which is total, and a run that reaches 1e9 stamps mints a new runId on its next
    // resume (the clock is per RUN, seeded from the fold) and starts again below the cap.
    issue: () => {
      if (n < COUNTER_MAX) n += 1;
      return { n, deviceId, runId };
    },
    observe: (observed) => {
      const m = typeof observed === 'number' ? observed : observed.n;
      if (Number.isFinite(m) && m > n) n = Math.min(COUNTER_MAX, Math.floor(m));
    },
  };
}

// ── case sensitivity probe (§3.2, §11 row 23) ─────────────────────────────────────────────────────────────────────────

function swapCase(s: string): string {
  let out = '';
  for (const ch of s) {
    const up = ch.toUpperCase();
    out += up !== ch ? up : ch.toLowerCase();
  }
  return out;
}

/**
 * Per workspace volume, without writing: `stat()` of a case-swapped spelling of an existing entry (`.GIT` for `.git`, else
 * the root's own last component) succeeds only on a case-insensitive volume. `exists` is the injected probe.
 */
export function probeCaseInsensitive(root: string, exists: (path: string) => boolean): boolean {
  const gitDir = join(root, '.git');
  if (exists(gitDir)) {
    const swapped = join(root, swapCase('.git'));
    return swapped !== gitDir && exists(swapped);
  }
  const parts = root.split('/');
  const last = parts.pop() ?? '';
  const swappedLast = swapCase(last);
  if (swappedLast === last || last === '') return false;
  return exists([...parts, swappedLast].join('/'));
}

// ── device identity (`coordination/device.json`, §3.2) ────────────────────────────────────────────────────────────────

export type DeviceIdentityStatus = 'loaded' | 'created' | 'readopted' | 'foreign';
export interface DeviceIdentityResult {
  status: DeviceIdentityStatus;
  /** for `'foreign'`: the record on disk that names another host + user (the CLI asks before adopting) */
  device: DeviceRecord;
  path: string;
  /** §3.1 (revision 5): the per-host subtree this identity was read from / written to */
  hostKey: string;
  /** §3.2 clone adoption: the `deviceId` this machine walked away from */
  adoptedFrom?: string;
  /** §3.2 / §10.3: a cloned `deviceKey` speaks for two machines, so an adoption always mints a fresh one */
  newKey?: boolean;
  /** §3.2: `device.json` did not read back our own id (a shared, synced home) — the new id holds for THIS PROCESS only */
  processOnly?: boolean;
}

export interface DeviceIdentityOptions {
  root: string;
  fs: CoordFs;
  hostname: string;
  username: string;
  jevcode: string;
  nowIso: string;
  label?: string;
  syncMode?: DeviceRecord['syncMode'];
  random?: RandomBytes;
  /**
   * + re-review (6): `machineIdOf(<platform uuid>)` — `IOPlatformUUID` (macOS `ioreg`), `/etc/machine-id` (Linux) or the
   * host's equivalent, probed by the CALLER (this module spawns nothing). Cached in the PRIVATE `coordination/machine.json`
   * at device creation, never in the published `device.json`. Omitted, the identity is machine-agnostic as before.
   */
  machineId?: string;
  /** §3.1 (revision 5): the per-host subtree; derived from `hostname + username + machineId` when the caller has none */
  hostKey?: string;
}

const DEVICE_MAX_BYTES = 2048;

/** Parse `device.json` text; null when malformed (a bad identity file is recreated, never trusted). */
export function parseDeviceRecord(text: string): DeviceRecord | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isJsonObject(parsed.value)) return null;
  const o = parsed.value;
  if (o['v'] !== 1) return null;
  const deviceId = o['deviceId'];
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) return null;
  for (const k of ['label', 'host', 'user', 'jevcode', 'createdAt'] as const) if (typeof o[k] !== 'string') return null;
  const syncMode = o['syncMode'];
  if (syncMode !== 'off' && syncMode !== 'shared-dir' && syncMode !== 'git') return null;
  const rec: DeviceRecord = {
    v: 1,
    deviceId,
    label: o['label'] as string,
    host: o['host'] as string,
    user: o['user'] as string,
    jevcode: o['jevcode'] as string,
    createdAt: o['createdAt'] as string,
    syncMode,
    checksum: typeof o['checksum'] === 'string' ? o['checksum'] : '',
  };
  if (rec.checksum !== checksumOf(rec)) return null;
  return rec;
}

export function buildDeviceRecord(o: { deviceId: string; label: string; host: string; user: string; jevcode: string; createdAt: string; syncMode: DeviceRecord['syncMode'] }): DeviceRecord {
  return withChecksum({ v: 1 as const, ...o, label: o.label.slice(0, LABEL_MAX_CHARS) });
}

async function readDeviceFile(fs: CoordFs, path: string): Promise<DeviceRecord | null> {
  try {
    const r = await fs.readBounded(path, DEVICE_MAX_BYTES);
    return r.overflow ? null : parseDeviceRecord(r.text);
  } catch {
    return null;
  }
}

/**
 * + re-review (6): the PRIVATE machine record. `device.json` is the published public subset (both copies are readable by
 * every device that shares the folder), so the machine id lives in its own 0600 file beside `device.key` and is never
 * mirrored. `bootId` is the caller's boot identifier when it has one (the `run.lock` rule, decision (a)).
 */
export const MACHINE_FILE = 'machine.json';
export interface MachineRecord {
  v: 1;
  /** the OS machine identifier this device's `hostKey` was derived from — stored so a CHANGE is detected (§3.2) */
  machineId: string;
  /** the derived `hostKey`, so a reader does not have to re-hash to compare */
  hostKey?: string;
  /** the OS boot identity, when the caller resolved one (decision (a)) */
  bootId?: string;
}

export async function readMachineRecord(fs: CoordFs, hostDir: string): Promise<MachineRecord | null> {
  try {
    const r = await fs.readBounded(join(hostDir, MACHINE_FILE), 512);
    if (r.overflow) return null;
    const parsed = parseJson(r.text);
    if (!parsed.ok || !isJsonObject(parsed.value) || parsed.value['v'] !== 1) return null;
    const id = parsed.value['machineId'];
    if (typeof id !== 'string' || id === '') return null;
    const bootId = parsed.value['bootId'];
    const hostKey = parsed.value['hostKey'];
    return { v: 1, machineId: id, ...(typeof hostKey === 'string' && HOST_KEY_RE.test(hostKey) ? { hostKey } : {}), ...(typeof bootId === 'string' ? { bootId } : {}) };
  } catch {
    return null;
  }
}

export async function writeMachineRecord(fs: CoordFs, hostDir: string, rec: Omit<MachineRecord, 'v'>): Promise<void> {
  if (rec.machineId.trim() === '') throw new ConfigError('coordination: a machine id cannot be empty', { setting: 'coordination' });
  await fs.mkdir(hostDir, DIR_MODE);
  await fs.writeAtomic(join(hostDir, MACHINE_FILE), `${JSON.stringify({ v: 1, ...rec })}\n`, { fsync: true, mode: FILE_MODE });
}

/**
 * Write `devices/<hostKey>/device.json` (§3.1, revision 5: PER HOST, never mirrored) and its PUBLIC copy
 * `registry/<deviceId>/device.json` (one writer: the CLI).
 */
export async function writeDeviceRecord(fs: CoordFs, root: string, hostKey: string, rec: DeviceRecord): Promise<void> {
  const text = `${JSON.stringify(rec)}\n`;
  const hostDir = hostRoot(root, hostKey);
  await fs.mkdir(hostDir, DIR_MODE);
  await fs.writeAtomic(join(hostDir, 'device.json'), text, { fsync: true, mode: FILE_MODE });
  const reg = join(root, 'registry', rec.deviceId);
  await fs.mkdir(reg, DIR_MODE);
  await fs.writeAtomic(join(reg, 'device.json'), text, { fsync: true, mode: FILE_MODE });
}

/**
 * §3.2 `deviceId`: load `devices/<hostKey>/device.json`; missing → re-adopt a registry subtree whose device.json names
 * this host + user (a restored `~/.jevcode`), else mint one; present but naming another host + user (a wholesale copy to
 * a new Mac, §11 row 27) → `'foreign'` so the CLI can ask `adopt as a new device? [y]` and call `adoptNewDevice`.
 *
 * §3.1 (revision 5): the file is PER HOST, so the two common cases need no prompt at all — a restored `~/.jevcode` on
 * the same host finds its own `hostKey` and re-adopts its id, and a home shared live by two machines simply has two
 * `devices/` entries.
 */
export async function deviceIdentity(o: DeviceIdentityOptions): Promise<DeviceIdentityResult> {
  const hostKey = o.hostKey ?? hostKeyOf(o.hostname, o.username, o.machineId);
  const hostDir = hostRoot(o.root, hostKey);
  const path = join(hostDir, 'device.json');
  const existing = await readDeviceFile(o.fs, path);
  const machine = await readMachineRecord(o.fs, hostDir);
  if (existing !== null) {
    // + re-review (6)(i): `host + user` collides on two default-named Macs and on cloned VMs sharing one `~/.jevcode`;
    // the cached machine id is what makes `kind:'foreign'` reachable in exactly that case, so the CLI can ask to adopt.
    const sameMachine = o.machineId === undefined || machine === null || machine.machineId === o.machineId;
    if (existing.host === o.hostname && existing.user === o.username && sameMachine) {
      if (o.machineId !== undefined && machine === null) await writeMachineRecord(o.fs, hostDir, { machineId: o.machineId, hostKey });
      return { status: 'loaded', device: existing, path, hostKey };
    }
    return { status: 'foreign', device: existing, path, hostKey };
  }
  let subtrees: string[] = [];
  try {
    subtrees = await o.fs.readdir(join(o.root, 'registry'));
  } catch (e) {
    if (errnoCode(e) !== 'ENOENT' && errnoCode(e) !== 'ENOTDIR') throw e;
  }
  for (const id of subtrees.filter((s) => DEVICE_ID_RE.test(s)).sort()) {
    const rec = await readDeviceFile(o.fs, join(o.root, 'registry', id, 'device.json'));
    if (rec !== null && rec.host === o.hostname && rec.user === o.username) {
      await writeDeviceRecord(o.fs, o.root, hostKey, rec);
      if (o.machineId !== undefined) await writeMachineRecord(o.fs, hostDir, { machineId: o.machineId, hostKey });
      return { status: 'readopted', device: rec, path, hostKey };
    }
  }
  return adoptNewDevice(o);
}

/**
 * Mint a fresh device id and write both device.json files; the previous subtree (if any) is left read-only.
 *
 * §3.2 (design revision 5) — the CLONE path. `adoptFrom` names the `deviceId` this machine is walking away from because
 * the fold showed two live beats under it with different `bootId`s. Two things then follow, and both are normative:
 *  (a) a NEW `deviceKey` / `keyId` is minted with the id, because a cloned key is held by two machines and can no longer
 *      speak for either (§10.3) — `newKey: true` says so, and the caller writes it with `writeCommonsKey`;
 *  (b) `device.json` is the one genuinely co-written file, so it is READ BACK after the rename. When it does not read
 *      back our own new `deviceId` (a shared, synced home where the other clone rewrote it) we retry once and then keep
 *      the new id FOR THIS PROCESS ONLY, recording the split in `devices/<hostKey>/adopted/<deviceId>.json`.
 * No prompt is involved: two engines co-writing one `state.json` is data loss, a second device subtree is a directory.
 */
export async function adoptNewDevice(o: DeviceIdentityOptions & { adoptFrom?: string; bootId?: string | null }): Promise<DeviceIdentityResult> {
  const hostKey = o.hostKey ?? hostKeyOf(o.hostname, o.username, o.machineId);
  const hostDir = hostRoot(o.root, hostKey);
  const rec = buildDeviceRecord({
    deviceId: mintDeviceId(o.random),
    label: o.label ?? o.hostname,
    host: o.hostname,
    user: o.username,
    jevcode: o.jevcode,
    createdAt: o.nowIso,
    syncMode: o.syncMode ?? 'off',
  });
  await writeDeviceRecord(o.fs, o.root, hostKey, rec);
  if (o.machineId !== undefined) await writeMachineRecord(o.fs, hostDir, { machineId: o.machineId, hostKey, ...(typeof o.bootId === 'string' ? { bootId: o.bootId } : {}) });
  let processOnly = false;
  if (o.adoptFrom !== undefined) {
    // (b): one read-back, one retry, then this process keeps the id alone and the split is recorded.
    let back = await readDeviceFile(o.fs, join(hostDir, 'device.json'));
    if (back === null || back.deviceId !== rec.deviceId) {
      await writeDeviceRecord(o.fs, o.root, hostKey, rec);
      back = await readDeviceFile(o.fs, join(hostDir, 'device.json'));
    }
    processOnly = back === null || back.deviceId !== rec.deviceId;
    if (processOnly) {
      const dir = join(hostDir, 'adopted');
      await o.fs.mkdir(dir, DIR_MODE);
      const split = { v: 1, deviceId: rec.deviceId, adoptedFrom: o.adoptFrom, bootId: o.bootId ?? null, machineId: o.machineId ?? null, at: o.nowIso };
      await o.fs.writeAtomic(join(dir, `${rec.deviceId}.json`), `${JSON.stringify(split)}\n`, { fsync: true, mode: FILE_MODE });
    }
  }
  return {
    status: 'created',
    device: rec,
    path: join(hostDir, 'device.json'),
    hostKey,
    ...(o.adoptFrom !== undefined ? { adoptedFrom: o.adoptFrom, newKey: true, processOnly } : {}),
  };
}

// ── trusted / ignored devices (§10.3, §4.6 row 4) ──────────────────────────────────────────────────────────────────────

/**
 * §10.3 pairing. `keyHex` is the 32-byte `commonsKey` shared with that device; it verifies the `hmac` of every record read
 * from its subtree. The file is `coordination/trusted-devices.json` — NOT `~/.jevcode/trust.json`, which is the TUI's
 * unrelated workspace-trust gate (`src/config/trust.ts`) — and is never mirrored (review #42).
 */
export interface TrustedDevice {
  deviceId: string;
  label: string;
  pairedAt: string;
  /**
   * §10.3 (design revision 4): `trusted-devices.json` gains `key` — THIS peer's 32-byte verification key, per device,
   * not one group key shared by everyone paired. Written as `key`; the older `keyHex` spelling is still read so a
   * file written before the rename keeps working.
   */
  keyHex?: string;
}
export interface IgnoredDevice {
  deviceId: string;
  label: string;
  at: string;
}

const LIST_MAX_BYTES = 65_536;

async function readDeviceList<T extends { deviceId: string }>(fs: CoordFs, path: string, pick: (o: Record<string, unknown>) => T | null): Promise<T[]> {
  let text: string;
  try {
    const r = await fs.readBounded(path, LIST_MAX_BYTES);
    if (r.overflow) return [];
    text = r.text;
  } catch {
    return [];
  }
  const parsed = parseJson(text);
  if (!parsed.ok || !isJsonObject(parsed.value) || parsed.value['v'] !== 1 || !Array.isArray(parsed.value['devices'])) return [];
  const out: T[] = [];
  for (const d of parsed.value['devices']) {
    if (!isJsonObject(d)) continue;
    const t = pick(d);
    if (t !== null && DEVICE_ID_RE.test(t.deviceId)) out.push(t);
  }
  return out;
}

export const TRUSTED_FILE = 'trusted-devices.json';

export function readTrusted(fs: CoordFs, hostDir: string): Promise<TrustedDevice[]> {
  return readDeviceList(fs, join(hostDir, TRUSTED_FILE), (o) => {
    if (typeof o['deviceId'] !== 'string' || typeof o['label'] !== 'string' || typeof o['pairedAt'] !== 'string') return null;
    const key = typeof o['key'] === 'string' ? o['key'] : o['keyHex'];
    return { deviceId: o['deviceId'], label: o['label'], pairedAt: o['pairedAt'], ...(typeof key === 'string' && COMMONS_KEY_RE.test(key) ? { keyHex: key } : {}) };
  });
}

/** The verification key per paired device — what the fold hands `hmacValid` for a foreign record (§10.3). */
export async function readTrustKeys(fs: CoordFs, hostDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const d of await readTrusted(fs, hostDir)) if (d.keyHex !== undefined) out.set(d.deviceId, d.keyHex);
  return out;
}

export function readIgnoredDevices(fs: CoordFs, hostDir: string): Promise<IgnoredDevice[]> {
  return readDeviceList(fs, join(hostDir, 'ignored-devices.json'), (o) =>
    typeof o['deviceId'] === 'string' && typeof o['label'] === 'string' && typeof o['at'] === 'string' ? { deviceId: o['deviceId'], label: o['label'], at: o['at'] } : null,
  );
}

/** §4.6 row 4: a local tombstone — the fold skips the subtree; nothing foreign is ever deleted. */
export async function ignoreDevice(fs: CoordFs, hostDir: string, entry: IgnoredDevice): Promise<IgnoredDevice[]> {
  const list = (await readIgnoredDevices(fs, hostDir)).filter((d) => d.deviceId !== entry.deviceId);
  list.push({ ...entry, label: entry.label.slice(0, LABEL_MAX_CHARS) });
  await fs.mkdir(hostDir, DIR_MODE);
  await fs.writeAtomic(join(hostDir, 'ignored-devices.json'), `${JSON.stringify({ v: 1, devices: list })}\n`, { fsync: true, mode: FILE_MODE });
  return list;
}

/** + review minor 25: lift a local tombstone — the subtree folds again from the next scan. */
export async function unignoreDevice(fs: CoordFs, hostDir: string, deviceId: string): Promise<IgnoredDevice[]> {
  const list = (await readIgnoredDevices(fs, hostDir)).filter((d) => d.deviceId !== deviceId);
  await fs.mkdir(hostDir, DIR_MODE);
  await fs.writeAtomic(join(hostDir, 'ignored-devices.json'), `${JSON.stringify({ v: 1, devices: list })}\n`, { fsync: true, mode: FILE_MODE });
  return list;
}

export async function writeTrusted(fs: CoordFs, hostDir: string, devices: TrustedDevice[]): Promise<void> {
  await fs.mkdir(hostDir, DIR_MODE);
  // §10.3: written under BOTH spellings for one release, so a downgrade does not silently unpair every device
  const rows = devices.map((d) => (d.keyHex === undefined ? d : { ...d, key: d.keyHex }));
  await fs.writeAtomic(join(hostDir, TRUSTED_FILE), `${JSON.stringify({ v: 1, devices: rows })}\n`, { fsync: true, mode: FILE_MODE });
}

/** §10.3: pair a device — one upsert by id; the key never leaves this file. */
export async function trustDevice(fs: CoordFs, hostDir: string, entry: TrustedDevice): Promise<TrustedDevice[]> {
  const list = (await readTrusted(fs, hostDir)).filter((d) => d.deviceId !== entry.deviceId);
  list.push({ ...entry, label: entry.label.slice(0, LABEL_MAX_CHARS) });
  list.sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
  await writeTrusted(fs, hostDir, list);
  return list;
}

// ── the commons key (§10.3; NEVER a member of a published record) ─────────────────────────────────────────────────────

export const DEVICE_KEY_FILE = 'device.key';

/**
 * The 32-byte key this device signs its records with. It lives in its OWN file so that both `device.json` files — the local
 * one and the published `registry/<deviceId>/device.json` copy — stay the public subset the review asked for (#42: the
 * registry copy would otherwise mirror the W5 `commonsKey` into the shared folder).
 */
export function mintCommonsKey(random: RandomBytes = defaultRandom): string {
  return Buffer.from(random(COMMONS_KEY_BYTES)).toString('hex');
}

export async function readCommonsKey(fs: CoordFs, hostDir: string): Promise<string | null> {
  try {
    const r = await fs.readBounded(join(hostDir, DEVICE_KEY_FILE), 256);
    if (r.overflow) return null;
    const parsed = parseJson(r.text);
    if (!parsed.ok || !isJsonObject(parsed.value) || parsed.value['v'] !== 1) return null;
    const key = parsed.value['keyHex'];
    return typeof key === 'string' && COMMONS_KEY_RE.test(key) ? key : null;
  } catch {
    return null;
  }
}

export async function writeCommonsKey(fs: CoordFs, hostDir: string, keyHex: string): Promise<void> {
  if (!COMMONS_KEY_RE.test(keyHex)) throw new ConfigError('coordination: a commons key is 64 hex characters', { setting: 'coordination' });
  await fs.mkdir(hostDir, DIR_MODE);
  await fs.writeAtomic(join(hostDir, DEVICE_KEY_FILE), `${JSON.stringify({ v: 1, keyHex })}\n`, { fsync: true, mode: FILE_MODE });
}
