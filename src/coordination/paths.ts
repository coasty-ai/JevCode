/**
 * The store layout (§3.1 / §12.0.4, decided): `~/.jevcode/coordination/` = `join(jevcodeDir(), 'coordination')`, kind-first,
 * one per-device subtree per kind — each device writes only under `<kind>/<deviceId>/`. The ledger keeps the design's
 * internal name **commons** for the whole; the shared-dir mirror is `<sharedDir>/jevcode-commons/` with the same layout.
 * File names are parsed with the §3.1 regexes and anything else is skipped and counted, never joined into a path.
 */
import { join } from 'node:path';
import { DEVICE_ID_RE, LEASE_ID_RE, MSG_ID_RE, MSG_T_RE, REPO_KEY_RE, RUN_ID_RE, SEQ_RE, SLUG_RE, isValidTarget } from './ids.js';

export const COORDINATION_DIR = 'coordination';
export const MIRROR_DIR = 'jevcode-commons';
export const DEVICE_FILE = 'device.json';
/** ~/.jevcode/worktrees/<repoKey>/<slug>/ — session worktrees, outside the checkout and every sandbox root (§6.5) */
export const WORKTREES_DIR = 'worktrees';

export function coordinationRoot(home: string): string {
  return join(home, COORDINATION_DIR);
}

/** `~/.jevcode/worktrees/<repoKey>/<slug>` — the session worktree itself (§6.5); a sibling of `coordination/`, not inside it. */
export function sessionWorktreeDir(home: string, repoKey: string, slug: string): string {
  return join(home, WORKTREES_DIR, repoKey, slug);
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
  deviceFile: string;
  /** the 0600 commons key — its own file so both `device.json` copies stay the public subset (§10.3, review #42) */
  deviceKeyFile: string;
  repokeysDir: string;
  /** `trusted-devices.json` — NOT `~/.jevcode/trust.json`, which is the TUI's workspace-trust gate */
  trustedFile: string;
  ignoredFile: string;
  /** `inbox/seen/` — under the inbox kind, not a sibling of it ('seen' can never be read as a deviceId) */
  seenDir: string;
  worktreesDir: string;
  kindRoot(kind: CommonsKind): string;
  deviceDir(kind: CommonsKind, deviceId: string): string;
  deviceRecordFile(deviceId: string): string;
  heartbeatFile(deviceId: string, runId: string): string;
  leaseDir(deviceId: string, repoKey: string): string;
  leaseFile(deviceId: string, repoKey: string, leaseId: string): string;
  outboxDir(deviceId: string, target: string): string;
  messageFile(deviceId: string, target: string, tMs: number, seq: number): string;
  ackDir(deviceId: string, msgId: string): string;
  ackFile(deviceId: string, msgId: string, sessionId: string): string;
  runsDir(deviceId: string, runId: string): string;
  /** `inbox/seen/<consumerId>.json` — the message dedupe set of one CONSUMER process (§5.1, review #13) */
  seenFile(consumerId: string): string;
  worktreeFile(repoKey: string, slug: string): string;
}

/** Path builders over a root (the local store or a mirror root). Components are the caller's validated ids. */
export function commonsPaths(root: string): Commons {
  const kindRoot = (kind: CommonsKind): string => join(root, kind);
  const deviceDir = (kind: CommonsKind, deviceId: string): string => join(root, kind, deviceId);
  return {
    root,
    deviceFile: join(root, DEVICE_FILE),
    deviceKeyFile: join(root, 'device.key'),
    repokeysDir: join(root, 'repokeys'),
    trustedFile: join(root, 'trusted-devices.json'),
    ignoredFile: join(root, 'ignored-devices.json'),
    seenDir: join(root, 'inbox', 'seen'),
    worktreesDir: join(root, WORKTREES_DIR),
    kindRoot,
    deviceDir,
    deviceRecordFile: (deviceId) => join(deviceDir('registry', deviceId), DEVICE_FILE),
    heartbeatFile: (deviceId, runId) => join(deviceDir('registry', deviceId), `${runId}.json`),
    leaseDir: (deviceId, repoKey) => join(deviceDir('leases', deviceId), repoKey),
    leaseFile: (deviceId, repoKey, leaseId) => join(deviceDir('leases', deviceId), repoKey, `${leaseId}.json`),
    outboxDir: (deviceId, target) => join(deviceDir('inbox', deviceId), target),
    messageFile: (deviceId, target, tMs, seq) => join(deviceDir('inbox', deviceId), target, `${tMs}-${seq}.json`),
    ackDir: (deviceId, msgId) => join(deviceDir('acks', deviceId), msgId),
    ackFile: (deviceId, msgId, sessionId) => join(deviceDir('acks', deviceId), msgId, `${sessionId}.json`),
    runsDir: (deviceId, runId) => join(deviceDir('runs', deviceId), runId),
    seenFile: (consumerId) => join(root, 'inbox', 'seen', `${consumerId}.json`),
    worktreeFile: (repoKey, slug) => join(root, WORKTREES_DIR, repoKey, `${slug}.json`),
  };
}

// ── file-name parsers (§3.1: validated exactly like run ids; anything else is skipped and counted) ────────────────────

const JSON_EXT = /\.json$/;

export function isDeviceIdDir(name: string): boolean {
  return DEVICE_ID_RE.test(name);
}
export function isRepoKeyDir(name: string): boolean {
  return REPO_KEY_RE.test(name);
}
export function isTargetDir(name: string): boolean {
  return isValidTarget(name);
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
/** `<sessionId>.json` → sessionId */
export function parseAckName(name: string): string | null {
  return parseHeartbeatName(name);
}
