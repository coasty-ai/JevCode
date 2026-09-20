/**
 * Masked presentation of the resolved table (DESIGN.md §3): secrets appear only as
 * `<source> (sha256:xxxxxxxx)`, the first 8 hex characters of their SHA-256, never any
 * character of the key itself. Used by run.json and `jevcode config`.
 */
import type { ConfigRecordValue, ConfigSource, Resolved } from '../core/types.js';
import { fingerprint } from '../core/hash.js';

export { fingerprint };

export function isMaskedValue(v: ConfigRecordValue['value']): v is { source: string; fingerprint: string } {
  return typeof v === 'object' && v !== null;
}

/** Build the run.json / `jevcode config` record: secrets masked, sources kept. */
export function maskEntries(entries: ReadonlyMap<string, Resolved<string>>, secretNames: ReadonlySet<string>): Record<string, ConfigRecordValue> {
  const out: Record<string, ConfigRecordValue> = {};
  for (const [name, r] of entries) {
    out[name] = secretNames.has(name) ? { value: { source: r.source, fingerprint: fingerprint(r.value) }, source: r.source } : { value: r.value, source: r.source };
  }
  return out;
}

/** `<source> (sha256:1a2b3c4d)` for a secret, the plain value otherwise. */
export function formatRecordValue(v: ConfigRecordValue): string {
  return isMaskedValue(v.value) ? `${v.value.source} (sha256:${v.value.fingerprint})` : v.value;
}

/** Source column text; kept as a hook so the table and run.json can diverge later without touching callers. */
export function formatSource(source: ConfigSource | string): string {
  return source;
}

/** Three-column plain-text table: setting, value, source. Deterministic order (sorted by setting). */
export function renderConfigTable(record: Record<string, ConfigRecordValue>, extra: Record<string, string> = {}): string {
  const rows: [string, string, string][] = Object.keys(record)
    .sort()
    .map((k) => {
      const v = record[k]!;
      return [k, formatRecordValue(v), formatSource(v.source)];
    });
  for (const [k, v] of Object.entries(extra)) rows.push([k, v, '']);
  const w0 = Math.max('setting'.length, ...rows.map((r) => r[0].length));
  const w1 = Math.max('value'.length, ...rows.map((r) => r[1].length));
  const lines = [`${'setting'.padEnd(w0)}  ${'value'.padEnd(w1)}  source`, `${'-'.repeat(w0)}  ${'-'.repeat(w1)}  ------`];
  for (const [a, b, c] of rows) lines.push(`${a.padEnd(w0)}  ${b.padEnd(w1)}  ${c}`.trimEnd());
  return lines.join('\n');
}
