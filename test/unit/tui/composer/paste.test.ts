/**
 * TUI-DESIGN §4.5, §10.3, §19.0 (`paste.test.ts`): chip thresholds (3 lines / 800 chars; 2 lines below rows 12), the
 * 1 MiB refusal toast verbatim, `fp8` only, normalisation, expansion in label order, missing-chip cancellation, history labels.
 */
import { describe, expect, it } from 'vitest';
import type { ChipRef } from '../../../../src/tui/composer/buffer.js';
import {
  CHIP_CHAR_THRESHOLD,
  CHIP_LINE_THRESHOLD,
  CHIP_LINE_THRESHOLD_SHORT,
  PASTE_MAX_BYTES,
  PasteStore,
  chipLabel,
  countLines,
  formatPasteSize,
  missingChipNotice,
  normalisePaste,
  parseChipLabels,
  pasteRefusedToast,
  shouldChip,
} from '../../../../src/tui/composer/paste.js';

const rows24 = { rows: 24 };

describe('thresholds', () => {
  it('> 3 lines or > 800 chars becomes a chip; the line threshold drops to 2 below rows 12', () => {
    expect(CHIP_LINE_THRESHOLD).toBe(3);
    expect(CHIP_LINE_THRESHOLD_SHORT).toBe(2);
    expect(CHIP_CHAR_THRESHOLD).toBe(800);
    expect(shouldChip('a\nb\nc', 24)).toBe(false);
    expect(shouldChip('a\nb\nc\nd', 24)).toBe(true);
    expect(shouldChip('a\nb\nc', 11)).toBe(true);
    expect(shouldChip('a\nb', 11)).toBe(false);
    expect(shouldChip('x'.repeat(800), 24)).toBe(false);
    expect(shouldChip('x'.repeat(801), 24)).toBe(true);
    expect(shouldChip('a\nb\nc\n', 24)).toBe(false); // trailing newline is not a fourth line
    expect(shouldChip('a\nb\nc', Number.NaN)).toBe(false);
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\n\nb')).toBe(3);
  });

  it('accept() returns insert text below the thresholds and a chip above, with the body only in the store', () => {
    const store = new PasteStore();
    const small = store.accept('hello\nworld', rows24);
    expect(small).toEqual({ kind: 'insert', text: 'hello\nworld' });
    const body = 'l1\nl2\nl3\nl4\nl5';
    const big = store.accept(body, rows24);
    expect(big.kind).toBe('chip');
    if (big.kind !== 'chip') return;
    expect(big.chip).toEqual({ n: 1, lines: 5, bytes: body.length, label: '[Pasted #1, 5 lines]' });
    expect(Object.keys(big.chip)).toEqual(['n', 'lines', 'bytes', 'label']); // no body, no digest on the ChipRef
    expect(big.blob.text).toBe(body);
    expect(big.blob.fp8).toMatch(/^[0-9a-f]{8}$/);
    expect(store.get(1)?.text).toBe(body);
    expect(store.size).toBe(1);
    // the chip label is one line: it keeps the composer in budget whatever the paste was
    expect(big.chip.label.includes('\n')).toBe(false);
  });

  it('numbers chips monotonically across clears and honours reserveAbove', () => {
    const store = new PasteStore();
    const a = store.accept('x'.repeat(900), rows24);
    store.clear();
    const b = store.accept('y'.repeat(900), rows24);
    expect(a.kind === 'chip' && a.chip.n).toBe(1);
    expect(b.kind === 'chip' && b.chip.n).toBe(2);
    store.reserveAbove(10);
    const c = store.accept('z'.repeat(900), rows24);
    expect(c.kind === 'chip' && c.chip.n).toBe(11);
    store.reserveAbove(3); // never goes backwards
    const d = store.accept('w'.repeat(900), rows24);
    expect(d.kind === 'chip' && d.chip.n).toBe(12);
    expect(new PasteStore({ firstN: 5 }).accept('q'.repeat(900), rows24)).toMatchObject({ chip: { n: 5 } });
  });

  it('a 64 KB paste becomes one chip with the right line count (A105)', () => {
    const store = new PasteStore();
    const body = 'line of text\r\n'.repeat(4681); // ≈ 64 KB with CRLF
    const r = store.accept(body, rows24);
    expect(r.kind).toBe('chip');
    if (r.kind !== 'chip') return;
    expect(r.chip.lines).toBe(4681);
    expect(r.blob.text.includes('\r')).toBe(false);
    expect(r.chip.bytes).toBe(Buffer.byteLength(r.blob.text, 'utf8'));
  });
});

describe('1 MiB refusal', () => {
  it('refuses > 1 MiB with the §24 toast and stores nothing', () => {
    const store = new PasteStore();
    const huge = 'a'.repeat(PASTE_MAX_BYTES + 1);
    const r = store.accept(huge, rows24);
    expect(r.kind).toBe('refused');
    expect(store.size).toBe(0);
    if (r.kind === 'refused') expect(r.toast).toBe('paste of 1.05 MB refused (limit 1 MiB); write it to a file and @-mention it');
    expect(pasteRefusedToast(3_200_000)).toBe('paste of 3.2 MB refused (limit 1 MiB); write it to a file and @-mention it');
    expect(pasteRefusedToast(12_000_000)).toBe('paste of 12 MB refused (limit 1 MiB); write it to a file and @-mention it');
    expect(formatPasteSize(1_048_577)).toBe('1.05 MB');
    expect(formatPasteSize(2048)).toBe('2 KB');
    expect(formatPasteSize(12)).toBe('12 B');
    expect(formatPasteSize(Number.NaN)).toBe('0 B');
    expect(formatPasteSize(-1)).toBe('0 B');
  });
  it('exactly 1 MiB is accepted; multi-byte text is measured in UTF-8 bytes', () => {
    const store = new PasteStore();
    expect(store.accept('a'.repeat(PASTE_MAX_BYTES), rows24).kind).toBe('chip');
    const cjk = '日'.repeat(Math.floor(PASTE_MAX_BYTES / 3) + 1); // 3 bytes each → just over
    expect(store.accept(cjk, rows24).kind).toBe('refused');
    expect(new PasteStore({ maxBytes: 10 }).accept('0123456789ab', rows24).kind).toBe('refused');
  });
});

describe('normalisation (step 2)', () => {
  it('CRLF/CR → LF, C0/C1 minus \\n\\t dropped, tabs KEPT, bidi stripped, U+2028/2029 → LF, NFC', () => {
    expect(normalisePaste('a\r\nb\rc')).toBe('a\nb\nc');
    expect(normalisePaste('x\u0007y\u001b[31mz')).toBe('xy[31mz');
    expect(normalisePaste('a\tb')).toBe('a\tb'); // §4.5 step 2: sanitizeStream minus \n\t — a body is never re-indented
    expect(normalisePaste('\u202eabc\u202c')).toBe('abc');
    expect(normalisePaste('a\u2028b')).toBe('a\nb');
    expect(normalisePaste('e\u0301')).toBe('é'); // NFC composes
    expect(normalisePaste('')).toBe('');
    expect(new PasteStore().accept('\u0007\u0000', rows24)).toEqual({ kind: 'empty' });
  });

  it('a chip body keeps its tabs byte-exact (Makefile), `bytes` matches the tab-bearing body and expand restores it verbatim', () => {
    const store = new PasteStore();
    const makefile = 'all:\n\tgo build ./...\n\ttest\n\tlint\n';
    const r = store.accept(makefile, rows24);
    expect(r.kind).toBe('chip');
    if (r.kind !== 'chip') return;
    expect(r.blob.text).toBe(makefile);
    expect(r.blob.text.includes('\t')).toBe(true);
    expect(r.blob.text.includes('    ')).toBe(false);
    expect(r.chip.bytes).toBe(Buffer.byteLength(makefile, 'utf8'));
    expect(r.chip.lines).toBe(4);
    expect(store.expand(`build it: ${r.chip.label}`, [r.chip])).toEqual({ ok: true, text: `build it: ${makefile}` });
    // a TSV row with CRLF: line endings normalised, tabs untouched
    const tsv = store.accept('a\tb\tc\r\n1\t2\t3\r\n4\t5\t6\r\n7\t8\t9', rows24);
    if (tsv.kind !== 'chip') throw new Error('expected chip');
    expect(tsv.blob.text).toBe('a\tb\tc\n1\t2\t3\n4\t5\t6\n7\t8\t9');
  });

  it('a paste below the thresholds is inserted into the buffer with tabs expanded (§4.1 buffer rule), not the body form', () => {
    const store = new PasteStore();
    expect(store.accept('a\tb', rows24)).toEqual({ kind: 'insert', text: 'a    b' });
    expect(store.accept('x\r\n\ty', rows24)).toEqual({ kind: 'insert', text: 'x\n    y' });
    expect(store.size).toBe(0);
  });
});

describe('expand (step 5)', () => {
  const chipsOf = (store: PasteStore, bodies: string[]): ChipRef[] =>
    bodies.map((b) => {
      const r = store.accept(b, rows24);
      if (r.kind !== 'chip') throw new Error('expected chip');
      return r.chip;
    });

  it('replaces every label with its body in label order and leaves other text alone', () => {
    const store = new PasteStore();
    const [c1, c2] = chipsOf(store, ['A\nB\nC\nD', 'E\nF\nG\nH']);
    if (c1 === undefined || c2 === undefined) throw new Error('chips');
    const draft = `first ${c2.label} then ${c1.label} end`;
    expect(store.expand(draft, [c2, c1])).toEqual({ ok: true, text: 'first E\nF\nG\nH then A\nB\nC\nD end' });
    expect(store.expand('no chips here', [c1])).toEqual({ ok: true, text: 'no chips here' });
    expect(store.expand('plain', [])).toEqual({ ok: true, text: 'plain' });
  });

  it('cancels with the §24 notice when a body is missing (after --resume) or its bytes differ', () => {
    const store = new PasteStore();
    const [c1] = chipsOf(store, ['A\nB\nC\nD']);
    if (c1 === undefined) throw new Error('chip');
    const ghost: ChipRef = { n: 7, lines: 120, bytes: 4096, label: chipLabel(7, 120) };
    expect(store.expand(`${c1.label} ${ghost.label}`, [c1, ghost])).toEqual({ ok: false, missing: ghost, notice: 'remove [Pasted #7] or paste again' });
    expect(missingChipNotice(1)).toBe('remove [Pasted #1] or paste again');
    const mismatched: ChipRef = { ...c1, bytes: c1.bytes + 1 };
    expect(store.expand(c1.label, [mismatched]).ok).toBe(false);
    store.delete(c1.n);
    expect(store.expand(c1.label, [c1]).ok).toBe(false);
    expect(store.has(c1.n)).toBe(false);
  });
});

describe('history labels (§4.6, P58)', () => {
  it('rewrites chip labels to `[Pasted #n: "<redacted first line ≤ 40>", k lines]` with no digest or body', () => {
    const store = new PasteStore();
    const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
    const r = store.accept(`token ${secret} "quoted"\nline2\nline3\nline4`, rows24);
    if (r.kind !== 'chip') throw new Error('chip');
    const redact = (s: string): string => s.replace(secret, '[REDACTED:pattern]');
    const out = store.labelsForHistory(`please look ${r.chip.label} thanks`, [r.chip], redact);
    expect(out).toBe(`please look [Pasted #1: "token [REDACTED:pattern] 'quoted'", 4 lines] thanks`);
    expect(out.includes(secret)).toBe(false);
    expect(out.includes(r.blob.fp8)).toBe(false);
    expect(out.includes('line2')).toBe(false);
  });
  it('clips the first line to 40 code points with … and keeps a bodiless chip label as is', () => {
    const store = new PasteStore();
    const first = '日本語'.repeat(20);
    const r = store.accept(`${first}\nb\nc\nd`, rows24);
    if (r.kind !== 'chip') throw new Error('chip');
    const out = store.labelsForHistory(r.chip.label, [r.chip], (s) => s);
    const m = /^\[Pasted #1: "(.*)", 4 lines\]$/.exec(out);
    expect(m).not.toBeNull();
    expect(Array.from(m?.[1] ?? '').length).toBe(40);
    expect(m?.[1]?.endsWith('…')).toBe(true);
    const ghost: ChipRef = { n: 9, lines: 2, bytes: 10, label: chipLabel(9, 2) };
    expect(store.labelsForHistory(`x ${ghost.label}`, [ghost], (s) => s)).toBe(`x ${ghost.label}`);
    expect(chipLabel(3, 1)).toBe('[Pasted #3, 1 line]');
  });
});

describe('parseChipLabels', () => {
  it('finds labels and their numbers', () => {
    expect(parseChipLabels('a [Pasted #2, 10 lines] b [Pasted #7, 1 line]')).toEqual([
      { n: 2, lines: 10, label: '[Pasted #2, 10 lines]' },
      { n: 7, lines: 1, label: '[Pasted #7, 1 line]' },
    ]);
    expect(parseChipLabels('none')).toEqual([]);
  });
});
