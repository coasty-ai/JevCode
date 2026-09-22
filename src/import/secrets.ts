/**
 * Value shapes and the secret decision (docs/IMPORT-DESIGN.md §4.4.2 rules 1–3 + rule 8, §4.4.3
 * group I, §4.8.1 invariants 1–2).
 *
 * **The one invariant this module exists for: no function here ever retains a substring of a
 * value.** `shapeOf` returns a length, a charset name, an entropy bucket, a `sha256[0..8]`
 * fingerprint, a family name and a reference flag — never a prefix, a suffix or a character.
 * `referenceName` is the single exception and it is not a value: a pure `${VAR}` reference holds
 * no credential bytes at all, and §4.8.3 requires the variable *name* to travel in place of the
 * secret.
 *
 * Pure: no I/O, no network, no logging. Nothing here prints.
 */
import { sha256Hex } from '../core/hash.js';
import { MIN_SECRET_LENGTH, SECRET_NAME_RE, detectSecrets } from '../core/redact.js';
import type { Json } from '../core/types.js';
import type { ValueShape } from './types.js';

// ---------------------------------------------------------------------------------------
// §4.4.2 — the path sets the nine key rules are written against
// ---------------------------------------------------------------------------------------

/**
 * §4.4.2 rule 1 — the known-secret set. Matched against a leaf's dotted path; a `RegExp` entry is
 * anchored by construction, a string entry is an exact dotted path.
 */
export const KNOWN_SECRET_PATHS: readonly (string | RegExp)[] = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  /^oauthAccount(\..+)?$/,
  /^provider\.[^.]+\.options\.apiKey$/,
  /(^|\.)oauth\.clientSecret$/,
  /(^|\.)[A-Za-z0-9_]*-api-key$/i,
  /(^|\.)headers\.Authorization$/i,
  /(^|\.)headers\.x-api-key$/i,
];

/** §4.4.2 rule 5 — the permission set; every hit is `suggest`, never written (§4.8.4). */
export const PERMISSION_PATHS: readonly (string | RegExp)[] = [
  /^permissions(\..+)?$/,
  /^permission(\..+)?$/,
  /(^|\.)allowedTools(\..+)?$/,
  /^sandbox(\..+)?$/,
  /(^|\.)approval_policy$/,
  /(^|\.)sandbox_mode$/,
  /(^|\.)trust_level$/,
  /(^|\.)trust$/,
  /(^|\.)hasTrustDialogAccepted$/,
  /(^|\.)prefix_rule(\..+)?$/,
];

/** §4.4.2 rule 6 — the hook/exec set; report-only (§4.8.4). `*.command` inside an MCP block is rule 7's. */
export const EXEC_PATHS: readonly (string | RegExp)[] = [
  /^hooks(\..+)?$/,
  /(^|\.)hooks\..+$/,
  /(^|\.)notify(\.\d+)?$/,
  /(^|\.)statusLine(\..+)?$/,
  /(^|\.)command$/,
];

/** §4.4.2 rule 7 — the mcp set, in the five spellings the eight dialects of §3.10 use. */
export const MCP_PATHS: readonly (string | RegExp)[] = [
  /^mcpServers(\..+)?$/,
  /^mcp(\..+)?$/,
  /^mcp_servers(\..+)?$/,
  /^servers(\..+)?$/,
  /^context_servers(\..+)?$/,
];

/** True when `dotted` matches any entry of `set` (exact string, or the regex). */
export function matchesPath(dotted: string, set: readonly (string | RegExp)[]): boolean {
  for (const entry of set) {
    if (typeof entry === 'string') {
      if (dotted === entry || dotted.endsWith(`.${entry}`)) return true;
    } else if (entry.test(dotted)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------
// §4.4.2 rule 8 / §4.4.3 group I — the shape of a value
// ---------------------------------------------------------------------------------------

/** §4.4.2 rule 8: the charset gate. `mixed` is printable ASCII plus non-ASCII; `other` has controls. */
const HEX_RE = /^[0-9a-fA-F]+$/;
const ALNUM_RE = /^[A-Za-z0-9]+$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const ASCII_RE = /^[\x20-\x7e]+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** §4.4.3 group I: the entropy bucket boundaries, in bits per character. */
export const ENTROPY_MEDIUM_BITS = 2.5;
export const ENTROPY_HIGH_BITS = 3.5;
/** §4.4.2 rule 8: the band's own entropy floor. */
export const ENTROPY_BAND_BITS = 3.2;
/** §4.4.2 rule 8: the band's own length floor. */
export const BAND_MIN_LENGTH = 20;

/** §4.4.2 rule 8: which of the six charset names a value falls in. Pure; retains nothing. */
export function charsetOf(value: string): ValueShape['charset'] {
  if (value.length === 0) return 'other';
  if (CONTROL_RE.test(value)) return 'other';
  if (HEX_RE.test(value)) return 'hex';
  if (ALNUM_RE.test(value)) return 'alnum';
  if (BASE64URL_RE.test(value) || BASE64_RE.test(value)) return 'base64url';
  if (ASCII_RE.test(value)) return 'ascii';
  return 'mixed';
}

/**
 * Shannon entropy of the value's own character distribution, in **bits per character** — the unit
 * §4.4.2 rule 8 states its `≥ 3.2` threshold in. Returns 0 for the empty string.
 */
export function entropyBits(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = [...counts.values()].reduce((a, b) => a + b, 0);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function bucketOf(bits: number): ValueShape['entropyBucket'] {
  if (bits >= ENTROPY_HIGH_BITS) return 'high';
  if (bits >= ENTROPY_MEDIUM_BITS) return 'medium';
  return 'low';
}

/**
 * §4.4.2 rule 8 / §4.4.3 group I / §8.2 R9. The only description of a candidate value that ever
 * leaves this module: length, charset, entropy bucket, `sha256(value)[0..8]`, the `detectSecrets`
 * family when a pattern recognised it, and whether the whole value is an env reference.
 *
 * **Retains no substring of `value`** — not a prefix, not a suffix, not a character. The
 * fingerprint is a hash, and `family` is one of the fifteen fixed family names of `redact.ts`.
 */
export function shapeOf(value: string): ValueShape {
  const hits = value.length === 0 ? [] : detectSecrets(value);
  const first = hits[0];
  return {
    length: value.length,
    charset: charsetOf(value),
    entropyBucket: bucketOf(entropyBits(value)),
    fingerprint: sha256Hex(value).slice(0, 8),
    family: first ? first.family : null,
    reference: isEnvReference(value),
  };
}

// ---------------------------------------------------------------------------------------
// §4.4.2 rule 4 / §4.8.3 — env references
// ---------------------------------------------------------------------------------------

const VAR = '[A-Za-z_][A-Za-z0-9_]*';
/**
 * `${VAR}`, `${env:VAR}`, `{env:VAR}`, `$VAR`, `%VAR%` — the forms that hold **no value at all**.
 *
 * `${VAR:-default}` and `${VAR:default}` are deliberately *not* here. Rule 4 exists because
 * `env.GITHUB_TOKEN = "${GITHUB_TOKEN}"` carries no credential byte, so it may skip rules 1, 2
 * and the band; a default-value form carries a literal in the same string —
 * `${TOKEN:-sk-ant-…}` — and giving it that free pass wrote the literal straight through. The
 * shell's own expansion of the default is the *value*, so the whole value is not a reference.
 * (`mcp.ts` still normalises `${VAR:-default}` to `${VAR}` per §3.10; the default is dropped
 * there, so what reaches this predicate from that path is already pure.)
 */
const REFERENCE_FORMS: readonly RegExp[] = [
  new RegExp(`^\\$\\{(?:env:)?(${VAR})\\}$`),
  new RegExp(`^\\{env:(${VAR})\\}$`),
  new RegExp(`^\\$(${VAR})$`),
  new RegExp(`^%(${VAR})%$`),
];

/** §4.4.2 rule 4: true when the **whole** value is one env reference and nothing else. */
export function isEnvReference(value: string): boolean {
  return referenceName(value) !== null;
}

/** §4.8.3: the variable name inside a pure reference, or `null` when the value is not one. */
export function referenceName(value: string): string | null {
  if (value.length === 0 || value.length > 256) return null;
  for (const re of REFERENCE_FORMS) {
    const m = re.exec(value);
    if (m && m[1] !== undefined) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// §4.4.2 rules 1–3 + the band — the value decision
// ---------------------------------------------------------------------------------------

/** §4.4.2: the outcome of the value half of a key rule. `rule` is the rule number that fired. */
export interface SecretDecision {
  secret: boolean;
  band: boolean;
  rule: number;
  why: string;
}

/**
 * §4.4.2 rule 8: the leaf names that keep a high-entropy value **out** of the band. JevCode writes
 * `sha256` fields itself, so the allowlist is not hypothetical.
 */
export const NON_SECRET_LEAF_NAMES: readonly string[] = [
  'sha',
  'sha256',
  'hash',
  'id',
  'uuid',
  'machineID',
  'sessionId',
  'checksum',
  'etag',
  'version',
  'commit',
  'digest',
  'fingerprint',
];

const NON_SECRET_SET = new Set(NON_SECRET_LEAF_NAMES.map((n) => n.toLowerCase()));

/** True when the leaf name is on rule 8's allowlist (case-insensitive). */
export function isAllowlistedLeaf(leafName: string): boolean {
  return NON_SECRET_SET.has(leafName.toLowerCase());
}

/**
 * §4.4.2 rules 1–3 plus the rule-8 band predicate, for one leaf.
 *
 * Order is the design's, with one normative reading made explicit: **a value that is a pure env
 * reference falls through rules 1 and 2 to rule 4.** `env.GITHUB_TOKEN = "${GITHUB_TOKEN}"` holds
 * no credential byte, §4.8.3 makes that form the thing that *travels* in place of a secret, and
 * §4.4.3 group I lists `the string ${OPENROUTER_API_KEY} at mcpServers.x.env.OPENROUTER_API_KEY`
 * as a **false** example. Rule 3 still runs first: a literal a pattern recognises is a secret
 * whatever its path.
 *
 * The returned `shape` is `null` for non-string values (a number or a boolean cannot be a
 * credential) and for the empty string.
 */
export function classifyValue(dotted: string, leafName: string, value: Json): SecretDecision & { shape: ValueShape | null } {
  const str = typeof value === 'string' ? value : null;
  const shape = str === null || str.length === 0 ? null : shapeOf(str);

  // rule 3 first among the "it *is* one" rules: a recognised family is a secret at any path.
  if (str !== null && shape !== null && shape.family !== null) {
    return { secret: true, band: false, rule: 3, why: `key rule 3 (detectSecrets family ${shape.family})`, shape };
  }

  const isReference = shape !== null && shape.reference;

  if (!isReference && matchesPath(dotted, KNOWN_SECRET_PATHS)) {
    return { secret: true, band: false, rule: 1, why: `key rule 1 (known-secret set: ${dotted})`, shape };
  }
  // `env.*` where the variable name itself reads as a credential (rule 1's first clause).
  if (!isReference && /^env\./.test(dotted) && SECRET_NAME_RE.test(leafName)) {
    return { secret: true, band: false, rule: 1, why: `key rule 1 (known-secret set: ${dotted})`, shape };
  }
  if (!isReference && SECRET_NAME_RE.test(leafName) && str !== null && str.length >= MIN_SECRET_LENGTH) {
    return { secret: true, band: false, rule: 2, why: `key rule 2 (secret-looking name, ${str.length} chars)`, shape };
  }
  if (isReference) {
    return { secret: false, band: false, rule: 4, why: `key rule 4 (env reference \${${referenceName(str ?? '') ?? ''}})`, shape };
  }
  if (inBand(leafName, str)) {
    return { secret: false, band: true, rule: 8, why: `key rule 8 (band: ${shape?.length ?? 0} chars, ${shape?.charset ?? 'other'}, entropy ${shape?.entropyBucket ?? 'low'})`, shape };
  }
  return { secret: false, band: false, rule: 9, why: 'key rule 9 (config)', shape };
}

/**
 * §4.4.2 rule 8: length ≥ 20, charset ∈ {hex, base64url, alnum}, Shannon entropy ≥
 * `ENTROPY_BAND_BITS` (3.2 b/c), the value not a pure reference and the leaf name not on the
 * allowlist.
 *
 * It takes the **value**, not a `ValueShape`, because the band's floor falls *inside* the medium
 * bucket: `entropyBucket` only says `[2.5, 3.5)`, so a shape cannot decide 3.0 from 3.3. Testing
 * the bucket instead admitted everything from 2.5 up, which is a different rule from the one the
 * design states. Pure, and it retains nothing: the value is read, never stored or returned.
 */
export function inBand(leafName: string, value: string | null): boolean {
  if (value === null || value.length < BAND_MIN_LENGTH) return false;
  const charset = charsetOf(value);
  if (charset !== 'hex' && charset !== 'base64url' && charset !== 'alnum') return false;
  if (isAllowlistedLeaf(leafName)) return false;
  if (isEnvReference(value)) return false;
  return entropyBits(value) >= ENTROPY_BAND_BITS;
}

/**
 * §4.4.3 group I: `secret ⟺ (code rule 1–3 fired) OR (in band AND p ≥ 0.5)`.
 *
 * **Jev may promote into the secret class and may never demote out of it.** With no Jev answer at
 * all (`jevP === null`) every band item is a secret — the conservative side of §0 principle 4.
 */
export function joinSecretVerdict(code: SecretDecision, jevP: number | null): SecretDecision {
  if (code.secret) return code;
  if (!code.band) return code;
  if (jevP === null) {
    return { secret: true, band: true, rule: code.rule, why: `${code.why} → code fallback (jev unavailable): band item treated as a secret` };
  }
  if (jevP >= 0.5) {
    return { secret: true, band: true, rule: code.rule, why: `${code.why} → jev is_secret p=${jevP.toFixed(2)}` };
  }
  return { secret: false, band: true, rule: code.rule, why: `${code.why} → jev is_secret p=${jevP.toFixed(2)} (below 0.50)` };
}
