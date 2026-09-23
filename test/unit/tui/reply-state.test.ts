/**
 * AGENT-LOOP-DESIGN §9.3–§9.4 (slice S5a; TUI map top change 6): the reply's pure model — the prefix-stable prose wrap,
 * the light markdown, and the commit bookkeeping. The property the zero-jump claim rests on: for random texts cut into
 * random chunks, committed at the shaper's line boundaries and by random overflow commits, the committed items draw
 * exactly the rows of the finished text, blank lines included, every character once.
 */
import { describe, expect, it } from 'vitest';
import { stringWidth } from '../../../src/tui/composer/width.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import type { TranscriptItem } from '../../../src/tui/plain.js';
import { EMPTY_REPLY, commitCut, commitOverflow, commitThrough, pendingItems, pendingLines, pendingRows, proseLayout, proseLayoutRows, type ReplyState } from '../../../src/tui/reply-state.js';
import { fenceDisplay, holdBack, isFenceLine, parseProse, proseRowText, proseRows, type ProseRole } from '../../../src/tui/transcript/markdown.js';
import { wrapCells, wrapProse } from '../../../src/tui/transcript/wrap.js';
import { randomChunks } from './agent-fixtures.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = ['the', 'parser', 'reads', 'a', 'token', '**bold**', '`code`', 'value,', 'and', 'then', 'folds', 'it.', '日本語', 'café', 'x', 'supercalifragilisticexpialidocious_identifier_name', '👍', '→', 'item', '(3)', '—'];

/** A random reply: paragraphs, blank lines, bullets, a numbered item, a heading, and sometimes a fenced block. */
function randomText(r: () => number): string {
  const lines: string[] = [];
  const n = 1 + Math.floor(r() * 9);
  for (let i = 0; i < n; i++) {
    const kind = r();
    if (kind < 0.12) lines.push('');
    else if (kind < 0.22 && lines.every((l) => !isFenceLine(l))) {
      lines.push('```ts', 'const x = parse("1 + 2");', '  return   x;', '```');
    } else {
      const words = Array.from({ length: 1 + Math.floor(r() * 30) }, () => VOCAB[Math.floor(r() * VOCAB.length)]!);
      const lead = kind < 0.35 ? '- ' : kind < 0.42 ? '  * ' : kind < 0.46 ? '1. ' : kind < 0.5 ? '## ' : '';
      lines.push(lead + words.join(' '));
    }
  }
  return lines.join('\n');
}

/** The lines of a finished text: a text that ends with its newline has no final partial line. */
function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/** The rows the finished text draws, line by line (fence state tracked), at a body width. */
function referenceRows(text: string, width: number): string[] {
  let fence = false;
  const out: string[] = [];
  for (const line of linesOf(text)) {
    const role: ProseRole = isFenceLine(line) ? 'fence' : fence ? 'code' : 'text';
    if (role === 'fence') fence = !fence;
    out.push(...proseRows(line, role, width).map(proseRowText));
  }
  return out;
}

/** The body rows a list of committed items draws. */
function committedRows(items: readonly TranscriptItem[], columns: number): string[] {
  const out: string[] = [];
  let prev: TranscriptItem | null = null;
  for (const it of items) {
    out.push(...proseLayout(it, prev, columns).rows.map(proseRowText));
    prev = it;
  }
  return out;
}

describe('wrapProse: greedy, grapheme-aware, prefix-stable', () => {
  it('rows fit the width in cells, and every row of a prefix except its last is a row of the whole text', () => {
    const r = rng(7);
    for (let n = 0; n < 300; n++) {
      const text = randomText(r).replace(/\n/g, ' ');
      const w = 8 + Math.floor(r() * 70);
      const full = wrapProse(text, w, 2);
      for (const row of full.rows) expect(stringWidth(row), `${JSON.stringify(text)} @${w}`).toBeLessThanOrEqual(w);
      const cut = Math.floor(r() * text.length);
      const pre = wrapProse(text.slice(0, cut), w, 2);
      for (let i = 0; i < pre.rows.length - 1; i++) expect(pre.rows[i], `prefix row ${i} of ${JSON.stringify(text.slice(0, cut))} @${w}`).toBe(full.rows[i]);
    }
  });

  it('the source ranges cover the text: re-wrapping from any row start (as a continuation) draws the remaining rows (an overflow cut is exact)', () => {
    const r = rng(11);
    for (let n = 0; n < 200; n++) {
      const text = randomText(r).replace(/\n/g, ' ');
      const w = 10 + Math.floor(r() * 60);
      const full = wrapProse(text, w, 3);
      for (let k = 1; k < full.rows.length; k++) {
        const tail = wrapProse(text.slice(full.starts[k]!), w, 3, true);
        expect(tail.rows, `cut at row ${k} of ${JSON.stringify(text)} @${w}`).toEqual(full.rows.slice(k));
      }
      // and a head cut by rows is the whole line's first rows (proseRows keeps the rows that START before `to`), a
      // continuation from that row start its remaining rows
      const all = proseRows(text, 'text', w);
      if (all.length > 1) {
        const k = 1 + Math.floor(r() * (all.length - 1));
        const head = proseRows(text, 'text', w, { to: all[k]!.start });
        const rest = proseRows(text, 'text', w, { from: all[k]!.start });
        expect([...head, ...rest].map(proseRowText), `head/rest at ${k}`).toEqual(all.map(proseRowText));
      }
    }
  });

  it('keeps row 0 indentation, hangs continuations, cuts an over-wide token by grapheme, and an empty text is one empty row', () => {
    expect(wrapProse('', 10).rows).toEqual(['']);
    expect(wrapProse('  indented words here', 12).rows).toEqual(['  indented', 'words here']);
    expect(wrapProse('• one two three four', 10, 2).rows).toEqual(['• one two', '  three', '  four']);
    expect(wrapProse('abcdefghijkl', 5).rows).toEqual(['abcde', 'fghij', 'kl']);
    expect(wrapProse('日本語日本語', 4).rows).toEqual(['日本', '語日', '本語']);
    expect(wrapCells('  x = 1;   // a comment', 10).rows).toEqual(['  x = 1;  ', ' // a comm', 'ent']);
  });

  it('an indentation wider than the row keeps only what fits: every row stays within the width', () => {
    const w = wrapProse('          x y', 5);
    for (const row of w.rows) expect(stringWidth(row)).toBeLessThanOrEqual(5);
    expect(w.rows).toEqual(['    x', 'y']);
    // prefix-stable: the indentation alone draws the same first row start
    expect(wrapProse('          ', 5).starts[0]).toBe(w.starts[0]);
    for (const width of [1, 2, 3, 8]) for (const row of wrapProse(`${' '.repeat(12)}alpha beta`, width).rows) expect(stringWidth(row)).toBeLessThanOrEqual(width);
  });
});

describe('light markdown: the same rows live and committed', () => {
  it('bold and inline code hide their markers; bullets become • and hang; a heading is bold; a fence line is the legacy fence row', () => {
    const p = parseProse('use **bold** and `x + 1` here', 'text');
    expect(p.display).toBe('use bold and x + 1 here');
    expect(p.runs.find((x) => x.style === 'bold')).toEqual({ from: 4, to: 8, style: 'bold' });
    expect(p.runs.find((x) => x.style === 'code')).toEqual({ from: 13, to: 18, style: 'code' });
    const b = parseProse('- first item', 'text');
    expect(b.display).toBe(`${GLYPHS.unicode.bullet} first item`);
    expect(b.hang).toBe(2);
    expect(parseProse('**bold** alone', 'text').display).toBe('bold alone');
    expect(parseProse('## Heading', 'text').runs.every((x) => x.style === 'heading')).toBe(true);
    expect(parseProse('```ts', 'fence').display).toBe(fenceDisplay('```ts'));
    expect(fenceDisplay('```python')).toBe('╶──── python');
    expect(parseProse('  a  b', 'code').display).toBe('  a  b');
  });

  it('a toggle stays open to the end of a line, so a partial line is a prefix of the finished one; a trailing `*` and a trailing emoji wait', () => {
    expect(parseProse('say **hel', 'text').display).toBe('say hel');
    expect(parseProse('say **hello** now', 'text').display.startsWith('say hel')).toBe(true);
    expect(holdBack('2 *')).toBe('2 ');
    expect(holdBack('2 **')).toBe('2 **');
    expect(holdBack('ok 👍')).toBe('ok ');
    expect(parseProse('ok 👍', 'text', GLYPHS.unicode, true).display).toBe('ok ');
    expect(parseProse('ok 👍', 'text').display).toBe('ok 👍');
  });
});

describe('the reply model: random texts, random chunks, random overflow — the committed rows are the finished rows', () => {
  it('commits at the shaper\'s line boundaries plus random overflow commits draw exactly the reference rows, blank lines kept', () => {
    const r = rng(2026);
    for (let n = 0; n < 250; n++) {
      const text = randomText(r);
      const columns = 24 + Math.floor(r() * 90);
      const chunks = randomChunks(text, n, 14);
      let live = '';
      let reply: ReplyState = EMPTY_REPLY;
      let seq = 0;
      const items: TranscriptItem[] = [];
      let prev: TranscriptItem | null = null;
      const fenceOpen = (s: string): boolean => s.split('\n').filter((l) => isFenceLine(l)).length % 2 === 1;
      let shaped = '';
      for (const c of chunks) {
        live += c;
        shaped += c;
        // a random overflow cap (the block's rows), sometimes tiny
        if (r() < 0.5) {
          const cap = 1 + Math.floor(r() * 6);
          const o = commitOverflow(live, reply, { rows: cap, columns }, prev, 1, seq);
          if (o !== null) {
            items.push(...o.items);
            reply = o.reply;
            seq = o.seq;
            prev = items.at(-1) ?? prev;
            // after an overflow commit the block fits its cap
            expect(pendingRows(pendingItems(live, reply, 1), prev, columns), `cap ${cap}`).toBeLessThanOrEqual(Math.max(cap, 1) + 2);
          }
        }
        // the shaper's line commit: through the last newline when no fence is open
        const cut = shaped.lastIndexOf('\n');
        if (cut >= 0 && !fenceOpen(shaped.slice(0, cut + 1))) {
          const t = commitThrough(live, reply, commitCut(live, false), 1, seq);
          items.push(...t.items);
          reply = t.reply;
          seq = t.seq;
          live = t.live;
          shaped = shaped.slice(cut + 1);
          prev = items.at(-1) ?? prev;
        }
      }
      const f = commitThrough(live, reply, commitCut(live, true), 1, seq);
      items.push(...f.items);
      const width = proseLayout(items[0] ?? { key: 'x', seq: 0, step: 1, kind: 'chat', level: 'info', text: '', label: '[jevcode]' }, null, columns).width;
      expect(committedRows(items, columns), `${JSON.stringify(text)} @${columns}`).toEqual(referenceRows(text, width));
      // blank lines are kept: one committed blank item per blank source line outside a fence
      const blanks = linesOf(text).filter((l) => l === '').length;
      expect(items.filter((i) => i.prose !== undefined && i.prose.line === '' && (i.prose.from ?? 0) === 0).length).toBe(blanks);
      // keys are unique
      expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    }
  });

  it('pendingLines: an empty partial line is not drawn; the first line starts at the overflow offset; roles follow the fence', () => {
    expect(pendingLines('abc\n', EMPTY_REPLY).map((p) => [p.line, p.partial])).toEqual([['abc', false]]);
    expect(pendingLines('abc\nde', EMPTY_REPLY).map((p) => [p.line, p.partial])).toEqual([
      ['abc', false],
      ['de', true],
    ]);
    expect(pendingLines('```\nx = 1\n', EMPTY_REPLY).map((p) => p.role)).toEqual(['fence', 'code']);
    expect(pendingLines('long line', { done: 0, offset: 5, fence: false })[0]!.from).toBe(5);
    expect(pendingLines('', EMPTY_REPLY)).toEqual([]);
  });

  it('commitThrough keeps the text after the cut in the buffer (not a clear) and carries the fence state', () => {
    const c = commitThrough('line one\n```js\nconst a = 1;\n```\npartial', EMPTY_REPLY, commitCut('line one\n```js\nconst a = 1;\n```\npartial', false), 3, 10);
    expect(c.live).toBe('partial');
    expect(c.items.map((i) => [i.text, i.prose?.role])).toEqual([
      ['line one', 'text'],
      ['```js', 'fence'],
      ['const a = 1;', 'code'],
      ['```', 'fence'],
    ]);
    expect(c.reply.fence).toBe(false);
    expect(c.items.map((i) => i.key)).toEqual(['3:chat:10', '3:chat:11', '3:chat:12', '3:chat:13']);
    expect(c.seq).toBe(14);
  });

  it('a committed line is redacted at the format-pattern layer (a key split across deltas never lands in the scrollback)', () => {
    const key = `sk-or-v1-${'a'.repeat(64)}`;
    const c = commitThrough(`my key is ${key}\n`, EMPTY_REPLY, commitCut(`my key is ${key}\n`, false), 1, 0);
    expect(c.items[0]!.text).not.toContain(key);
  });

  it('a paragraph that first outgrows the block by its spacer alone commits the spacer WITH a body row (no tail-cut jump)', () => {
    const you: TranscriptItem = { key: 'y', seq: 0, step: null, kind: 'chat', level: 'info', text: 'tell me', label: '[you]' };
    const para = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const items = pendingItems(para, EMPTY_REPLY, 1);
    const l = proseLayout(items[0]!, you, 80);
    expect(l.spacer).toBe(true);
    // the cap is the body rows: the spacer alone is the excess
    const c = commitOverflow(para, EMPTY_REPLY, { rows: l.rows.length, columns: 80 }, you, 1, 0);
    expect(c).not.toBeNull();
    expect(c!.items).toHaveLength(1);
    expect(c!.items[0]!.prose?.to).toBe(l.rows[1]!.start);
    expect(c!.reply.offset).toBe(l.rows[1]!.start);
    // the rest fits the cap with a row to spare — nothing was tail-cut
    expect(pendingRows(pendingItems(para, c!.reply, 1), c!.items[0]!, 80)).toBe(l.rows.length - 1);
    // a complete one-row line that cannot be cut goes whole
    const two = 'short line\nstill streaming';
    const d = commitOverflow(two, EMPTY_REPLY, { rows: 2, columns: 80 }, you, 1, 0);
    expect(d?.items.map((i) => i.text)).toEqual(['short line']);
  });

  it('a key on an overflowing line: live rows, cut offsets and committed rows are one (redacted) text — words are never split', () => {
    const key = `ghp_${'A'.repeat(36)}`;
    const line = `alpha beta gamma delta ${key} epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega`;
    const drawn = pendingItems(line, EMPTY_REPLY, 1);
    expect(drawn[0]!.prose?.line).not.toContain(key);
    const c = commitOverflow(line, EMPTY_REPLY, { rows: 1, columns: 60 }, null, 1, 0);
    expect(c).not.toBeNull();
    const rest = pendingItems(line, c!.reply, 1)[0]!;
    const tail = proseLayout(rest, c!.items.at(-1)!, 60).rows.map(proseRowText).join(' ');
    // the continuation opens on a whole word (the cut is a row start of the drawn text)
    expect(tail.trimStart()).toMatch(/^[a-z]+ /);
    const head = c!.items.map((i) => i.text).join(' ');
    expect(`${head} ${tail.trim()}`.replace(/\s+/g, ' ')).toBe(drawn[0]!.prose!.line.replace(/\s+/g, ' '));
    expect(`${head}${tail}`).not.toContain(key);
  });

  it('a partial line is never cut inside its trailing key-character run (a key still streaming may turn into the marker)', () => {
    // a long token hard-split across rows at the end of the partial line: its rows stay in the block
    const line = `one two ghp_${'B'.repeat(30)}`;
    const c = commitOverflow(line, EMPTY_REPLY, { rows: 1, columns: 30 }, null, 1, 0);
    const cut = c?.reply.offset ?? 0;
    expect(cut).toBeLessThanOrEqual(line.indexOf('ghp_'));
    // once the key is complete (and redacted) and the line moved on, the cut may pass it
    const done = `${line}BBBBBB and more words after it`;
    const d = commitOverflow(done, EMPTY_REPLY, { rows: 1, columns: 30 }, null, 1, 0);
    expect(d).not.toBeNull();
    expect(d!.items.map((i) => i.text).join(' ')).not.toContain('ghp_B');
  });

  it('the layout: a spacer above the first prose row after another label, none inside the reply, none on a continuation', () => {
    const you: TranscriptItem = { key: 'y', seq: 0, step: null, kind: 'chat', level: 'info', text: 'hi', label: '[you]' };
    const [a, b] = pendingItems('first\nsecond', EMPTY_REPLY, 1);
    expect(proseLayout(a!, you, 80).spacer).toBe(true);
    expect(proseLayout(b!, a!, 80).spacer).toBe(false);
    const cont = pendingItems('rest of a line', { done: 0, offset: 3, fence: false }, 1)[0]!;
    expect(proseLayout(cont, you, 80).spacer).toBe(false);
    expect(proseLayout(cont, you, 80).labelCell).toBe(false);
    // the stacked rung (24–33 columns) puts the label on its own row
    const stacked = proseLayout(a!, null, 30);
    expect(stacked.labelRow).toBe(true);
    expect(proseLayoutRows(stacked)).toBe(2);
  });
});
