/**
 * Frame parity (TUI-DESIGN §19.1 "a width/row test over this document's fenced frames"): the O4-owned
 * rows of F-B, F-D, F-G, F-J, F-K, F-P, F-T, F-X, F-Y and F-Z are rendered from the fixture builders and
 * diffed against the fenced frames read from docs/TUI-DESIGN.md at test time. Rows the design fixes by
 * formula are compared byte for byte; three hand-drawn features are normalised and named here:
 *   (1) the partial bar cell — the frames are mutually inconsistent (0.52 → ▏ in F-B but 0.81 → ▏ too,
 *       §7.6 0.62 → ▏), so every eighth glyph is compared as one class;
 *   (2) the timeline letter strips — F-T's s7 strip is 41 letters wide and its stage shares do not follow
 *       `round(ms/total·40)`, so strips are compared by pattern (`I+C+P+R+X+J+`, ≤ 40 letters);
 *   (3) whitespace runs — F-D's left half is 61 cells against §7.2's "59 + 1 + 60", F-G/F-J's gauge rows
 *       are not column-aligned, F-Z's `open:` sits one cell right of `evidence`; those rows compare after
 *       collapsing runs of spaces.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GLYPHS, cellWidth } from '../../../../src/tui/glyphs.js';
import { decisionRows } from '../../../../src/tui/pane/decisions.js';
import { paneLines, paneRuleRow, toDecisionRow } from '../../../../src/tui/pane/model.js';
import { planRows } from '../../../../src/tui/pane/plan.js';
import { timelineRows } from '../../../../src/tui/pane/timeline.js';
import { followupLines, reviewHeaderLines } from '../../../../src/tui/review/lines.js';
import { frameBDecisions, frameDDecisions, frameDPlanView, frameGDecisions, frameJDecisions, frameYDecisions, paneState, workedRequest } from './helpers.js';

const DOC = readFileSync(new URL('../../../../docs/TUI-DESIGN.md', import.meta.url), 'utf8').split('\n');

/** The fenced block under the `**F-X.` caption. */
function frame(tag: string): string[] {
  const start = DOC.findIndex((l) => l.startsWith(`**${tag}.`));
  expect(start, `frame ${tag} caption`).toBeGreaterThanOrEqual(0);
  let i = start;
  while (!DOC[i]!.startsWith('```')) i++;
  i++;
  const out: string[] = [];
  while (!DOC[i]!.startsWith('```')) out.push(DOC[i]!), i++;
  return out;
}

/** The frame's column count from its caption (`80×24`). */
function frameColumns(tag: string): number {
  const caption = DOC.find((l) => l.startsWith(`**${tag}.`))!;
  return Number(/(\d+)×\d+/.exec(caption)![1]);
}

const PARTIAL_RE = /[▏▎▍▌▋▊▉]/g;
const partial = (s: string): string => s.replace(PARTIAL_RE, '▏');
const collapse = (s: string): string => s.replace(/ +/g, ' ').trimEnd();
const strips = (s: string): string => s.replace(/\b[DICPRXJ]{2,}\b/g, 'STRIP');

const rows = (decs: ReturnType<typeof frameBDecisions>): ReturnType<typeof toDecisionRow>[] => decs.map((d) => toDecisionRow(d, 0.85));

describe('frame parity: every fenced frame is ≤ its caption width where O4 draws it', () => {
  it.each(['F-B', 'F-D', 'F-G', 'F-J', 'F-K', 'F-P', 'F-T', 'F-X', 'F-Y', 'F-Z'])('%s rows fit the caption width', (tag) => {
    const w = frameColumns(tag);
    for (const l of frame(tag)) expect(cellWidth(l), l).toBeLessThanOrEqual(w);
  });
});

describe('F-B: the decisions tab at 80×24 (12 rows, `!` near flag)', () => {
  it('renders the twelve rows exactly, modulo the partial cell', () => {
    const state = paneState({ rows: rows(frameBDecisions()) });
    const mine = decisionRows(state, 12, 80);
    const theirs = frame('F-B').slice(4, 16);
    expect(mine.map(partial)).toEqual(theirs.map(partial));
    // byte-exact on every row whose partial cell the frame draws by the formula (all but tests/test_a.py 0.52)
    mine.forEach((l, i) => {
      if (!l.includes('tests/test_a.py')) expect(l).toBe(theirs[i]);
    });
    expect(paneRuleRow(state, 12, 80, 'none')).toBe(frame('F-B')[3]);
  });
});

describe('F-G: the seven-row pane and the review header at 80×24', () => {
  it('pane rows are exact; title and keys are exact; gauge rows agree on every token before the level text', () => {
    const f = frame('F-G');
    const state = paneState({ rows: rows(frameGDecisions()) });
    expect(decisionRows(state, 7, 80)).toEqual(f.slice(1, 8));
    const header = reviewHeaderLines(workedRequest(), 8, 80);
    expect(header[0]).toBe(f[8]);
    expect(header[1]).toBe(f[9]);
    // ruler: the frame's `dimension     lvl` (5 spaces) cannot align with its own gauge rows; compare the tokens
    expect(collapse(header[2]!)).toBe(collapse(f[10]!));
    for (let i = 0; i < 5; i++) {
      const mine = collapse(partial(header[3 + i]!)).split(' ');
      const theirs = collapse(partial(f[11 + i]!)).split(' ');
      const n = i === 4 ? 6 : 7;
      expect(mine.slice(0, n)).toEqual(theirs.slice(0, n));
    }
  });
});

describe('F-J: the wide decisions tab at 120×40 with latency and consumedBy', () => {
  it('renders the twelve rows exactly, modulo the partial cell', () => {
    const f = frame('F-J');
    const state = paneState({ rows: rows(frameJDecisions()) });
    const mine = decisionRows(state, 12, 120);
    expect(mine.map(partial)).toEqual(f.slice(1, 13).map(partial));
    mine.forEach((l, i) => {
      if (!l.includes('tests/test_a.py')) expect(l).toBe(f[1 + i]);
    });
    expect(paneRuleRow(state, 12, 120, 'review')).toBe(f[0]);
    const header = reviewHeaderLines(workedRequest(), 8, 120);
    expect(header[0]).toBe(f[13]);
    expect(header[1]).toBe(f[14]);
    for (let i = 0; i < 5; i++) {
      const mine = collapse(partial(header[3 + i]!)).split(' ');
      const theirs = collapse(partial(f[16 + i]!)).split(' ');
      const n = i === 4 ? 9 : 10;
      expect(mine.slice(0, n)).toEqual(theirs.slice(0, n));
    }
  });
});

describe('F-Y: the wide tab over two steps at 120×12', () => {
  it('renders the five rows exactly', () => {
    const f = frame('F-Y');
    const state = paneState({ step: 3, rows: rows(frameYDecisions()) });
    expect(decisionRows(state, 5, 120)).toEqual(f.slice(3, 8));
  });
});

describe('F-K and F-Z: the plan tab at 80 and 120 columns', () => {
  it('F-K rows are exact, rule row included', () => {
    const f = frame('F-K');
    const state = paneState({ tab: 'p' });
    expect(planRows(state, 11, 80)).toEqual(f.slice(1, 8));
    expect(paneRuleRow(state, 11, 80, 'palette')).toBe(f[0]);
  });
  it('F-Z rows are exact except the hand-drawn `open:` column (one cell right of `evidence`)', () => {
    const f = frame('F-Z');
    const state = paneState({ tab: 'p' });
    const mine = planRows(state, 11, 120);
    expect(mine.slice(0, 6)).toEqual(f.slice(1, 7));
    expect(collapse(mine[6]!)).toBe(collapse(f[7]!));
    expect(mine[6]!.indexOf('open:')).toBe(mine[0]!.indexOf('evidence'));
    expect(paneRuleRow(state, 11, 120, 'palette')).toBe(f[0]);
  });
});

describe('F-T: the timeline tab at 80×40', () => {
  it('timing rows are exact; letter rows agree outside the hand-drawn strips', () => {
    const f = frame('F-T');
    const mine = timelineRows(paneState({ tab: 't' }), 12, 80);
    expect(mine[0]).toBe(f[1]);
    expect(mine[2]).toBe(f[3]);
    expect(strips(mine[1]!)).toBe(strips(f[2]!));
    expect(strips(mine[3]!)).toBe(strips(f[4]!));
    for (const l of [mine[1]!, mine[3]!]) {
      const strip = /([ICPRXJ]+)/.exec(l)![1]!;
      expect(strip).toMatch(/^I+C+P+R+X+J+$/);
      expect(strip.length).toBeLessThanOrEqual(40);
    }
    expect(paneRuleRow(paneState({ tab: 't' }), 12, 80, 'none')).toBe(f[0]);
  });
});

describe('F-P and F-X: the follow-up box and the 120-column compact review', () => {
  it('F-P box rows are exact', () => {
    const f = frame('F-P');
    // TUI-DESIGN-2 §4.7: the box draws the cli-boxes `round` corners now (`╭ ╮ ╰ ╯`); the design frame's square corners map onto them
    const round = (l: string): string => l.replace('┌', '╭').replace('┐', '╮').replace('└', '╰').replace('┘', '╯');
    expect(followupLines({ runCapUsd: 2, clampedToUsd: 0.42, sessionSpentUsd: 9.58, sessionCapUsd: 10, runs: 5, lastRunUsd: 0.71 }, 5, 80)).toEqual(f.slice(13, 18).map(round));
    expect(decisionRows(paneState({ rows: rows(frameBDecisions()) }), 12, 80).map(partial)).toEqual(f.slice(1, 13).map(partial));
  });
  it('F-X title, keys and the three-dimension compact row are exact', () => {
    const f = frame('F-X');
    expect(reviewHeaderLines(workedRequest(), 3, 120)).toEqual(f.slice(1, 4));
  });
});

describe('F-D: two tabs side by side at 120×50', () => {
  it('every row agrees after collapsing spaces (the frame’s left half is 61 cells, §7.2 says 59; its `remaining 3` omits the unverified item that §15 keeps in `remaining`)', () => {
    const f = frame('F-D');
    const state = paneState({ tab: 'd', step: 3, rows: rows(frameDDecisions()), plan: frameDPlanView() });
    const mine = paneLines(state, 12, 120, 'none', { terminalRows: 50 });
    const theirs = f.slice(3, 15);
    expect(mine.length).toBe(theirs.length);
    const norm = (l: string): string => collapse(partial(l)).replace(/remaining \d/, 'remaining N');
    mine.forEach((l, i) => expect(norm(l)).toBe(norm(theirs[i]!)));
    expect(paneRuleRow(state, 12, 120, 'none', { terminalRows: 50 })).toBe(f[0]);
    for (const l of mine) expect(cellWidth(l)).toBeLessThanOrEqual(120);
  });
  it('the ASCII twin of every frame row above is pure ASCII', () => {
    const ascii = /^[\x20-\x7e]*$/;
    for (const [tag, decs, columns] of [['F-B', frameBDecisions(), 80], ['F-J', frameJDecisions(), 120], ['F-Y', frameYDecisions(), 120]] as const) {
      for (const l of decisionRows(paneState({ rows: rows(decs) }), 12, columns, GLYPHS.ascii)) expect(l, tag).toMatch(ascii);
    }
    for (const l of paneLines(paneState({ tab: 'd', step: 3, rows: rows(frameDDecisions()), plan: frameDPlanView() }), 12, 120, 'none', { terminalRows: 50, glyphs: GLYPHS.ascii })) expect(l).toMatch(ascii);
  });
});
