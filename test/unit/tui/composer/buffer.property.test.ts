/**
 * TUI-DESIGN §19.2 (A106): mulberry32-seeded fuzzer over the buffer-op alphabet with `Intl.Segmenter` as the oracle.
 * Invariants after every op: cursor on a grapheme boundary and outside every chip; text === graphemes.join('') with no
 * control chars; stacks and ring within their caps; `layoutRows(text).join` equals the text modulo wraps; the rendered
 * cursor equals the summed widths; render is pure. Identities: insert+backspace, kill+undo, paste = one undo step,
 * undo(redo(x)) == x. 500 random ops per seed (5,000 iterations in the main run); shrink by prefix replay; the seed is printed on failure.
 */
import { describe, expect, it } from 'vitest';
import { RETIRED_MAX, bufferAtoms, createBuffer, reduceBuffer, snapshotOf, type BufferAction, type ChipRef, type Motion, type TextBuffer } from '../../../../src/tui/composer/buffer.js';
import { filterInput } from '../../../../src/tui/composer/filter.js';
import { KILL_RING_MAX } from '../../../../src/tui/composer/killring.js';
import { cursorToRowX, layoutRows, textUnits, type Row } from '../../../../src/tui/composer/rows.js';
import { stringWidth } from '../../../../src/tui/composer/width.js';
import { CONTROL_OR_BIDI_RE, INSERT_POOL, graphemes, legalBoundaries, mulberry32, pick } from './helpers.js';

const MOTIONS: readonly Motion[] = ['left', 'right', 'up', 'down', 'home', 'end', 'wordLeft', 'wordRight', 'start', 'finish'];
const KILLS = ['toEnd', 'toStart', 'wordBack', 'wordForward'] as const;
const LEAKS = ['[I', '[O', '[24;80R', '[27;2;13~', '[?0u', '[?62;22c', '[<64;10;5M', ']11;rgb:1e1e/1e1e/1e1e', '\\', '\u001b[A', '\u001bx', '\u001a', '\u001f'];
const HISTORY = ['first prompt', 'fix the test in src/a.ts', '日本語の質問', 'emoji 👍 steer', '/diff'];

interface Op {
  readonly action: BufferAction;
  readonly nowMs: number;
  readonly label: string;
}

function randomOp(r: () => number, step: number, chipN: { n: number }): Op {
  const roll = r();
  const nowMs = step * (r() < 0.1 ? 3000 : 50); // mostly fast typing, sometimes a 3 s pause
  if (roll < 0.32) return { action: { type: 'insert', text: pick(r, INSERT_POOL) }, nowMs, label: 'insert' };
  if (roll < 0.38) {
    let text = '';
    const n = 1 + Math.floor(r() * 30);
    for (let i = 0; i < n; i++) text += r() < 0.15 ? '\r\n' : r() < 0.05 ? '\t' : pick(r, INSERT_POOL);
    return { action: { type: 'insert', text, paste: true }, nowMs, label: 'paste' };
  }
  if (roll < 0.41) return { action: { type: 'newline' }, nowMs, label: 'newline' };
  if (roll < 0.5) return { action: { type: 'backspace' }, nowMs, label: 'backspace' };
  if (roll < 0.55) return { action: { type: 'delete' }, nowMs, label: 'delete' };
  if (roll < 0.7) return { action: { type: 'move', to: pick(r, MOTIONS), columns: 3 + Math.floor(r() * 60) }, nowMs, label: 'move' };
  if (roll < 0.76) return { action: { type: 'kill', what: pick(r, KILLS) }, nowMs, label: 'kill' };
  if (roll < 0.79) return { action: { type: 'yank' }, nowMs, label: 'yank' };
  if (roll < 0.81) return { action: { type: 'yankPop' }, nowMs, label: 'yankPop' };
  if (roll < 0.83) return { action: { type: 'transpose' }, nowMs, label: 'transpose' };
  if (roll < 0.87) return { action: { type: 'undo' }, nowMs, label: 'undo' };
  if (roll < 0.9) return { action: { type: 'redo' }, nowMs, label: 'redo' };
  if (roll < 0.92) {
    const n = chipN.n++;
    const chip: ChipRef = { n, lines: 4 + n, bytes: 900 + n, label: `[Pasted #${n}, ${4 + n} lines]` };
    return { action: { type: 'chip', chip }, nowMs, label: 'chip' };
  }
  if (roll < 0.95) return { action: { type: 'history', dir: r() < 0.6 ? 1 : -1, entries: HISTORY }, nowMs, label: 'history' };
  if (roll < 0.96) return { action: { type: 'historyFilter', filter: r() < 0.5 ? 'all' : 'workspace' }, nowMs, label: 'historyFilter' };
  if (roll < 0.97) return { action: { type: 'clear' }, nowMs, label: 'clear' };
  if (roll < 0.98) return { action: { type: 'setText', text: pick(r, HISTORY), pushUndo: r() < 0.5 }, nowMs, label: 'setText' };
  // raw parse-keypress leak-through routed through the filter: inserted only when the filter says text
  const leak = pick(r, LEAKS);
  const f = filterInput(leak);
  return { action: f.ok ? { type: 'insert', text: f.text } : { type: 'move', to: 'right', columns: 40 }, nowMs, label: `raw:${JSON.stringify(leak)}` };
}

function checkInvariants(b: TextBuffer, columns: number): void {
  const atoms = bufferAtoms(b);
  const bs = legalBoundaries(b.text, atoms);
  if (!bs.has(b.cursor)) throw new Error(`cursor ${b.cursor} not on a grapheme boundary of ${JSON.stringify(b.text)}`);
  if (graphemes(b.text).join('') !== b.text) throw new Error('graphemes.join !== text');
  if (CONTROL_OR_BIDI_RE.test(b.text)) throw new Error(`control char in text ${JSON.stringify(b.text)}`);
  if (/\r/.test(b.text)) throw new Error('CR in text');
  for (const a of atoms) {
    if (b.cursor > a.start && b.cursor < a.end) throw new Error(`cursor ${b.cursor} inside chip ${a.start}-${a.end}`);
  }
  for (const c of b.chips) if (!b.text.includes(c.label)) throw new Error(`chip ${c.label} has no label in text`);
  for (const c of b.retired) {
    if (b.text.includes(c.label)) throw new Error(`retired chip ${c.label} is still in the text`);
    if (b.chips.some((l) => l.n === c.n)) throw new Error(`chip #${c.n} is both live and retired`);
  }
  if (b.retired.length > RETIRED_MAX) throw new Error('retired over cap');
  if (new Set(b.chips.map((c) => c.n)).size !== b.chips.length) throw new Error('duplicate live chip');
  if (b.undo.length > 100 || b.redo.length > 100) throw new Error('undo/redo over cap');
  if (b.killRing.length > KILL_RING_MAX) throw new Error('kill ring over cap');
  if (b.yankIndex !== null && (b.yankIndex < 0 || b.yankIndex >= b.killRing.length)) throw new Error('yankIndex out of range');
  const rows: Row[] = layoutRows(b.text, columns, 2, { atoms });
  const again = layoutRows(b.text, columns, 2, { atoms });
  if (JSON.stringify(rows) !== JSON.stringify(again)) throw new Error('layoutRows is not pure');
  let joined = '';
  rows.forEach((row, i) => {
    joined += b.text.slice(row.start, row.end);
    if (row.hard && i < rows.length - 1) joined += '\n';
  });
  if (joined !== b.text) throw new Error('layoutRows rows do not partition the text');
  const width = Math.max(1, columns - 2);
  for (const row of rows) {
    if (!bs.has(row.start) || !bs.has(row.end)) throw new Error(`row ${row.start}-${row.end} splits a grapheme`);
    for (const a of atoms) if ((row.start > a.start && row.start < a.end) || (row.end > a.start && row.end < a.end)) throw new Error('row splits a chip');
    if (row.cells > width) {
      const units = textUnits(b.text, row.start, row.end, atoms);
      if (units.filter((u) => u.cells > 0).length !== 1) throw new Error(`row width ${row.cells} > ${width}`);
    }
  }
  const { row, x } = cursorToRowX(rows, b.text, b.cursor);
  const rr = rows[row];
  if (rr === undefined) throw new Error('cursor row missing');
  if (x !== stringWidth(b.text.slice(rr.start, b.cursor))) throw new Error('rendered cursor x != summed widths');
}

/** Replays `ops[0..n)` from a fresh buffer; returns the buffer or throws the first invariant violation. */
function replay(ops: readonly Op[], n: number, columns: number, extra?: (before: TextBuffer, op: Op, after: TextBuffer) => void): TextBuffer {
  let b = createBuffer();
  for (let i = 0; i < n; i++) {
    const op = ops[i];
    if (op === undefined) break;
    const before = b;
    b = reduceBuffer(b, op.action, op.nowMs);
    checkInvariants(b, columns);
    extra?.(before, op, b);
  }
  return b;
}

function shrink(ops: readonly Op[], columns: number, extra?: (before: TextBuffer, op: Op, after: TextBuffer) => void): number {
  let lo = 1;
  let hi = ops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      replay(ops, mid, columns, extra);
      lo = mid + 1;
    } catch {
      hi = mid;
    }
  }
  return lo;
}

function fuzz(seed: number, count: number, extra?: (before: TextBuffer, op: Op, after: TextBuffer) => void): void {
  const r = mulberry32(seed);
  const columns = 3 + Math.floor(r() * 70);
  const chipN = { n: 1 };
  const ops: Op[] = [];
  for (let i = 0; i < count; i++) ops.push(randomOp(r, i, chipN));
  try {
    replay(ops, ops.length, columns, extra);
  } catch (e) {
    const n = shrink(ops, columns, extra);
    const tail = ops.slice(Math.max(0, n - 6), n).map((o) => o.label).join(' → ');
    throw new Error(`seed ${seed} (columns ${columns}): ${(e as Error).message}; shortest failing prefix ${n} ops, ending: ${tail}`);
  }
}

/** True when `g` neither attaches to a preceding base nor absorbs a following one, per the segmenter oracle. */
const standsAlone = (g: string): boolean => graphemes(g).length === 1 && graphemes('a' + g).length === 2 && graphemes(g + 'a').length === 2;
const standalone = INSERT_POOL.filter(standsAlone);

describe('buffer property tests (A106)', () => {
  it('500 random ops × 10 seeds (5,000 iterations) keep every invariant', () => {
    const t0 = performance.now();
    for (let seed = 1; seed <= 10; seed++) fuzz(seed, 500);
    const ms = performance.now() - t0;
    process.stdout.write(`[measured] fuzz 10 × 500 ops with full invariant checks: ${ms.toFixed(0)} ms\n`);
    expect(ms).toBeLessThan(6000); // design: < 2 s per file on an idle machine; 3× headroom
  });

  it('insert + backspace is the identity for a standalone grapheme at a non-joining position', () => {
    const r = mulberry32(777);
    fuzz(777, 300, (_before, _op, after) => {
      const g = pick(r, standalone);
      const before = graphemes(after.text.slice(0, after.cursor));
      const following = graphemes(after.text.slice(after.cursor));
      const prevG = before[before.length - 1] ?? '';
      const nextG = following[0] ?? '';
      // skip positions where the oracle says the neighbours would join with `g` (or with each other once `g` sits between them)
      if (prevG !== '' && graphemes(prevG + g).length !== 2) return;
      if (nextG !== '' && graphemes(g + nextG).length !== 2) return;
      if (nextG !== '' && prevG !== '' && graphemes(prevG + g + nextG).length !== 3) return;
      const inserted = reduceBuffer(after, { type: 'insert', text: g }, 0);
      const back = reduceBuffer(inserted, { type: 'backspace' }, 0);
      if (back.text !== after.text || back.cursor !== after.cursor) {
        throw new Error(`insert(${JSON.stringify(g)})+backspace changed ${JSON.stringify(after.text)}@${after.cursor} → ${JSON.stringify(back.text)}@${back.cursor}`);
      }
    });
  });

  it('kill + undo and paste + undo restore text and cursor; a paste is exactly one undo step', () => {
    fuzz(4242, 400, (before, op, after) => {
      if (op.label === 'kill' && after.text !== before.text) {
        const undone = reduceBuffer(after, { type: 'undo' }, 0);
        if (undone.text !== before.text || undone.cursor !== before.cursor) throw new Error(`kill+undo mismatch: ${JSON.stringify(before.text)} vs ${JSON.stringify(undone.text)}`);
      }
      if (op.label === 'paste' && after.text !== before.text) {
        if (after.undo.length !== Math.min(100, before.undo.length + 1)) throw new Error('paste pushed more than one undo step');
        const undone = reduceBuffer(after, { type: 'undo' }, 0);
        if (undone.text !== before.text || undone.cursor !== before.cursor) throw new Error('paste+undo mismatch');
      }
    });
  });

  it('undo(redo(x)) == x whenever a redo exists', () => {
    fuzz(1313, 400, (_before, _op, x) => {
      if (x.redo.length === 0) return;
      const y = reduceBuffer(x, { type: 'redo' }, 0);
      const z = reduceBuffer(y, { type: 'undo' }, 0);
      if (JSON.stringify(snapshotOf(z)) !== JSON.stringify(snapshotOf(x))) throw new Error(`undo(redo(x)) != x: ${JSON.stringify(x.text)} vs ${JSON.stringify(z.text)}`);
      if (z.undo.length !== x.undo.length || z.redo.length !== x.redo.length) throw new Error('undo/redo stack sizes changed');
    });
  });

  it('chips stay atomic under every op and their ChipRefs track the labels', () => {
    fuzz(999, 400, (_before, _op, after) => {
      for (const a of bufferAtoms(after)) {
        for (const m of MOTIONS) {
          const moved = reduceBuffer({ ...after, cursor: a.start }, { type: 'move', to: m, columns: 30 }, 0);
          if (moved.cursor > a.start && moved.cursor < a.end) throw new Error(`motion ${m} landed inside a chip`);
        }
      }
    });
  });

  it('a chip label that leaves the text through kill or delete and returns through yank/yankPop/undo is a chip again (never plain text)', () => {
    fuzz(2718, 400, (before, op, after) => {
      if (!['kill', 'yank', 'yankPop', 'undo', 'redo', 'backspace', 'delete'].includes(op.label)) return;
      const known = [...before.chips, ...before.retired];
      for (const c of known) {
        const inText = after.text.includes(c.label);
        const live = after.chips.some((l) => l.n === c.n);
        const retired = after.retired.some((l) => l.n === c.n);
        if (inText && !live) throw new Error(`label ${c.label} present after ${op.label} but the ChipRef is not live`);
        if (!inText && live) throw new Error(`ChipRef #${c.n} live after ${op.label} without its label`);
        if (!inText && !retired && before.retired.length < RETIRED_MAX) throw new Error(`ChipRef #${c.n} lost after ${op.label}`);
      }
    });
  });

  it('the shrinker reports the shortest failing prefix and the seed (self-test against a deliberately broken invariant)', () => {
    let calls = 0;
    expect(() =>
      fuzz(5, 200, (_b, _o, after) => {
        calls++;
        if (after.text.length > 30) throw new Error('synthetic');
      }),
    ).toThrow(/seed 5 \(columns \d+\): synthetic; shortest failing prefix \d+ ops, ending: /);
    expect(calls).toBeGreaterThan(0);
  });
});
