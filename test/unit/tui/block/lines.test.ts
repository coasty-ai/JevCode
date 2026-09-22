/**
 * TUI-DESIGN-4 §3.1 (D-U): the one command-output grammar — `blockWidth` off the rung (§3.1.2, no floor above the
 * available width), the four tiers, the five row kinds plus `gap` (§3.1.3), the number/path formats (§3.1.4), the
 * truncation rules (§3.1.5) and `detailRole`'s syntax gate (§3.1.6). The F-B1…F-B7 frames are read back from
 * `docs/TUI-DESIGN-4.md` with `palette.test.ts`'s fence pattern so the document and the renderer cannot drift.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_WIDTH_MAX,
  FLUSH_MIN_COLUMNS,
  LABEL_GUTTER,
  STACKED_MIN_COLUMNS,
  blockTexts,
  blockTier,
  blockWidth,
  detailRole,
  elideLeft,
  elideRight,
  gutterMode,
  renderBlock,
  type BlockRow,
} from '../../../../src/tui/block/lines.js';
import { GLYPHS, cellWidth } from '../../../../src/tui/glyphs.js';
import { LABEL_GUTTER as TRANSCRIPT_LABEL_GUTTER, bodyWidth } from '../../../../src/tui/Transcript.js';
import { shortPath } from '../../../../src/core/text.js';

const DESIGN4 = fileURLToPath(new URL('../../../../docs/TUI-DESIGN-4.md', import.meta.url));

/** the fenced block that follows a `**<marker>` caption line of a design document */
function fence(marker: string): string[] {
  const lines = readFileSync(DESIGN4, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.startsWith(marker));
  expect(at, marker).toBeGreaterThan(0);
  let k = at + 1;
  while (lines[k] !== '```') k++;
  const body: string[] = [];
  for (k++; lines[k] !== '```'; k++) body.push(lines[k] as string);
  return body;
}

/** the body rows of an F-B frame: the `     [ui] <head>` row is dropped, the 10-cell gutter is stripped */
function frameBody(marker: string): string[] {
  const rows = fence(marker).filter((l) => l.trim() !== '');
  const head = rows.find((l) => l.includes('[ui] '));
  expect(head, marker).toBeDefined();
  return rows.filter((l) => l !== head).map((l) => l.slice(LABEL_GUTTER));
}

function frameHead(marker: string): string {
  const head = fence(marker).find((l) => l.includes('[ui] '));
  expect(head, marker).toBeDefined();
  return (head as string).slice((head as string).indexOf('[ui] ') + '[ui] '.length);
}

const FRAMES = ['**F-B1.', '**F-B2.', '**F-B3.', '**F-B5.', '**F-B6.'] as const;

describe('blockWidth — the rung, not `columns` alone (§3.1.2)', () => {
  it('is the rung body width: `columns − 10` in gutter, `− 2` in stacked, `columns` in flush', () => {
    expect(blockWidth(80)).toBe(70);
    expect(blockWidth(40)).toBe(30);
    expect(blockWidth(120)).toBe(110);
    expect(blockWidth(34)).toBe(24);
    expect(blockWidth(33)).toBe(31);
    expect(blockWidth(24)).toBe(22);
    expect(blockWidth(23)).toBe(23);
    expect(blockWidth(10)).toBe(10);
  });

  it('never floors above the available width — the 28-floor bug of §14.2 item 7', () => {
    for (let columns = 1; columns <= 200; columns++) {
      const mode = gutterMode(columns);
      const rendered = mode === 'gutter' ? columns - LABEL_GUTTER : mode === 'stacked' ? columns - 2 : columns;
      expect(blockWidth(columns), `columns ${columns}`).toBeLessThanOrEqual(Math.max(1, rendered));
      expect(blockWidth(columns)).toBeGreaterThanOrEqual(1);
    }
  });

  it('agrees with `Transcript.tsx`\u2019s rendered body width on the gutter rung', () => {
    expect(LABEL_GUTTER).toBe(TRANSCRIPT_LABEL_GUTTER);
    for (let columns = STACKED_MIN_COLUMNS; columns <= 200; columns++) {
      expect(blockWidth(columns), `columns ${columns}`).toBe(Math.min(BLOCK_WIDTH_MAX, bodyWidth(columns, '[ui]')));
    }
  });

  it('clamps to 160 at the identity pty run\u2019s 640 columns, and to 1 at 0 / NaN', () => {
    expect(blockWidth(640)).toBe(BLOCK_WIDTH_MAX);
    expect(blockWidth(0)).toBe(1);
    expect(blockWidth(Number.NaN)).toBe(1);
    expect(gutterMode(0)).toBe('flush');
    expect(gutterMode(FLUSH_MIN_COLUMNS)).toBe('stacked');
    expect(gutterMode(STACKED_MIN_COLUMNS)).toBe('gutter');
  });

  it('tiers are derived from the WIDTH, not the columns', () => {
    expect(blockTier(blockWidth(40))).toBe('tight');
    expect(blockTier(blockWidth(44))).toBe('narrow');
    expect(blockTier(blockWidth(80))).toBe('standard');
    expect(blockTier(blockWidth(120))).toBe('wide');
    expect(blockTier(33)).toBe('tight');
    expect(blockTier(34)).toBe('narrow');
    expect(blockTier(59)).toBe('narrow');
    expect(blockTier(60)).toBe('standard');
    expect(blockTier(99)).toBe('standard');
    expect(blockTier(100)).toBe('wide');
  });
});

describe('the five row kinds plus gap (§3.1.3)', () => {
  const rows: BlockRow[] = [
    { kind: 'kv', key: 'session', value: '$0.04 of $10.00, 12 %, 3 runs' },
    { kind: 'facts', segments: ['questions 83', 'p50 0 ms', 'p95 2 ms', '$0.001'] },
    { kind: 'table', cells: ['bin', 'n', 'mean p', 'observed'], header: true },
    { kind: 'table', cells: ['0.9-1.0', '12', '0.95', '0.92'], align: ['l', 'r', 'r', 'r'] },
    { kind: 'rule', caption: 'pending' },
    { kind: 'note', text: '+18 settings at their defaults (/config --all)' },
  ];

  for (const width of [28, 30, 50, 70, 110, 160]) {
    it(`renders every kind within ${width} cells`, () => {
      const out = renderBlock(rows, width);
      expect(out.length).toBeGreaterThan(0);
      for (const r of out) {
        expect(cellWidth(r.text), `${width}: ${JSON.stringify(r.text)}`).toBeLessThanOrEqual(width);
        expect(r.text).not.toMatch(/\s$/);
      }
    });
  }

  it('a kv key is padded to the 10-cell field and the value wraps UNDER column 11, never to column 0', () => {
    const out = blockTexts([{ kind: 'kv', key: 'raise it', value: '/budget spend-cap <usd> · /budget session-spend-cap <usd|none>' }], 70);
    expect(out[0]).toBe('raise it   /budget spend-cap <usd> · /budget session-spend-cap');
    expect(out[1]).toBe('           <usd|none>');
  });

  it('the tight tier puts the key on its own row and the value indented 2', () => {
    const out = blockTexts([{ kind: 'kv', key: 'generator.model', value: 'z-ai/glm-5.3-flash' }], 30);
    expect(out).toEqual(['generator.model', '  z-ai/glm-5.3-flash']);
  });

  it('a key longer than the gutter keeps its own row at every tier (§3.3 edge 3)', () => {
    const out = blockTexts([{ kind: 'kv', key: 'session.spendCapUsd', value: '$10.000' }], 70);
    expect(out).toEqual(['session.spendCapUsd', '  $10.000']);
  });

  it('the narrow tier elides a kv value instead of wrapping it', () => {
    const out = blockTexts([{ kind: 'kv', key: 'run', value: 'x'.repeat(80) }], 40);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/…$/);
    expect(cellWidth(out[0] as string)).toBe(40);
  });

  it('`rule` is `fenceRow`\u2019s shape and `note` indents two cells', () => {
    expect(blockTexts([{ kind: 'rule', caption: 'sandbox' }], 70)).toEqual(['╶──── sandbox']);
    expect(blockTexts([{ kind: 'rule' }], 70)).toEqual(['╶────']);
    expect(blockTexts([{ kind: 'note', text: 'nothing pending' }], 70)).toEqual(['  nothing pending']);
  });

  it('a gap is a blank row; leading and trailing gaps are dropped and two collapse to one', () => {
    const out = blockTexts([{ kind: 'gap' }, { kind: 'note', text: 'a' }, { kind: 'gap' }, { kind: 'gap' }, { kind: 'note', text: 'b' }, { kind: 'gap' }], 70);
    expect(out).toEqual(['  a', '', '  b']);
  });

  it('`rows.length === 0` is the head alone — no gap rows (§3.3 edge 7)', () => {
    expect(renderBlock([], 70)).toEqual([]);
  });

  it('the header row is dim and a body cell keeps the default role (§3.1.6)', () => {
    const out = renderBlock(rows, 70);
    expect(out.find((r) => r.text.startsWith('bin'))?.role).toBe('dim');
    expect(out.find((r) => r.text.startsWith('0.9-1.0'))?.role).toBeNull();
    expect(out.find((r) => r.text.startsWith('╶────'))?.role).toBe('code');
  });

  it('a `facts` row packs at ` · ` and the tight tier gives each segment its own row', () => {
    expect(blockTexts([{ kind: 'facts', segments: ['a', 'b', 'c'] }], 70)).toEqual(['a · b · c']);
    expect(blockTexts([{ kind: 'facts', segments: ['a', 'b'] }], 20)).toEqual(['· a', '· b']);
  });

  it('`--ascii` substitutes the glyph twins and the rows stay within the width', () => {
    const out = blockTexts([...rows, { kind: 'facts', segments: ['a', 'b'] }], 50, GLYPHS.ascii);
    // nothing the renderer GENERATES may be a unicode glyph under --ascii (the data itself is the caller's business)
    expect(out.join('\n')).not.toMatch(/[·─…╶]/);
    expect(out.join('\n')).toContain('a - b');
    for (const r of out) expect(cellWidth(r)).toBeLessThanOrEqual(50);
  });

  it('a value with a newline or a control byte is one line before it is measured (§3.3 edge 5)', () => {
    const out = blockTexts([{ kind: 'kv', key: 'k', value: 'a\nb\u0007c' }], 70);
    expect(out).toEqual(['k          a bc']);
  });

  it('wide graphemes are measured in cells, never in `String.length` (§3.3 edge 4)', () => {
    const out = blockTexts([{ kind: 'table', cells: ['名前', 'x'], header: true }, { kind: 'table', cells: ['a', 'y'] }], 70);
    expect(cellWidth(out[0] as string)).toBe(cellWidth(out[1] as string) + cellWidth('x') - cellWidth('y'));
    expect(out[1]).toBe('a     y');
  });

  it('a row exactly `width` cells is neither wrapped nor given a trailing space (§3.3 edge 6)', () => {
    const exact = 'x'.repeat(70);
    expect(blockTexts([{ kind: 'facts', segments: [exact] }], 70)).toEqual([exact]);
  });
});

describe('truncation (§3.1.5)', () => {
  it('prose elides right, a path elides left', () => {
    expect(elideRight('abcdefghij', 5, GLYPHS.unicode)).toBe('abcd…');
    expect(elideLeft('/a/b/c/src/app.py', 12, GLYPHS.unicode)).toBe('…/src/app.py');
  });

  it('rows beyond the cap become one dim footer that names the command', () => {
    const rows: BlockRow[] = Array.from({ length: 30 }, (_, i) => ({ kind: 'note', text: `row ${i}` }));
    const out = renderBlock(rows, 70, GLYPHS.unicode, { max: 24, moreFooter: '… +{n} more files (/diff --all)' });
    expect(out).toHaveLength(25);
    expect(out[24]?.text).toBe('… +6 more files (/diff --all)');
    expect(out[24]?.role).toBe('dim');
  });
});

describe('detailRole — only on a block that declared its syntax (§3.1.6)', () => {
  it('classifies diff rows when the syntax is declared', () => {
    expect(detailRole('+VALUE_0 = 3', 'diff')).toBe('added');
    expect(detailRole('-VALUE_0 = 0', 'diff')).toBe('removed');
    expect(detailRole('@@ -1,3 +1,4 @@', 'diff')).toBe('hunk');
    expect(detailRole('diff --git a/x b/x', 'diff')).toBe('diffMeta');
    expect(detailRole(' print(VALUE_0)', 'diff')).toBeNull();
  });

  it('never classifies a `/why` row that happens to start with `+`', () => {
    expect(detailRole('+VALUE_0 = 3', undefined)).toBeNull();
  });
});

describe('the F-B frames, read back from docs/TUI-DESIGN-4.md', () => {
  for (const marker of FRAMES) {
    it(`${marker.slice(2, -1)} fits the 24×80 body width and its head is a noun ≤ 40 cells`, () => {
      const head = frameHead(marker);
      // §3.1.1: the head NOUN is ≤ 40 cells; the one right-hand meta field after ` · ` is extra
      expect(cellWidth(head.split(' · ')[0] as string)).toBeLessThanOrEqual(40);
      expect(head).not.toMatch(/^[A-Z]/);
      for (const row of frameBody(marker)) expect(cellWidth(row), `${marker} ${JSON.stringify(row)}`).toBeLessThanOrEqual(blockWidth(80));
    });
  }

  it('F-B4 is the tight tier at `blockWidth(40)` — the key row, then the value indented 2', () => {
    const body = frameBody('**F-B4.');
    expect(blockWidth(40)).toBe(30);
    for (const row of body) expect(cellWidth(row)).toBeLessThanOrEqual(30);
    const pairs = body.filter((r) => !r.startsWith('…'));
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      expect(pairs[i]).not.toMatch(/^ /);
      expect(pairs[i + 1]).toMatch(/^ {2}\S/);
    }
  });

  it('F-B2\u2019s `raise it` row is exactly what `renderBlock` produces at width 70', () => {
    const body = frameBody('**F-B2.');
    const at = body.findIndex((r) => r.startsWith('raise it'));
    expect(at).toBeGreaterThan(0);
    const produced = blockTexts([{ kind: 'kv', key: 'raise it', value: '/budget spend-cap <usd> · /budget session-spend-cap <usd|none>' }], blockWidth(80));
    expect([body[at], body[at + 1]]).toEqual(produced);
  });

  it('F-B7\u2019s error wraps under the gutter and keeps the §3.1.7 shape', () => {
    const rows = fence('**F-B7.');
    const joined = rows.map((r) => r.trim()).join(' ');
    expect(joined).toMatch(/^\[ui\] error: \/undo 2 — /);
    for (const r of rows) expect(cellWidth(r)).toBeLessThanOrEqual(80);
  });
});

describe('shortPath (§3.4)', () => {
  const root = '/tmp/a3-ws';
  const home = '/Users/x';
  it('is workspace-relative inside the root', () => {
    expect(shortPath('/tmp/a3-ws/src/app.py', { root, home, width: 40 })).toBe('src/app.py');
    expect(shortPath('/tmp/a3-ws', { root, home, width: 40 })).toBe('.');
  });
  it('is `~`-abbreviated inside $HOME', () => {
    expect(shortPath('/Users/x/.jevcode/runs', { root, home, width: 40 })).toBe('~/.jevcode/runs');
    expect(shortPath('/Users/x', { root, home, width: 40 })).toBe('~');
  });
  it('`~` wins when root === home (edge 1)', () => {
    expect(shortPath('/Users/x/p', { root: home, home, width: 40 })).toBe('~/p');
  });
  it('elides LEFT keeping the last two segments outside both', () => {
    expect(shortPath('/very/long/prefix/runs/20260922-035503', { root, home, width: 30 })).toBe('…/runs/20260922-035503');
  });
  it('never breaks a run id — the whole path comes back and the row wraps', () => {
    const id = '20260922-035503-kntk2yw3-and-more';
    expect(shortPath(`/a/b/c/runs/${id}`, { root, home, width: 20 })).toBe(`/a/b/c/runs/${id}`);
  });
  it('leaves a relative path, a `~…` directory and a Windows path alone (edges 2, 3, 4)', () => {
    expect(shortPath('src/app.py', { root, home, width: 4 })).toBe('src/app.py');
    expect(shortPath('/tmp/~x/y', { root: '/none', home, width: 40 })).toBe('/tmp/~x/y');
    expect(shortPath('C:\\Users\\x\\p', { root, home, width: 4 })).toBe('C:\\Users\\x\\p');
  });
  it('measures in cells when the caller passes `cellWidth` (edge 5)', () => {
    // a CJK segment is 2 cells per code point: `…/名前名前名前/leaf` is 13 CODE POINTS and 19 CELLS, so at
    // width 14 the default (code-point) measure keeps two segments and `cellWidth` — correctly — keeps one
    const wide = '/a/b/名前名前名前/leaf';
    expect([...'…/名前名前名前/leaf'].length).toBe(13);
    expect(cellWidth('…/名前名前名前/leaf')).toBe(19);
    expect(shortPath(wide, { root: '/none', home, width: 14 })).toBe('…/名前名前名前/leaf');
    expect(shortPath(wide, { root: '/none', home, width: 14, measure: cellWidth })).toBe('…/leaf');
    expect(cellWidth(shortPath('/a/b/cc/leaf', { root: '/none', home, width: 8, measure: cellWidth }))).toBeLessThanOrEqual(8);
  });
  it('a width of 0 or a negative width never throws', () => {
    expect(shortPath('/a/b/c', { root, home, width: 0 })).toBe('/a/b/c');
    expect(shortPath('/a/b/c', { root, home, width: -3 })).toBe('/a/b/c');
  });
});


/**
 * §10 S3, the sweep the 40/80/120 sample cannot do: for **every** terminal width 1…200, `blockWidth(columns)` is at
 * most the body width the transcript row actually renders into, and every rendered row of a block built at that
 * width fits inside it. This is the assertion the 28-cell floor of an earlier draft failed at columns 24–37
 * (§3.1.2, §14.2 "Review log" item 7) and that the `commands-width` pty gate could not see.
 */
describe('the 1…200 column sweep (§10 S3)', () => {
  const rows: BlockRow[] = [
    { kind: 'kv', key: 'workspace', value: '~/T/a3-ws-jC6j7y · no git repository' },
    { kind: 'kv', key: 'averylongkeyname', value: 'the value of a key wider than the 10-cell field' },
    { kind: 'facts', segments: ['questions 83', 'p50 0 ms', 'p95 2 ms', '$0.001'] },
    { kind: 'table', cells: ['bin', 'n', 'mean p', 'observed'], header: true },
    { kind: 'table', cells: ['0.9–1.0', '12', '0.95', '0.92'], align: ['l', 'r', 'r', 'r'] },
    { kind: 'rule', caption: 'sandbox' },
    { kind: 'gap' },
    { kind: 'note', text: '… +18 settings at their defaults (/config --all)' },
    { kind: 'kv', key: 'runs', value: '/very/long/absolute/path/runs/20260922-035503-kntk2yw3', path: true },
  ];

  it('blockWidth(columns) ≤ the rendered body width at every width, and every row fits it', () => {
    for (let columns = 1; columns <= 200; columns++) {
      const w = blockWidth(columns);
      const mode = gutterMode(columns);
      const rendered = Math.max(1, mode === 'gutter' ? columns - LABEL_GUTTER : mode === 'stacked' ? columns - 2 : columns);
      expect(w, `columns ${columns}`).toBeGreaterThanOrEqual(1);
      expect(w, `columns ${columns}`).toBeLessThanOrEqual(Math.min(BLOCK_WIDTH_MAX, rendered));
      for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
        for (const r of renderBlock(rows, w, g)) {
          expect(cellWidth(r.text), `columns ${columns} (${g.mode}): ${JSON.stringify(r.text)}`).toBeLessThanOrEqual(w);
          expect(r.text, `columns ${columns}: trailing space`).not.toMatch(/ $/);
        }
      }
    }
  });

  it('never returns 0 rows for a non-empty block, and never loops on a 1-cell body (§3.3 edge 1)', () => {
    for (const columns of [0, 1, 2, 5, 10, 23, 24, 33, 34]) {
      const out = renderBlock(rows, blockWidth(columns));
      expect(out.length, `columns ${columns}`).toBeGreaterThan(0);
    }
  });
});

describe('§3.3 edge 4: every arithmetic walk is by GRAPHEME UNIT, never by UTF-16 code unit', () => {
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  /** a combining mark that begins a string has lost its base — an orphan */
  const ORPHAN_MARK = /^[̀-ͯ҃-҉᪰-᫿᷀-᷿⃐-⃿︠-︯]/;

  const inputs = [
    '/a/b/\u{1f600}\u{1f600}\u{1f600}',
    '/xxx/ééé',
    '/deep/dir/\u{1f469}‍\u{1f4bb}/app.py',
    '/x/一二三四五',
    '/flags/\u{1f1fa}\u{1f1f8}\u{1f1eb}\u{1f1f7}/x',
  ];

  it('`elideLeft` never emits a lone surrogate or an orphan combining mark, at any width, in either glyph set', () => {
    for (const text of inputs) {
      for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
        for (let width = 1; width <= cellWidth(text) + 2; width++) {
          const out = elideLeft(text, width, g);
          expect(LONE_SURROGATE.test(out), `${JSON.stringify(text)} @${width} (${g.mode}) → ${JSON.stringify(out)}`).toBe(false);
          // the ellipsis is the only thing that may precede the kept tail; what follows it must have a base
          const tail = out.startsWith(g.ellipsis) ? out.slice(g.ellipsis.length) : out;
          expect(ORPHAN_MARK.test(tail), `${JSON.stringify(text)} @${width} (${g.mode}) → ${JSON.stringify(out)}`).toBe(false);
          expect(cellWidth(out), `${JSON.stringify(text)} @${width}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it('the measured cases: an astral pair and a combining acute both survive whole or not at all', () => {
    // the whole emoji or none of it — never the low half
    expect(elideLeft('/a/b/\u{1f600}\u{1f600}\u{1f600}', 4, GLYPHS.unicode)).toBe('…\u{1f600}');
    expect(elideLeft('/a/b/\u{1f600}\u{1f600}\u{1f600}', 6, GLYPHS.unicode)).toBe('…\u{1f600}\u{1f600}');
    // `é` is `e` + U+0301: the mark never arrives without its base
    expect(elideLeft('/xxx/ééé', 3, GLYPHS.unicode)).toBe('…éé');
  });
});

describe('§3.1.5: an identifier is never elided — the row wraps instead', () => {
  const RUN_ID = '20260922-035503-kntk2yw3';
  const id: BlockRow = { kind: 'kv', key: 'run', value: `${RUN_ID} · complete (exit 0)`, id: true };
  const resume: BlockRow = { kind: 'kv', key: 'resume', value: `jevcode run --resume ${RUN_ID}`, id: true };

  it('the narrow band (widths 34–59, i.e. terminals 44–69 columns) keeps the run id and the --resume command whole', () => {
    for (let width = 34; width <= 59; width++) {
      for (const row of [id, resume]) {
        const rows = blockTexts([row], width);
        expect(rows.join('\n').replace(/\n\s*/g, ' '), `width ${width}`).toContain(RUN_ID);
        for (const r of rows) expect(cellWidth(r), `width ${width}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('the same holds at every width down to the tight tier, where the key takes its own row', () => {
    for (let width = 26; width <= 120; width++) {
      const joined = blockTexts([id, resume], width).join('\n').replace(/\n\s*/g, ' ');
      expect(joined, `width ${width}`).toContain(RUN_ID);
      expect(joined, `width ${width}`).not.toContain('…');
    }
  });

  it('a kv row WITHOUT `id` still elides in the narrow tier (the flag is opt-in, not a behaviour change)', () => {
    const prose: BlockRow = { kind: 'kv', key: 'note', value: 'a sentence far too long for a forty-cell body to hold whole' };
    expect(blockTexts([prose], 40)[0]).toMatch(/…$/);
  });
});

describe('§3.1.5 / §2.6: the `… +N more` footer is laddered to fit, never elided', () => {
  const many: BlockRow[] = Array.from({ length: 30 }, (_, i) => ({ kind: 'note', flush: true, text: `row ${i}` }));

  it('drops the footer clause before it ever cuts a token', () => {
    const wide = renderBlock(many, 70, GLYPHS.unicode, { max: 5, moreFooter: '… +{n} more rows (/config --all)' });
    expect(wide[wide.length - 1]?.text).toBe('… +25 more rows (/config --all)');
    const narrow = renderBlock(many, 30, GLYPHS.unicode, { max: 5, moreFooter: '… +{n} more rows (/config --all)' });
    expect(narrow[narrow.length - 1]?.text).toBe('… +25 more rows');
    const tiny = renderBlock(many, 10, GLYPHS.unicode, { max: 5, moreFooter: '… +{n} more rows (/config --all)' });
    expect(tiny[tiny.length - 1]?.text).toBe('… +25');
  });

  it('no footer at any width from 1 to 120 ends in the ellipsis of a cut token', () => {
    for (let width = 1; width <= 120; width++) {
      const out = renderBlock(many, width, GLYPHS.unicode, { max: 3, moreFooter: '… +{n} more rows (/config --all)' });
      const footer = out[out.length - 1]?.text ?? '';
      expect(cellWidth(footer), `width ${width}`).toBeLessThanOrEqual(width);
      if (width >= 6) expect(footer, `width ${width}`).toMatch(/^… \+27/);
    }
  });

  it('`protectTail` keeps the trailing rows out of the cap (§3.3 edge 4: the sandbox statement)', () => {
    const rows: BlockRow[] = [...many, { kind: 'gap' }, { kind: 'rule', caption: 'sandbox' }, { kind: 'facts', segments: ['seatbelt', 'network off'] }];
    const out = renderBlock(rows, 70, GLYPHS.unicode, { max: 5, moreFooter: '… +{n} more rows', protectTail: 3 });
    const texts = out.map((r) => r.text);
    expect(texts).toContain('╶──── sandbox');
    expect(texts[texts.length - 1]).toBe('seatbelt · network off');
    expect(texts.filter((t) => t.startsWith('… +'))).toHaveLength(1);
  });
});

describe('§3.3: a `facts` segment wider than the tight row never leaves a dangling bullet', () => {
  it('wraps the segment and prefixes the bullet onto the first row only', () => {
    const out = blockTexts([{ kind: 'facts', segments: ['一二三四五六七八九十一二三四五六七八九十'] }], 30);
    expect(out[0]).not.toBe('·');
    expect(out[0]?.startsWith('· ')).toBe(true);
    for (const r of out) expect(cellWidth(r)).toBeLessThanOrEqual(30);
    // nothing is lost: every glyph of the segment survives across the rows
    expect(out.join('').replace(/[·\s]/g, '')).toBe('一二三四五六七八九十一二三四五六七八九十');
  });
});

describe('BLOCK_CAPS (§3.1.5) name the constants they cite', () => {
  it('`why` is `WHY_MAX_LINES`, not a second number beside it', async () => {
    const { WHY_MAX_LINES } = await import('../../../../src/tui/why.js');
    const { BLOCK_CAPS } = await import('../../../../src/tui/block/lines.js');
    expect(BLOCK_CAPS.why).toBe(WHY_MAX_LINES);
  });
});

describe('§3.1.6: a raw row is classified ONLY when its block declared a syntax', () => {
  const diffRowsIn: BlockRow[] = [
    { kind: 'facts', segments: ['diff --git a/x b/x'], wrap: false },
    { kind: 'facts', segments: ['@@ -1,3 +1,4 @@'], wrap: false },
    { kind: 'facts', segments: ['+VALUE_0 = 3'], wrap: false },
    { kind: 'facts', segments: ['-VALUE_0 = 0'], wrap: false },
    { kind: 'facts', segments: [' print(VALUE_0)'], wrap: false },
  ];

  it('`syntax: \'diff\'` paints the four §6.2 roles and leaves a context row default', () => {
    expect(renderBlock(diffRowsIn, 70, GLYPHS.unicode, { syntax: 'diff' }).map((r) => r.role)).toEqual(['diffMeta', 'hunk', 'added', 'removed', null]);
  });

  it('WITHOUT the declaration the same rows are all default — a `/why` line starting with `+` is never green', () => {
    expect(renderBlock(diffRowsIn, 70).map((r) => r.role)).toEqual([null, null, null, null, null]);
  });

  it('an explicit `role` on the row always wins over the classifier', () => {
    const out = renderBlock([{ kind: 'facts', segments: ['+x'], wrap: false, role: 'dim' }], 70, GLYPHS.unicode, { syntax: 'diff' });
    expect(out[0]?.role).toBe('dim');
  });
});
