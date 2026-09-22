/**
 * docs/IMPORT-DESIGN.md §4.3 `jsonl.ts` — byte-capped JSONL, and the §4.2.6 metadata-only
 * transcript pass.
 *
 * The author's machine holds 3 371 transcripts / 2.7 GB, the largest 151 MB: the metadata pass
 * therefore stops at `transcriptScanBytes` (256 KiB), so that file costs one 256 KiB read and
 * never a body. A truncated last line is dropped, not fatal (§4.3). Nothing here throws.
 */
import { IMPORT_LIMITS } from '../../core/limits.js';
import { patternRedact } from '../../core/redact.js';
import type { Json } from '../../core/types.js';
import type { ParseResult } from '../types.js';

/** §4.3: the two bounds a JSONL read is allowed. */
export interface JsonlOptions {
  maxBytes?: number;
  maxRecords?: number;
}

const DEFAULT_MAX_RECORDS = 100_000;
const MAX_WARNINGS = 8;

function toBuffer(input: string | Buffer): Buffer {
  return Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
}

function isObject(v: Json | undefined): v is Readonly<Record<string, Json>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** §4.3: one record per line, byte-capped; a bad line is a warning, a truncated last line is dropped. */
export function parseJsonl(input: string | Buffer, opts: JsonlOptions = {}): ParseResult<readonly Json[]> {
  const maxBytes = opts.maxBytes ?? IMPORT_LIMITS.sourceReadCapBytes;
  const maxRecords = opts.maxRecords ?? DEFAULT_MAX_RECORDS;
  const warnings: string[] = [];
  const buf = toBuffer(input);
  const truncated = buf.length > maxBytes;
  const text = buf.subarray(0, Math.min(buf.length, maxBytes)).toString('utf8');
  const lines = text.split('\n');
  if (truncated) {
    lines.pop();
    warnings.push(`truncated at ${maxBytes} bytes; last partial line dropped`);
  }
  const out: Json[] = [];
  let bad = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (out.length >= maxRecords) {
      warnings.push(`stopped at ${maxRecords} records`);
      break;
    }
    try {
      out.push(JSON.parse(line) as Json);
    } catch {
      bad++;
      if (warnings.length < MAX_WARNINGS) warnings.push('one line is not JSON');
    }
  }
  if (bad > 0 && out.length === 0) return { ok: false, error: `no record parsed (${bad} malformed line${bad === 1 ? '' : 's'})`, warnings };
  if (bad > 0) warnings.push(`${bad} malformed line${bad === 1 ? '' : 's'} dropped`);
  return { ok: true, value: out, warnings };
}

/** §4.2.6: the shapes-only transcript summary — one line per session, never a body. */
export interface TranscriptMeta {
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  firstUserMessage: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** bytes **scanned** (≤ `transcriptScanBytes`), not the file's size — `SourceItem.bytes` has that */
  bytes: number;
  records: number;
  truncated: boolean;
}

function firstString(rec: Readonly<Record<string, Json>>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** Claude Code puts `message.content`; Codex puts `payload.content`; both allow a string or a block list. */
function messageText(v: Json | undefined): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const block of v) {
      if (typeof block === 'string') parts.push(block);
      else if (isObject(block) && typeof block['text'] === 'string') parts.push(block['text']);
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }
  return null;
}

function isUserRecord(rec: Readonly<Record<string, Json>>): boolean {
  if (rec['type'] === 'user' || rec['role'] === 'user') return true;
  const msg = rec['message'];
  return isObject(msg) && msg['role'] === 'user';
}

/**
 * §4.2.6: the metadata-only pass. `sessionId`, `cwd`, `gitBranch`, the first user message
 * (redacted, ≤ `messageChars`), the first and last timestamps, the record count. It stops at
 * `transcriptScanBytes`, so the 151 MB transcript costs one 256 KiB read.
 */
export function transcriptMeta(input: string | Buffer, opts: { redact?: (s: string) => string; messageChars?: number } = {}): TranscriptMeta {
  const redact = opts.redact ?? patternRedact;
  const chars = opts.messageChars ?? 120;
  const buf = toBuffer(input);
  const scanned = Math.min(buf.length, IMPORT_LIMITS.transcriptScanBytes);
  const parsed = parseJsonl(buf, { maxBytes: IMPORT_LIMITS.transcriptScanBytes });
  const records = parsed.ok ? parsed.value : [];
  const meta: TranscriptMeta = {
    sessionId: null,
    cwd: null,
    gitBranch: null,
    firstUserMessage: null,
    startedAt: null,
    endedAt: null,
    bytes: scanned,
    records: records.length,
    truncated: buf.length > IMPORT_LIMITS.transcriptScanBytes,
  };
  for (const rec of records) {
    if (!isObject(rec)) continue;
    const payload = isObject(rec['payload']) ? rec['payload'] : null;
    const git = isObject(rec['git']) ? rec['git'] : payload !== null && isObject(payload['git']) ? payload['git'] : null;
    meta.sessionId ??= firstString(rec, ['sessionId', 'session_id']) ?? (payload !== null ? firstString(payload, ['id', 'sessionId', 'session_id']) : null);
    meta.cwd ??= firstString(rec, ['cwd', 'workingDirectory']) ?? (payload !== null ? firstString(payload, ['cwd', 'workingDirectory']) : null);
    meta.gitBranch ??= firstString(rec, ['gitBranch', 'git_branch', 'branch']) ?? (git !== null ? firstString(git, ['branch', 'gitBranch']) : null);
    const ts = firstString(rec, ['timestamp', 'time', 'created_at', 'createdAt']);
    if (ts !== null) {
      meta.startedAt ??= ts;
      meta.endedAt = ts;
    }
    if (meta.firstUserMessage === null && isUserRecord(rec)) {
      const msg = rec['message'];
      const text = messageText(isObject(msg) ? msg['content'] : undefined) ?? messageText(rec['content']) ?? (payload !== null ? messageText(payload['content']) : null);
      if (text !== null) meta.firstUserMessage = redact(text.replace(/\s+/g, ' ').trim()).slice(0, chars);
    }
  }
  return meta;
}
