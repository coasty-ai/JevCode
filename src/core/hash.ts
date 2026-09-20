import { createHash } from 'node:crypto';
import type { Json } from './types.js';

/** Deterministic JSON serialisation: object keys sorted recursively, arrays kept in order. */
export function stableStringify(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k] as Json)}`).join(',')}}`;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 12-hex-character digest of the stable JSON form (as lab.mjs `sha()`, but key-order independent). */
export function sha12(value: Json): string {
  return sha256Hex(stableStringify(value)).slice(0, 12);
}

/** First 8 hex characters of SHA-256; the only form in which a secret is ever displayed (§3). */
export function fingerprint(secret: string): string {
  return sha256Hex(secret).slice(0, 8);
}
