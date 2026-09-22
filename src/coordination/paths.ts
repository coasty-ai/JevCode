/**
 * The store layout (§3.1 / §12.0.4, decided): `~/.jevcode/coordination/` = `join(jevcodeDir(), 'coordination')`, kind-first,
 * one per-device subtree per kind — each device writes only under `<kind>/<deviceId>/`. The ledger keeps the design's
 * internal name **commons** for the whole; the shared-dir mirror is `<sharedDir>/jevcode-commons/` with the same layout.
 * File names are parsed with the §3.1 regexes and anything else is skipped and counted, never joined into a path.
 */
import { join } from 'node:path';
import { hostRoot } from './ids.js';
export { DEVICES_DIR, hostRoot } from './ids.js';
import { CONSUMER_ID_RE, DEVICE_ID_RE, LEASE_ID_RE, MSG_ID_RE, MSG_T_RE, RUN_ID_RE, SEQ_RE, SLUG_RE, isValidTarget } from './ids.js';

// ── key ⇄ directory component (+ review major 13) ─────────────────────────────────────────────────────────────────────
//
// A repoKey is `ws:<16 hex>` / `rm:<16 hex>` / `<16 hex>` and a broadcast target is `@<repoKey>`. The colon form stays
// INSIDE records (it is the identity §3.2 defines), but it may never reach a path component: Windows and every
// Windows-backed share reserve `:` for a drive/ADS, iCloud Drive and Dropbox rewrite or refuse it, and a macOS Finder
// alias renders it as `/`. Directory components therefore use `ws-` / `rm-`, which round-trips exactly.

const KEY_SCHEME_RE = /^(ws|rm):/;
const KEY_PREFIX_RE = /^(ws|rm)-/;
/** §3.1 (design revision 4): the `<keyDir>` lease component — the colon-free spelling of a `repoKey` / `wsKey`. */
export const KEY_DIR_RE = /^(ws-|rm-)?[0-9a-f]{16}$/;

/** §3.1 `keyDir(repoKey ?? wsKey)`: `ws:3f9a…` → `ws-3f9a…`; a bare 16-hex roots key is unchanged. */
export function keyDir(key: string): string {
  return key.replace(KEY_SCHEME_RE, '$1-');
}
/** the inverse of `keyDir` — `ws-3f9a…` → `ws:3f9a…`. */
export function keyOfDir(name: string): string {
  return name.replace(KEY_PREFIX_RE, '$1:');
}
/** the pre-revision-4 names */
export const encodeKeyComponent = keyDir;
export const decodeKeyComponent = keyOfDir;
/** `@ws:3f9a…` → `@ws-3f9a…`; a session-id target is unchanged. */
export function encodeTargetComponent(target: string): string {
  return target.startsWith('@') ? `@${keyDir(target.slice(1))}` : target;
}
export function decodeTargetComponent(name: string): string {
  return name.startsWith('@') ? `@${keyOfDir(name.slice(1))}` : name;
}

/** `leases/<deviceId>/<repoKey-dir>/<leaseId>.json`, relative to the device subtree (the ledger's `writeOwn` rel). */
export function leaseRel(repoKey: string, leaseId: string): string {
  return join(keyDir(repoKey), `${leaseId}.json`);
}
/** `inbox/<deviceId>/<target-dir>/<t>-<seq>.json`, relative to the device subtree. */
export function messageRel(target: string, tMs: number, seq: number): string {
  return join(encodeTargetComponent(target), `${tMs}-${seq}.json`);
}
/** `acks/<deviceId>/<msgId>/<consumerId>.json`, relative to the device subtree. */
export function ackRel(msgId: string, consumerId: string): string {
  return join(msgId, `${consumerId}.json`);
}

export const COORDINATION_DIR = 'coordination';
export const MIRROR_DIR = 'jevcode-commons';
export const DEVICE_FILE = 'device.json';
/** ~/.jevcode/worktrees/<repoKey>/<slug>/ — session worktrees, outside the checkout and every sandbox root (§6.5) */
export const WORKTREES_DIR = 'worktrees';
/** §9.3 (design revision 5): the one fixed name inside a run's mirror dir; never parsed as anything but `kind:'claims'`. */
export const CLAIMS_FILE = 'claims.json';

export function coordinationRoot(home: string): string {
  return join(home, COORDINATION_DIR);
}

/** `~/.jevcode/worktrees/<keyDir>/<slug>` — the session worktree itself (§6.5); a sibling of `coordination/`, not inside it. */
export function sessionWorktreeDir(home: string, repoKey: string, slug: string): string {
  return join(home, WORKTREES_DIR, keyDir(repoKey), slug);
}

/**
 * §3.1 / §9.3 (design revision 4): `devices/<hostKey>/claims/<runId>.json` — the takeover claim this device minted for a
 * run it has no local dir for, so the NEXT mint on this device reads it instead of re-issuing the same epoch. Local
 * truth: never mirrored, never published.
 */
export function deviceClaimsDir(root: string, hostKey: string): string {
  return join(hostRoot(root, hostKey), 'claims');
}
export function deviceClaimFile(root: string, hostKey: string, runId: string): string {
  return join(deviceClaimsDir(root, hostKey), `${runId}.json`);
}
export function mirrorRoot(sharedDir: string): string {
  return join(sharedDir, MIRROR_DIR);
}

/** The five per-device kinds (`sessions sync disable` removes exactly these from the mirror). */
export const COMMONS_KINDS = ['registry', 'leases', 'inbox', 'acks', 'runs'] as const;
export type CommonsKind = (typeof COMMONS_KINDS)[number];
/** The kinds the fold reads (`runs/` is the §9.3 essential-set mirror, read by the importer only). */
export const FOLD_KINDS = ['registry', 'leases', 'inbox', 'acks'] as const;

export interface Commons {
  readonly root: string;
  /**
   * §3.1 (revision 5): `devices/<hostKey>/` — every file below it is per-HOST local truth and is never mirrored. Empty
   * when the caller could not name a `hostKey` at all; `commonsPaths` then falls back to the root so a mirror-only
   * `Commons` (which has no identity files) still builds.
   */
  readonly hostDir: string;
  deviceFile: string;
  /** the 0600 commons key — its own file so both `device.json` copies stay the public subset (§10.3, review #42) */
  deviceKeyFile: string;
  repokeysDir: string;
  /** `trusted-devices.json` — NOT `~/.jevcode/trust.json`, which is the TUI's workspace-trust gate */
  trustedFile: string;
  ignoredFile: string;
  /** `inbox/seen/<deviceId>/` — under the inbox kind, not a sibling of it ('seen' can never be read as a deviceId) */
  seenDir(deviceId: string): string;
  worktreesDir: string;
  kindRoot(kind: CommonsKind): string;
  deviceDir(kind: CommonsKind, deviceId: string): string;
  deviceRecordFile(deviceId: string): string;
  heartbeatFile(deviceId: string, runId: string): string;
  /** the repoKey is encoded for the path (`ws:` → `ws-`, review major 13); the record keeps the colon form */
  leaseDir(deviceId: string, repoKey: string): string;
  leaseFile(deviceId: string, repoKey: string, leaseId: string): string;
  outboxDir(deviceId: string, target: string): string;
  messageFile(deviceId: string, target: string, tMs: number, seq: number): string;
  ackDir(deviceId: string, msgId: string): string;
  /** `acks/<deviceId>/<msgId>/<consumerId>.json` — the CONSUMER PROCESS, not the session (review major 8) */
  ackFile(deviceId: string, msgId: string, consumerId: string): string;
  runsDir(deviceId: string, runId: string): string;
  /** §9.3 (revision 5): `runs/<deviceId>/<runId>/claims.json` — the authenticated `kind:'claims'` projection */
  claimsFile(deviceId: string, runId: string): string;
  /** `inbox/seen/<deviceId>/<consumerId>.json` — the message dedupe set of one CONSUMER process (§5.1, review #13) */
  seenFile(deviceId: string, consumerId: string): string;
  worktreeFile(repoKey: string, slug: string): string;
}

/**
 * Path builders over a root (the local store or a mirror root). Components are the caller's validated ids.
 * `hostKey` names the §3.1 per-host identity subtree; a mirror root has no identity files, so it may be omitted.
 */
export function commonsPaths(root: string, hostKey?: string): Commons {
  const kindRoot = (kind: CommonsKind): string => join(root, kind);
  const deviceDir = (kind: CommonsKind, deviceId: string): string => join(root, kind, deviceId);
  const hostDir = hostKey === undefined ? root : hostRoot(root, hostKey);
  return {
    root,
    hostDir,
    deviceFile: join(hostDir, DEVICE_FILE),
    deviceKeyFile: join(hostDir, 'device.key'),
    repokeysDir: join(hostDir, 'repokeys'),
    trustedFile: join(hostDir, 'trusted-devices.json'),
    ignoredFile: join(hostDir, 'ignored-devices.json'),
    seenDir: (deviceId) => join(root, 'inbox', 'seen', deviceId),
    worktreesDir: join(hostDir, WORKTREES_DIR),
    kindRoot,
    deviceDir,
    deviceRecordFile: (deviceId) => join(deviceDir('registry', deviceId), DEVICE_FILE),
    heartbeatFile: (deviceId, runId) => join(deviceDir('registry', deviceId), `${runId}.json`),
    leaseDir: (deviceId, repoKey) => join(deviceDir('leases', deviceId), keyDir(repoKey)),
    leaseFile: (deviceId, repoKey, leaseId) => join(deviceDir('leases', deviceId), leaseRel(repoKey, leaseId)),
    outboxDir: (deviceId, target) => join(deviceDir('inbox', deviceId), encodeTargetComponent(target)),
    messageFile: (deviceId, target, tMs, seq) => join(deviceDir('inbox', deviceId), messageRel(target, tMs, seq)),
    ackDir: (deviceId, msgId) => join(deviceDir('acks', deviceId), msgId),
    ackFile: (deviceId, msgId, consumerId) => join(deviceDir('acks', deviceId), ackRel(msgId, consumerId)),
    runsDir: (deviceId, runId) => join(deviceDir('runs', deviceId), runId),
    claimsFile: (deviceId, runId) => join(deviceDir('runs', deviceId), runId, CLAIMS_FILE),
    seenFile: (deviceId, consumerId) => join(root, 'inbox', 'seen', deviceId, `${consumerId}.json`),
    worktreeFile: (repoKey, slug) => join(hostDir, WORKTREES_DIR, keyDir(repoKey), `${slug}.json`),
  };
}

// ── file-name parsers (§3.1: validated exactly like run ids; anything else is skipped and counted) ────────────────────

const JSON_EXT = /\.json$/;

export function isDeviceIdDir(name: string): boolean {
  return DEVICE_ID_RE.test(name);
}
export function isRepoKeyDir(name: string): boolean {
  return KEY_DIR_RE.test(name);
}
export function isTargetDir(name: string): boolean {
  return isValidTarget(decodeTargetComponent(name));
}
export function isMsgIdDir(name: string): boolean {
  return MSG_ID_RE.test(name);
}
export function isSlugName(name: string): boolean {
  return SLUG_RE.test(name);
}

/** `<runId>.json` → runId (never `device.json`, the one fixed name in a registry subtree) */
export function parseHeartbeatName(name: string): string | null {
  if (!JSON_EXT.test(name)) return null;
  const id = name.replace(JSON_EXT, '');
  return RUN_ID_RE.test(id) ? id : null;
}
/** `<runId>-<seq>.json` → leaseId */
export function parseLeaseName(name: string): string | null {
  if (!JSON_EXT.test(name)) return null;
  const id = name.replace(JSON_EXT, '');
  return LEASE_ID_RE.test(id) ? id : null;
}
/** `<t>-<seq>.json` → { t, seq } */
export function parseMessageName(name: string): { t: number; seq: number } | null {
  if (!JSON_EXT.test(name)) return null;
  const stem = name.replace(JSON_EXT, '');
  const dash = stem.indexOf('-');
  if (dash === -1) return null;
  const t = stem.slice(0, dash);
  const seq = stem.slice(dash + 1);
  if (!MSG_T_RE.test(t) || !SEQ_RE.test(seq)) return null;
  return { t: Number(t), seq: Number(seq) };
}
/**
 * `<consumerId>.json` → consumerId (review major 8: `${sessionId ?? 'tui'}-${actor8}`, not a bare session id).
 * The legacy bare-run-id form is still accepted so an ack written by an older build is not silently skipped.
 */
export function parseAckName(name: string): string | null {
  if (!JSON_EXT.test(name)) return null;
  const id = name.replace(JSON_EXT, '');
  return CONSUMER_ID_RE.test(id) || RUN_ID_RE.test(id) ? id : null;
}
