/**
 * Self-checksums (§12.0.4 "Record schemas"): `checksum = sha256Hex(stableStringify(record minus { checksum, hmac }))`.
 * A torn or half-synced file fails it and is skipped by the fold (§2.1 rule 1). `undefined` members are dropped before
 * hashing (JSON.stringify drops them on write, so the text on disk and the hash agree).
 */
import { sha256Hex, stableStringify } from '../core/hash.js';
import { toJson } from '../core/json.js';

/** The canonical text a record's checksum covers. */
export function canonicalText(record: object): string {
  const copy: Record<string, unknown> = { ...(record as Record<string, unknown>) };
  delete copy['checksum'];
  delete copy['hmac'];
  return stableStringify(toJson(copy));
}

export function checksumOf(record: object): string {
  return sha256Hex(canonicalText(record));
}

/** `record` with its checksum recomputed (the last step of every writer). */
export function withChecksum<T extends object>(record: T): T & { checksum: string } {
  return { ...record, checksum: checksumOf(record) };
}

export function checksumValid(record: { checksum?: unknown }): boolean {
  return typeof record.checksum === 'string' && record.checksum === checksumOf(record);
}
