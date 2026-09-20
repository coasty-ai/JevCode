/**
 * Secret redaction (DESIGN.md §8.4). Two layers: exact secret strings known from
 * configuration (replaced with the name of the setting or variable they came from), then
 * format patterns for keys we did not configure but recognise. There is deliberately no
 * generic long-token rule: 40-hex git SHAs, npm integrity hashes and base64 blobs are
 * ordinary output for a coding agent and must survive intact.
 */
import type { Json } from './types.js';

export interface SecretEntry {
  /** setting or variable name shown inside the marker, e.g. `generator.apiKey` or `OPENROUTER_API_KEY` */
  name: string;
  value: string;
}
export type SecretSet = readonly SecretEntry[];

export interface Redactor {
  redact(s: string): string;
  /** string leaves only; keys are left alone */
  redactJson(v: Json): Json;
  /** Add a secret discovered after construction (e.g. a key returned by a login flow). Returns false when ignored (too short). */
  addSecret(name: string, value: string): boolean;
  /** number of exact secrets currently active */
  readonly size: number;
}

/** Values shorter than this are ignored: redacting them would mangle ordinary output. */
export const MIN_SECRET_LENGTH = 8;

/** Variable names in a loaded .env whose values join the SecretSet even when JevCode never reads them. */
export const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

export const PATTERN_MARKER = '[REDACTED:pattern]';

/**
 * Each prefix must start a token: without the lookbehind `disk-usage-report-2026-09-19-final`
 * contains `sk-` + 20 safe chars and a base64 blob can contain `AIza` mid-stream, and both
 * would be mangled although §8.4 requires ordinary command output to survive. A key is only
 * ever preceded by a separator (`=`, space, quote, `:`), never by another alphanumeric.
 * The specific `sk-or-v1-` / `sk-ant-` prefixes are listed before the generic `sk-` rule.
 */
const FORMAT_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-or-v1-[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])sk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{22,}/g,
];

/** Header values: the header name stays, the value goes; an already-redacted marker is left alone so the name survives. */
const HEADER_PATTERN = /(authorization:\s*bearer|x-api-key:)\s*(?!\[REDACTED:)\S+/gi;

/** Format-pattern redaction only; safe to use before `resolveConfig()` has run. */
export function patternRedact(s: string): string {
  if (s.length === 0) return s;
  let out = s;
  for (const re of FORMAT_PATTERNS) out = out.replace(re, PATTERN_MARKER);
  return out.replace(HEADER_PATTERN, `$1 ${PATTERN_MARKER}`);
}

function marker(name: string): string {
  return `[REDACTED:${name}]`;
}

export function createRedactor(secrets: SecretSet): Redactor {
  // Longest first so a key that contains another key as a substring is named correctly.
  const entries: SecretEntry[] = [];
  const seen = new Set<string>();
  function add(name: string, value: string): boolean {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    entries.push({ name, value });
    entries.sort((a, b) => b.value.length - a.value.length);
    return true;
  }
  for (const e of secrets) add(e.name, e.value);

  function redact(s: string): string {
    if (typeof s !== 'string' || s.length === 0) return s;
    let out = s;
    for (const e of entries) {
      if (out.includes(e.value)) out = out.split(e.value).join(marker(e.name));
    }
    return patternRedact(out);
  }

  function redactJson(v: Json): Json {
    if (typeof v === 'string') return redact(v);
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => redactJson(x));
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v)) out[k] = redactJson(x);
    return out;
  }

  return {
    redact,
    redactJson,
    addSecret: add,
    get size() {
      return entries.length;
    },
  };
}
