/**
 * Secret redaction (DESIGN.md §8.4) and secret detection (TUI-DESIGN §10.1). Two layers: exact
 * secret strings known from configuration (replaced with the name of the setting or variable they
 * came from), then format patterns for keys we did not configure but recognise. There is
 * deliberately no generic long-token rule: 40-hex git SHAs, npm integrity hashes and base64 blobs
 * are ordinary output for a coding agent and must survive intact.
 *
 * `detectSecrets` is the composer's gate (§10.2): it reports the span of every hit — the eight
 * redacting families, the nine warn-only families (C44 staging: they never mask automatically) and
 * the exact configured secrets — so the host can hand every span to `addSecret` on `y`.
 */
import type { Json, SecretHit } from './types.js';

/** TUI-DESIGN §10.1 / §15 item 19: the detection hit shape lives in core/types.ts (SessionHost.detectSecrets); re-exported here. */
export type { SecretHit } from './types.js';

/** DESIGN §8.4: one exact secret and the name its marker shows. */
export interface SecretEntry {
  /** setting or variable name shown inside the marker, e.g. `generator.apiKey` or `OPENROUTER_API_KEY` */
  name: string;
  value: string;
}
/** DESIGN §8.4: the exact secrets resolveConfig assembles once. */
export type SecretSet = readonly SecretEntry[];

/** TUI-DESIGN §10.1: one span `redact` replaces with an exact marker — the name, never the value. */
export interface ExactSpan {
  name: string;
  start: number;
  end: number;
}

/** DESIGN §8.4 / TUI-DESIGN §10.2: the two-layer redactor handed to the engine, clients, store and renderers. */
export interface Redactor {
  redact(s: string): string;
  /** string leaves only; keys are left alone */
  redactJson(v: Json): Json;
  /** Add a secret discovered after construction (e.g. a key returned by a login flow). Returns false when ignored (too short). */
  addSecret(name: string, value: string): boolean;
  /** TUI-DESIGN §10.2 / §15 item 19: forget every exact secret registered under `name` (the composer ring evicts its oldest entry); false when none had that name. */
  dropSecret(name: string): boolean;
  /**
   * TUI-DESIGN §10.1: the spans `redact(s)` would replace with exact markers — one `{ name, start, end }`
   * per occurrence, non-overlapping, sorted by start (longest secret claims first, like `redact`).
   * The values never leave the redactor; `detectSecrets` uses this instead of re-deriving spans.
   */
  exactSpans(s: string): readonly ExactSpan[];
  /** number of exact secrets currently active */
  readonly size: number;
  /**
   * The length of the longest exact secret right now (0 when none; `addSecret` / `dropSecret` move it): how far back a
   * secret still arriving in a streamed text can start — chat/stream-redact.ts bounds the live region's hold-back by it.
   */
  readonly maxLength: number;
  /**
   * The same, over the exact secrets that CONTAIN whitespace only (0 when none). A secret without whitespace can never
   * straddle a word boundary, so a stream only has to hold back its trailing word for those; this is how far a secret
   * with whitespace (a passphrase, a PEM block acknowledged in the composer) can reach back across boundaries.
   */
  readonly maxSpacedLength: number;
}

/** Values shorter than this are ignored: redacting them would mangle ordinary output. */
export const MIN_SECRET_LENGTH = 8;

/** Variable names in a loaded .env whose values join the SecretSet even when JevCode never reads them. */
export const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** DESIGN §8.4: the marker a format-pattern hit becomes. */
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
  // xAI (`xai-` + a 40+ base62 tail) and Fireworks (`fw_` + a 20+ base62 tail). Appended rather than
  // inserted: `REDACTING_FAMILIES` indexes this array positionally, so a new row at the end leaves
  // every existing family's index alone. There is deliberately NO Meta row — the Meta Model API's
  // key shape is documented nowhere in this repository, and a guessed prefix would either mangle
  // ordinary output or mask nothing; it stays out until a real sample settles the shape.
  /(?<![A-Za-z0-9])xai-[A-Za-z0-9]{40,}/g,
  /(?<![A-Za-z0-9])fw_[A-Za-z0-9]{20,}/g,
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

/** DESIGN §8.4: build the redactor — exact secrets (longest first, ≥ 8 chars, de-duplicated) then `patternRedact`; `addSecret`/`dropSecret` mutate it in place so every holder sees the change. */
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
  function drop(name: string): boolean {
    let dropped = false;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.name !== name) continue;
      seen.delete(e.value);
      entries.splice(i, 1);
      dropped = true;
    }
    return dropped;
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

  // Mirrors `redact`: longest secret first, left-to-right non-overlapping occurrences (split/join semantics).
  function exactSpans(s: string): readonly ExactSpan[] {
    if (typeof s !== 'string' || s.length === 0 || entries.length === 0) return [];
    const out: ExactSpan[] = [];
    for (const e of entries) {
      if (!s.includes(e.value)) continue;
      let from = 0;
      for (;;) {
        const at = s.indexOf(e.value, from);
        if (at === -1) break;
        const end = at + e.value.length;
        insertSpanIfFree(out, { name: e.name, start: at, end });
        from = end;
      }
    }
    return out;
  }

  return {
    redact,
    redactJson,
    addSecret: add,
    dropSecret: drop,
    exactSpans,
    get size() {
      return entries.length;
    },
    // `entries` is kept longest first
    get maxLength() {
      return entries[0]?.value.length ?? 0;
    },
    get maxSpacedLength() {
      return entries.find((e) => /\s/.test(e.value))?.value.length ?? 0;
    },
  };
}

/** Index of the first span in `sorted` (by start) whose start is ≥ `start`. */
function lowerBound(sorted: readonly { start: number }[], start: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]!.start < start) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Insert `span` into `sorted` (kept sorted by start and non-overlapping) unless it overlaps an
 * existing span; returns true when inserted. Binary search + splice keeps thousands of hits
 * (a log full of PEM headers) linear-ish instead of the quadratic `some()` scan.
 */
function insertSpanIfFree<T extends { start: number; end: number }>(sorted: T[], span: T): boolean {
  if (span.end <= span.start) return false;
  const at = lowerBound(sorted, span.start);
  const next = sorted[at];
  if (next && next.start < span.end) return false;
  const prev = at > 0 ? sorted[at - 1] : undefined;
  if (prev && prev.end > span.start) return false;
  sorted.splice(at, 0, span);
  return true;
}

// ---------------------------------------------------------------------------------------
// Detection (TUI-DESIGN §10.1)
// ---------------------------------------------------------------------------------------

/** One detection family: the regex (global) and how a hit is labelled without echoing the secret. */
export interface SecretFamily {
  family: string;
  re: RegExp;
  /**
   * Label for a match: the family's fixed, public prefix plus `…` — never a character of the
   * variable tail (the design's "≤ 6 secret characters": the prefix is not secret, the tail is).
   */
  label: (match: string) => string;
}

const ELLIPSIS = '…';

function prefixLabel(n: number): (m: string) => string {
  return (m) => `${m.slice(0, n)}${ELLIPSIS}`;
}

/** Pre-check literal: a family is only scanned when its cheapest fixed fragment occurs (keeps 256 KB under the §10.1 budget). */
interface FamilySpec extends SecretFamily {
  needles: readonly string[];
  /** a linear custom scanner replacing `re` (PEM: header + END pairing without a lazy body) */
  find?: (s: string) => readonly { start: number; end: number }[];
}

/** The eight redacting families (`FORMAT_PATTERNS`), one label rule each; `sk-proj-` is labelled OpenAI (P55). */
const REDACTING_FAMILIES: readonly FamilySpec[] = [
  { family: 'openrouter', re: FORMAT_PATTERNS[0]!, needles: ['sk-or-v1-'], label: () => `sk-or-${ELLIPSIS}` },
  { family: 'anthropic', re: FORMAT_PATTERNS[1]!, needles: ['sk-ant-'], label: () => `sk-ant-${ELLIPSIS}` },
  {
    family: 'sk',
    re: FORMAT_PATTERNS[2]!,
    needles: ['sk-'],
    label: (m) => (m.startsWith('sk-proj-') ? `sk-proj-${ELLIPSIS} (OpenAI)` : `sk-${ELLIPSIS}`),
  },
  { family: 'google', re: FORMAT_PATTERNS[3]!, needles: ['AIza'], label: () => `AIza${ELLIPSIS}` },
  { family: 'github', re: FORMAT_PATTERNS[4]!, needles: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'], label: prefixLabel(4) },
  { family: 'github_pat', re: FORMAT_PATTERNS[5]!, needles: ['github_pat_'], label: () => `github_pat_${ELLIPSIS}` },
  { family: 'xai', re: FORMAT_PATTERNS[6]!, needles: ['xai-'], label: () => `xai-${ELLIPSIS}` },
  { family: 'fireworks', re: FORMAT_PATTERNS[7]!, needles: ['fw_'], label: () => `fw_${ELLIPSIS}` },
];

/**
 * PEM blocks are detected by the `PRIVATE KEY` header and reported end-anchored (the whole
 * `-----BEGIN … -----END … PRIVATE KEY-----` block, so `y` masks the base64 body too, §10.2); a
 * header without its END line is reported alone. `-----BEGIN CERTIFICATE-----` never matches.
 * The header regex has no body: a lazy `[\s\S]*?` body would rescan to the end of the input for
 * every header without an END (quadratic on a log full of headers, §10.1 backtracking guard).
 */
const PEM_BEGIN_RE = /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END_RE = /-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/y;
const PEM_END_NEEDLE = '-----END';

/** One linear pass: every header, paired with the first matching END line before the next header. */
function pemSpans(s: string): readonly { start: number; end: number }[] {
  PEM_BEGIN_RE.lastIndex = 0;
  const heads = [...s.matchAll(PEM_BEGIN_RE)];
  if (heads.length === 0) return [];
  const ends: number[] = [];
  for (let p = s.indexOf(PEM_END_NEEDLE); p !== -1; p = s.indexOf(PEM_END_NEEDLE, p + 1)) ends.push(p);
  const out: { start: number; end: number }[] = [];
  let ei = 0;
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    const start = h.index;
    const headEnd = start + h[0].length;
    const limit = i + 1 < heads.length ? heads[i + 1]!.index : s.length;
    while (ei < ends.length && ends[ei]! < headEnd) ei++;
    let end = headEnd;
    for (let k = ei; k < ends.length && ends[k]! < limit; k++) {
      PEM_END_RE.lastIndex = ends[k]!;
      const m = PEM_END_RE.exec(s);
      if (m) {
        end = ends[k]! + m[0].length;
        break;
      }
    }
    out.push({ start, end });
  }
  return out;
}

const WARN_ONLY_FAMILIES: readonly FamilySpec[] = [
  { family: 'aws', re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g, needles: ['A3T', 'AKIA', 'ASIA', 'ABIA', 'ACCA'], label: prefixLabel(4) },
  { family: 'slack', re: /(?<![A-Za-z0-9])xox[abpers]-[0-9]{8,13}-[A-Za-z0-9-]{10,}/g, needles: ['xox'], label: prefixLabel(5) },
  {
    family: 'slack_webhook',
    re: /hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/g,
    needles: ['hooks.slack.com/'],
    label: () => `hooks.slack.com/${ELLIPSIS}`,
  },
  { family: 'pem', re: PEM_BEGIN_RE, needles: ['PRIVATE KEY'], label: () => `-----BEGIN${ELLIPSIS}`, find: pemSpans },
  { family: 'jwt', re: /\bey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/_-]{17,}\.[a-zA-Z0-9/_-]{10,}={0,2}/g, needles: ['.ey'], label: prefixLabel(3) },
  {
    family: 'stripe',
    re: /(?<![A-Za-z0-9])(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}\b/g,
    needles: ['sk_', 'rk_'],
    label: (m) => `${m.slice(0, m.indexOf('_', 3) + 1)}${ELLIPSIS}`,
  },
  { family: 'npm', re: /(?<![A-Za-z0-9])npm_[a-zA-Z0-9]{36}\b/g, needles: ['npm_'], label: () => `npm_${ELLIPSIS}` },
  { family: 'huggingface', re: /(?<![A-Za-z0-9])hf_[A-Za-z]{34}\b/g, needles: ['hf_'], label: () => `hf_${ELLIPSIS}` },
  { family: 'gitlab', re: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g, needles: ['glpat-'], label: () => `glpat-${ELLIPSIS}` },
];

/** TUI-DESIGN §10.1: the warn-only families (AWS, Slack, webhook, PEM `PRIVATE KEY`, JWT, Stripe, npm_, hf_, glpat-); detected, never auto-masked (C44). The PEM entry's `re` is the header form; detection pairs it with its END line. */
export const WARN_ONLY_PATTERNS: readonly { family: string; re: RegExp }[] = WARN_ONLY_FAMILIES.map((f) => ({ family: f.family, re: f.re }));

/** TUI-DESIGN §10.1: the redacting families as detection entries (family name, regex, label rule). */
export const REDACTING_PATTERNS: readonly SecretFamily[] = REDACTING_FAMILIES.map(({ family, re, label }) => ({ family, re, label }));

/** Family name of an exact configured secret; its label is `your <NAME>`. */
export const EXACT_FAMILY = 'exact';

/**
 * TUI-DESIGN §10.1: what `detectSecrets` accepts as the exact layer — the design's
 * `Pick<Redactor, 'redact'>`, plus `exactSpans` when the caller hands a real `Redactor` (then the
 * spans are exact by construction; with a bare `redact` they are recovered by alignment and
 * verified, see `exactHits`).
 */
export type ExactDetector = Pick<Redactor, 'redact'> & Partial<Pick<Redactor, 'exactSpans'>>;

const MARKER_HEAD = '[REDACTED:';
const PROBE_CHARS = 24;
/** Two secrets glued with no separator through a bare `redact`: the first one's end is found by a bounded scan. */
const GLUED_SCAN_MAX = 4096;

function isSpace(c: string | undefined): boolean {
  return c !== undefined && /\s/.test(c);
}

function exactHit(name: string, start: number, end: number): SecretHit {
  return { family: EXACT_FAMILY, label: `your ${name}`, start, end, warnOnly: false };
}

/**
 * Where does the span replaced by the marker `o[j..k)` end in `s`, starting at `i`? Candidates are
 * the positions where the literal text that follows the marker in `o` re-appears in `s`; each is
 * verified with `redact(s.slice(i, end)) === marker`, which rejects a probe that also occurs inside
 * the secret's tail (`${key}e`). A marker at the very end of `o` claims the rest of `s`; two glued
 * markers are separated by a bounded smallest-end scan. `null` = cannot align.
 */
function alignMarker(s: string, i: number, o: string, k: number, run: string, minLen: number, redact: (x: string) => string): number | null {
  let segEnd = o.indexOf(MARKER_HEAD, k);
  if (segEnd === -1) segEnd = o.length;
  const seg = o.slice(k, segEnd);
  if (seg.length === 0) {
    if (k >= o.length) return redact(s.slice(i)) === run ? s.length : null;
    const limit = Math.min(s.length, i + GLUED_SCAN_MAX);
    for (let end = i + minLen; end <= limit; end++) if (redact(s.slice(i, end)) === run) return end;
    return null;
  }
  const probe = seg.slice(0, Math.min(seg.length, PROBE_CHARS));
  let at = s.indexOf(probe, i + minLen);
  while (at !== -1 && redact(s.slice(i, at)) !== run) at = s.indexOf(probe, at + 1);
  return at === -1 ? null : at;
}

/**
 * Fallback for a bare `redact` function: recover the spans it replaced by aligning `s` with
 * `redact(s)`, one marker at a time. Literal runs must match (whitespace runs may differ where the
 * header rule normalised them). A `[REDACTED:` in `o` that is also present literally in `s` at the
 * same point (a pasted redacted log, a name that parses as garbage) is aligned as text, never
 * reported. Pattern markers are aligned but not reported (the pattern layer owns them). Bails
 * (returns what it has) when alignment is impossible.
 */
function exactHits(s: string, redact: (x: string) => string): SecretHit[] {
  const o = redact(s);
  if (o === s) return [];
  const hits: SecretHit[] = [];
  let i = 0;
  let j = 0;
  while (j < o.length && i <= s.length) {
    if (o.startsWith(MARKER_HEAD, j)) {
      const literalHere = s.startsWith(MARKER_HEAD, i);
      const close = o.indexOf(']', j + MARKER_HEAD.length);
      const name = close === -1 ? '' : o.slice(j + MARKER_HEAD.length, close);
      const k = close + 1;
      const run = close === -1 ? '' : o.slice(j, k);
      const isPattern = name === 'pattern';
      const end = close === -1 || name === '' || name.includes('[') ? null : alignMarker(s, i, o, k, run, isPattern ? 1 : MIN_SECRET_LENGTH, redact);
      if (end === null) {
        if (literalHere) {
          i += MARKER_HEAD.length;
          j += MARKER_HEAD.length;
          continue;
        }
        return hits;
      }
      if (!isPattern && end > i && s.slice(i, end) !== run) hits.push(exactHit(name, i, end));
      i = end;
      j = k;
      continue;
    }
    if (s[i] === o[j]) {
      i++;
      j++;
      continue;
    }
    // Whitespace normalised by the header rule: skip runs on both sides and retry once.
    if (isSpace(s[i]) || isSpace(o[j])) {
      while (isSpace(s[i])) i++;
      while (isSpace(o[j])) j++;
      if (s[i] === o[j] || o.startsWith(MARKER_HEAD, j)) continue;
    }
    return hits;
  }
  return hits;
}

function scanFamily(s: string, f: FamilySpec, warnOnly: boolean, accepted: SecretHit[]): void {
  if (!f.needles.some((n) => s.includes(n))) return;
  if (f.find) {
    for (const sp of f.find(s)) {
      if (sp.end <= sp.start) continue;
      insertSpanIfFree(accepted, { family: f.family, label: f.label(s.slice(sp.start, sp.end)), start: sp.start, end: sp.end, warnOnly });
    }
    return;
  }
  f.re.lastIndex = 0;
  for (const m of s.matchAll(f.re)) {
    const text = m[0];
    if (text.length === 0) continue;
    insertSpanIfFree(accepted, { family: f.family, label: f.label(text), start: m.index, end: m.index + text.length, warnOnly });
  }
}

/**
 * TUI-DESIGN §10.1: every secret span in `s` — exact configured secrets first (labelled
 * `your <NAME>`, one hit per secret when `exact` is a `Redactor`), then the eight redacting
 * families, then the warn-only families. Spans never overlap (an earlier, more specific family
 * wins) and are sorted by start; labels never carry the secret's tail. Pure; a 256 KB input scans
 * in under the 5 ms budget because each family is gated by a literal pre-check before its regex
 * runs and the PEM scan is linear.
 */
export function detectSecrets(s: string, exact?: ExactDetector): readonly SecretHit[] {
  if (typeof s !== 'string' || s.length === 0) return [];
  const accepted: SecretHit[] = [];
  if (exact) {
    const spans = typeof exact.exactSpans === 'function' ? exact.exactSpans(s) : null;
    const hits = spans ? spans.map((sp) => exactHit(sp.name, sp.start, sp.end)) : exactHits(s, (x) => exact.redact(x));
    for (const h of hits) insertSpanIfFree(accepted, h);
  }
  for (const f of REDACTING_FAMILIES) scanFamily(s, f, false, accepted);
  for (const f of WARN_ONLY_FAMILIES) scanFamily(s, f, true, accepted);
  return accepted;
}

/** TUI-DESIGN §10.2: the distinct span texts of `hits` that are long enough for `addSecret` (≥ MIN_SECRET_LENGTH). */
export function secretSpans(s: string, hits: readonly SecretHit[]): readonly string[] {
  const out: string[] = [];
  for (const h of hits) {
    const span = s.slice(h.start, h.end);
    if (span.length >= MIN_SECRET_LENGTH && !out.includes(span)) out.push(span);
  }
  return out;
}

/** TUI-DESIGN §10.7: a draft that never left the composer — hit spans replaced by `[REDACTED:draft]` before history or ui.json see it. */
export const DRAFT_MARKER = '[REDACTED:draft]';

/** TUI-DESIGN §10.7: replace every hit span (all families, warn-only included) with `marker`; overlapping spans are merged. */
export function redactSpans(s: string, hits: readonly SecretHit[], mark: string = DRAFT_MARKER): string {
  if (hits.length === 0) return s;
  const sorted = [...hits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let cursor = 0;
  let open: { start: number; end: number } | null = null;
  const flush = (): void => {
    if (!open) return;
    out += s.slice(cursor, open.start) + mark;
    cursor = open.end;
    open = null;
  };
  for (const h of sorted) {
    const start = Math.max(0, Math.min(s.length, h.start));
    const end = Math.max(start, Math.min(s.length, h.end));
    if (end === start) continue;
    if (open && start <= open.end) open.end = Math.max(open.end, end);
    else {
      flush();
      open = { start, end };
    }
  }
  flush();
  return out + s.slice(cursor);
}
