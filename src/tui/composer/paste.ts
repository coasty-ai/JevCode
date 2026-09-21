/**
 * Paste lifecycle, the store half (TUI-DESIGN §4.5, §10.3; A4, 16 §4.3, C10). The Ink `useRef` wiring is O9's.
 *
 * Bodies live only in this store's Map: never in React state, the reducer, an `EngineEvent`, `ui.json`, history or logs.
 * A paste that is `> 3 lines || > 800 chars` (line threshold 2 below rows 12) becomes a chip `[Pasted #n, k lines]`;
 * the store keeps `{ text, lines, bytes, fp8 }` where `fp8` is the first 8 hex of the body's sha256 — a display
 * fingerprint, never the full digest (a full digest of a short paste is an offline oracle). Hard cap 1 MiB per paste.
 * Bodies keep their tabs (§4.5 step 2); only text that enters the buffer has them expanded (§4.1).
 *
 * Chip identity is the label string: `expand` replaces every occurrence of a live chip's label (§4.5 step 5), and the
 * reducer keeps plain text from ever aliasing one (`buffer.ts` defuses a typed or pasted label with `[Pasted # n, …]`).
 */
import { createHash } from 'node:crypto';
import type { ChipRef } from './buffer.js';
import { expandTabs, normaliseChunk } from './filter.js';

/** One stored paste body (TUI-DESIGN §4.5 step 4). */
export interface PasteBlob {
  readonly text: string;
  readonly lines: number;
  readonly bytes: number;
  /** first 8 hex of sha256(text) */
  readonly fp8: string;
}

/** Outcome of offering a paste to the store (TUI-DESIGN §4.5 steps 3–4). */
export type PasteDecision =
  | { readonly kind: 'refused'; readonly bytes: number; readonly toast: string }
  | { readonly kind: 'chip'; readonly chip: ChipRef; readonly blob: PasteBlob }
  | { readonly kind: 'insert'; readonly text: string }
  | { readonly kind: 'empty' };

/** Result of expanding chip labels back into bodies at submit (TUI-DESIGN §4.5 step 5). */
export type ExpandResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly missing: ChipRef; readonly notice: string };

/** Hard cap per paste (TUI-DESIGN §4.5 step 3, D4). */
export const PASTE_MAX_BYTES = 1024 * 1024;
/** Chip thresholds (TUI-DESIGN §4.5 step 4; 02 §3.3). */
export const CHIP_LINE_THRESHOLD = 3;
/** Line threshold below rows 12 (TUI-DESIGN §4.5 step 4, 02 §3.3). */
export const CHIP_LINE_THRESHOLD_SHORT = 2;
/** Character threshold (TUI-DESIGN §4.5 step 4). */
export const CHIP_CHAR_THRESHOLD = 800;
/** Below this many terminal rows the line threshold drops to 2 (TUI-DESIGN §4.5 step 4). */
export const SHORT_TERMINAL_ROWS = 12;
/** The redacted first line inside a history label is clipped to this many characters (TUI-DESIGN §4.6, P58). */
export const HISTORY_LABEL_LINE_MAX = 40;

const LABEL_RE = /\[Pasted #(\d+), (\d+) lines?\]/g;

/** `[Pasted #n, k lines]` (TUI-DESIGN §4.1, §4.5); singular for one line. */
export function chipLabel(n: number, lines: number): string {
  return `[Pasted #${n}, ${lines} ${lines === 1 ? 'line' : 'lines'}]`;
}

/** Human size for the refusal toast (TUI-DESIGN §24: `paste of 3.2 MB refused (limit 1 MiB); …`). */
export function formatPasteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes >= 1e6) {
    const mb = bytes / 1e6;
    return `${mb >= 10 ? mb.toFixed(0) : mb >= 1.1 ? mb.toFixed(1) : mb.toFixed(2)} MB`;
  }
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** The refusal toast, verbatim from TUI-DESIGN §24. */
export function pasteRefusedToast(bytes: number): string {
  return `paste of ${formatPasteSize(bytes)} refused (limit 1 MiB); write it to a file and @-mention it`;
}

/** The submit-time notice for a chip whose body is gone (after `--resume`), verbatim from TUI-DESIGN §24 minus the `[ui]` label. */
export function missingChipNotice(n: number): string {
  return `remove [Pasted #${n}] or paste again`;
}

/** Number of lines of a normalised body for the chip threshold and label (TUI-DESIGN §4.5); a trailing '\n' does not add an empty line. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && i !== text.length - 1) n++;
  return n;
}

/**
 * Normalise a paste body (TUI-DESIGN §4.5 step 2): CRLF/CR → LF, `sanitizeStream` minus `\n\t` (tabs are KEPT — a
 * Makefile, Go source or TSV must reach the generator byte-exact; 07 §1.1), bidi stripped, U+2028/2029 → LF, NFC.
 * Tab expansion is a buffer rule (§4.1) and is applied only to the `insert` text that enters the composer (`expandTabs`).
 */
export function normalisePaste(raw: string): string {
  const n = normaliseChunk(raw, { keepTabs: true });
  return /^[\u0000-\u007f]*$/.test(n) ? n : n.normalize('NFC');
}

/** True when a normalised paste collapses into a chip at this terminal height (TUI-DESIGN §4.5 step 4). */
export function shouldChip(text: string, rows: number): boolean {
  const lineLimit = Number.isFinite(rows) && rows < SHORT_TERMINAL_ROWS ? CHIP_LINE_THRESHOLD_SHORT : CHIP_LINE_THRESHOLD;
  return countLines(text) > lineLimit || text.length > CHIP_CHAR_THRESHOLD;
}

function fp8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

/**
 * In-memory paste bodies keyed by chip number (TUI-DESIGN §4.5). One per composer, held in a `useRef` by O9; the
 * counter is monotonic for the store's lifetime so labels never collide within a session.
 */
export class PasteStore {
  private readonly blobs = new Map<number, PasteBlob>();
  private nextN = 1;
  private readonly maxBytes: number;

  constructor(opts: { maxBytes?: number; firstN?: number } = {}) {
    this.maxBytes = opts.maxBytes ?? PASTE_MAX_BYTES;
    if (opts.firstN !== undefined && Number.isInteger(opts.firstN) && opts.firstN > 0) this.nextN = opts.firstN;
  }

  /** Chips stored so far. */
  get size(): number {
    return this.blobs.size;
  }

  /**
   * Offer a raw paste (TUI-DESIGN §4.5 steps 2–4): normalise (tabs kept); `> 1 MiB` → `refused` with the toast and nothing
   * stored; over the chip thresholds → store the tab-exact body and return the `ChipRef` to insert; else plain `insert`
   * text with tabs expanded for the buffer (§4.1; one undo step). Thresholds and `bytes` are measured on the stored form.
   */
  accept(raw: string, opts: { rows: number }): PasteDecision {
    const rawBytes = Buffer.byteLength(raw, 'utf8');
    if (rawBytes > this.maxBytes) return { kind: 'refused', bytes: rawBytes, toast: pasteRefusedToast(rawBytes) };
    const text = normalisePaste(raw);
    if (text.length === 0) return { kind: 'empty' };
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.maxBytes) return { kind: 'refused', bytes, toast: pasteRefusedToast(bytes) };
    if (!shouldChip(text, opts.rows)) return { kind: 'insert', text: expandTabs(text) };
    const n = this.nextN++;
    const lines = countLines(text);
    const blob: PasteBlob = { text, lines, bytes, fp8: fp8(text) };
    this.blobs.set(n, blob);
    return { kind: 'chip', chip: { n, lines, bytes, label: chipLabel(n, lines) }, blob };
  }

  /** The body behind chip `n`, or undefined when it was never stored or not restored after `--resume`. */
  get(n: number): PasteBlob | undefined {
    return this.blobs.get(n);
  }

  has(n: number): boolean {
    return this.blobs.has(n);
  }

  /** Forget one body (the chip was deleted from the draft). */
  delete(n: number): boolean {
    return this.blobs.delete(n);
  }

  /** Forget every body (submit done, `/new`). The counter keeps counting so old labels in history stay unambiguous. */
  clear(): void {
    this.blobs.clear();
  }

  /** Reserve numbering above chips restored from `ui.json` so a new paste never reuses a label seen before (TUI-DESIGN §4.5, identity = `n` + `bytes`). */
  reserveAbove(n: number): void {
    if (Number.isInteger(n) && n >= this.nextN) this.nextN = n + 1;
  }

  /**
   * Replace every chip label in `text` with its body, in label order (TUI-DESIGN §4.5 step 5). A chip whose body is
   * missing (after `--resume`) cancels with `remove [Pasted #n] or paste again`; a `bytes` mismatch counts as missing.
   */
  expand(text: string, chips: readonly ChipRef[]): ExpandResult {
    if (chips.length === 0) return { ok: true, text };
    const ordered = [...chips].sort((a, b) => a.n - b.n);
    let out = text;
    for (const chip of ordered) {
      if (chip.label.length === 0 || !out.includes(chip.label)) continue;
      const blob = this.blobs.get(chip.n);
      if (blob === undefined || blob.bytes !== chip.bytes) return { ok: false, missing: chip, notice: missingChipNotice(chip.n) };
      out = out.split(chip.label).join(blob.text);
    }
    return { ok: true, text: out };
  }

  /**
   * History form of a draft (TUI-DESIGN §4.6, P58): every chip label becomes
   * `[Pasted #n: "<redacted first line ≤ 40>", k lines]` — no digest, no body; a chip without a body keeps its plain label.
   */
  labelsForHistory(text: string, chips: readonly ChipRef[], redact: (s: string) => string): string {
    if (chips.length === 0) return text;
    let out = text;
    for (const chip of chips) {
      if (chip.label.length === 0 || !out.includes(chip.label)) continue;
      const blob = this.blobs.get(chip.n);
      if (blob === undefined) continue;
      const nl = blob.text.indexOf('\n');
      const first = redact(nl === -1 ? blob.text : blob.text.slice(0, nl)).replace(/"/g, "'");
      const clipped = clipChars(first, HISTORY_LABEL_LINE_MAX);
      const label = `[Pasted #${chip.n}: "${clipped}", ${chip.lines} ${chip.lines === 1 ? 'line' : 'lines'}]`;
      out = out.split(chip.label).join(label);
    }
    return out;
  }
}

/** Clip to `max` code points (never splitting a surrogate pair), appending `…` when cut. */
function clipChars(s: string, max: number): string {
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  return cps.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** Parse `[Pasted #n, k lines]` labels out of a draft (TUI-DESIGN §4.5, §8.8: `ui.json` restore renders them as chips). */
export function parseChipLabels(text: string): { n: number; lines: number; label: string }[] {
  const out: { n: number; lines: number; label: string }[] = [];
  for (const m of text.matchAll(LABEL_RE)) out.push({ n: Number(m[1]), lines: Number(m[2]), label: m[0] });
  return out;
}
